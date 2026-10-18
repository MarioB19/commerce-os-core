#!/usr/bin/env python3
"""Run as a systemd-owned root process. Detailed installer output remains private."""
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import shutil
import stat
import subprocess
import sys
from ci_provider_evidence import installation_id, release_identity
import tempfile
import time
import uuid
import urllib.request
import urllib.error
from ci_release import ReleaseError, digest, extract_release, require, verify_migrations
from deployment_scope import NO_PORTAL
import api_web_deployment as api_web

BASE=Path('/opt/commerce-os')
PRIVATE=BASE/'private'
SERVICES=['api','web','ingress','automation-worker','channel-worker','postgres']
MAX_RELEASE_ENV=256*1024
PORTAL_BASE=Path('/opt/mcl-portal')
SERVER_CURRENT_PORTAL_ENV='@server-current'
PORTAL_GENERATED_ENV_KEYS={'MCL_ACCESS_DB','MCL_RELEASE_SHA'}
SYSTEMD_ROOT=Path('/etc/systemd/system')
WAHA_BACKUP_UNITS=('commerce-waha-backup.service','commerce-waha-backup.timer')
PREPARE_TIMEOUT_SECONDS=1200
INSTALL_TIMEOUT_SECONDS=1200
ATTEMPT_LABEL='com.commerce-os.deployment-attempt'

class DeploymentCleanupError(ReleaseError):
    """An administrative task may still own a DB transaction; do not race it."""

def error_code(error):
    return str(error) if isinstance(error,ReleaseError) and re.fullmatch(r'[A-Z0-9_]{1,100}',str(error)) else type(error).__name__

