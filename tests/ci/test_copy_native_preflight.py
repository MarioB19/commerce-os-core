"""Synthetic transport/collector boundaries; no actual Cloud, Docker or Root attestation."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result
ci = module('native_ci', ROOT / 'scripts/copy-native-preflight-ci.py')
native = module('native_root', ROOT / 'scripts/copy_native_preflight_root.py')
SHA = 'a' * 40
CID = 'b' * 64
SECRET = 'synthetic-private-value-never-published'
ENV = {'GITHUB_EVENT_NAME': 'workflow_dispatch', 'COPY_PREFLIGHT_MODE': 'copy-preflight',
       'GITHUB_REPOSITORY': ci.REPOSITORY, 'GITHUB_REF': 'refs/heads/main',
       'GITHUB_WORKFLOW_REF': ci.REPOSITORY + '/.github/workflows/ci.yml@refs/heads/main',
       'COPY_PREFLIGHT_EXPECTED_SHA': SHA, 'GITHUB_SHA': SHA, 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1',
       'GCP_PROJECT_ID': ci.TARGET[0], 'GCP_INSTANCE': ci.TARGET[1], 'GCP_ZONE': ci.TARGET[2], 'GCP_WORKLOAD_IDENTITY_PROVIDER': ci.PROVIDER, 'GCP_DEPLOY_SERVICE_ACCOUNT': ci.SERVICE_ACCOUNT}


def vm(oslogin='TRUE'):
    return {'id': ci.VM_ID, 'name': ci.TARGET[1], 'zone': 'https://www.googleapis.com/compute/v1/projects/' + ci.TARGET[0] + '/zones/' + ci.TARGET[2],
            'status': 'RUNNING', 'machineType': 'zones/us-east1-d/machineTypes/e2-standard-4',
            'metadata': {'items': [{'key': 'enable-oslogin', 'value': oslogin}, {'key': 'startup-script', 'value': SECRET}]}}


def report():
    result = {'schema_version': 1, 'status': 'OBSERVED_PARTIAL', 'observed_at': '2026-10-08T09:00:00+00:00',
              'business_mutations': 0, 'configuration_mutations': 0, 'backup_executed': False, 'installed': False,
              'readiness_proven': False, 'snapshot_atomic': False,
              'current_release': {'status': 'OBSERVED', 'source_sha': 'd9618bc92d1aba0a5af5de92149a325cf8dea69f', 'release_sha256': '1' * 64, 'metadata_sha256': '2' * 64},
              'files': {}, 'disk': {'status': 'OBSERVED', 'available_bytes': 4096}}
    for key in ('deployment_journals', 'backup_journals', 'controller_journals', 'containers', 'networks', 'volumes'):
        result[key] = {'status': 'UNKNOWN', 'reason': 'MISSING'}
    return result


class NativePreflight(unittest.TestCase):
    def test_manual_main_target_and_exact_sha_rejected_before_any_commands(self):
        self.assertEqual(ci.config(ENV), {'sha': SHA, 'run_id': '123-1'})
        for key, value in [('GITHUB_REF', 'refs/heads/other'), ('GITHUB_EVENT_NAME', 'schedule'), ('COPY_PREFLIGHT_MODE', 'backup'),
                           ('GITHUB_REPOSITORY', 'other/repo'), ('GCP_PROJECT_ID', 'vibe-conversa-prod'), ('GCP_ZONE', 'us-east1-b'), ('GCP_WORKLOAD_IDENTITY_PROVIDER', 'other/provider'), ('GCP_DEPLOY_SERVICE_ACCOUNT', 'other@invalid'),
                           ('GITHUB_SHA', 'c'*40), ('COPY_PREFLIGHT_EXPECTED_SHA', '$(command)'), ('COPY_PREFLIGHT_INPUT_JSON', '{}'),
                           ('COPY_PREFLIGHT_RETURN_PUBLIC_KEY', 'public'), ('COPY_PREFLIGHT_ACTION', 'issue')]:
            with self.subTest(key=key), patch.object(ci, 'command') as command:
                with self.assertRaises(RuntimeError): ci.config(dict(ENV, **{key: value}))
                command.assert_not_called()

    def test_vm_identity_and_installed_sha_are_separate_from_diagnostic_sha(self):
        self.assertEqual(ci.vm_report(json.dumps(vm()))['zone'], 'us-east1-d')
        for key, value in [('id', '123'), ('name', 'other'), ('zone', 'us-east1-b')]:
            with self.assertRaises(RuntimeError): ci.vm_report(json.dumps(dict(vm(), **{key: value})))
        observed = ci.public_report(report())
        self.assertNotEqual(observed['current_release']['source_sha'], SHA)
        self.assertNotIn(SECRET, json.dumps(ci.vm_report(json.dumps(vm()))))

    def test_second_output_allowlist_rejects_secret_unknown_keys_and_fake_success(self):
        for mutate in [lambda r: r.update(extra=SECRET), lambda r: r['disk'].update(reason=SECRET),
                       lambda r: r.update(readiness_proven=True), lambda r: r.update(status='SUCCEEDED'),
                       lambda r: r.update(business_mutations=True), lambda r: r['current_release'].update(source_sha=SECRET),
                       lambda r: r['files'].update(**{'unknown.env': {'status': 'OBSERVED'}})]:
            value=report(); mutate(value)
            with self.assertRaises(RuntimeError): ci.public_report(value)
        with self.assertRaises(RuntimeError): ci.parse('{"status":"a","status":"b"}')
        with self.assertRaises(RuntimeError): ci.parse('{"x":NaN}')

    def execute_fixture(self, directory, oslogin='TRUE', remote_fail=False, cleanup_fail=False):
        calls=[]
        def success(args, **kwargs):
            calls.append(args)
            if args[:3]==['gcloud','auth','list']: return ci.SERVICE_ACCOUNT
            if args[0]=='gcloud': return json.dumps(vm(oslogin))
            if args[0]=='ssh-keygen':
                key=Path(args[-1]);key.write_text('synthetic-local-private-key');key.chmod(0o600)
                key.with_suffix('.pub').write_text('ssh-ed25519 c3ludGhldGlj fixture')
            return SHA
        def command(args, **kwargs):
            calls.append((args, kwargs))
            return subprocess.CompletedProcess(args, 1 if remote_fail else 0, SECRET if remote_fail else json.dumps(report()), '')
        with patch.dict(os.environ, {'RUNNER_TEMP': str(directory)}), patch.object(ci, 'verify_main') as verify, patch.object(ci, 'payload', return_value=b'# exact public payload\n'), patch.object(ci, 'success', side_effect=success), patch.object(ci, 'command', side_effect=command), patch.object(ci, 'remove_ephemeral_key', side_effect=RuntimeError('PREFLIGHT_KEY_CLEANUP_REQUIRED') if cleanup_fail else None, return_value={'key_absent_verified': True}) as remove:
            if remote_fail or cleanup_fail or oslogin!='TRUE':
                with self.assertRaises(RuntimeError): ci.execute({'sha': SHA, 'run_id': '123-1'})
            else:
                result = ci.execute({'sha': SHA, 'run_id': '123-1'})
                self.assertEqual(result['source_sha'], SHA)
                self.assertFalse(result['readiness_proven'])
                self.assertTrue(result['ephemeral_key_absent_verified'])
                self.assertNotIn(SECRET, json.dumps(result))
            self.assertEqual(remove.call_count, 0 if oslogin!='TRUE' else 1)
            self.assertEqual(list(Path(directory).iterdir()), [])
            return calls, verify.call_count

    def test_transport_fixed_stdin_no_scp_no_secret_and_canonical_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            calls,checks=self.execute_fixture(temporary)
        remote=[entry for entry in calls if type(entry) is tuple][0]
        args,kwargs=remote
        self.assertIn('--command='+ci.REMOTE,args);self.assertIn('--ssh-key-expire-after=15m',args)
        self.assertEqual(kwargs['input'],b'# exact public payload\n');self.assertEqual(kwargs['timeout'],180)
        self.assertEqual(checks,4)
        self.assertTrue(all('scp' not in str(entry) and 'systemd-run' not in str(entry) for entry in calls))

    def test_unknown_remote_and_cleanup_fail_closed(self):
        for remote,cleanup in [(True,False),(False,True)]:
            with tempfile.TemporaryDirectory() as temporary:
                self.execute_fixture(temporary,remote_fail=remote,cleanup_fail=cleanup)

    def test_disabled_oslogin_cannot_fallback_to_instance_metadata_writes(self):
        with tempfile.TemporaryDirectory() as temporary:
            calls,_=self.execute_fixture(temporary,oslogin='FALSE')
        self.assertFalse(any('ssh-keygen' in entry for entry in calls))
        self.assertFalse(any(type(entry) is tuple for entry in calls))

    def test_native_container_private_values_and_unknown_names_are_only_hashes(self):
        row={'Id':CID,'Image':'sha256:'+'c'*64,'Name':SECRET,'Config':{'Env':['API_KEY='+SECRET], 'Labels':{'com.docker.compose.service':SECRET}},
             'HostConfig':{'PortBindings':{'443/tcp':[{'HostIp':'0.0.0.0','HostPort':'443'}]}},'State':{'Running':False,'Pid':0}}
        with patch.object(native,'docker',side_effect=[(CID+'\n').encode(),json.dumps([row]).encode(),(CID+'\n').encode()]):
            values,_=native.containers()
        output=json.dumps(values)
        self.assertNotIn(SECRET,output);self.assertIsNone(values[0]['service'])
        self.assertFalse(values[0]['running']);self.assertEqual(values[0]['pid'],0)
        with patch.object(native,'docker',return_value=b'--host=evil\n'):
            with self.assertRaises(RuntimeError): native.containers()

    def test_native_network_volume_strings_do_not_cross_output(self):
        row={'Id':CID,'Name':SECRET,'Driver':'bridge','Internal':True,'IPAM':{'Config':[{'Subnet':'172.30.80.0/24','Gateway':'172.30.80.1'}]},'Containers':{},'Options':{'secret':SECRET},'Labels':{'secret':SECRET}}
        with patch.object(native,'docker',side_effect=[(CID+'\n').encode(),json.dumps([row]).encode()]):
            result=native.networks()
        self.assertNotIn(SECRET,json.dumps(result));self.assertEqual(result[0]['ipam'][0]['subnet'],'172.30.80.0/24')
        with patch.object(native,'docker',side_effect=[b'owned-volume\n',json.dumps([{'Name':'owned-volume','Driver':'local','Options':{'password':SECRET}}]).encode()]):
            self.assertNotIn(SECRET,json.dumps(native.volumes()))

    def test_collector_missing_fields_partial_and_never_readiness(self):
        with patch.object(native,'current_release',return_value={'status':'UNKNOWN','reason':'MISSING'}), patch.object(native,'file_observation',return_value={'status':'UNKNOWN','reason':'MISSING'}), patch.object(native,'journals',return_value={'status':'UNKNOWN','reason':'MISSING'}), patch.object(native,'observed',return_value={'status':'UNKNOWN','reason':'COMMAND'}), patch.object(native,'directory',side_effect=RuntimeError('CUSTODY')):
            value=native.collect()
        self.assertEqual(value['status'],'OBSERVED_PARTIAL');self.assertFalse(value['readiness_proven'])
        ci.public_report(value)

    def test_reader_rejects_symlink_fifo_nonroot_or_writable_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);good=root/'data';good.write_text('synthetic');good.chmod(0o620)
            link=root/'link';link.symlink_to(good)
            with patch.object(native,'directory'):
                for path in [good,link]:
                    with self.assertRaises((RuntimeError,OSError)): native.protected(path)
                if hasattr(os,'mkfifo'):
                    fifo=root/'fifo';os.mkfifo(fifo)
                    with self.assertRaises(RuntimeError): native.protected(fifo)

    def test_reader_actual_hash_and_post_read_identity_recheck(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'data';path.write_bytes(b'synthetic-root-config');path.chmod(0o600)
            original_fstat=os.fstat;original_lstat=Path.lstat
            def owner(info, drift=False):
                values={name:getattr(info,name) for name in dir(info) if name.startswith('st_')}
                values['st_uid']=0
                if drift: values['st_mtime_ns']+=1
                return types.SimpleNamespace(**values)
            with patch.object(native,'directory'), patch.object(native.os,'fstat',side_effect=lambda fd:owner(original_fstat(fd))), patch.object(native.Path,'lstat',side_effect=lambda:owner(original_lstat(path))):
                raw,observed=native.protected(path)
                self.assertEqual(raw,b'synthetic-root-config');self.assertEqual(observed['sha256'],native.sha(raw))
            count=[0]
            def changed(fd):
                count[0]+=1
                return owner(original_fstat(fd),count[0]>1)
            with patch.object(native,'directory'), patch.object(native.os,'fstat',side_effect=changed), patch.object(native.Path,'lstat',side_effect=lambda:owner(original_lstat(path))):
                with self.assertRaisesRegex(RuntimeError,'DRIFT'): native.protected(path)

    def test_workflow_delta_changes_only_new_mode_and_its_explicit_exclusions(self):
        text=(ROOT/'.github/workflows/ci.yml').read_text()
        self.assertEqual(text.count('google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093'),4)
        block=text.split('\n  copy-preflight:\n')[1]
        self.assertIn('GCP_WORKLOAD_IDENTITY_PROVIDER: ${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}',block)
        self.assertIn('GCP_DEPLOY_SERVICE_ACCOUNT: ${{ vars.GCP_DEPLOY_SERVICE_ACCOUNT }}',block)
        self.assertIn('cancel-in-progress: false',block)

    def test_command_deadlines_and_output_bounds_are_actual_child_processes(self):
        with patch.object(ci,'ROOT',Path(tempfile.gettempdir())):
            result=ci.command([sys.executable,'-c','import sys; data=sys.stdin.buffer.read(); print(len(data))'],input=b'x'*40000,timeout=2)
            self.assertEqual(result.returncode,0);self.assertEqual(result.stdout.strip(),'40000')
            with self.assertRaises(RuntimeError): ci.command([sys.executable,'-c','import time; time.sleep(3)'],timeout=0.05)
            with patch.object(ci,'MAX_BYTES',32):
                with self.assertRaises(RuntimeError): ci.command([sys.executable,'-c','print("x"*100)'],timeout=2)

    def test_workflow_excludes_other_jobs_and_has_no_second_backup_schedule(self):
        text=(ROOT/'.github/workflows/ci.yml').read_text()
        self.assertEqual(text.count('fromJSON(\'["credential","backup","copy-preflight"]\')'),2)
        self.assertIn('group: commerce-os-production',text);self.assertIn('options: [verify, release, credential, backup, copy-preflight]',text)
        block=text.split('\n  copy-preflight:\n')[1]
        self.assertIn("github.ref == 'refs/heads/main'",block);self.assertIn("github.repository == 'MarioB19/commerce-os'",block)
        self.assertLess(block.index('--preflight'),block.index('google-github-actions/auth@'))
        self.assertNotIn('contents: write',block);self.assertNotIn('scp',block)
        self.assertNotIn('  schedule:',text);self.assertNotIn('- cron:',text)

if __name__=='__main__': unittest.main()
