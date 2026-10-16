"""Real admission/CAS transitions and native contract fixtures; no cloud calls."""
from copy import deepcopy
import base64
from datetime import timedelta
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudbuild_release_controller as m
from test_cloudbuild_admission import MemoryStore, NOW, ATTEMPT
from test_cloudbuild_native_package import PackageTests, PACKAGE


class ReleaseControllerTests(unittest.TestCase):
    def setUp(self):
        p = PackageTests(); p.setUp(); self.package = p; self.moment = NOW
        self.proposal = {'kind': 'package', 'verification': p.verify, 'inputs': p.inputs, 'replica': p.replica,
            'full_attempt_id': '11111111-1111-4111-8111-111111111111',
            'gate_attempt_id': '22222222-2222-4222-8222-222222222222', 'gate_contract': {}}
        self.build = deepcopy(p.build)
        self.build['name'] = 'projects/' + m.NUMBER + '/locations/us-east1/builds/' + PACKAGE
        self.build.update(createTime=m.ledger.stamp(NOW), startTime=m.ledger.stamp(NOW), finishTime=m.ledger.stamp(NOW + timedelta(seconds=61)))
        self.plan = {'identity': {'repository_id': m.REPOSITORY_ID, 'event_id': 'package-main-fixture',
            'source_sha': p.verify['source_sha'], 'source_tree': p.verify['source_tree']}, 'stage': 'package',
            'timeout_seconds': 1800, 'queue_seconds': 600, 'config_sha256': m.ledger.canonical_hash(m.package.build_config(p.inputs)),
            'verifier_sha256': 'f' * 64, 'runner_sha256': p.inputs['package_driver_sha256'], 'workflow_sha256': p.verify['workflow_sha256']}
        self.store = MemoryStore(m.ledger.new_ledger())
        approval = {'plan_sha256': m.ledger.canonical_hash(self.plan), 'review_sha256': 'a' * 64,
            'expires_at': m.ledger.stamp(NOW + timedelta(hours=4))}
        admission = {'approval_sha256': m.ledger.canonical_hash(approval), 'inventory_sha256': 'b' * 64,
            'expires_at': approval['expires_at'], 'projected_gross_microusd': 99_000_000,
            'credit_verified': True, 'inventory_complete': True}
        for op, field, value in [('discover', 'plan', self.plan), ('approve_source', 'approval', approval), ('reserve', 'admission', admission)]:
            m.ledger.transact(self.store, {'op': op, 'attempt_id': ATTEMPT, field: value}, now=NOW)
        self.api = Mock(); self.api.create_once.return_value = {'metadata': {'build': {'id': PACKAGE}}}
        self.api.build.side_effect = lambda _id: deepcopy(self.build); self.api.inventory.return_value = [self.build]
        self.reader = Mock(); self.reader.full_reader.project.return_value = {'projectId': m.PROJECT, 'projectNumber': m.NUMBER}
        self.reader.evidence.return_value = {'artifact_uri': p.uri, 'archive_sha256': 'c' * 64}
        self.controller = m.ReleaseController(self.store, self.api, self.reader, Mock(), Mock(), clock=lambda: self.moment)
        # Dispatch state-machine cases isolate already-authenticated dependencies.
        self.controller.dependencies = Mock(return_value=m.describe(self.proposal))

    def dispatch(self): return self.controller.dispatch(ATTEMPT, self.proposal)
    def reconcile(self):
        self.moment = NOW + timedelta(minutes=2)
        return self.controller.reconcile(ATTEMPT, self.proposal)

    def test_single_post_after_intent_and_two_dependency_reads(self):
        def post(_request):
            self.assertEqual(self.store.document['attempts'][ATTEMPT]['state'], 'SUBMIT_INTENT')
            self.assertEqual(self.controller.dependencies.call_count, 2)
            return {'metadata': {'build': {'id': PACKAGE}}}
        self.api.create_once.side_effect = post
        self.assertEqual(self.dispatch()['state'], 'UUID_BOUND')
        self.assertEqual(self.dispatch()['state'], 'RECONCILIATION_REQUIRED')
        self.api.create_once.assert_called_once()

    def test_unknown_cas_never_posts(self):
        self.store.lose_response = True
        with self.assertRaisesRegex(RuntimeError, 'WRITE_RESPONSE_LOST'): self.dispatch()
        self.api.create_once.assert_not_called()

    def test_dependency_closes_after_cas_keeps_intent_and_no_post(self):
        self.controller.dependencies.side_effect = [m.describe(self.proposal), RuntimeError('PAUSED')]
        self.assertEqual(self.dispatch()['state'], 'UNKNOWN')
        self.api.create_once.assert_not_called()
        self.assertIn('intent', self.store.document['attempts'][ATTEMPT])

    def test_lost_post_reconciles_unique_native_source_without_replay(self):
        self.api.create_once.side_effect = TimeoutError('lost')
        self.assertEqual(self.dispatch()['state'], 'UNKNOWN')
        self.assertEqual(self.reconcile()['state'], 'PACKAGE_EXECUTION_SUCCEEDED')
        self.api.create_once.assert_called_once()

    def test_failed_package_is_charged_without_artifact_or_success(self):
        self.build['status'] = 'FAILURE'; self.build['steps'][0]['status'] = 'FAILURE'
        self.build.pop('sourceProvenance'); self.build.pop('results')
        self.assertEqual(self.dispatch()['state'], 'UUID_BOUND')
        result = self.reconcile()
        self.assertEqual(result['state'], 'PACKAGE_FAILED'); self.assertFalse(result['deployment_proven'])
        self.reader.evidence.assert_not_called()
        self.assertEqual(m.ledger.budget_usage(self.store.document, now=self.moment)['2026-10']['confirmed_seconds'], 120)

    def test_success_missing_artifact_retains_reservation(self):
        self.dispatch(); self.reader.evidence.side_effect = RuntimeError('NATIVE_ARTIFACT_MISSING')
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_ARTIFACT_MISSING'): self.reconcile()
        self.assertEqual(self.store.document['active_attempt'], ATTEMPT)
        self.assertEqual(self.store.document['attempts'][ATTEMPT]['state'], 'TERMINAL_UNRECONCILED')

    def test_multiple_native_matches_block_without_new_post(self):
        self.api.create_once.side_effect = TimeoutError('lost'); self.dispatch()
        self.api.inventory.return_value = [self.build, deepcopy(self.build)]
        self.assertEqual(self.reconcile()['state'], 'BLOCKED_MULTIPLE_NATIVE_MATCHES')
        self.assertIsNotNone(self.store.document['blocked']); self.api.create_once.assert_called_once()

    def test_native_config_mismatch_is_not_bound(self):
        self.build['serviceAccount'] = 'attacker@example.invalid'
        self.assertEqual(self.dispatch()['state'], 'UNKNOWN')
        self.assertNotIn('build_id', self.store.document['attempts'][ATTEMPT])

    def test_missing_native_interval_keeps_budget(self):
        self.build.pop('startTime'); self.dispatch()
        with self.assertRaisesRegex(RuntimeError, 'BILLABLE_INTERVAL_REQUIRED'): self.reconcile()
        self.assertEqual(self.store.document['active_attempt'], ATTEMPT)

    def test_running_native_package_bound_without_artifact_claim(self):
        self.build['status'] = 'WORKING'; self.build['steps'][0]['status'] = 'WORKING'
        self.build.pop('sourceProvenance'); self.build.pop('results')
        self.assertEqual(self.dispatch()['state'], 'UUID_BOUND')
        self.assertEqual(self.reconcile()['state'], 'PENDING')
        self.reader.evidence.assert_not_called()

    def test_package_identity_does_not_open_artifact_gate(self):
        self.build['status'] = 'FAILURE'
        self.assertEqual(m.release.package_native_identity(self.package.admission, self.build, m.NUMBER), 'FAILURE')
        with self.assertRaisesRegex(RuntimeError, 'PACKAGE_NATIVE_BUILD_MISMATCH'):
            m.release.package_native(self.package.admission, self.build, m.NUMBER)
        for field in ('approval', 'logsBucket'):
            altered = deepcopy(self.build); altered[field] = {'unexpected': True}
            with self.assertRaisesRegex(RuntimeError, 'UNEXPECTED_NATIVE_INPUT'):
                m.release.package_native_identity(self.package.admission, altered, m.NUMBER)

    def dependency_fixture(self):
        import test_cloudbuild_attestation as gates
        g = gates.GateTests(); g.setUp(); g.terminal(); g.reconcile()
        self.moment = g.moment; old = deepcopy(self.store.document['attempts'][ATTEMPT])
        self.store = g.store; attempt_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        for op, field in [('discover', 'plan'), ('approve_source', 'approval'), ('reserve', 'admission')]:
            m.ledger.transact(self.store, {'op': op, 'attempt_id': attempt_id, field: old[field]}, now=self.moment)
        self.proposal.update(full_attempt_id=ATTEMPT, gate_attempt_id=gates.GATE_ATTEMPT, gate_contract=g.contract)
        g.build['name'] = 'projects/' + m.NUMBER + '/locations/us-east1/builds/' + g.contract['build_id']
        self.api.build.side_effect = lambda _id: deepcopy(g.build)
        self.api.attestation_logs.return_value = [g.log]
        self.reader.full_reader.evaluate.return_value = {'state': 'success'}
        github = Mock(); github.check.return_value = g.check
        eligibility = Mock(side_effect=lambda *_: {'approval_sha256': old['admission']['approval_sha256'],
            'inventory_sha256': old['admission']['inventory_sha256'], 'observed_at': m.ledger.stamp(self.moment),
            'event_sha256': 'd' * 64})
        self.controller = m.ReleaseController(self.store, self.api, self.reader, github, eligibility, clock=lambda: self.moment)
        return attempt_id, g

    def test_dependencies_require_actual_full_attestation_logs_and_app(self):
        attempt, _ = self.dependency_fixture()
        self.assertEqual(self.controller.dependencies(attempt, self.proposal)['stage'], 'package')
        self.controller.github.check.assert_called_once()
        self.api.attestation_logs.return_value = []
        with self.assertRaisesRegex(RuntimeError, 'ONE_EXACT_RECEIPT_REQUIRED'):
            self.controller.dependencies(attempt, self.proposal)
        self.api.create_once.assert_not_called()

    def test_expiry_during_native_full_never_returns_eligibility(self):
        attempt, _ = self.dependency_fixture()
        def advance(_):
            self.moment += timedelta(hours=5)
            return {'state': 'success'}
        self.reader.full_reader.evaluate.side_effect = advance
        with self.assertRaisesRegex(RuntimeError, 'APPROVAL_EXPIRED'):
            self.controller.dependencies(attempt, self.proposal)
        self.api.create_once.assert_not_called()

    def test_pause_during_last_eligibility_is_seen_after_read(self):
        attempt, _ = self.dependency_fixture(); original = self.controller.eligibility_reader.side_effect; calls = 0
        def pause(*args):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.store.document['blocked'] = {'reason': 'synthetic-pause', 'evidence_sha256': 'e' * 64}
            return original(*args)
        self.controller.eligibility_reader.side_effect = pause
        with self.assertRaisesRegex(RuntimeError, 'FINAL_LEDGER_CHANGED'):
            self.controller.dependencies(attempt, self.proposal)
        self.api.create_once.assert_not_called()

    def test_final_ledger_read_cannot_outlive_native_eligibility(self):
        attempt, _ = self.dependency_fixture()
        eligibility = self.controller.eligibility_reader.side_effect
        load = self.store.load
        final_read = False
        calls = 0
        def observed(*args):
            nonlocal final_read, calls
            calls += 1
            result = eligibility(*args)
            if calls == 2:
                self.moment += timedelta(seconds=119)
                final_read = True
            return result
        def slow_final_load():
            nonlocal final_read
            if final_read:
                self.moment += timedelta(seconds=2)
                final_read = False
            return load()
        self.controller.eligibility_reader.side_effect = observed
        self.store.load = slow_final_load
        with self.assertRaisesRegex(RuntimeError, 'ELIGIBILITY_STALE'):
            self.controller.dependencies(attempt, self.proposal)
        self.api.create_once.assert_not_called()

    def publisher_fixture(self):
        from test_cloudbuild_publisher_contract import fixture
        contract, _ = fixture(); contract['attempt_id'] = ATTEMPT
        contract['archive_sha256'] = self.package.verify['archive_sha256']
        native_id = contract.pop('build_id')
        self.proposal = {'kind': 'publisher', 'contract': contract, 'release_admission': self.package.admission,
            'full_attempt_id': '11111111-1111-4111-8111-111111111111',
            'package_attempt_id': '22222222-2222-4222-8222-222222222222',
            'gate_attempt_id': '33333333-3333-4333-8333-333333333333', 'gate_contract': {}}
        details = m.describe(self.proposal, native_id)
        self.plan.update(stage='publisher', timeout_seconds=900, config_sha256=m.ledger.canonical_hash(details['config']),
            verifier_sha256=contract['image'].rsplit(':', 1)[1], runner_sha256=contract['driver_sha256'])
        approval = {'plan_sha256': m.ledger.canonical_hash(self.plan), 'review_sha256': 'a' * 64,
            'expires_at': m.ledger.stamp(NOW + timedelta(hours=4))}
        admission = {'approval_sha256': m.ledger.canonical_hash(approval), 'inventory_sha256': 'b' * 64,
            'expires_at': approval['expires_at'], 'projected_gross_microusd': 99_000_000,
            'credit_verified': True, 'inventory_complete': True}
        self.store = MemoryStore(m.ledger.new_ledger()); self.controller.store = self.store
        for op, field, value in [('discover', 'plan', self.plan), ('approve_source', 'approval', approval), ('reserve', 'admission', admission)]:
            m.ledger.transact(self.store, {'op': op, 'attempt_id': ATTEMPT, field: value}, now=NOW)
        self.build = {**m.publisher.create_request(details['contract']), 'id': native_id, 'projectId': m.PROJECT,
            'name': 'projects/' + m.NUMBER + '/locations/us-east1/builds/' + native_id, 'status': 'SUCCESS',
            'createTime': m.ledger.stamp(NOW), 'startTime': m.ledger.stamp(NOW),
            'finishTime': m.ledger.stamp(NOW + timedelta(seconds=61))}
        self.build['steps'][0].update(status='SUCCESS', exitCode=0)
        locator = contract['storage_source']; uri = 'gs://' + locator['bucket'] + '/' + locator['object']
        self.build['sourceProvenance'] = {'resolvedStorageSource': deepcopy(locator), 'fileHashes': {uri: {
            'fileHash': [{'type': 'SHA256', 'value': base64.b64encode(bytes.fromhex(contract['archive_sha256'])).decode()}]}}}
        self.api.create_once.return_value = {'metadata': {'build': {'id': native_id}}}
        self.controller.dependencies.return_value = details

    def test_publisher_native_success_accounts_execution_without_deployment_claim(self):
        self.publisher_fixture()
        self.assertEqual(self.dispatch()['state'], 'UUID_BOUND')
        result = self.reconcile()
        self.assertEqual(result['state'], 'PUBLISHER_EXECUTION_SUCCEEDED')
        self.assertFalse(result['deployment_proven']); self.reader.evidence.assert_not_called()
        self.assertEqual(m.ledger.budget_usage(self.store.document, now=self.moment)['2026-10']['confirmed_seconds'], 120)

    def test_publisher_candidate_uuid_and_changed_source_rejected(self):
        self.publisher_fixture()
        self.proposal['contract']['build_id'] = self.build['id']
        with self.assertRaisesRegex(RuntimeError, 'UUID_MUST_NOT_BE_INVENTED'): self.dispatch()
        self.proposal['contract'].pop('build_id'); self.proposal['contract']['archive_sha256'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'VERIFICATION_SOURCE_CHANGED'): self.dispatch()
        self.api.create_once.assert_not_called()


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromTestCase(ReleaseControllerTests)


if __name__ == '__main__': unittest.main()
