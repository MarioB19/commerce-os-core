"""Generation-bound custody reads and one-shot source uploads for trusted CI.

Bucket/prefix and object descriptors come from the installed, protected service
configuration, never an HTTP event or candidate checkout. This module grants no
IAM, creates no bucket, initializes no ledger, and never retries a request.
"""
import base64
from copy import deepcopy
import hashlib
import os
from pathlib import Path
import re
import stat
import time
import urllib.error
import urllib.parse
import urllib.request

import cloudbuild_admission as ledger
from cloudbuild_connected_source import MAX_ARCHIVE
from cloudbuild_full_evidence import EvidenceError, need
from cloudbuild_gcs_store import generation
from cloudbuild_native_reader import MAX_RESPONSE, NoRedirect, decode

ORIGIN = 'https://storage.googleapis.com'
CHUNK = 1024 * 1024
TRANSFER_SECONDS = 240


def fingerprint(value):
    # Reading may legitimately advance atime; content/link identity must not move.
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_nlink)


class SourceBody:
    """Never send more than the admitted bytes, even if the local file grows."""
    def __init__(self, stream, size, *, clock=time.monotonic):
        self.stream = stream; self.remaining = size; self.sha = hashlib.sha256()
        self.clock = clock; self.deadline = clock() + TRANSFER_SECONDS

    def read(self, count=-1):
        need(self.clock() < self.deadline, 'SOURCE_UPLOAD_TRANSFER_TIME_EXCEEDED')
        if not self.remaining: return b''
        raw = self.stream.read(min(CHUNK if count < 0 else count, self.remaining))
        need(raw, 'SOURCE_UPLOAD_TRUNCATED_DURING_POST')
        self.remaining -= len(raw); self.sha.update(raw)
        return raw


def object_path(value):
    need(type(value) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./-]{0,511}', value)
         and all(part not in {'', '.', '..'} for part in value.split('/')), 'CUSTODY_PATH_INVALID')
    return value


def validate_descriptor(value, *, maximum=MAX_RESPONSE):
    ledger.exact(value, 'bucket object generation sha256 size md5', 'CUSTODY_DESCRIPTOR_FIELDS_INVALID')
    need(type(value['bucket']) is str and re.fullmatch(r'[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]', value['bucket']),
         'CUSTODY_BUCKET_INVALID')
    object_path(value['object']); generation(value['generation']); ledger.digest(value['sha256'])
    need(type(value['size']) is int and 0 < value['size'] <= maximum, 'CUSTODY_SIZE_INVALID')
    try:
        valid = (type(value['md5']) is str and len(base64.b64decode(value['md5'], validate=True)) == 16
                 and base64.b64encode(base64.b64decode(value['md5'])).decode() == value['md5'])
    except (ValueError, TypeError): valid = False
    need(valid, 'CUSTODY_MD5_INVALID')


