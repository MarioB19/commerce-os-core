import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock
import urllib.error
import urllib.parse

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudbuild_project_inventory as m

ID = '11111111-1111-4111-8111-111111111111'


def build(region='us-east1'):
    return {'id': ID, 'projectId': m.PROJECT, 'name': 'projects/' + m.PROJECT + '/locations/' + region + '/builds/' + ID,
            'status': 'FAILURE', 'createTime': '2026-10-10T12:00:00Z', 'startTime': '2026-10-10T12:00:01Z',
            'finishTime': '2026-10-10T13:13:59Z', 'source': {'synthetic': True}}


class Response(io.BytesIO):
    status = 200
    headers = {}


class Remote:
    def __init__(self):
        self.calls = []; self.location_rows = [{'locationId': 'us-east1',
            'name': 'projects/' + m.PROJECT + '/locations/us-east1'}]
        self.rows = {'us-east1': [build()], 'global': []}; self.page = None; self.error_region = None
        self.headers = {}
    def open(self, request, timeout):
        self.calls.append(request)
        parsed = urllib.parse.urlparse(request.full_url)
        if '/v2/' in parsed.path: value = {'locations': self.location_rows}
        else:
            region = parsed.path.split('/locations/')[1].split('/')[0]
            if region == self.error_region:
                raise urllib.error.HTTPError(request.full_url, 403, 'private', {}, io.BytesIO(b'private'))
            value = {'builds': self.rows.get(region, [])}
            if self.page is not None: value = self.page(region, urllib.parse.parse_qs(parsed.query))
        response = Response(json.dumps(value).encode()); response.headers = self.headers
        return response


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.remote = Remote(); self.api = m.ProjectInventory(lambda: 'synthetic-token', '123', opener=self.remote)
    def test_global_and_every_provider_region_are_read(self):
        result = self.api.snapshot()
        self.assertEqual(result['regions'], ['global', 'us-east1'])
        self.assertTrue(result['complete']); self.assertEqual(result['requests'], 3)
        self.assertEqual(result['builds'][0]['status'], 'FAILURE')
        self.assertEqual(result['builds'][0]['native_sha256'], m.canonical_hash(build()))
        self.assertTrue(all(request.method == 'GET' for request in self.remote.calls))
        for request in self.remote.calls:
            query = urllib.parse.parse_qs(urllib.parse.urlparse(request.full_url).query)
            self.assertEqual(query.get('projectId'), [m.PROJECT] if '/v1/' in request.full_url else None)
        with self.assertRaisesRegex(m.EvidenceError, 'INVENTORY_INSTANCE_ALREADY_USED'): self.api.snapshot()
    def test_extra_region_cannot_be_silently_ignored(self):
        self.remote.location_rows.append({'locationId': 'europe-west1',
            'name': 'projects/' + m.PROJECT + '/locations/europe-west1'})
        self.remote.error_region = 'europe-west1'
        with self.assertRaisesRegex(m.EvidenceError, '^INVENTORY_HTTP_403$'): self.api.snapshot()
    def test_empty_page_with_token_is_followed(self):
        def page(region, query):
            if region == 'global': return {}
            return {'builds': [build()]} if 'pageToken' in query else {'nextPageToken': 'second'}
        self.remote.page = page
        result = self.api.snapshot(); self.assertEqual(len(result['builds']), 1); self.assertEqual(result['requests'], 4)
    def test_repeated_token_and_page_bound_fail_closed(self):
        self.remote.page = lambda region, query: {'nextPageToken': 'same'}
        with self.assertRaisesRegex(m.EvidenceError, 'INVENTORY_PAGE_TOKEN_INVALID'): self.api.snapshot()
    def test_duplicate_cross_region_uuid_is_not_deduplicated(self):
        self.remote.rows['global'] = [build('global')]
        with self.assertRaisesRegex(m.EvidenceError, 'INVENTORY_DUPLICATE_OR_COUNT_BOUND'): self.api.snapshot()
    def test_unknown_status_or_wrong_project_or_name_rejects(self):
        for key, value in [('status', 'STATUS_UNKNOWN'), ('projectId', 'other'), ('name', 'wrong'), ('createTime', 'invalid')]:
            with self.subTest(key=key):
                self.setUp(); self.remote.rows['us-east1'][0][key] = value
                with self.assertRaises((m.EvidenceError, m.ledger.AdmissionError)): self.api.snapshot()
    def test_changed_config_changes_inventory_hash(self):
        first = self.api.snapshot()
        self.api = m.ProjectInventory(lambda: 'synthetic-token', '123', opener=self.remote)
        self.remote.rows['us-east1'][0]['source'] = {'synthetic': False}
        self.assertNotEqual(first['inventory_sha256'], self.api.snapshot()['inventory_sha256'])
    def test_missing_admitted_region_or_duplicate_location_rejects(self):
        for rows in ([], self.remote.location_rows * 2):
            with self.subTest(rows=rows):
                self.setUp(); self.remote.location_rows = rows
                with self.assertRaises(m.EvidenceError): self.api.snapshot()
    def test_time_bound_and_encoding_rejects(self):
        self.api.clock = Mock(side_effect=[0, 91])
        with self.assertRaisesRegex(m.EvidenceError, 'INVENTORY_TIME_BOUND'): self.api.snapshot()
        self.setUp(); self.remote.headers = {'Content-Encoding': 'gzip'}
        with self.assertRaisesRegex(m.EvidenceError, 'INVENTORY_RESPONSE_UNCONFIRMED'): self.api.snapshot()
    def test_credential_failure_is_redacted_and_no_requests(self):
        self.api.token_provider = Mock(side_effect=RuntimeError('private credential'))
        with self.assertRaisesRegex(m.EvidenceError, '^INVENTORY_TOKEN_UNAVAILABLE$'): self.api.snapshot()
        self.assertEqual(self.remote.calls, [])


if __name__ == '__main__': unittest.main()
