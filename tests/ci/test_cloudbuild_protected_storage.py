"""Synthetic custody/upload failure injection; no network or cloud mutation."""
import base64
from copy import deepcopy
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.parse

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudbuild_protected_storage as m

ATTEMPT = '11111111-1111-4111-8111-111111111111'


class Response(io.BytesIO):
    status = 200
    def __init__(self, raw, headers=None):
        super().__init__(raw); self.headers = headers or {}


class Remote:
    def __init__(self, raw=b'{"protected":true}\n', name='control/review.json'):
        self.raw = raw; self.name = name; self.calls = []; self.generation = '123'
        self.lost = False; self.headers = {}; self.change = {}; self.media_change = None

    def metadata(self):
        return {'bucket': 'synthetic-ci', 'name': self.name, 'generation': self.generation,
                'size': str(len(self.raw)), 'md5Hash': base64.b64encode(hashlib.md5(self.raw).digest()).decode(),
                **self.change}

    def open(self, request, timeout):
        self.calls.append(request)
        query = urllib.parse.parse_qs(urllib.parse.urlparse(request.full_url).query)
        if request.method == 'POST':
            if query.get('ifGenerationMatch') != ['0']: raise AssertionError('exclusive create required')
            self.name = query['name'][0]
            parts = []
            while raw := request.data.read(8192): parts.append(raw)
            self.raw = b''.join(parts)
            if self.lost: raise TimeoutError('synthetic private response')
        elif query.get('alt') == ['media']:
            return Response(self.raw if self.media_change is None else self.media_change, self.headers)
        return Response(json.dumps(self.metadata()).encode(), self.headers)

    def descriptor(self):
        return {'bucket': 'synthetic-ci', 'object': self.name, 'generation': self.generation,
                'sha256': hashlib.sha256(self.raw).hexdigest(), 'size': len(self.raw),
                'md5': self.metadata()['md5Hash']}


class Journal:
    def __init__(self): self.intent = None; self.results = []; self.before_commit = None
    def commit_intent(self, action, payload):
        if self.before_commit: self.before_commit()
        effect = None if self.intent else 'CREATE_ONCE'
        self.intent = m.ledger.canonical_hash(payload)
        return {'effect': effect, 'intent_sha256': self.intent, 'attempt_id': ATTEMPT, 'fencing_generation': '5'}
    def record_result(self, action, result): self.results.append(result)


