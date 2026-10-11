#!/usr/bin/env python3
"""OIDC/IAP transport for the single deployed V5 credential issuer, never arbitrary commands."""
import hashlib
import base64
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
from v5_token_transport_config import validate_transport,safe_remote_failure,StagedFailure

def command(args,stage='AUTHENTICATED_TRANSPORT',remote_failure=False):
    if stage not in {'AUTHENTICATED_TRANSPORT','MAIN_READBACK','SSH_KEY_PREPARATION','REMOTE_DIRECTORY','INPUT_COPY','REMOTE_ISSUER','REMOTE_CLEANUP','OS_LOGIN_CLEANUP'}:raise RuntimeError('V5_CI_TRANSPORT_FAILED')
    try:result=subprocess.run(args,text=True,capture_output=True,timeout=180)
    except subprocess.TimeoutExpired:raise StagedFailure('V5_'+stage+'_TIMEOUT',stage.lower()) from None
    except OSError:raise StagedFailure('V5_'+stage+'_FAILED',stage.lower()) from None
    if result.returncode:
        safe=safe_remote_failure(result.stderr) if remote_failure else None
        raise StagedFailure(safe['code'] if safe else 'V5_'+stage+'_FAILED',safe.get('stage','request') if safe else stage.lower())
    return result.stdout
def main():
    os.umask(0o077);config=validate_transport(os.environ)
    head=command(['gh','api','repos/MarioB19/commerce-os/commits/main','--jq','.sha'],stage='MAIN_READBACK').strip()
    if head!=config['sha']: raise RuntimeError('SUPERSEDED_COMMIT')
    temporary=Path(os.environ['RUNNER_TEMP'])/('commerce-v5-'+config['run_id']);temporary.mkdir(mode=0o700)
    input_file=temporary/'input.json';input_file.write_text(json.dumps(config['input'])+'\n');input_file.chmod(0o600)
    public_file=temporary/'public.pem';public_file.write_text(config['public_key']);public_file.chmod(0o600)
    key=temporary/'iap-key';command(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(key)],stage='SSH_KEY_PREPARATION')
    base=['--project=vibe-conversa-prod','--zone=us-east1-d','--tunnel-through-iap','--quiet','--ssh-key-file='+str(key)]
    remote='commerce-v5-'+config['run_id']
    def ssh(text,stage='REMOTE_DIRECTORY'):return command(['gcloud','compute','ssh','vibe-conversa-prod',*base,'--ssh-key-expire-after=15m','--command='+text],stage=stage,remote_failure=stage=='REMOTE_ISSUER')
    try:
        ssh('umask 077 && mkdir '+remote)
        command(['gcloud','compute','scp',*base,str(input_file),str(public_file),'vibe-conversa-prod:~/'+remote+'/'],stage='INPUT_COPY')
        if command(['gh','api','repos/MarioB19/commerce-os/commits/main','--jq','.sha'],stage='MAIN_READBACK').strip()!=config['sha']:raise RuntimeError('SUPERSEDED_COMMIT')
        # Shell contains only fixed strings or validated IDs. JSON and keys are copied as data.
        args=[config['action'],config['sha'],config['run_id'],remote+'/input.json',remote+'/public.pem']
        response=ssh('sudo python3 /opt/commerce-os/current/scripts/v5-token-remote.py '+' '.join(map(shlex.quote,args)),stage='REMOTE_ISSUER')
        envelope=json.loads(response)
        if set(envelope)!={'schema_version','algorithm','recipient_sha256','encrypted_key','nonce','tag','ciphertext'} or envelope['algorithm']!='RSA-OAEP-SHA256+A256GCM':raise RuntimeError('ENCRYPTED_RECEIPT_REQUIRED')
        output=Path(os.environ['RUNNER_TEMP'])/'v5-encrypted-receipt';output.mkdir(mode=0o700,exist_ok=True)
        artifact=output/'envelope.json';artifact.write_text(json.dumps(envelope)+'\n');artifact.chmod(0o600)
        print(json.dumps({'status':'ENCRYPTED_RECEIPT_READY','source_sha':config['sha'],'operation_id':config['input']['operation_id'],'action':config['action'],'ciphertext_sha256':hashlib.sha256(artifact.read_bytes()).hexdigest(),'raw_token_in_runner':False}))
    finally:
        # Inputs contain no secrets; source and destination key are public only.
        try:ssh('rm -f '+remote+'/input.json '+remote+'/public.pem && rmdir '+remote,stage='REMOTE_CLEANUP')
        except RuntimeError:pass
        try:
            public=key.with_suffix('.pub').read_text();fingerprint=hashlib.sha256(base64.b64decode(public.split()[1])).hexdigest()
            command(['gcloud','compute','os-login','ssh-keys','remove','--key='+fingerprint,'--quiet'],stage='OS_LOGIN_CLEANUP')
        except (RuntimeError,OSError,ValueError,IndexError):pass
        key.unlink(missing_ok=True);key.with_suffix('.pub').unlink(missing_ok=True)
        input_file.unlink(missing_ok=True);public_file.unlink(missing_ok=True)
if __name__=='__main__':
    try:main()
    except Exception as error:
        code=str(error) if isinstance(error,RuntimeError) and re.fullmatch('[A-Z0-9_]+',str(error)) else 'V5_CI_TRANSPORT_FAILED'
        stage=getattr(error,'stage','request')
        print(json.dumps({'status':'FAILED','code':code,'stage':stage if stage in {'request','image','validation','issuer','encryption','authenticated_transport','main_readback','ssh_key_preparation','remote_directory','input_copy','remote_issuer','remote_cleanup','os_login_cleanup'} else 'request'}));raise SystemExit(1)
