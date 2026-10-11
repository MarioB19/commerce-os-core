"""Synthetic transport tests; no credential, SSH, Cloud Build or VM access."""
import copy
from datetime import datetime,timedelta,timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch,Mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
import cloudbuild_native_install as m
from ci_release import ReleaseError
from test_cloudbuild_native_publisher import native_fixture

ATTEMPT='aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb'


def boot_fixture(admitted):
    import runtime_boot_admission as boot
    from test_runtime_boot_restore_gate import Fixture,SOURCE
    moment=datetime.now(timezone.utc);f=Fixture()
    history=boot.pack_history(f.refs,f.read,restore_source_sha=SOURCE,now=moment)
    return boot.pack_inputs(admitted,{name:b'{}'for name in boot.gate.NATIVE},history,
        created_at=moment,expires_at=moment+timedelta(minutes=15))


class Journal:
    def __init__(self):self.actions={};self.results=[];self.bad=None
    def commit_intent(self,action,payload):
        digest=hashlib.sha256(m.encoded(payload)).hexdigest();new=action not in self.actions
        self.actions[action]=digest
        value={'effect':'CREATE_ONCE' if new else None,'intent_sha256':digest,'attempt_id':ATTEMPT,'fencing_generation':'2'}
        if self.bad:value[self.bad]='wrong'
        return value
    def record_result(self,action,result):self.results.append((action,result))


class NativeInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name).resolve();self.root=self.base/'source';self.root.mkdir()
        self.private=self.base/'private';self.private.mkdir(mode=0o700)
        self.admitted,self.native,_,_=native_fixture();self.report=self.native['report']
        self.journal=Journal();self.reports=[];self.now=[0.0]
        self.vm={'id':m.INSTANCE_ID,'name':m.INSTANCE,'status':'RUNNING',
            'zone':'https://www.googleapis.com/compute/v1/projects/'+m.PROJECT+'/zones/'+m.ZONE}
        self.controls={'deploy_paused':False,'github_actions_enabled':False}
        self.args=dict(client_sha256=m.digest(ROOT/'scripts/deploy-ci-client.py'),attempt_id=ATTEMPT,
            admission_reader=lambda:copy.deepcopy(self.admitted),identity_reader=lambda:m.ACCOUNT,
            instance_reader=lambda:copy.deepcopy(self.vm),main_reader=lambda:self.admitted['source_sha'],
            controls_reader=lambda:copy.deepcopy(self.controls),token_provider=lambda:'synthetic-ephemeral-token',
            journal=self.journal,report_sink=self.reports.append,clock=lambda:self.now[0])
        self.args['boot_inputs']=boot_fixture(self.admitted)
        (self.root/'release').mkdir(mode=0o700)
        self.adapter=self.new()
    def new(self,**changes):return m.NativeInstall(self.root,self.private,**(self.args|changes))
    def fake_main(self,*,native,environment):
        self.assertIs(native,self.adapter);self.assertEqual(environment['GCP_PROJECT_ID'],m.PROJECT)
        self.assertEqual(environment['COMMERCE_DEPLOY_SCOPE'],'copy-runtime')
        native.admission(self.root);native.before_start();native.record_report(self.report)
        return copy.deepcopy(self.report)

    def test_canonical_client_is_pinned_before_transport(self):
        with self.assertRaisesRegex(ReleaseError,'CLIENT_CHANGED'):self.new(client_sha256='0'*64)
    def test_missing_or_foreign_boot_input_cannot_consume_transport_intent(self):
        with self.assertRaisesRegex(RuntimeError,'BOOT_INPUT_WIRE'):self.new(boot_inputs=None).install_once()
        changed=copy.deepcopy(self.admitted);changed['archive_sha256']='0'*64
        with self.assertRaisesRegex(RuntimeError,'BOOT_INPUT_ADMISSION_CHANGED'):
            self.new(boot_inputs=boot_fixture(changed)).install_once()
        self.assertEqual(self.journal.actions,{})
    def test_boot_copy_requires_consumed_intent_and_exact_bytes_after_restart(self):
        self.adapter.authorized=True;self.adapter.admitted=copy.deepcopy(self.admitted)
        with self.assertRaisesRegex(RuntimeError,'BOOT_INPUT_INTENT_REQUIRED'):self.adapter.boot_input_file()
        self.adapter.intent('install-transport:'+self.admitted['installation_run_id'],self.adapter.payload())
        path=self.adapter.boot_input_file();self.assertEqual(path.read_bytes(),self.args['boot_inputs'])
        self.assertEqual(path.stat().st_mode & 0o777,0o600)
        path.write_bytes(b'foreign')
        with self.assertRaisesRegex(RuntimeError,'BOOT_INPUT_FILE_CHANGED'):self.adapter.boot_input_file()
        second=self.new();second.authorized=True;second.admitted=self.admitted
        second.intents['install-transport:'+self.admitted['installation_run_id']]='synthetic'
        with self.assertRaises(FileExistsError):second.boot_input_file()
    def test_boot_file_drift_after_root_intent_prevents_start(self):
        self.adapter.client.main=self.fake_main;commit=self.journal.commit_intent
        def altered(action,payload):
            result=commit(action,payload)
            if action.startswith('root-start:'):(self.root/'release/host-boot-inputs.json').write_bytes(b'changed')
            return result
        self.journal.commit_intent=altered
        with self.assertRaisesRegex(RuntimeError,'OUTCOME_UNKNOWN'):self.adapter.install_once()
        self.assertEqual(len(self.journal.actions),2);self.assertFalse(self.reports)
    def test_native_install_uses_two_distinct_durable_actions_and_no_publication(self):
        self.adapter.client.main=self.fake_main
        with patch.dict(os.environ,{'GH_TOKEN':'ambient-secret','GITHUB_SHA':'ambient-sha'}):
            before=dict(os.environ);result=self.adapter.install_once();self.assertEqual(dict(os.environ),before)
        self.assertEqual(result['status'],'ROOT_INSTALLATION_OBSERVED_PUBLICATION_PENDING')
        self.assertEqual(len(self.journal.actions),2);self.assertEqual(len(self.reports),1)
        self.assertTrue(all(r['status']=='RECONCILED' for _,r in self.journal.results))
    def test_workload_vm_and_controls_fail_before_intent_or_transport(self):
        for key,value in [('status','TERMINATED'),('id','different')]:
            old=self.vm[key];self.vm[key]=value
            with self.assertRaisesRegex(ReleaseError,'VM_IDENTITY'):self.new().install_once()
            self.vm[key]=old
        for key in self.controls:
            self.controls[key]=True
            with self.assertRaisesRegex(ReleaseError,'EXCLUSIONS'):self.new().install_once()
            self.controls[key]=False
        with self.assertRaisesRegex(ReleaseError,'WORKLOAD_IDENTITY'):
            self.new(identity_reader=lambda:'personal@example.invalid').install_once()
        self.assertEqual(self.journal.actions,{})
    def test_wrong_cas_binding_blocks_start(self):
        for key in ('intent_sha256','attempt_id','fencing_generation'):
            self.journal=Journal();self.journal.bad=key
            adapter=self.new(journal=self.journal);adapter.client.main=Mock(side_effect=AssertionError('transport'))
            with self.assertRaisesRegex(ReleaseError,'INTENT_NOT_NEW'):adapter.install_once()
            adapter.client.main.assert_not_called()
    def test_uncertain_start_never_reruns_transport(self):
        def lost(**kwargs):kwargs['native'].before_start();raise TimeoutError('synthetic lost SSH')
        self.adapter.client.main=Mock(side_effect=lost)
        with self.assertRaisesRegex(RuntimeError,'OUTCOME_UNKNOWN'):self.adapter.install_once()
        self.assertEqual(len(self.journal.actions),2)
        second=self.new();second.client.main=Mock(side_effect=AssertionError('replay'))
        with self.assertRaisesRegex(ReleaseError,'INTENT_NOT_NEW'):second.install_once()
        second.client.main.assert_not_called()
        self.assertTrue(all(r['status']=='UNKNOWN' for _,r in self.journal.results))
    def test_budget_or_admission_changes_during_transfer_prevent_root_start(self):
        self.adapter.client.main=lambda **kwargs:self.admitted.update(archive_sha256='0'*64) or kwargs['native'].before_start()
        with self.assertRaisesRegex(RuntimeError,'OUTCOME_UNKNOWN'):self.adapter.install_once()
        self.assertEqual(len(self.journal.actions),1)
    def test_new_pause_during_transfer_prevents_root_start(self):
        self.adapter.client.main=lambda **kwargs:self.controls.update(deploy_paused=True) or kwargs['native'].before_start()
        with self.assertRaisesRegex(RuntimeError,'OUTCOME_UNKNOWN'):self.adapter.install_once()
        self.assertEqual(len(self.journal.actions),1)
    def test_slow_root_cas_cannot_start_after_deadline_or_pause_change(self):
        for change in ('deadline','pause'):
            with self.subTest(change=change):
                (self.root/'release/host-boot-inputs.json').unlink(missing_ok=True)
                self.now[0]=0;self.controls['deploy_paused']=False;self.journal=Journal()
                self.adapter=self.new(journal=self.journal);starts=[];original=self.journal.commit_intent
                def commit(action,payload):
                    result=original(action,payload)
                    if action.startswith('root-start:'):
                        if change=='deadline':self.now[0]=811
                        else:self.controls['deploy_paused']=True
                    return result
                self.journal.commit_intent=commit
                def transport(**kwargs):kwargs['native'].before_start();starts.append(True);return self.report
                self.adapter.client.main=transport
                with self.assertRaisesRegex(RuntimeError,'OUTCOME_UNKNOWN'):self.adapter.install_once()
                self.assertEqual(starts,[]);self.assertEqual(len(self.journal.actions),2)
    def test_fifteen_minutes_includes_cleanup_reserve(self):
        self.assertEqual(self.adapter.remaining(),810)
        self.now[0]=810
        with self.assertRaisesRegex(ReleaseError,'DEADLINE'):self.adapter.remaining()
        self.adapter.begin_cleanup();self.assertEqual(self.adapter.remaining(),90)
        self.now[0]=900
        with self.assertRaisesRegex(ReleaseError,'DEADLINE'):self.adapter.remaining()
    def test_clean_environment_only_adds_google_token_for_google_process(self):
        with patch.dict(os.environ,{'GH_TOKEN':'ambient','SSH_AUTH_SOCK':'ambient','GOOGLE_APPLICATION_CREDENTIALS':'ambient'}):
            env=self.adapter.environment();google=self.adapter.environment(google=True)
        self.assertFalse(any(key in env for key in ('GH_TOKEN','SSH_AUTH_SOCK','GOOGLE_APPLICATION_CREDENTIALS','CLOUDSDK_AUTH_ACCESS_TOKEN')))
        self.assertEqual(google['CLOUDSDK_AUTH_ACCESS_TOKEN'],'synthetic-ephemeral-token')
        self.assertEqual(google['CLOUDSDK_CONFIG'],str(self.private/'gcloud'))
    def test_arbitrary_command_or_personal_account_never_spawns(self):
        with patch.object(m.subprocess,'Popen')as process:
            for argv in (['sh','-c','true'],['gcloud','compute','ssh',m.INSTANCE,'--account=personal@example.invalid'],
                         ['gcloud','compute','ssh','other'],['gcloud','compute','ssh',m.INSTANCE,'--project=other'],
                         ['gcloud','compute','os-login','ssh-keys','remove','--all'],['git','push']):
                with self.assertRaises(ReleaseError):self.adapter.run(argv)
        process.assert_not_called()
    def test_main_reader_uses_callback_without_github_cli_or_token_env(self):
        with patch.object(m.subprocess,'Popen')as process:
            result=self.adapter.run(['gh','api','repos/MarioB19/commerce-os-core/commits/main','--jq','.sha'],capture=True)
        self.assertEqual(result.stdout.strip(),self.admitted['source_sha']);process.assert_not_called()
    def test_native_wait_does_not_inherit_ninety_minute_loop(self):
        calls=[]
        def wait(ssh,path,unit,**kwargs):calls.append(kwargs);return self.report
        self.adapter.client.wait_for_report=wait
        self.assertEqual(self.adapter.wait_for_report(None,'/fixture','fixture'),self.report)
        self.assertEqual(calls,[{'attempts':1,'delay':0}])
    def test_bounded_subprocess_output_and_wall_time_kill_local_fixture(self):
        original=m.subprocess.Popen
        adapter=self.new(clock=time.monotonic)
        for code in ('import sys;sys.stdout.write("x"*1048577)','import time;time.sleep(5)'):
            def process(_argv,**kwargs):return original([sys.executable,'-c',code],**kwargs)
            adapter.remaining=lambda:.1
            with patch.object(m.subprocess,'Popen',side_effect=process):
                result=adapter.run(['git','rev-parse','HEAD'],check=False,capture=True)
            self.assertEqual(result.returncode,124);self.assertEqual(result.stdout,'')
    def test_sdk_token_stays_in_environment_and_oslogin_gets_fixed_project(self):
        original=m.subprocess.Popen;seen=[]
        def process(argv,**kwargs):
            seen.append((argv,kwargs['env']))
            return original([sys.executable,'-c','print("{}")'],**kwargs)
        with patch.object(m.subprocess,'Popen',side_effect=process):
            self.adapter.run(['gcloud','compute','os-login','describe-profile','--format=json'],capture=True)
        argv,env=seen[0]
        self.assertIn('--account='+m.ACCOUNT,argv);self.assertIn('--project='+m.PROJECT,argv)
        self.assertNotIn('synthetic-ephemeral-token',' '.join(argv))
        self.assertEqual(env['CLOUDSDK_AUTH_ACCESS_TOKEN'],'synthetic-ephemeral-token')
    def test_google_split_duplicate_extra_scope_and_scp_destination_rejected(self):
        self.adapter.admitted=self.admitted
        flags=['--project='+m.PROJECT,'--zone='+m.ZONE,'--account='+m.ACCOUNT,'--quiet',
               '--tunnel-through-iap','--ssh-key-file='+str(self.private/'key')]
        ssh=['gcloud','compute','ssh',m.INSTANCE,*flags,'--ssh-key-expire-after=30m','--command=true']
        self.assertEqual(self.adapter.google_command(ssh),ssh)
        invalid=[ssh+['--project','evil'],ssh+['--project='+m.PROJECT],ssh+['--flags-file=/tmp/evil'],
                 ['gcloud','compute','scp',*flags,'source',m.INSTANCE+':~/foreign/']]
        with patch.object(m.subprocess,'Popen')as execute:
            for argv in invalid:
                with self.assertRaises(ReleaseError):self.adapter.run(argv)
        execute.assert_not_called()
    def test_scp_requires_complete_fixed_boot_closure_in_order(self):
        self.adapter.admitted=self.admitted
        names=self.adapter.client.STAGING_SCRIPTS
        self.assertEqual(len(names),25);self.assertEqual(len(set(names)),25)
        self.assertTrue({'runtime_boot_install.py','runtime_boot_install_host.py','runtime_boot_install_gate.py',
            'runtime_boot_install_runner.py','runtime_boot_restore_gate.py','runtime-boot.py',
            'runtime_boot_host.py','runtime_boot_runner.py','runtime_boot_policy.py','b02_backup_contract.py',
            'cloudbuild_full_evidence.py','cloudbuild_release_evidence.py','cloudbuild-publish-status.py'}<=set(names))
        flags=['--project='+m.PROJECT,'--zone='+m.ZONE,'--account='+m.ACCOUNT,'--quiet',
               '--tunnel-through-iap','--ssh-key-file='+str(self.private/'key')]
        files=[str(self.root/'release/commerce-os.tar'),*[str(self.root/'scripts'/name)for name in names],str(self.root/'release/host-boot-inputs.json')]
        target=m.INSTANCE+':~/commerce-ci-'+self.admitted['installation_run_id']+'/'
        prefix=['gcloud','compute','scp',*flags]
        self.assertEqual(self.adapter.google_command(prefix+files+[target]),prefix+files+[target])
        for changed in (files[:-1],files+[files[-1]],files[:1]+list(reversed(files[1:])),
                        files[:-1]+[str(self.root/'scripts/foreign.py')]):
            with self.assertRaisesRegex(ReleaseError,'SCP_SCOPE'):self.adapter.google_command(prefix+changed+[target])
        for target2 in (target.replace('~/','/tmp/'),target+'nested/',target.replace(m.INSTANCE,'foreign')):
            with self.assertRaisesRegex(ReleaseError,'SCP_SCOPE'):self.adapter.google_command(prefix+files+[target2])

    def test_cleanup_names_exactly_the_staged_closure_and_optional_portal(self):
        unit='commerce-ci-'+self.admitted['installation_run_id']
        command=self.adapter.client.cleanup_staging_command(unit,unit)
        names=command.split('sudo rm -f ',1)[1].split(';',1)[0].split()
        self.assertEqual(names,[unit+'/'+name for name in
            ('commerce-os.tar',*self.adapter.client.STAGING_SCRIPTS,'host-boot-inputs.json','mcl-portal.env')])
        self.assertIn('[ "$pid" -eq 0 ]',command);self.assertNotIn('rm -rf',command)
    def test_reconcile_only_reads_existing_unit_and_removes_own_ephemeral_key(self):
        commands=[]
        def run(argv,**kwargs):
            commands.append(argv)
            if argv[0]=='ssh-keygen':
                Path(argv[-1]).write_text('synthetic-private');Path(argv[-1]+'.pub').write_text('ssh-ed25519 c3ludGhldGlj fixture')
            return subprocess.CompletedProcess(argv,0,'','')
        self.adapter.run=run;self.adapter.wait_for_report=lambda *_:copy.deepcopy(self.report)
        with patch.object(m,'remove_ephemeral_key',return_value={'key_absent_verified':True})as cleanup:
            result=self.adapter.reconcile()
        self.assertEqual(result['status'],'ROOT_INSTALLATION_RECONCILED_PUBLICATION_PENDING')
        self.assertEqual(self.journal.actions,{})
        self.assertFalse(any('scp'in argv or any('systemd-run'in v for v in argv)for argv in commands))
        self.assertEqual(sum(any('sudo rm -f commerce-ci-'in v for v in argv)for argv in commands),1)
        cleanup.assert_called_once();self.assertEqual(list(self.private.iterdir()),[])

    def test_reconcile_preserves_staging_when_terminal_state_is_unknown(self):
        commands=[]
        def run(argv,**kwargs):
            commands.append(argv)
            if argv[0]=='ssh-keygen':
                Path(argv[-1]).write_text('synthetic-private');Path(argv[-1]+'.pub').write_text('ssh-ed25519 c3ludGhldGlj fixture')
            return subprocess.CompletedProcess(argv,0,'','')
        self.adapter.run=run
        self.adapter.wait_for_report=Mock(side_effect=RuntimeError('NATIVE_PUBLISHER_DEADLINE_RECONCILE_ONLY'))
        with patch.object(m,'remove_ephemeral_key',return_value={'key_absent_verified':True})as cleanup:
            with self.assertRaisesRegex(RuntimeError,'DEADLINE'):self.adapter.reconcile()
        self.assertFalse(any(any('sudo rm -f'in v for v in argv)for argv in commands))
        cleanup.assert_called_once();self.assertEqual(list(self.private.iterdir()),[])