class CustodyTests(unittest.TestCase):
    def setUp(self):
        self.remote = Remote(); self.api = m.ProtectedStorage(lambda: 'synthetic-token', 'synthetic-ci', 'control', opener=self.remote)

    def test_json_reads_exact_generation_and_hash(self):
        self.assertEqual(self.api.read_json(self.remote.descriptor()), {'protected': True})
        self.assertEqual(len(self.remote.calls), 2)
        self.assertTrue(all('generation=123' in r.full_url for r in self.remote.calls))
        self.assertEqual(self.remote.calls[0].method, 'GET')

    def test_wrong_scope_and_generation_fail_without_fallback(self):
        for field, value in [('bucket', 'other-bucket'), ('object', 'sources/other'), ('generation', '999')]:
            with self.subTest(field=field):
                descriptor = self.remote.descriptor(); descriptor[field] = value
                with self.assertRaises((m.EvidenceError, m.ledger.AdmissionError)): self.api.read_json(descriptor)
        self.assertFalse(any(r.method == 'POST' for r in self.remote.calls))

    def test_bytes_or_metadata_tampering_and_compression_rejected(self):
        cases = [('media_change', b'{"protected":false}'), ('change', {'md5Hash': 'wrong'}),
                 ('change', {'contentEncoding': 'gzip'}), ('change', {'componentCount': 2}),
                 ('headers', {'Content-Encoding': 'gzip'}), ('headers', {'Content-Length': '99'})]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                self.setUp(); expected = self.remote.descriptor(); setattr(self.remote, field, value)
                with self.assertRaises(m.EvidenceError): self.api.read_json(expected)

    def test_oversized_duplicate_keys_and_non_objects_rejected(self):
        value = self.remote.descriptor(); value['size'] = m.MAX_RESPONSE + 1
        with self.assertRaises(m.EvidenceError): self.api.read_json(value)
        self.assertEqual(self.remote.calls, [])
        for raw in [b'{"a":1,"a":2}', b'[]', b'{"a":NaN}']:
            self.remote.raw = raw
            with self.assertRaises(m.EvidenceError): self.api.read_json(self.remote.descriptor())

    def test_credentials_never_leak_on_unknown(self):
        self.api.opener = Mock(); self.api.opener.open.side_effect = TimeoutError('synthetic-token private')
        with self.assertRaisesRegex(m.EvidenceError, '^CUSTODY_OUTCOME_UNKNOWN$'):
            self.api.read_json(self.remote.descriptor())
        self.assertEqual(self.api.opener.open.call_count, 1)

    def test_descriptor_rejects_malformed_generation_size_hash_and_path(self):
        for key, value in [('generation', '01'), ('size', True), ('size', 0), ('sha256', 'x'),
                           ('md5', '!'), ('object', 'control/../other')]:
            descriptor = self.remote.descriptor(); descriptor[key] = value
            with self.subTest(key=key), self.assertRaises((m.EvidenceError, m.ledger.AdmissionError)):
                m.validate_descriptor(descriptor)

    def test_cumulative_read_deadlines_reject_slow_responses(self):
        for operation, moments, code in [
            ('json', [0, 1, 61], 'CUSTODY_JSON_TIME_EXCEEDED'),
            ('media', [0, 1, 241], 'CUSTODY_MEDIA_TIME_EXCEEDED')]:
            with self.subTest(operation=operation):
                self.api.clock = Mock(side_effect=moments)
                with self.assertRaisesRegex(m.EvidenceError, code):
                    if operation == 'json': self.api._json(Response(b'{}'))
                    else: self.api._verify_media(self.remote.descriptor())


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name).resolve() / 'source.tgz'; self.path.write_bytes(b'synthetic archive')
        self.path.chmod(0o600)
        self.remote = Remote(self.path.read_bytes(), 'sources/' + ATTEMPT + '.tgz')
        self.expected = self.remote.descriptor(); del self.expected['generation']
        self.api = m.ProtectedStorage(lambda: 'synthetic-token', 'synthetic-ci', 'sources', opener=self.remote)
        self.journal = Journal()

    def upload(self): return self.api.upload_source_once(self.path, self.expected, self.journal, attempt_id=ATTEMPT)
    def posts(self): return [r for r in self.remote.calls if r.method == 'POST']

    def test_upload_then_generation_media_readback_records_result(self):
        result = self.upload()
        self.assertEqual(result['state'], 'SOURCE_UPLOADED_AND_VERIFIED')
        self.assertEqual(result['descriptor']['generation'], '123')
        self.assertEqual(len(self.posts()), 1)
        self.assertEqual(self.journal.results[0]['status'], 'RECONCILED')
        self.assertEqual(self.upload()['state'], 'RECONCILIATION_REQUIRED')
        self.assertEqual(len(self.posts()), 1)

    def test_lost_ack_is_unknown_then_get_only_reconciliation(self):
        self.remote.lost = True
        self.assertEqual(self.upload()['state'], 'UNKNOWN')
        self.assertEqual(self.journal.results[-1]['status'], 'UNKNOWN')
        self.assertEqual(self.api.reconcile_source(self.expected)['generation'], '123')
        self.assertEqual(self.upload()['state'], 'RECONCILIATION_REQUIRED')
        self.assertEqual(len(self.posts()), 1)

    def test_failed_cas_prevents_post(self):
        self.journal.commit_intent = Mock(side_effect=m.ledger.CommitOutcomeUnknown('CAS uncertain'))
        with self.assertRaises(m.ledger.CommitOutcomeUnknown): self.upload()
        self.assertEqual(self.posts(), [])

    def test_mismatched_local_hash_mode_symlink_and_scope_never_create_intent(self):
        for kind in ('hash', 'mode', 'symlink', 'scope', 'hardlink'):
            with self.subTest(kind=kind):
                self.setUp()
                if kind == 'hash': self.path.write_bytes(b'changed but same?')
                elif kind == 'mode': self.path.chmod(0o644)
                elif kind == 'symlink':
                    link = self.path.with_name('link'); link.symlink_to(self.path); self.path = link
                elif kind == 'hardlink': os.link(self.path, self.path.with_name('hardlink'))
                else: self.expected['object'] = 'sources/other.tgz'
                with self.assertRaises((m.EvidenceError, OSError)): self.upload()
                self.assertIsNone(self.journal.intent); self.assertEqual(self.posts(), [])

    def test_growth_after_intent_is_bounded_and_unknown(self):
        self.journal.before_commit = lambda: self.path.write_bytes(self.path.read_bytes() + b'EXTRA')
        self.assertEqual(self.upload()['state'], 'UNKNOWN')
        self.assertEqual(len(self.remote.raw), self.expected['size'])
        self.assertEqual(len(self.posts()), 1)

    def test_growth_during_local_hash_stops_before_intent(self):
        digest = hashlib.sha256(); original_update = digest.update
        class GrowingHash:
            def update(inner, raw):
                original_update(raw)
                with self.path.open('ab') as file: file.write(b'EXTRA')
            def hexdigest(inner): return digest.hexdigest()
        with patch.object(m.hashlib, 'sha256', return_value=GrowingHash()):
            with self.assertRaisesRegex(m.EvidenceError, 'SOURCE_UPLOAD_LOCAL_SIZE_CHANGED'): self.upload()
        self.assertIsNone(self.journal.intent); self.assertEqual(self.posts(), [])

    def test_tampered_remote_media_is_unknown(self):
        self.remote.media_change = b'tampered'
        self.assertEqual(self.upload()['state'], 'UNKNOWN')
        self.assertEqual(len(self.posts()), 1)

    def test_reconciliation_wrong_bytes_never_reuploads(self):
        self.remote.raw = b'wrong'
        with self.assertRaises(m.EvidenceError): self.api.reconcile_source(self.expected)
        self.assertEqual(self.posts(), [])

    def test_invalid_journal_binding_or_generation_never_posts(self):
        for key, value in [('attempt_id', 'wrong'), ('intent_sha256', 'a' * 64), ('fencing_generation', '0')]:
            with self.subTest(key=key):
                self.journal.commit_intent = lambda *_: {'effect': 'CREATE_ONCE', 'attempt_id': ATTEMPT,
                    'intent_sha256': m.ledger.canonical_hash(self.expected), 'fencing_generation': '5', key: value}
                with self.assertRaises((m.EvidenceError, m.ledger.AdmissionError)): self.upload()
                self.assertEqual(self.posts(), [])

    def test_local_hash_deadline_blocks_intent(self):
        moments = iter([0, 31]); self.api.clock = lambda: next(moments)
        with self.assertRaisesRegex(m.EvidenceError, 'SOURCE_UPLOAD_HASH_TIME_EXCEEDED'): self.upload()
        self.assertIsNone(self.journal.intent); self.assertEqual(self.posts(), [])

    def test_stream_deadline_and_size_are_enforced(self):
        clock = Mock(side_effect=[0, 241])
        stream = m.SourceBody(io.BytesIO(b'abcEXTRA'), 3, clock=clock)
        with self.assertRaisesRegex(m.EvidenceError, 'SOURCE_UPLOAD_TRANSFER_TIME_EXCEEDED'): stream.read(8)
        stream = m.SourceBody(io.BytesIO(b'abcEXTRA'), 3)
        self.assertEqual(stream.read(8), b'abc'); self.assertEqual(stream.read(8), b'')


if __name__ == '__main__': unittest.main()