class ProtectedStorage:
    def __init__(self, token_provider, bucket, prefix, *, opener=None, clock=time.monotonic):
        need(type(bucket) is str and re.fullmatch(r'[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]', bucket),
             'CUSTODY_BUCKET_INVALID')
        object_path(prefix)
        self.token_provider = token_provider; self.bucket = bucket; self.prefix = prefix + '/'
        self.clock = clock
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def _json(self, response):
        deadline = self.clock() + 60; chunks = []; total = 0
        while True:
            need(self.clock() < deadline, 'CUSTODY_JSON_TIME_EXCEEDED')
            raw = response.read1(min(65536, MAX_RESPONSE - total + 1))
            need(self.clock() < deadline, 'CUSTODY_JSON_TIME_EXCEEDED')
            if not raw: break
            total += len(raw); need(total <= MAX_RESPONSE, 'CUSTODY_JSON_TOO_LARGE'); chunks.append(raw)
        return decode(b''.join(chunks))

    def _path(self, name):
        object_path(name); need(name.startswith(self.prefix), 'CUSTODY_PREFIX_CHANGED')
        return ORIGIN + '/storage/v1/b/' + self.bucket + '/o/' + urllib.parse.quote(name, safe='')

    def _request(self, method, url, *, body=None, size=None):
        need(method in {'GET', 'POST'} and url.startswith(ORIGIN + '/'), 'CUSTODY_ENDPOINT_REJECTED')
        try: token = self.token_provider()
        except Exception: raise EvidenceError('CUSTODY_TOKEN_UNAVAILABLE') from None
        need(type(token) is str and token and not any(c.isspace() for c in token), 'CUSTODY_TOKEN_UNAVAILABLE')
        headers = {'Authorization': 'Bearer ' + token, 'Accept-Encoding': 'identity'}
        if body is not None:
            headers.update({'Content-Type': 'application/octet-stream', 'Content-Length': str(size)})
        request = urllib.request.Request(url, method=method, data=body, headers=headers)
        try:
            response = self.opener.open(request, timeout=30)
            if response.status != 200 or response.headers.get('Content-Encoding', 'identity') != 'identity':
                response.close(); raise EvidenceError('CUSTODY_RESPONSE_UNCONFIRMED')
            return response
        except urllib.error.HTTPError as error:
            error.close(); raise EvidenceError('CUSTODY_HTTP_ERROR') from None
        except (OSError, ValueError): raise EvidenceError('CUSTODY_OUTCOME_UNKNOWN') from None

    def _metadata(self, name, observed=None):
        url = self._path(name)
        if observed is not None: url += '?' + urllib.parse.urlencode({'generation': generation(observed)})
        with self._request('GET', url) as response: value = self._json(response)
        need(value.get('bucket') == self.bucket and value.get('name') == name, 'CUSTODY_IDENTITY_CHANGED')
        actual = generation(value.get('generation'))
        need(observed is None or observed == actual, 'CUSTODY_GENERATION_CHANGED')
        need(value.get('contentEncoding') in (None, 'identity') and not value.get('componentCount')
             and type(value.get('size')) is str and re.fullmatch(r'[1-9][0-9]{0,9}', value['size']),
             'CUSTODY_METADATA_INVALID')
        return value

    def _verify_media(self, descriptor, *, collect=False):
        url = self._path(descriptor['object']) + '?' + urllib.parse.urlencode({
            'generation': descriptor['generation'], 'alt': 'media'})
        sha = hashlib.sha256(); md5 = hashlib.md5(); total = 0; chunks = []
        deadline = self.clock() + TRANSFER_SECONDS
        with self._request('GET', url) as response:
            length = response.headers.get('Content-Length')
            need(length is None or length == str(descriptor['size']), 'CUSTODY_CONTENT_LENGTH_CHANGED')
            while True:
                need(self.clock() < deadline, 'CUSTODY_MEDIA_TIME_EXCEEDED')
                raw = response.read1(min(CHUNK, descriptor['size'] - total + 1))
                need(self.clock() < deadline, 'CUSTODY_MEDIA_TIME_EXCEEDED')
                if not raw: break
                total += len(raw); need(total <= descriptor['size'], 'CUSTODY_MEDIA_TOO_LARGE')
                sha.update(raw); md5.update(raw)
                if collect: chunks.append(raw)
        need(total == descriptor['size'] and sha.hexdigest() == descriptor['sha256']
             and base64.b64encode(md5.digest()).decode() == descriptor['md5'], 'CUSTODY_MEDIA_HASH_CHANGED')
        return b''.join(chunks) if collect else None

    def _confirm(self, descriptor, *, collect=False):
        need(descriptor['bucket'] == self.bucket, 'CUSTODY_BUCKET_CHANGED')
        self._path(descriptor['object'])
        metadata = self._metadata(descriptor['object'], descriptor['generation'])
        need(metadata['size'] == str(descriptor['size']) and metadata.get('md5Hash') == descriptor['md5'],
             'CUSTODY_METADATA_HASH_CHANGED')
        return self._verify_media(descriptor, collect=collect)

    def read_json(self, descriptor):
        validate_descriptor(descriptor)
        return decode(self._confirm(descriptor, collect=True))

    def reconcile_source(self, expected):
        """GET-only reconciliation after an uncertain upload; never POST again."""
        ledger.exact(expected, 'bucket object sha256 size md5', 'SOURCE_UPLOAD_FIELDS_INVALID')
        need(expected['bucket'] == self.bucket, 'CUSTODY_BUCKET_CHANGED')
        metadata = self._metadata(expected['object'])
        descriptor = {**deepcopy(expected), 'generation': metadata['generation']}
        validate_descriptor(descriptor, maximum=MAX_ARCHIVE); self._confirm(descriptor)
        return descriptor

    def upload_source_once(self, path, expected, journal, *, attempt_id):
        """One generation-zero POST, only after durable intent and full local hash.

        The caller must reconcile returned UNKNOWN. Missing objects, 412s and
        lost acknowledgments never authorize a second upload of this attempt.
        """
        ledger.native_uuid(attempt_id)
        ledger.exact(expected, 'bucket object sha256 size md5', 'SOURCE_UPLOAD_FIELDS_INVALID')
        validate_descriptor({**expected, 'generation': '1'}, maximum=MAX_ARCHIVE)
        need(expected['bucket'] == self.bucket, 'CUSTODY_BUCKET_CHANGED'); self._path(expected['object'])
        need(expected['object'] == self.prefix + attempt_id + '.tgz', 'SOURCE_UPLOAD_ATTEMPT_PATH_REQUIRED')
        local = Path(path)
        need(local.is_absolute() and local.resolve() == local, 'SOURCE_UPLOAD_PATH_UNSAFE')
        fd = os.open(local, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as body:
            before = os.fstat(body.fileno())
            need(stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid()
                 and stat.S_IMODE(before.st_mode) == 0o600 and before.st_size == expected['size']
                 and before.st_nlink == 1,
                 'SOURCE_UPLOAD_PRIVATE_FILE_REQUIRED')
            sha = hashlib.sha256(); md5 = hashlib.md5(); total = 0
            deadline = self.clock() + 30
            while True:
                need(self.clock() < deadline, 'SOURCE_UPLOAD_HASH_TIME_EXCEEDED')
                raw = body.read(min(CHUNK, expected['size'] - total + 1))
                need(self.clock() < deadline, 'SOURCE_UPLOAD_HASH_TIME_EXCEEDED')
                if not raw: break
                total += len(raw); need(total <= expected['size'], 'SOURCE_UPLOAD_LOCAL_SIZE_CHANGED')
                sha.update(raw); md5.update(raw)
            hashed = os.fstat(body.fileno())
            need(total == expected['size'] and fingerprint(before) == fingerprint(hashed) and sha.hexdigest() == expected['sha256']
                 and base64.b64encode(md5.digest()).decode() == expected['md5'],
                 'SOURCE_UPLOAD_LOCAL_HASH_CHANGED')
            body.seek(0)
            action = 'source-upload:' + attempt_id
            intent = journal.commit_intent(action, expected)
            if intent.get('effect') != 'CREATE_ONCE': return {'state': 'RECONCILIATION_REQUIRED'}
            need(intent.get('intent_sha256') == ledger.canonical_hash(expected)
                 and intent.get('attempt_id') == attempt_id, 'SOURCE_UPLOAD_INTENT_BINDING_CHANGED')
            generation(intent.get('fencing_generation'))
            try:
                bounded = SourceBody(body, expected['size'], clock=self.clock)
                query = urllib.parse.urlencode({'uploadType': 'media', 'name': expected['object'], 'ifGenerationMatch': '0'})
                with self._request('POST', ORIGIN + '/upload/storage/v1/b/' + self.bucket + '/o?' + query,
                                   body=bounded, size=expected['size']) as response:
                    metadata = self._json(response)
                need(bounded.remaining == 0 and bounded.sha.hexdigest() == expected['sha256'],
                     'SOURCE_UPLOAD_SENT_BYTES_CHANGED')
                after = os.fstat(body.fileno())
                need(fingerprint(before) == fingerprint(after),
                     'SOURCE_UPLOAD_FILE_CHANGED_DURING_POST')
                need(metadata.get('bucket') == self.bucket and metadata.get('name') == expected['object'],
                     'SOURCE_UPLOAD_RESPONSE_IDENTITY_CHANGED')
                descriptor = {**deepcopy(expected), 'generation': generation(metadata.get('generation'))}
                self._confirm(descriptor)
                journal.record_result(action, {'status': 'RECONCILED', 'intent_sha256': intent['intent_sha256'],
                    'native_id': descriptor['generation'], 'descriptor': descriptor})
                return {'state': 'SOURCE_UPLOADED_AND_VERIFIED', 'descriptor': descriptor}
            except Exception:
                journal.record_result(action, {'status': 'UNKNOWN', 'intent_sha256': intent['intent_sha256']})
                return {'state': 'UNKNOWN'}
