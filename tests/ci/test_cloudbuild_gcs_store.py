"""Contract tests for conditional GCS writes; never contact Google Cloud."""
import io
import json
from pathlib import Path
import sys
import unittest
import urllib.error
import urllib.parse
from unittest.mock import Mock

SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import cloudbuild_gcs_store as m


class FakeGCS:
    def __init__(self):
        self.current = '0'
        self.versions = {}
        self.calls = []
        self.after_write = None
        self.media_error = None
        self.metadata_change = {}

    def metadata(self, generation):
        return json.dumps({'bucket': 'synthetic-ci', 'name': 'controller/ledger.json',
                           'generation': generation, 'size': str(len(self.versions[generation])),
                           **self.metadata_change}).encode()

    def __call__(self, method, url, body=None):
        self.calls.append((method, url, body))
        query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        if method == 'POST':
            if query['ifGenerationMatch'][0] != self.current:
                return 412, b'{}'
            self.current = str(int(self.current) + 1)
            self.versions[self.current] = body
            if self.after_write:
                if isinstance(self.after_write, Exception):
                    raise self.after_write
                return self.after_write, b'{}'
            return 200, self.metadata(self.current)
        if query.get('alt') == ['media']:
            if self.media_error:
                return self.media_error
            observed = query['generation'][0]
            return (200, self.versions[observed]) if observed in self.versions else (404, b'{}')
        return (200, self.metadata(self.current)) if self.current != '0' else (404, b'{}')


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.remote = FakeGCS()
        self.store = m.GCSAdmissionStore('synthetic-ci', 'controller/ledger.json', self.remote)

    def posts(self):
        return [call for call in self.remote.calls if call[0] == 'POST']

    def test_initial_create_and_exact_generation_readback(self):
        self.assertEqual(self.store.load(), ('0', None))
        self.assertEqual(self.store.compare_and_swap('0', {'active': 'synthetic'}), '1')
        self.assertEqual(self.store.load(), ('1', {'active': 'synthetic'}))
        self.assertEqual(len(self.posts()), 1)
        self.assertIn('ifGenerationMatch=0', self.posts()[0][1])
        self.assertIn('generation=1', self.remote.calls[-1][1])

    def test_concurrent_writers_one_wins_other_conflicts_without_retry(self):
        self.store.compare_and_swap('0', {'sequence': 1})
        first = self.store.load()
        second = self.store.load()
        self.assertEqual(self.store.compare_and_swap(first[0], {'sequence': 2}), '2')
        with self.assertRaises(m.CASConflict):
            self.store.compare_and_swap(second[0], {'sequence': 3})
        self.assertEqual(len(self.posts()), 3)
        self.assertEqual(self.store.load(), ('2', {'sequence': 2}))

    def test_write_may_commit_before_timeout_server_error_or_redirect(self):
        for outcome in (TimeoutError('private response'), 503, 307):
            with self.subTest(outcome=type(outcome).__name__):
                self.setUp()
                self.remote.after_write = outcome
                with self.assertRaisesRegex(m.CommitOutcomeUnknown, '^LEDGER_CAS_OUTCOME_UNKNOWN$'):
                    self.store.compare_and_swap('0', {'status': 'SUBMIT_INTENT'})
                self.assertEqual(len(self.posts()), 1)
                self.assertEqual(self.store.load(), ('1', {'status': 'SUBMIT_INTENT'}))

    def test_success_response_requires_matching_identity_and_exact_bytes(self):
        for change in ({'bucket': 'another-bucket'}, {'name': 'another/object'},
                       {'generation': '0'}, {'generation': True}, {'size': '0'},
                       {'contentEncoding': 'gzip'}):
            with self.subTest(change=change):
                self.setUp()
                self.remote.metadata_change = change
                with self.assertRaises(m.CommitOutcomeUnknown):
                    self.store.compare_and_swap('0', {'counter': 1})
                self.assertEqual(len(self.posts()), 1)

    def test_missing_or_tampered_readback_is_unknown_not_success(self):
        for response in ((404, b'{}'), (200, b'{"counter":9}\n'), (200, b'changed')):
            with self.subTest(status=response[0]):
                self.setUp()
                self.remote.media_error = response
                with self.assertRaises(m.CommitOutcomeUnknown):
                    self.store.compare_and_swap('0', {'counter': 1})
                self.assertEqual(len(self.posts()), 1)

    def test_missing_generation_after_metadata_is_not_absent_ledger(self):
        self.store.compare_and_swap('0', {'counter': 1})
        self.remote.media_error = (404, b'{}')
        with self.assertRaises(m.AdmissionError):
            self.store.load()

    def test_malformed_json_and_duplicate_keys_are_rejected(self):
        for raw in (b'{}{}', b'[]', b'{"a":1,"a":2}', b'{"a":NaN}', b'\xff'):
            with self.subTest(raw=raw), self.assertRaises(m.AdmissionError):
                m.decode(raw)

    def test_invalid_or_oversized_input_does_not_send(self):
        for gen, doc in ((True, {}), (1, {}), ('-1', {}), ('01', {}), ('0', []),
                         ('0', {'a': float('inf')}), ('0', {'a': 'x' * m.MAX_BYTES})):
            with self.subTest(generation=gen), self.assertRaises(m.AdmissionError):
                self.store.compare_and_swap(gen, doc)
        self.assertEqual(self.remote.calls, [])

    def test_invalid_paths_and_targets_are_rejected(self):
        for path in ('../ledger', 'control/../ledger', '/ledger', 'control//ledger', 'a?b'):
            with self.subTest(path=path), self.assertRaises(m.AdmissionError):
                m.GCSAdmissionStore('synthetic-ci', path, self.remote)


class TransportTests(unittest.TestCase):
    def test_token_provider_failure_is_sanitized_before_any_request(self):
        provider = Mock(side_effect=RuntimeError('synthetic private credential diagnostic'))
        transport = m.SingleRequestTransport(provider)
        transport.opener = Mock()
        with self.assertRaisesRegex(m.AdmissionError, '^GCS_TOKEN_UNAVAILABLE$'):
            transport('GET', m.ORIGIN + '/path')
        transport.opener.open.assert_not_called()

    def test_redirects_are_not_followed(self):
        handler = m.NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 307, '', {}, 'https://other.invalid'))

    def test_http_error_is_one_request_and_does_not_expose_body(self):
        transport = m.SingleRequestTransport(lambda: 'synthetic-token')
        transport.opener = Mock()
        transport.opener.open.side_effect = urllib.error.HTTPError(
            'https://storage.googleapis.com/path', 503, 'unavailable', {}, io.BytesIO(b'private-error'))
        self.assertEqual(transport('POST', m.ORIGIN + '/path', b'{}'), (503, b'private-error'))
        self.assertEqual(transport.opener.open.call_count, 1)

    def test_transport_exception_does_not_reveal_credentials_or_retry(self):
        transport = m.SingleRequestTransport(lambda: 'synthetic-token')
        transport.opener = Mock()
        transport.opener.open.side_effect = TimeoutError('synthetic-token private')
        with self.assertRaisesRegex(m.AdmissionError, '^GCS_TRANSPORT_UNCERTAIN$'):
            transport('GET', m.ORIGIN + '/path')
        self.assertEqual(transport.opener.open.call_count, 1)

    def test_untrusted_origin_cannot_receive_authorization(self):
        provider = Mock(return_value='synthetic-token')
        transport = m.SingleRequestTransport(provider)
        with self.assertRaises(m.AdmissionError):
            transport('GET', m.ORIGIN + '.attacker.invalid/path')
        provider.assert_not_called()


if __name__ == '__main__':
    unittest.main()
