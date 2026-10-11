#!/usr/bin/env python3
"""Canonical publisher transport. Google credentials and SSH key stay ephemeral."""
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
from ci_release import digest, require
from deployment_scope import deployment_scope, NO_PORTAL
from ephemeral_os_login import remove_ephemeral_key
from ci_provider_evidence import unit_name, installation_id

ROOT=Path(__file__).resolve().parent.parent
# The forward install may use its full bounded stage time. If systemd reaches
# that ceiling it sends SIGTERM; deploy-ci-vps catches it and needs a separate,
# sufficient stop window to restore core, identity proxy and backup units and
# atomically publish the terminal report before systemd may escalate to SIGKILL.
REMOTE_RUNTIME_MAX_SECONDS=3600
REMOTE_STOP_TIMEOUT_SECONDS=1800
REPORT_POLL_INTERVAL_SECONDS=10
REPORT_POLL_ATTEMPTS=(REMOTE_RUNTIME_MAX_SECONDS+REMOTE_STOP_TIMEOUT_SECONDS)//REPORT_POLL_INTERVAL_SECONDS+30
SERVER_CURRENT_PORTAL_ENV='@server-current'

def run(args, check=True, capture=False):
    return subprocess.run(args,cwd=ROOT,check=check,text=True,capture_output=capture)

def verify_local_source(sha,runner=run):
    head=runner(['git','rev-parse','HEAD'],capture=True).stdout.strip()
    require(head==sha,'LOCAL_SOURCE_SHA_MISMATCH')
    status=runner(['git','status','--porcelain','--untracked-files=all'],capture=True).stdout
    require(not status.strip(),'LOCAL_SOURCE_NOT_CLEAN')

def unit_runtime_state(ssh,unit):
    require(unit_name(unit),
            'INVALID_REMOTE_UNIT_IDENTITY')
    response=ssh('sudo systemctl show '+unit+'.service '
                 '--property=LoadState --property=ActiveState '
                 '--property=SubState --property=MainPID --no-pager',check=False)
    if response.returncode!=0:
        return 'UNKNOWN'
    values={}
    for line in response.stdout.splitlines():
        if '=' in line:
            key,value=line.split('=',1);values[key]=value
    pid=values.get('MainPID','')
    if not pid.isdigit():
        return 'UNKNOWN'
    active=values.get('ActiveState','')
    if int(pid)>0 or active in {'active','activating','deactivating','reloading'}:
        return 'RUNNING'
    if (int(pid)==0 and active in {'inactive','failed'}
            and values.get('LoadState') in {'loaded','not-found'}):
        return 'TERMINAL'
    return 'UNKNOWN'

def wait_for_report(ssh, report_path, unit, attempts=REPORT_POLL_ATTEMPTS, delay=REPORT_POLL_INTERVAL_SECONDS):
    command='sudo test -s '+report_path+' && sudo cat '+report_path
    for attempt in range(attempts):
        response=ssh(command,check=False)
        if response.returncode==0 or attempt >= 2:
            state=unit_runtime_state(ssh,unit)
            if state=='TERMINAL':
                # The unit can finish after the first report read. Only a fresh
                # read AFTER confirmed exit is authoritative, whether the first
                # response was absent, stale RUNNING, or an earlier invocation.
                final=ssh(command,check=False)
                if final.returncode==0:
                    candidate=json.loads(final.stdout)
                    require(isinstance(candidate,dict) and candidate.get('status') in {'SUCCEEDED','FAILED','PREPARED_ACTION_REQUIRED'},
                            'REMOTE_SERVICE_EXITED_WITH_NONTERMINAL_REPORT')
                    return candidate
                require(final.returncode!=1,'REMOTE_SERVICE_EXITED_WITHOUT_REPORT')
            # A report is not authoritative while the unit may still be running
            # or rolling back. Transport errors do not establish remote exit.
        time.sleep(delay)
    raise RuntimeError('REMOTE_DEPLOYMENT_STATUS_TIMEOUT_INSPECT_SYSTEMD')

def public_key_identity(value):
    """Compare the key algorithm/blob and ignore local or OS Login comments."""
    parts=value.strip().split()
    require(len(parts)>=2,'INVALID_SSH_PUBLIC_KEY')
    return tuple(parts[:2])

