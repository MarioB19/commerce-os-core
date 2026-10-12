"""Real policy files and one CAS; synthetic Docker/B02/Root authority only."""
import base64
import contextlib
import copy
import datetime as dt
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch
sys.path[:0] = [str(Path(__file__).resolve().parents[2]/'scripts')]
import runtime_boot_install_host as h
import runtime_boot_install as b
import copy_runtime_deployment as r
from ci_release import require


class GatewayPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.p = Path(self.tmp.name).resolve(); self.private = self.p/'private'; self.private.mkdir(mode=0o700)
        self.root = self.p/'releases'/'same'; (self.root/'scripts').mkdir(parents=True)
        (self.p/'current').symlink_to(self.root)
        self.boot = self.private/'runtime-boot'; (self.boot/'tools').mkdir(parents=True); (self.boot/'boots').mkdir()
        self.unit = self.p/b.UNIT
        self.old_dir = self.private/'deployments'/'100-1'; self.old_dir.mkdir(parents=True)
        self.new_dir = self.private/'deployments'/'200-1'; self.new_dir.mkdir()
        (self.private/'daily-b02'/'runs').mkdir(parents=True)
        (self.private/'controller-approvals').mkdir()
        (self.private/'release.env').write_bytes(b'SYNTHETIC=1\n')
        self.source = 'a'*40
        for n in b.FILES: (self.root/'scripts'/n).write_bytes(('synthetic '+n).encode())
        self.bundle = b.prepare(self.root, self.source)
        (self.boot/'sources.json').write_bytes(self.bundle['sources.json']); self.unit.write_bytes(self.bundle[b.UNIT])
        for n, raw in self.bundle['tools'].items(): (self.boot/'tools'/n).write_bytes(raw)
        self.config = self.private/'docker'/'config.json'; self.config.parent.mkdir(); self.config.write_bytes(b'{}')
        self.plan = r.sealed_bytes({'docker_config_path': str(self.config)})
        self.rows = {}
        for i,n in enumerate(('api','waha-01','waha-02','caddy')):
            self.rows[n] = {'Id':str(i+1)*64, 'role':n, 'State': {'Running':True,'Paused':False,'Restarting':False,
                'Pid':100+i,'StartedAt':'2026-10-11T00:00:00+00:00','OOMKilled':False},
                'Config':{},'HostConfig':{'RestartPolicy':{'Name':'unless-stopped' if n=='api' else 'no'}}}
        old_rows = {n:v for n,v in self.rows.items() if n!='waha-02'}
        self.state = {'runtime_stage':'OPERATING','current_release':str(self.root),'owner_workspace_id':'synthetic',
            'last_release_receipt_ref':self.ref(self.old_dir/'adoption-receipt.json',b'{}'),
            'service_inventory':{n:v['Id'] for n,v in old_rows.items()},'portal':{},'canonical_files':{},
            'smtp_transition_ref':self.ref(self.p/'smtp',b'{}'),'caddy_config_ref':self.ref(self.p/'caddy',b'{}'),
            'network_baseline':{},'active_proxy_sha256':'d'*64}
        self.state_raw = r.sealed_bytes(self.state)
        (self.private/'api-web-adoption.json').write_bytes(self.state_raw);(self.private/'daily-b02'/'plan.json').write_bytes(self.plan)
        self.policy = {'schema_version':1,'host_id':'123456','adoption_ref':r.native.reference(self.private/'api-web-adoption.json',self.state_raw),
            'plan_ref':r.native.reference(self.private/'daily-b02'/'plan.json',self.plan),
            'gateway_start_ids':{'waha-01':self.rows['waha-01']['Id']},'sessions_autostart':False}
        self.old_policy = r.sealed_bytes(self.policy);(self.boot/'policy.json').write_bytes(self.old_policy)
        ctx = {'manifest_sha256':r.sha256(self.bundle['sources.json']), 'unit_sha256':r.sha256(self.bundle[b.UNIT]), 'policy_sha256':r.sha256(self.old_policy)}
        jr = self.ref(self.old_dir/'host-boot-install.json',r.sealed_bytes({'context':ctx,'core_units':{n:{'path':n,'sha256':'f'*64} for n in ('containerd.service','docker.service')},'actions':{'file:policy.json':{'status':'CONFIRMED'}}}))
        completion = {'status':'HOST_BOOT_INSTALLED_REBOOT_NOT_VERIFIED','context':ctx,'journal_ref':jr,
            'native_gates':{'provider_evidence':{'source_sha':self.source}}}
        self.origin = self.ref(self.old_dir/'host-boot-install.complete.json',r.sealed_bytes(completion))
        self.paused = {'body':{'dispatch_frozen':True,'real_sends_enabled':False,'allow_real_operations':False}}
        self.before = {'state':self.state,'state_raw':self.state_raw,'plan_raw':self.plan,'services':old_rows,
            'workspace':'synthetic','policy':copy.deepcopy(self.paused)}
        rr = self.ref(self.p/'runtime',r.sealed_bytes({'captured_at':dt.datetime.now(dt.timezone.utc).isoformat(),'services':old_rows}))
        self.manifest = {'source_sha':self.source,'run_id':'200-1','before_adoption_sha256':r.sha256(self.state_raw),
            'before_plan_sha256':r.sha256(self.plan),'runtime_before_ref':rr,'ownership_observation_ref':self.ref(self.p/'ownership',b'{}'),
            'backup_tools_manifest_ref':{}}
        self.approval = self.ref(self.private/'controller-approvals'/'gateway.json',r.sealed_bytes(self.manifest))
        self.report = {'source_sha':self.source,'run_id':'200-1','action':'RECONCILE_CANONICAL_GATEWAY_INVENTORY','approval_ref':self.approval}
        self.locks = [types.SimpleNamespace(closed=False) for _ in range(4)]
        self.server = types.SimpleNamespace(PRIVATE=self.private)
        self.stack = contextlib.ExitStack();self.addCleanup(self.stack.close)
        def read(ref):
            raw=Path(ref['path']).read_bytes();require(r.native.reference(ref['path'],raw)==ref,'TEST_REFERENCE_CHANGED');return raw
        def write(path,raw,previous=None):
            if previous is None:
                with open(path,'xb') as f:f.write(raw)
            else:
                require(Path(path).read_bytes()==previous,'TEST_CAS_CHANGED');Path(path).write_bytes(raw)
        def validate(policy,**kw):
            require(policy['adoption_ref']==r.native.reference(self.private/'api-web-adoption.json',kw['adoption_raw'])
                and policy['plan_ref']==r.native.reference(self.private/'daily-b02/plan.json',kw['plan_raw']), 'TEST_POLICY_REFS')
            return {v['role']:v for v in kw['rows']}
        def command(_self,argv,_root):
            return ' '.join(v['Id'] for v in self.rows.values()) if argv[1]=='ps' else json.dumps(list(self.rows.values()))
        replacements={(h.host,'PRIVATE'):self.private,(h.host,'BASE'):self.boot,(h,'UNIT_PATH'):self.unit,
            (h,'directory'):lambda _:None,(h.host,'protected_parents'):lambda _:None,
            (h.host,'protected'):lambda p,**_:Path(p).read_bytes(),(h.host,'durable_write'):write,
            (h.host,'native_host_id'):lambda:'123456',(r.native,'read_reference'):read,
            (h.os,'geteuid'):lambda:0,(r,'CORE'):frozenset({'api'}),
            (r,'current_source_guard'):lambda *_:None,(r,'current_policy'):lambda *_:copy.deepcopy(self.paused),
            (r,'commercial_snapshot'):lambda *_:'e'*64,(r,'ownership_projection'):lambda *_:{},
            (r,'inspect_inventory'):lambda rows,**_:{v['role']:v for v in rows},
            (r,'compare_live_snapshot'):lambda a,z:require(a==z,'TEST_CID_OR_RUNTIME_CHANGED'),
            (h.host.HostAdapter,'command'):command,(h.policy_tools,'validate_policy'):validate,
            (h.Installer,'unit_identity'):lambda _self,n:{'path':n,'sha256':'f'*64},
            (h.Installer,'show'):lambda _self,n:{'UnitFileState':'enabled','NeedDaemonReload':'no'},
            (h.host,'network_snapshot'):lambda *_:{},(r,'topology'):lambda *_:None,(r,'verify_edge'):lambda *_:None,
            (r.native,'active_proxy_digest'):lambda *_:'d'*64,(r.native,'read_portal_references'):lambda *_:None,
            (r,'validate_state'):lambda *_:None,(r,'validate_plan'):lambda *_:None,
            (r,'validate_inventory'):lambda _state,rows:{v['role']:v for v in rows}}
        for (mod,n),v in replacements.items():self.stack.enter_context(patch.object(mod,n,v))
        class Guard:
            def __init__(self,_sha):pass
            def runtime_guard(self):pass
            def portal_guard(self):pass
        self.backup=types.SimpleNamespace(BackupRunner=Guard,controller_update_locks=lambda _:contextlib.nullcontext())
        self.stack.enter_context(patch.object(r,'reviewed_backup_module',lambda *_:contextlib.nullcontext(self.backup)))

    def ref(self,path,raw):
        Path(path).write_bytes(raw);return r.native.reference(path,raw)

    def adapter(self):return h.GatewayPolicy(self.server,self.root,self.new_dir,self.before,self.rows,self.report,self.locks,time.monotonic()+300)

    def apply_pair(self):
        self.new_state=dict(self.state,last_release_receipt_ref=r.native.reference(self.new_dir/'adoption-receipt.json',b'{}'),
            service_inventory={n:v['Id'] for n,v in self.rows.items()})
        self.new_state_raw=r.sealed_bytes(self.new_state);self.new_plan=self.plan+b' '
        (self.private/'api-web-adoption.json').write_bytes(self.new_state_raw);(self.private/'daily-b02'/'plan.json').write_bytes(self.new_plan)
        self.ref(self.new_dir/'copy-runtime-transition.json',r.sealed_bytes({'status':'APPLIED','source_sha':self.source,'run_id':'200-1',
            'actual_state_sha256':r.sha256(self.new_state_raw),'actual_plan_sha256':r.sha256(self.new_plan)}))

    def test_policy_only_cas_preserves_installation_and_next_deployment_lineage(self):
        a=self.adapter(); original={n:p.read_bytes() for n,p in [('unit',self.unit),('sources',self.boot/'sources.json')]}
        self.apply_pair()
        with patch.object(h.host,'bounded',side_effect=AssertionError('no systemd')):
            result=a.apply(self.new_state_raw,self.new_plan,self.backup)
        self.assertEqual(result['status'],'HOST_BOOT_POLICY_RECONCILED_INSTALLATION_PRESERVED')
        self.assertEqual(result['installation_ref'],self.origin);self.assertFalse(result['tools_installed'])
        self.assertEqual(json.loads((self.boot/'policy.json').read_bytes())['gateway_start_ids'],{n:v['Id'] for n,v in self.rows.items() if n.startswith('waha')})
        observed=h.installed_bundle({'state':self.new_state,'state_raw':self.new_state_raw,'plan_raw':self.new_plan},source_sha=self.source,root=self.root)
        self.assertEqual(observed['installation_ref'],self.origin)
        self.assertEqual(original,{'unit':self.unit.read_bytes(),'sources':(self.boot/'sources.json').read_bytes()})

    def test_source_or_receipt_or_tool_change_rejected_before_admission(self):
        cases=[(self.old_dir/'host-boot-install.complete.json',lambda v:r.sealed_bytes(dict(json.loads(v),status='UNKNOWN'))),
               (self.boot/'tools'/'ci_release.py',lambda v:v+b'changed')]
        for path,change in cases:
            old=path.read_bytes();path.write_bytes(change(old))
            with self.assertRaises(RuntimeError):self.adapter()
            path.write_bytes(old)
        self.report['source_sha']='b'*40
        with self.assertRaisesRegex(RuntimeError,'SOURCE_CHANGED'):self.adapter()
        self.assertFalse((self.new_dir/'host-boot-gateway-admission.json').exists())

    def test_pause_change_rejected_before_admission(self):
        self.paused['body']['dispatch_frozen']=False
        with self.assertRaisesRegex(RuntimeError,'PAUSE_CHANGED'):self.adapter()
        self.assertFalse((self.new_dir/'host-boot-gateway-admission.json').exists())

    def test_existing_gateway_cid_change_rejected_before_admission(self):
        self.rows['waha-01']=dict(self.rows['waha-01'],Id='9'*64)
        with self.assertRaisesRegex(RuntimeError,'PRIOR_CID_CHANGED'):self.adapter()

    def test_policy_drift_before_pair_is_caught_by_early_fence(self):
        a=self.adapter();(self.boot/'policy.json').write_bytes(self.old_policy+b' ')
        with self.assertRaisesRegex(RuntimeError,'POLICY_CAS_CHANGED'):a.fence()
        self.assertEqual((self.private/'api-web-adoption.json').read_bytes(),self.state_raw)

    def test_original_core_unit_identity_cannot_be_re_adopted(self):
        with patch.object(h.Installer,'unit_identity',lambda _self,n:{'path':n,'sha256':'0'*64}):
            with self.assertRaisesRegex(RuntimeError,'ORIGINAL_CORE_UNITS_CHANGED'):self.adapter()
        self.assertFalse((self.new_dir/'host-boot-gateway-admission.json').exists())

    def test_expiry_after_pair_never_writes_policy_or_intent(self):
        a=self.adapter();self.apply_pair();a.expires_at=dt.datetime.now(dt.timezone.utc)-dt.timedelta(seconds=1)
        with self.assertRaisesRegex(RuntimeError,'ADMISSION_EXPIRED'):a.apply(self.new_state_raw,self.new_plan,self.backup)
        self.assertEqual((self.boot/'policy.json').read_bytes(),self.old_policy)
        self.assertFalse((self.new_dir/'host-boot-install.json').exists())

    def test_post_intent_pause_change_preserves_intent_and_old_policy(self):
        a=self.adapter();self.apply_pair();write=h.host.durable_write
        def change(path,raw,**kwargs):
            write(path,raw,**kwargs)
            if Path(path).name=='host-boot-install.json':self.paused['body']['real_sends_enabled']=True
        with patch.object(h.host,'durable_write',change),self.assertRaisesRegex(RuntimeError,'PAUSE_CHANGED'):
            a.apply(self.new_state_raw,self.new_plan,self.backup)
        self.assertEqual((self.boot/'policy.json').read_bytes(),self.old_policy)
        self.assertEqual(json.loads((self.new_dir/'host-boot-install.json').read_bytes())['actions']['file:policy.json']['status'],'INTENT')

    def test_lost_policy_ack_recovery_only_reads_exact_new_policy(self):
        a=self.adapter();self.apply_pair();replace=h.replace_file
        def unknown(*args,**kwargs):replace(*args,**kwargs);raise OSError('synthetic lost acknowledgement')
        with patch.object(h,'replace_file',unknown),self.assertRaisesRegex(OSError,'synthetic'):a.apply(self.new_state_raw,self.new_plan,self.backup)
        actual={'state':self.new_state,'state_raw':self.new_state_raw,'plan_raw':self.new_plan,'services':self.rows}
        future=dt.datetime.now(dt.timezone.utc)+dt.timedelta(hours=2)
        class Later(dt.datetime):
            @classmethod
            def now(cls,tz=None):return future
        with patch.object(h,'replace_file',side_effect=AssertionError('no redispatch')),patch.object(h.dt,'datetime',Later):
            result=b.gateway_recover(self.server,self.root,self.new_dir,actual,self.report,self.locks,time.monotonic()+300,self.manifest)
        self.assertEqual(result['installation_ref'],self.origin)
        self.assertEqual(json.loads((self.new_dir/'host-boot-install.json').read_bytes())['actions']['file:policy.json']['status'],'CONFIRMED')

    def test_unknown_before_effect_recovery_never_repeats_cas(self):
        a=self.adapter();self.apply_pair()
        with patch.object(h,'replace_file',side_effect=OSError('synthetic before effect')),self.assertRaisesRegex(OSError,'synthetic'):a.apply(self.new_state_raw,self.new_plan,self.backup)
        actual={'state':self.new_state,'state_raw':self.new_state_raw,'plan_raw':self.new_plan,'services':self.rows}
        with patch.object(h,'replace_file',side_effect=AssertionError('no redispatch')),self.assertRaisesRegex(RuntimeError,'UNKNOWN_NO_RETRY'):
            b.gateway_recover(self.server,self.root,self.new_dir,actual,self.report,self.locks,time.monotonic()+300,self.manifest)
        self.assertEqual((self.boot/'policy.json').read_bytes(),self.old_policy)


if __name__=='__main__':unittest.main()
