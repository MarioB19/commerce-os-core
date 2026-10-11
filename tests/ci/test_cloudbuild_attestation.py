import copy
import json
from datetime import timedelta
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
import cloudbuild_attestation as m
import cloudbuild_admission as ledger
from test_cloudbuild_admission import NOW, ATTEMPT
import test_cloudbuild_controller as controller_tests
from test_cloudbuild_publish_status import NUMBER

GATE_ATTEMPT='44444444-4444-4444-8444-444444444444'
GATE_BUILD='55555555-5555-4555-8555-555555555555'
TRIGGER='66666666-6666-4666-8666-666666666666'


class GateTests(unittest.TestCase):
    def setUp(self):
        self.full=controller_tests.DispatchTests();self.full.setUp();self.full.dispatch();self.full.reconcile()
        self.store=self.full.store;self.moment=NOW+timedelta(minutes=2)
        self.contract={'build_id':GATE_BUILD,'trigger_id':TRIGGER,'repository_id':m.REPOSITORY_ID,
            'source_sha':'a'*40,'source_tree':'b'*40,'github_check_name':'provider-native-check-fixture',
            'image':'us-east1-docker.pkg.dev/'+m.PROJECT+'/commerce-ci-public/attestor@sha256:'+'6'*64,
            'substitutions':{'COMMIT_SHA':'a'*40,'SHORT_SHA':'a'*7},
            'full_manifest_sha256':m.canonical_hash(self.full.manifest)}
        self.build={**m.template(self.contract['image']),'id':GATE_BUILD,'projectId':m.PROJECT,
            'name':'projects/'+NUMBER+'/locations/us-east1/builds/'+GATE_BUILD,'buildTriggerId':TRIGGER,
            'source':{'connectedRepository':{'repository':m.CONNECTED_REPOSITORY,'revision':'a'*40}},
            'substitutions':self.contract['substitutions'],'status':'PENDING',
            'approval':{'state':'PENDING','config':{'approvalRequired':True}},'createTime':ledger.stamp(NOW)}
        plan=copy.deepcopy(self.full.plan);plan.update(stage='attestation',timeout_seconds=120,queue_seconds=14400,
            config_sha256=m.gate_binding(self.contract)['config_sha256'],verifier_sha256='6'*64)
        plan['identity']['event_id']='native-gate-'+GATE_BUILD
        approval={'plan_sha256':ledger.canonical_hash(plan),'review_sha256':'7'*64,
            'expires_at':ledger.stamp(self.moment+timedelta(hours=2))}
        admission={'approval_sha256':ledger.canonical_hash(approval),'inventory_sha256':'8'*64,
            'expires_at':approval['expires_at'],'projected_gross_microusd':99_000_000,
            'credit_verified':True,'inventory_complete':True}
        for op,fields in [('discover',{'plan':plan}),('approve_source',{'approval':approval}),('reserve',{'admission':admission})]:
            ledger.transact(self.store,{'op':op,'attempt_id':GATE_ATTEMPT,**fields},now=self.moment)
        self.eligibility=Mock(return_value={'approval_sha256':admission['approval_sha256'],
            'inventory_sha256':admission['inventory_sha256'],'observed_at':ledger.stamp(self.moment),'event_sha256':'9'*64})
        self.reader=self.full.reader;self.reader.evaluate.return_value={'state':'success'}
        self.api=Mock();self.api.build.side_effect=lambda _:copy.deepcopy(self.build)
        def approve(_):
            self.assertEqual(self.store.document['attempts'][GATE_ATTEMPT]['intent']['gate']['build_id'],GATE_BUILD)
            self.build['approval'].update(state='APPROVED',result={'decision':'APPROVED'})
            self.build.update(status='WORKING',startTime=ledger.stamp(self.moment))
            return {'metadata':{'build':{'id':GATE_BUILD}}}
        self.api.approve_once.side_effect=approve
        self.controller=m.GateController(self.store,self.api,self.reader,self.eligibility,clock=lambda:self.moment)
        self.bundle={'gate_attempt_id':GATE_ATTEMPT,'full_attempt_id':ATTEMPT,
                     'full_manifest':self.full.manifest,'contract':self.contract}

    def approve(self):return self.controller.approve(GATE_ATTEMPT,ATTEMPT,self.full.manifest,self.contract)
    def attest(self):return m.attest(self.bundle,self.store,self.api,self.reader,Mock())

    def test_gate_approval_uses_reserved_native_uuid_and_never_create(self):
        self.assertEqual(self.approve()['state'],'NATIVE_APPROVAL_CONFIRMED')
        self.assertEqual(self.approve()['state'],'RECONCILIATION_REQUIRED')
        self.api.approve_once.assert_called_once_with(GATE_BUILD);self.api.create_once.assert_not_called()
        self.assertEqual(self.store.document['attempts'][GATE_ATTEMPT]['state'],'UUID_BOUND')
        self.assertEqual(ledger.budget_usage(self.store.document,now=self.moment)['2026-10']['total_seconds'],240)

    def test_lost_approval_response_holds_reservation_and_is_never_retried(self):
        self.api.approve_once.side_effect=OSError('private network detail')
        self.assertEqual(self.approve()['state'],'UNKNOWN')
        self.assertEqual(self.approve()['state'],'RECONCILIATION_REQUIRED')
        self.assertEqual(self.store.document['active_attempt'],GATE_ATTEMPT)
        self.api.approve_once.assert_called_once();self.api.create_once.assert_not_called()

    def test_lost_cas_readback_never_approves(self):
        self.store.lose_response=True
        with self.assertRaisesRegex(RuntimeError,'WRITE_RESPONSE_LOST'):self.approve()
        self.api.approve_once.assert_not_called()

    def test_failed_full_never_approves_pending_gate(self):
        self.reader.evaluate.return_value={'state':'failure'}
        with self.assertRaisesRegex(RuntimeError,'ATTESTATION_NATIVE_FULL_REQUIRED'):self.approve()
        self.api.approve_once.assert_not_called()

    def test_slow_native_full_read_expires_eligibility_before_intent(self):
        def slow(_):
            self.moment+=timedelta(seconds=121);return {'state':'success'}
        self.reader.evaluate.side_effect=slow
        with self.assertRaisesRegex(RuntimeError,'CONTROLLER_ELIGIBILITY_STALE'):self.approve()
        self.api.approve_once.assert_not_called()
        self.assertNotIn('intent',self.store.document['attempts'][GATE_ATTEMPT])

    def test_slow_confirmed_cas_consumes_intent_but_never_approves_after_expiry(self):
        original=self.store.compare_and_swap
        def slow(expected,document):
            result=original(expected,document);self.moment+=timedelta(seconds=121);return result
        self.store.compare_and_swap=slow
        self.assertEqual(self.approve()['state'],'UNKNOWN')
        self.api.approve_once.assert_not_called()
        self.assertIn('intent',self.store.document['attempts'][GATE_ATTEMPT])

    def test_nonpending_or_implicit_approval_gate_never_dispatches(self):
        for mutate in [lambda b:b.update(status='WORKING'),lambda b:b['approval']['config'].update(approvalRequired=False)]:
            original=copy.deepcopy(self.build);mutate(self.build)
            with self.assertRaises(RuntimeError):self.approve()
            self.build=original
        self.api.approve_once.assert_not_called()

    def test_source_revision_trigger_and_privileged_step_changes_are_rejected(self):
        changes=[lambda b:b['source']['connectedRepository'].update(revision='refs/heads/main'),
                 lambda b:b.update(buildTriggerId='77777777-7777-4777-8777-777777777777'),
                 lambda b:b['steps'][0].update(args=['candidate.py']),
                 lambda b:b['steps'][0].update(secretEnv=['SECRET']),
                 lambda b:b.update(serviceAccount='projects/x/serviceAccounts/privileged@example.invalid')]
        for mutate in changes:
            original=copy.deepcopy(self.build);mutate(self.build)
            with self.subTest(mutate=mutate),self.assertRaises(RuntimeError):self.approve()
            self.build=original
        self.api.approve_once.assert_not_called()

    def test_attestor_rereads_full_and_native_approval_before_pass_receipt(self):
        self.approve();receipt=self.attest()
        self.assertEqual(receipt['status'],'PASSED');self.assertEqual(receipt['gate_build_id'],GATE_BUILD)
        self.assertFalse(receipt['github_check_published']);self.assertFalse(receipt['deployment_proven'])
        self.reader.evaluate.return_value={'state':'failure'}
        with self.assertRaisesRegex(RuntimeError,'ATTESTATION_NATIVE_FULL_REQUIRED'):self.attest()

    def test_attestor_rejects_superseded_event(self):
        self.approve();events=Mock(side_effect=RuntimeError('EVENT_HEAD_SUPERSEDED'))
        with self.assertRaisesRegex(RuntimeError,'EVENT_HEAD_SUPERSEDED'):
            m.attest(self.bundle,self.store,self.api,self.reader,events)

    def test_gate_cannot_be_submitted_as_storage_source_build(self):
        with self.assertRaisesRegex(RuntimeError,'ATTESTATION_APPROVAL_INTENT_REQUIRED'):
            ledger.transact(self.store,{'op':'submit_intent','attempt_id':GATE_ATTEMPT,
                'source':{'bucket':'synthetic-source','object':'gate/fake.tgz','generation':'1','archive_sha256':'1'*64},
                'nonce':'88888888-8888-4888-8888-888888888888','request_sha256':'2'*64},now=self.moment)
        self.api.create_once.assert_not_called()

    def test_real_trigger_options_are_required_without_relaxing_full_options(self):
        self.build['options']['dynamicSubstitutions']=False
        with self.assertRaisesRegex(RuntimeError,'ATTESTATION_OPTIONS_MISMATCH'):self.approve()

    def terminal(self):
        self.approve();self.build['status']='SUCCESS';self.build['steps'][0].update(status='SUCCESS',exitCode=0)
        self.build['sourceProvenance']={'resolvedConnectedRepository':self.build['source']['connectedRepository']}
        self.build['finishTime']=ledger.stamp(self.moment+timedelta(seconds=30));self.moment+=timedelta(minutes=1)
        self.log={'resource':{'type':'build','labels':{'build_id':GATE_BUILD,'project_id':m.PROJECT}},
            'textPayload':'Step #0 - "Commerce-V7-native-attestation": '+json.dumps(m.expected_receipt(self.contract,self.full.manifest))}
        self.api.attestation_logs.return_value=[self.log]
        self.check={'id':123,'app':{'id':10529},'name':self.contract['github_check_name'],'head_sha':'a'*40,
            'status':'completed','conclusion':'success','details_url':'https://console.cloud.google.com/cloud-build/builds;region=us-east1/'+GATE_BUILD+'?project='+m.PROJECT}
    def reconcile(self):
        return self.controller.reconcile(GATE_ATTEMPT,ATTEMPT,self.full.manifest,self.contract,lambda _:self.check)

    def test_terminal_native_receipt_and_actual_app_check_are_all_required(self):
        self.terminal();self.assertEqual(self.reconcile()['state'],'ATTESTATION_PASSED')
        self.assertIsNone(self.store.document['active_attempt'])
        self.assertEqual(ledger.budget_usage(self.store.document,now=self.moment)['2026-10']['confirmed_seconds'],180)

    def test_neutral_wrong_app_old_head_or_other_build_never_pass(self):
        self.terminal()
        for mutation in [lambda c:c.update(conclusion='neutral'),lambda c:c['app'].update(id=1),
                         lambda c:c.update(head_sha='b'*40),lambda c:c.update(details_url='https://example.invalid/')]:
            original=copy.deepcopy(self.check);mutation(self.check)
            with self.assertRaisesRegex(RuntimeError,'ATTESTATION_GITHUB_APP_CHECK_NOT_PROVEN'):self.reconcile()
            self.check=original
            self.assertEqual(self.store.document['active_attempt'],GATE_ATTEMPT)
        self.assertEqual(self.store.document['attempts'][GATE_ATTEMPT]['state'],'TERMINAL_UNRECONCILED')

    def test_duplicate_or_missing_receipts_never_pass(self):
        self.terminal()
        for logs in [[],[self.log,self.log]]:
            self.api.attestation_logs.return_value=logs
            with self.assertRaisesRegex(RuntimeError,'ATTESTATION_ONE_EXACT_RECEIPT_REQUIRED'):self.reconcile()
            self.assertEqual(self.store.document['active_attempt'],GATE_ATTEMPT)

    def test_unknown_approval_reconciles_pending_without_resend(self):
        self.api.approve_once.side_effect=OSError();self.approve();self.check={}
        self.assertEqual(self.reconcile()['state'],'UNKNOWN_APPROVAL_NOT_OBSERVED')
        self.api.approve_once.assert_called_once();self.assertEqual(self.store.document['active_attempt'],GATE_ATTEMPT)


if __name__=='__main__':unittest.main()
