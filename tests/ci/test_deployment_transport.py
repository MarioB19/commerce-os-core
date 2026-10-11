import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
from ci_release import ReleaseError
spec=importlib.util.spec_from_file_location('deployment_client',Path(__file__).resolve().parents[2]/'scripts/deploy-ci-client.py')
client=importlib.util.module_from_spec(spec);spec.loader.exec_module(client)

class DeploymentTransportTests(unittest.TestCase):
    def test_local_source_must_match_and_be_clean(self):
        sha='a'*40
        calls=[]
        def clean(args,check=True,capture=False):
            calls.append(args)
            value=sha+'\n' if args[1:]==['rev-parse','HEAD'] else ''
            return subprocess.CompletedProcess(args,0,stdout=value,stderr='')
        client.verify_local_source(sha,clean)
        self.assertEqual(calls,[['git','rev-parse','HEAD'],
                                ['git','status','--porcelain','--untracked-files=all']])
        def dirty(args,check=True,capture=False):
            value=sha+'\n' if args[1:]==['rev-parse','HEAD'] else ' M scripts/deploy-ci-vps.py\n'
            return subprocess.CompletedProcess(args,0,stdout=value,stderr='')
        with self.assertRaisesRegex(ReleaseError,'LOCAL_SOURCE_NOT_CLEAN'):
            client.verify_local_source(sha,dirty)

    def test_watchdog_and_report_poll_cover_late_rollback(self):
        self.assertGreaterEqual(client.REMOTE_RUNTIME_MAX_SECONDS,3600)
        self.assertGreaterEqual(client.REMOTE_STOP_TIMEOUT_SECONDS,1800)
        self.assertGreater(
            client.REPORT_POLL_ATTEMPTS*client.REPORT_POLL_INTERVAL_SECONDS,
            client.REMOTE_RUNTIME_MAX_SECONDS+client.REMOTE_STOP_TIMEOUT_SECONDS,
        )
        workflow=(Path(__file__).resolve().parents[2]/'.github/workflows/ci.yml').read_text()
        deploy=re.search(r'(?ms)^  deploy:\n.*?^    timeout-minutes: (\d+)\s*$',workflow)
        self.assertIsNotNone(deploy)
        self.assertGreater(
            int(deploy.group(1))*60,
            client.REPORT_POLL_ATTEMPTS*client.REPORT_POLL_INTERVAL_SECONDS,
        )

    def test_server_current_portal_mode_never_transfers_a_local_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            portal,files,argument=client.portal_transport(directory,'server-current')
            self.assertFalse(portal.exists());self.assertEqual(files,[])
            self.assertEqual(argument,client.SERVER_CURRENT_PORTAL_ENV)
            portal.write_text('secret')
            with self.assertRaisesRegex(ReleaseError,'LOCAL_PORTAL_ENV_MUST_NOT_EXIST'):
                client.portal_transport(directory,'server-current')

    def test_cleanup_only_removes_staging_after_confirmed_inactive_or_absent(self):
        command=client.cleanup_staging_command('commerce-ci-123-1','commerce-ci-123-1')
        self.assertIn('active|activating|deactivating|reloading',command)
        self.assertIn('[ "$pid" -eq 0 ]',command)
        self.assertIn('exit 75',command)
        self.assertIn('sudo rm -f',command)
        self.assertIn('test ! -e commerce-ci-123-1',command)

    def test_remote_python_cannot_leave_untracked_bytecode_in_staging(self):
        source=(Path(__file__).resolve().parents[2]/'scripts/deploy-ci-client.py').read_text()
        self.assertIn('/usr/bin/env PYTHONDONTWRITEBYTECODE=1 ',source)
        self.assertIn('/usr/bin/python3 "$stage/deploy-ci-vps.py"',source)

    @staticmethod
    def unit(load='loaded',active='inactive',sub='dead',pid=0):
        return f'LoadState={load}\nActiveState={active}\nSubState={sub}\nMainPID={pid}\n'

    def test_structured_unit_state_keeps_deactivating_rollback_running(self):
        for active,pid,expected in (
            ('deactivating',0,'RUNNING'),('inactive',42,'RUNNING'),
            ('inactive',0,'TERMINAL'),('failed',0,'TERMINAL')):
            def ssh(_command,check,active=active,pid=pid):
                self.assertFalse(check)
                return subprocess.CompletedProcess([],0,stdout=self.unit(active=active,pid=pid),stderr='')
            self.assertEqual(client.unit_runtime_state(ssh,'commerce-ci-123-1'),expected)

    def transport(self, events):
        remaining=list(events)
        def ssh(command, check):
            self.assertFalse(check)
            kind,code,body=remaining.pop(0)
            self.assertEqual('unit' if 'systemctl show' in command else 'report',kind)
            return subprocess.CompletedProcess([],code,stdout=body,stderr='')
        return ssh,remaining

    def test_report_published_between_poll_and_collected_unit_is_retrieved(self):
        report={'status':'SUCCEEDED','source_sha':'a'*40,'run_id':'123-1'}
        ssh,left=self.transport([('report',1,'')]*3+[
            ('unit',0,self.unit(load='not-found')),('report',0,json.dumps(report))])
        self.assertEqual(client.wait_for_report(ssh,'/private/report.json','commerce-ci-123-1',delay=0),report)
        self.assertEqual(left,[])

    def test_confirmed_exit_without_report_still_fails(self):
        ssh,left=self.transport([('report',1,'')]*3+[
            ('unit',0,self.unit()),('report',1,'')])
        with self.assertRaisesRegex(ReleaseError,'REMOTE_SERVICE_EXITED_WITHOUT_REPORT'):
            client.wait_for_report(ssh,'/private/report.json','commerce-ci-123-1',delay=0)
        self.assertEqual(left,[])

    def test_transport_failure_does_not_claim_remote_process_exited(self):
        report={'status':'SUCCEEDED'}
        ssh,left=self.transport([('report',1,'')]*3+[
            ('unit',255,''),('report',0,json.dumps(report)),
            ('unit',0,self.unit(load='not-found')),('report',0,json.dumps(report))])
        self.assertEqual(client.wait_for_report(ssh,'/private/report.json','commerce-ci-123-1',delay=0),report)
        self.assertEqual(left,[])

    def test_transport_failure_during_final_read_preserves_unknown(self):
        report={'status':'FAILED'}
        ssh,left=self.transport([('report',1,'')]*3+[
            ('unit',0,self.unit()),('report',255,''),('report',0,json.dumps(report)),
            ('unit',0,self.unit(load='not-found')),('report',0,json.dumps(report))])
        self.assertEqual(client.wait_for_report(ssh,'/private/report.json','commerce-ci-123-1',delay=0),report)
        self.assertEqual(left,[])

    def test_deactivating_unit_is_not_treated_as_exited_during_rollback(self):
        report={'status':'FAILED'}
        ssh,left=self.transport([('report',1,'')]*3+[
            ('unit',0,self.unit(active='deactivating',sub='stop-sigterm',pid=321)),
            ('report',0,json.dumps(report)),
            ('unit',0,self.unit(active='deactivating',sub='stop-sigterm',pid=321)),
            ('report',0,json.dumps(report)),('unit',0,self.unit(load='not-found')),('report',0,json.dumps(report))])
        self.assertEqual(client.wait_for_report(ssh,'/private/report.json','commerce-ci-123-1',delay=0),report)
        self.assertEqual(left,[])

    def test_running_report_is_refreshed_after_unit_exits_between_ssh_calls(self):
        stale={'status':'RUNNING','stage':'install','source_sha':'a'*40,'run_id':'123-1'}
        final={**stale,'status':'SUCCEEDED','stage':'complete'}
        ssh,left=self.transport([
            ('report',0,json.dumps(stale)),('unit',0,self.unit(load='not-found')),
            ('report',0,json.dumps(final))])
        self.assertEqual(client.wait_for_report(ssh,'/private/report.json','commerce-ci-123-1',attempts=1,delay=0),final)
        self.assertEqual(left,[])

    def test_confirmed_exit_with_running_report_is_not_a_terminal_result(self):
        report={'status':'RUNNING','stage':'install'}
        ssh,left=self.transport([
            ('report',0,json.dumps(report)),('unit',0,self.unit()),
            ('report',0,json.dumps(report))])
        with self.assertRaisesRegex(ReleaseError,'REMOTE_SERVICE_EXITED_WITH_NONTERMINAL_REPORT'):
            client.wait_for_report(ssh,'/private/report.json','commerce-ci-123-1',attempts=1,delay=0)
        self.assertEqual(left,[])

    def test_report_found_only_after_exit_must_also_be_terminal(self):
        report={'status':'RUNNING','stage':'install'}
        ssh,left=self.transport([('report',1,'')]*3+[
            ('unit',0,self.unit()),('report',0,json.dumps(report))])
        with self.assertRaisesRegex(ReleaseError,'REMOTE_SERVICE_EXITED_WITH_NONTERMINAL_REPORT'):
            client.wait_for_report(ssh,'/private/report.json','commerce-ci-123-1',attempts=3,delay=0)
        self.assertEqual(left,[])

    def test_old_success_is_not_reused_while_a_later_invocation_rolls_back(self):
        old={'status':'SUCCEEDED','stage':'complete'}
        running={'status':'RUNNING','stage':'install'}
        final={'status':'FAILED','stage':'install','rollback':{'status':'SUCCEEDED'}}
        ssh,left=self.transport([
            ('report',0,json.dumps(old)),('unit',0,self.unit(active='deactivating',sub='stop-sigterm',pid=321)),
            ('report',0,json.dumps(running)),('unit',0,self.unit(load='not-found')),
            ('report',0,json.dumps(final))])
        self.assertEqual(client.wait_for_report(ssh,'/private/report.json','commerce-ci-123-1',attempts=2,delay=0),final)
        self.assertEqual(left,[])

    def test_invalid_final_report_status_is_never_accepted(self):
        for report in ({},{'status':'UNKNOWN'},[],{'status':'CLEANUP_FAILED'}):
            with self.subTest(report=report):
                ssh,left=self.transport([
                    ('report',0,json.dumps({'status':'RUNNING'})),('unit',0,self.unit()),
                    ('report',0,json.dumps(report))])
                with self.assertRaisesRegex(ReleaseError,'REMOTE_SERVICE_EXITED_WITH_NONTERMINAL_REPORT'):
                    client.wait_for_report(ssh,'/private/report.json','commerce-ci-123-1',attempts=1,delay=0)
                self.assertEqual(left,[])

    def test_missing_response_is_bounded_and_never_restarts_installer(self):
        ssh,left=self.transport([('report',255,'')]*3+[('unit',255,'')])
        with self.assertRaisesRegex(RuntimeError,'REMOTE_DEPLOYMENT_STATUS_TIMEOUT_INSPECT_SYSTEMD'):
            client.wait_for_report(ssh,'/private/report.json','commerce-ci-123-1',attempts=3,delay=0)
        self.assertEqual(left,[])

if __name__=='__main__':
    unittest.main()
