#!/usr/bin/env python3
"""Fixed administrative task from the deployed release; stdout is encrypted only."""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from v5_token_transport_config import REMOTE_FAILURE_CODES,REMOTE_FAILURE_STAGES,StagedFailure,safe_remote_failure

BASE=Path('/opt/commerce-os')
AUTH='363c24edb04448cec2f9b041320ae9f24790cb98d1d7d9f3b4d07e4081dbc1cb'
PHASE='request'
def require(condition,code):
    if not condition: raise RuntimeError(code)
def private_read(path):
    path=Path(path);s=path.lstat()
    require(path.is_file() and not path.is_symlink() and s.st_mode&0o077==0,'PRIVATE_INPUT_REQUIRED')
    return path.read_text()
def run(args,cwd=None,stage='ISSUER_EXECUTION'):
    require(stage in {'IMAGE_INSPECT','RECIPIENT_VALIDATION','ISSUER_EXECUTION','RECEIPT_ENCRYPTION'},'V5_REMOTE_TASK_FAILED')
    phase={'IMAGE_INSPECT':'image','RECIPIENT_VALIDATION':'validation','ISSUER_EXECUTION':'issuer','RECEIPT_ENCRYPTION':'encryption'}[stage]
    try:result=subprocess.run(args,cwd=cwd,text=True,capture_output=True,timeout=90)
    except subprocess.TimeoutExpired:raise StagedFailure('V5_'+stage+'_TIMEOUT',phase) from None
    except OSError:raise StagedFailure('V5_'+stage+'_FAILED',phase) from None
    if result.returncode:
        safe=safe_remote_failure(result.stderr)
        raise StagedFailure(safe['code'] if safe else 'V5_'+stage+'_FAILED',phase)
    return result.stdout
def verified_installed_image(sealed,installed,inspection):
    require(isinstance(sealed,dict) and isinstance(sealed.get('id'),str) and re.fullmatch('sha256:[a-f0-9]{64}',sealed['id']),'SEALED_IMAGE_REQUIRED')
    layers=sealed.get('layers')
    require(isinstance(layers,list) and layers and all(isinstance(layer,str) and re.fullmatch('sha256:[a-f0-9]{64}',layer) for layer in layers),'SEALED_IMAGE_LAYERS_REQUIRED')
    require(isinstance(installed,str) and re.fullmatch('sha256:[a-f0-9]{64}',installed),'INSTALLED_IMAGE_REQUIRED')
    require(isinstance(inspection,list) and len(inspection)==1 and isinstance(inspection[0],dict),'INSTALLED_IMAGE_INSPECTION_INVALID')
    info=inspection[0]
    require(isinstance(info.get('Id'),str) and re.fullmatch('sha256:[a-f0-9]{64}',info['Id']),'INSTALLED_IMAGE_INSPECTION_INVALID')
    require(info.get('Os')=='linux' and info.get('Architecture')=='amd64','INSTALLED_IMAGE_PLATFORM_MISMATCH')
    # Same sealed OS/architecture/ordered-layer check as deploy-ci-vps.smoke:
    # containerd can use an OCI index Id distinct from the runner's config Id.
    require(isinstance(info.get('RootFS'),dict) and info['RootFS'].get('Layers')==layers,'INSTALLED_IMAGE_LAYERS_MISMATCH')
    return info['Id']
def immutable(path,text):
    if path.exists(): require(private_read(path)==text,'PRIVATE_REQUEST_OR_RECIPIENT_DRIFT')
    else:
        with path.open('x') as file: file.write(text)
        path.chmod(0o600)
def validate_request(action,sha,run_id,data):
    require(action in ('inspect','issue','readback','revoke'),'ACTION_NOT_ALLOWED')
    require(re.fullmatch('[a-f0-9]{40}',sha) and re.fullmatch('[0-9]+-[0-9]+',run_id),'SOURCE_AND_RUN_REQUIRED')
    require(data.get('authorization_sha256')==AUTH,'V5_AUTHORIZATION_REQUIRED')
    require(re.fullmatch('[a-f0-9-]{36}',data.get('operation_id','')),'OPERATION_ID_REQUIRED')
    require(not set(data.get('scopes',[]))&{'assignments:authorize','warmup:activate','channels:manage','finance:review','campaigns:write','*'},'OPERATIONAL_GRANT_FORBIDDEN')
