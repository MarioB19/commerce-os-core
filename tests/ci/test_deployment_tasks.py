"""Recovery boundaries exercised with real local process trees and inert Docker."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
spec=importlib.util.spec_from_file_location('deployment_tasks',ROOT/'scripts/deploy-ci-vps.py')
deploy=importlib.util.module_from_spec(spec);spec.loader.exec_module(deploy)
spec=importlib.util.spec_from_file_location('task_ownership',ROOT/'scripts/ownership-isolation-receipts.py')
ownership=importlib.util.module_from_spec(spec);spec.loader.exec_module(ownership)
ATTEMPT='deploy-'+'a'*32

class DeploymentTaskTests(unittest.TestCase):
    def test_failed_preparation_never_invokes_runtime_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);private=base/'private';previous=base/'releases'/'previous'
            private.mkdir();previous.mkdir(parents=True);(base/'current').symlink_to(previous)
            (previous/'RELEASE.json').write_text(json.dumps({'source_sha':'a'*40}))
            original='COMMERCE_IMAGE=sha256:'+'a'*64+'\n';(private/'release.env').write_text(original)
            (private/'api.env').write_text('COMMERCE_DEPLOYMENT_STATUS=DEPLOYED\n')
            (private/'admin.env').write_text('BOOTSTRAP_EMAIL=fixture@example.invalid\n')
            archive=base/'release.tar';archive.write_bytes(b'fixture')
            def extract(_archive,root,_hash):
                root.mkdir();(root/'RELEASE.json').write_text(json.dumps({'source_sha':'b'*40,'run_id':'101','migration_hashes':{}}))
            with patch.object(deploy,'BASE',base),patch.object(deploy,'PRIVATE',private),patch.object(deploy.os,'geteuid',return_value=0),patch.object(sys,'argv',['deploy',str(archive),'hash','b'*40,'101-1','@server-current']),patch.object(deploy.signal,'signal'),patch.object(deploy.shutil,'disk_usage',return_value=SimpleNamespace(free=10*1024**3)),patch.object(deploy,'extract_release',side_effect=extract),patch.object(deploy,'raw_policy_snapshot',return_value={}),patch.object(deploy,'migrations',return_value={}),patch.object(deploy,'preserved_containers',return_value=[]),patch.object(deploy,'gateway_inventory',return_value=[]),patch.object(deploy,'run_install_phase',side_effect=deploy.ReleaseError('PREPARATION_FAILED')) as install,patch.object(deploy,'recover_failed_install') as rollback:
                with self.assertRaisesRegex(deploy.ReleaseError,'PREPARATION_FAILED'):deploy.main()
            self.assertEqual(install.call_count,1);self.assertEqual(install.call_args.args[-1],'prepare');rollback.assert_not_called()
            self.assertEqual((private/'release.env').read_text(),original)
            self.assertEqual((base/'current').resolve(),previous.resolve())
            self.assertEqual(json.loads((private/'deployments/101-1/report.json').read_text())['stage'],'prepare')

    def test_real_installer_preparation_failure_preserves_config_and_services(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);scripts=root/'scripts';binary=root/'bin';private=root/'private'
            for path in (scripts,binary,private):path.mkdir()
            source=(ROOT/'scripts/install-vps.sh').read_text().replace('/opt/commerce-os',str(root))
            (scripts/'install-vps.sh').write_text(source)
            (scripts/'compose-release.sh').write_text('#!/bin/sh\n[ "$2" = config ] || exit 99\n')
            (scripts/'maintenance.sh').write_text('#!/bin/sh\nexit 78\n')
            for name,output in [('id','0'),('uname','x86_64'),('sha256sum',''),('flock','')]:
                path=binary/name;path.write_text('#!/bin/sh\nprintf "%s\\n" "'+output+'"\n');path.chmod(0o755)
            docker=binary/'docker';docker.write_text("#!/usr/bin/env python3\nimport sys\na=sys.argv[1:]\nif a[:2]==['image','inspect']:print('linux/amd64' if '{{.Os}}/{{.Architecture}}' in a else 'sha256:'+'a'*64)\n");docker.chmod(0o755)
            for name in ('images.tar.gz','images.sha256','PACKAGE.sha256'):(root/name).write_text('fixture')
            original='COMMERCE_MAINTENANCE_IMAGE=sha256:'+'b'*64+'\n'
            (private/'release.env').write_text(original);(private/'api.env').write_text('UNCHANGED=yes\n')
            result=subprocess.run(['sh',str(scripts/'install-vps.sh'),'fixture@example.invalid'],cwd=root,env={**os.environ,'PATH':str(binary)+os.pathsep+os.environ['PATH'],'COMMERCE_INSTALL_PHASE':'prepare'},capture_output=True,text=True)
            self.assertEqual(result.returncode,78,result.stderr)
            self.assertEqual((private/'release.env').read_text(),original)
            self.assertEqual((private/'api.env').read_text(),'UNCHANGED=yes\n')
            self.assertFalse(list(private.glob('predeploy-backup.*.env')))

    def test_timeout_kills_grandchild_even_if_it_ignores_term(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);marker=root/'orphan-wrote';pid=root/'child-pid'
            # Avoid timing two Python cold starts inside the .3s kill boundary.
            # The real shell grandchild still ignores TERM and would write late.
            child=root/'grandchild.sh'
            child.write_text("trap '' TERM\nprintf '%s' \"$$\" > child-pid\nsleep .6\nprintf orphan > orphan-wrote\n")
            with self.assertRaises(subprocess.TimeoutExpired):
                deploy.run_bounded_process(['/bin/sh','-c','/bin/sh grandchild.sh & wait'],cwd=root,log_path=root/'log',timeout=.3)
            self.assertTrue(pid.exists());time.sleep(.5)
            self.assertFalse(marker.exists())
            self.assertEqual((root/'log').stat().st_mode&0o777,0o600)

    def test_real_rollback_attests_fresh_candidate_and_original_owner_before_release(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);scripts=root/'scripts';binary=root/'bin';private=root/'private';state=root/'state';assets=root/'assets'
            for path in (scripts,binary,private,state,assets):path.mkdir()
            events=root/'events.jsonl';original=state/'ownership-before.json';original.write_text('{"owner":"old generation"}')
            (scripts/'release.sh').write_text((ROOT/'scripts/release.sh').read_text())
            event_code="import os,json,sys\nfrom pathlib import Path\na=sys.argv[1:]\nwith open(os.environ['FIXTURE_EVENTS'],'a') as f:f.write(json.dumps(a)+'\\n')\n"
            (scripts/'ownership-isolation-receipts.py').write_text(event_code+"if a[0]=='supports-recovery':print('1')\nif a[0]=='capture':Path(a[2]).write_text('{\"owner\":\"candidate generation\"}')\nif a[0]=='attest':assert Path(a[2]).is_file()\n")
            (scripts/'compose-release.sh').write_text('#!/bin/sh\nexec python3 scripts/fixture-compose.py "$@"\n')
            (scripts/'fixture-compose.py').write_text(event_code)
            docker=binary/'docker';docker.write_text('#!'+sys.executable+'\n'+event_code+"if a[:2]==['image','inspect'] and '--format' in a:print('amd64' if '{{.Architecture}}' in a else 'linux')\n");docker.chmod(0o755)
            for name in ('api','ingress','automation','channel','postgres','admin'):(private/(name+'.env')).write_text('FIXTURE=yes\n')
            release=root/'release.env';release.write_text('COMMERCE_IMAGE=sha256:'+'a'*64+'\nCOMMERCE_WEB_IMAGE=sha256:'+'b'*64+'\nCOMMERCE_SECRETS_DIR='+str(private)+'\nCOMMERCE_PRIVATE_ASSETS_DIR='+str(assets)+'\nCOMMERCE_PROXY_NETWORK=fixture\nCOMMERCE_ORIGIN=https://fixture.invalid\n')
            result=subprocess.run(['sh','scripts/release.sh','rollback',str(release)],cwd=root,env={**os.environ,'PATH':str(binary)+os.pathsep+os.environ['PATH'],'FIXTURE_EVENTS':str(events),'COMMERCE_DEPLOYMENT_ATTEMPT':ATTEMPT,'COMMERCE_DEPLOYMENT_STATE_DIR':str(state)},capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            calls=[json.loads(line) for line in events.read_text().splitlines()]
            capture=next(c for c in calls if c[0]=='capture');attests=[c for c in calls if c[0]=='attest']
            self.assertEqual([c[2] for c in attests],[capture[2],str(original)])
            self.assertEqual(original.read_text(),'{"owner":"old generation"}')
            self.assertLess(calls.index(capture),next(i for i,c in enumerate(calls) if len(c)>1 and c[1]=='stop'))
            self.assertLess(next(i for i,c in enumerate(calls) if len(c)>1 and c[1]=='up'),calls.index(attests[0]))
            self.assertLess(calls.index(attests[-1]),next(i for i,c in enumerate(calls) if c[0]=='release'))
            for call in (c for c in calls if c[0]=='run'):
                self.assertIn('com.commerce-os.deployment-attempt='+ATTEMPT,call);self.assertIn('PGAPPNAME='+ATTEMPT,call)

    def test_task_journal_precedes_process_and_preserves_both_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            def process(*args,**kwargs):
                journal=json.loads((root/'task-activate.json').read_text())
                self.assertEqual(journal['status'],'RUNNING')
                self.assertEqual(kwargs['env']['PGAPPNAME'],journal['attempt'])
                self.assertEqual(kwargs['env']['COMMERCE_DEPLOYMENT_STATE_DIR'],str(root))
                raise subprocess.TimeoutExpired(['fixture'],1)
            with patch.object(deploy,'run_bounded_process',side_effect=process),patch.object(deploy,'cleanup_deployment_attempt',side_effect=deploy.ReleaseError('DEPLOYMENT_DATABASE_TASK_STILL_ACTIVE')):
                with self.assertRaises(deploy.DeploymentCleanupError) as raised:deploy.run_install_phase(root,root,'fixture@example.invalid','activate')
            journal=json.loads((root/'task-activate.json').read_text())
            self.assertEqual(journal['phase_error'],'TimeoutExpired')
            self.assertEqual(journal['cleanup_error'],'DEPLOYMENT_DATABASE_TASK_STILL_ACTIVE')
            self.assertEqual(journal['status'],'CLEANUP_FAILED')
            self.assertEqual(raised.exception.phase_error,'TimeoutExpired')

    def cleanup_runner(self, *, vanish=False, live=False):
        calls=[];inventory=[['b'*64],[],[],[]] if vanish else [['b'*64],['b'*64],[]]
        def run(args,**kwargs):
            calls.append((args,kwargs.get('input')))
            if args[:3]==['docker','ps','-aq']:
                self.assertEqual(args[-1],'label='+deploy.ATTEMPT_LABEL+'='+ATTEMPT)
                return SimpleNamespace(returncode=0,stdout='\n'.join(inventory.pop(0)),stderr='')
            if args[:2]==['docker','stop']:return SimpleNamespace(returncode=1 if vanish else 0,stdout='',stderr='')
            if args[:2]==['docker','rm']:return SimpleNamespace(returncode=0,stdout='',stderr='')
            sql=kwargs['input'];self.assertIn("application_name='"+ATTEMPT+"'",sql)
            if 'json_agg' in sql:output=json.dumps([{'pid':123,'state':'active','transaction_open':True}])
            elif 'pg_terminate_backend' in sql:output='1'
            else:output='1' if live else '0'
            return SimpleNamespace(returncode=0,stdout=output,stderr='')
        return run,calls

    def test_cleanup_scopes_containers_and_database_to_exact_attempt(self):
        runner,calls=self.cleanup_runner()
        result=deploy.cleanup_deployment_attempt(ROOT,'fixture.env',ATTEMPT,runner,wait_seconds=0)
        self.assertEqual(result['database_sessions_remaining'],0)
        self.assertEqual(result['database_sessions_observed'][0]['pid'],123)
        self.assertTrue(any(sql and 'pg_terminate_backend' in sql for _,sql in calls))
        self.assertFalse(any('LIKE' in (sql or '') for _,sql in calls))
        self.assertLess(next(i for i,(_,sql) in enumerate(calls) if sql and 'json_agg' in sql),next(i for i,(args,_) in enumerate(calls) if args[:2]==['docker','stop']))

    def test_cleanup_observation_is_recorded_before_stopping_anything(self):
        runner,calls=self.cleanup_runner()
        def observe(value):
            self.assertEqual(value['database_sessions'][0]['pid'],123)
            self.assertFalse(any(args[:2]==['docker','stop'] for args,_ in calls))
            raise OSError('inert journal write failure')
        with self.assertRaises(OSError):deploy.cleanup_deployment_attempt(ROOT,'fixture.env',ATTEMPT,runner,record_observation=observe)
        self.assertFalse(any(args[:2]==['docker','stop'] for args,_ in calls))

    def test_successful_reinventory_resolves_rm_race_at_stop(self):
        runner,_=self.cleanup_runner(vanish=True)
        self.assertEqual(deploy.cleanup_deployment_attempt(ROOT,'fixture.env',ATTEMPT,runner,wait_seconds=0)['database_sessions_remaining'],0)

    def test_cleanup_refuses_rollback_while_database_task_remains(self):
        runner,_=self.cleanup_runner(live=True)
        with self.assertRaisesRegex(deploy.ReleaseError,'DEPLOYMENT_DATABASE_TASK_STILL_ACTIVE'):
            deploy.cleanup_deployment_attempt(ROOT,'fixture.env',ATTEMPT,runner,wait_seconds=0)

    def test_only_deployment_status_is_restored_and_missing_field_stays_missing(self):
        for original in ('COMMERCE_DEPLOYMENT_STATUS=DEPLOYED\n',''):
            with self.subTest(present=bool(original)),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);api=root/'api.env';api.write_text('OTHER=before\n'+original)
                with patch.object(deploy,'PRIVATE',root):
                    deploy.snapshot_api_deployment_status(root)
                    api.write_text('OTHER=changed-during-install\nCOMMERCE_DEPLOYMENT_STATUS=DEPLOYING\n')
                    deploy.restore_api_deployment_status(root)
                self.assertEqual(api.read_text(),'OTHER=changed-during-install\n'+original)
                self.assertEqual(api.stat().st_mode&0o777,0o600)

    def test_psql_daemon_child_receives_attempt_application_name(self):
        with patch.dict(os.environ,{'COMMERCE_DEPLOYMENT_ATTEMPT':ATTEMPT}),patch.object(ownership,'compose',return_value='0') as compose:
            ownership.database('fixture.env','SELECT 1')
        self.assertEqual(compose.call_args.args[:6],('fixture.env','exec','-T','--env','PGAPPNAME='+ATTEMPT,'postgres'))

    def test_stopped_api_uses_actual_image_and_only_recovery_reuses_hold(self):
        with tempfile.TemporaryDirectory() as directory:
            release=Path(directory)/'release.env';release.write_text('COMMERCE_IMAGE=sha256:'+'c'*64+'\n')
            def docker(args,**kwargs):return 'sha256:'+'b'*64 if args[1]=='inspect' else '1'
            with patch.object(ownership,'compose',return_value='d'*64) as compose,patch.object(ownership,'run',side_effect=docker),patch.object(ownership,'database',return_value='t'):
                self.assertTrue(ownership.supports_hold(release,True));self.assertEqual(compose.call_args.args, (release,'ps','-aq','api'))
            sql=[]
            with patch.object(ownership,'supports_hold',return_value=True),patch.object(ownership,'database',side_effect=lambda _,query:sql.append(query)):
                ownership.hold(release);ownership.hold(release,True)
            self.assertIn('RELEASE_HOLD_ALREADY_ACTIVE',sql[0]);self.assertNotIn('RELEASE_HOLD_ALREADY_ACTIVE',sql[1])
            self.assertIn("WHERE environment='REAL' AND NOT release_hold",sql[1])
            self.assertIn('release_frozen=o.release_frozen OR NOT o.frozen',sql[1])

    def test_removed_api_requires_recent_private_captured_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);release=root/'release.env';release.write_text('COMMERCE_IMAGE=sha256:'+'c'*64+'\n')
            capture=root/'capture.json';ownership.private_write(capture,{'captured_at':ownership.dt.datetime.now(ownership.UTC).isoformat(),'api_image':'sha256:'+'b'*64})
            with patch.dict(os.environ,{'COMMERCE_OWNERSHIP_RECOVERY_CAPTURE':str(capture)}),patch.object(ownership,'compose',return_value=''),patch.object(ownership,'run',return_value='1'),patch.object(ownership,'database',return_value='t'):
                self.assertTrue(ownership.supports_hold(release,True))
                with self.assertRaisesRegex(RuntimeError,'RUNNING_IMAGE_UNKNOWN'):ownership.supports_hold(release)
                capture.chmod(0o644)
                with self.assertRaisesRegex(RuntimeError,'CAPTURE_INVALID'):ownership.supports_hold(release,True)

if __name__=='__main__':unittest.main()
