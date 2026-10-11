import importlib.util
import inspect
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
from ci_release import ReleaseError
spec=importlib.util.spec_from_file_location('rollback_deploy',ROOT/'scripts'/'deploy-ci-vps.py')
deploy=importlib.util.module_from_spec(spec);spec.loader.exec_module(deploy)

PREVIOUS_ENV=b'COMMERCE_IMAGE=sha256:' + b'a'*64 + b'\nCOMMERCE_WEB_IMAGE=sha256:' + b'b'*64 + b'\n'
CANDIDATE_ENV=b'COMMERCE_IMAGE=sha256:' + b'c'*64 + b'\nCOMMERCE_WEB_IMAGE=sha256:' + b'd'*64 + b'\n'

class DeploymentRollbackTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='deploy-rollback-')
        self.base=Path(self.temp.name)/'commerce-os'
        self.private=self.base/'private'
        self.releases=self.base/'releases'
        self.previous=self.releases/'ci-previous'
        self.candidate=self.releases/'ci-candidate'
        self.report_dir=self.private/'deployments'/'101-1'
        for release in [self.previous,self.candidate]:
            (release/'scripts').mkdir(parents=True)
            (release/'scripts'/'release.sh').write_text('#!/bin/sh\nexit 0\n')
        self.report_dir.mkdir(parents=True)
        (self.report_dir/'previous-release.env').write_bytes(PREVIOUS_ENV)
        (self.private/'release.env').write_bytes(CANDIDATE_ENV)
        os.chmod(self.report_dir/'previous-release.env',0o600)
        os.chmod(self.private/'release.env',0o600)
        (self.base/'current').symlink_to(self.candidate,target_is_directory=True)
        self.globals=(patch.object(deploy,'BASE',self.base),patch.object(deploy,'PRIVATE',self.private))
        for item in self.globals:item.start()

    def tearDown(self):
        for item in reversed(self.globals):item.stop()
        self.temp.cleanup()

    def test_compatible_release_detection_uses_both_runtime_images(self):
        previous=self.report_dir/'previous-release.env'
        candidate=self.private/'release.env'
        with patch.object(deploy,'command',side_effect=['1','1']) as runner:
            self.assertTrue(deploy.compatible_release_images(previous,candidate,self.candidate))
            self.assertEqual(runner.call_count,2)
            self.assertIn('sha256:'+'a'*64,runner.call_args_list[0].args[0])
            self.assertIn('sha256:'+'c'*64,runner.call_args_list[1].args[0])
        with patch.object(deploy,'command',side_effect=['0','1']):
            self.assertFalse(deploy.compatible_release_images(previous,candidate,self.candidate))
        with patch.object(deploy,'command',return_value='UNKNOWN'):
            with self.assertRaisesRegex(ReleaseError,'RELEASE_HOLD_CAPABILITY_UNKNOWN'):
                deploy.compatible_release_images(previous,candidate,self.candidate)

    def test_services_current_and_private_env_are_restored_in_order(self):
        events=[]
        original_replace=os.replace
        def runner(args,**kwargs):
            events.append('services')
            self.assertEqual((self.base/'current').resolve(),self.candidate.resolve())
            self.assertEqual((self.private/'release.env').read_bytes(),CANDIDATE_ENV)
            return SimpleNamespace(returncode=0,stdout='private output',stderr='private output')
        def replace(source,destination):
            events.append(Path(destination).name)
            return original_replace(source,destination)
        with patch.object(deploy.os,'replace',side_effect=replace):
            result=deploy.rollback_candidate(self.candidate,self.previous,self.report_dir,runner)
        self.assertEqual(events,['task-rollback.json','services','task-rollback.json','current','release.env'])
        self.assertEqual((self.base/'current').resolve(),self.previous.resolve())
        self.assertEqual((self.private/'release.env').read_bytes(),PREVIOUS_ENV)
        self.assertEqual((self.private/'release.env').stat().st_mode&0o777,0o600)
        self.assertEqual(result,{'status':'SUCCEEDED','release':'ci-previous','services_restored':True,
                                 'current_restored':True,'release_env_restored':True,'database_restored':False})
        self.assertNotIn('private output',json.dumps(result))

    def test_installer_failure_before_symlink_switch_is_also_recoverable(self):
        (self.base/'current').unlink()
        (self.base/'current').symlink_to(self.previous,target_is_directory=True)
        (self.private/'release.env').unlink()
        runner=MagicMock(return_value=SimpleNamespace(returncode=0,stdout='',stderr=''))
        deploy.rollback_candidate(self.candidate,self.previous,self.report_dir,runner)
        runner.assert_called_once_with(
            ['sh','scripts/release.sh','rollback',str((self.report_dir/'previous-release.env').resolve())],
            cwd=self.candidate.resolve(),text=True,capture_output=True,timeout=720)
        self.assertEqual((self.base/'current').resolve(),self.previous.resolve())
        self.assertEqual((self.private/'release.env').read_bytes(),PREVIOUS_ENV)

    def test_failed_rollback_is_sanitized_and_preserves_original_error(self):
        report={'status':'FAILED','error':'HTTPS_READINESS_FAILED','stage':'verify'}
        runner=MagicMock(return_value=SimpleNamespace(returncode=2,stdout='secret stdout',stderr='secret stderr'))
        failure=deploy.recover_failed_install(self.candidate,self.previous,self.report_dir,report,None,runner)
        self.assertIsInstance(failure,ReleaseError)
        self.assertEqual(str(failure),'DEPLOYMENT_ROLLBACK_FAILED')
        self.assertEqual(report['error'],'HTTPS_READINESS_FAILED')
        self.assertEqual(report['rollback']['status'],'FAILED')
        self.assertEqual(report['rollback']['core'],{'status':'FAILED','error':'ROLLBACK_COMMAND_FAILED','database_restored':False})
        self.assertEqual(report['rollback']['identity_proxy'],{'status':'NOT_APPLIED','other_sites_preserved':True})
        self.assertEqual(report['rollback']['waha_backup_timer'],{'status':'NOT_APPLIED','units_restored':False,'runtime_state_restored':False})
        self.assertFalse(report['rollback']['database_restored'])
        self.assertNotIn('secret',json.dumps(report))
        self.assertIn('secret stderr',(self.report_dir/'rollback.log').read_text())
        self.assertEqual((self.report_dir/'rollback.log').stat().st_mode&0o777,0o600)
        journal=json.loads((self.report_dir/'task-rollback.json').read_text())
        self.assertEqual(journal['phase_error'],'ROLLBACK_COMMAND_FAILED')
        self.assertEqual(journal['status'],'FAILED')
        self.assertEqual((self.base/'current').resolve(),self.candidate.resolve())
        self.assertEqual((self.private/'release.env').read_bytes(),CANDIDATE_ENV)
        self.assertEqual(runner.call_args.args[0][2],'rollback')
        self.assertNotIn('restore',' '.join(runner.call_args.args[0]).lower())

    def test_successful_rollback_report_keeps_original_failure(self):
        report={'status':'FAILED','error':'INSTALLER_FAILED','stage':'install'}
        runner=MagicMock(return_value=SimpleNamespace(returncode=0,stdout='',stderr=''))
        self.assertIsNone(deploy.recover_failed_install(self.candidate,self.previous,self.report_dir,report,None,runner))
        self.assertEqual(report['error'],'INSTALLER_FAILED')
        self.assertEqual(report['rollback']['status'],'SUCCEEDED')
        self.assertEqual(report['rollback']['core']['status'],'SUCCEEDED')
        self.assertEqual(report['rollback']['waha_backup_timer']['status'],'NOT_APPLIED')
        self.assertFalse(report['rollback']['database_restored'])

    def test_caddy_restore_is_attempted_even_when_core_rollback_fails(self):
        report={'status':'FAILED','error':'HTTPS_READINESS_FAILED','stage':'verify'}
        core=MagicMock(return_value=SimpleNamespace(returncode=2,stdout='',stderr='private core'))
        proxy_runner=MagicMock(return_value=SimpleNamespace(returncode=0,stdout='{"status":"RESTORED","other_sites_preserved":true}',stderr=''))
        receipt={'status':'UPDATED','other_sites_preserved':True,'rollback_token':'identity-proxy-safe_123'}
        failure=deploy.recover_failed_install(self.candidate,self.previous,self.report_dir,report,receipt,core,proxy_runner)
        self.assertEqual(str(failure),'DEPLOYMENT_ROLLBACK_FAILED')
        self.assertEqual(report['rollback']['core']['status'],'FAILED')
        self.assertEqual(report['rollback']['identity_proxy']['status'],'RESTORED')
        self.assertNotIn('private',json.dumps(report))
        proxy_runner.assert_called_once()

    def test_waha_units_and_runtime_state_are_restored_before_success(self):
        systemd=self.base/'systemd';systemd.mkdir()
        previous={
            'commerce-waha-backup.service':b'[Service]\nExecStart=/previous/backup\n',
            'commerce-waha-backup.timer':b'[Timer]\nOnCalendar=previous\n',
        }
        for name,content in previous.items():
            (systemd/name).write_bytes(content);os.chmod(systemd/name,0o640)
        enabled={name:False for name in deploy.WAHA_BACKUP_UNITS}
        active={name:False for name in deploy.WAHA_BACKUP_UNITS}
        calls=[]
        def systemctl(args,**_kwargs):
            calls.append(args);action=args[1]
            if action=='is-enabled':
                value='enabled' if enabled[args[2]] else 'disabled'
                return SimpleNamespace(returncode=0 if value=='enabled' else 1,stdout=value+'\n',stderr='')
            if action=='is-active':
                value='active' if active[args[2]] else 'inactive'
                return SimpleNamespace(returncode=0 if value=='active' else 3,stdout=value+'\n',stderr='')
            if action=='stop':
                for name in args[2:]:active[name]=False
            elif action=='disable':enabled[args[2]]=False
            elif action=='enable':enabled[args[2]]=True
            elif action=='start':active[args[2]]=True
            return SimpleNamespace(returncode=0,stdout='',stderr='')
        state=deploy.capture_waha_backup_state(systemctl,systemd);state['attempted']=True
        for name in deploy.WAHA_BACKUP_UNITS:(systemd/name).write_text('candidate unit\n')
        enabled['commerce-waha-backup.timer']=True;active['commerce-waha-backup.timer']=True
        result=deploy.restore_waha_backup_state(state,systemctl,systemd)
        self.assertEqual(result,{'status':'RESTORED','units_restored':True,'runtime_state_restored':True})
        self.assertEqual({name:(systemd/name).read_bytes() for name in previous},previous)
        self.assertFalse(enabled['commerce-waha-backup.timer']);self.assertFalse(active['commerce-waha-backup.timer'])
        self.assertIn(['systemctl','daemon-reload'],calls)

    def test_waha_restore_failure_prevents_successful_rollback_claim(self):
        report={'status':'FAILED','error':'PORTAL_INSTALL_FAILED','stage':'portal'}
        core=MagicMock(return_value=SimpleNamespace(returncode=0,stdout='',stderr=''))
        with patch.object(deploy,'restore_waha_backup_state',side_effect=ReleaseError('WAHA_BACKUP_STATE_RESTORE_FAILED')):
            failure=deploy.recover_failed_install(
                self.candidate,self.previous,self.report_dir,report,None,core,None,
                {'attempted':True})
        self.assertEqual(str(failure),'DEPLOYMENT_ROLLBACK_FAILED')
        self.assertEqual(report['error'],'PORTAL_INSTALL_FAILED')
        self.assertEqual(report['rollback']['status'],'FAILED')
        self.assertEqual(report['rollback']['waha_backup_timer']['error'],'WAHA_BACKUP_STATE_RESTORE_FAILED')
        self.assertFalse(report['rollback']['database_restored'])

    def test_partially_installed_new_waha_unit_is_removed_and_stopped(self):
        systemd=self.base/'systemd';systemd.mkdir()
        states={name:{'enabled':False,'active':False} for name in deploy.WAHA_BACKUP_UNITS}
        calls=[]
        def systemctl(args,**_kwargs):
            calls.append(args);action=args[1];name=args[2] if len(args)>2 else None
            exists=name is not None and (systemd/name).exists()
            if action=='is-enabled':
                value=('enabled' if states[name]['enabled'] else 'disabled') if exists else 'not-found'
                return SimpleNamespace(returncode=0 if value=='enabled' else 1,stdout=value+'\n',stderr='')
            if action=='is-active':
                value=('active' if states[name]['active'] else 'inactive') if exists else 'not-found'
                return SimpleNamespace(returncode=0 if value=='active' else 3,stdout=value+'\n',stderr='')
            if action in ('stop','disable') and not exists:
                return SimpleNamespace(returncode=5,stdout='',stderr='unit not found')
            if action=='stop':states[name]['active']=False
            elif action=='disable':states[name]['enabled']=False
            return SimpleNamespace(returncode=0,stdout='',stderr='')
        state=deploy.capture_waha_backup_state(systemctl,systemd);state['attempted']=True
        service=systemd/'commerce-waha-backup.service'
        service.write_text('[Service]\nExecStart=/candidate/backup\n')
        states[service.name]={'enabled':True,'active':True}
        result=deploy.restore_waha_backup_state(state,systemctl,systemd)
        self.assertEqual(result['status'],'RESTORED')
        self.assertFalse(service.exists())
        self.assertFalse(states[service.name]['enabled']);self.assertFalse(states[service.name]['active'])
        self.assertIn(['systemctl','stop','commerce-waha-backup.timer'],calls)
        self.assertIn(['systemctl','is-active','commerce-waha-backup.timer'],calls)

    def test_staging_soak_starts_only_after_portal_gate(self):
        source=inspect.getsource(deploy.main)
        self.assertLess(source.index('portal_install.install'),source.index('start-staging-soak.py'))

    def test_portal_rollback_report_is_bounded_and_preserves_failure_signal(self):
        error=ReleaseError('PORTAL_OTHER_CONTAINERS_CHANGED')
        error.rollback={'status':'FAILED','error':'ROLLBACK_SOURCE_CHANGED',
                        'proxy':{'status':'FAILED','error':'ROLLBACK_SOURCE_CHANGED','private':'secret'},
                        'current_restored':False,'candidate_stopped':False,
                        'previous_container_started':True,'database_restored':False,
                        'private':'secret'}
        result,failed=deploy.portal_rollback_result(error)
        self.assertTrue(failed)
        self.assertEqual(result['error'],'ROLLBACK_SOURCE_CHANGED')
        self.assertTrue(result['previous_container_started'])
        self.assertNotIn('private',json.dumps(result))
        self.assertNotIn('secret',json.dumps(result))

    def test_unexpected_current_target_stops_before_service_mutation(self):
        unrelated=self.releases/'ci-unrelated'
        unrelated.mkdir()
        (self.base/'current').unlink()
        (self.base/'current').symlink_to(unrelated,target_is_directory=True)
        runner=MagicMock()
        with self.assertRaisesRegex(ReleaseError,'^ROLLBACK_CURRENT_STATE_INVALID$'):
            deploy.rollback_candidate(self.candidate,self.previous,self.report_dir,runner)
        runner.assert_not_called()
        self.assertEqual((self.private/'release.env').read_bytes(),CANDIDATE_ENV)

    def test_timeout_fails_closed_without_mutating_pointer_or_env(self):
        runner=MagicMock(side_effect=subprocess.TimeoutExpired(['sh','scripts/release.sh'],720,output='secret'))
        with self.assertRaisesRegex(ReleaseError,'^ROLLBACK_COMMAND_TIMEOUT$'):
            deploy.rollback_candidate(self.candidate,self.previous,self.report_dir,runner)
        self.assertEqual((self.base/'current').resolve(),self.candidate.resolve())
        self.assertEqual((self.private/'release.env').read_bytes(),CANDIDATE_ENV)

if __name__=='__main__':
    unittest.main()
