import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import api_web_deployment as guards
import copy_portal_deployment as portal
from ci_release import ReleaseError
import test_api_web_deployment as api_fixture
vps=api_fixture.vps


class CopyPortalControllerTests(unittest.TestCase):
    def exercise(self,failure=None,continue_api_web=False):
        calls=[]
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory).resolve();private=base/'private';private.mkdir()
            current=base/'releases'/'current';current.mkdir(parents=True)
            (current/'RELEASE.json').write_text(json.dumps({'source_sha':('a' if continue_api_web else 'b')*40}))
            (base/'current').symlink_to(current)
            (private/'release.env').write_text('COMMERCE_PROXY_NETWORK=owned-proxy\n')
            input_file=private/'mcl-input.env'
            raw='MCL_SESSION_SECRET='+'1'*64+'\nMCL_CORE_CODES_SHA256='+'2'*64+'\nMCL_KIT_CODES_SHA256='+'3'*64+'\nNEXT_PUBLIC_SITE_URL=https://ciclo.inovaris.online\n'
            if failure=='input':raw='INVALID=fixture\n'
            input_file.write_text(raw)
            archive=base/'archive';archive.write_bytes(b'fixture')
            if continue_api_web:
                prior=private/'deployments'/'9-1';prior.mkdir(parents=True)
                vps._write_report(prior/'report.json',{'source_sha':'a'*40,'run_id':'9-1','status':'SUCCEEDED',
                    'deployment_scope':'api-web','release':'current','consumers_absent':True,
                    'predeploy_backup_completed':True,'migration_count':65,'core_version':{'sha':'a'*40}})
                vps._write_report(prior/'task-prepare.json',{'status':'SUCCEEDED','attempt':'first-api-web'})
            baseline={'state':{'schema_version':1,'current_release':str(current),
                'caddy_config_ref':{}},'state_raw':b'state','plan_raw':b'plan',
                'files':{'release.env':b'COMMERCE_PROXY_NETWORK=owned-proxy\n'}}
            fresh=copy.deepcopy(baseline)
            if failure=='drift':fresh['state_raw']=b'changed'
            class Lock:
                def __init__(self,name):self.name=name
                def close(self):calls.append('close:'+self.name)
            def ci_lock(_):calls.append('lock:ci');return Lock('ci')
            def four(_):calls.append('lock:four');return [Lock('four')]
            def extract(_archive,root,_hash):
                root.mkdir();(root/'RELEASE.json').write_text(json.dumps({'source_sha':'a'*40,'run_id':'9',
                    'migration_hashes':{str(i)+'.sql':'a'*64 for i in range(65)}}))
            def phase(_root,report,_owner,value):
                self.assertEqual(report.name,'portal-prepare')
                calls.append(value)
                if failure=='prepare':raise ReleaseError('PREPARATION_FAILED')
            class FakePortalInstallError(ReleaseError):
                rollback={'status':'SUCCEEDED'}
            receipt={'status':'ORIGIN_READY','run_id':'9-1','source_sha':'a'*40}
            def install(_root,_input,_sha,_run,**options):
                calls.append('install')
                self.assertTrue(options['allow_migration_maintenance'])
                self.assertTrue(options['defer_public_contact_fields'])
                self.assertEqual(options['proxy_network'],'owned-proxy')
                try:options['verify_before_commit'](receipt)
                except ReleaseError as error:raise FakePortalInstallError(str(error)) from error
                return receipt
            fake=SimpleNamespace(install=install,PortalInstallError=FakePortalInstallError)
            def receiver(_state):
                calls.append('https')
                if failure=='postcondition':raise ReleaseError('COPY_PORTAL_HTTPS_VERSION_FAILED')
            def rebase(*args,**kwargs):
                calls.append('rebase');self.assertIn('portal_transition',kwargs)
                if failure=='rebase':raise ReleaseError('COPY_REBASE_CAS_FAILED')
                return {'preserved_runtime_rebased':True,'transport_configuration_update_required':True}
            def cleanup(*args):calls.append('cleanup');return {'own_stopped_container_removed':True,'state_and_volumes_preserved':True}
            auth=api_fixture.ApiWebOwnerIdentityTests.identity()
            mocks=[patch.object(vps,'BASE',base),patch.object(vps,'PRIVATE',private),
                   patch.object(portal.signal,'signal'),
                   patch.object(guards,'protected_bytes',side_effect=lambda path:Path(path).read_bytes()),
                   patch.object(guards,'read_reference',return_value=b'owned-proxy'),
                   patch.object(guards,'read_portal_references'),
                   patch.object(guards,'snapshot',side_effect=[baseline,fresh,baseline]),
                   patch.object(guards,'database_guard',return_value=True),
                   patch.object(guards,'acquire_locks_for_prepare',side_effect=ci_lock),
                   patch.object(guards,'acquire_locks',side_effect=four),
                   patch.object(guards,'verify_predeploy_backup',return_value={'local_ciphertext_readback_verified':True}),
                   patch.object(guards,'rebase',side_effect=rebase),
                   patch.object(vps,'shutil',SimpleNamespace(copyfile=__import__('shutil').copyfile,
                       disk_usage=lambda _:SimpleNamespace(free=10*1024**3))),
                   patch.object(vps,'raw_policy_snapshot',return_value='frozen'),
                   patch.object(vps,'owner_auth_snapshot',return_value=auth),
                   patch.object(vps,'verify_ciclo_maintenance',return_value=True),
                   patch.object(vps,'verify_ciclo_state',side_effect=receiver),
                   patch.object(vps,'verify_core_version'),patch.object(vps,'extract_release',side_effect=extract),
                   patch.object(vps,'migrations',return_value={str(i)+'.sql':'a'*64 for i in range(65)}),
                   patch.object(vps,'run_install_phase',side_effect=phase),
                   patch.object(vps,'command',return_value=json.dumps([{'Id':'sha256:'+'c'*64}])),
                   patch.object(portal,'require_installed_api_web',return_value={}),
                   patch.object(portal,'transition_after',return_value=({}, {'portal':{'source_sha':'a'*40}})),
                   patch.object(portal,'remove_stopped_candidate',side_effect=cleanup),
                   patch.object(portal.importlib.util,'spec_from_file_location',return_value=SimpleNamespace(
                       loader=SimpleNamespace(exec_module=lambda _:None))),
                   patch.object(portal.importlib.util,'module_from_spec',return_value=fake)]
            with contextlib.ExitStack() as stack,contextlib.redirect_stdout(io.StringIO()),patch.dict(os.environ,{'COMMERCE_DEPLOY_SCOPE':'before'}):
                for mock in mocks:stack.enter_context(mock)
                try:portal.publish(vps,str(archive),'hash','a'*40,'9-1',str(input_file),continue_api_web=continue_api_web)
                except ReleaseError:pass
                self.assertEqual(os.environ['COMMERCE_DEPLOY_SCOPE'],'before')
            report=json.loads((private/'deployments'/'9-1'/'report.json').read_text())
            if continue_api_web:
                self.assertEqual(json.loads((prior/'api-web-complete.json').read_text())['status'],'SUCCEEDED')
                self.assertEqual(json.loads((prior/'task-prepare.json').read_text())['attempt'],'first-api-web')
            return calls,report

    def test_backup_then_ordered_locks_then_verify_commit_and_cas(self):
        calls,report=self.exercise()
        self.assertLess(calls.index('prepare'),calls.index('close:ci'))
        self.assertLess(calls.index('close:ci'),calls.index('lock:four'))
        self.assertLess(calls.index('lock:four'),calls.index('install'))
        self.assertLess(calls.index('https'),calls.index('rebase'))
        self.assertEqual(calls[-1],'close:four')
        self.assertEqual(report['status'],'SUCCEEDED')
        self.assertFalse(report['consumers_started']);self.assertFalse(report['physical_delivery_verified'])

    def test_invalid_input_or_preparation_and_fresh_drift_stop_before_portal(self):
        for failure in ('input','prepare','drift'):
            calls,report=self.exercise(failure)
            with self.subTest(failure=failure):
                self.assertEqual(report['status'],'FAILED')
                self.assertNotIn('install',calls);self.assertNotIn('rebase',calls)
                self.assertNotIn('cleanup',calls)
                if failure=='input':self.assertNotIn('lock:ci',calls)

    def test_failed_postcondition_uses_canonical_rollback_cleanup_without_database_restore(self):
        calls,report=self.exercise('postcondition')
        self.assertIn('cleanup',calls);self.assertNotIn('rebase',calls)
        self.assertEqual(report['status'],'FAILED')
        self.assertEqual(report['rollback']['status'],'SUCCEEDED')
        self.assertFalse(report['rollback']['database_restored'])

    def test_interrupted_plan_rebase_is_blocked_and_never_removes_or_rolls_back_live_portal(self):
        calls,report=self.exercise('rebase')
        self.assertEqual(calls.count('rebase'),1)
        self.assertNotIn('cleanup',calls)
        self.assertEqual(report['rollback']['status'],'BLOCKED')
        self.assertEqual(report['rollback']['error'],'COPY_REBASE_RECONCILIATION_REQUIRED')

    def test_same_run_continuation_preserves_first_phase_receipt_and_task_journal(self):
        calls,report=self.exercise(continue_api_web=True)
        self.assertEqual(report['status'],'SUCCEEDED')
        self.assertTrue(report['api_web_completed_in_same_run'])
        self.assertEqual(report['core_version'],{'sha':'a'*40})
        self.assertEqual(report['migration_count'],65)


if __name__=='__main__':unittest.main()
