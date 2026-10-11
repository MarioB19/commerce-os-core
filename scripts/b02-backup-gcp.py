#!/usr/bin/env python3
"""One keyless Cloud Run transport. Root authenticates every execution itself."""
import argparse
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import signal
import sys
import time
import urllib.request
import urllib.parse
import uuid
from b02_backup_contract import (DAILY, TARGET, MAX_BYTES, GCP_JOB, GCP_EXECUTOR, canonical,
    gcp_binding, gcp_run_identity, need, sha256, unique_json, validate_bucket, validate_custody, export_names)
from ephemeral_os_login import remove_ephemeral_key

SCRIPTS = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('b02_ci_transport', SCRIPTS/'b02-backup-ci.py')
common = importlib.util.module_from_spec(spec); spec.loader.exec_module(common)
spec = importlib.util.spec_from_file_location('b02_root_transport', SCRIPTS/'b02-backup-root.py')
root_transport = importlib.util.module_from_spec(spec); spec.loader.exec_module(root_transport)


def durable_json(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as stream:
        stream.write(canonical(value)); stream.flush(); os.fsync(stream.fileno())
    fd = os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def metadata_token():
    # Fixed metadata host/path/header; never a user-supplied credential source.
    request = urllib.request.Request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        headers={'Metadata-Flavor':'Google'})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs): raise RuntimeError('B02_METADATA_REDIRECT_REJECTED')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    try:
        with opener.open(request,timeout=10) as response:
            need(response.status==200 and response.geturl()==request.full_url and response.headers.get('Metadata-Flavor')=='Google','B02_METADATA_IDENTITY_INVALID')
            raw=response.read(16385); need(len(raw)<=16384,'B02_METADATA_BOUND')
            data=unique_json(raw)
            need(type(data) is dict and data.get('token_type')=='Bearer'
                 and type(data.get('expires_in')) is int and data['expires_in']>=120
                 and isinstance(data.get('access_token'),str),'B02_METADATA_TOKEN_INVALID')
            return data['access_token']
    except Exception: raise RuntimeError('B02_METADATA_UNAVAILABLE') from None



def create_resumable_session(bucket, object_name, expected, token, *, timeout=30):
    """One create-only session; capability and OAuth credential remain in RAM."""
    need(type(expected) is dict and set(expected)=={'bytes','sha256'}
         and type(expected['bytes']) is int and 0<expected['bytes']<=MAX_BYTES
         and re.fullmatch(r'[a-f0-9]{64}',expected['sha256']), 'B02_UPLOAD_EXPECTED_INVALID')
    need(type(token) is str and 20<=len(token)<=4096, 'B02_UPLOAD_TOKEN_INVALID')
    need(type(timeout) in (int,float) and 0<timeout<=30, 'B02_UPLOAD_DEADLINE_INVALID')
    query=urllib.parse.urlencode({'uploadType':'resumable','name':object_name,'ifGenerationMatch':'0'})
    url='https://storage.googleapis.com/upload/storage/v1/b/'+urllib.parse.quote(bucket,safe='')+'/o?'+query
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):raise RuntimeError('B02_UPLOAD_REDIRECT_REJECTED')
    request=urllib.request.Request(url,data=canonical({'name':object_name,'contentType':'application/octet-stream'}),method='POST',
        headers={'Authorization':'Bearer '+token,'Content-Type':'application/json; charset=UTF-8',
                 'X-Upload-Content-Type':'application/octet-stream','X-Upload-Content-Length':str(expected['bytes'])})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect()).open(request,timeout=timeout) as response:
            need(response.status==200 and response.geturl()==url, 'B02_UPLOAD_SESSION_RESPONSE_INVALID')
            uri=response.headers.get('Location');root_transport.resumable_target(uri,bucket,object_name)
            return uri
    except Exception:raise RuntimeError('B02_UPLOAD_SESSION_UNKNOWN_PRESERVE') from None
    finally:token=None;request=None


def cloud_environment(env):
    need(env.get('CLOUD_RUN_JOB')=='commerce-b02-daily'
         and re.fullmatch(r'commerce-b02-daily-[a-z0-9]{1,30}',env.get('CLOUD_RUN_EXECUTION',''))
         and env.get('CLOUD_RUN_TASK_INDEX')=='0' and env.get('CLOUD_RUN_TASK_COUNT')=='1'
         and env.get('CLOUD_RUN_TASK_ATTEMPT')=='0'
         and re.fullmatch(r'[a-f0-9]{40}',env.get('B02_SOURCE_SHA','')),'B02_GCP_ENVIRONMENT_INVALID')
    need(not any(name.startswith('GITHUB_') for name in env), 'B02_GCP_NO_GITHUB_IMPERSONATION')
    return GCP_JOB+'/executions/'+env['CLOUD_RUN_EXECUTION'],env['B02_SOURCE_SHA']