class CanonicalSeamTests(unittest.TestCase):
    setUp=NativeInstallTests.setUp
    new=NativeInstallTests.new
    def test_cleanup_exception_still_revokes_key_and_removes_local_material(self):
        client=self.adapter.client
        release=self.root/'release';archive=release/'commerce-os.tar';archive.write_bytes(b'fixture')
        archive_hash=m.digest(archive);(release/'commerce-os.tar.sha256').write_text(archive_hash)
        self.admitted['archive_sha256']=archive_hash
        self.report['archive_sha256']=archive_hash
        self.adapter.boot_inputs=boot_fixture(self.admitted)
        self.adapter.boot_input_sha256=hashlib.sha256(self.adapter.boot_inputs).hexdigest()
        source=self.root/'scripts';source.mkdir()
        for name in client.STAGING_SCRIPTS:
            (source/name).write_text('synthetic fixture\n')
        self.adapter.authorized=True;self.adapter.admitted=copy.deepcopy(self.admitted)
        self.adapter.intents['install-transport:'+self.admitted['installation_run_id']]='synthetic'
        calls=[]
        def executor(argv,check=True,capture=False):
            if argv[:2]==['gcloud','compute']:self.adapter.google_command(argv)
            calls.append(argv);out='';code=0
            if argv==['git','rev-parse','HEAD']:out=self.admitted['source_sha']
            if argv[0]=='ssh-keygen':
                Path(argv[-1]).write_text('synthetic-private');Path(argv[-1]+'.pub').write_text('ssh-ed25519 c3ludGhldGlj fixture')
            if argv[0]=='gh':out=self.admitted['source_sha']
            command=next((v[10:]for v in argv if v.startswith('--command=')),'')
            if command.startswith('attempt=0;'):raise RuntimeError('synthetic cleanup transport failure')
            if command.startswith('sudo systemctl show'):out='LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n'
            if command.startswith('sudo test -s'):code=1
            return subprocess.CompletedProcess(argv,code,out,'')
        self.adapter.run=executor;self.adapter.wait_for_report=lambda *_:copy.deepcopy(self.report)
        env={'COMMERCE_DEPLOY_PAUSED':'false','COMMERCE_DEPLOY_SCOPE':'copy-runtime','GCP_PROJECT_ID':m.PROJECT,
             'GCP_INSTANCE':m.INSTANCE,'GCP_ZONE':m.ZONE,'RUNNER_TEMP':str(self.private)}
        with patch.object(client,'remove_ephemeral_key')as cleanup:
            with self.assertRaisesRegex(RuntimeError,'cleanup transport failure'):client.main(native=self.adapter,environment=env)
        cleanup.assert_called_once();self.assertFalse(list(self.private.glob('commerce-ci-*')))
        self.assertEqual(sum(any('systemd-run'in v for v in argv)for argv in calls),1)
        start=next(v for argv in calls for v in argv if v.startswith('--command=') and 'systemd-run'in v)
        self.assertIn('copy-runtime '+self.adapter.boot_input_sha256,start)
        self.assertIn('host-boot-inputs.json',start)
        self.assertTrue(all('--account='+m.ACCOUNT in argv for argv in calls if argv[:2]==['gcloud','compute']))
        self.assertFalse((release/'deployment.json').exists())


if __name__=='__main__':unittest.main()
