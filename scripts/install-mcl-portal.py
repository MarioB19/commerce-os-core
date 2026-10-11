#!/usr/bin/env python3
"""Install the portal from the same sealed CI release; detailed errors stay private."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from ci_release import ReleaseError,require,digest
from mcl_portal_release import (portal_env,rewrite_portal,proxy,LEGACY_PROXY_NETWORK,
                                portal_network_name,verify_portal_network)

BASE=Path('/opt/mcl-portal')
MAX_STATE=256*1024

class PortalInstallError(ReleaseError):
    def __init__(self,original,rollback):
        super().__init__(original)
        self.rollback=rollback
        self.rollback_failed=rollback.get('status')!='SUCCEEDED'

def run(args,check=True):
    result=subprocess.run(args,text=True,capture_output=True,timeout=120)
    if check:require(result.returncode==0,'PORTAL_COMMAND_FAILED')
    return result

def containers():
    ids=run(['docker','ps','-q']).stdout.split()
    if not ids:return {}
    return {x['Id']:(x['Image'],x['State']['StartedAt'],sorted(x['NetworkSettings']['Networks'])) for x in json.loads(run(['docker','inspect',*ids]).stdout) if x['Config'].get('Labels',{}).get('com.inovaris.product')!='mi-ciclo-listo-portal'}

def _safe_code(error,fallback):
    value=str(error) if isinstance(error,(ReleaseError,proxy.ProxyError)) else ''
    return value if re.fullmatch(r'[A-Z0-9_]{1,100}',value) else fallback

def _read_state(path,code):
    try:
        descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        with os.fdopen(descriptor,'rb') as source:
            require(stat.S_ISREG(os.fstat(source.fileno()).st_mode),code)
            data=source.read(MAX_STATE+1)
        require(0<len(data)<=MAX_STATE,code)
        return data
    except ReleaseError:
        raise
    except OSError:
        raise ReleaseError(code) from None

def _sync_directory(path):
    descriptor=os.open(path,os.O_RDONLY|getattr(os,'O_DIRECTORY',0))
    try:os.fsync(descriptor)
    finally:os.close(descriptor)

def _write_state(path,data):
    temporary=None
    try:
        descriptor,name=tempfile.mkstemp(prefix='.portal-state-',dir=path.parent)
        temporary=Path(name)
        with os.fdopen(descriptor,'wb') as target:
            os.fchmod(target.fileno(),0o600)
            target.write(data);target.flush();os.fsync(target.fileno())
        os.replace(temporary,path);temporary=None;_sync_directory(path.parent)
        require(_read_state(path,'PORTAL_STATE_RESTORE_FAILED')==data,
                'PORTAL_STATE_RESTORE_FAILED')
    except ReleaseError:raise
    except OSError:raise ReleaseError('PORTAL_STATE_RESTORE_FAILED') from None
    finally:
        if temporary is not None:
            try:temporary.unlink()
            except OSError:pass

def _restore_current(previous_state,candidate_state,current_written):
    current=BASE/'current.json'
    if not current_written:
        if not current.exists() and not current.is_symlink():return False
        observed=_read_state(current,'PORTAL_CURRENT_STATE_CHANGED')
        if candidate_state is not None and observed==candidate_state:current_written=True
        elif previous_state is not None and observed==previous_state:return False
        else:raise ReleaseError('PORTAL_CURRENT_STATE_CHANGED')
    require(candidate_state is not None
            and _read_state(current,'PORTAL_CURRENT_STATE_CHANGED')==candidate_state,
            'PORTAL_CURRENT_STATE_CHANGED')
    if previous_state is None:
        try:current.unlink();_sync_directory(BASE)
        except OSError:raise ReleaseError('PORTAL_STATE_RESTORE_FAILED') from None
        require(not current.exists(),'PORTAL_STATE_RESTORE_FAILED')
    else:_write_state(current,previous_state)
    return True

def rollback_portal(name,previous,previous_state,candidate_state,current_written,
                    proxy_source,operations,proxy_receipt,previous_stop_attempted,
                    runner=run):
    """Undo only this portal switch; never touch Commerce data or PostgreSQL."""
    result={'status':'SUCCEEDED','proxy':{'status':'NOT_APPLIED'},'current_restored':False,
            'previous_container_started':False,'candidate_stopped':False,
            'database_restored':False}
    previous_name=previous.get('container','') if isinstance(previous,dict) else ''
    if previous_stop_attempted:
        if not re.fullmatch(r'mcl-portal-[0-9]+-[0-9]+',previous_name):
            result.update(status='FAILED',error='PORTAL_PREVIOUS_CONTAINER_INVALID');return result
        try:
            runner(['docker','start',previous_name])
            result['previous_container_started']=True
        except Exception as error:
            result.update(status='FAILED',error=_safe_code(error,'PORTAL_PREVIOUS_START_FAILED'));return result
    if proxy_receipt is not None:
        if proxy_receipt.get('status')!='UPDATED':
            result.update(status='FAILED',error='PORTAL_PROXY_ROLLBACK_UNAVAILABLE',
                          proxy={'status':'FAILED','error':'PORTAL_PROXY_ROLLBACK_UNAVAILABLE'})
            return result
        try:
            if hasattr(operations,'begin_rollback'):operations.begin_rollback()
            restored=proxy.restore_proxy(proxy_source,operations,BASE/'caddy-backups',
                                         proxy_receipt.get('rollback_token'))
            result['proxy']={'status':restored['status'],'other_sites_preserved':True}
        except Exception as error:
            code=_safe_code(error,'PORTAL_PROXY_RESTORE_FAILED')
            result.update(status='FAILED',error=code,proxy={'status':'FAILED','error':code})
            return result
    try:
        result['current_restored']=_restore_current(previous_state,candidate_state,current_written)
    except Exception as error:
        result.update(status='FAILED',error=_safe_code(error,'PORTAL_STATE_RESTORE_FAILED'))
    try:
        stopped=runner(['docker','stop',name],check=False)
        require(getattr(stopped,'returncode',None)==0,'PORTAL_CANDIDATE_STOP_FAILED')
        result['candidate_stopped']=True
    except Exception as error:
        result.update(status='FAILED',error=_safe_code(error,'PORTAL_CANDIDATE_STOP_FAILED'))
    return result

def attempt_portal_rollback(*args,**kwargs):
    """Keep an unexpected rollback defect from replacing the install failure."""
    try:
        return rollback_portal(*args,**kwargs)
    except Exception as error:
        code=_safe_code(error,'PORTAL_ROLLBACK_FAILED')
        return {'status':'FAILED','error':code,
                'proxy':{'status':'FAILED','error':code},
                'current_restored':False,'previous_container_started':False,
                'candidate_stopped':False,'database_restored':False}

def require_production_portal(root,image_info=None):
    """Public synthetic fixtures verify software but cannot replace paid content."""
    marker=Path(root)/'portals/mi-ciclo-listo/PUBLIC_FIXTURE_PROFILE.json'
    require(not marker.exists() and not marker.is_symlink(),
            'SYNTHETIC_PORTAL_PUBLICATION_FORBIDDEN')
    if image_info is not None:
        labels=(image_info.get('Config') or {}).get('Labels') or {}
        require(labels.get('org.commerce-os.content-profile') in (None,'production-private-v1'),
                'SYNTHETIC_PORTAL_IMAGE_FORBIDDEN')

def install(root,private_input,sha,run_id,*,allow_migration_maintenance=False,
            defer_public_contact_fields=False,proxy_network=LEGACY_PROXY_NETWORK,
            verify_before_commit=None):
    require(os.geteuid()==0,'ROOT_REQUIRED')
    require_production_portal(root)
    require(type(allow_migration_maintenance) is bool,'PORTAL_MIGRATION_OPTION_INVALID')
    require(type(defer_public_contact_fields) is bool,'PORTAL_CONTACT_DEFERRAL_OPTION_INVALID')
    require(not defer_public_contact_fields or allow_migration_maintenance,
            'PORTAL_CONTACT_DEFERRAL_REQUIRES_MIGRATION')
    require(verify_before_commit is None or (allow_migration_maintenance and callable(verify_before_commit)),
            'PORTAL_COMMIT_VERIFIER_INVALID')
    network=portal_network_name(proxy_network,allow_migration_maintenance=allow_migration_maintenance)
    require(re.fullmatch(r'[0-9]+-[0-9]+',run_id),'PORTAL_RUN_ID_INVALID')
    env=portal_env(Path(private_input).read_text(),sha,
                   require_legal_fields=allow_migration_maintenance and not defer_public_contact_fields)
    root=Path(root); images=json.loads((root/'images.json').read_text())
    info=json.loads(run(['docker','image','inspect','mi-ciclo-listo-portal:release']).stdout)[0]
    require_production_portal(root,info)
    require(info['Os']=='linux' and info['Architecture']=='amd64' and info['RootFS']['Layers']==images['mi-ciclo-listo-portal:release']['layers'],'PORTAL_IMAGE_MISMATCH')
    available=int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:')))*1024
    require(available>=384*1024**2,'PORTAL_INSUFFICIENT_MEMORY')
    require(shutil.disk_usage('/opt').free>1024**3,'PORTAL_INSUFFICIENT_DISK')
    network_rows=json.loads(run(['docker','network','inspect',network]).stdout)
    caddy_networks=json.loads(run(['docker','inspect',proxy.PROXY,'--format',
                                  '{{json .NetworkSettings.Networks}}']).stdout)
    verify_portal_network(network,network_rows,caddy_networks,
                          allow_migration_maintenance=allow_migration_maintenance)
    BASE.mkdir(mode=0o700,exist_ok=True);state=BASE/'state';state.mkdir(mode=0o700,exist_ok=True);os.chown(state,1000,1000)
    releases=BASE/'releases';releases.mkdir(mode=0o700,exist_ok=True);release=releases/run_id
    require(not release.exists(),'PORTAL_RELEASE_ALREADY_EXISTS_INSPECT_REPORT')
    release.mkdir(mode=0o700);env_path=release/'runtime.env';env_path.write_text(env);env_path.chmod(0o600)
    before=containers();previous=None;previous_state=None
    if (BASE/'current.json').exists() or (BASE/'current.json').is_symlink():
        previous_state=_read_state(BASE/'current.json','PORTAL_CURRENT_STATE_INVALID')
        previous=json.loads(previous_state);shutil.copyfile(BASE/'current.json',release/'previous.json')
    name='mcl-portal-'+run_id
    require(not run(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$']).stdout.strip(),
            'PORTAL_CONTAINER_NAME_ALREADY_EXISTS')
    report={'source_sha':sha,'run_id':run_id,'container':name,'image':info['Id'],'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previous':previous,'status':'STARTING','portal_manifest_sha256':digest(root/'portal-manifest.json')}
    report['public_contact_fields_deferred']=defer_public_contact_fields
    report['proxy_network']=network
    (release/'report.json').write_text(json.dumps(report))
    proxy_receipt=None;proxy_source=None;operations=None;current_written=False
    candidate_state=None;previous_stop_attempted=False
    try:
        run(['docker','run','-d','--name',name,'--label','com.inovaris.product=mi-ciclo-listo-portal','--label','com.inovaris.source-sha='+sha,'--restart','unless-stopped','--init','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','320m','--cpus','0.35','--pids-limit','80','--network',network,'--env-file',str(env_path),'--mount','type=bind,src='+str(state)+',dst=/data','--tmpfs','/tmp:rw,nosuid,size=32m,uid=1000,gid=1000','--tmpfs','/app/.next/cache:rw,nosuid,size=48m,uid=1000,gid=1000','--log-driver','json-file','--log-opt','max-size=5m','--log-opt','max-file=2',info['Id']])
        for _ in range(45):
            ready=run(['docker','exec',name,'node','-e',"fetch('http://127.0.0.1:3000/api/version').then(r=>r.json()).then(x=>process.exit(x.release===process.env.MCL_RELEASE_SHA&&x.activities===480?0:1)).catch(()=>process.exit(1))"],check=False)
            if ready.returncode==0:break
            time.sleep(2)
        require(ready.returncode==0,'PORTAL_HEALTH_FAILED')
        # Private hashes in the sealed artifact must match the running image bytes.
        manifest=json.loads((root/'portal-manifest.json').read_text())
        checked=json.loads(run(['docker','exec',name,'node','-e',"const fs=require('fs'),c=require('crypto');console.log(JSON.stringify(Object.fromEntries(fs.readdirSync('/app/private/pdfs').map(n=>[n,c.createHash('sha256').update(fs.readFileSync('/app/private/pdfs/'+n)).digest('hex')]))))"]).stdout)
        require(checked==manifest['pdfs'],'PORTAL_PRIVATE_PDF_HASH_MISMATCH')
        operations=proxy.DockerCaddy()
        proxy_source=operations.source_path()
        proxy_receipt=proxy.update_proxy(proxy_source,operations,BASE/'caddy-backups',
            lambda source:rewrite_portal(source,name,allow_migration_maintenance=allow_migration_maintenance))
        require(containers()==before,'PORTAL_OTHER_CONTAINERS_CHANGED')
        report.update(status='ORIGIN_READY',other_containers_preserved=True,
                      proxy={'status':proxy_receipt['status'],'other_sites_preserved':True,
                             'rollback_available':proxy_receipt['status']=='UPDATED'},
                      private_pdfs_verified=len(checked),https_verification='PENDING_DOMAIN_READBACK',finished_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
        (release/'report.json').write_text(json.dumps(report,sort_keys=True))
        if verify_before_commit is not None:verify_before_commit(dict(report))
        candidate_state=json.dumps(report,sort_keys=True).encode()
        _write_state(BASE/'current.json',candidate_state);current_written=True
        if previous and re.fullmatch(r'mcl-portal-[0-9]+-[0-9]+',previous.get('container','')):
            previous_stop_attempted=True;run(['docker','stop',previous['container']])
        return {k:v for k,v in report.items() if k!='previous'}
    except Exception as error:
        original=_safe_code(error,'PORTAL_INSTALL_FAILED')
        rollback=attempt_portal_rollback(
            name,previous,previous_state,candidate_state,current_written,
            proxy_source,operations,proxy_receipt,previous_stop_attempted)
        report.update(status='FAILED',error=original,
                      proxy_switched=proxy_receipt is not None and proxy_receipt.get('status')=='UPDATED',
                      rollback=rollback)
        (release/'report.json').write_text(json.dumps(report,sort_keys=True))
        raise PortalInstallError(original,rollback) from error
