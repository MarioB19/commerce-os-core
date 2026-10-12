"""Read-only transport boundaries; all provider responses are synthetic."""
import copy
import io
import json
from pathlib import Path
import sys
import unittest
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudbuild_native_reader as m
from test_cloudbuild_publish_status import fixture, NUMBER


class Response:
    status = 200

    def __init__(self, value):
        self.raw = value if type(value) is bytes else json.dumps(value).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, size):
        return self.raw[:size]


class Opener:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def open(self, request, timeout):
        self.calls.append((request, timeout))
        value = self.responses.pop(0)
        if isinstance(value, Exception):
            raise value
        return Response(value)


class NativeReaderTests(unittest.TestCase):
    def setUp(self):
        self.manifest, self.build, self.github, _, self.logs = fixture()
        self.opener = Opener([{'projectId': m.PROJECT, 'projectNumber': NUMBER},
                              self.build, {'entries': self.logs}])
        self.source_calls = []
        self.token_calls = 0

        def token():
            self.token_calls += 1
            return 'synthetic-token'

        def source(repository, sha):
            self.source_calls.append((repository, sha))
            return self.github

        self.reader = m.GoogleFullReader(token, source, opener=self.opener)

    def test_rest_and_cli_share_exact_success_and_validators(self):
        result = self.reader.evaluate(self.manifest)
        self.assertEqual(result['state'], 'success')
        self.assertEqual(self.source_calls, [(m.REPOSITORY, self.manifest['source_sha'])])
        self.assertEqual(self.token_calls, 3)
        requests = [call[0] for call in self.opener.calls]
        self.assertEqual([r.method for r in requests], ['GET', 'GET', 'POST'])
        self.assertEqual([r.full_url for r in requests], [m.PROJECT_URL,
            m.BUILD_ROOT + 'us-east1/builds/' + self.manifest['build_id'], m.LOG_URL])
        self.assertEqual(json.loads(requests[2].data), {
            'resourceNames': ['projects/' + m.PROJECT],
            'filter': m.log_filter(self.manifest), 'orderBy': 'timestamp asc', 'pageSize': 100})
        self.assertTrue(all(r.get_header('Authorization') == 'Bearer synthetic-token' for r in requests))
        self.assertTrue(all(timeout == 20 for _, timeout in self.opener.calls))

    def test_invalid_source_identity_fails_before_any_token_or_network(self):
        for field, value in [('region', '../metadata'), ('build_id', 'other?url=metadata'),
                             ('repository', 'MarioB19/commerce-os')]:
            manifest = copy.deepcopy(self.manifest)
            manifest[field] = value
            with self.subTest(field=field), self.assertRaises(m.EvidenceError):
                self.reader.evaluate(manifest)
        self.assertEqual(self.token_calls, 0)
        self.assertFalse(self.opener.calls)
        self.assertFalse(self.source_calls)

    def test_incomplete_logs_cannot_pass_even_with_one_good_receipt(self):
        for response in [{'entries': self.logs, 'nextPageToken': 0},
                         {'entries': self.logs, 'nextPageToken': None},
                         {'entries': self.logs, 'partial': True},
                         {'entries': self.logs * 100}, {'entries': {}}, {}]:
            self.opener.responses = [response]
            with self.subTest(response_keys=list(response)), self.assertRaises(m.EvidenceError):
                entries = self.reader.logs(self.manifest)
                from cloudbuild_full_evidence import receipts_from_logs
                receipts_from_logs(entries, self.manifest)

    def test_candidate_receipt_does_not_replace_native_provenance(self):
        self.build['sourceProvenance']['resolvedStorageSource']['generation'] = '24'
        with self.assertRaisesRegex(m.EvidenceError, 'RESOLVED_SOURCE_MISMATCH'):
            self.reader.evaluate(self.manifest)
        self.assertEqual(len(self.opener.calls), 2)

    def test_pending_or_failed_native_build_does_not_query_logs_or_claim_success(self):
        for native, expected in [('WORKING', 'pending'), ('FAILURE', 'failure'),
                                 ('CANCELLED', 'failure')]:
            self.build['status'] = native
            self.opener.responses = [{'projectId': m.PROJECT, 'projectNumber': NUMBER}, self.build]
            self.opener.calls.clear()
            self.assertEqual(self.reader.evaluate(self.manifest)['state'], expected)
            self.assertEqual(len(self.opener.calls), 2)

    def test_trigger_build_still_cannot_claim_bootstrap_attestation(self):
        self.build['buildTriggerId'] = 'synthetic-trigger'
        with self.assertRaisesRegex(m.EvidenceError, 'BOOTSTRAP_ONLY_NOT_TRIGGER_ATTESTATION'):
            self.reader.evaluate(self.manifest)

    def test_unknown_operation_is_rejected_before_token_or_request(self):
        with self.assertRaisesRegex(m.EvidenceError, 'NATIVE_READ_OPERATION_INVALID'):
            self.reader._read('approve', self.manifest)
        self.assertEqual(self.token_calls, 0)
        self.assertFalse(self.opener.calls)

    def test_network_and_http_errors_are_redacted_and_never_retried(self):
        for error in [OSError('synthetic-token'), urllib.error.HTTPError(
            'https://example.invalid/synthetic-token', 403, 'synthetic-token', {},
            io.BytesIO(b'synthetic-token'))]:
            self.opener.responses = [error]
            self.opener.calls.clear()
            with self.assertRaises(m.EvidenceError) as outcome:
                self.reader.project()
            self.assertNotIn('synthetic-token', str(outcome.exception))
            self.assertEqual(len(self.opener.calls), 1)

    def test_no_redirect_handler_declines_credential_forwarding(self):
        self.assertIsNone(m.NoRedirect().redirect_request(
            None, None, 302, '', {}, 'https://example.invalid/'))

    def test_token_failure_never_performs_request_or_exposes_original_error(self):
        def broken():
            raise RuntimeError('synthetic-token')
        self.reader.token_provider = broken
        with self.assertRaisesRegex(m.EvidenceError, '^NATIVE_TOKEN_UNAVAILABLE$'):
            self.reader.project()
        self.assertFalse(self.opener.calls)

    def test_duplicate_keys_nonfinite_and_oversize_json_fail_closed(self):
        for raw in [b'{"projectId":"safe","projectId":"other"}', b'{"x":NaN}',
                    b'[]', b'null', b'\xff', b' ' * (m.MAX_RESPONSE + 1)]:
            with self.subTest(length=len(raw)), self.assertRaises(m.EvidenceError):
                m.decode(raw)


if __name__ == '__main__':
    unittest.main()
