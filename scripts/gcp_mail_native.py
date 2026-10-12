"""Native transport components; no runtime factory or provisioning entrypoint.

Inputs are sealed service configuration and trusted internal callbacks. No HTTP
request chooses URLs, credentials, journal object, key version or effect fence.
"""
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import re
import signal
import threading
import time
from urllib import error, parse, request

import gcp_mail_dispatch as core

MAX_JSON = 4 * 1024 * 1024
CERTS = 'https://www.googleapis.com/oauth2/v3/certs'


def document(raw, maximum=MAX_JSON):
    core.need(type(raw) is bytes and 0 < len(raw) <= maximum, 'MAIL_NATIVE_BODY_BOUND')
    def pairs(items):
        result = {}
        for key, value in items:
            core.need(key not in result, 'MAIL_NATIVE_DUPLICATE_JSON')
            result[key] = value
        return result
    def invalid(_):
        raise core.MailError('MAIL_NATIVE_NONFINITE_JSON')
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)
    except (ValueError, UnicodeError, RecursionError):
        raise core.MailError('MAIL_NATIVE_INVALID_JSON') from None


@contextmanager
def deadline(seconds):
    core.need(threading.current_thread() is threading.main_thread() and
              0 < seconds <= 30 and signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0),
              'MAIL_NATIVE_DEADLINE_REQUIRED')
    previous = signal.getsignal(signal.SIGALRM)
    def stop(*_):
        raise core.MailError('MAIL_NATIVE_TIMEOUT')
    signal.signal(signal.SIGALRM, stop)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise core.MailError('MAIL_NATIVE_REDIRECT_FORBIDDEN')


class NativeHTTP:
    """One call, absolute deadline, bounded body, no credential-bearing errors."""
    def __init__(self, *, finish_at, opener=None, monotonic=time.monotonic):
        self.finish_at, self.monotonic = finish_at, monotonic
        self.opener = opener or request.build_opener(request.ProxyHandler({}), NoRedirect())
        self.calls = 0
        self.reserved_bytes = 0

    def __call__(self, method, url, *, token=None, body=None, maximum=MAX_JSON, before_send=None):
        parsed = parse.urlsplit(url)
        core.need(parsed.scheme == 'https' and parsed.netloc in
                  {'www.googleapis.com', 'secretmanager.googleapis.com', 'storage.googleapis.com'}
                  and not parsed.fragment and method in {'GET', 'POST'}, 'MAIL_NATIVE_ENDPOINT')
        core.need(type(maximum) is int and 1 <= maximum <= MAX_JSON and
                  (body is None or type(body) is bytes and len(body) <= MAX_JSON), 'MAIL_NATIVE_BODY_BOUND')
        core.need((method == 'GET' and body is None) or
                  (method == 'POST' and body is not None and callable(before_send)), 'MAIL_NATIVE_METHOD')
        # Conservative aggregate limits are internal safeguards, not billing caps.
        reserved = maximum + 1 + (len(body) if body is not None else 0)
        core.need(self.calls < 24 and self.reserved_bytes + reserved <= 32 * 1024 * 1024,
                  'MAIL_NATIVE_REQUEST_BUDGET')
        headers = {'Accept-Encoding': 'identity', 'Accept': 'application/json'}
        if token is not None:
            core.need(type(token) is str and 0 < len(token) <= 8192 and
                      not any(ord(c) < 33 or ord(c) > 126 for c in token), 'MAIL_NATIVE_TOKEN_INVALID')
            headers['Authorization'] = 'Bearer ' + token
        if body is not None:
            headers['Content-Type'] = 'application/json'
        req = request.Request(url, data=body, headers=headers, method=method)
        self.calls += 1
        self.reserved_bytes += reserved
        if before_send:
            before_send()
        remaining = self.finish_at - self.monotonic()
        core.need(remaining > 0, 'MAIL_NATIVE_TIMEOUT')
        try:
            with deadline(min(remaining, 10)):
                with self.opener.open(req, timeout=min(remaining, 5)) as response:
                    core.need(response.status == 200 and response.headers.get('Content-Encoding', 'identity') == 'identity'
                              and response.headers.get('Content-Type', '').split(';')[0].lower() in
                              {'application/json', 'application/octet-stream'}, 'MAIL_NATIVE_RESPONSE')
                    chunks = []; size = 0
                    while True:
                        core.need(self.monotonic() < self.finish_at, 'MAIL_NATIVE_TIMEOUT')
                        block = response.read1(min(65536, maximum + 1 - size))
                        if not block:
                            break
                        size += len(block)
                        core.need(size <= maximum, 'MAIL_NATIVE_BODY_BOUND')
                        chunks.append(block)
                    return b''.join(chunks)
        except error.HTTPError as exc:
            code = exc.code
            exc.close()
            raise core.MailError('MAIL_NATIVE_HTTP_' + str(code) if code in {400, 401, 403, 404, 409, 412, 429}
                                 else 'MAIL_NATIVE_HTTP_UNKNOWN') from None
        except core.MailError:
            raise
        except Exception:
            raise core.MailError('MAIL_NATIVE_NETWORK_UNKNOWN') from None


