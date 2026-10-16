"""Bounded native adapter for the existing canonical Root transport.

All readers and callbacks are wired by the immutable publisher image from its
protected configuration. HTTP inputs/candidate files cannot supply callbacks.
The admission reader reauthenticates FULL, package, immutable archive and active
budget. The identity reader queries the workload identity; the GitHub reader
uses a separate read-authorized provider. This module grants no permissions.

Two durable actions fence transport preparation and the actual Root start.
Uncertain effects reconcile by reads only; a timeout does not stop systemd's
canonical installer/rollback or authorize replay. Fifteen minutes include key
cleanup. Root+HTTPS verification and GitHub publication remain separate.
"""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import time
import uuid

from ci_provider_evidence import PROJECT, CLOUD_RUN, validate_context
from ci_release import digest, require
from ephemeral_os_login import remove_ephemeral_key

ACCOUNT = 'commerce-v7-publisher-core@'+PROJECT+'.iam.gserviceaccount.com'
INSTANCE = 'commerce-os-test'
INSTANCE_ID = '6334472381123916728'
ZONE = 'us-east1-d'
SECONDS = 900
CLEANUP_SECONDS = 90
MAX_OUTPUT = 1024*1024


def encoded(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()


def load_client(expected):
    path=Path(__file__).with_name('deploy-ci-client.py')
    require(type(expected)is str and re.fullmatch('[a-f0-9]{64}',expected)
            and digest(path)==expected,'NATIVE_INSTALL_CLIENT_CHANGED')
    spec=importlib.util.spec_from_file_location('trusted_canonical_install_client',path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def validate_admitted(value):
    require(type(value)is dict,'NATIVE_INSTALL_ADMISSION_REQUIRED')
    context=validate_context(value.get('context'))
    match=CLOUD_RUN.fullmatch(value.get('installation_run_id',''))
    require(context['package_origin']=='cloud-build' and match and match[1]==context['package_build_id']
            and value.get('source_sha')==context['source_sha']
            and type(value.get('archive_sha256'))is str and re.fullmatch('[a-f0-9]{64}',value['archive_sha256']),
            'NATIVE_INSTALL_ADMISSION_BINDING_INVALID')
    return value


class NativeInstall:
    account=ACCOUNT

    def __init__(self,root,private,*,client_sha256,attempt_id,admission_reader,identity_reader,
                 instance_reader,main_reader,controls_reader,token_provider,journal,report_sink,boot_inputs=None,clock=time.monotonic):
        self.root=Path(root);self.private=Path(private)
        require(str(uuid.UUID(attempt_id))==attempt_id,'NATIVE_INSTALL_ATTEMPT_INVALID')
        require(self.root.is_absolute() and self.root.resolve()==self.root and self.root.is_dir()
                and self.private.is_absolute() and self.private.resolve()==self.private
                and not self.private.is_relative_to(self.root),'NATIVE_INSTALL_DIRECTORY_INVALID')
        info=self.private.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid==os.getuid() and stat.S_IMODE(info.st_mode)==0o700,
                'NATIVE_INSTALL_PRIVATE_DIRECTORY_REQUIRED')
        self.client=load_client(client_sha256);self.client.ROOT=self.root
        self.attempt_id=attempt_id;self.admission_reader=admission_reader;self.identity_reader=identity_reader
        self.instance_reader=instance_reader;self.main_reader=main_reader;self.controls_reader=controls_reader
        self.token_provider=token_provider
        self.journal=journal;self.report_sink=report_sink;self.clock=clock
        self.deadline=clock()+SECONDS;self.cleaning=False;self.admitted=None;self.authorized=False
        self.intents={}
        self.boot_inputs=boot_inputs;self.boot_staged=False
        self.boot_input_sha256=hashlib.sha256(boot_inputs).hexdigest() if type(boot_inputs)is bytes else None

    def remaining(self):
        limit=self.deadline if self.cleaning else self.deadline-CLEANUP_SECONDS
        remaining=limit-self.clock()
        require(remaining>0,'NATIVE_PUBLISHER_DEADLINE_RECONCILE_ONLY')
        return remaining

    def observed_identity(self):
        require(self.identity_reader()==self.account,'NATIVE_PUBLISHER_WORKLOAD_IDENTITY_CHANGED')
        vm=self.instance_reader()
        require(type(vm)is dict and str(vm.get('id'))==INSTANCE_ID and vm.get('name')==INSTANCE
                and vm.get('zone')=='https://www.googleapis.com/compute/v1/projects/'+PROJECT+'/zones/'+ZONE
                and vm.get('status')=='RUNNING','NATIVE_PUBLISHER_VM_IDENTITY_CHANGED')

    def observed_controls(self):
        controls=self.controls_reader()
        require(type(controls)is dict and controls.get('deploy_paused')is False
                and controls.get('github_actions_enabled')is False,'NATIVE_INSTALL_EXCLUSIONS_REQUIRED')

    def intent(self,action,payload):
        self.remaining()
        value=self.journal.commit_intent(action,payload)
        require(type(value)is dict and value.get('effect')=='CREATE_ONCE'
                and value.get('intent_sha256')==hashlib.sha256(encoded(payload)).hexdigest()
                and value.get('attempt_id')==self.attempt_id
                and type(value.get('fencing_generation'))is str
                and re.fullmatch('[1-9][0-9]*',value['fencing_generation']),
                'NATIVE_INSTALL_INTENT_NOT_NEW_RECONCILE_ONLY')
        self.intents[action]=value['intent_sha256']

    def payload(self):
        return {key:self.admitted[key] for key in ('context','source_sha','installation_run_id','archive_sha256')}

    def validate_boot_input(self):
        import runtime_boot_admission as boot
        value,_,_=boot.unpack(self.boot_inputs)
        require(all(value[k]==self.admitted[k] for k in ('source_sha','installation_run_id','archive_sha256'))
                and boot.gate.restore.stamp(value['created_at']) <= datetime.now(timezone.utc)
                < boot.gate.restore.stamp(value['expires_at']), 'NATIVE_BOOT_INPUT_ADMISSION_CHANGED')
        require(boot.checksum(self.boot_inputs)==self.boot_input_sha256,'NATIVE_BOOT_INPUT_CHANGED')
        return boot

    def boot_input_file(self):
        require(self.authorized,'NATIVE_INSTALL_TRANSPORT_NOT_ADMITTED')
        boot=self.validate_boot_input();path=self.root/'release'/boot.FILENAME
        parent=path.parent.lstat()
        require(stat.S_ISDIR(parent.st_mode) and parent.st_uid==os.getuid()
                and stat.S_IMODE(parent.st_mode)==0o700,'NATIVE_BOOT_INPUT_DIRECTORY_UNSAFE')
        if not self.boot_staged:
            require('install-transport:'+self.admitted['installation_run_id'] in self.intents,
                    'NATIVE_BOOT_INPUT_INTENT_REQUIRED')
            fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'wb')as stream:
                stream.write(self.boot_inputs);stream.flush();os.fsync(stream.fileno())
            fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:os.fsync(fd)
            finally:os.close(fd)
            self.boot_staged=True
        with os.fdopen(os.open(path,os.O_RDONLY|os.O_NOFOLLOW),'rb')as stream:
            before=os.fstat(stream.fileno())
            require(stat.S_ISREG(before.st_mode) and before.st_uid==os.getuid() and before.st_nlink==1
                    and stat.S_IMODE(before.st_mode)==0o600 and 0<before.st_size<=boot.MAX_WIRE,
                    'NATIVE_BOOT_INPUT_FILE_CHANGED')
            raw=stream.read(boot.MAX_WIRE+1)
            fp=lambda s:(s.st_dev,s.st_ino,s.st_uid,s.st_gid,s.st_mode,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
            require(raw==self.boot_inputs and len(raw)==before.st_size
                    and fp(before)==fp(os.fstat(stream.fileno()))==fp(path.lstat()),
                    'NATIVE_BOOT_INPUT_FILE_CHANGED')
        return path

    def admission(self,root):
        require(self.authorized and Path(root)==self.root,'NATIVE_INSTALL_TRANSPORT_NOT_ADMITTED')
        require(self.admission_reader()==self.admitted,'NATIVE_INSTALL_ADMISSION_CHANGED')
        return deepcopy(self.admitted)

    def before_start(self):
        self.observed_identity();self.observed_controls()
        require(self.admission_reader()==self.admitted,'NATIVE_INSTALL_ADMISSION_CHANGED')
        require(self.main_reader()==self.admitted['source_sha'],'SUPERSEDED_COMMIT')
        self.intent('root-start:'+self.admitted['installation_run_id'],self.payload())
        # A slow CAS can consume the intent while its admission becomes stale.
        # Re-read after the confirmed commit; failure cannot authorize replay.
        self.remaining();self.observed_identity();self.observed_controls()
        require(self.admission_reader()==self.admitted,'NATIVE_INSTALL_ADMISSION_CHANGED')
        require(self.main_reader()==self.admitted['source_sha'],'SUPERSEDED_COMMIT')
        self.boot_input_file()
        self.remaining()

    def environment(self,*,google=False):
        env={'PATH':'/opt/google-cloud-sdk/bin:/usr/local/bin:/usr/bin:/bin','HOME':str(self.private),
             'CLOUDSDK_CONFIG':str(self.private/'gcloud'),'CLOUDSDK_CORE_DISABLE_PROMPTS':'1',
             'CLOUDSDK_CORE_DISABLE_USAGE_REPORTING':'true','CLOUDSDK_COMPONENT_MANAGER_DISABLE_UPDATE_CHECK':'1',
             'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0',
             'PYTHONDONTWRITEBYTECODE':'1','LC_ALL':'C.UTF-8'}
        if google:
            try:token=self.token_provider()
            except Exception:raise RuntimeError('NATIVE_INSTALL_TOKEN_UNAVAILABLE') from None
            require(type(token)is str and token and not any(c.isspace() for c in token),'NATIVE_INSTALL_TOKEN_UNAVAILABLE')
            env['CLOUDSDK_AUTH_ACCESS_TOKEN']=token
        return env

    def google_command(self,argv):
        """Exactly the canonical SSH/SCP options; no SDK flags-file or aliases."""
        kind=argv[2]
        if kind=='os-login':
            require(argv[3:]==['describe-profile','--format=json'] or
                (len(argv)==7 and argv[3:5]==['ssh-keys','remove'] and
                 re.fullmatch('--key=[a-f0-9]{64}',argv[5]) and argv[6]=='--quiet'),
                'NATIVE_INSTALL_OSLOGIN_SCOPE_CHANGED')
            return argv+['--account='+self.account,'--project='+PROJECT]
        require(self.admitted is not None,'NATIVE_INSTALL_ADMISSION_REQUIRED')
        start=4 if kind=='ssh' else 3
        if kind=='ssh':require(len(argv)>4 and argv[3]==INSTANCE,'NATIVE_INSTALL_VM_CHANGED')
        options={};positions=[]
        for value in argv[start:]:
            if value.startswith('--'):
                key,separator,item=value.partition('=')
                require(key not in options and (separator or key in {'--quiet','--tunnel-through-iap'}),
                        'NATIVE_INSTALL_DUPLICATE_OR_SPLIT_OPTION')
                options[key]=item if separator else None
            else:positions.append(value)
        expected={'--project':PROJECT,'--zone':ZONE,'--account':self.account,
            '--quiet':None,'--tunnel-through-iap':None}
        require(all(options.get(k,'missing')==v for k,v in expected.items()),'NATIVE_INSTALL_GOOGLE_SCOPE_CHANGED')
        keys=set(expected)|{'--ssh-key-file'}
        if kind=='ssh':keys|={'--ssh-key-expire-after','--command'}
        require(set(options)==keys,'NATIVE_INSTALL_GOOGLE_OPTIONS_CHANGED')
        key=Path(options['--ssh-key-file'])
        require(key.is_absolute() and key.parent==self.private and key.name not in {'','.','..'},
                'NATIVE_INSTALL_KEY_PATH_CHANGED')
        if kind=='ssh':
            require(not positions and options['--ssh-key-expire-after']in{'5m','30m'}
                    and options['--command'] and '\x00'not in options['--command'],
                    'NATIVE_INSTALL_SSH_SCOPE_CHANGED')
        else:
            # The immutable client hash was authenticated by load_client().
            # Share its complete fixed closure, never a candidate-provided list.
            files=[str(self.root/'release/commerce-os.tar'),
                *[str(self.root/'scripts'/name)for name in self.client.STAGING_SCRIPTS],
                str(self.root/'release/host-boot-inputs.json')]
            destination=INSTANCE+':~/commerce-ci-'+self.admitted['installation_run_id']+'/'
            require(positions==files+[destination],'NATIVE_INSTALL_SCP_SCOPE_CHANGED')
        return argv

    def run(self,argv,check=True,capture=False):
        require(type(argv)is list and argv and all(type(v)is str for v in argv),'NATIVE_INSTALL_COMMAND_INVALID')
        if argv==['gh','api','repos/MarioB19/commerce-os-core/commits/main','--jq','.sha']:
            value=self.main_reader();require(type(value)is str and re.fullmatch('[a-f0-9]{40}',value),'NATIVE_MAIN_READ_INVALID')
            return subprocess.CompletedProcess(argv,0,value+'\n','')
        google=argv[:2]==['gcloud','compute']
        allowed=argv in (['git','rev-parse','HEAD'],['git','status','--porcelain','--untracked-files=all'])
        allowed=allowed or (argv[0]=='ssh-keygen' and argv[:7]==['ssh-keygen','-q','-t','ed25519','-N','','-C']
            and len(argv)==10 and argv[8]=='-f' and Path(argv[9]).parent==self.private)
        allowed=allowed or (google and len(argv)>2 and argv[2]in{'ssh','scp','os-login'})
        require(allowed,'NATIVE_INSTALL_COMMAND_REJECTED')
        if google:
            argv=self.google_command(argv)
        timeout=min(300 if google and argv[2]=='scp' else 60,self.remaining())
        process=subprocess.Popen(argv,cwd=self.root,env=self.environment(google=google),stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
        selector=selectors.DefaultSelector();selector.register(process.stdout,selectors.EVENT_READ)
        expires=self.clock()+timeout;raw=bytearray();code=None
        try:
            while selector.get_map():
                require(self.clock()<expires,'NATIVE_INSTALL_COMMAND_TIMEOUT')
                for event,_ in selector.select(min(.1,max(.001,expires-self.clock()))):
                    chunk=os.read(event.fileobj.fileno(),min(65536,MAX_OUTPUT-len(raw)+1))
                    if not chunk:selector.unregister(event.fileobj);continue
                    raw.extend(chunk);require(len(raw)<=MAX_OUTPUT,'NATIVE_INSTALL_OUTPUT_BOUND')
            code=process.wait(timeout=max(.001,expires-self.clock()))
        except Exception:
            if process.poll()is None:os.killpg(process.pid,signal.SIGKILL)
            process.wait(timeout=5)
            if check:raise RuntimeError('NATIVE_INSTALL_COMMAND_FAILED_OR_UNKNOWN') from None
            return subprocess.CompletedProcess(argv,124,'','')
        finally:
            selector.close();process.stdout.close()
            if process.poll()is None:os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=5)
        require(not check or code==0,'NATIVE_INSTALL_COMMAND_FAILED_OR_UNKNOWN')
        return subprocess.CompletedProcess(argv,code,raw.decode() if capture else '','')

    def wait_for_report(self,ssh,path,unit):
        # One canonical poll per iteration, with the same terminal-unit then
        # fresh-report ordering. No cloud worker may inherit the 90-minute loop.
        while self.remaining()>15:
            try:return self.client.wait_for_report(ssh,path,unit,attempts=1,delay=0)
            except RuntimeError as error:
                if str(error)!='REMOTE_DEPLOYMENT_STATUS_TIMEOUT_INSPECT_SYSTEMD':raise
            time.sleep(min(5,max(0,self.remaining()-15)))
        raise RuntimeError('NATIVE_PUBLISHER_DEADLINE_RECONCILE_ONLY')

    def record_report(self,report):
        require(type(report)is dict and report.get('run_id')==self.admitted['installation_run_id']
                and report.get('source_sha')==self.admitted['source_sha'],'NATIVE_INSTALL_REPORT_CHANGED')
        self.client.validate_requested_scope(report,'copy-runtime')
        if report.get('status')=='SUCCEEDED':
            require(report.get('provider_evidence')==self.admitted['context']
                    and report.get('source_tree')==self.admitted['context']['source_tree']
                    and report.get('archive_sha256')==self.admitted['archive_sha256'],
                    'NATIVE_INSTALL_REPORT_PACKAGE_CHANGED')
        # This is a derived private transport receipt. It cannot replace the
        # original Root bytes/reference collected by the publication reader.
        self.report_sink(encoded(report))

    def begin_cleanup(self):self.cleaning=True

    def install_once(self):
        require(not self.authorized,'NATIVE_INSTALL_ALREADY_USED')
        self.observed_identity();self.observed_controls()
        self.admitted=deepcopy(validate_admitted(self.admission_reader()))
        self.validate_boot_input()
        require(self.main_reader()==self.admitted['source_sha'],'SUPERSEDED_COMMIT')
        action='install-transport:'+self.admitted['installation_run_id']
        self.intent(action,self.payload());self.authorized=True
        values={'COMMERCE_DEPLOY_PAUSED':'false','COMMERCE_DEPLOY_SCOPE':'copy-runtime',
            'GCP_PROJECT_ID':PROJECT,'GCP_INSTANCE':INSTANCE,'GCP_ZONE':ZONE,'RUNNER_TEMP':str(self.private)}
        try:
            self.remaining();self.observed_identity();self.observed_controls()
            require(self.admission_reader()==self.admitted,'NATIVE_INSTALL_ADMISSION_CHANGED')
            require(self.main_reader()==self.admitted['source_sha'],'SUPERSEDED_COMMIT')
            self.boot_input_file()
            report=self.client.main(native=self,environment=values)
            for name,intent in self.intents.items():
                self.journal.record_result(name,{'status':'RECONCILED','intent_sha256':intent,
                    'native_id':self.admitted['installation_run_id'],'report_sha256':hashlib.sha256(encoded(report)).hexdigest()})
            return {'status':'ROOT_INSTALLATION_OBSERVED_PUBLICATION_PENDING','report':report}
        except Exception:
            for name,intent in self.intents.items():
                try:self.journal.record_result(name,{'status':'UNKNOWN','intent_sha256':intent})
                except Exception:pass
            raise RuntimeError('NATIVE_INSTALL_OUTCOME_UNKNOWN_RECONCILE_ONLY') from None

    def reconcile(self):
        """Inspect the existing unit/report; never stage, copy or start again."""
        self.observed_identity();self.admitted=deepcopy(validate_admitted(self.admission_reader()))
        run=self.admitted['installation_run_id'];unit='commerce-ci-'+run
        key=self.private/('reconcile-'+str(uuid.uuid4()));attempted=False
        base=['gcloud','compute','ssh',INSTANCE,'--project='+PROJECT,'--zone='+ZONE,
            '--account='+self.account,'--tunnel-through-iap','--quiet','--ssh-key-file='+str(key),'--ssh-key-expire-after=5m']
        def ssh(command,check=True):return self.run(base+['--command='+command],check=check,capture=True)
        try:
            self.run(['ssh-keygen','-q','-t','ed25519','-N','','-C','commerce-release-reconcile','-f',str(key)])
            attempted=True
            report=self.wait_for_report(ssh,'/opt/commerce-os/private/deployments/'+run+'/report.json',unit)
            self.record_report(report)
            # The canonical poll has authenticated a terminal unit and fresh
            # report. Cleanup independently rechecks terminal state/MainPID;
            # uncertain or still-running installs never reach this command.
            self.begin_cleanup()
            cleanup=ssh(self.client.cleanup_staging_command(unit,unit),check=False)
            require(cleanup.returncode==0,'REMOTE_STAGING_CLEANUP_UNCONFIRMED')
            require(report.get('status')=='SUCCEEDED','NATIVE_INSTALL_TERMINAL_NOT_SUCCESS')
            return {'status':'ROOT_INSTALLATION_RECONCILED_PUBLICATION_PENDING','report':report}
        finally:
            self.begin_cleanup()
            try:
                if attempted:remove_ephemeral_key(key.with_suffix('.pub').read_text(),lambda argv:self.run(argv,check=False,capture=True))
            finally:key.unlink(missing_ok=True);key.with_suffix('.pub').unlink(missing_ok=True)
