"""Factory integration with real ledger transitions, no network/cloud effects."""
import base64
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
import hashlib
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudbuild_runtime as m
from test_cloudbuild_admission import MemoryStore, NOW, ATTEMPT, observation
import test_cloudbuild_controller as controller_tests


def config():
    return {'schema_version': 1, 'role': 'controller', 'project': m.PROJECT,
        'project_number': m.PROJECT_NUMBER, 'repository_id': m.REPOSITORY_ID, 'mode': 'active',
        **{k: {'bucket': 'private-custody', 'object': 'runtime/' + k + '.json', 'minimum_generation': '1'}
           for k in ('ledger', 'control', 'meter')},
        'custody': {'bucket': 'private-custody', 'prefix': 'runtime'},
        'sources': {'bucket': 'private-source', 'prefix': 'full'},
        'adoption': {'month': '2026-10', 'minimum_confirmed_seconds': 4440, 'evidence_sha256': '1' * 64}}


def descriptor(task):
    raw = json.dumps(task, sort_keys=True, separators=(',', ':')).encode()
    return {'bucket': 'private-custody', 'object': 'runtime/tasks/task.json', 'generation': '2',
        'sha256': hashlib.sha256(raw).hexdigest(), 'size': len(raw), 'md5': base64.b64encode(hashlib.md5(raw).digest()).decode()}


