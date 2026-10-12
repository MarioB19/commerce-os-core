"""Read-only Google REST adapter for the trusted FULL evidence contract.

The controller supplies its ADC token provider and its trusted source reader.
This module never discovers a personal account, invokes gcloud/gh, creates or
approves builds, publishes a check, or imports code from a candidate checkout.
The bootstrap contract still rejects public-repository and trigger profiles.
"""
import json
import time
import urllib.error
import urllib.request

from cloudbuild_full_evidence import (PROJECT, REPOSITORY, EvidenceError, need,
    validate_manifest, log_filter, evaluate_reader)

MAX_RESPONSE = 4 * 1024 * 1024
MAX_LOG_PAGES = 8
MAX_LOG_SECONDS = 90
PROJECT_URL = 'https://cloudresourcemanager.googleapis.com/v1/projects/' + PROJECT
BUILD_ROOT = 'https://cloudbuild.googleapis.com/v1/projects/' + PROJECT + '/locations/'
LOG_URL = 'https://logging.googleapis.com/v2/entries:list'


def decode(raw):
    need(type(raw) is bytes and 0 < len(raw) <= MAX_RESPONSE, 'NATIVE_RESPONSE_SIZE_INVALID')

    def pairs(items):
        value = {}
        for key, item in items:
            need(key not in value, 'NATIVE_DUPLICATE_JSON_KEY')
            value[key] = item
        return value

    def constant(_value):
        raise EvidenceError('NATIVE_JSON_INVALID')

    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeError, ValueError):
        raise EvidenceError('NATIVE_JSON_INVALID') from None
    need(type(value) is dict, 'NATIVE_JSON_OBJECT_REQUIRED')
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GoogleFullReader:
    """Bounded native reads; missing, truncated or uncertain data never passes.

    commit_reader(repository, sha) must read the authenticated source of truth,
    not a candidate receipt. It uses separate credentials, if required. Google
    bearer tokens are used only for the three fixed Google API read operations.
    ADC acquisition/refresh belongs to the trusted caller, not candidate code.
    """
    def __init__(self, token_provider, commit_reader, *, opener=None):
        self.token_provider = token_provider
        self.commit_reader = commit_reader
        self.opener = opener or urllib.request.build_opener(
            urllib.request.ProxyHandler({}), NoRedirect())

    def _read(self, operation, m=None, *, page_token='',
              remaining_bytes=MAX_RESPONSE, deadline=None, with_size=False):
        if operation == 'project':
            method, url, payload = 'GET', PROJECT_URL, None
        else:
            validate_manifest(m)
            if operation == 'build':
                method, url, payload = ('GET', BUILD_ROOT + m['region'] +
                                        '/builds/' + m['build_id'], None)
            elif operation == 'logs':
                method, url = 'POST', LOG_URL
                # entries.list is a read operation. No default one-day filter,
                # no unbounded pagination, and no follow-up URL from a response.
                payload = {'resourceNames': ['projects/' + PROJECT],
                           'filter': log_filter(m), 'orderBy': 'timestamp asc',
                           'pageSize': 100}
                need(type(page_token) is str and len(page_token) <= 4096,
                     'LOG_PAGE_TOKEN_INVALID')
                if page_token:
                    payload['pageToken'] = page_token
            else:
                raise EvidenceError('NATIVE_READ_OPERATION_INVALID')
        need(type(remaining_bytes) is int and 0 < remaining_bytes <= MAX_RESPONSE,
             'NATIVE_RESPONSE_SIZE_INVALID')
        need(deadline is None or time.monotonic() < deadline, 'LOG_QUERY_DEADLINE')
        try:
            token = self.token_provider()
        except Exception:
            raise EvidenceError('NATIVE_TOKEN_UNAVAILABLE') from None
        need(type(token) is str and token and not any(c.isspace() for c in token),
             'NATIVE_TOKEN_UNAVAILABLE')
        headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/json'}
        body = None
        if payload is not None:
            body = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(url, data=body, method=method, headers=headers)
        remaining = 20 if deadline is None else min(20, deadline - time.monotonic())
        need(remaining > 0, 'LOG_QUERY_DEADLINE')
        try:
            with self.opener.open(request, timeout=remaining) as response:
                need(response.status == 200, 'NATIVE_READ_UNCONFIRMED')
                raw = response.read(remaining_bytes + 1)
        except urllib.error.HTTPError as error:
            # Never relay server text, request headers, URLs or token values.
            error.close()
            raise EvidenceError('NATIVE_READ_HTTP_ERROR') from None
        except (OSError, ValueError):
            raise EvidenceError('NATIVE_READ_UNCERTAIN') from None
        need(deadline is None or time.monotonic() < deadline, 'LOG_QUERY_DEADLINE')
        need(len(raw) <= remaining_bytes, 'NATIVE_RESPONSE_SIZE_INVALID')
        value = decode(raw)
        return (value, len(raw)) if with_size else value

    def project(self):
        return self._read('project')

    def commit(self, m):
        validate_manifest(m)
        return self.commit_reader(REPOSITORY, m['source_sha'])

    def build(self, m):
        return self._read('build', m)

    def logs(self, m):
        validate_manifest(m)
        entries = []; seen = set(); token = ''; remaining = MAX_RESPONSE
        deadline = time.monotonic() + MAX_LOG_SECONDS
        for _ in range(MAX_LOG_PAGES):
            response, size = self._read('logs', m, page_token=token,
                remaining_bytes=remaining, deadline=deadline, with_size=True)
            remaining -= size
            need(set(response) <= {'entries', 'nextPageToken'}
                 and type(response.get('entries', [])) is list, 'LOG_QUERY_INCOMPLETE')
            entries.extend(response.get('entries', []))
            need(len(entries) < 100, 'LOG_QUERY_INCOMPLETE')
            token = response.get('nextPageToken', '')
            need(type(token) is str and len(token) <= 4096, 'LOG_PAGE_TOKEN_INVALID')
            if not token:
                return entries
            need(token not in seen, 'LOG_PAGE_TOKEN_REPEATED')
            seen.add(token)
        raise EvidenceError('LOG_QUERY_INCOMPLETE')

    def evaluate(self, m):
        return evaluate_reader(m, self)
