"""Synthetic tests only; no fixture can be selected by the Linux Root CLI."""
import contextlib
import copy
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
import initial_pilot_approvals as a
from ci_release import ReleaseError
from test_copy_runtime_deployment import fixture

spec=importlib.util.spec_from_file_location('pilot_approval_contract',ROOT/'scripts/initial-pilot-root.py')
pilot=importlib.util.module_from_spec(spec);spec.loader.exec_module(pilot)
OP='11111111-1111-4111-8111-111111111111'


class Synthetic:
    def __init__(self,base):
        self.base=base; self.private=base/'private';self.private.mkdir(mode=0o700)
        state,rows,_=fixture(0)
        services={name:next(row for row in rows if row['Id']==cid) for name,cid in state['service_inventory'].items()}
        now=dt.datetime.now(dt.timezone.utc)
        self.capture={'current_release':str(base/'current'),'source_sha':'a'*40,'package_manifest_sha256':'b'*64,
            'before_adoption_sha256':'c'*64,'before_plan_sha256':'d'*64,'profile_sha256':{'api.env':'e'*64},
            'backup_finished_at':(now-dt.timedelta(seconds=10)).isoformat(),'captured_at':now.isoformat(),'services':services}
        self.facts={'ownership':{'held':True},'operation':{'id':OP},'volume_inventory':{'names':['commerce-os_pg'],'volumes':[]},
            'volume_mode':'CREATE_EMPTY','credential_refs':{},'administrator_token_ref':{},'compose_sha256':'f'*64,'image_id':'sha256:'+'1'*64}
        self.locks=0;self.reads=0;self.mutate=None
    @contextlib.contextmanager
    def locked(self):
        self.locks+=1
        try:yield
        finally:self.locks-=1
    def capture_native(self,*_):
        assert self.locks==1
        self.reads+=1
        if self.mutate:self.mutate(self.reads)
        return copy.deepcopy(self.capture)
    def candidate_env(self,folder,pilot_path):
        return a.review.immutable(folder/'candidate-release.env',('COMMERCE_PILOT_RELEASE_ENV='+pilot_path+'\n').encode())
    def observe_native(self,*_):
        assert self.locks==1
        self.reads+=1
        if self.mutate:self.mutate(self.reads)
        return copy.deepcopy(self.facts)


