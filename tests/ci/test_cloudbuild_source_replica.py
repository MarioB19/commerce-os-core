import base64
from copy import deepcopy
import hashlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock
import urllib.parse

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudbuild_source_replica as m
from cloudbuild_effect_journal import DurableEffectJournal, initial_journal
from test_cloudbuild_admission import MemoryStore, NOW, ATTEMPT
from test_cloudbuild_release_controller import ReleaseControllerTests


class Response(io.BytesIO):
    status = 200
    headers = {}


class Remote:
    def __init__(self, name, data):
        self.objects = {name: (data, '100')}; self.calls = []; self.lost = False; self.corrupt = False

    def open(self, request, timeout):
        self.calls.append(request)
        parsed = urllib.parse.urlparse(request.full_url); query = urllib.parse.parse_qs(parsed.query)
        name = urllib.parse.unquote(parsed.path.split('/o/', 1)[1])
        if request.method == 'POST':
            original, destination = name.split('/copyTo/b/synthetic-ci-source/o/')
            if query != {'sourceGeneration': ['100'], 'ifSourceGenerationMatch': ['100'], 'ifGenerationMatch': ['0']}:
                raise AssertionError('immutable generation/exclusive copy required')
            if destination in self.objects: raise AssertionError('no second copy')
            data = self.objects[original][0]; self.objects[destination] = (b'changed' if self.corrupt else data, '200')
            name = destination
            if self.lost: raise TimeoutError('synthetic lost reply')
        data, generation = self.objects[name]
        if query.get('alt') == ['media']: return Response(data)
        return Response(json.dumps({'bucket': 'synthetic-ci-source', 'name': name, 'generation': generation,
            'size': str(len(data)), 'md5Hash': base64.b64encode(hashlib.md5(data).digest()).decode()}).encode())


class ReplicaTests(unittest.TestCase):
    def setUp(self):
        f = ReleaseControllerTests(); f.setUp(); self.verify = deepcopy(f.package.verify)
        data = b'synthetic immutable source'
        self.verify['storage_source'] = {'bucket': 'synthetic-ci-source', 'object': 'full/original.tgz', 'generation': '100'}
        self.verify['archive_sha256'] = hashlib.sha256(data).hexdigest()
        self.original = {**self.verify['storage_source'], 'sha256': self.verify['archive_sha256'],
            'size': len(data), 'md5': base64.b64encode(hashlib.md5(data).digest()).decode()}
        self.remote = Remote('full/original.tgz', data); self.fence = Mock()
        self.replica = m.SourceReplica(lambda: 'synthetic-token', 'synthetic-ci-source', 'package', fence=self.fence, opener=self.remote)
        binding = {'attempt_id': ATTEMPT, 'plan_sha256': m.ledger.canonical_hash(f.plan), 'source_sha': f.plan['identity']['source_sha']}
        self.journal_store = MemoryStore(initial_journal(binding))
        self.journal = DurableEffectJournal(self.journal_store, f.store, binding, clock=lambda: NOW)

    def copy(self): return self.replica.copy_once(self.verify, self.original, ATTEMPT, self.journal)
    def posts(self): return [q for q in self.remote.calls if q.method == 'POST']

    def test_copy_uses_three_generation_preconditions_and_verified_bytes(self):
        result = self.copy()
        self.assertEqual(result['state'], 'SOURCE_REPLICA_VERIFIED')
        self.assertEqual(result['replica']['origin'], self.verify['storage_source'])
        self.assertEqual(result['replica']['storage_source']['object'], 'package/' + ATTEMPT + '.tgz')
        self.fence.assert_called_once(); self.assertEqual(len(self.posts()), 1)
        self.assertEqual(self.copy()['state'], 'RECONCILIATION_REQUIRED'); self.assertEqual(len(self.posts()), 1)

    def test_lost_copy_is_reconciled_without_second_post(self):
        self.remote.lost = True
        self.assertEqual(self.copy()['state'], 'UNKNOWN')
        result = self.replica.reconcile(self.verify, self.original, ATTEMPT, self.journal)
        self.assertEqual(result['state'], 'SOURCE_REPLICA_VERIFIED'); self.assertEqual(len(self.posts()), 1)

    def test_pause_after_intent_keeps_it_consumed(self):
        self.fence.side_effect = RuntimeError('PAUSED')
        self.assertEqual(self.copy()['state'], 'UNKNOWN'); self.assertEqual(self.posts(), [])
        self.fence.side_effect = None
        self.assertEqual(self.copy()['state'], 'RECONCILIATION_REQUIRED'); self.assertEqual(self.posts(), [])

    def test_wrong_origin_or_corrupted_destination_never_verifies(self):
        changed = deepcopy(self.original); changed['generation'] = '101'
        with self.assertRaisesRegex(RuntimeError, 'ORIGIN_CHANGED'):
            self.replica.copy_once(self.verify, changed, ATTEMPT, self.journal)
        self.assertEqual(self.posts(), [])
        self.remote.corrupt = True
        self.assertEqual(self.copy()['state'], 'UNKNOWN')
        with self.assertRaisesRegex(RuntimeError, 'HASH_CHANGED'):
            self.replica.reconcile(self.verify, self.original, ATTEMPT, self.journal)

    def test_reconcile_needs_original_intent_and_cannot_create(self):
        with self.assertRaisesRegex(RuntimeError, 'INTENT_REQUIRED'):
            self.replica.reconcile(self.verify, self.original, ATTEMPT, self.journal)
        self.assertEqual(self.remote.calls, [])


def load_tests(loader, tests, pattern): return loader.loadTestsFromTestCase(ReplicaTests)
if __name__ == '__main__': unittest.main()