class GoogleIdentity:
    def __init__(self, http, *, clock=lambda: datetime.now(timezone.utc)):
        self.http, self.clock = http, clock

    def __call__(self, token, audience):
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding, rsa
        core.need(type(token) is str and len(token) <= 8192 and token.count('.') == 2, 'MAIL_ID_TOKEN_INVALID')
        head, body, signature = token.split('.')
        header, claims = document(core.unb64(head, 2048)), document(core.unb64(body, 6144))
        core.exact(header, 'alg kid typ', 'MAIL_ID_TOKEN_HEADER')
        core.need(header['alg'] == 'RS256' and header['typ'] == 'JWT' and
                  type(header['kid']) is str and re.fullmatch('[A-Za-z0-9_-]{1,128}', header['kid']),
                  'MAIL_ID_TOKEN_HEADER')
        keys = document(self.http('GET', CERTS, maximum=65536))
        core.exact(keys, 'keys', 'MAIL_ID_KEYS_FIELDS')
        core.need(type(keys['keys']) is list and 1 <= len(keys['keys']) <= 10, 'MAIL_ID_KEYS_BOUND')
        matches = [key for key in keys['keys'] if type(key) is dict and key.get('kid') == header['kid']]
        core.need(len(matches) == 1, 'MAIL_ID_KEY_NOT_UNIQUE')
        key = matches[0]
        core.need(key.get('alg') == 'RS256' and key.get('kty') == 'RSA' and key.get('use') == 'sig', 'MAIL_ID_KEY_TYPE')
        n, e = int.from_bytes(core.unb64(key.get('n'), 512), 'big'), int.from_bytes(core.unb64(key.get('e'), 8), 'big')
        core.need(n.bit_length() in {2048, 3072, 4096} and e == 65537, 'MAIL_ID_KEY_SIZE')
        try:
            rsa.RSAPublicNumbers(e, n).public_key().verify(core.unb64(signature, 512),
                (head + '.' + body).encode('ascii'), padding.PKCS1v15(), hashes.SHA256())
        except Exception:
            raise core.MailError('MAIL_ID_SIGNATURE_INVALID') from None
        now = core.utc(self.clock()).timestamp()
        core.need(type(claims) is dict and claims.get('iss') in {'accounts.google.com', 'https://accounts.google.com'}
                  and claims.get('aud') == audience and type(claims.get('iat')) is int
                  and type(claims.get('exp')) is int and claims['iat'] <= now < claims['exp'] <= claims['iat'] + 3600,
                  'MAIL_ID_CLAIMS_INVALID')
        return claims


def crc32c(raw):
    value = 0xffffffff
    for byte in raw:
        value ^= byte
        for _ in range(8):
            value = (value >> 1) ^ (0x82f63b78 if value & 1 else 0)
    return value ^ 0xffffffff