class PilotApproval(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='commerce-pilot-review-',dir=Path.home())
        self.base=Path(self.temp.name);self.adapter=Synthetic(self.base);self.stack=contextlib.ExitStack()
        reader=a.review.read_private;directory=a.review.private_directory
        self.stack.enter_context(patch.object(a.review,'read_private',side_effect=lambda p,**kw:reader(p,**dict(kw,uid=os.getuid()))))
        self.stack.enter_context(patch.object(a.review,'private_directory',side_effect=lambda p,**kw:directory(p,**dict(kw,uid=os.getuid()))))
        for name in ('backup','tools','pilot','admin'):
            path=self.base/(name+'.json');path.write_bytes(b'{"synthetic":true}\n');path.chmod(0o600)
            ref=self.base/(name+'-ref.json');ref.write_bytes(a.review.encoded(a.file_ref(path)));ref.chmod(0o600)
        self.folder=self.adapter.private/'initial-pilot-reviews'/'fixture'
    def tearDown(self):self.stack.close();self.temp.cleanup()
    def capture(self):return a.capture(self.adapter,'fixture',self.base/'backup-ref.json',self.base/'tools-ref.json')
    def observe(self):return a.observe(self.adapter,'fixture','123-1',OP,self.base/'pilot.json',self.base/'admin.json')
    def ready(self):self.capture();return self.observe()
    def seal(self,value):return a.seal(self.adapter,'fixture',value['observation_sha256'])
    def rewrite(self,path,change):
        value=json.loads(path.read_bytes());change(value);raw=a.review.encoded(value);path.write_bytes(raw);return a.runtime.sha256(raw)
    def test_capture_observe_seal_exact_actuator_contract_no_runtime_writes(self):
        captured=self.capture();self.assertEqual(captured['status'],'CAPTURED_OPERATION_REQUIRED')
        self.assertFalse((self.adapter.private/'controller-approvals').exists())
        value=self.observe();self.assertFalse((self.adapter.private/'controller-approvals').exists())
        result=self.seal(value);self.assertEqual(result['status'],'SEALED');self.assertFalse(result['gateway_created'])
        approval=a.runtime._parse(a.read_ref(a.ref_file(result['approval_ref_file'])))
        self.assertEqual(set(approval),pilot.FIELDS)
        self.assertEqual(approval['operation_id'],OP);self.assertEqual(approval['volume_mode'],'CREATE_EMPTY')
        self.assertFalse((self.adapter.private/'release.env').exists())
        self.assertEqual(self.adapter.reads,6);self.assertEqual(self.adapter.locks,0)
        before=self.adapter.reads
        self.assertEqual(self.seal(value)['status'],'SEALED_REPLAY_HISTORICAL');self.assertEqual(self.adapter.reads,before)
    def test_capture_refuses_changed_runtime_between_native_reads(self):
        def change(count):
            if count==2:self.adapter.capture['services']['api']['Id']='9'*64
        self.adapter.mutate=change
        with self.assertRaisesRegex(Exception,'INSTANCE_CHANGED'):self.capture()
        self.assertFalse((self.folder/'capture.json').exists());self.assertEqual(self.adapter.locks,0)
    def test_capture_cannot_be_repeated_with_retroactive_time(self):
        self.capture()
        with self.assertRaisesRegex(ReleaseError,'CAPTURE_EXISTS'):self.capture()
        self.assertEqual(self.adapter.reads,2)
    def test_observe_requires_authentic_capture(self):
        with self.assertRaises(FileNotFoundError):self.observe()
    def test_seal_requires_exact_reviewed_digest(self):
        self.ready()
        with self.assertRaisesRegex(ReleaseError,'HASH_CHANGED'):a.seal(self.adapter,'fixture','0'*64)
        self.assertFalse((self.adapter.private/'controller-approvals').exists())
    def test_observe_native_drift_cannot_be_approved(self):
        self.capture()
        def change(count):
            if count==4:self.adapter.facts['image_id']='sha256:'+'2'*64
        self.adapter.mutate=change
        with self.assertRaisesRegex(ReleaseError,'NATIVE_CHANGED'):self.observe()
        self.assertFalse((self.folder/'observation.json').exists())
    def test_changed_operation_ownership_credentials_image_and_volumes_fail_seal(self):
        value=self.ready();original=copy.deepcopy(self.adapter.facts)
        for key in original:
            self.adapter.facts=copy.deepcopy(original);self.adapter.facts[key]='changed'
            with self.subTest(key=key),self.assertRaisesRegex(ReleaseError,'NATIVE_CHANGED'):self.seal(value)
        self.assertFalse((self.adapter.private/'controller-approvals').exists())
    def test_seal_second_read_rejects_toctou(self):
        value=self.ready()
        def change(count):
            if count==6:self.adapter.facts['compose_sha256']='2'*64
        self.adapter.mutate=change
        with self.assertRaisesRegex(ReleaseError,'NATIVE_CHANGED'):self.seal(value)
        self.assertFalse((self.adapter.private/'controller-approvals').exists())
    def test_expired_and_future_observations_fail_before_native_reads(self):
        self.ready()
        for epoch in (time.time()-1900,time.time()+100):
            digest=self.rewrite(self.folder/'observation.json',lambda v:v.update(created_at_epoch=int(epoch)))
            with self.assertRaisesRegex(ReleaseError,'EXPIRED'):a.seal(self.adapter,'fixture',digest)
        self.assertEqual(self.adapter.reads,4)
    def test_approval_body_cannot_diverge_from_native_observation(self):
        self.ready()
        digest=self.rewrite(self.folder/'observation.json',lambda v:v['approval'].update(volume_mode='PRESERVE_EXISTING'))
        with self.assertRaisesRegex(ReleaseError,'APPROVAL_CHANGED'):a.seal(self.adapter,'fixture',digest)
    def test_volume_receipt_must_equal_observed_inventory(self):
        self.ready()
        self.rewrite(self.folder/'volume-inventory.json',lambda v:v.update(names=['foreign']))
        def change(value):value['approval']['volume_inventory_ref']=a.file_ref(self.folder/'volume-inventory.json')
        digest=self.rewrite(self.folder/'observation.json',change)
        with self.assertRaisesRegex(ReleaseError,'VOLUME_REFERENCE_CHANGED'):a.seal(self.adapter,'fixture',digest)
    def test_capture_reference_drift_fails(self):
        value=self.ready();(self.base/'backup.json').write_bytes(b'changed')
        with self.assertRaisesRegex(ReleaseError,'REFERENCE_CHANGED'):self.seal(value)
    def test_partial_seal_is_immutable_and_recoverable_only_without_drift(self):
        value=self.ready();original=a.review.immutable
        def fail_receipt(path,raw):
            if Path(path).name=='seal.json':raise OSError('synthetic failure')
            return original(path,raw)
        with patch.object(a.review,'immutable',side_effect=fail_receipt),self.assertRaises(OSError):self.seal(value)
        path=self.adapter.private/'controller-approvals/initial-pilot-fixture.json';inode=path.stat().st_ino
        self.adapter.facts['ownership']={'held':False}
        with self.assertRaisesRegex(ReleaseError,'NATIVE_CHANGED'):self.seal(value)
        self.adapter.facts['ownership']={'held':True}
        self.assertEqual(self.seal(value)['status'],'SEALED');self.assertEqual(path.stat().st_ino,inode)
    def test_symlink_reference_rejected(self):
        path=self.base/'pilot.json';path.unlink();path.symlink_to(self.base/'admin.json')
        with self.assertRaises(OSError):a.file_ref(path)
    def test_candidate_env_changes_only_overlay_and_never_live(self):
        self.capture();path=self.adapter.private/'release.env';raw=b'A=unchanged\n# retained\nCOMMERCE_PILOT_RELEASE_ENV=/previous\n';path.write_bytes(raw);path.chmod(0o600)
        adapter=object.__new__(a.Native);adapter.private=self.adapter.private
        result=adapter.candidate_env(self.folder,'/private/pilot.env')
        self.assertEqual(path.read_bytes(),raw)
        self.assertEqual(a.read_ref(result),b'A=unchanged\n# retained\nCOMMERCE_PILOT_RELEASE_ENV=/private/pilot.env\n')
    def test_unsafe_identifiers_rejected_and_cli_has_no_fixture_backend(self):
        for name in ('../outside','A','x/y'):
            with self.assertRaises(ReleaseError):a.identity(name)
        with patch.object(a.review.os,'geteuid',return_value=1000),self.assertRaisesRegex(ReleaseError,'LINUX_ROOT_REQUIRED'):a.Native()
        cli=(ROOT/'scripts/initial-pilot-approvals.py').read_text()
        self.assertNotIn('fixture',cli);self.assertIn('approvals.Native()',cli)


