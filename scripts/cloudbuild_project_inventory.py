"""Bounded, authenticated project-wide Cloud Build inventory (GET only).

Enumerates the provider's supported regions and global, follows every page,
and fails closed on any region error, truncation, duplicate or unknown status.
It never treats one regional list as proof that the entire project is idle.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import cloudbuild_admission as ledger
from cloudbuild_full_evidence import PROJECT, EvidenceError, need, canonical_hash
from cloudbuild_native_reader import MAX_RESPONSE, NoRedirect, decode

ORIGIN = 'https://cloudbuild.googleapis.com'
MAX_REGIONS = 80
MAX_BUILDS = 1000
MAX_TOTAL_BYTES = 32 * 1024 * 1024
MAX_SECONDS = 90
STATUSES = ledger.TERMINAL_STATUSES | {'PENDING', 'QUEUED', 'WORKING'}


class ProjectInventory:
    def __init__(self, token_provider, project_number, *, opener=None, clock=time.monotonic,
                 utc_now=lambda: datetime.now(timezone.utc)):
        need(type(project_number) is str and re.fullmatch(r'[1-9][0-9]{0,19}', project_number),
             'INVENTORY_PROJECT_NUMBER_REQUIRED')
        self.token_provider = token_provider; self.project_number = project_number
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.clock = clock; self.utc_now = utc_now; self.lock = threading.Lock()
        self.deadline = 0; self.total_bytes = 0; self.requests = 0

    def _read(self, version, region=None, token=''):
        need(version in {'v1', 'v2'} and ((version == 'v2' and region is None) or
             (version == 'v1' and type(region) is str and re.fullmatch(r'[a-z][a-z0-9-]{0,39}', region))),
             'INVENTORY_ENDPOINT_REJECTED')
        need(type(token) is str and len(token) <= 4096, 'INVENTORY_PAGE_TOKEN_INVALID')
        need(self.clock() < self.deadline, 'INVENTORY_TIME_BOUND')
        try: credential = self.token_provider()
        except Exception: raise EvidenceError('INVENTORY_TOKEN_UNAVAILABLE') from None
        need(type(credential) is str and credential and not any(c.isspace() for c in credential),
             'INVENTORY_TOKEN_UNAVAILABLE')
        path = '/' + version + '/projects/' + PROJECT + '/locations'
        if region is not None: path += '/' + region + '/builds'
        query = urllib.parse.urlencode({'pageSize': 100,
            **({'projectId': PROJECT} if version == 'v1' else {}), **({'pageToken': token} if token else {})})
        request = urllib.request.Request(ORIGIN + path + '?' + query, method='GET', headers={
            'Authorization': 'Bearer ' + credential, 'Accept-Encoding': 'identity'})
        chunks = []; size = 0
        try:
            with self.opener.open(request, timeout=20) as response:
                need(response.status == 200 and response.headers.get('Content-Encoding', 'identity') == 'identity',
                     'INVENTORY_RESPONSE_UNCONFIRMED')
                while True:
                    need(self.clock() < self.deadline, 'INVENTORY_TIME_BOUND')
                    raw = response.read1(min(65536, MAX_RESPONSE - size + 1))
                    need(self.clock() < self.deadline, 'INVENTORY_TIME_BOUND')
                    if not raw: break
                    size += len(raw); need(size <= MAX_RESPONSE, 'INVENTORY_RESPONSE_TOO_LARGE')
                    with self.lock:
                        self.total_bytes += len(raw)
                        need(self.total_bytes <= MAX_TOTAL_BYTES, 'INVENTORY_TOTAL_SIZE_BOUND')
                    chunks.append(raw)
        except urllib.error.HTTPError as error:
            status = error.code; error.close()
            raise EvidenceError('INVENTORY_HTTP_' + str(status)) from None
        except (OSError, ValueError): raise EvidenceError('INVENTORY_READ_UNCERTAIN') from None
        with self.lock: self.requests += 1
        return decode(b''.join(chunks))

    def _pages(self, version, field, region=None, *, pages=10):
        seen = set(); token = ''; values = []
        for _ in range(pages):
            value = self._read(version, region, token)
            need(set(value) <= {field, 'nextPageToken'} and type(value.get(field, [])) is list
                 and len(value.get(field, [])) <= 100, 'INVENTORY_PAGE_INVALID')
            values.extend(value.get(field, []))
            need(len(values) <= MAX_BUILDS, 'INVENTORY_COUNT_BOUND')
            token = value.get('nextPageToken', '')
            need(type(token) is str and len(token) <= 4096 and token not in seen, 'INVENTORY_PAGE_TOKEN_INVALID')
            if not token: return values
            seen.add(token)
        raise EvidenceError('INVENTORY_PAGINATION_INCOMPLETE')

    def _regions(self):
        rows = self._pages('v2', 'locations', pages=2); regions = set()
        for row in rows:
            need(type(row) is dict, 'INVENTORY_LOCATION_INVALID')
            region = row.get('locationId')
            need(type(region) is str and re.fullmatch(r'[a-z][a-z0-9-]{0,39}', region)
                 and region not in regions and row.get('name') in {
                    'projects/' + p + '/locations/' + region for p in (PROJECT, self.project_number)},
                 'INVENTORY_LOCATION_IDENTITY_CHANGED')
            regions.add(region)
        need('us-east1' in regions and 0 < len(regions) <= MAX_REGIONS, 'INVENTORY_REGIONS_INCOMPLETE')
        regions.add('global'); need(len(regions) <= MAX_REGIONS, 'INVENTORY_REGION_BOUND')
        return sorted(regions)

    def _builds(self, region):
        rows = self._pages('v1', 'builds', region); result = []
        for row in rows:
            need(type(row) is dict, 'INVENTORY_BUILD_INVALID'); build_id = ledger.native_uuid(row.get('id'))
            need(row.get('projectId') == PROJECT and row.get('name') in {
                'projects/' + p + '/locations/' + region + '/builds/' + build_id for p in (PROJECT, self.project_number)}
                and row.get('status') in STATUSES, 'INVENTORY_BUILD_IDENTITY_CHANGED')
            ledger.timestamp(row.get('createTime'))
            for key in ('startTime', 'finishTime'):
                if key in row: ledger.timestamp(row[key])
            # Accounting fields plus a full native row digest; source, worker,
            # timeout and config changes cannot hide behind the compact report.
            result.append({key: row[key] for key in ('id', 'name', 'projectId', 'status',
                'createTime', 'startTime', 'finishTime') if key in row} | {'native_sha256': canonical_hash(row)})
        return result

    def snapshot(self):
        # One object handles one snapshot; reusing an expired/partial observation
        # is never a cache or permission to omit failed regions.
        need(self.deadline == 0, 'INVENTORY_INSTANCE_ALREADY_USED')
        self.deadline = self.clock() + MAX_SECONDS; started = ledger.stamp(self.utc_now())
        regions = self._regions()
        with ThreadPoolExecutor(max_workers=4) as pool:
            batches = list(pool.map(self._builds, regions))
        need(self.clock() < self.deadline, 'INVENTORY_TIME_BOUND')
        builds = sorted((row for batch in batches for row in batch), key=lambda row: row['name'])
        need(len(builds) <= MAX_BUILDS and len({row['id'] for row in builds}) == len(builds),
             'INVENTORY_DUPLICATE_OR_COUNT_BOUND')
        payload = {'project': PROJECT, 'project_number': self.project_number, 'regions': regions, 'builds': builds}
        return {**payload, 'inventory_sha256': canonical_hash(payload), 'started_at': started,
                'observed_at': ledger.stamp(self.utc_now()), 'response_bytes': self.total_bytes,
                'requests': self.requests, 'complete': True}