def main():
    global PHASE
    PHASE='request'
    os.umask(0o077)
    require(len(sys.argv)==6,'EXPLICIT_ARGUMENTS_REQUIRED')
    action,sha,run_id,input_path,public_path=sys.argv[1:]
    data=json.loads(private_read(input_path));validate_request(action,sha,run_id,data)
    public=private_read(public_path);require(public.startswith('-----BEGIN PUBLIC KEY-----') and 'PRIVATE KEY' not in public and len(public)<10000,'PUBLIC_KEY_REQUIRED')
    require((BASE/'current').is_symlink(),'EXISTING_INSTALLATION_REQUIRED')
    with (BASE/'private/ci-deploy.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_SH|fcntl.LOCK_NB)
        PHASE='image'
        current=(BASE/'current').resolve();metadata=json.loads((current/'RELEASE.json').read_text())
        require(metadata.get('source_sha')==sha,'DEPLOYED_SHA_MISMATCH')
        sealed=json.loads((current/'images.json').read_text())['commerce-os-maintenance:release']
        release=dict(line.split('=',1) for line in (BASE/'private/release.env').read_text().splitlines() if line and not line.startswith('#'))
        installed=release.get('COMMERCE_MAINTENANCE_IMAGE')
        require(isinstance(installed,str) and re.fullmatch('sha256:[a-f0-9]{64}',installed),'INSTALLED_IMAGE_REQUIRED')
        try:inspection=json.loads(run(['docker','image','inspect',installed],stage='IMAGE_INSPECT'))
        except ValueError:raise RuntimeError('INSTALLED_IMAGE_INSPECTION_INVALID') from None
        image=verified_installed_image(sealed,installed,inspection)
        directory=BASE/'private/v5-service-tokens'/data['operation_id'];directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        require(not directory.is_symlink() and directory.stat().st_mode&0o077==0,'PRIVATE_DIRECTORY_REQUIRED')
        immutable(directory/'input.json',json.dumps(data,sort_keys=True)+'\n');immutable(directory/'public.pem',public)
        execution=directory/('run-'+run_id+'-'+action);execution.mkdir(mode=0o700,exist_ok=True)
        prefix=['docker','run','--rm','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','64','--memory','256m','--cpus','0.5','--network','commerce-os_core','--user','0:0','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=32m','--env-file',str(BASE/'private/admin.env'),'-v',str(directory)+':/v5-private',image]
        # Validate encryption destination before even a credential write.
        PHASE='validation'
        validation=execution/'validation.json';validation.write_text('{"validation":true}');validation.chmod(0o600)
        check=execution/'validation.enc';check.unlink(missing_ok=True)
        run(prefix+['node','scripts/v5-token-envelope.mjs','seal','/v5-private/public.pem','/v5-private/'+execution.name+'/validation.json','-','/v5-private/'+execution.name+'/validation.enc'],current,stage='RECIPIENT_VALIDATION')
        PHASE='issuer'
        try:outcome=json.loads(run(prefix+['node','--import','tsx','scripts/v5-service-token.ts',action,'/v5-private/input.json','/v5-private/ledger'],current,stage='ISSUER_EXECUTION'))
        except ValueError:raise RuntimeError('V5_ISSUER_RESPONSE_INVALID') from None
        require(isinstance(outcome,dict),'V5_ISSUER_RESPONSE_INVALID')
        outcome.update(source_sha=sha,run_id=run_id,operation_id=data['operation_id'],transport='GITHUB_OIDC_IAP_EXISTING_TARGET',business_mutations=False)
        PHASE='encryption'
        receipt=execution/'receipt.json';receipt.write_text(json.dumps(outcome)+'\n');receipt.chmod(0o600)
        envelope=execution/'envelope.json';envelope.unlink(missing_ok=True)
        token='/v5-private/ledger/service-token' if action in ('issue','readback') else '-'
        run(prefix+['node','scripts/v5-token-envelope.mjs','seal','/v5-private/public.pem','/v5-private/'+execution.name+'/receipt.json',token,'/v5-private/'+execution.name+'/envelope.json'],current,stage='RECEIPT_ENCRYPTION')
        print(envelope.read_text().strip())
def failure_payload(error):
    code=str(error) if isinstance(error,RuntimeError) and str(error) in REMOTE_FAILURE_CODES else 'V5_REMOTE_TASK_FAILED'
    stage=getattr(error,'stage',PHASE)
    return {'status':'FAILED','code':code,'stage':stage if stage in REMOTE_FAILURE_STAGES else 'request'}
if __name__=='__main__':
    try: main()
    except Exception as error:
        print(json.dumps(failure_payload(error)),file=sys.stderr);sys.exit(1)