class FactoryTests(unittest.TestCase):
    def setUp(self):
        self.fixture = controller_tests.DispatchTests(); self.fixture.setUp(); f = self.fixture
        self.moment = NOW
        old = observation(status='FAILURE', build='99999999-9999-4999-8999-999999999999',
                          start=NOW - timedelta(minutes=74), seconds=4440)
        m.ledger.transact(f.store, {'op': 'account_external', 'observation': old, 'native_verified': True}, now=NOW)
        attempt = f.store.document['attempts'][ATTEMPT]
        self.task = {'schema_version': 1, 'operation': 'DISPATCH_FULL', 'phase': 'DISPATCH',
            'attempt_id': ATTEMPT, **{k: deepcopy(attempt[k]) for k in ('plan', 'approval', 'admission')},
            'event': {'kind': 'main', 'repository_id': m.REPOSITORY_ID, 'source_sha': f.manifest['source_sha'],
                      'source_tree': f.manifest['source_tree'], 'base_sha': f.manifest['source_sha']},
            'payload': {'proposal': f.proposal}, 'expires_at': m.ledger.stamp(NOW + timedelta(hours=4))}
        self.factory = m.RuntimeFactory(config(), clock=lambda: self.moment)
        r = self.factory
        self.control = {'schema_version': 1, 'mode': 'active', 'expires_at': self.task['expires_at'], 'task': descriptor(self.task)}
        r.control_store = Mock(); r.control_store.load.side_effect = lambda: ('10', deepcopy(self.control))
        r.custody = Mock(); r.custody.read_json.side_effect = lambda _ref: deepcopy(self.task)
        r.ledger_store = f.store; r.source_reader = Mock(); r.api = f.api; r.full_reader = f.reader
        r.github = Mock(); r.github.current_event.return_value = {'event_sha256': '7' * 64}
        r.inventory_snapshot = Mock(); r.inventory_snapshot.return_value = {'complete': True, 'inventory_sha256': self.task['admission']['inventory_sha256']}

    def work(self): return self.factory.inspect_work()

    def test_end_to_end_dispatch_with_real_ledger_and_native_response(self):
        result = self.factory.execute(self.work())
        self.assertEqual(result['state'], 'UUID_BOUND'); self.assertEqual(result['request_outcome'], 'CONFIRMED')
        self.fixture.api.create_once.assert_called_once()
        self.assertEqual(m.ledger.budget_usage(self.fixture.store.document, now=NOW)['2026-10']['confirmed_seconds'], 4440)

    def test_pause_during_submit_cas_consumes_intent_without_post(self):
        original = self.fixture.store.compare_and_swap
        def pause(expected, document):
            result = original(expected, document)
            if document['attempts'][ATTEMPT]['state'] == 'SUBMIT_INTENT': self.control['mode'] = 'paused'
            return result
        self.fixture.store.compare_and_swap = pause
        result = self.factory.execute(self.work())
        self.assertEqual(result['request_outcome'], 'UNKNOWN')
        self.assertIn('intent', self.fixture.store.document['attempts'][ATTEMPT])
        self.fixture.api.create_once.assert_not_called()

    def test_newer_github_head_after_cas_never_posts(self):
        self.factory.github.current_event.side_effect = [{'event_sha256': '7' * 64}, RuntimeError('HEAD_SUPERSEDED')]
        result = self.factory.execute(self.work())
        self.assertEqual(result['request_outcome'], 'UNKNOWN')
        self.fixture.api.create_once.assert_not_called()
        self.assertIn('intent', self.fixture.store.document['attempts'][ATTEMPT])

    def test_unknown_native_post_retains_ledger_and_reports_unknown(self):
        self.fixture.api.create_once.side_effect = OSError('private data not returned')
        result = self.factory.execute(self.work())
        self.assertEqual(result['request_outcome'], 'UNKNOWN')
        self.assertEqual(self.fixture.store.document['active_attempt'], ATTEMPT)
        self.assertNotIn('private data', repr(result))

    def test_control_paused_after_inspection_never_creates(self):
        work = self.work(); self.control['mode'] = 'paused'
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_CONTROL_CHANGED'): self.factory.execute(work)
        self.fixture.api.create_once.assert_not_called()

    def test_mutated_or_forged_work_never_dispatches(self):
        work = self.work()
        with self.assertRaisesRegex(RuntimeError, 'WORK_NOT_ISSUED'): self.factory.execute(replace(work))
        work.task['payload']['proposal']['archive_sha256'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'WORK_CHANGED'): self.factory.execute(work)
        self.fixture.api.create_once.assert_not_called()

    def test_shadow_or_paused_does_not_read_task_or_source(self):
        for field in ('config', 'control'):
            self.factory.config['mode'] = 'shadow' if field == 'config' else 'active'
            self.control['mode'] = 'paused' if field == 'control' else 'active'
            self.assertIsNone(self.work())
        self.factory.custody.read_json.assert_not_called(); self.factory.source_reader.connect.assert_not_called()

    def test_inventory_changed_never_persists_submit_intent(self):
        self.factory.inventory_snapshot.return_value['inventory_sha256'] = '0' * 64
        with self.assertRaisesRegex(RuntimeError, 'INVENTORY_CHANGED'): self.factory.execute(self.work())
        self.assertNotIn('intent', self.fixture.store.document['attempts'][ATTEMPT])
        self.fixture.api.create_once.assert_not_called()

    def test_post_cas_inventory_cannot_outlive_approval_with_later_task_expiry(self):
        # Custody validity is not the source/economic approval's lifetime.
        expiry = NOW + timedelta(hours=4)
        self.task['expires_at'] = m.ledger.stamp(expiry + timedelta(hours=1))
        self.control['expires_at'] = self.task['expires_at']
        self.moment = expiry - timedelta(seconds=50)
        calls = 0
        def inventory():
            nonlocal calls
            calls += 1
            if calls == 2: self.moment += timedelta(seconds=51)
            return {'complete': True, 'inventory_sha256': self.task['admission']['inventory_sha256']}
        self.factory.inventory_snapshot.side_effect = inventory
        result = self.factory.execute(self.work())
        self.assertEqual(result['request_outcome'], 'UNKNOWN'); self.assertEqual(calls, 2)
        self.fixture.api.create_once.assert_not_called()
        self.assertIn('intent', self.fixture.store.document['attempts'][ATTEMPT])

    def test_inventory_read_taking_121_seconds_cannot_dispatch(self):
        def slow():
            self.moment += timedelta(seconds=121)
            return {'complete': True, 'inventory_sha256': self.task['admission']['inventory_sha256']}
        self.factory.inventory_snapshot.side_effect = slow
        with self.assertRaisesRegex(RuntimeError, 'ELIGIBILITY_EXPIRED'): self.factory.execute(self.work())
        self.fixture.api.create_once.assert_not_called()

    def test_adoption_floor_rejects_missing_native_usage(self):
        self.fixture.store.document['external_builds'] = {}
        with self.assertRaisesRegex(RuntimeError, 'HISTORICAL_USAGE_NOT_ADOPTED'): self.factory.execute(self.work())
        self.fixture.api.create_once.assert_not_called()

    def test_task_with_different_event_tree_fails_before_credential(self):
        self.task['event']['source_tree'] = '0' * 40
        with self.assertRaisesRegex(RuntimeError, 'EVENT_PLAN_MISMATCH'): self.work()
        self.factory.source_reader.connect.assert_not_called()

    def test_expired_task_fails_before_credential(self):
        self.task['expires_at'] = m.ledger.stamp(NOW)
        with self.assertRaisesRegex(RuntimeError, 'TASK_EXPIRED'): self.work()
        self.factory.source_reader.connect.assert_not_called()

    def test_controller_cannot_accept_attestor_run(self):
        self.task.update(operation='ATTEST', phase='RUN'); self.task['plan']['stage'] = 'attestation'
        self.task['plan']['timeout_seconds'] = 120
        with self.assertRaisesRegex(RuntimeError, 'TASK_ROLE_MISMATCH'): self.work()

    def test_admit_preserves_old_usage_and_reserves_only_one_new_attempt(self):
        self.task['phase'] = 'ADMIT'; f = self.fixture
        del f.store.document['attempts'][ATTEMPT]; f.store.document['events'] = {}; f.store.document['active_attempt'] = None
        result = self.factory.execute(self.work())
        self.assertEqual(result['state'], 'RESERVED'); f.api.create_once.assert_not_called()
        usage = m.ledger.budget_usage(f.store.document, now=NOW)['2026-10']
        self.assertEqual(usage, {'confirmed_seconds': 4440, 'reserved_seconds': 5700, 'total_seconds': 10140})

    def test_abort_replayed_admit_never_claims_reserved(self):
        self.task['phase'] = 'ADMIT'
        m.ledger.transact(self.fixture.store, {'op':'abort_before_dispatch','attempt_id':ATTEMPT,
            'evidence_sha256':'a'*64,'native_verified':True}, now=NOW)
        before = deepcopy(self.fixture.store.document)
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_ADMISSION_NOT_RESERVED'):
            self.factory.execute(self.work())
        self.assertEqual(self.fixture.store.document, before)
        self.fixture.api.create_once.assert_not_called()

    def test_source_repeated_acquisition_intent_never_reclones(self):
        self.task.update(operation='SOURCE', phase='ACQUIRE')
        self.task['payload'] = {'source_approval': {'repository_id': m.REPOSITORY_ID,
            **{k: self.task['plan']['identity'][k] for k in ('source_sha', 'source_tree')},
            'review_sha256': self.task['approval']['review_sha256'],
            **{k: self.task['plan'][k] for k in ('runner_sha256', 'workflow_sha256')}},
            'journal': {'bucket': 'private-custody', 'object': 'runtime/source-journals/' + ATTEMPT + '.json', 'minimum_generation': '1'}}
        with patch.object(m, 'DurableEffectJournal') as journal, patch.object(m, 'prepare_archive') as clone:
            journal.return_value.commit_intent.return_value = {'effect': None}
            with self.assertRaisesRegex(RuntimeError, 'ACQUISITION_ALREADY_CONSUMED'): self.factory.execute(self.work())
            clone.assert_not_called()


