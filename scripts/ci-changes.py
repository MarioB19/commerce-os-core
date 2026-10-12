#!/usr/bin/env python3
"""Conservative impact selection. Product operations are API work, never release inputs."""
import os
import json
import re
import subprocess
from pathlib import Path

SHA=re.compile(r'[a-f0-9]{40}')
RUNTIME=('apps/','portals/','packages/','infra/','scripts/','.github/workflows/')
ROOT_CONFIG={'package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','.node-version','.dockerignore'}
BACKUP_SOURCES={'scripts/b02-backup-ci.py','scripts/b02-backup-root.py','scripts/b02_backup_contract.py','scripts/b02-portal-capsule.mjs','scripts/b02-backup-gcp.py','scripts/setup-b02-gcp-scheduler.py','infra/b02-cloud-run.Dockerfile'}
BACKUP_DELIVERY=BACKUP_SOURCES|{'.github/workflows/ci.yml','scripts/ci-changes.py','tests/ci/test_b02_backup.py','tests/ci/test_b02_gcp.py','tests/ci/test_b02_portal_backup.py','tests/ci/test_b02_portal_capsule.mjs','tests/ci/test_b02_portal_capsule_linux.mjs','tests/ci/test_v5_selection.py','tests/ci/test_v5_credential_transport.py'}
# These isolated fixture cleanups accompany the full backup verification. They
# are not shipped application sources; unrelated runtime paths remain releases.
BACKUP_FIXTURE_TESTS={'tests/integration/number-capacity-reconciliation.test.ts','tests/integration/integration-settings.test.ts'}
def publication_paused(value):
    if value not in ('','false','true'):raise RuntimeError('COMMERCE_DEPLOY_PAUSED_INVALID')
    return value=='true'
def narrative(path):
    return path in ('README.md','AGENTS.md') or (path.startswith('docs/') and path.endswith('.md')) or path.startswith('docs/evidence/')
def impact(paths, complete=True):
    if not complete:return 'full'
    if not paths or all(narrative(p) for p in paths):return 'light'
    if all(narrative(p) or p.startswith('portals/mi-ciclo-listo/') for p in paths):return 'portal'
    if all(narrative(p) or p.startswith(('apps/web/src/','apps/web/public/','tests/e2e/')) for p in paths):return 'web'
    return 'full'
def should_deploy(event, ref, before, paths, mode='release'):
    if ref!='refs/heads/main' or event not in ('push','workflow_dispatch'):return False
    if event=='workflow_dispatch' and mode!='release':return False
    if not SHA.fullmatch(before or '') or before=='0'*40:return True
    return any(p.startswith(RUNTIME) or p in ROOT_CONFIG or not(narrative(p) or p.startswith('tests/')) for p in paths)
def software_installation(deployment, status, fetch, repository, *, provider_verify=None):
    """An environment success may belong to backup/credential, not software."""
    if status.get('environment_url') != 'https://commerce-os.inovaris.online':return False
    sha=deployment.get('sha','')
    if not isinstance(sha,str) or not SHA.fullmatch(sha):return False
    prefix='https://github.com/'+repository+'/actions/runs/'
    log=status.get('log_url','')
    if not isinstance(log,str):return False
    payload=deployment.get('payload')
    if isinstance(payload,dict) and payload.get('provider')=='google-cloud-build':
        # Only the trusted local publisher may supply the native/custody reader.
        # Actions/verifier workers without it conservatively use no baseline.
        return repository=='MarioB19/commerce-os-core' and callable(provider_verify) and provider_verify(deployment,status) is True
    if isinstance(payload,dict) and payload.get('deployment_scope')=='copy-runtime':
        if payload.get('runtime_stage')!='OPERATING' or payload.get('consumers_started') is not True:return False
    job_link=re.fullmatch(re.escape(prefix)+r'([1-9][0-9]*)/job/([1-9][0-9]*)',log)
    if job_link:
        job=fetch('actions/jobs/'+job_link[2])
        return (isinstance(job,dict) and job.get('name')=='deploy'
                and job.get('workflow_name')=='Commerce OS CI/CD'
                and job.get('status')=='completed' and job.get('conclusion')=='success'
                and job.get('head_sha')==sha and job.get('run_id')==int(job_link[1])
                and job.get('html_url')==log)
    payload=deployment.get('payload')
    if isinstance(payload,dict) and payload.get('deployment_scope')=='copy-runtime':
        if payload.get('runtime_stage')!='OPERATING' or payload.get('consumers_started') is not True:return False
    # Canonical incident installations have an explicit immutable package receipt;
    # their Actions run may have failed before a runner due to account funding.
    run_link=re.fullmatch(re.escape(prefix)+r'([1-9][0-9]*)',log)
    payload=deployment.get('payload')
    return (bool(run_link) and isinstance(payload,dict)
            and payload.get('installer_status')=='SUCCEEDED' and payload.get('source_sha')==sha
            and isinstance(payload.get('archive_sha256'),str)
            and bool(re.fullmatch(r'[a-f0-9]{64}',payload['archive_sha256']))
            and isinstance(payload.get('installation_run_id'),str)
            and bool(re.fullmatch(re.escape(run_link[1])+r'-[1-9][0-9]*',payload['installation_run_id']))
            and isinstance(payload.get('verification'),str) and bool(payload['verification'].strip()))
