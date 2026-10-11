"""Explicit slot-3 approvals and private credential reads; no native effects."""
import contextlib
import copy
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts'))
import additional_existing_gateway as a
from ci_release import ReleaseError
from test_initial_pilot_approvals import Synthetic as OriginalSynthetic
from test_copy_runtime_deployment import fixture

OP='11111111-1111-4111-8111-111111111111'


class Synthetic(OriginalSynthetic):
    def __init__(self,base):
        super().__init__(base)
        state,rows,_=fixture(1)
        self.capture['services']={name:next(r for r in rows if r['Id']==cid) for name,cid in state['service_inventory'].items()}
        p=base/'credential.env';p.write_bytes(b'SYNTHETIC=only\n');p.chmod(0o600)
        ref=a.initial.file_ref(p)
        self.facts.update(credential_refs={'waha-03.env':ref},gcp_binding_ref=ref,
            credential_binding={'credentials_match':True,'profile_disabled':True,'profile_version':1})
        (self.private/'release.env').write_bytes(b'UNCHANGED=synthetic\n');(self.private/'release.env').chmod(0o600)
    def credentials_native(self,folder,capture,params):
        assert self.locks==1
        self.reads+=1
        if self.mutate:self.mutate(self.reads)
        return copy.deepcopy({'source_sha':self.capture['source_sha'],'profile':self.facts['credential_binding'], 'target':str(self.private/'waha-03.env')})
    def candidate_overlay(self,folder,config):
        return a.review.immutable(folder/'candidate-additional-gateways.json',b'{"synthetic":true}\n')