class NativeCapture(unittest.TestCase):
    def test_capture_calls_real_snapshot_backup_and_barriers_without_ownership_hold(self):
        adapter=object.__new__(a.Native);adapter.server=object();adapter.private=Path('/synthetic/private')
        now=dt.datetime.now(dt.timezone.utc);state,rows,plan=fixture(0)
        services={name:next(row for row in rows if row['Id']==cid) for name,cid in state['service_inventory'].items()}
        before={'state':state,'source_sha':'a'*40,'state_raw':b'state','plan_raw':plan,'services':services,'files':{'api.env':b'private'},
            'policy':{'body':{'dispatch_frozen':True,'real_sends_enabled':False,'allow_real_operations':False}}}
        with patch.object(adapter,'baseline',return_value=(Path('/synthetic/current'),'b'*64,before)),\
             patch.object(adapter,'backup',return_value=now-dt.timedelta(seconds=5)) as backup,\
             patch.object(a.runtime,'in_flight_guard') as guard:
            value=adapter.capture_native(Path('/synthetic/folder'),{},{});backup.assert_called_once();guard.assert_called_once()
            self.assertEqual(value['source_sha'],'a'*40);self.assertEqual(len(value['services']),8)
            self.assertLessEqual(a.timestamp(value['backup_finished_at']),a.timestamp(value['captured_at']))
            before['policy']['body']['real_sends_enabled']=True
            with self.assertRaisesRegex(ReleaseError,'FROZEN_POLICY'):adapter.capture_native(Path('/synthetic/folder'),{},{})