class SourcePipelineTests(FactoryTests):
    # Reuse setup only; this class's load_tests below selects its own cases.
    def source_fixture(self):
        from cloudbuild_effect_journal import initial_journal
        self.task.update(operation='SOURCE', phase='ACQUIRE')
        self.task['payload'] = {'source_approval': {'repository': m.REPOSITORY, 'repository_id': m.REPOSITORY_ID,
            **{k: self.task['plan']['identity'][k] for k in ('source_sha', 'source_tree')},
            'review_sha256': self.task['approval']['review_sha256'], 'expires_at': self.task['expires_at'],
            **{k: self.task['plan'][k] for k in ('runner_sha256', 'workflow_sha256')}},
            'journal': {'bucket': 'private-custody', 'object': 'runtime/source-journals/' + ATTEMPT + '.json', 'minimum_generation': '1'}}
        binding = {'attempt_id': ATTEMPT, 'plan_sha256': m.ledger.canonical_hash(self.task['plan']),
                   'source_sha': self.task['plan']['identity']['source_sha']}
        self.journal_store = MemoryStore(initial_journal(binding))
        self.factory._store = Mock(return_value=self.journal_store)
        self.factory.sources = Mock(bucket='private-source', prefix='full/')

    def test_source_cannot_use_publisher_or_controller_journal(self):
        self.source_fixture()
        for prefix in ('journals', 'controller-journals'):
            with self.subTest(prefix=prefix):
                self.task['payload']['journal']['object'] = 'runtime/' + prefix + '/' + ATTEMPT + '.json'
                with self.assertRaisesRegex(RuntimeError, 'JOURNAL_PATH_CHANGED'):
                    self.factory.execute(self.work())
        self.factory._store.assert_not_called()
        self.factory.sources.upload_source_once.assert_not_called()
        self.assertEqual(self.journal_store.document['actions'], {})

    def test_source_acquisition_result_persists_before_upload(self):
        self.source_fixture()
        data = b'archive fixture'
        def acquire(directory, approval, reader):
            path = directory / 'source.tgz'; path.write_bytes(data)
            return {'archive_path': str(path), 'archive_bytes': len(data), 'archive_sha256': hashlib.sha256(data).hexdigest()}
        def upload(path, expected, journal, attempt_id):
            acquired = self.journal_store.document['actions']['source-acquire:' + ATTEMPT]['result']
            self.assertEqual(acquired['status'], 'RECONCILED'); self.assertEqual(acquired['expected'], expected)
            self.assertEqual(Path(path).read_bytes(), data)
            return {'state': 'SOURCE_UPLOADED_AND_VERIFIED', 'descriptor': {**expected, 'generation': '5'}}
        self.factory.sources.upload_source_once.side_effect = upload
        with patch.object(m, 'prepare_archive', side_effect=acquire):
            self.assertEqual(self.factory.execute(self.work())['request_outcome'], 'CONFIRMED')
        self.assertEqual(self.journal_store.document['revision'], 2)

    def test_source_failed_acquisition_stays_consumed_and_cannot_retry(self):
        self.source_fixture()
        with patch.object(m, 'prepare_archive', side_effect=OSError('private clone failure')) as clone:
            with self.assertRaises(OSError): self.factory.execute(self.work())
            with self.assertRaisesRegex(RuntimeError, 'ACQUISITION_ALREADY_CONSUMED'): self.factory.execute(self.work())
            self.assertEqual(clone.call_count, 1)
        self.assertIsNone(self.journal_store.document['actions']['source-acquire:' + ATTEMPT]['result'])
        self.factory.sources.upload_source_once.assert_not_called()

    def test_source_reconcile_never_uploads_or_clones(self):
        self.source_fixture()
        from cloudbuild_effect_journal import DurableEffectJournal
        journal = DurableEffectJournal(self.journal_store, self.fixture.store,
            self.journal_store.document['binding'], clock=lambda: NOW)
        action = 'source-acquire:' + ATTEMPT
        intent = journal.commit_intent(action, self.task['payload']['source_approval'])
        expected = {'bucket': 'private-source', 'object': 'full/' + ATTEMPT + '.tgz', 'size': 7,
                    'sha256': '0' * 64, 'md5': base64.b64encode(b'0' * 16).decode()}
        journal.record_result(action, {'status': 'RECONCILED', 'intent_sha256': intent['intent_sha256'], 'expected': expected})
        journal.commit_intent('source-upload:' + ATTEMPT, expected)
        self.task['phase'] = 'RECONCILE'
        self.factory.sources.reconcile_source.return_value = {**expected, 'generation': '5'}
        with patch.object(m, 'prepare_archive') as clone:
            self.assertEqual(self.factory.execute(self.work())['request_outcome'], 'CONFIRMED')
            clone.assert_not_called()
        self.factory.sources.upload_source_once.assert_not_called()
        result = self.journal_store.document['actions']['source-upload:' + ATTEMPT]['result']
        self.assertEqual(result['native_id'], '5'); self.assertEqual(result['status'], 'RECONCILED')


