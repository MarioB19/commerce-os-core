"""Native adapter composition with real durable journals and ledger, no cloud."""
from copy import deepcopy
from datetime import timedelta
import hashlib
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudbuild_runtime as runtime
import cloudbuild_runtime_release as m
from cloudbuild_gcs_store import encode
from cloudbuild_effect_journal import initial_journal
from test_cloudbuild_admission import NOW, ATTEMPT, BUILD, MemoryStore, approval, admission, observation
import test_cloudbuild_publisher_worker as workers


class CompositionTests(unittest.TestCase):
    def setUp(self):
        fixture = workers.WorkerTests(); fixture.setUp()
        self.body = deepcopy(fixture.body); self.contract = deepcopy(fixture.task['contract']); self.contract.pop('build_id')
        self.contract['task_sha256'] = hashlib.sha256(encode(self.body)).hexdigest()
        plan = deepcopy(fixture.task['plan'])
        plan['config_sha256'] = m.ledger.canonical_hash(m.publisher.template({**self.contract, 'build_id': m.SHAPE_UUID}))
        target = {'bucket': 'fixture-custody', 'object': 'runtime/controller-journals/' + ATTEMPT + '.json', 'minimum_generation': '1'}
        self.bundle = {'body': self.body, 'contract': self.contract, 'journal': target, 'phase': 'INSTALL'}
        self.task = {'schema_version': 1, 'operation': 'PUBLISH', 'phase': 'PREPARE', 'attempt_id': ATTEMPT,
                     'plan': plan, 'approval': approval(value=plan), 'admission': admission(value=plan),
                     'event': {'kind': 'main', 'repository_id': runtime.REPOSITORY_ID, 'source_sha': 'a' * 40,
                               'source_tree': 'b' * 40, 'base_sha': 'a' * 40},
                     'payload': self.bundle, 'expires_at': self.body['expires_at']}
        self.parent = MemoryStore(m.ledger.new_ledger())
        m.ledger.transact(self.parent, {'op': 'account_external', 'observation': observation(status='FAILURE',
            build='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', start=NOW-timedelta(minutes=74), seconds=4440), 'native_verified': True}, now=NOW)
        for op, key in [('discover', 'plan'), ('approve_source', 'approval'), ('reserve', 'admission')]:
            m.ledger.transact(self.parent, {'op': op, 'attempt_id': ATTEMPT, key: self.task[key]}, now=NOW)
        self.stores = {}; self.controller_store = MemoryStore(initial_journal(m.binding(self.task)))
        self.control = MemoryStore({'schema_version': 1, 'mode': 'paused', 'expires_at': self.task['expires_at'], 'task': None})
        self.bundle['initial_control'] = {'generation': '1', 'document': deepcopy(self.control.document)}
        self.stores['runtime/publisher-control.json'] = self.control
        self.stores[target['object']] = self.controller_store
        def store(bucket, name, transport=None):
            self.assertEqual(bucket, 'fixture-custody')
            value = self.stores.setdefault(name, MemoryStore())
            value.media = lambda observed, size: encode(value.document)
            return value
        self.make_store = store
        f = Mock(); self.factory = f
        f.config = {'custody': {'bucket': 'fixture-custody', 'prefix': 'runtime'}, 'sources': {'bucket': 'fixture-source', 'prefix': 'full'}, 'project_number': runtime.PROJECT_NUMBER}
        f.clock = lambda: NOW; f.ledger_store = self.parent
        f._current.side_effect = lambda work: deepcopy(self.task)
        f._ledger.side_effect = self.parent.load
        f._store.side_effect = lambda where: store(where['bucket'], where['object'])
        f.custody.read_json.side_effect = lambda ref: deepcopy(store(ref['bucket'], ref['object']).document)
        self.work = SimpleNamespace(task=self.task, control_expires_at=self.task['expires_at'])
        self.pipeline = m.ReleaseRuntime(f, self.work)
        self.native = {**m.publisher.template({**self.contract, 'build_id': BUILD}), 'id': BUILD,
            'projectId': runtime.PROJECT, 'name': 'projects/' + runtime.PROJECT + '/locations/us-east1/builds/' + BUILD,
            'status': 'WORKING', 'source': {'storageSource': self.contract['storage_source']}}
        f.api.build.return_value = self.native

    def prepare(self):
        with patch.object(m, 'GCSAdmissionStore', side_effect=self.make_store):
            return self.pipeline.prepare(self.bundle)

    def bind_ledger(self):
        contract = {**self.contract, 'build_id': BUILD}; source = {**contract['storage_source'], 'archive_sha256': contract['archive_sha256']}
        m.ledger.transact(self.parent, {'op': 'submit_intent', 'attempt_id': ATTEMPT, 'source': source,
            'nonce': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'request_sha256': m.ledger.canonical_hash(m.publisher.create_request(contract))}, now=NOW)
        m.ledger.transact(self.parent, {'op': 'bind', 'attempt_id': ATTEMPT, 'build_id': BUILD, 'source': source,
            'config_sha256': self.task['plan']['config_sha256'], 'native_evidence_sha256': '7' * 64}, now=NOW)

    def bind(self):
        with patch.object(m, 'GCSAdmissionStore', side_effect=self.make_store): return self.pipeline.bind(self.bundle, BUILD)

    def test_prepare_four_intents_separate_journals_and_no_build(self):
        result = self.prepare(); self.assertEqual(result['state'], 'PUBLISHER_PREPARED')
        self.assertEqual(len(self.controller_store.document['actions']), 4)
        worker = self.stores['runtime/journals/' + ATTEMPT + '.json']
        self.assertEqual(worker.document, initial_journal(m.binding(self.task)))
        self.assertIsNot(worker, self.controller_store); self.assertEqual(worker.document['revision'], 0)
        task = self.factory.custody.read_json(self.control.document['task'])
        workers.m.validate_task(task, BUILD, NOW, preparing=True)
        workers.m.validate_body(self.body, task, NOW)
        self.assertEqual(task['contract']['build_id'], m.SHAPE_UUID)
        self.assertEqual(task['body_ref']['sha256'], hashlib.sha256(encode(self.body)).hexdigest())
        self.factory.api.create_once.assert_not_called()

    def test_prepare_redelivery_has_no_second_cas(self):
        self.prepare(); counts = {k: v.cas_count for k, v in self.stores.items()}
        self.assertEqual(self.prepare()['state'], 'PUBLISHER_PREPARED')
        self.assertEqual(counts, {k: v.cas_count for k, v in self.stores.items()})

    def test_bind_exact_native_uuid_after_ledger_is_readable_by_worker(self):
        self.prepare(); self.bind_ledger()
        result = self.bind(); self.assertEqual(result['state'], 'PUBLISHER_BOUND')
        task = self.factory.custody.read_json(self.control.document['task'])
        workers.m.validate_task(task, BUILD, NOW)
        self.assertEqual(task['operation'], 'PUBLISH'); self.assertEqual(task['contract']['build_id'], BUILD)
        self.assertEqual(len(self.controller_store.document['actions']), 6)
        self.assertEqual(self.control.cas_count, 2)
        self.factory.api.create_once.assert_not_called()

    def test_bind_before_native_ledger_does_not_write(self):
        self.prepare(); count = self.controller_store.cas_count
        with self.assertRaisesRegex(RuntimeError, 'BINDING_CHANGED'): self.bind()
        self.assertEqual(self.controller_store.cas_count, count); self.assertEqual(self.control.cas_count, 1)

    def test_binding_expiry_during_native_read_consumes_no_new_intent(self):
        self.prepare(); self.bind_ledger()
        def slow(_): self.factory.clock = lambda: NOW + timedelta(hours=6); return self.native
        self.factory.api.build.side_effect = slow
        with self.assertRaises(RuntimeError): self.bind()
        self.assertEqual(len(self.controller_store.document['actions']), 4)

    def test_task_or_control_expiry_during_final_ledger_read_stops_binding(self):
        for expiry_kind in ('task', 'control'):
            with self.subTest(expiry_kind=expiry_kind):
                self.setUp(); self.prepare(); self.bind_ledger()
                if expiry_kind == 'task':
                    self.task['expires_at'] = m.ledger.stamp(NOW + timedelta(seconds=1))
                else: self.work.control_expires_at = m.ledger.stamp(NOW + timedelta(seconds=1))
                calls = 0
                def final_read():
                    nonlocal calls
                    calls += 1
                    if calls == 2: self.factory.clock = lambda: NOW + timedelta(seconds=2)
                    return self.parent.load()
                self.factory._ledger.side_effect = final_read
                with self.assertRaisesRegex(RuntimeError, 'EXPIRED'):
                    self.pipeline.bound_fence(BUILD, {**self.contract, 'build_id': BUILD})
                self.assertEqual(len(self.controller_store.document['actions']), 4)

    def test_terminal_native_worker_cannot_gain_late_binding(self):
        self.prepare(); self.bind_ledger(); self.native['status'] = 'FAILURE'
        with self.assertRaisesRegex(RuntimeError, 'BINDING_TOO_LATE'): self.bind()
        self.assertEqual(self.control.cas_count, 1)

    def test_missing_control_is_not_bootstrapped(self):
        self.control.document = None; self.control.generation = '0'
        with self.assertRaisesRegex(RuntimeError, 'CAS_BASE_CHANGED'): self.prepare()
        self.assertEqual(self.control.cas_count, 0)

    def test_missing_controller_journal_never_recreates(self):
        self.controller_store.document = None; self.controller_store.generation = '0'
        with self.assertRaisesRegex(RuntimeError, 'JOURNAL_MISSING'): self.prepare()
        self.assertEqual(self.controller_store.cas_count, 0)

    def test_custody_changed_hash_or_colliding_journal_rejected(self):
        self.bundle['body']['installation_attempt'] = '2'
        with self.assertRaisesRegex(RuntimeError, 'BODY_CHANGED'): self.prepare()
        self.bundle['body']['installation_attempt'] = '1'
        self.bundle['journal']['object'] = self.body['journal']['object']
        with self.assertRaisesRegex(RuntimeError, 'CONTROLLER_JOURNAL_CHANGED'): self.prepare()

    def test_lost_object_write_reconciles_without_recreating(self):
        where = 'runtime/journals/' + ATTEMPT + '.json'; target = self.make_store('fixture-custody', where); target.lose_response = True
        self.assertEqual(self.prepare()['state'], 'UNKNOWN'); self.assertEqual(target.cas_count, 1)
        self.assertEqual(self.prepare()['state'], 'PUBLISHER_PREPARED'); self.assertEqual(target.cas_count, 1)

    def test_control_lost_cas_reconciles_without_replay(self):
        self.control.lose_response = True
        self.assertEqual(self.prepare()['state'], 'UNKNOWN')
        self.assertEqual(self.prepare()['state'], 'PUBLISHER_PREPARED')
        self.assertEqual(self.control.cas_count, 1)

    def test_pause_after_custody_intent_consumes_without_target_creation(self):
        self.factory._fence.side_effect = [None, RuntimeError('PAUSED')]
        self.assertEqual(self.prepare()['state'], 'UNKNOWN')
        target = self.stores['runtime/journals/' + ATTEMPT + '.json']
        self.assertEqual(target.cas_count, 0); self.assertEqual(len(self.controller_store.document['actions']), 1)

    def test_dispatch_prepares_and_binds_in_same_request_without_replaying_post(self):
        proposal = {'kind': 'publisher', 'contract': self.contract,
                    'release_admission': self.body['release_admission']}
        self.task.update(phase='DISPATCH', payload={'proposal': proposal, 'custody': self.bundle})
        self.pipeline = m.ReleaseRuntime(self.factory, self.work)
        self.pipeline.controller = Mock()
        def dispatch(*_):
            prepared = self.factory.custody.read_json(self.control.document['task'])
            self.assertEqual(prepared['operation'], 'PUBLISH_PREPARED')
            self.bind_ledger(); return {'state': 'UUID_BOUND', 'build_id': BUILD}
        self.pipeline.controller.dispatch.side_effect = dispatch
        self.pipeline.controller.reconcile.return_value = {'state': 'PENDING', 'build_id': BUILD}
        with patch.object(m, 'GCSAdmissionStore', side_effect=self.make_store):
            self.assertEqual(self.pipeline.execute()['state'], 'PUBLISHER_BOUND')
            self.assertEqual(self.pipeline.execute()['state'], 'PUBLISHER_BOUND')
        self.pipeline.controller.dispatch.assert_called_once()
        self.pipeline.controller.reconcile.assert_called_once()
        self.assertEqual(self.control.cas_count, 2)

    def test_bound_intent_source_cannot_be_substituted_even_with_same_template(self):
        self.prepare(); self.bind_ledger()
        self.parent.document['attempts'][ATTEMPT]['intent']['source']['generation'] = '999'
        with self.assertRaisesRegex(RuntimeError, 'INTENT_CHANGED'): self.bind()
        self.assertEqual(self.control.cas_count, 1)

    def test_lost_bound_control_reply_is_get_only_reconciled(self):
        self.prepare(); self.bind_ledger(); self.control.lose_response = True
        self.assertEqual(self.bind()['state'], 'UNKNOWN'); self.assertEqual(self.control.cas_count, 2)
        self.assertEqual(self.bind()['state'], 'PUBLISHER_BOUND'); self.assertEqual(self.control.cas_count, 2)

    def test_runtime_image_copy_set_imports_release_composition_without_sdk_or_network(self):
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            paths = list((root / 'scripts').glob('cloudbuild_*.py')) + [root / 'scripts' / name
                for name in ('cloudbuild-http.py', 'cloudbuild-attest.py', 'ci_release.py',
                             'ci_provider_evidence.py', 'ephemeral_os_login.py', 'operator_identity.py')]
            for path in paths: shutil.copyfile(path, target / path.name)
            code = 'import sys; sys.path.insert(0,sys.argv[1]); import cloudbuild_runtime_release, cloudbuild_publisher_worker'
            result = subprocess.run([sys.executable, '-I', '-c', code, str(target)], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_new_runtime_stages_are_reserved_and_wrong_stage_rejected(self):
        runtime.validate_task(self.task, lambda: NOW)
        for operation in ('PACKAGE', 'PUBLISH'):
            value = deepcopy(self.task); value['operation'] = operation; value['phase'] = 'DISPATCH'
            if operation == 'PACKAGE': value['plan']['stage'] = 'package'; value['plan']['timeout_seconds'] = 1800
            runtime.validate_task(value, lambda: NOW)
            value['plan']['stage'] = 'full'; value['plan']['timeout_seconds'] = 5700
            with self.assertRaisesRegex(RuntimeError, 'STAGE_MISMATCH'): runtime.validate_task(value, lambda: NOW)


if __name__ == '__main__': unittest.main()