class SecretKey:
    def __init__(self, http, credential, version):
        core.need(type(version) is str and re.fullmatch(r'projects/[1-9][0-9]*/secrets/[A-Za-z0-9_-]{1,255}/versions/[1-9][0-9]*', version),
                  'MAIL_SECRET_VERSION_REQUIRED')
        self.http, self.credential, self.version = http, credential, version

    def __call__(self):
        value = document(self.http('GET', 'https://secretmanager.googleapis.com/v1/' + self.version + ':access',
                                   token=self.credential(), maximum=4096))
        core.exact(value, 'name payload', 'MAIL_SECRET_FIELDS')
        core.need(value['name'] == self.version, 'MAIL_SECRET_VERSION_CHANGED')
        payload = value['payload']; core.exact(payload, 'data dataCrc32c', 'MAIL_SECRET_PAYLOAD')
        try:
            raw = base64.b64decode(payload['data'], validate=True)
        except Exception:
            raise core.MailError('MAIL_SECRET_INVALID') from None
        core.need(type(payload['dataCrc32c']) is str and payload['dataCrc32c'] == str(crc32c(raw))
                  and len(raw) == 32 and base64.b64encode(raw).decode() == payload['data'], 'MAIL_SECRET_CHECKSUM')
        return raw


class JournalStore:
    def __init__(self, http, credential, *, bucket, name, fence):
        core.need(type(bucket) is str and re.fullmatch('[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', bucket), 'MAIL_JOURNAL_BUCKET')
        core.need(type(name) is str and re.fullmatch(r'mail/[a-z0-9-]{1,64}/journal\.json', name), 'MAIL_JOURNAL_NAME')
        core.need(callable(fence), 'MAIL_JOURNAL_FENCE')
        self.http, self.credential, self.bucket, self.name, self.fence = http, credential, bucket, name, fence
        self.url = 'https://storage.googleapis.com/storage/v1/b/' + bucket + '/o/' + parse.quote(name, safe='')
        self.attempted = set()

    def metadata(self, token):
        value = document(self.http('GET', self.url, token=token, maximum=16384))
        core.need(type(value) is dict and value.get('bucket') == self.bucket and value.get('name') == self.name
                  and type(value.get('generation')) is str and re.fullmatch('[1-9][0-9]*', value['generation'])
                  and type(value.get('size')) is str and re.fullmatch('[1-9][0-9]{0,7}', value['size']) and int(value['size']) <= MAX_JSON
                  and type(value.get('md5Hash')) is str and 'contentEncoding' not in value, 'MAIL_JOURNAL_METADATA')
        return value

    def _load_original(self):
        token = self.credential(); before = self.metadata(token)
        raw = self.http('GET', self.url + '?alt=media&generation=' + before['generation'],
                        token=token, maximum=int(before['size']))
        core.need(len(raw) == int(before['size']) and base64.b64encode(hashlib.md5(raw).digest()).decode() == before['md5Hash'],
                  'MAIL_JOURNAL_HASH')
        after = self.metadata(token)
        core.need(all(after[k] == before[k] for k in ('generation', 'size', 'md5Hash')), 'MAIL_JOURNAL_CHANGED')
        return before['generation'], core.validate_journal(document(raw)), raw

    def load(self):
        generation, value, _raw = self._load_original()
        return generation, value

    def compare_and_swap(self, generation, value):
        core.need(type(generation) is str and re.fullmatch('[1-9][0-9]*', generation) and
                  generation not in self.attempted, 'MAIL_JOURNAL_CAS_REPLAY')
        raw = core.encode(core.validate_journal(value)); core.need(len(raw) <= MAX_JSON, 'MAIL_JOURNAL_BODY_BOUND')
        token = self.credential()
        url = 'https://storage.googleapis.com/upload/storage/v1/b/' + self.bucket + '/o?' + parse.urlencode(
            {'uploadType': 'media', 'name': self.name, 'ifGenerationMatch': generation})
        self.attempted.add(generation)
        written = document(self.http('POST', url, token=token, body=raw, maximum=16384, before_send=self.fence))
        new = written.get('generation') if type(written) is dict else None
        core.need(type(new) is str and re.fullmatch('[1-9][0-9]*', new) and new != generation
                  and written.get('bucket') == self.bucket and written.get('name') == self.name
                  and written.get('size') == str(len(raw))
                  and written.get('md5Hash') == base64.b64encode(hashlib.md5(raw).digest()).decode()
                  and 'contentEncoding' not in written,
                  'MAIL_JOURNAL_CAS_UNCONFIRMED')
        confirmed, _actual, actual_raw = self._load_original()
        core.need(confirmed == new and actual_raw == raw, 'MAIL_JOURNAL_CAS_UNCONFIRMED')
        return confirmed