def profile_contains_public_key(profile, public):
    target=public_key_identity(public)
    keys=profile.get('sshPublicKeys') or {}
    return any(public_key_identity(entry.get('key',''))==target for entry in keys.values() if entry.get('key'))

def append_step_summary(path,report,sha):
    """The optional CI summary must never turn a completed remote deploy into UNKNOWN."""
    if not path:
        return False
    try:
        with Path(path).open('a') as summary:
            summary.write('Deployment **'+report['status']+'** for `'+sha+'`.\n\n')
            summary.write('Stage: '+report['stage']+'. Details: deployment artifact; installer log remains private on the VPS.\n')
        return True
    except OSError:
        return False

def validate_requested_scope(report,scope):
    if scope=='api-web':
        require(report.get('deployment_scope')=='api-web','REMOTE_DEPLOYMENT_SCOPE_MISMATCH')
    if scope=='portal-copy':
        require(report.get('deployment_scope')=='portal-copy'
                and report.get('api_web_completed_in_same_run') is True,
                'REMOTE_DEPLOYMENT_SCOPE_MISMATCH')
        if report.get('status')=='SUCCEEDED':
            require(report.get('portal_https_verified') is True and report.get('private_pdfs_verified')==10
                    and report.get('core_pdfs')==9
                    and report.get('consumers_absent') is True and report.get('consumers_started') is False,
                    'REMOTE_PORTAL_COMPLETION_REQUIRED')
    if scope=='copy-runtime':
        require(report.get('deployment_scope')=='copy-runtime','REMOTE_DEPLOYMENT_SCOPE_MISMATCH')
        if report.get('status')=='SUCCEEDED':
            require(report.get('runtime_stage')=='OPERATING' and report.get('consumers_started') is True
                    and report.get('healthy_services')==6 and report.get('physical_sales_proven') is False,
                    'REMOTE_COPY_RUNTIME_COMPLETION_REQUIRED')
        if report.get('status')=='PREPARED_ACTION_REQUIRED':
            require(report.get('runtime_stage')=='CORE_PREPARED' and report.get('consumers_started') is False
                    and report.get('core_prepared') is True and report.get('migration_count')==67,
                    'REMOTE_COPY_CORE_PREPARATION_REQUIRED')
    return True

def portal_transport(runner_temp,source):
    require(source in ('local','server-current'),'PORTAL_PRIVATE_ENV_SOURCE_INVALID')
    portal_env=Path(runner_temp)/'mcl-portal.env'
    if source=='local':
        require(portal_env.is_file(),'PORTAL_PRIVATE_ENV_MISSING')
        return portal_env,[portal_env],'"$PWD/mcl-portal.env"'
    require(not portal_env.exists(),'LOCAL_PORTAL_ENV_MUST_NOT_EXIST')
    return portal_env,[],SERVER_CURRENT_PORTAL_ENV

def cleanup_staging_command(remote,unit):
    require(unit_name(remote) and unit_name(unit),
            'INVALID_REMOTE_STAGING_IDENTITY')
    files=' '.join(remote+'/'+name for name in
                   ('commerce-os.tar','deploy-ci-vps.py','ci_release.py','deployment_scope.py','api_web_deployment.py',
                    'mcl_portal_release.py','update-identity-proxy.py','copy_portal_deployment.py','copy_runtime_deployment.py','ci_provider_evidence.py','mcl-portal.env'))
    return ('attempt=0; while [ "$attempt" -lt 30 ]; do '
            'state=$(sudo systemctl show '+unit+'.service --property=ActiveState --value 2>/dev/null) || exit $?; '
            'pid=$(sudo systemctl show '+unit+'.service --property=MainPID --value 2>/dev/null) || exit $?; '
            'case "$pid" in ""|*[!0-9]*) exit 1;; esac; '
            'if { [ "$state" = inactive ] || [ "$state" = failed ]; } && [ "$pid" -eq 0 ]; then break; fi; '
            'case "$state" in active|activating|deactivating|reloading) attempt=$((attempt+1)); sleep 1;; *) exit 1;; esac; '
            'done; [ "$attempt" -lt 30 ] || exit 75; '
            'sudo rm -f '+files+'; sudo rmdir '+remote+' 2>/dev/null || true; '
            'sudo test ! -e '+remote)

