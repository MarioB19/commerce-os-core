"""Generation-CAS storage for the trusted CI admission controller.

No credential, bucket, IAM, trigger or build is created by importing this module.
The caller supplies a trusted token provider; candidate code never uses this SA.
There are no transport retries or redirects. An ambiguous write blocks the caller
until it reloads and reconciles; it must never authorize a CreateBuild by itself.
"""
import hashlib
import json
import re
import urllib.error
import urllib.parse
import urllib.request

from cloudbuild_admission import AdmissionError, CASConflict, CommitOutcomeUnknown

MAX_BYTES = 4 * 1024 * 1024
ORIGIN = 'https://storage.googleapis.com'


def require(condition, code):
    if not condition:
        raise AdmissionError(code)


def generation(value, *, zero=False):
    require(type(value) is str and re.fullmatch(r'0|[1-9][0-9]*', value)
            and (zero or value != '0') and len(value) <= 20,
            'GCS_GENERATION_INVALID')
    return value


def encode(document):
    require(type(document) is dict, 'LEDGER_OBJECT_REQUIRED')
    try:
        raw = (json.dumps(document, sort_keys=True, separators=(',', ':'),
                          allow_nan=False) + '\n').encode('utf-8')
    except (TypeError, ValueError):
        raise AdmissionError('LEDGER_JSON_INVALID') from None
    require(0 < len(raw) <= MAX_BYTES, 'LEDGER_TOO_LARGE')
    return raw


def decode(raw):
    require(type(raw) is bytes and 0 < len(raw) <= MAX_BYTES, 'GCS_RESPONSE_SIZE_INVALID')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'DUPLICATE_JSON_KEY')
            result[key] = value
        return result
    def constant(_value):
        raise AdmissionError('GCS_JSON_INVALID')
    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeError, ValueError):
        raise AdmissionError('GCS_JSON_INVALID') from None
    require(type(value) is dict, 'GCS_JSON_OBJECT_REQUIRED')
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class SingleRequestTransport:
    """Small authenticated JSON API transport; errors never include credentials."""
    def __init__(self, token_provider):
        self.token_provider = token_provider
        self.opener = urllib.request.build_opener(NoRedirect())

    def __call__(self, method, url, body=None):
        require(method in {'GET', 'POST'} and url.startswith(ORIGIN + '/'),
                'GCS_TRANSPORT_TARGET_INVALID')
        try:
            token = self.token_provider()
        except Exception:
            raise AdmissionError('GCS_TOKEN_UNAVAILABLE') from None
        require(type(token) is str and token and not any(c.isspace() for c in token),
                'GCS_TOKEN_UNAVAILABLE')
        headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/json'}
        if body is not None:
            headers.update({'Content-Type': 'application/json', 'Content-Length': str(len(body))})
        request = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with self.opener.open(request, timeout=20) as response:
                return response.status, response.read(MAX_BYTES + 1)
        except urllib.error.HTTPError as error:
            try:
                return error.code, error.read(MAX_BYTES + 1)
            finally:
                error.close()
        except (OSError, ValueError):
            raise AdmissionError('GCS_TRANSPORT_UNCERTAIN') from None


class GCSAdmissionStore:
    """One private GCS object is the authoritative global admission ledger.

    Configure UBLA/PAP, exclusive controller IAM and no lifecycle deletion for
    this object before use. Missing state is not permission to recreate it: only
    the separately authorized initial bootstrap may CAS generation zero.
    """
    def __init__(self, bucket, object_name, transport):
        require(type(bucket) is str and re.fullmatch(r'[a-z0-9][a-z0-9_-]{1,61}[a-z0-9]', bucket),
                'LEDGER_BUCKET_INVALID')
        require(type(object_name) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./-]{0,511}', object_name)
                and all(part not in {'', '.', '..'} for part in object_name.split('/')),
                'LEDGER_PATH_INVALID')
        self.bucket = bucket
        self.object_name = object_name
        self.transport = transport
        self.url = ORIGIN + '/storage/v1/b/' + bucket + '/o/' + urllib.parse.quote(object_name, safe='')

    def metadata(self, value):
        require(value.get('bucket') == self.bucket and value.get('name') == self.object_name,
                'LEDGER_OBJECT_IDENTITY_MISMATCH')
        observed = generation(value.get('generation'))
        size = value.get('size')
        require(type(size) is str and re.fullmatch(r'[1-9][0-9]*', size)
                and len(size) <= 10 and int(size) <= MAX_BYTES, 'LEDGER_SIZE_INVALID')
        require(value.get('contentEncoding') in (None, 'identity'), 'LEDGER_ENCODING_UNSUPPORTED')
        return observed, int(size)

    def media(self, observed, size):
        status, raw = self.transport('GET', self.url + '?' + urllib.parse.urlencode({
            'alt': 'media', 'generation': generation(observed)}))
        require(status == 200 and len(raw) == size and len(raw) <= MAX_BYTES,
                'LEDGER_GENERATION_READ_FAILED')
        return raw

    def load(self):
        status, raw = self.transport('GET', self.url)
        if status == 404:
            return '0', None
        require(status == 200, 'LEDGER_METADATA_READ_FAILED')
        observed, size = self.metadata(decode(raw))
        return observed, decode(self.media(observed, size))

    def compare_and_swap(self, expected_generation, document):
        expected = generation(expected_generation, zero=True)
        raw = encode(document)
        url = ORIGIN + '/upload/storage/v1/b/' + self.bucket + '/o?' + urllib.parse.urlencode({
            'uploadType': 'media', 'name': self.object_name, 'ifGenerationMatch': expected})
        # Exactly one POST. A caller must reload after any exception, never
        # assume a timeout means the write did not happen and repeat an effect.
        try:
            status, response = self.transport('POST', url, raw)
        except Exception:
            raise CommitOutcomeUnknown('LEDGER_CAS_OUTCOME_UNKNOWN') from None
        if status == 412:
            raise CASConflict('LEDGER_GENERATION_CONFLICT')
        try:
            require(status == 200, 'LEDGER_CAS_RESPONSE_UNCONFIRMED')
            observed, size = self.metadata(decode(response))
            require(observed != expected and size == len(raw), 'LEDGER_CAS_IDENTITY_UNCONFIRMED')
            readback = self.media(observed, size)
            require(hashlib.sha256(readback).digest() == hashlib.sha256(raw).digest()
                    and readback == raw, 'LEDGER_CAS_READBACK_MISMATCH')
        except Exception:
            raise CommitOutcomeUnknown('LEDGER_CAS_OUTCOME_UNKNOWN') from None
        return observed