class ApprovalProtocol(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='additional-approval-',dir=Path.home())
        self.base=Path(self.temp.name);self.stack=contextlib.ExitStack()
        reader=a.review.read_private;directory=a.review.private_directory
        self.stack.enter_context(patch.object(a.review,'read_private',side_effect=lambda p,**kw:reader(p,**dict(kw,uid=os.getuid()))))
        self.stack.enter_context(patch.object(a.review,'private_directory',side_effect=lambda p,**kw:directory(p,**dict(kw,uid=os.getuid()))))
        self.adapter=Synthetic(self.base)
        for name in ('backup','tools','pilot','admin'):
            path=self.base/(name+'.json');path.write_bytes(b'{"synthetic":true}\n');path.chmod(0o600)
            ref=self.base/(name+'-ref.json');ref.write_bytes(a.review.encoded(a.initial.file_ref(path)));ref.chmod(0o600)
        self.folder=self.adapter.private/'additional-existing-gateway-reviews'/'fixture'
    def tearDown(self):self.stack.close();self.temp.cleanup()
    def capture(self):return a.capture(self.adapter,'fixture',self.base/'backup-ref.json',self.base/'tools-ref.json')
    def observe(self):return a.observe(self.adapter,'fixture','123-1',OP,self.base/'pilot.json',self.base/'admin.json')
    def ready(self):self.capture();return self.observe()
    def seal(self,value):return a.seal(self.adapter,'fixture',value['observation_sha256'])
    def rewrite(self,path,change):
        value=json.loads(path.read_bytes());change(value);raw=a.review.encoded(value);path.write_bytes(raw);return a.runtime.sha256(raw)
    def test_capture_then_operation_observe_explicit_seal_and_historical_replay(self):
        original=(self.adapter.private/'release.env').read_bytes()
        self.assertEqual(self.capture()['services_observed'],9)
        value=self.observe();self.assertFalse((self.adapter.private/'controller-approvals').exists())
        result=self.seal(value);self.assertEqual(result['status'],'SEALED')
        approval=json.loads(a.initial.read_ref(a.initial.ref_file(result['approval_ref_file'])))
        a.approval_guard(approval);self.assertEqual(approval['target_slot'],3)
        self.assertEqual(set(approval),a.FIELDS);self.assertEqual(approval['operation_id'],OP)
        self.assertEqual((self.adapter.private/'release.env').read_bytes(),original)
        self.assertFalse((self.adapter.private/'additional-gateways.json').exists())
        reads=self.adapter.reads;self.assertEqual(self.seal(value)['status'],'SEALED_REPLAY_HISTORICAL')
        self.assertEqual(self.adapter.reads,reads);self.assertEqual(self.adapter.locks,0)
    def test_capture_and_observation_drift_never_emit_approval(self):
        self.capture();self.adapter.mutate=lambda n:self.adapter.facts.update(image_id=str(n))
        with self.assertRaises(ReleaseError):self.observe()
        self.assertFalse((self.adapter.private/'controller-approvals').exists())
    def test_seal_rechecks_private_binding_gcp_overlay_and_cas(self):
        for name in ('credential_binding','gcp_binding_ref','compose_sha256','operation','ownership'):
            with self.subTest(name=name),tempfile.TemporaryDirectory(dir=self.base) as temp:
                # Reuse the exact observed protocol in a distinct private fixture.
                self.adapter=Synthetic(Path(temp));self.folder=self.adapter.private/'additional-existing-gateway-reviews'/'fixture'
                value=self.ready();self.adapter.facts[name]={'changed':True}
                with self.assertRaises(ReleaseError):self.seal(value)
                self.assertFalse((self.adapter.private/'controller-approvals').exists())
    def test_wrong_digest_and_expired_observation_cannot_seal(self):
        value=self.ready()
        with self.assertRaises(ReleaseError):a.seal(self.adapter,'fixture','0'*64)
        digest=self.rewrite(self.folder/'observation.json',lambda v:v.update(created_at_epoch=int(time.time())-a.review.MAX_AGE-1))
        with self.assertRaisesRegex(ReleaseError,'EXPIRED'):a.seal(self.adapter,'fixture',digest)
    def test_approval_target_or_native_facts_cannot_be_edited(self):
        self.ready()
        digest=self.rewrite(self.folder/'observation.json',lambda v:v['approval'].update(target_slot=2))
        with self.assertRaises(ReleaseError):a.seal(self.adapter,'fixture',digest)
    def test_same_capture_cannot_be_backdated_or_recreated(self):
        self.capture()
        with self.assertRaises(ReleaseError):self.capture()
        self.assertEqual(self.adapter.reads,2)
    def test_cli_has_no_backend_fixture_or_approval_json_input(self):
        source=(ROOT/'scripts/additional-existing-gateway-approvals.py').read_text()
        self.assertNotIn('--fixture',source);self.assertNotIn('--backend',source)
        self.assertIn("'adoption-seal':('review_id','observation_sha256')",source)

    def test_credentials_explicit_seal_contains_only_observed_metadata(self):
        self.capture()
        observed=a.credentials_observe(self.adapter,'fixture',OP,self.base/'admin.json')
        self.assertFalse((self.adapter.private/'controller-approvals').exists())
        result=a.credentials_seal(self.adapter,'fixture',observed['observation_sha256'])
        approved=json.loads(a.initial.read_ref(a.initial.ref_file(result['approval_ref_file'])))
        self.assertEqual(set(approved),a.CREDENTIAL_APPROVAL_FIELDS)
        self.assertEqual(approved['kind'],'ADDITIONAL_EXISTING_CREDENTIALS')
        self.assertNotIn('credential_env',json.dumps(approved))
        self.assertFalse((self.adapter.private/'waha-03.env').exists())
        reads=self.adapter.reads
        self.assertEqual(a.credentials_seal(self.adapter,'fixture',observed['observation_sha256'])['status'],'SEALED_REPLAY_HISTORICAL')
        self.assertEqual(self.adapter.reads,reads)
    def test_changed_profile_version_cannot_be_sealed(self):
        self.capture();observed=a.credentials_observe(self.adapter,'fixture',OP,self.base/'admin.json')
        self.adapter.facts['credential_binding']['profile_version']=2
        with self.assertRaises(ReleaseError):a.credentials_seal(self.adapter,'fixture',observed['observation_sha256'])
        self.assertFalse((self.adapter.private/'controller-approvals').exists())
    def test_credential_seal_digest_expiry_and_capture_are_authenticated(self):
        self.capture();observed=a.credentials_observe(self.adapter,'fixture',OP,self.base/'admin.json')
        with self.assertRaises(ReleaseError):a.credentials_seal(self.adapter,'fixture','0'*64)
        digest=self.rewrite(self.folder/'credentials-observation.json',lambda v:v.update(created_at_epoch=int(time.time())-a.review.MAX_AGE-1))
        with self.assertRaisesRegex(ReleaseError,'EXPIRED'):a.credentials_seal(self.adapter,'fixture',digest)