class Transport:
    def __init__(self, *, work_base=Path('/work'), clock=time.monotonic, runner=common.command):
        self.clock=clock; self.deadline=clock()+1695; self.runner=runner
        self.execution,self.source=cloud_environment(os.environ)
        need((SCRIPTS.parent/'SOURCE_SHA').read_text().strip()==self.source,'B02_IMAGE_SOURCE_CHANGED')
        info=work_base.lstat()
        # Cloud Run's newly mounted emptyDir may start writable. Tighten only
        # this exact empty, root-owned ephemeral mount, never historical storage.
        if work_base==Path('/work') and info.st_uid==0 and os.geteuid()==0 and not work_base.is_symlink() and not any(work_base.iterdir()):
            work_base.chmod(0o700);info=work_base.lstat()
        need(work_base.is_dir() and not work_base.is_symlink()
            and info.st_uid==os.geteuid() and not info.st_mode&0o022,'B02_WORK_CUSTODY_INVALID')
        self.work=work_base/os.environ['CLOUD_RUN_EXECUTION'];self.work.mkdir(mode=0o700)
        self.key=self.work/'iap-key';self.registered=False;self.acknowledged=False
        self.base=['--project='+TARGET[0],'--zone='+TARGET[2],'--tunnel-through-iap','--quiet','--ssh-key-file='+str(self.key)]
        self.root='sudo -n /usr/bin/env PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -B '+str(DAILY/'b02-backup-root.py')
        # Isolated SDK state, no user's profile; ADC is the attached service identity.
        config=self.work/'gcloud';config.mkdir(mode=0o700)
        os.environ.update(CLOUDSDK_CONFIG=str(config),CLOUDSDK_CORE_DISABLE_PROMPTS='1',
            CLOUDSDK_STORAGE_PROCESS_COUNT='1',CLOUDSDK_STORAGE_THREAD_COUNT='1',
            CLOUDSDK_STORAGE_PARALLEL_COMPOSITE_UPLOAD_ENABLED='False')

    def command(self,args,*,timeout=900,check=True,failure_code='B02_TRANSPORT_COMMAND_FAILED',input=None):
        remaining=self.deadline-self.clock();need(remaining>10,'B02_TRANSPORT_GLOBAL_DEADLINE')
        return self.runner(args,timeout=min(timeout,remaining-5),check=check,failure_code=failure_code,input=input)

    def ssh(self,command,*,check=True,input=None,timeout=180):
        # Disable multiplexed/background SSH outside this command's process group.
        return self.command(['gcloud','compute','ssh',TARGET[1],*self.base,'--ssh-key-expire-after=30m',
            '--ssh-flag=-T','--ssh-flag=-oControlMaster=no','--ssh-flag=-oControlPersist=no',
            '--command='+command],check=check,input=input,timeout=timeout)

    def verify_uploaded(self, expected, name, object_name, created):
        """Generation-pinned full readback over GCS, without copying payload via IAP."""
        uri='gs://'+self.binding['bucket']+'/'+object_name
        metadata=unique_json(self.command(['gcloud','storage','objects','describe',uri,'--format=json']).stdout)
        generation=str(metadata.get('generation',''))
        need(metadata.get('bucket')==self.binding['bucket'] and metadata.get('name')==object_name
             and generation.isdigit() and int(generation)>0 and str(metadata.get('size'))==str(expected['bytes']),
             'B02_OBJECT_METADATA_MISMATCH')
        readback=self.work/('readback-'+name)
        need(not readback.exists() and not readback.is_symlink(),'B02_READBACK_TARGET_EXISTS')
        self.command(['gcloud','storage','cp',uri+'#'+generation,str(readback),'--quiet'])
        readback.chmod(0o600)
        need(common.export_reference(readback,name)==expected,'B02_FULL_OBJECT_HASH_MISMATCH')
        readback.unlink()
        return expected|{'generation':generation,'full_download_verified':True,'create_command_succeeded':created,'object':object_name}

    def status(self):
        data=unique_json(self.ssh(self.root+' status'+self.identity).stdout)
        need(data.get('run_id')==self.run_id and data.get('plan_sha256')==self.binding['plan_sha256'], 'B02_REPORT_IDENTITY_CHANGED')
        if data.get('status')!='NOT_STARTED':need(data.get('source_sha')==self.source,'B02_REPORT_SOURCE_CHANGED')
        return data

    def run(self):
        self.command(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(self.key)],timeout=30)
        self.registered=True
        checks=''.join(sha256((SCRIPTS/name).read_bytes())+'  '+str(DAILY/name)+'\n'
            for name in ('b02-backup-root.py','b02_backup_contract.py','b02-portal-capsule.mjs'))
        self.ssh('printf %s '+shlex.quote(checks)+' | sudo -n sha256sum --check --status')
        self.binding=gcp_binding(unique_json(self.ssh(self.root+' gcp-binding').stdout))
        need(self.binding['source_sha']==self.source,'B02_GCP_INSTALLED_SOURCE_CHANGED')
        common.verify_instance(self.command(['gcloud','compute','instances','describe',TARGET[1],
            '--project='+TARGET[0],'--zone='+TARGET[2],'--format=json','--quiet']).stdout)
        bucket=validate_bucket(unique_json(self.command(['gcloud','storage','buckets','describe',
            'gs://'+self.binding['bucket'],'--raw','--format=json','--quiet']).stdout),self.binding['bucket'])
        request={'execution':self.execution,'access_token':metadata_token()}
        try:
            authorized=unique_json(self.ssh(self.root+' gcp-authorize --plan-sha256 '+self.binding['plan_sha256'],
                input=json.dumps(request),timeout=150).stdout)
        finally:request.clear()
        need(authorized.get('status')=='B02_GCP_AUTHORIZED' and authorized.get('source_sha')==self.source
             and authorized.get('plan_sha256')==self.binding['plan_sha256'],'B02_AUTHORIZATION_INVALID')
        self.run_id=authorized['run_id'];need(re.fullmatch(r'gcp-[a-f0-9]{32}',self.run_id),'B02_RUN_ID_INVALID')
        self.identity=' --plan-sha256 '+self.binding['plan_sha256']+' --run-id '+self.run_id
        self.unit='commerce-b02-'+self.run_id
        durable_json(self.work/'authorization.json',authorized)
        previous=self.status();need(previous.get('status')=='NOT_STARTED','B02_ALREADY_DISPATCHED_PRESERVE')
        unit=self.ssh('sudo -n systemctl show '+self.unit+'.service --property=LoadState --property=ActiveState --property=MainPID --no-pager',check=False)
        need(common.unit_state(unit.stdout,unit.returncode)=='TERMINAL','B02_REMOTE_START_UNKNOWN_PRESERVE')
        trigger={'authorization_ref':authorized['trigger_ref'],'claim_ref':authorized['claim_ref']}
        command='sudo -n systemd-run --quiet --collect --unit='+self.unit+' --property=RuntimeMaxSec=1650 --property=TimeoutStopSec=60 --property=UMask=0077 /usr/bin/env PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -B '+str(DAILY/'b02-backup-root.py')+' execute'+self.identity+' --source-sha '+self.source+' --trigger-json '+shlex.quote(json.dumps(trigger))
        if authorized['scheduled']:command+=' --scheduled'
        durable_json(self.work/'dispatch-intent.json',{'run_id':self.run_id,'command_sha256':sha256(command.encode()),'attempt':1})
        try:self.ssh(command,check=False)
        except RuntimeError:pass  # Unknown single dispatch: only status reads below.
        while True:
            current=self.status()
            if current.get('status') not in ('NOT_STARTED','RUNNING'):break
            need(self.deadline-self.clock()>60,'B02_REMOTE_TIMEOUT_UNKNOWN_PRESERVE');time.sleep(5)
        need(current['status']=='LOCAL_CUSTODY_PENDING','B02_LOCAL_CUSTODY_REQUIRED')
        unit=self.ssh('sudo -n systemctl show '+self.unit+'.service --property=LoadState --property=ActiveState --property=MainPID --no-pager',check=False)
        need(common.unit_state(unit.stdout,unit.returncode)=='TERMINAL' and self.status()==current,'B02_REMOTE_FINAL_STATE_CHANGED')
        need(sum(x['bytes'] for x in current['exports'].values())<=MAX_BYTES,'B02_TOTAL_COST_SIZE_LIMIT')
        self.ssh(self.root+' export'+self.identity)
        objects={}
        for name in export_names(current):
            expected={key:current['exports'][name][key] for key in ('bytes','sha256')}
            free=os.statvfs(self.work).f_bavail*os.statvfs(self.work).f_frsize
            need(free>=2*expected['bytes']+64*1024**2,'B02_TMPFS_RESERVATION_FAILED')
            object_name='b02/daily/'+self.run_id+'/'+name
            durable_json(self.work/('transfer-'+name+'.intent.json'),{'run_id':self.run_id,'name':name,'expected':expected})
            remaining=self.deadline-self.clock();need(remaining>10,'B02_TRANSPORT_GLOBAL_DEADLINE')
            session=create_resumable_session(self.binding['bucket'],object_name,expected,metadata_token(),timeout=min(30,remaining-5))
            try:
                budget=min(900,int(self.deadline-self.clock()-10));need(budget>0,'B02_TRANSPORT_GLOBAL_DEADLINE')
                response=unique_json(self.ssh(self.root+' gcp-upload-object'+self.identity,
                    input=json.dumps({'name':name,'session_uri':session,'timeout_seconds':budget}),timeout=budget+5).stdout)
            finally:session=None
            need(response=={'status':'B02_CIPHERTEXT_OBJECT_UPLOADED','run_id':self.run_id,'name':name,
                            'bytes':expected['bytes'],'sha256':expected['sha256']},'B02_ROOT_UPLOAD_RESULT_CHANGED')
            objects[name]=self.verify_uploaded(expected,name,object_name,True)
            durable_json(self.work/('verified-'+name+'.json'),objects[name])
        custody={'status':'B02_OFFHOST_CUSTODY_VERIFIED','run_id':self.run_id,'source_sha':self.source,
            'plan_sha256':self.binding['plan_sha256'],'bucket':self.binding['bucket'],'bucket_configuration':bucket,'objects':objects,
            'keys_exported':False,'plaintext_exported':False,'restore_verified':False,'backup_contract_version':2,
            'backup_decryption_key_exported':False,'portal_credentials_archived_encrypted':True,'portal_capsule':current['portal_capsule']}
        validate_custody(custody,current,self.binding['bucket'])
        receipt=self.work/'custody.json';durable_json(receipt,custody)
        fifth=common.upload_verified(receipt,'gs://'+self.binding['bucket']+'/b02/daily/'+self.run_id+'/custody.json',
            self.work/'readback-custody.json',runner=self.command)
        durable_json(self.work/'custody-object.json',fifth)
        self.command(['gcloud','compute','scp',*self.base,'--scp-flag=-oControlMaster=no','--scp-flag=-oControlPersist=no',str(receipt),TARGET[1]+':~/commerce-b02-'+self.run_id+'/custody.json'])
        ack=unique_json(self.ssh(self.root+' ack'+self.identity+' --receipt-sha256 '+sha256(receipt.read_bytes())).stdout)
        need(ack.get('status')=='SUCCEEDED' and ack.get('external_copy_verified') is True
             and ack.get('run_id')==self.run_id and ack.get('source_sha')==self.source
             and ack.get('plan_sha256')==self.binding['plan_sha256'],'B02_CUSTODY_ACK_UNKNOWN')
        durable_json(self.work/'ack.json',ack);self.acknowledged=True
        self.ssh(self.root+' discard-export'+self.identity)
        return {'status':'B02_GCP_OFFSITE_VERIFIED','run_id':self.run_id,'source_sha':self.source,
            'execution':self.execution,'execution_uid':str(uuid.UUID(hex=self.run_id[4:])),
            'external_copy_verified':True,'scheduled_delivery_proven':False,'restore_verified':False,
            'custody_object':fifth|{'object':'b02/daily/'+self.run_id+'/custody.json','bucket':self.binding['bucket']},
            'root_ack':{'status':ack['status'],'run_id':ack['run_id'],'source_sha':ack['source_sha'],
                'external_copy_verified':ack['external_copy_verified']},'export_discard_command_succeeded':True}

    def cleanup(self):
        result={'key_absent_verified':True,'registered':False}
        if self.registered:
            # Preserve a bounded independent cleanup margin after the work fuse.
            def cleanup_command(args):return self.runner(args,timeout=30,failure_code='B02_OS_LOGIN_CLEANUP_COMMAND_FAILED')
            result=remove_ephemeral_key(self.key.with_suffix('.pub').read_text(),cleanup_command)
        self.key.unlink(missing_ok=True);self.key.with_suffix('.pub').unlink(missing_ok=True)
        return result


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--prepared',action='store_true');args=parser.parse_args()
    if args.prepared:
        print(json.dumps({'status':'PREPARED_ONLY','cloud_calls':0,'schedule_enabled':False}));return
    os.umask(0o077)
    def interrupted(*_):raise RuntimeError('B02_RUNNER_INTERRUPTED_UNKNOWN_PRESERVE')
    signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
    transport=Transport()
    try:result=transport.run()
    finally:cleanup=transport.cleanup()
    result['ephemeral_key_cleanup']=cleanup
    # Cloud Logging is the durable terminal receipt for the fifth object pin.
    # Read it back by authenticated execution identity before claiming custody.
    print(json.dumps(result))


if __name__=='__main__':
    try:main()
    except Exception as error:
        code=str(error) if isinstance(error,RuntimeError) and re.fullmatch(r'[A-Z0-9_]{1,100}',str(error)) else 'B02_GCP_TRANSPORT_FAILED'
        print(json.dumps({'status':'STOP_PRESERVE','code':code}),file=sys.stderr);sys.exit(1)
