"""Real ledger transitions with synthetic native responses; no cloud effects."""
import copy
from datetime import timedelta
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudbuild_controller as m
import cloudbuild_admission as ledger
from test_cloudbuild_admission import MemoryStore, NOW, ATTEMPT
from test_cloudbuild_publish_status import fixture, NUMBER


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.manifest, self.build, self.github, self.receipt, self.logs = fixture()
        self.proposal = {key: value for key, value in self.manifest.items() if key != 'build_id'}
        self.build.update(createTime=ledger.stamp(NOW), startTime=ledger.stamp(NOW),
                          finishTime=ledger.stamp(NOW + timedelta(seconds=61)))
        self.moment = NOW
        self.plan = {'identity': {'repository_id':m.REPOSITORY_ID, 'event_id':'private-pr-49-head-fixture',
            'source_sha':self.manifest['source_sha'], 'source_tree':self.manifest['source_tree']},
            'stage':'full', 'timeout_seconds':5700, 'queue_seconds':600,
            'config_sha256':self.manifest['build_config_sha256'], 'verifier_sha256':'d'*64,
            'runner_sha256':'e'*64, 'workflow_sha256':'f'*64}
        approval = {'plan_sha256':ledger.canonical_hash(self.plan), 'review_sha256':'9'*64,
                    'expires_at':ledger.stamp(NOW+timedelta(hours=4))}
        admission = {'approval_sha256':ledger.canonical_hash(approval), 'inventory_sha256':'8'*64,
                     'expires_at':approval['expires_at'], 'projected_gross_microusd':99_000_000,
                     'credit_verified':True, 'inventory_complete':True}
        self.store = MemoryStore(ledger.new_ledger())
        for op, fields in [('discover',{'plan':self.plan}),('approve_source',{'approval':approval}),
                           ('reserve',{'admission':admission})]:
            ledger.transact(self.store, {'op':op,'attempt_id':ATTEMPT,**fields}, now=NOW)
        self.eligibility = Mock(return_value={'approval_sha256':admission['approval_sha256'],
            'inventory_sha256':admission['inventory_sha256'], 'observed_at':ledger.stamp(NOW),
            'event_sha256':'7'*64})
        self.api = Mock(); self.api.create_once.return_value = {'metadata':{'build':{'id':self.manifest['build_id']}}}
        self.api.build.side_effect = lambda _id:copy.deepcopy(self.build)
        self.api.inventory.return_value = [self.build]
        self.reader = Mock(); self.reader.project.return_value = {'projectId':m.PROJECT,'projectNumber':NUMBER}
        self.reader.commit.return_value = self.github; self.reader.logs.side_effect = lambda _:copy.deepcopy(self.logs)
        self.controller = m.FullController(self.store,self.api,self.reader,self.eligibility,clock=lambda:self.moment)

    def dispatch(self): return self.controller.dispatch_full(ATTEMPT,self.proposal)
    def reconcile(self):
        self.moment = NOW+timedelta(minutes=2)
        return self.controller.reconcile_full(ATTEMPT,self.proposal)

    def test_confirmed_cas_precedes_single_post_then_native_uuid_binds(self):
        def create(request):
            self.assertEqual(self.store.document['attempts'][ATTEMPT]['state'],'SUBMIT_INTENT')
            self.assertEqual(request['source'],{'storageSource':self.manifest['storage_source']})
            self.assertEqual(self.store.document['attempts'][ATTEMPT]['intent']['request_sha256'],ledger.canonical_hash(request))
            return {'metadata':{'build':{'id':self.manifest['build_id']}}}
        self.api.create_once.side_effect = create
        self.assertEqual(self.dispatch()['state'],'UUID_BOUND')
        self.assertEqual(self.dispatch()['state'],'RECONCILIATION_REQUIRED')
        self.api.create_once.assert_called_once()

    def test_lost_cas_response_never_calls_build_api(self):
        self.store.lose_response = True
        with self.assertRaisesRegex(RuntimeError,'WRITE_RESPONSE_LOST'): self.dispatch()
        self.api.create_once.assert_not_called()
        self.store.lose_response = False
        self.assertEqual(self.dispatch()['state'],'RECONCILIATION_REQUIRED')
        self.api.create_once.assert_not_called()

    def test_slow_cas_never_creates_after_eligibility_expires(self):
        original=self.store.compare_and_swap
        def slow(expected,document):
            result=original(expected,document);self.moment+=timedelta(seconds=121);return result
        self.store.compare_and_swap=slow
        self.assertEqual(self.dispatch()['state'],'UNKNOWN');self.api.create_once.assert_not_called()
        self.assertIn('intent',self.store.document['attempts'][ATTEMPT])
        self.assertEqual(self.dispatch()['state'],'RECONCILIATION_REQUIRED')
        self.api.create_once.assert_not_called()

    def test_lost_create_response_is_reconciled_by_unique_native_source_without_retry(self):
        self.api.create_once.side_effect = OSError('private transport details')
        self.assertEqual(self.dispatch()['state'],'UNKNOWN')
        self.assertEqual(self.store.document['active_attempt'],ATTEMPT)
        self.assertEqual(self.reconcile()['state'],'FULL_PASSED')
        self.assertIsNone(self.store.document['active_attempt'])
        self.assertEqual(ledger.budget_usage(self.store.document,now=self.moment)['2026-10']['confirmed_seconds'],120)
        self.api.create_once.assert_called_once()

    def test_zero_matches_do_not_release_unknown_or_resend(self):
        self.api.create_once.side_effect = OSError(); self.dispatch(); self.api.inventory.return_value = []
        self.assertEqual(self.reconcile()['state'],'UNKNOWN_NO_NATIVE_MATCH')
        self.assertEqual(self.store.document['active_attempt'],ATTEMPT)
        self.assertEqual(self.dispatch()['state'],'RECONCILIATION_REQUIRED'); self.api.create_once.assert_called_once()

    def test_multiple_matching_builds_block_instead_of_selecting_one(self):
        self.api.create_once.side_effect = OSError(); self.dispatch(); self.api.inventory.return_value = [self.build,self.build]
        self.assertEqual(self.reconcile()['state'],'BLOCKED_MULTIPLE_NATIVE_MATCHES')
        self.assertEqual(self.store.document['blocked']['reason'],'MULTIPLE_NATIVE_SOURCE_MATCHES')
        self.assertEqual(self.store.document['active_attempt'],ATTEMPT)

    def test_actual_failure_is_accounted_but_never_becomes_pass(self):
        self.build['status']='FAILURE'; self.dispatch()
        self.assertEqual(self.reconcile()['state'],'FULL_FAILED'); self.reader.logs.assert_not_called()
        self.assertEqual(self.store.document['attempts'][ATTEMPT]['terminal']['status'],'FAILURE')
        self.assertIsNone(self.store.document['active_attempt'])

    def test_native_success_missing_full_gate_retains_unreconciled_reservation(self):
        self.dispatch(); self.logs.clear()
        with self.assertRaises(m.EvidenceError): self.reconcile()
        self.assertEqual(self.store.document['attempts'][ATTEMPT]['state'],'TERMINAL_UNRECONCILED')
        self.assertEqual(self.store.document['active_attempt'],ATTEMPT)

    def test_replaced_source_or_plan_configuration_is_rejected(self):
        for mutation in [lambda p:p.update(source_tree='1'*40),
                         lambda p:p['build_config']['steps'][0]['args'].append('unreviewed')]:
            original=copy.deepcopy(self.proposal); mutation(self.proposal)
            with self.assertRaises(m.EvidenceError): self.dispatch()
            self.proposal=original
        self.api.create_once.assert_not_called()

    def test_replayed_proposal_cannot_change_source_object(self):
        self.dispatch(); self.proposal['storage_source']['generation']='24'
        with self.assertRaisesRegex(m.EvidenceError,'CONTROLLER_PROPOSAL_INTENT_MISMATCH'): self.reconcile()
        self.api.create_once.assert_called_once()

    def test_eligibility_expired_or_event_superseded_prevents_intent(self):
        self.eligibility.return_value['observed_at']=ledger.stamp(NOW-timedelta(minutes=3))
        with self.assertRaisesRegex(m.EvidenceError,'CONTROLLER_ELIGIBILITY_STALE'): self.dispatch()
        self.eligibility.side_effect=m.EvidenceError('EVENT_HEAD_SUPERSEDED')
        with self.assertRaisesRegex(m.EvidenceError,'EVENT_HEAD_SUPERSEDED'): self.dispatch()
        self.api.create_once.assert_not_called()
        self.assertEqual(self.store.document['attempts'][ATTEMPT]['state'],'RESERVED')

    def test_pending_build_does_not_release_global_reservation(self):
        self.build['status']='WORKING'; self.dispatch()
        self.assertEqual(self.reconcile()['state'],'PENDING')
        self.assertEqual(self.store.document['active_attempt'],ATTEMPT)

    def test_missing_native_execution_timing_never_infers_free_execution(self):
        self.build['status']='CANCELLED'; self.build.pop('startTime'); self.dispatch()
        with self.assertRaisesRegex(m.EvidenceError,'CONTROLLER_NATIVE_BILLABLE_INTERVAL_REQUIRED'): self.reconcile()
        self.assertEqual(self.store.document['active_attempt'],ATTEMPT)