class AttestorTests(unittest.TestCase):
    def setUp(self):
        import test_cloudbuild_attestation as gates
        self.gate = gates.GateTests(); self.gate.setUp(); self.gate.approve()
        self.gate.build['name'] = 'projects/' + m.PROJECT + '/locations/us-east1/builds/' + self.gate.contract['build_id']
        self.gate.reader.project.return_value = {'projectId': m.PROJECT, 'projectNumber': m.PROJECT_NUMBER}
        f = self.gate
        old = observation(status='FAILURE', build='99999999-9999-4999-8999-999999999999',
                          start=NOW - timedelta(minutes=74), seconds=4440)
        m.ledger.transact(f.store, {'op': 'account_external', 'observation': old, 'native_verified': True}, now=f.moment)
        attempt = f.store.document['attempts'][gates.GATE_ATTEMPT]
        self.task = {'schema_version': 1, 'operation': 'ATTEST', 'phase': 'RUN', 'attempt_id': gates.GATE_ATTEMPT,
            **{k: deepcopy(attempt[k]) for k in ('plan', 'approval', 'admission')},
            'event': {'kind': 'main', 'repository_id': m.REPOSITORY_ID, 'source_sha': 'a' * 40,
                      'source_tree': 'b' * 40, 'base_sha': 'a' * 40},
            'payload': f.bundle, 'expires_at': m.ledger.stamp(NOW + timedelta(hours=4))}
        self.factory = m.RuntimeFactory(config() | {'role': 'attestor'}, clock=lambda: f.moment)
        r = self.factory
        control = {'schema_version': 1, 'mode': 'active', 'expires_at': self.task['expires_at'], 'task': descriptor(self.task)}
        self.control = control
        r.control_store = Mock(); r.control_store.load.side_effect = lambda: ('10', deepcopy(self.control))
        r.custody = Mock(); r.custody.read_json.side_effect = lambda _ref: deepcopy(self.task)
        r.ledger_store = f.store; r.source_reader = Mock(); r.api = f.api; r.full_reader = f.reader
        r.github = Mock(); r.github.current_event.return_value = {'event_sha256': '7' * 64}

    def test_running_native_gate_full_and_custody_produce_receipt_without_post(self):
        result = self.factory.run_attestor(self.gate.contract['build_id'])
        self.assertEqual(result['status'], 'PASSED'); self.assertFalse(result['deployment_proven'])
        self.factory.api.create_once.assert_not_called()
        self.assertEqual(self.factory.api.approve_once.call_count, 1)  # setup only

    def test_mismatched_uuid_or_nonrunning_native_build_never_attests(self):
        with self.assertRaisesRegex(RuntimeError, 'ATTESTOR_BUILD_CHANGED'):
            self.factory.run_attestor('99999999-9999-4999-8999-999999999999')
        self.gate.build['status'] = 'QUEUED'
        with self.assertRaisesRegex(RuntimeError, 'ATTESTOR_NOT_RUNNING'):
            self.factory.run_attestor(self.gate.contract['build_id'])

    def test_full_failure_or_source_superseded_rejects_receipt(self):
        self.factory.full_reader.evaluate.return_value = {'state': 'failure'}
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_FULL_REQUIRED'):
            self.factory.run_attestor(self.gate.contract['build_id'])
        self.factory.full_reader.evaluate.return_value = {'state': 'success'}
        self.factory.github.current_event.side_effect = RuntimeError('HEAD_SUPERSEDED')
        with self.assertRaisesRegex(RuntimeError, 'HEAD_SUPERSEDED'):
            self.factory.run_attestor(self.gate.contract['build_id'])

    def test_control_pause_during_full_read_prevents_receipt(self):
        def slow(_manifest):
            self.control['mode'] = 'paused'
            return {'state': 'success'}
        self.factory.full_reader.evaluate.side_effect = slow
        with self.assertRaisesRegex(RuntimeError, 'CONTROL_CHANGED'):
            self.factory.run_attestor(self.gate.contract['build_id'])

    def test_expiry_during_full_read_prevents_receipt(self):
        def slow(_manifest):
            self.gate.moment += timedelta(hours=4)
            return {'state': 'success'}
        self.factory.full_reader.evaluate.side_effect = slow
        with self.assertRaisesRegex(RuntimeError, 'CONTROL_EXPIRED|TASK_EXPIRED|EXPIRED'):
            self.factory.run_attestor(self.gate.contract['build_id'])

    def test_attestor_cannot_call_controller_executor(self):
        with self.assertRaisesRegex(RuntimeError, 'CONTROLLER_REQUIRED'):
            self.factory.execute(self.factory.inspect_work())


