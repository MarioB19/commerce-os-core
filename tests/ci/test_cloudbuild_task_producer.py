"""Producer contracts using native-shaped existing fixtures; no network effects."""
from copy import deepcopy
from datetime import timedelta
from pathlib import Path
import sys,unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import cloudbuild_task_producer as m
from test_cloudbuild_admission import NOW,ATTEMPT
from test_cloudbuild_controller import DispatchTests
from test_cloudbuild_attestation import GateTests,GATE_ATTEMPT
from test_cloudbuild_publish_status import NUMBER

class Tests(unittest.TestCase):
 def setUp(self):
  self.f=DispatchTests();self.f.setUp();self.expires=m.ledger.stamp(NOW+timedelta(hours=4))
  self.event={'kind':'main','repository_id':m.REPOSITORY_ID,'source_sha':self.f.manifest['source_sha'],'source_tree':self.f.manifest['source_tree'],'base_sha':self.f.manifest['source_sha']}
  self.plan=m.full_plan(self.event,event_id='main-full-reviewed',build_config=self.f.manifest['build_config'],verifier_image=self.f.manifest['verifier_image'],runner_sha256=self.f.manifest['runner_sha256'],workflow_sha256=self.f.manifest['workflow_sha256'])
  self.economic={'inventory_sha256':'8'*64,'expires_at':self.expires,'projected_gross_microusd':99_323_827,'credit_verified':True,'inventory_complete':True}
  self.auth=m.authorization(self.plan,review_sha256='9'*64,economic=self.economic,expires_at=self.expires,moment=NOW)
 def test_plan_admission_source_and_dispatch_share_hashes(self):
  admit=m.full_task('ADMIT',ATTEMPT,self.event,self.auth,expires_at=self.expires,moment=NOW)
  journal={'bucket':'private-custody','object':'core/source-journals/'+ATTEMPT+'.json','minimum_generation':'5'}
  source=m.source_task(ATTEMPT,self.event,self.auth,journal,custody={'bucket':'private-custody','prefix':'core'},expires_at=self.expires,moment=NOW)
  dispatch=m.full_task('DISPATCH',ATTEMPT,self.event,self.auth,proposal=self.f.proposal,expires_at=self.expires,moment=NOW)
  for value in (admit,source,dispatch):self.assertEqual(value['plan'],self.plan);self.assertEqual(value['approval'],self.auth['approval'])
  self.assertEqual(source['payload']['source_approval']['review_sha256'],'9'*64)
  self.assertNotIn('build_id',dispatch['payload']['proposal']);self.assertEqual(admit['payload'],{})
 def test_paused_control_never_contains_work(self):
  self.assertEqual(m.paused_control(expires_at=self.expires,moment=NOW),{'schema_version':1,'mode':'paused','expires_at':self.expires,'task':None})
 def test_expired_and_over_four_hour_window_rejected(self):
  for expiry in (NOW,NOW+timedelta(hours=4,seconds=1)):
   with self.subTest(expiry=expiry),self.assertRaisesRegex(RuntimeError,'WINDOW'):m.paused_control(expires_at=m.ledger.stamp(expiry),moment=NOW)
 def test_task_cannot_outlive_review_or_economics(self):
  self.auth['approval']['expires_at']=m.ledger.stamp(NOW+timedelta(hours=3));self.auth['admission']['approval_sha256']=m.ledger.canonical_hash(self.auth['approval'])
  with self.assertRaisesRegex(RuntimeError,'AUTHORIZATION_WINDOW'):m.full_task('ADMIT',ATTEMPT,self.event,self.auth,expires_at=self.expires,moment=NOW)
 def test_no_credit_or_incomplete_inventory_or_over_budget_rejected(self):
  for key,value in [('credit_verified',False),('inventory_complete',False),('projected_gross_microusd',100_000_001)]:
   e={**self.economic,key:value}
   with self.subTest(key=key),self.assertRaises(RuntimeError):m.authorization(self.plan,review_sha256='9'*64,economic=e,expires_at=self.expires,moment=NOW)
 def test_reconcile_retains_the_same_native_source_without_retry_flag(self):
  value=m.full_task('RECONCILE',ATTEMPT,self.event,self.auth,proposal=self.f.proposal,expires_at=self.expires,moment=NOW)
  self.assertEqual(value['operation'],'RECONCILE_FULL');self.assertEqual(value['payload']['proposal'],self.f.proposal)
 def test_source_wrong_journal_or_zero_generation_rejected(self):
  for obj,gen in [('core/journals/'+ATTEMPT+'.json','5'),('core/source-journals/'+ATTEMPT+'.json','0')]:
   with self.subTest(obj=obj,gen=gen),self.assertRaises(RuntimeError):m.source_task(ATTEMPT,self.event,self.auth,{'bucket':'private-custody','object':obj,'minimum_generation':gen},custody={'bucket':'private-custody','prefix':'core'},expires_at=self.expires,moment=NOW)
 def test_source_event_and_plan_mismatch_rejected(self):
  event={**self.event,'source_sha':'c'*40,'base_sha':'c'*40}
  with self.assertRaisesRegex(RuntimeError,'EVENT_PLAN'):m.full_task('ADMIT',ATTEMPT,event,self.auth,expires_at=self.expires,moment=NOW)
 def test_proposal_new_image_or_tree_cannot_inherit_approval(self):
  for key,value in [('source_tree','c'*40),('runner_sha256','c'*64)]:
   proposal={**self.f.proposal,key:value}
   with self.subTest(key=key),self.assertRaises(RuntimeError):m.full_task('DISPATCH',ATTEMPT,self.event,self.auth,proposal=proposal,expires_at=self.expires,moment=NOW)
 def test_attestation_requires_authentic_pending_build_and_reconciled_full(self):
  g=GateTests();g.setUp();plan=m.attestation_plan(self.event,event_id='main-attest-reviewed',contract=g.contract,driver_sha256='4'*64,workflow_sha256='f'*64)
  auth=m.authorization(plan,review_sha256='9'*64,economic=self.economic,expires_at=self.expires,moment=g.moment)
  kwargs=dict(full_attempt_id=ATTEMPT,full_manifest=g.full.manifest,contract=g.contract,native_build=g.build,document=g.store.document,project_number=NUMBER,expires_at=self.expires,moment=g.moment)
  result=m.attestation_task('APPROVE',GATE_ATTEMPT,self.event,auth,**kwargs);self.assertEqual(result['payload']['contract']['build_id'],g.build['id'])
  changed=deepcopy(auth);changed_event={**self.event,'source_sha':'c'*40,'source_tree':'d'*40,'base_sha':'c'*40}
  changed['plan']['identity'].update(source_sha='c'*40,source_tree='d'*40)
  changed['approval']['plan_sha256']=m.ledger.canonical_hash(changed['plan']);changed['admission']['approval_sha256']=m.ledger.canonical_hash(changed['approval'])
  for phase in ('ADMIT','APPROVE'):
   with self.subTest(phase=phase),self.assertRaisesRegex(RuntimeError,'GATE_PLAN_BINDING_MISMATCH'):m.attestation_task(phase,GATE_ATTEMPT,changed_event,changed,**kwargs)
  g.build['status']='WORKING'
  with self.assertRaisesRegex(RuntimeError,'ALREADY_STARTED'):m.attestation_task('APPROVE',GATE_ATTEMPT,self.event,auth,**kwargs)
  g.build['status']='PENDING';g.store.document['attempts'][ATTEMPT]['terminal']['status']='FAILURE'
  with self.assertRaisesRegex(RuntimeError,'RECONCILED_FULL'):m.attestation_task('APPROVE',GATE_ATTEMPT,self.event,auth,**kwargs)
if __name__=='__main__':unittest.main()