def deployed_baseline(fetch, repository=None, *, provider_verify=None):
    try:
        repository=repository or os.environ.get('GITHUB_REPOSITORY','')
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',repository):return ''
        deployments=fetch('deployments?environment=production&per_page=30')
        for deployment in deployments:
            if not isinstance(deployment,dict) or type(deployment.get('id')) is not int or deployment['id']<=0:continue
            statuses=fetch('deployments/'+str(deployment['id'])+'/statuses?per_page=1')
            if (isinstance(statuses,list) and statuses and isinstance(statuses[0],dict)
                    and statuses[0].get('state')=='success'
                    and software_installation(deployment,statuses[0],fetch,repository,provider_verify=provider_verify)):
                return deployment['sha']
    except (subprocess.CalledProcessError,ValueError,KeyError,TypeError):pass
    return ''
def diff_paths(base,head='HEAD'):
    # -z preserves spaces/newlines. --no-renames returns both removed and added paths.
    raw=subprocess.check_output(['git','diff','--no-renames','--name-only','-z',base,head])
    return [p.decode('utf-8') for p in raw.split(b'\0') if p]
def final_gate(changes_result,verify_result,scope):
    return changes_result=='success' and verify_result=='success' and scope in ('light','portal','web','full')
def backup_delivery_only(paths):
    return bool(paths) and any(path in BACKUP_SOURCES for path in paths) and all(path in BACKUP_DELIVERY or path in BACKUP_FIXTURE_TESTS or narrative(path) for path in paths)
def select(event,ref,before,paths,*,mode='verify',draft=False,complete=True,push_paths=None,publication_scope=''):
    deploy=should_deploy(event,ref,before,paths,mode)
    if event=='workflow_dispatch' and ref=='refs/heads/main' and mode=='release' and publication_scope=='copy-runtime':deploy=True
    scope='light' if draft else impact(paths,complete)
    if deploy and publication_scope=='copy-runtime':scope='full'
    # Only the complete push diff can identify a backup delivery. The deployed
    # baseline may contain unrelated application work; it remains release input.
    if event=='push' and ref=='refs/heads/main' and push_paths is not None and backup_delivery_only(push_paths):
        deploy=False;scope='full'
    # Releases must verify the entire deployed-baseline diff, even after a docs push.
    if deploy and not complete:scope='full'
    return {'deploy':str(deploy).lower(),'scope':scope,'baseline':before,'diff_complete':str(complete).lower()}
def main():
    paused=publication_paused(os.environ.get('COMMERCE_DEPLOY_PAUSED',''))
    event,ref=os.environ['EVENT_NAME'],os.environ['REF']
    payload=json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    def fetch(path):return json.loads(subprocess.check_output(['gh','api','repos/'+os.environ['GITHUB_REPOSITORY']+'/'+path],text=True))
    before=deployed_baseline(fetch) if ref=='refs/heads/main' else payload.get('pull_request',{}).get('base',{}).get('sha','')
    head=payload.get('pull_request',{}).get('head',{}).get('sha','HEAD')
    complete=bool(SHA.fullmatch(before or '') and before!='0'*40)
    try:paths=diff_paths(before,head) if complete else []
    except (subprocess.CalledProcessError,UnicodeDecodeError):paths=[];complete=False
    push_paths=None
    push_before=payload.get('before','')
    if event=='push' and SHA.fullmatch(push_before) and push_before!='0'*40:
        try:push_paths=diff_paths(push_before)
        except (subprocess.CalledProcessError,UnicodeDecodeError):pass
    selection=select(event,ref,before,paths,mode=os.environ.get('DISPATCH_MODE','verify'),draft=payload.get('pull_request',{}).get('draft',False),complete=complete,push_paths=push_paths,publication_scope=os.environ.get('COMMERCE_DEPLOY_SCOPE',''))
    with open(os.environ['GITHUB_OUTPUT'],'a') as output:
        for key,value in selection.items():output.write(key+'='+value+'\n')
    print(json.dumps({**selection,'changed_paths':len(paths)},sort_keys=True))
    summary='Publicación CI pausada: package y deploy no se ejecutarán; verificación y audit conservan su alcance.' if paused else 'Publicación CI sin pausa temporal; package y deploy conservan sus gates habituales.'
    print(summary)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'],'a') as output:output.write(summary+'\n')
if __name__=='__main__':main()