class BoundaryTests(unittest.TestCase):
    def test_fixed_factory_construction_has_no_network(self):
        with patch.object(urllib.request.OpenerDirector, 'open', side_effect=AssertionError('network')):
            value = m.RuntimeFactory(config())
        self.assertIsInstance(value.meter_store, m.ExistingStore)

    def test_repeated_inventory_observations_use_fresh_native_readers(self):
        from test_cloudbuild_project_inventory import Remote
        real = m.ProjectInventory; remote = Remote(); readers = []
        def reader(token, number):
            value = real(lambda: 'fixture', number, opener=remote); readers.append(value); return value
        factory = m.RuntimeFactory(config())
        with patch.object(m, 'ProjectInventory', side_effect=reader):
            first = factory.inventory_snapshot(); second = factory.inventory_snapshot()
        self.assertEqual(len(readers), 2); self.assertIsNot(readers[0], readers[1])
        self.assertEqual(first['inventory_sha256'], second['inventory_sha256'])
        self.assertEqual(len(remote.calls), 6)

    def test_config_rejects_dynamic_fields_and_lost_usage(self):
        for change in ({'factory': 'evil.module'}, {'repository_id': 1359063164}, {'role': 'publisher'}, {'mode': 'unsafe'}):
            with self.assertRaises(RuntimeError): m.validate_config(config() | change)
        cfg = config(); cfg['adoption']['minimum_confirmed_seconds'] = 0
        with self.assertRaisesRegex(RuntimeError, 'USAGE_MUST_BE_PRESERVED'): m.validate_config(cfg)

    def test_store_absence_and_rewind_fail_closed_without_cas(self):
        underlying = Mock(); underlying.load.side_effect = [('4', {'x': 1}), ('3', {'x': 1})]
        store = m.ExistingStore(underlying, '2'); self.assertEqual(store.load()[0], '4')
        with self.assertRaisesRegex(RuntimeError, 'MISSING_OR_REWOUND'): store.load()
        underlying.compare_and_swap.assert_not_called()
        underlying.load.side_effect = None; underlying.load.return_value = ('0', None)
        with self.assertRaises(RuntimeError): store.load()

    def test_identity_rejects_personal_or_other_service_account(self):
        identity = m.RoleIdentity('attestor'); identity._read = Mock(return_value=b'user@example.test')
        with self.assertRaisesRegex(RuntimeError, 'IDENTITY_CHANGED'): identity()
        self.assertEqual(identity._read.call_count, 1)

    def test_identity_uses_exact_adc_metadata_and_retains_token_only_in_ram(self):
        identity = m.RoleIdentity('attestor')
        identity._read = Mock(side_effect=[identity.email.encode(), b'{"access_token":"opaque-fixture","expires_in":3600,"token_type":"Bearer"}'])
        self.assertEqual(identity(), 'opaque-fixture')
        self.assertNotIn('opaque-fixture', vars(identity))


import urllib.request
def load_tests(loader, _tests, _pattern):
    suite = unittest.TestSuite()
    for cls in (FactoryTests, SourcePipelineTests, AttestorTests, BoundaryTests):
        for name in cls.__dict__:
            if name.startswith('test_'): suite.addTest(cls(name))
    return suite

if __name__ == '__main__': unittest.main()