class CredentialReader(unittest.TestCase):
    def test_real_reader_compares_only_selected_profile_and_rolls_back(self):
        self.run_case({})
    def run_case(self,changes,success=True,mode="compare"):
        node=os.environ.get('NODE_BINARY') or shutil.which('node')
        self.assertTrue(node,'Node runtime is required for the installed reader regression')
        facts={'source':'a'*40,'account':{'id':'account','environment':'REAL','version':7,'body':{'provider':'waha','gateway_ref':'WAHA_03','sending_enabled':False}},
            'sessions':[{'revision':8,'desired_state':'STOPPED','operational_pause':True,'recovery_enabled':False}],
            'profile':{'key':'waha:WAHA_03','type':'waha','enabled':False,'version':3,'config':{'base_url':'http://waha-03:3000'},'secrets':{'api_key':'synthetic-api','webhook_secret':'synthetic-hook'}}}
        for key,value in changes.items():
            target=facts;parts=key.split('.')
            for part in parts[:-1]:target=target[int(part)] if isinstance(target,list) else target[part]
            target[parts[-1]]=value
        fixture='''const fixture=FIXTURE;process.env.COMMERCE_RELEASE_SHA=fixture.source;const queries=[];const client={query:async(q,p)=>{queries.push(q);if(q.startsWith('SELECT'))return {rows:fixture.sessions};return {rows:[]}},release(){}};
const db={pool:{connect:async()=>client,end:async()=>{if(process.exitCode!==1&&(!queries.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')||queries.at(-1)!=='ROLLBACK'))throw Error('readonly')}},getRecord:async()=>fixture.account,readIntegrationSettings:async(c,w,e,k,o)=>{if(k!=='waha:WAHA_03'||o.secrets!==true)throw Error('scope');return fixture.profile}};'''.replace('FIXTURE',json.dumps(facts))
        program={'compare':a.CREDENTIAL_JS,'profile':a.PROFILE_JS,'export':a.EXPORT_JS}[mode].replace("const db=await import('./packages/db/src/index.ts');",fixture)
        data={'source_sha':'a'*40,'workspace':'synthetic-workspace','account_id':'account','account_version':7,'session_version':8,'profile_key':'waha:WAHA_03','api_key':'synthetic-api','webhook_secret':'synthetic-hook'}
        out=subprocess.run([node,'--input-type=module','-e',program],input=json.dumps(data),text=True,capture_output=True,timeout=10)
        self.assertEqual(out.returncode,0 if success else 1,out.stderr)
        if mode!='export' or not success:
            self.assertNotIn('synthetic-api',out.stdout+out.stderr);self.assertNotIn('synthetic-hook',out.stdout+out.stderr)
        if success:
            result=json.loads(out.stdout)
            if mode=='compare':self.assertEqual(result['credentials_match'],True)
            else:
                self.assertNotIn('credentials_match',result)
                self.assertTrue(result['secrets_present'] and result['secrets_valid'])
            if mode=='export':self.assertEqual(result.pop('credential_env'),'WAHA_API_KEY=synthetic-api\nWHATSAPP_HOOK_HMAC_KEY=synthetic-hook\n')
            self.assertNotIn('credential_env',result)
        else:self.assertEqual(out.stdout,'');self.assertEqual(out.stderr,'ADDITIONAL_EXISTING_PRIVATE_BINDING_FAILED\n')
    def test_profile_metadata_and_export_use_identical_existing_bytes_without_generation(self):
        self.run_case({},mode='profile');self.run_case({},mode='export')
        for mode in ('profile','export'):
            for value in ('contains$dollar','contains\nnewline','quote\'value','', 'sha512:'+'a'*128):
                with self.subTest(mode=mode,value=value):self.run_case({'profile.secrets.api_key':value},False,mode)
    def test_wrong_source_profile_credentials_or_mutable_account_fail_without_secret_output(self):
        for change in ({'source':'b'*40},{'account.version':8},{'account.body.gateway_ref':'WAHA_01'},
                       {'account.body.sending_enabled':True},{'sessions.0.revision':9},
                       {'sessions.0.operational_pause':False},{'profile.enabled':True},
                       {'profile.config.base_url':'http://waha-02:3000'},{'profile.secrets.api_key':'changed'},
                       {'profile.secrets.webhook_secret':'changed'}):
            with self.subTest(change=change):self.run_case(change,False)


if __name__=='__main__':unittest.main()