class Response:
    status=200
    def __init__(self,value):self.raw=json.dumps(value).encode()
    def __enter__(self):return self
    def __exit__(self,*_):return False
    def read(self,n):return self.raw[:n]


class TransportTests(unittest.TestCase):
    def test_create_is_fixed_regional_endpoint_and_never_retried(self):
        opener=Mock(); opener.open.side_effect=OSError('token-do-not-leak')
        api=m.GoogleBuildAPI(lambda:'token-do-not-leak',opener=opener)
        with self.assertRaisesRegex(m.EvidenceError,'^CONTROLLER_API_OUTCOME_UNKNOWN$'):api.create_once({'fixture':True})
        self.assertEqual(opener.open.call_count,1)
        request=opener.open.call_args.args[0]
        self.assertEqual(request.full_url,m.ROOT+'/builds');self.assertEqual(request.method,'POST')
    def test_inventory_consumes_empty_continuation_and_rejects_repeated_token(self):
        opener=Mock();opener.open.side_effect=[Response({'nextPageToken':'opaque+/='}),Response({'builds':[{'id':'fixture'}]})]
        api=m.GoogleBuildAPI(lambda:'synthetic',opener=opener)
        self.assertEqual(api.inventory(),[{'id':'fixture'}]);self.assertEqual(opener.open.call_count,2)
        opener.open.side_effect=[Response({'nextPageToken':'again'}),Response({'nextPageToken':'again'})]
        with self.assertRaisesRegex(m.EvidenceError,'CONTROLLER_INVENTORY_TOKEN_INVALID'):api.inventory()
    def test_wrong_endpoint_rejected_without_credential_lookup(self):
        token=Mock();api=m.GoogleBuildAPI(token,opener=Mock())
        with self.assertRaisesRegex(m.EvidenceError,'CONTROLLER_API_TARGET_REJECTED'):
            api._request('POST','/triggers',{})
        token.assert_not_called()


if __name__=='__main__':unittest.main()
