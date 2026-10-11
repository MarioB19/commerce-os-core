from copy import deepcopy
from datetime import timedelta
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudbuild_custody_writer as m
from cloudbuild_effect_journal import DurableEffectJournal, initial_journal, fresh_binding
from test_cloudbuild_admission import MemoryStore, reserved, NOW, ATTEMPT


class CustodyWriterTests(unittest.TestCase):
    def setUp(self):
        self.parent = MemoryStore(reserved())
        _, binding = fresh_binding(self.parent, ATTEMPT, NOW)
        self.journal_store = MemoryStore(initial_journal(binding))
        self.journal = DurableEffectJournal(self.journal_store, self.parent, binding, clock=lambda: NOW)
        self.stores = {}; self.fences = 0
        def fence(): self.fences += 1
        def store(bucket, name):
            value = self.stores.setdefault((bucket, name), MemoryStore())
            def media(observed, size):
                self.assertEqual(observed, value.generation)
                return getattr(value, 'raw_override', m.encode(value.document))
            value.media = media
            return value
        self.writer = m.PublisherCustodyWriter('private-custody', 'runtime/v7', store, fence=fence)
        self.value = {'schema_version': 1, 'attempt_id': ATTEMPT, 'fixture': 'protected bytes'}

    def create(self, kind='body', value=None):
        return self.writer.create_once(kind, ATTEMPT, self.value if value is None else value, self.journal)

    def test_immutable_create_and_replay_never_write_twice(self):
        result = self.create(); self.assertEqual(result['state'], 'CUSTODY_CONFIRMED')
        store = next(iter(self.stores.values())); self.assertEqual(store.cas_count, 1)
        self.assertEqual(self.create()['state'], 'RECONCILIATION_REQUIRED')
        self.assertEqual(store.cas_count, 1); self.assertEqual(self.fences, 1)
        self.assertEqual(store.document, self.value)

    def test_deleted_object_is_not_recreated_after_committed_intent(self):
        self.create(); store = next(iter(self.stores.values())); store.document = None; store.generation = '0'
        self.assertEqual(self.create()['state'], 'RECONCILIATION_REQUIRED')
        self.assertEqual(store.cas_count, 1)
        with self.assertRaises(RuntimeError):
            self.writer.reconcile('custody-body:' + ATTEMPT, self.writer.payload('body', ATTEMPT, self.value), self.journal)
        self.assertIsNone(store.document)

    def test_lost_cas_response_reconciles_by_read_only(self):
        target = self.writer.target('body', ATTEMPT); store = self.writer.store_factory(self.writer.bucket, target)
        store.lose_response = True
        self.assertEqual(self.create()['state'], 'UNKNOWN'); self.assertEqual(store.cas_count, 1)
        result = self.writer.reconcile('custody-body:' + ATTEMPT, self.writer.payload('body', ATTEMPT, self.value), self.journal)
        self.assertEqual(result['state'], 'CUSTODY_CONFIRMED'); self.assertEqual(store.cas_count, 1)
        self.assertEqual(self.create()['state'], 'RECONCILIATION_REQUIRED')

    def test_pause_after_intent_does_not_write_and_retains_intent(self):
        def paused(): raise RuntimeError('PAUSED')
        self.writer.fence = paused
        self.assertEqual(self.create()['state'], 'UNKNOWN')
        self.assertEqual(next(iter(self.stores.values())).cas_count, 0)
        self.assertIn('custody-body:' + ATTEMPT, self.journal_store.document['actions'])

    def test_changed_replay_and_out_of_scope_kind_rejected(self):
        self.create()
        with self.assertRaisesRegex(RuntimeError, 'REPLAY_PAYLOAD_CHANGED'): self.create(value={'changed': True})
        for kind in ('ledger', 'control', '../meter', 'controller-journal'):
            with self.assertRaisesRegex(RuntimeError, 'KIND_REJECTED'): self.create(kind)
        with self.assertRaisesRegex(RuntimeError, 'DOCUMENT_BOUND'): self.create('prepared', {'big': 'x' * m.MAX_JSON})

    def test_worker_journal_only_initial_exact_attempt_binding(self):
        expected = initial_journal(self.journal.binding)
        self.assertEqual(self.create('worker-journal', expected)['state'], 'CUSTODY_CONFIRMED')
        changed = deepcopy(expected); changed['binding']['source_sha'] = 'f' * 40
        with self.assertRaisesRegex(RuntimeError, 'BINDING_CHANGED'): self.create('worker-journal', changed)

    def prepared(self):
        task = self.create('prepared')['descriptor']; expiry = m.ledger.stamp(NOW + timedelta(hours=1))
        before = {'schema_version': 1, 'mode': 'paused', 'expires_at': expiry, 'task': None}
        name = self.writer.prefix + '/publisher-control.json'
        control = MemoryStore(before); self.stores[(self.writer.bucket, name)] = control
        return task, expiry, before, control

    def test_control_prepared_then_bound_uses_exact_two_cas(self):
        task, expiry, before, control = self.prepared()
        result = self.writer.control_once('prepared', ATTEMPT, '1', before, task, expiry, self.journal)
        self.assertEqual(result['state'], 'CUSTODY_CONFIRMED'); self.assertEqual(control.cas_count, 1)
        bound = self.create('bound')['descriptor']; old = deepcopy(control.document); generation = control.generation
        result = self.writer.control_once('bound', ATTEMPT, generation, old, bound, expiry, self.journal)
        self.assertEqual(result['state'], 'CUSTODY_CONFIRMED'); self.assertEqual(control.cas_count, 2)
        self.assertEqual(control.document['task'], bound)

    def test_control_cannot_reset_or_overwrite_concurrent_generation(self):
        task, expiry, before, control = self.prepared()
        control.generation = '2'
        with self.assertRaisesRegex(RuntimeError, 'CAS_BASE_CHANGED'):
            self.writer.control_once('prepared', ATTEMPT, '1', before, task, expiry, self.journal)
        self.assertEqual(control.cas_count, 0)
        before['mode'] = 'active'; control.document = before
        with self.assertRaisesRegex(RuntimeError, 'EMPTY_PAUSED'):
            self.writer.control_once('prepared', ATTEMPT, '2', before, task, expiry, self.journal)

    def test_unexpected_cas_generation_or_readback_stays_unknown(self):
        store = self.writer.store_factory(self.writer.bucket, self.writer.target('body', ATTEMPT))
        original = store.compare_and_swap
        def drift(*args):
            result = original(*args); store.document = {'changed': True}; return result
        store.compare_and_swap = drift
        self.assertEqual(self.create()['state'], 'UNKNOWN')
        with self.assertRaisesRegex(RuntimeError, 'CONTENT_CHANGED'):
            self.writer.reconcile('custody-body:' + ATTEMPT, self.writer.payload('body', ATTEMPT, self.value), self.journal)

    def test_reconcile_rejects_semantically_equal_json_with_other_bytes(self):
        self.create(); store = next(iter(self.stores.values()))
        store.raw_override = b' ' + m.encode(self.value)
        payload = self.writer.payload('body', ATTEMPT, self.value)
        with self.assertRaisesRegex(RuntimeError, 'CONTENT_CHANGED'):
            self.writer.reconcile('custody-body:' + ATTEMPT, payload, self.journal)
        self.assertEqual(store.cas_count, 1)

    def test_reconcile_rejects_generation_change_during_exact_media_read(self):
        self.create(); store = next(iter(self.stores.values()))
        original = self.writer.store_factory
        def changed_factory(bucket, name):
            current = original(bucket, name)
            def media(observed, size):
                current.generation = str(int(observed) + 1)
                return m.encode(current.document)
            current.media = media
            return current
        self.writer.store_factory = changed_factory
        with self.assertRaisesRegex(RuntimeError, 'GENERATION_CHANGED'):
            self.writer.reconcile('custody-body:' + ATTEMPT,
                self.writer.payload('body', ATTEMPT, self.value), self.journal)
        self.assertEqual(store.cas_count, 1)

    def test_reconcile_without_intent_never_reads_or_writes_target(self):
        with self.assertRaisesRegex(RuntimeError, 'INTENT_REQUIRED'):
            self.writer.reconcile('custody-body:' + ATTEMPT, self.writer.payload('body', ATTEMPT, self.value), self.journal)
        self.assertEqual(self.stores, {})


if __name__ == '__main__': unittest.main()