def main():
    cloud_admission=os.environ.get('COMMERCE_CLOUD_RELEASE_ADMISSION')
    if cloud_admission:
        from cloudbuild_release_evidence import deployment_admission
        require(os.environ.get('COMMERCE_DEPLOY_PAUSED')=='false','CLOUD_PUBLICATION_PAUSED')
        require(not any(os.environ.get(key) for key in ('GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT')),
                'MIXED_RELEASE_PROVIDERS')
        admitted=deployment_admission(Path(cloud_admission), ROOT,
            os.environ.get('COMMERCE_INSTALLATION_ATTEMPT','1'))
        sha=admitted['source_sha'];run_id=admitted['installation_run_id']
    else:
        sha=os.environ['GITHUB_SHA']
        run_id=os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT']
    require(re.fullmatch(r'[a-f0-9]{40}',sha) and installation_id(run_id),'INVALID_RUN_IDENTITY')
    project=os.environ['GCP_PROJECT_ID'];instance=os.environ['GCP_INSTANCE'];zone=os.environ['GCP_ZONE']
    scope=deployment_scope(os.environ)
    require(not cloud_admission or scope=='copy-runtime','CLOUD_COPY_RUNTIME_REQUIRED')
    verify_local_source(sha)
    archive=ROOT/'release/commerce-os.tar'
    expected=(ROOT/'release/commerce-os.tar.sha256').read_text().split()[0]
    require(digest(archive)==expected,'ARTIFACT_CHECKSUM_MISMATCH')
    require(not cloud_admission or expected==admitted['archive_sha256'],'ADMITTED_ARCHIVE_CHANGED')
    key=Path(os.environ['RUNNER_TEMP'])/('commerce-ci-'+run_id)
    base=[f'--project={project}',f'--zone={zone}','--tunnel-through-iap','--quiet',f'--ssh-key-file={key}']
    if cloud_admission:
        from cloudbuild_release_evidence import ACCOUNT
        base.append('--account='+ACCOUNT)
    def ssh(cmd,check=True):
        return run(['gcloud','compute','ssh',instance,*base,'--ssh-key-expire-after=30m','--command='+cmd],check=check,capture=True)
    remote='commerce-ci-'+run_id
    unit=remote
    portal_source=os.environ.get('MCL_PORTAL_ENV_SOURCE','local')
    portal_env=None
    staging_created=False
    ssh_attempted=False
    try:
        run(['ssh-keygen','-q','-t','ed25519','-N','','-C','commerce-ci-'+run_id,'-f',str(key)])
        if scope in {'api-web','copy-runtime'}:
            require(not (Path(os.environ['RUNNER_TEMP'])/'mcl-portal.env').exists(),'API_WEB_PORTAL_SECRET_NOT_SELECTED')
            portal_files=[];portal_argument=NO_PORTAL
        else:
            require(scope!='portal-copy' or portal_source=='local','COPY_PORTAL_INITIAL_INPUT_REQUIRED')
            portal_env,portal_files,portal_argument=portal_transport(os.environ['RUNNER_TEMP'],portal_source)
        files=[archive,ROOT/'scripts/deploy-ci-vps.py',ROOT/'scripts/ci_release.py',
               ROOT/'scripts/deployment_scope.py',ROOT/'scripts/api_web_deployment.py',
               ROOT/'scripts/mcl_portal_release.py',ROOT/'scripts/update-identity-proxy.py',
               ROOT/'scripts/copy_portal_deployment.py',ROOT/'scripts/copy_runtime_deployment.py',
               ROOT/'scripts/ci_provider_evidence.py',*portal_files]
        ssh_attempted=True
        ssh('umask 077 && test ! -e '+remote+' && mkdir '+remote)
        staging_created=True
        run(['gcloud','compute','scp',*base,*map(str,files),instance+':~/'+remote+'/'])
        # main might advance during transfer; do not install an obsolete build.
        head=run(['gh','api','repos/MarioB19/commerce-os/commits/main','--jq','.sha'],capture=True).stdout.strip()
        require(head==sha,'SUPERSEDED_COMMIT')
        checks=''.join(digest(p)+'  '+p.name+'\n' for p in files)
        names=' '.join('"$stage/'+p.name+'"' for p in files)
        regular_checks=' && '.join(
            'sudo test -f "$stage/'+p.name+'" && sudo test ! -L "$stage/'+p.name+'"'
            for p in files)
        prefix=('cd '+remote+' && printf %s '+shlex.quote(checks)
                +' | sha256sum --check --status && stage="$PWD" && '
                +'sudo chown root:root "$stage" && sudo chmod 700 "$stage" && '
                +'test "$(sudo find "$stage" -mindepth 1 -maxdepth 1 -printf x | wc -c)" -eq '
                +str(len(files))+' && '+regular_checks+' && '
                +'sudo chown root:root '+names+' && sudo chmod 600 '+names+' && '
                +'printf %s '+shlex.quote(checks)
                +' | sudo /bin/sh -c \'cd "$1" && sha256sum --check --status\' sh "$stage" && ')
        # systemd owns the process even if this SSH connection disappears.
        if scope not in {'api-web','copy-runtime'} and portal_source=='local':
            portal_argument='"$stage/mcl-portal.env"'
        report_path='/opt/commerce-os/private/deployments/'+run_id+'/report.json'
        start=(prefix+'sudo systemd-run --quiet --collect --unit='+unit
               +' --property=RuntimeMaxSec='+str(REMOTE_RUNTIME_MAX_SECONDS)
               +' --property=TimeoutStopSec='+str(REMOTE_STOP_TIMEOUT_SECONDS)
               +' --property=UMask=0077 /usr/bin/env PYTHONDONTWRITEBYTECODE=1 '
               +'/usr/bin/python3 "$stage/deploy-ci-vps.py" '
               +'"$stage/commerce-os.tar" '+expected+' '+sha+' '+run_id+' '+portal_argument+' '+scope
               +(' '+digest(portal_env) if scope=='portal-copy' else ''))
        # An uncertain start is reconciled by structured unit state; never start again blindly.
        state=unit_runtime_state(ssh,unit)
        if state=='TERMINAL':
            existing=ssh('sudo test -s '+report_path+' && sudo cat '+report_path,check=False)
            if existing.returncode==0:
                raise RuntimeError('EXISTING_REPORT_INSPECT_OR_USE_NEW_RUN_ATTEMPT')
            if existing.returncode!=1:
                raise RuntimeError('REMOTE_STATUS_UNKNOWN_INSPECT_SYSTEMD')
            # No report exists, so there is no evidence to overwrite.
            ssh(start,check=False)
        elif state!='RUNNING':
            raise RuntimeError('REMOTE_STATUS_UNKNOWN_INSPECT_SYSTEMD')
        report=wait_for_report(ssh,report_path,unit)
        require(report['source_sha']==sha and report['run_id']==run_id,'REMOTE_REPORT_IDENTITY_MISMATCH')
        (ROOT/'release/deployment.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report),flush=True)
        validate_requested_scope(report,scope)
        if not append_step_summary(os.environ.get('GITHUB_STEP_SUMMARY'),report,sha):
            print(json.dumps({'warning':'STEP_SUMMARY_WRITE_FAILED'}),file=sys.stderr,flush=True)
        require(report['status']=='SUCCEEDED','REMOTE_DEPLOYMENT_FAILED')
    finally:
        # Never delete a package while a disconnected remote installer still uses it.
        cleanup_failed=False
        if staging_created:
            cleanup=cleanup_staging_command(remote,unit)
            cleanup_failed=ssh(cleanup,check=False).returncode!=0
        try:
            if ssh_attempted:
                public=key.with_suffix('.pub').read_text()
                remove_ephemeral_key(public, lambda args: run(args,check=False,capture=True))
        finally:
            key.unlink(missing_ok=True);key.with_suffix('.pub').unlink(missing_ok=True)
            if portal_env is not None:portal_env.unlink(missing_ok=True)
        require(not cleanup_failed,'REMOTE_STAGING_CLEANUP_UNCONFIRMED')

if __name__=='__main__':
    main()