def run_bounded_process(args, *, cwd, log_path, timeout, env=None, runner=None):
    """A timeout must reap the whole local process tree before recovery begins."""
    descriptor=os.open(log_path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
    with os.fdopen(descriptor,'w') as log:
        os.fchmod(log.fileno(),0o600)
        if runner is not None:
            # Dependency injection for command-contract tests; production streams
            # directly to the private file, without retaining output in memory.
            try:
                result=runner(args,cwd=cwd,text=True,capture_output=True,timeout=timeout)
            except subprocess.TimeoutExpired as error:
                for value in (error.stdout,error.stderr):
                    if value:log.write(value.decode(errors='replace') if isinstance(value,bytes) else value)
                raise
            for value in (getattr(result,'stdout',''),getattr(result,'stderr','')):
                if value:log.write(value)
            return result
        child=subprocess.Popen(args,cwd=cwd,env=env,text=True,stdout=log,stderr=log,start_new_session=True)
        failed=False
        try:
            return subprocess.CompletedProcess(args,child.wait(timeout=timeout))
        except BaseException:
            failed=True
            try:os.killpg(child.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:pass
            # The shell can exit while a descendant ignores TERM.
            try:os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            child.wait(timeout=5)
            raise
        finally:
            # Even a shell that exits successfully must not leave background
            # descendants able to mutate the release after the phase ended.
            if not failed:
                try:os.killpg(child.pid,signal.SIGKILL)
                except ProcessLookupError:pass

def cleanup_deployment_attempt(root,release_env,attempt,runner=None,wait_seconds=30,record_observation=None):
    """Only this attempt's disposable containers and DB sessions are eligible.

    Closing the task container can roll back its open transaction, or it may
    already have committed. Neither outcome restores or reruns a migration.
    Recovery cannot proceed until PostgreSQL confirms those sessions are gone.
    """
    require(bool(re.fullmatch(r'deploy-[a-f0-9]{32}',attempt)),'DEPLOYMENT_ATTEMPT_INVALID')
    run=runner or subprocess.run
    def checked(args,input_text=None):
        result=run(args,cwd=root,input=input_text,text=True,capture_output=True,timeout=40)
        require(result.returncode==0,'DEPLOYMENT_CLEANUP_UNCONFIRMED')
        return result.stdout.strip()
    def containers():
        ids=checked(['docker','ps','-aq','--no-trunc','--filter','label='+ATTEMPT_LABEL+'='+attempt]).split()
        require(all(re.fullmatch(r'[a-f0-9]{64}',item) for item in ids),'DEPLOYMENT_CONTAINER_ID_INVALID')
        return ids
    ids=containers()
    predicate="application_name='"+attempt+"' AND pid<>pg_backend_pid()"
    sql='SELECT count(*) FROM pg_stat_activity WHERE '+predicate+';'
    args=['sh','scripts/compose-release.sh',str(release_env),'exec','-T','postgres','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','commerce_owner','-d','commerce']
    # Inspect and durably record the exact registered task before stopping it.
    # Failure to observe PostgreSQL leaves it untouched for manual recovery.
    observed=json.loads(checked(args,"SELECT COALESCE(json_agg(json_build_object('pid',pid,'state',state,'transaction_open',xact_start IS NOT NULL)),'[]') FROM pg_stat_activity WHERE "+predicate+';'))
    require(isinstance(observed,list) and all(isinstance(row,dict) and isinstance(row.get('pid'),int) and row['pid']>0 for row in observed),'DEPLOYMENT_DATABASE_STATE_UNKNOWN')
    if record_observation:record_observation({'container_ids':ids,'database_sessions':observed})
    if ids:
        try:checked(['docker','stop','--time','20',*ids])
        except (ReleaseError,subprocess.TimeoutExpired):
            # --rm may complete between inventory and stop. Absence must be
            # established by a successful second inventory, never an error.
            require(not containers(),'DEPLOYMENT_CLEANUP_UNCONFIRMED')
        # --rm can race the explicit removal; inspect inventory again first.
        remaining=containers()
        if remaining:
            try:checked(['docker','rm','-f',*remaining])
            except (ReleaseError,subprocess.TimeoutExpired):
                require(not containers(),'DEPLOYMENT_CLEANUP_UNCONFIRMED')
    require(not containers(),'DEPLOYMENT_CONTAINERS_STILL_ACTIVE')
    # A docker exec child (pg_dump/psql) lives in postgres, not in the local PGID.
    # Re-query rather than relying on the snapshot: a tagged backend may have
    # opened between observation and stopping its container.
    checked(args,'SELECT count(*) FROM (SELECT pg_terminate_backend(pid) stopped FROM pg_stat_activity WHERE '+predicate+') task WHERE stopped;')
    deadline=time.monotonic()+wait_seconds
    while True:
        count=checked(args,sql)
        require(bool(re.fullmatch(r'[0-9]+',count)),'DEPLOYMENT_DATABASE_STATE_UNKNOWN')
        if count=='0':return {'containers_stopped':len(ids),'database_sessions_observed':observed,'database_sessions_remaining':0}
        if time.monotonic()>=deadline:raise ReleaseError('DEPLOYMENT_DATABASE_TASK_STILL_ACTIVE')
        time.sleep(min(1,max(0,deadline-time.monotonic())))

def run_deployment_task(root,report_dir,args,phase,timeout,runner=None):
    attempt='deploy-'+uuid.uuid4().hex
    env={**os.environ,'COMMERCE_DEPLOYMENT_ATTEMPT':attempt,'PGAPPNAME':attempt,'COMMERCE_DEPLOYMENT_LOG_PRIVATE':'1','COMMERCE_DEPLOYMENT_STATE_DIR':str(report_dir)}
    if phase in ('prepare','activate'):env['COMMERCE_INSTALL_PHASE']=phase
    journal={'attempt':attempt,'phase':phase,'status':'RUNNING','started_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    journal_path=report_dir/('task-'+phase+'.json');_write_report(journal_path,journal)
    failure=None
    try:
        result=run_bounded_process(args,cwd=root,
            log_path=report_dir/({'prepare':'prepare.log','activate':'install.log','rollback':'rollback.log','copy-migrations':'copy-migrations.log','v7-retirement-export':'v7-retirement-export.log'}[phase]),
            timeout=timeout,env=env,runner=runner)
        require(result.returncode==0,{'prepare':'PREPARATION_FAILED','activate':'INSTALLER_FAILED','rollback':'ROLLBACK_COMMAND_FAILED','copy-migrations':'COPY_BOUNDED_MIGRATIONS_FAILED','v7-retirement-export':'V7_RETIREMENT_EXPORT_FAILED'}[phase])
    except BaseException as error:
        failure=error;journal['phase_error']=error_code(error)
    # A killed docker CLI is not proof that its daemon-owned task stopped.
    try:
        def record_observation(observed):
            journal['cleanup_observation']=observed;_write_report(journal_path,journal)
        if runner is None:journal['cleanup']=cleanup_deployment_attempt(root,report_dir/'previous-release.env',attempt,record_observation=record_observation)
    except Exception as error:
        journal.update(status='CLEANUP_FAILED',cleanup_error=error_code(error));_write_report(journal_path,journal)
        unsafe=DeploymentCleanupError('DEPLOYMENT_CLEANUP_UNCONFIRMED');unsafe.phase_error=journal.get('phase_error');unsafe.cleanup_error=journal['cleanup_error'];raise unsafe from error
    journal.update(status='FAILED' if failure else 'SUCCEEDED',finished_at=datetime.datetime.now(datetime.timezone.utc).isoformat());_write_report(journal_path,journal)
    if failure:raise failure
    return result

def run_install_phase(root,report_dir,owner,phase):
    require(phase in ('prepare','activate'),'INSTALL_PHASE_INVALID')
    return run_deployment_task(root,report_dir,['sh','scripts/install-vps.sh',owner],phase,
        PREPARE_TIMEOUT_SECONDS if phase=='prepare' else INSTALL_TIMEOUT_SECONDS)

def _terminate_for_rollback(_signum,_frame):
    raise ReleaseError('REMOTE_DEPLOYMENT_TERMINATED')

def data_env(path):
    return dict(line.split('=',1) for line in Path(path).read_text().splitlines() if line and not line.startswith('#'))

def command(args, cwd, input_text=None):
    result=subprocess.run(args,cwd=cwd,input=input_text,text=True,capture_output=True,timeout=120)
    require(result.returncode==0,'REMOTE_CHECK_FAILED')
    return result.stdout.strip()

def _read_private_regular(path, code):
    try:
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        with os.fdopen(fd,'rb') as source:
            require(stat.S_ISREG(os.fstat(source.fileno()).st_mode),code)
            data=source.read(MAX_RELEASE_ENV+1)
        require(0<len(data)<=MAX_RELEASE_ENV,code)
        return data
    except ReleaseError:
        raise
    except OSError:
        raise ReleaseError(code) from None

def current_portal_private_env(base=PORTAL_BASE):
    """Read and sanitize the active portal input while the deploy lock is held."""
    base=Path(base)
    try:
        state=json.loads(_read_private_regular(base/'current.json','PORTAL_CURRENT_STATE_INVALID'))
    except (json.JSONDecodeError,UnicodeDecodeError):
        raise ReleaseError('PORTAL_CURRENT_STATE_INVALID') from None
    run_id=state.get('run_id','') if isinstance(state,dict) else ''
    require(isinstance(run_id,str) and re.fullmatch(r'[0-9]+-[0-9]+',run_id),
            'PORTAL_CURRENT_STATE_INVALID')
    try:
        raw=_read_private_regular(base/'releases'/run_id/'runtime.env',
                                  'PORTAL_RUNTIME_ENV_INVALID').decode('utf-8')
    except UnicodeDecodeError:
        raise ReleaseError('PORTAL_RUNTIME_ENV_INVALID') from None
    filtered=[];removed={key:0 for key in PORTAL_GENERATED_ENV_KEYS};retained=set()
    for line in raw.splitlines():
        if not line or line.startswith('#'):
            filtered.append(line);continue
        require('=' in line,'PORTAL_RUNTIME_ENV_INVALID')
        key=line.split('=',1)[0]
        require(bool(re.fullmatch(r'[A-Z][A-Z0-9_]*',key)),'PORTAL_RUNTIME_ENV_INVALID')
        if key in PORTAL_GENERATED_ENV_KEYS:
            removed[key]+=1;continue
        require(key not in retained,'PORTAL_RUNTIME_ENV_INVALID')
        retained.add(key);filtered.append(line)
    require(bool(retained) and all(count==1 for count in removed.values()),
            'PORTAL_RUNTIME_ENV_FILTER_INVALID')
    return ('\n'.join(filtered)+'\n').encode('utf-8')

def _fsync_directory(path):
    flags=os.O_RDONLY|getattr(os,'O_DIRECTORY',0)
    descriptor=os.open(path,flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

def _write_report(path,report):
    """Publish a complete private report atomically for the polling client."""
    temporary=None
    try:
        descriptor,name=tempfile.mkstemp(prefix='.report-',suffix='.json',dir=path.parent)
        temporary=Path(name)
        with os.fdopen(descriptor,'w') as target:
            os.fchmod(target.fileno(),0o600)
            target.write(json.dumps(report,sort_keys=True)+'\n')
            target.flush();os.fsync(target.fileno())
        os.replace(temporary,path);temporary=None;_fsync_directory(path.parent)
    finally:
        if temporary is not None:
            try:temporary.unlink()
            except OSError:pass

def _systemctl_state(run,action,name):
    try:
        result=run(['systemctl',action,name],text=True,capture_output=True,timeout=30)
    except (OSError,subprocess.TimeoutExpired):
        raise ReleaseError('WAHA_BACKUP_STATE_READ_FAILED') from None
    value=str(getattr(result,'stdout','')).strip()
    allowed=({'enabled','enabled-runtime','disabled','static','indirect','generated','transient','alias','not-found'}
             if action=='is-enabled' else
             {'active','inactive','failed','activating','deactivating','reloading','unknown','not-found'})
    require(value in allowed,'WAHA_BACKUP_STATE_READ_FAILED')
    return value

def capture_waha_backup_state(runner=None,systemd_root=None):
    """Read exact unit bytes and runtime state before the candidate can change them."""
    run=runner or subprocess.run;unit_root=Path(systemd_root or SYSTEMD_ROOT);units={}
    for name in WAHA_BACKUP_UNITS:
        path=unit_root/name
        try:info=os.lstat(path)
        except FileNotFoundError:
            units[name]={'present':False,'content':None,'mode':None,'uid':None,'gid':None,
                         'enabled':False,'active':False}
            continue
        except OSError:raise ReleaseError('WAHA_BACKUP_UNIT_READ_FAILED') from None
        require(stat.S_ISREG(info.st_mode),'WAHA_BACKUP_UNIT_INVALID')
        content=_read_private_regular(path,'WAHA_BACKUP_UNIT_READ_FAILED')
        enabled=_systemctl_state(run,'is-enabled',name)
        active=_systemctl_state(run,'is-active',name)
        units[name]={'present':True,'content':content,'mode':stat.S_IMODE(info.st_mode),
                     'uid':info.st_uid,'gid':info.st_gid,'enabled':enabled.startswith('enabled'),
                     'active':active=='active'}
    return {'attempted':False,'units':units}

def _restore_unit_file(path,snapshot):
    try:
        try:current=os.lstat(path)
        except FileNotFoundError:current=None
        if current is not None:require(stat.S_ISREG(current.st_mode),'WAHA_BACKUP_UNIT_INVALID')
        if not snapshot['present']:
            if current is not None:path.unlink();_fsync_directory(path.parent)
            require(not path.exists() and not path.is_symlink(),'WAHA_BACKUP_UNIT_RESTORE_FAILED')
            return
        temporary=None
        try:
            descriptor,name=tempfile.mkstemp(prefix='.'+path.name+'.rollback-',dir=path.parent)
            temporary=Path(name)
            with os.fdopen(descriptor,'wb') as target:
                os.fchmod(target.fileno(),snapshot['mode'])
                if hasattr(os,'fchown'):os.fchown(target.fileno(),snapshot['uid'],snapshot['gid'])
                target.write(snapshot['content']);target.flush();os.fsync(target.fileno())
            os.replace(temporary,path);temporary=None;_fsync_directory(path.parent)
        finally:
            if temporary is not None:
                try:temporary.unlink()
                except OSError:pass
        restored=os.lstat(path)
        require(stat.S_ISREG(restored.st_mode)
                and stat.S_IMODE(restored.st_mode)==snapshot['mode']
                and restored.st_uid==snapshot['uid']
                and restored.st_gid==snapshot['gid']
                and path.read_bytes()==snapshot['content'],'WAHA_BACKUP_UNIT_RESTORE_FAILED')
    except ReleaseError:raise
    except OSError:raise ReleaseError('WAHA_BACKUP_UNIT_RESTORE_FAILED') from None

def restore_waha_backup_state(state,runner=None,systemd_root=None):
    """Stop candidate scheduling, restore prior units/state, then verify readback."""
    if state is None or state.get('attempted') is not True:
        return {'status':'NOT_APPLIED','units_restored':False,'runtime_state_restored':False}
    units=state.get('units');require(isinstance(units,dict)
        and set(units)==set(WAHA_BACKUP_UNITS),'WAHA_BACKUP_SNAPSHOT_INVALID')
    run=runner or subprocess.run;unit_root=Path(systemd_root or SYSTEMD_ROOT)
    def checked(args,code,safe_state=None):
        try:result=run(args,text=True,capture_output=True,timeout=60)
        except (OSError,subprocess.TimeoutExpired):raise ReleaseError(code) from None
        if getattr(result,'returncode',None)!=0:
            require(safe_state is not None
                    and _systemctl_state(run,safe_state[0],safe_state[1]) in safe_state[2],code)
    inactive={'inactive','failed','not-found'}
    disabled={'disabled','static','indirect','generated','transient','alias','not-found'}
    for name in WAHA_BACKUP_UNITS:
        checked(['systemctl','stop',name],'WAHA_BACKUP_STOP_FAILED',
                ('is-active',name,inactive))
        checked(['systemctl','disable',name],'WAHA_BACKUP_DISABLE_FAILED',
                ('is-enabled',name,disabled))
    for name in WAHA_BACKUP_UNITS:_restore_unit_file(unit_root/name,units[name])
    checked(['systemctl','daemon-reload'],'WAHA_BACKUP_RELOAD_FAILED')
    for name in WAHA_BACKUP_UNITS:
        previous=units[name]
        if previous['present'] and previous['enabled']:
            checked(['systemctl','enable',name],'WAHA_BACKUP_ENABLE_RESTORE_FAILED')
        if previous['present'] and previous['active']:
            checked(['systemctl','start',name],'WAHA_BACKUP_ACTIVE_RESTORE_FAILED')
        enabled=_systemctl_state(run,'is-enabled',name).startswith('enabled')
        active=_systemctl_state(run,'is-active',name)=='active'
        require(enabled==previous['enabled'] and active==previous['active'],
                'WAHA_BACKUP_STATE_RESTORE_FAILED')
    return {'status':'RESTORED','units_restored':True,'runtime_state_restored':True}

def _validate_current(previous_root,candidate_root):
    current=BASE/'current'
    try:
        try:
            current_info=os.lstat(current)
        except FileNotFoundError:
            return
        require(stat.S_ISLNK(current_info.st_mode),'ROLLBACK_CURRENT_STATE_INVALID')
        active=current.resolve(strict=True)
        require(active in (previous_root,candidate_root),'ROLLBACK_CURRENT_STATE_INVALID')
    except ReleaseError:
        raise
    except OSError:
        raise ReleaseError('ROLLBACK_CURRENT_STATE_INVALID') from None

def _restore_current(previous_root,candidate_root):
    current=BASE/'current'
    _validate_current(previous_root,candidate_root)
    try:
        staging=Path(tempfile.mkdtemp(prefix='.rollback-current-',dir=BASE))
        try:
            link=staging/'current'
            link.symlink_to(previous_root,target_is_directory=True)
            os.replace(link,current)
            _fsync_directory(BASE)
        finally:
            try:
                (staging/'current').unlink(missing_ok=True)
                staging.rmdir()
            except OSError:
                pass
        require(current.is_symlink() and current.resolve(strict=True)==previous_root,
                'ROLLBACK_CURRENT_RESTORE_FAILED')
    except ReleaseError:
        raise
    except OSError:
        raise ReleaseError('ROLLBACK_CURRENT_RESTORE_FAILED') from None

def _restore_release_env(expected):
    destination=PRIVATE/'release.env'
    temporary=None
    try:
        try:
            info=os.lstat(destination)
        except FileNotFoundError:
            info=os.stat(PRIVATE)
        else:
            require(stat.S_ISREG(info.st_mode),'ROLLBACK_RELEASE_ENV_INVALID')
        descriptor,name=tempfile.mkstemp(prefix='.rollback-release-',suffix='.env',dir=PRIVATE)
        temporary=Path(name)
        with os.fdopen(descriptor,'wb') as target:
            os.fchmod(target.fileno(),0o600)
            if hasattr(os,'fchown'):
                os.fchown(target.fileno(),info.st_uid,info.st_gid)
            target.write(expected)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary,destination)
        temporary=None
        _fsync_directory(PRIVATE)
        restored=_read_private_regular(destination,'ROLLBACK_RELEASE_ENV_RESTORE_FAILED')
        require(restored==expected,'ROLLBACK_RELEASE_ENV_RESTORE_FAILED')
    except ReleaseError:
        raise
    except OSError:
        raise ReleaseError('ROLLBACK_RELEASE_ENV_RESTORE_FAILED') from None
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass

def snapshot_api_deployment_status(report_dir):
    data=_read_private_regular(PRIVATE/'api.env','API_ENV_INVALID').decode('utf-8')
    values=[line.split('=',1)[1] for line in data.splitlines() if line.startswith('COMMERCE_DEPLOYMENT_STATUS=')]
    require(len(values)<=1,'API_DEPLOYMENT_STATUS_AMBIGUOUS')
    _write_report(Path(report_dir)/'previous-api-status.json',{'present':bool(values),'value':values[0] if values else None})

def restore_api_deployment_status(report_dir):
    snapshot=Path(report_dir)/'previous-api-status.json'
    # Historical reports did not capture this field; do not invent its value.
    if not snapshot.exists():return
    value=json.loads(_read_private_regular(snapshot,'API_STATUS_SNAPSHOT_INVALID'))
    require(isinstance(value,dict) and isinstance(value.get('present'),bool)
            and (not value['present'] or isinstance(value.get('value'),str) and not any(c in value['value'] for c in '\r\n')),'API_STATUS_SNAPSHOT_INVALID')
    destination=PRIVATE/'api.env'
    raw=_read_private_regular(destination,'API_ENV_INVALID').decode('utf-8')
    lines=raw.splitlines(keepends=True)
    require(sum(line.startswith('COMMERCE_DEPLOYMENT_STATUS=') for line in lines)<=1,'API_DEPLOYMENT_STATUS_AMBIGUOUS')
    content=''.join(line for line in lines if not line.startswith('COMMERCE_DEPLOYMENT_STATUS='))
    if value['present']:content+=('' if not content or content.endswith('\n') else '\n')+'COMMERCE_DEPLOYMENT_STATUS='+value['value']+'\n'
    descriptor,name=tempfile.mkstemp(prefix='.rollback-api-status-',dir=PRIVATE)
    try:
        with os.fdopen(descriptor,'w') as target:
            os.fchmod(target.fileno(),0o600);target.write(content);target.flush();os.fsync(target.fileno())
        os.replace(name,destination);_fsync_directory(PRIVATE)
    finally:
        Path(name).unlink(missing_ok=True)

def rollback_candidate(root,previous_root,report_dir,runner=None):
    """Restore the previous runtime/configuration only; PostgreSQL is never restored."""
    root,previous_root,report_dir=Path(root),Path(previous_root),Path(report_dir)
    try:
        releases=(BASE/'releases').resolve(strict=True)
        root=root.resolve(strict=True)
        previous_root=previous_root.resolve(strict=True)
        report_dir=report_dir.resolve(strict=True)
        require(root.parent==releases and previous_root.parent==releases and root!=previous_root,
                'ROLLBACK_RELEASE_INVALID')
        require(report_dir.parent==(PRIVATE/'deployments').resolve(strict=True),
                'ROLLBACK_REPORT_DIRECTORY_INVALID')
        require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}',previous_root.name),
                'ROLLBACK_RELEASE_INVALID')
        require((root/'scripts'/'release.sh').is_file(),'ROLLBACK_SCRIPT_MISSING')
    except ReleaseError:
        raise
    except OSError:
        raise ReleaseError('ROLLBACK_STATE_INVALID') from None
    previous_env=report_dir/'previous-release.env'
    previous_data=_read_private_regular(previous_env,'ROLLBACK_PREVIOUS_ENV_INVALID')
    try:
        release_env_info=os.lstat(PRIVATE/'release.env')
    except FileNotFoundError:
        release_env_info=None
    except OSError:
        raise ReleaseError('ROLLBACK_RELEASE_ENV_INVALID') from None
    if release_env_info is not None:
        require(stat.S_ISREG(release_env_info.st_mode),'ROLLBACK_RELEASE_ENV_INVALID')
    _validate_current(previous_root,root)
    restore_api_deployment_status(report_dir)
    try:
        result=run_deployment_task(root,report_dir,['sh','scripts/release.sh','rollback',str(previous_env)],'rollback',720,runner)
    except subprocess.TimeoutExpired:
        raise ReleaseError('ROLLBACK_COMMAND_TIMEOUT') from None
    except OSError:
        raise ReleaseError('ROLLBACK_COMMAND_FAILED') from None
    require(getattr(result,'returncode',None)==0,'ROLLBACK_COMMAND_FAILED')
    require(_read_private_regular(previous_env,'ROLLBACK_PREVIOUS_ENV_INVALID')==previous_data,
            'ROLLBACK_PREVIOUS_ENV_CHANGED')
    _restore_current(previous_root,root)
    _restore_release_env(previous_data)
    return {'status':'SUCCEEDED','release':previous_root.name,'services_restored':True,
            'current_restored':True,'release_env_restored':True,'database_restored':False}

def _rollback_error(error,fallback='ROLLBACK_FAILED'):
    code=str(error) if isinstance(error,ReleaseError) else ''
    return code if re.fullmatch(r'[A-Z0-9_]{1,100}',code) else fallback

def portal_rollback_result(error):
    value=getattr(error,'rollback',None)
    if value is None:return None,False
    if not isinstance(value,dict) or value.get('status') not in ('SUCCEEDED','FAILED'):
        return {'status':'FAILED','error':'PORTAL_ROLLBACK_REPORT_INVALID',
                'database_restored':False},True
    result={'status':value['status'],'current_restored':value.get('current_restored') is True,
            'previous_container_started':value.get('previous_container_started') is True,
            'candidate_stopped':value.get('candidate_stopped') is True,
            'database_restored':False}
    proxy_result=value.get('proxy')
    if isinstance(proxy_result,dict) and proxy_result.get('status') in ('NOT_APPLIED','RESTORED','UNCHANGED','FAILED'):
        result['proxy']={'status':proxy_result['status']}
        if proxy_result.get('other_sites_preserved') is True:
            result['proxy']['other_sites_preserved']=True
        proxy_error=proxy_result.get('error')
        if isinstance(proxy_error,str) and re.fullmatch(r'[A-Z0-9_]{1,100}',proxy_error):
            result['proxy']['error']=proxy_error
    else:
        result['proxy']={'status':'FAILED','error':'PORTAL_ROLLBACK_REPORT_INVALID'}
        result['status']='FAILED'
    code=value.get('error')
    if isinstance(code,str) and re.fullmatch(r'[A-Z0-9_]{1,100}',code):result['error']=code
    elif result['status']=='FAILED':result['error']='PORTAL_ROLLBACK_FAILED'
    return result,result['status']=='FAILED'

def recover_failed_install(root,previous_root,report_dir,report,identity_proxy=None,
                           runner=None,proxy_runner=None,waha_backup_state=None,
                           systemd_runner=None,systemd_root=None):
    """Record a bounded rollback result while leaving report['error'] untouched."""
    failures=[]
    try:
        core=rollback_candidate(root,previous_root,report_dir,runner)
    except Exception as error:
        core={'status':'FAILED','error':_rollback_error(error),'database_restored':False}
        failures.append(core['error'])
    try:
        identity=restore_identity_proxy(root,identity_proxy,proxy_runner)
    except Exception as error:
        identity={'status':'FAILED','error':_rollback_error(error,'IDENTITY_PROXY_RESTORE_FAILED')}
        failures.append(identity['error'])
    try:
        waha=restore_waha_backup_state(waha_backup_state,systemd_runner,systemd_root)
    except Exception as error:
        waha={'status':'FAILED','error':_rollback_error(error,'WAHA_BACKUP_RESTORE_FAILED'),
              'units_restored':False,'runtime_state_restored':False}
        failures.append(waha['error'])
    report['rollback']={'status':'FAILED' if failures else 'SUCCEEDED','core':core,
                        'identity_proxy':identity,'waha_backup_timer':waha,
                        'database_restored':False}
    return ReleaseError('DEPLOYMENT_ROLLBACK_FAILED') if failures else None

def update_identity_proxy(root, runner=None):
    run=runner or subprocess.run
    try:
        result=run([sys.executable,'scripts/update-identity-proxy.py'],cwd=root,text=True,capture_output=True,timeout=150)
    except subprocess.TimeoutExpired:
        raise ReleaseError('IDENTITY_PROXY_TIMEOUT') from None
    if result.returncode!=0:
        try:
            failure=json.loads(result.stderr)
            code=failure.get('error','')
            if failure.get('status')=='FAILED' and isinstance(code,str) and re.fullmatch(r'[A-Z0-9_]{1,100}',code):
                raise ReleaseError('IDENTITY_PROXY_'+code)
        except (ValueError,AttributeError):
            pass
        raise ReleaseError('IDENTITY_PROXY_UPDATE_FAILED')
    try:
        result=json.loads(result.stdout)
    except ValueError:
        raise ReleaseError('IDENTITY_PROXY_INVALID_REPORT') from None
    require(isinstance(result,dict) and result.get('status') in ('UPDATED','UNCHANGED') and result.get('other_sites_preserved') is True,'IDENTITY_PROXY_INVALID_REPORT')
    if result['status']=='UPDATED':
        require(isinstance(result.get('rollback_token'),str)
                and re.fullmatch(r'identity-proxy-[A-Za-z0-9._-]{1,80}',result['rollback_token']),
                'IDENTITY_PROXY_INVALID_REPORT')
        return {'status':'UPDATED','other_sites_preserved':True,
                'rollback_token':result['rollback_token']}
    require('rollback_token' not in result,'IDENTITY_PROXY_INVALID_REPORT')
    return {'status':'UNCHANGED','other_sites_preserved':True}

def restore_identity_proxy(root,receipt,runner=None):
    if receipt is None:
        return {'status':'NOT_APPLIED','other_sites_preserved':True}
    require(isinstance(receipt,dict) and receipt.get('status') in ('UPDATED','UNCHANGED'),
            'IDENTITY_PROXY_RESTORE_RECEIPT_INVALID')
    if receipt['status']=='UNCHANGED':
        return {'status':'NOT_REQUIRED','other_sites_preserved':True}
    token=receipt.get('rollback_token')
    require(isinstance(token,str) and re.fullmatch(r'identity-proxy-[A-Za-z0-9._-]{1,80}',token),
            'IDENTITY_PROXY_RESTORE_RECEIPT_INVALID')
    run=runner or subprocess.run
    try:
        result=run([sys.executable,'scripts/update-identity-proxy.py','restore',token],cwd=root,
                   text=True,capture_output=True,timeout=150)
    except subprocess.TimeoutExpired:
        raise ReleaseError('IDENTITY_PROXY_RESTORE_TIMEOUT') from None
    if result.returncode!=0:
        try:
            failure=json.loads(result.stderr)
            code=failure.get('error','')
            if failure.get('status')=='FAILED' and isinstance(code,str) and re.fullmatch(r'[A-Z0-9_]{1,100}',code):
                raise ReleaseError('IDENTITY_PROXY_RESTORE_'+code)
        except (ValueError,AttributeError):
            pass
        raise ReleaseError('IDENTITY_PROXY_RESTORE_FAILED')
    try:
        result=json.loads(result.stdout)
    except ValueError:
        raise ReleaseError('IDENTITY_PROXY_RESTORE_INVALID_REPORT') from None
    require(isinstance(result,dict) and result.get('status') in ('RESTORED','UNCHANGED')
            and result.get('other_sites_preserved') is True,
            'IDENTITY_PROXY_RESTORE_INVALID_REPORT')
    return {'status':result['status'],'other_sites_preserved':True}

def database(root,sql):
    return command(['sh','scripts/compose-release.sh',str(PRIVATE/'release.env'),'exec','-T','postgres','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','commerce_owner','-d','commerce'],root,sql)

def migrations(root):
    return json.loads(database(root,"SELECT COALESCE(jsonb_object_agg(name,sha256),'{}') FROM schema_migrations;"))

def preserved_containers():
    ids=subprocess.check_output(['docker','ps','-aq'],text=True).split()
    if not ids:return {}
    records=json.loads(subprocess.check_output(['docker','inspect',*ids],text=True))
    return {r['Id']:{'image':r['Image'],'started':r['State']['StartedAt'],'networks':sorted(r['NetworkSettings']['Networks']),'mounts':sorted((m.get('Name',m['Source']),m['Destination']) for m in r['Mounts'])} for r in records if r['State']['Running'] and (r['Config'].get('Labels',{}).get('com.docker.compose.project')!='commerce-os' or r['Config'].get('Labels',{}).get('com.docker.compose.service') in ('postgres','waha-01'))}

def gateway_inventory():
    import hashlib
    ids=subprocess.check_output(['docker','ps','-aq'],text=True).split()
    rows=json.loads(subprocess.check_output(['docker','inspect',*ids],text=True)) if ids else []
    result={}
    for r in rows:
        labels=r['Config'].get('Labels',{})
        service=labels.get('com.docker.compose.service','')
        if labels.get('com.docker.compose.project')!='commerce-os' or not re.fullmatch(r'waha-\d{2}',service):continue
        config=r['Config'];environment=config.get('Env',[])
        flags=dict(v.split('=',1) for v in environment if '=' in v)
        session_mount=next((v for v in r['Mounts'] if v['Destination']=='/app/.sessions'),None)
        permissions={'status':'NOT_OBSERVED'}
        if session_mount:
            try:
                metadata=Path(session_mount['Source']).stat()
                permissions={'status':'OBSERVED','uid':metadata.st_uid,'gid':metadata.st_gid,'mode':oct(metadata.st_mode & 0o777),'disk_encryption':'NOT_OBSERVED'}
            except OSError:pass
        result[r['Id']]={'session_directory_permissions':permissions,'image_user':config.get('User',''),'service':service,'engine':flags.get('WHATSAPP_DEFAULT_ENGINE','UNKNOWN'),'image':r['Image'],'running':r['State']['Running'],'started_at':r['State']['StartedAt'],'restart_policy':r['HostConfig']['RestartPolicy'],
          'mounts':sorted((m.get('Name',m['Source']),m['Destination']) for m in r['Mounts']),
          'configuration_sha256':hashlib.sha256(json.dumps(environment,sort_keys=True).encode()).hexdigest(),
          'autostart_disabled':all(flags.get(k,'false').lower()=='false' for k in ['WHATSAPP_RESTART_ALL_SESSIONS','WAHA_WORKER_RESTART_SESSIONS']) and not flags.get('WHATSAPP_START_SESSION','')}
    return result

def verify_session_preservation(root,before):
    after=gateway_inventory()
    require(after==before,'WAHA_GATEWAY_OR_VOLUME_CHANGED')
    require(all(v['autostart_disabled'] for v in after.values()),'WAHA_AUTOSTART_UNSAFE')
    snapshot=json.loads(database(root,"SELECT COALESCE(json_agg(json_build_object('account_id',account_id,'desired_state',desired_state,'recovery_enabled',recovery_enabled,'operational_pause',operational_pause,'observed_state',observed_state,'backup_status',backup_status,'primary_usage_source',primary_usage_source)),'[]') FROM channel_sessions WHERE environment='REAL' AND archived_at IS NULL;"))
    return {'gateways':after,'sessions':snapshot,'gateways_and_volumes_preserved':True,'autostart_disabled':True}

def install_waha_backup_timer(root):
    for name in WAHA_BACKUP_UNITS:
        source=root/'infra'/'systemd'/name
        require(source.is_file(),'WAHA_BACKUP_TIMER_MISSING')
        shutil.copyfile(source,Path('/etc/systemd/system')/name)
    command(['systemctl','daemon-reload'],root)
    command(['systemctl','enable','--now','commerce-waha-backup.timer'],root)
    # Read/check and copy already-stopped gateways only; never stops a productive account.
    # systemd joins a catch-up run already started by the persistent timer.
    backup=subprocess.run(['systemctl','start','commerce-waha-backup.service'],cwd=root,text=True,capture_output=True,timeout=300)
    require(backup.returncode==0,'WAHA_BACKUP_SCHEDULE_FAILED')
    receipt=json.loads((PRIVATE/'waha-backups'/'latest.json').read_text())
    return {'timer_enabled':True,'latest':receipt}

def verify_identity_headers(origin, opener=None):
    open_url=opener or urllib.request.urlopen
    for path in ['/login','/forgot-password','/reset-password','/account/security']:
        with open_url(origin+path,timeout=30) as response:
            cache={part.strip().lower() for part in response.headers.get('Cache-Control','').split(',')}
            require(response.status==200 and 'no-store' in cache and response.headers.get('Referrer-Policy')=='no-referrer','HTTPS_IDENTITY_HEADERS_FAILED')
    return True

def verify_creative_headers(origin, opener=None):
    open_url=opener or urllib.request.urlopen
    with open_url(origin+'/products',timeout=30) as response:
        policy=response.headers.get('Content-Security-Policy','')
        directives={part.strip().split(' ',1)[0]:part.strip().split(' ',1)[1] for part in policy.split(';') if len(part.strip().split(' ',1))==2}
        require(response.status==200 and directives.get('connect-src')=="'self' https://*.r2.cloudflarestorage.com" and directives.get('media-src')=="'self' blob: https://*.r2.cloudflarestorage.com" and directives.get('script-src')=="'self'",'HTTPS_CREATIVE_HEADERS_FAILED')
    return True

def verify_creative_device_routing(origin, opener=None):
    """An unauthenticated asset GET must hit the device gate without creating pairing state."""
    open_url = opener or urllib.request.urlopen
    path = '/creative-device/v1/assets/00000000-0000-4000-8000-000000000000/access'
    try:
        response = open_url(origin + path, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        require(response.status == 410, 'HTTPS_DEVICE_ROUTE_STATUS_FAILED')
        require(response.headers.get('Content-Type', '').split(';')[0].strip().lower()
                == 'application/json', 'HTTPS_DEVICE_ROUTE_CONTENT_TYPE_FAILED')
        raw = response.read(16385)
        require(len(raw) <= 16384, 'HTTPS_DEVICE_ROUTE_RESPONSE_TOO_LARGE')
        try:
            body = json.loads(raw)
        except (ValueError, TypeError):
            raise ReleaseError('HTTPS_DEVICE_ROUTE_JSON_FAILED') from None
        require(isinstance(body, dict) and isinstance(body.get('error'), dict)
                and body['error'].get('code') == 'PLATFORM_PRODUCTION_RETIRED',
                'HTTPS_DEVICE_ROUTE_GATE_FAILED')
    return True

def verify_core_version(origin, source_sha, opener=None):
    """Read only the public, bounded build identity and bind it to RELEASE.json."""
    require(re.fullmatch(r'[a-f0-9]{40}', source_sha), 'INVALID_SOURCE_SHA')
    open_url = opener or urllib.request.urlopen
    with open_url(origin + '/api/version', timeout=30) as response:
        require(response.status == 200, 'HTTPS_CORE_VERSION_STATUS_FAILED')
        require(response.headers.get('Content-Type', '').split(';')[0].strip().lower()
                == 'application/json', 'HTTPS_CORE_VERSION_CONTENT_TYPE_FAILED')
        raw = response.read(4097)
        require(len(raw) <= 4096, 'HTTPS_CORE_VERSION_RESPONSE_TOO_LARGE')
        try:
            body = json.loads(raw)
        except (ValueError, TypeError):
            raise ReleaseError('HTTPS_CORE_VERSION_JSON_FAILED') from None
        require(isinstance(body, dict)
                and body.get('service') == 'commerce-api'
                and body.get('configured') is True
                and body.get('sha') == source_sha
                and isinstance(body.get('release'), str)
                and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', body['release']),
                'HTTPS_CORE_VERSION_MISMATCH')
    return {'sha': source_sha, 'release': body['release']}

def raw_policy_snapshot(root):
    # Kept only in process memory; never put commercial settings into a release report.
    return database(root,"SELECT COALESCE(jsonb_object_agg(workspace_id,jsonb_build_object('version',version,'body',body)),'{}'::jsonb) FROM operational_settings WHERE environment='REAL';")

def compatible_release_images(previous_env,candidate_env,root):
    """Read the marker from the images that actually ran, not the release tar.

    The tar contains image archives and migrations, but not the staged runtime
    source tree. A file check in the extracted tar silently skipped the policy
    parity assertion on every compatible release.
    """
    marker="console.log(require('node:fs').existsSync('/app/packages/db/src/release-hold-capability.json')?'1':'0')"
    observed=[]
    for image in (data_env(previous_env)['COMMERCE_IMAGE'],data_env(candidate_env)['COMMERCE_IMAGE']):
        require(bool(re.fullmatch(r'sha256:[a-f0-9]{64}',image)),'RELEASE_HOLD_IMAGE_UNKNOWN')
        answer=command(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL',image,'node','-e',marker],root)
        require(answer in ('0','1'),'RELEASE_HOLD_CAPABILITY_UNKNOWN')
        observed.append(answer=='1')
    return all(observed)

def smoke(root, metadata, before, before_policy=None, compatible=False, scope='full'):
    env=data_env(PRIVATE/'release.env')
    images=json.loads((root/'images.json').read_text())
    keys={'commerce-os:release':'COMMERCE_IMAGE','commerce-os-web:release':'COMMERCE_WEB_IMAGE','commerce-os-maintenance:release':'COMMERCE_MAINTENANCE_IMAGE'}
    for tag,key in keys.items():
        info=json.loads(command(['docker','image','inspect',env[key]],root))[0]
        # Containerd may report the OCI index as Id; layers are stable across stores.
        require(info['Os']=='linux' and info['Architecture']=='amd64' and info['RootFS']['Layers']==images[tag]['layers'],'DEPLOYED_IMAGE_MISMATCH')
    selected=['api','web','postgres'] if scope=='api-web' else SERVICES
    for service in selected:
        cid=command(['sh','scripts/compose-release.sh',str(PRIVATE/'release.env'),'ps','-q',service],root)
        require(bool(cid),'SERVICE_MISSING')
        item=json.loads(command(['docker','inspect',cid],root))[0]
        require(item['State']['Running'] and item['State'].get('Health',{}).get('Status')=='healthy','SERVICE_NOT_HEALTHY')
        if service!='postgres':
            expected=env['COMMERCE_WEB_IMAGE' if service=='web' else 'COMMERCE_IMAGE']
            expected_id=json.loads(command(['docker','image','inspect',expected],root))[0]['Id']
            require(item['Image']==expected_id,'CONTAINER_IMAGE_MISMATCH')
    verify_migrations(migrations(root),metadata['migration_hashes'],complete=True)
    hold=database(root,"SELECT count(*) FROM operational_settings WHERE environment='REAL' AND release_hold;")
    require(hold=='0','REAL_RELEASE_HOLD_STUCK')
    if compatible:
        require(raw_policy_snapshot(root)==before_policy,'REAL_COMMERCIAL_POLICY_CHANGED_BY_RELEASE')
    frozen=database(root,"SELECT count(*)>0 AND bool_and(body @> '{\"dispatch_frozen\":true,\"real_sends_enabled\":false,\"allow_real_operations\":false}'::jsonb) FROM operational_settings WHERE environment='REAL';")
    after=preserved_containers()
    require(all(after.get(k)==v for k,v in before.items()),'PRESERVED_INFRASTRUCTURE_CHANGED')
    origin=env['COMMERCE_ORIGIN']
    require(origin=='https://commerce-os.inovaris.online','UNEXPECTED_ORIGIN')
    for name,checksum in json.loads((root/'web-manifest.json').read_text()).items():
        with urllib.request.urlopen(origin+'/'+name,timeout=30) as response:
            import hashlib
            require(response.status==200 and hashlib.sha256(response.read()).hexdigest()==checksum,'HTTPS_WEB_PARITY_FAILED')
    with urllib.request.urlopen(origin+'/readyz',timeout=30) as response:
        require(response.status==200,'HTTPS_READINESS_FAILED')
        if scope=='api-web':
            raw=response.read(4097)
            require(len(raw)<=4096 and json.loads(raw)=={'status':'ready','service':'api'},
                    'HTTPS_API_DATABASE_READINESS_FAILED')
    core_version=verify_core_version(origin,metadata['source_sha'])
    verify_identity_headers(origin)
    verify_creative_headers(origin)
    verify_creative_device_routing(origin)
    return {'core_version':core_version,'creative_device_routing_verified':True,'creative_http_headers_verified':True,'identity_http_headers_verified':True,'healthy_services':len(selected),'migration_count':len(metadata['migration_hashes']),'real_dispatch_frozen':frozen=='t','commercial_policy_preserved':compatible,'release_hold_cleared':True,'infrastructure_preserved':True,'https_web_parity':True,'provider_calls':{'status':'NOT_OBSERVABLE','zero_claim':False}}

def verify_ciclo_maintenance(opener=None):
    open_url=opener or urllib.request.urlopen
    try:response=open_url('https://ciclo.inovaris.online',timeout=30)
    except urllib.error.HTTPError as error:response=error
    with response:
        require(response.status==503,'CICLO_MAINTENANCE_CHANGED')
    return True

def verify_ciclo_state(state, opener=None):
    portal=state.get('portal')
    if portal is None:return verify_ciclo_maintenance(opener)
    open_url=opener or urllib.request.urlopen
    with open_url('https://ciclo.inovaris.online/api/version',timeout=30) as response:
        require(response.status==200,'COPY_PORTAL_HTTPS_VERSION_FAILED')
        raw=response.read(4097)
        require(0<len(raw)<=4096,'COPY_PORTAL_HTTPS_VERSION_BOUND')
        value=api_web.unique_json(raw)
        require(value.get('release')==portal['source_sha'] and value.get('activities')==480
                and value.get('grades')==9 and value.get('core_pdfs')==9
                and value.get('calendar_in_portal') is False,'COPY_PORTAL_HTTPS_VERSION_CHANGED')
    return True

def owner_auth_date(value):
    require(type(value) is str and len(value)<=40,'COPY_OWNER_AUTH_TIMESTAMP_REQUIRED')
    try:result=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
    except (ValueError,OverflowError):raise ReleaseError('COPY_OWNER_AUTH_TIMESTAMP_REQUIRED')
    require(result.tzinfo is not None and result.utcoffset()==datetime.timedelta(0),
            'COPY_OWNER_AUTH_UTC_REQUIRED')
    return result

def owner_auth_lifecycle(value):
    """Validate a private observation; only aggregate facts may enter a report."""
    require(type(value) is dict and set(value)=={'clock_utc','read_only','sessions','tokens','memberships'}
            and value['read_only']=='on','COPY_OWNER_AUTH_READONLY_REQUIRED')
    clock=owner_auth_date(value['clock_utc'])
    sessions=value['sessions'];tokens=value['tokens'];members=value['memberships']
    require(all(type(rows) is list for rows in (sessions,tokens,members))
            and 0<=len(sessions)<=api_web.MAX_OWNER_SESSIONS and len(tokens)==1
            and 1<=len(members)<=api_web.MAX_OWNER_USERS,
            'COPY_OWNER_AUTH_BINDING_CHANGED')
    session_fields={'id','user_id','created_at','updated_at','expires_at','unexpired'}
    token_fields={'id','user_id','workspace_id','allowed_environments','version','created_at',
                  'expires_at','revoked_at','unexpired'}
    member_fields={'user_id','workspace_id','role','active'}
    require(all(type(row) is dict and set(row)==session_fields for row in sessions)
            and all(type(row) is dict and set(row)==token_fields for row in tokens)
            and all(type(row) is dict and set(row)==member_fields for row in members),
            'COPY_OWNER_AUTH_FIELDS_CHANGED')
    def identifier(value):
        return type(value) is str and re.fullmatch(r'[A-Za-z0-9_:-]{1,160}',value) is not None
    token=tokens[0];workspace=token['workspace_id'];owner=token['user_id']
    require(all(identifier(row[key]) for row in sessions for key in ('id','user_id'))
            and all(identifier(token[key]) for key in ('id','user_id','workspace_id'))
            and all(identifier(row[key]) for row in members for key in ('user_id','workspace_id')),
            'COPY_OWNER_AUTH_IDENTIFIERS_REQUIRED')
    require(len({row['id'] for row in sessions})==len(sessions)
            and len({row['created_at'] for row in sessions})==len(sessions),
            'COPY_OWNER_AUTH_BINDING_CHANGED')
    environments=token['allowed_environments']
    require(type(environments) is list and 1<=len(environments)<=2
            and all(type(environment) is str and environment in ('REAL','SIMULATION') for environment in environments)
            and len(set(environments))==len(environments) and 'REAL' in environments
            and type(token['version']) is int and token['version']>0,
            'COPY_OWNER_AUTH_PAT_PERMISSIONS_CHANGED')
    token_created=owner_auth_date(token['created_at']);token_expiry=owner_auth_date(token['expires_at'])
    require(token_created<=clock<token_expiry and token['revoked_at'] is None
            and token['unexpired'] is True,'COPY_OWNER_AUTH_PAT_NOT_VALID')
    owners={row['user_id'] for row in members}
    require(len(owners)==len(members) and owner in owners
            and all(row['workspace_id']==workspace and row['active'] is True and row['role']=='owner' for row in members)
            and all(row['user_id'] in owners for row in sessions),'COPY_OWNER_AUTH_NOT_CANONICAL')
    active=0
    for row in sessions:
        created=owner_auth_date(row['created_at']);updated=owner_auth_date(row['updated_at'])
        expiry=owner_auth_date(row['expires_at'])
        require(created<=updated<=clock and expiry>updated
                and abs((expiry-updated).total_seconds()-43200)<=1,
                'COPY_OWNER_AUTH_SESSION_LIFECYCLE_INVALID')
        require(type(row['unexpired']) is bool and row['unexpired'] is (expiry>clock),
                'COPY_OWNER_AUTH_CLOCK_FACT_MISMATCH')
        active+=int(row['unexpired'])
    return {'retained_session_rows':len(sessions),'active_sessions':active,'expired_sessions':len(sessions)-active,
            'valid_nonrevoked_pat_rows':1,'active_owner_users':len(owners)}

def compare_owner_auth(before,after):
    """Preserve identity across a natural expiry; reject auth changes or revival."""
    owner_auth_lifecycle(before);facts=owner_auth_lifecycle(after)
    require(owner_auth_date(after['clock_utc'])>=owner_auth_date(before['clock_utc']),
            'COPY_OWNER_AUTH_CLOCK_REVERSED')
    def identity(value):
        return {'sessions':sorted((row['id'],row['user_id'],row['created_at']) for row in value['sessions']),
                'tokens':[{key:row[key] for key in row if key!='unexpired'} for row in value['tokens']],
                'memberships':sorted(value['memberships'],key=lambda row:(row['user_id'],row['workspace_id']))}
    require(identity(before)==identity(after),'COPY_OWNER_AUTH_IDENTITY_CHANGED')
    previous={row['id']:row for row in before['sessions']};renewed=0
    for observed in after['sessions']:
        old=previous[observed['id']]
        old_update=owner_auth_date(old['updated_at']);new_update=owner_auth_date(observed['updated_at'])
        old_expiry=owner_auth_date(old['expires_at']);new_expiry=owner_auth_date(observed['expires_at'])
        if new_update==old_update and new_expiry==old_expiry:continue
        # auth.ts: expiresIn=12h/updateAge=1h. BetterAuth updates existing rows
        # only after checking expiry; its expiry/update timestamps may skew <=1s.
        require(old_update<new_update<old_expiry and old_expiry<new_expiry
                and new_update>=old_expiry-datetime.timedelta(seconds=43200-3600+1),
                'COPY_OWNER_AUTH_NONCANONICAL_RENEWAL')
        renewed+=1
    return facts|{'identity_preserved':True,'canonical_renewed_sessions':renewed}

def owner_auth_snapshot(root):
    # Private IDs/times stay in RAM; no email/cookie/PAT hash/IP/name is selected.
    workspace=data_env(PRIVATE/'api.env').get('WORKSPACE_ID','')
    require(bool(re.fullmatch(r'[A-Za-z0-9_:-]{1,160}',workspace)),'COPY_PRIVATE_WORKSPACE_REQUIRED')
    value=json.loads(database(root,"""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
      SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s'; SET LOCAL TimeZone='UTC';
      SELECT json_build_object('clock_utc',now(),'read_only',current_setting('transaction_read_only'),
      'sessions',(SELECT coalesce(json_agg(s ORDER BY id),'[]') FROM
        (SELECT id,"userId" user_id,"createdAt" created_at,"updatedAt" updated_at,
          "expiresAt" expires_at,"expiresAt">now() unexpired FROM session) s),
      'tokens',(SELECT coalesce(json_agg(t ORDER BY id),'[]') FROM
        (SELECT id,user_id,workspace_id,allowed_environments,version,created_at,expires_at,
         revoked_at,expires_at>now() unexpired FROM personal_access_tokens WHERE revoked_at IS NULL) t),
      'memberships',(SELECT coalesce(json_agg(m ORDER BY user_id,workspace_id),'[]') FROM
        (SELECT user_id,workspace_id,role,active FROM memberships WHERE workspace_id='"""+workspace+"""'
          AND active AND role='owner') m)); ROLLBACK;"""))
    owner_auth_lifecycle(value)
    require(value['tokens'][0]['workspace_id']==workspace,'COPY_OWNER_AUTH_NOT_CANONICAL')
    return value

def publish_api_web(archive,archive_hash,sha,run_id,portal_private_env):
    """A fresh prepare backup, then ordered locks and a second baseline read."""
    require(portal_private_env==NO_PORTAL,'API_WEB_PORTAL_NOT_SELECTED')
    report_dir=PRIVATE/'deployments'/run_id
    require(not report_dir.exists(),'EXISTING_REPORT_INSPECT_OR_USE_NEW_RUN_ATTEMPT')
    report_dir.mkdir(mode=0o700,parents=True)
    report={'source_sha':sha,'run_id':run_id,'deployment_scope':'api-web',
            'full_runtime_started':False,'consumers_started':False,
            'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'status':'RUNNING','stage':'validate'}
    locks=[];prepare_lock=None;root=None;baseline=None;previous_root=None
    installation_started=False;rebase_started=False
    os.environ['COMMERCE_DEPLOY_SCOPE']='api-web'
    signal.signal(signal.SIGTERM,_terminate_for_rollback)
    try:
        prepare_lock=api_web.acquire_locks_for_prepare(PRIVATE)
        previous_root=(BASE/'current').resolve(strict=True)
        baseline=api_web.snapshot(PRIVATE,previous_root,command,report_dir)
        api_web.database_guard(database,previous_root)
        before_policy=raw_policy_snapshot(previous_root)
        before_auth=owner_auth_snapshot(previous_root)
        report['owner_auth_lifecycle']=owner_auth_lifecycle(before_auth)
        verify_ciclo_state(baseline['state'])
        current_metadata=json.loads((previous_root/'RELEASE.json').read_text())
        if current_metadata.get('source_sha')==sha:
            for path in sorted((PRIVATE/'deployments').glob('*/report.json'),reverse=True):
                prior=json.loads(api_web.protected_bytes(path))
                if (prior.get('status')=='SUCCEEDED' and prior.get('source_sha')==sha
                        and prior.get('deployment_scope')=='api-web' and prior.get('release')==previous_root.name):
                    report.update(prior,run_id=run_id,deduplicated=True,reused_run_id=prior['run_id'])
                    return
        require(shutil.disk_usage(BASE).free>max(4*1024**3,Path(archive).stat().st_size*5),'INSUFFICIENT_FREE_DISK')
        root=BASE/'releases'/('ci-'+run_id+'-'+sha[:12])
        extract_release(archive,root,archive_hash)
        metadata=json.loads((root/'RELEASE.json').read_text())
        require(metadata['source_sha']==sha and str(metadata['run_id'])==run_id.split('-')[0],'RELEASE_SOURCE_MISMATCH')
        require(len(metadata['migration_hashes'])==65,'COPY_65_MIGRATIONS_REQUIRED')
        verify_migrations(migrations(previous_root),metadata['migration_hashes'],complete=True)
        before=preserved_containers()
        shutil.copyfile(PRIVATE/'release.env',report_dir/'previous-release.env')
        snapshot_api_deployment_status(report_dir)
        report['previous_release']=previous_root.name
        report['stage']='prepare';_write_report(report_dir/'report.json',report)
        # Existing prepare loads verified images and makes a NEW canonical dump.
        # It owns schedule/maintenance locks itself; holding those here deadlocks.
        run_install_phase(root,report_dir,'@existing-owner','prepare')
        report['predeploy_backup']=api_web.verify_predeploy_backup(PRIVATE,report_dir)
        report['predeploy_backup_completed']=True
        prepare_lock.close();prepare_lock=None
        locks=api_web.acquire_locks(PRIVATE)
        fresh=api_web.snapshot(PRIVATE,previous_root,command,report_dir)
        require(fresh['state_raw']==baseline['state_raw'] and fresh['plan_raw']==baseline['plan_raw'],
                'COPY_PREPARE_BASELINE_CHANGED')
        api_web.database_guard(database,previous_root)
        require(raw_policy_snapshot(previous_root)==before_policy,'REAL_COMMERCIAL_POLICY_CHANGED_DURING_PREPARE')
        report['owner_auth_lifecycle']=compare_owner_auth(before_auth,owner_auth_snapshot(previous_root))
        verify_migrations(migrations(previous_root),metadata['migration_hashes'],complete=True)
        baseline=fresh
        os.environ['COMMERCE_API_WEB_LOCKS_HELD']='1'
        report['stage']='install';_write_report(report_dir/'report.json',report)
        installation_started=True
        run_install_phase(root,report_dir,'@existing-owner','activate')
        report['stage']='verify';_write_report(report_dir/'report.json',report)
        api_web.database_guard(database,root)
        report['owner_auth_lifecycle']=compare_owner_auth(before_auth,owner_auth_snapshot(root))
        report.update(smoke(root,metadata,before,before_policy,True,'api-web'))
        after=api_web.inventory(command,root,baseline['state'].get('portal'))
        api_web.compare_after(baseline,after,command,root,PRIVATE)
        require((BASE/'current').resolve(strict=True)==root,'COPY_CURRENT_READBACK_FAILED')
        report['ciclo_state_preserved']=verify_ciclo_state(baseline['state'])
        report['ciclo_maintenance_preserved']=not bool(baseline['state'].get('portal'))
        report.update(consumers_absent=True,postgres_caddy_profiles_auth_preserved=True,
                      smtp_disabled=True,firewall_configuration_mutations=0)
        report['stage']='rebase';rebase_started=True
        # Interrupted CAS needs read-only reconciliation; never automatic rebase
        # or rollback against a plan which may already have been changed.
        report['backup_continuity']=api_web.rebase(PRIVATE,baseline,after,root,_write_report,report_dir)
        report.update(status='SUCCEEDED',stage='complete',release=root.name)
    except Exception as error:
        report.update(status='FAILED',error=error_code(error))
        if rebase_started:
            report['rollback']={'status':'BLOCKED','error':'COPY_REBASE_RECONCILIATION_REQUIRED','database_restored':False}
        elif installation_started and isinstance(error,DeploymentCleanupError):
            report['rollback']={'status':'BLOCKED','error':'DEPLOYMENT_TASK_STATE_UNCONFIRMED','database_restored':False}
        elif installation_started:
            try:
                report['rollback']=rollback_candidate(root,previous_root,report_dir)
                api_web.database_guard(database,previous_root)
                verify_migrations(migrations(previous_root),metadata['migration_hashes'],complete=True)
                require(raw_policy_snapshot(previous_root)==before_policy,'COPY_ROLLBACK_POLICY_CHANGED')
                report['owner_auth_lifecycle']=compare_owner_auth(before_auth,owner_auth_snapshot(previous_root))
                after=api_web.inventory(command,previous_root,baseline['state'].get('portal'))
                api_web.compare_after(baseline,after,command,previous_root,PRIVATE)
                verify_ciclo_state(baseline['state'])
                rebase_started=True
                report['backup_continuity']=api_web.rebase(PRIVATE,baseline,after,previous_root,_write_report,report_dir)
                report['rollback']['scope']='api-web'
            except Exception as recovery:
                report['rollback']={'status':'FAILED','error':error_code(recovery),'database_restored':False}
        raise
    finally:
        os.environ.pop('COMMERCE_API_WEB_LOCKS_HELD',None)
        if prepare_lock is not None:prepare_lock.close()
        for lock in reversed(locks):lock.close()
        report['finished_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
        _write_report(report_dir/'report.json',report)
        print(json.dumps(report,sort_keys=True))

def main():
    os.umask(0o077)
    require(os.geteuid()==0,'ROOT_REQUIRED')
    if len(sys.argv)==3 and sys.argv[1]=='reconcile-copy-runtime-gateways':
        from copy_runtime_deployment import reconcile_gateways
        return reconcile_gateways(sys.modules[__name__],sys.argv[2])
    require(len(sys.argv) in (6,7,8),'DEPLOYMENT_ARGUMENTS_INVALID')
    archive,archive_hash,sha,run_id,portal_private_env=sys.argv[1:6]
    scope=sys.argv[6] if len(sys.argv)>=7 else 'full'
    require(scope in ('api-web','full','portal-copy','copy-runtime'),'EXPLICIT_DEPLOYMENT_SCOPE_REQUIRED')
    cloud_boot=scope=='copy-runtime' and run_id.startswith('cb-')
    # Canonical-local package (cv-): no native package build and no worker boot
    # admission; copy-runtime installs it and defers the durable boot.
    local_package=scope=='copy-runtime' and run_id.startswith('cv-')
    require((scope=='portal-copy' or cloud_boot)==(len(sys.argv)==8),
            'COPY_PORTAL_INPUT_DIGEST_REQUIRED' if scope=='portal-copy' else 'CANONICAL_PRIVATE_INPUT_DIGEST_REQUIRED')
    require(re.fullmatch(r'[a-f0-9]{40}',sha),'INVALID_SOURCE_SHA')
    require(installation_id(run_id),'INVALID_RUN_ID')
    require(not run_id.startswith(('cb-','cv-')) or scope=='copy-runtime','CLOUD_COPY_RUNTIME_REQUIRED')
    require((BASE/'current').is_symlink(),'EXISTING_INSTALLATION_REQUIRED')
    if scope=='api-web':
        return publish_api_web(archive,archive_hash,sha,run_id,portal_private_env)
    if scope=='copy-runtime':
        require(cloud_boot or local_package,'CANONICAL_CLOUD_BOOT_ADMISSION_REQUIRED')
        if cloud_boot:
            from runtime_boot_admission_host import staged_input
            globals()['HOST_BOOT_INPUTS_RAW']=staged_input(__file__,sys.argv[7])
        import copy_runtime_deployment
        return copy_runtime_deployment.publish(sys.modules[__name__],archive,archive_hash,sha,run_id,portal_private_env)
    if scope=='portal-copy':
        import copy_portal_deployment
        require(api_web.load_state(PRIVATE)[0]['schema_version']==1,'COPY_PORTAL_INITIAL_TRANSITION_ONLY')
        with copy_portal_deployment.promote_private_input(PRIVATE,portal_private_env,sys.argv[7],sha,run_id) as promoted:
            publish_api_web(archive,archive_hash,sha,run_id,NO_PORTAL)
            return copy_portal_deployment.publish(sys.modules[__name__],archive,archive_hash,sha,run_id,
                                                 str(promoted),continue_api_web=True)
    require(not (PRIVATE/'api-web-adoption.json').exists(),'COPY_FULL_TRANSITION_NOT_APPROVED')
    report_dir=PRIVATE/'deployments'/run_id
    report_dir.mkdir(mode=0o700,parents=True,exist_ok=True)
    lock=(PRIVATE/'ci-deploy.lock').open('w')
    report={'source_sha':sha,'run_id':run_id,'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'RUNNING','stage':'validate'}
    installation_started=False
    root=None
    previous_root=None
    identity_proxy_receipt=None
    waha_backup_state=None
    signal.signal(signal.SIGTERM,_terminate_for_rollback)
    try:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        current=(BASE/'current').resolve()
        previous_root=current
        # Push and dispatch for the same SHA may both pass selection before either finishes.
        # Under the installation lock, reuse only a successful report for the CURRENT release.
        current_meta=json.loads((current/'RELEASE.json').read_text())
        if current_meta.get('source_sha')==sha:
            for previous in sorted((PRIVATE/'deployments').glob('*/report.json'),reverse=True):
                prior=json.loads(previous.read_text())
                if prior.get('source_sha')==sha and prior.get('status')=='SUCCEEDED' and prior.get('release')==current.name:
                    report.update(prior,run_id=run_id,deduplicated=True,reused_run_id=prior['run_id'])
                    return
        require(shutil.disk_usage(BASE).free>max(4*1024**3,Path(archive).stat().st_size*5),'INSUFFICIENT_FREE_DISK')
        root=BASE/'releases'/('ci-'+run_id+'-'+sha[:12])
        extract_release(archive,root,archive_hash)
        metadata=json.loads((root/'RELEASE.json').read_text())
        require(metadata['source_sha']==sha and str(metadata['run_id'])==run_id.split('-')[0],'RELEASE_SOURCE_MISMATCH')
        before_policy=raw_policy_snapshot(current)
        verify_migrations(migrations(current),metadata['migration_hashes'])
        before=preserved_containers()
        before_gateways=gateway_inventory()
        report['previous_release']=current.name
        shutil.copyfile(PRIVATE/'release.env',report_dir/'previous-release.env')
        snapshot_api_deployment_status(report_dir)
        admin=data_env(PRIVATE/'admin.env')
        owner=admin.get('BOOTSTRAP_EMAIL','')
        require('@' in owner,'BOOTSTRAP_IDENTITY_MISSING')
        report['stage']='prepare'
        _write_report(report_dir/'report.json',report)
        run_install_phase(root,report_dir,owner,'prepare')
        report['stage']='install'
        _write_report(report_dir/'report.json',report)
        installation_started=True
        run_install_phase(root,report_dir,owner,'activate')
        compatible=compatible_release_images(report_dir/'previous-release.env',PRIVATE/'release.env',root)
        report['stage']='identity-proxy'
        identity_proxy_receipt=update_identity_proxy(root)
        report['identity_proxy']={'status':identity_proxy_receipt['status'],
                                  'other_sites_preserved':True,
                                  'rollback_available':identity_proxy_receipt['status']=='UPDATED'}
        report['stage']='verify'
        report.update(smoke(root,metadata,before,before_policy,compatible))
        report['session_continuity']=verify_session_preservation(root,before_gateways)
        waha_backup_state=capture_waha_backup_state()
        waha_backup_state['attempted']=True
        report['waha_backup']=install_waha_backup_timer(root)
        report['stage']='portal'
        # This code is part of the same sealed release, after Commerce parity checks.
        import importlib.util
        sys.path.insert(0,str(root/'scripts'))
        portal_spec=importlib.util.spec_from_file_location('mcl_portal_install',root/'scripts/install-mcl-portal.py')
        portal_install=importlib.util.module_from_spec(portal_spec);portal_spec.loader.exec_module(portal_install)
        if portal_private_env==SERVER_CURRENT_PORTAL_ENV:
            payload=current_portal_private_env()
            with tempfile.TemporaryFile(mode='w+b',dir=PRIVATE) as private_input:
                os.fchmod(private_input.fileno(),0o600)
                private_input.write(payload);private_input.flush();os.fsync(private_input.fileno());private_input.seek(0)
                report['portal']=portal_install.install(root,f'/proc/self/fd/{private_input.fileno()}',sha,run_id)
        else:
            report['portal']=portal_install.install(root,portal_private_env,sha,run_id)
        # Start the isolated observation only after every failure-producing release
        # gate. Its setup is non-fatal, so a failed deployment never owns its units,
        # configuration or containers.
        try:
            observation=subprocess.run([sys.executable,'scripts/start-staging-soak.py',sha],cwd=root,text=True,capture_output=True,timeout=120)
            require(observation.returncode==0,'STAGING_SETUP_FAILED')
            report['staging_soak']=json.loads(observation.stdout)
        except Exception as error:
            report['staging_soak']={'status':'SETUP_PENDING','reason':str(error) if isinstance(error,ReleaseError) else type(error).__name__}
        report.update(status='SUCCEEDED',release=root.name,stage='complete')
    except Exception as error:
        report['status']='FAILED'
        report['error']=str(error) if isinstance(error,ReleaseError) else type(error).__name__
        if isinstance(error,DeploymentCleanupError):
            report['phase_error']=getattr(error,'phase_error',None)
            report['cleanup_error']=getattr(error,'cleanup_error',str(error))
        portal_rollback,portal_rollback_failed=portal_rollback_result(error)
        if portal_rollback is not None:report['portal_rollback']=portal_rollback
        rollback_failure=None
        if installation_started and isinstance(error,DeploymentCleanupError):
            report['rollback']={'status':'BLOCKED','error':'DEPLOYMENT_TASK_STATE_UNCONFIRMED','database_restored':False}
            rollback_failure=ReleaseError('DEPLOYMENT_ROLLBACK_BLOCKED')
        elif installation_started:
            rollback_failure=recover_failed_install(root,previous_root,report_dir,report,
                                                     identity_proxy_receipt,
                                                     waha_backup_state=waha_backup_state)
        if portal_rollback_failed and rollback_failure is None:
            rollback_failure=ReleaseError('DEPLOYMENT_ROLLBACK_FAILED')
        # Keep detailed errors private, and never restore a database automatically.
        detail=repr(error)+'\n'
        if rollback_failure is not None:
            detail+='rollback='+str(rollback_failure)+'\n'
        (report_dir/'failure.txt').write_text(detail)
        if rollback_failure is not None:
            raise rollback_failure from error
        raise
    finally:
        report['finished_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
        _write_report(report_dir/'report.json',report)
        print(json.dumps(report,sort_keys=True))
        lock.close()

if __name__=='__main__':
    main()
