"""Bounded actuator tests: no Docker daemon mutation and no network access."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('capacity_administrator', ROOT / 'scripts/number-capacity-administrator.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class AdministratorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        for name in ['token', 'release.env']:
            p = self.root / name
            p.write_text('fixture-private')
            p.chmod(0o600)
        self.agent = mod.Administrator({'api_origin':'https://example.invalid','token_file':str(self.root/'token'),'release_env':str(self.root/'release.env'),'gateway_dir':str(self.root/'gateways'),'overlay':str(self.root/'overlay.json')})
        self.agent.directory.mkdir(mode=0o700)
        self.operation = '11111111-1111-4111-8111-111111111111'
    def tearDown(self):
        self.tmp.cleanup()
    def test_credentials_are_incremental_private_and_stable(self):
        first = self.agent.credentials(12)
        self.assertEqual(first, self.agent.credentials(12))
        self.assertEqual((self.agent.directory/'waha-12.env').stat().st_mode & 0o777, 0o600)
        self.assertNotEqual(first, self.agent.credentials(13))
    def test_reconcile_never_creates_missing_credentials(self):
        with self.assertRaisesRegex(ValueError, 'EXISTING_CREDENTIAL_REQUIRED'):
            self.agent.credentials(12, create=False)
        self.assertFalse((self.agent.directory/'waha-12.env').exists())
    def test_rejects_unbounded_commands_and_symlink_credentials(self):
        with self.assertRaisesRegex(ValueError,'OPERATION_ID_REQUIRED'):
            self.agent.execute('12; docker rm anything')
        (self.agent.directory/'waha-12.env').symlink_to(self.root/'token')
        with self.assertRaisesRegex(ValueError,'PRIVATE_CONFIGURATION_REQUIRED'):
            self.agent.credentials(12)
    def test_partial_host_failure_is_unknown_and_does_not_restart_existing_gateways(self):
        calls=[]
        def api(path, body=None, key=None, method=None):
            calls.append((path,body))
            if path.startswith('/number-operations/'):
                return {'version':1,'state':'REQUESTED'}
            if body and body.get('action')=='claim':
                return {'version':2,'action':'EXPAND','input':{'apply':True},'slots':[{'slot':12}]}
            return {'state':'UNKNOWN'}
        self.agent.api=api
        self.agent.snapshot=lambda slot:{'Id':'preserved-'+str(slot),'State':{'StartedAt':'unchanged'}}
        self.agent.compose=lambda *args: (_ for _ in ()).throw(RuntimeError('FIXTURE_PARTIAL_DOCKER_FAILURE'))
        with patch.object(mod.helper,'incremental',return_value={'previous_revision':'absent'}):
            with self.assertRaisesRegex(RuntimeError,'ADMINISTRATION_RECONCILIATION_REQUIRED'):
                self.agent.execute(self.operation)
        self.assertEqual(calls[-1][1]['outcome'],'UNKNOWN')
        self.assertEqual(calls[-1][1]['expected_version'],2)
    def test_readback_rejects_changed_volumes_before_verifying_success(self):
        self.agent.compose=lambda *args:'waha-01\n' if args==('config','--services') else 'a'*64
        bad={'Mounts':[{'Destination':'/app/.sessions','Name':'other-volume'}],'NetworkSettings':{'Networks':{}}}
        with patch.object(mod,'run',return_value=json.dumps([bad])):
            with self.assertRaisesRegex(ValueError,'GATEWAY_VOLUME_CHANGED'):
                self.agent.snapshot(1)
    def test_reconcile_requires_existing_unknown_operation(self):
        self.agent.api=lambda *args,**kwargs:{'state':'SUCCEEDED','version':3}
        with self.assertRaisesRegex(ValueError,'UNKNOWN_OPERATION_REQUIRED'):
            self.agent.execute(self.operation,True)
    def test_existing_quarantined_profile_is_not_enabled_or_replaced(self):
        calls=[]
        def api(path,body=None,key=None,method=None):
            calls.append((path,body,method))
            if path.startswith('/number-operations/'):
                return {'version':1,'state':'RESERVED'}
            if body and body.get('action')=='claim':
                return {'version':2,'action':'PROVISION','input':{'existing_account':True},'slots':[{'slot':1}]}
            if path=='/settings/integrations':
                return {'profiles':[{'key':'waha:waha-01','enabled':False,'config':{'base_url':'http://waha-01:3000'}}]}
            return {'state':'SUCCEEDED'}
        self.agent.api=api
        self.agent.credentials=lambda *args,**kwargs:{'WAHA_API_KEY':'synthetic-key','WHATSAPP_HOOK_HMAC_KEY':'synthetic-hook'}
        stable={'Id':'a'*64,'Image':'sha256:'+'b'*64,'Config':{},'HostConfig':{},'Mounts':[], 'NetworkSettings':{},'State':{'StartedAt':'unchanged'}}
        self.agent.snapshot=lambda slot:stable
        self.agent.readback=lambda slot:{'slot':slot,'session_count':0,'connected_sessions':0,'running':True}
        result=self.agent.execute(self.operation)
        self.assertEqual(result['state'],'SUCCEEDED')
        self.assertFalse(any(method=='PUT' for _,_,method in calls))
        self.assertEqual(calls[-1][1]['outcome'],'VERIFIED')

if __name__=='__main__':
    unittest.main()