class NativeObservation(unittest.TestCase):
    capture=PilotApproval.capture
    tearDown=PilotApproval.tearDown

    def setUp(self):
        PilotApproval.setUp(self)
        self.native=object.__new__(a.Native);self.native.private=self.adapter.private
        self.capture();self.saved=a.load_capture(self.folder,'fixture')
        self.current=self.base/'current';(self.current/'infra/compose').mkdir(parents=True)
        yaml=self.current/'infra/compose/pilot.yaml';yaml.write_bytes((ROOT/'infra/compose/pilot.yaml').read_bytes());yaml.chmod(0o600)
        self.private_env=self.adapter.private/'release.env';self.private_env.write_bytes(b'A=one\n');self.private_env.chmod(0o600)
        gateway=self.adapter.private/'gateway';gateway.mkdir(mode=0o700)
        values={'waha-01.env':'WAHA_API_KEY=synthetic-key\nWHATSAPP_HOOK_HMAC_KEY=synthetic-hook\n',
            'channel-pilot.env':'WAHA_01_API_KEY=synthetic-key\nWAHA_01_WEBHOOK_SECRET=synthetic-hook\nWAHA_01_URL=http://waha-01:3000\n',
            'ingress-pilot.env':'WAHA_01_WEBHOOK_SECRET=synthetic-hook\n'}
        for name,raw in values.items():path=gateway/name;path.write_text(raw);path.chmod(0o600)
        token=self.adapter.private/'token';token.write_text('synthetic-token');token.chmod(0o600)
        pilot_env=self.base/'pilot.json';pilot_env.write_text('COMMERCE_GATEWAY_CONFIG_DIR='+str(gateway)+'\n')
        config={'api_origin':'https://example.invalid','token_file':str(token),'gateway_dir':str(gateway),
                'release_env':str(self.private_env),'overlay':str(self.adapter.private/'absent-overlay.json')}
        (self.base/'admin.json').write_bytes(a.review.encoded(config))
        self.params={'run_id':'123-1','operation_id':OP,'pilot_release_env_ref':a.file_ref(pilot_env),
                     'administrator_config_ref':a.file_ref(self.base/'admin.json'),
                     'new_release_env_ref':self.native.candidate_env(self.folder,str(pilot_env))}
        state,_,_=fixture(0)
        self.before={'state':state,'state_raw':b'state','plan_raw':b'plan','source_sha':'a'*40,'workspace':'synthetic-workspace',
                     'files':{'api.env':b'private'},'release':{'A':'one'},'services':self.adapter.capture['services']}
        self.saved.update(before_adoption_sha256=a.runtime.sha256(b'state'),before_plan_sha256=a.runtime.sha256(b'plan'),
                          profile_sha256={'api.env':a.runtime.sha256(b'private')})
        self.finished=a.timestamp(self.saved['backup_finished_at'])
        self.operation={'id':OP,'created_at':dt.datetime.now(dt.timezone.utc).isoformat()}
        pinned=next(line.removeprefix('    image: ') for line in yaml.read_text().splitlines() if line.startswith('    image: '))
        self.render={'name':'commerce-os','services':{'waha-01':{'image':pinned,'restart':'no','init':True,'cap_drop':['ALL'],
            'pids_limit':100,'mem_limit':768*1024**2,'cpus':0.3,'security_opt':['no-new-privileges:true'],
            'networks':{'gateway-01':{}},'environment':{'WHATSAPP_RESTART_ALL_SESSIONS':'false','WAHA_WORKER_RESTART_SESSIONS':'false',
            'WHATSAPP_START_SESSION':'','WAHA_PRINT_QR':'false'},'volumes':[{'type':'volume','source':'sessions','target':'/app/.sessions'},
            {'type':'volume','source':'media','target':'/app/.media'}]}},'networks':{'gateway-01':{'name':'commerce-os_gateway-01'}},
            'volumes':{'sessions':{'name':pilot.VOLUMES[0]},'media':{'name':pilot.VOLUMES[1]}}}
        self.commands=[];self.queries=[]
        def command(args,*_):
            self.commands.append(args)
            if args[0]=='sh':return json.dumps(self.render)
            if args[:3]==['docker','image','inspect']:return json.dumps([{'Id':'sha256:'+'1'*64}])
            if args[:3]==['docker','volume','ls']:return 'commerce-os_pg'
            raise AssertionError(args)
        def database(_,query):self.queries.append(query);return json.dumps(self.operation)
        self.native.server=types.SimpleNamespace(command=command,database=database)
        self.native.pilot=types.SimpleNamespace(administrator=pilot.administrator,rendered_guard=pilot.rendered_guard,
            frozen_guard=lambda *_:{'held':True},volume_snapshot=lambda root:pilot.volume_snapshot(root))
        self.stack.enter_context(patch.object(pilot.server,'command',side_effect=command))
        self.stack.enter_context(patch.object(self.native,'baseline',side_effect=lambda *_:(self.current,'b'*64,copy.deepcopy(self.before))))
        self.stack.enter_context(patch.object(self.native,'backup',side_effect=lambda *_:self.finished))
    def invoke(self):return self.native.observe_native(self.folder,self.saved,self.params)
    def test_native_complete_observation_and_closed_commands(self):
        value=self.invoke();self.assertEqual(value['volume_mode'],'CREATE_EMPTY');self.assertEqual(set(value['credential_refs']),a.CREDENTIALS)
        self.assertEqual([cmd[:3] for cmd in self.commands], [['docker','volume','ls'],['sh',str(self.current/'scripts/compose-release.sh'),self.params['new_release_env_ref']['path']],['docker','image','inspect']])
        query=self.queries[0]
        for term in ("s.operation_id=o.id","s.environment='REAL'","s.workspace_id=o.workspace_id","o.lease_until<=clock_timestamp()","o.action='PROVISION'"):
            self.assertIn(term,query)
    def test_native_rejects_operation_before_capture_and_backup_after_capture(self):
        self.operation['created_at']=self.saved['backup_finished_at']
        with self.assertRaisesRegex(ReleaseError,'ORDER_REQUIRED'):self.invoke()
        self.operation['created_at']=dt.datetime.now(dt.timezone.utc).isoformat()
        self.finished=dt.datetime.now(dt.timezone.utc)
        with self.assertRaisesRegex(ReleaseError,'ORDER_REQUIRED'):self.invoke()
    def test_native_rejects_active_scope_missing_operation_and_credentials_changed(self):
        original=self.operation;self.operation=None
        with self.assertRaisesRegex(ReleaseError,'OPERATION_REQUIRED'):self.invoke()
        self.operation=original
        path=self.adapter.private/'gateway/channel-pilot.env';path.write_text(path.read_text().replace('synthetic-key','wrong-key'))
        with self.assertRaisesRegex(ValueError,'CREDENTIAL_BINDING_CHANGED'):self.invoke()
    def test_native_rejects_unreviewed_ports_and_live_container_replacement(self):
        self.render['services']['waha-01']['ports']=['3000:3000']
        with self.assertRaisesRegex(Exception,'DEFINITION_UNSAFE'):self.invoke()
        del self.render['services']['waha-01']['ports']
        self.before['services']=copy.deepcopy(self.before['services']);self.before['services']['api']['Id']='0'*64
        with self.assertRaisesRegex(Exception,'INSTANCE_CHANGED'):self.invoke()


if __name__=='__main__':unittest.main()
