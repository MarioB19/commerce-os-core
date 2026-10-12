"""Synthetic cryptographic and transport fixtures: no ADC, real key or network."""
import base64
from contextlib import nullcontext
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import io
import json
import pathlib
import signal
import sys
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

S = pathlib.Path(__file__).resolve().parents[2] / 'scripts'
sys.path.insert(0, str(S))
import gcp_mail_dispatch as core
import gcp_mail_native as m
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

NOW = datetime(2026, 10, 11, 21, tzinfo=timezone.utc)
VERSION = 'projects/123456789012/secrets/synthetic-mail-key/versions/1'
BUCKET, NAME = 'synthetic-mail-custody', 'mail/synthetic-release/journal.json'


def metadata(raw, generation='1'):
    return {'bucket': BUCKET, 'name': NAME, 'generation': generation,
            'size': str(len(raw)), 'md5Hash': base64.b64encode(hashlib.md5(raw).digest()).decode()}


class Response:
    status = 200
    def __init__(self, raw=b'{}', headers=None):
        self.stream = io.BytesIO(raw)
        self.headers = headers or {'Content-Type': 'application/json'}
        self.closed = False
    def read1(self, size): return self.stream.read(size)
    def __enter__(self): return self
    def __exit__(self, *_): self.closed = True


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.clock = [0.0]
        self.response = Response()
        self.opener = Mock(); self.opener.open.return_value = self.response
        self.http = m.NativeHTTP(finish_at=20, opener=self.opener, monotonic=lambda: self.clock[0])
    def test_fixed_tls_no_redirect_credentials_or_endpoint_override(self):
        for url in ('http://storage.googleapis.com/a', 'https://storage.googleapis.com.evil.test/a',
                    'https://user@storage.googleapis.com/a', 'https://storage.googleapis.com:443/a',
                    'https://storage.googleapis.com/a#fragment'):
            with self.subTest(url=url), self.assertRaisesRegex(core.MailError, 'ENDPOINT'):
                self.http('GET', url)
        self.opener.open.assert_not_called()
        with self.assertRaisesRegex(core.MailError, 'REDIRECT'):
            m.NoRedirect().redirect_request(None, None, None, None, None, None)
    def test_post_fence_runs_after_credentials_and_immediately_before_open(self):
        calls = []
        self.opener.open.side_effect = lambda *_a, **_kw: calls.append('open') or Response()
        self.http('POST', 'https://storage.googleapis.com/upload', token='SYNTHETIC', body=b'{}',
                  before_send=lambda: calls.append('fence'))
        self.assertEqual(calls, ['fence', 'open'])
        req = self.opener.open.call_args.args[0]
        self.assertEqual(req.get_header('Authorization'), 'Bearer SYNTHETIC')
        self.assertEqual(req.get_header('Accept-encoding'), 'identity')
        for method, body in [('POST', b'{}'), ('GET', b'{}'), ('PUT', b'{}')]:
            with self.assertRaises(core.MailError):
                self.http(method, 'https://storage.googleapis.com/a', body=body)
    def test_pause_or_expiry_after_fence_prevents_open(self):
        with self.assertRaisesRegex(core.MailError, 'PAUSED'):
            self.http('POST', 'https://storage.googleapis.com/a', body=b'{}',
                      before_send=lambda: (_ for _ in ()).throw(core.MailError('PAUSED')))
        self.opener.open.assert_not_called()
        with self.assertRaisesRegex(core.MailError, 'TIMEOUT'):
            self.http('POST', 'https://storage.googleapis.com/a', body=b'{}',
                      before_send=lambda: self.clock.__setitem__(0, 20))
        self.opener.open.assert_not_called()
        self.assertEqual(self.http.calls, 2)  # Failed reservations are retained.
    def test_exact_byte_bound_encoding_and_closed_error_messages(self):
        self.response = Response(b'12345'); self.opener.open.return_value = self.response
        with self.assertRaisesRegex(core.MailError, 'BODY_BOUND'):
            self.http('GET', m.CERTS, maximum=4)
        self.assertTrue(self.response.closed)
        self.opener.open.return_value = Response(headers={'Content-Type': 'application/json', 'Content-Encoding': 'gzip'})
        with self.assertRaisesRegex(core.MailError, 'RESPONSE'): self.http('GET', m.CERTS)
        self.opener.open.side_effect = OSError('SYNTHETIC_SECRET_DO_NOT_EMIT')
        with self.assertRaisesRegex(core.MailError, '^MAIL_NATIVE_NETWORK_UNKNOWN$'): self.http('GET', m.CERTS)
        error = HTTPError(m.CERTS, 403, 'SYNTHETIC_SECRET', {}, io.BytesIO(b'PRIVATE'))
        self.opener.open.side_effect = error
        with self.assertRaisesRegex(core.MailError, '^MAIL_NATIVE_HTTP_403$'): self.http('GET', m.CERTS)
        self.assertTrue(error.fp.closed)
    def test_request_and_aggregate_reservations_precede_io(self):
        self.opener.open.side_effect = lambda *_a, **_kw: Response(b'1')
        for _ in range(24): self.http('GET', m.CERTS, maximum=1)
        with self.assertRaisesRegex(core.MailError, 'REQUEST_BUDGET'): self.http('GET', m.CERTS, maximum=1)
        self.assertEqual(self.opener.open.call_count, 24)
    def test_upload_bytes_are_reserved_before_post_without_refund(self):
        self.http.reserved_bytes = 32 * 1024 * 1024 - 5
        with self.assertRaisesRegex(core.MailError, 'REQUEST_BUDGET'):
            self.http('POST', 'https://storage.googleapis.com/upload', body=b'1234',
                      maximum=1, before_send=Mock())
        self.opener.open.assert_not_called()
        self.http.reserved_bytes = 0
        with self.assertRaisesRegex(core.MailError, 'SYNTHETIC_PAUSED'):
            self.http('POST', 'https://storage.googleapis.com/upload', body=b'1234', maximum=1,
                      before_send=Mock(side_effect=core.MailError('SYNTHETIC_PAUSED')))
        self.assertEqual(self.http.reserved_bytes, 6)
        self.opener.open.assert_not_called()

    def test_aggregate_response_budget_is_independent_of_request_count(self):
        self.http = m.NativeHTTP(finish_at=20, opener=self.opener, monotonic=lambda: 0)
        self.http.reserved_bytes = 32 * 1024 * 1024 - 1
        with self.assertRaisesRegex(core.MailError, 'REQUEST_BUDGET'): self.http('GET', m.CERTS, maximum=1)
        self.opener.open.assert_not_called()
    def test_absolute_alarm_and_handler_are_restored_after_failure(self):
        before = signal.getsignal(signal.SIGALRM)
        def timed_out(*_a, **_kw):
            signal.getsignal(signal.SIGALRM)(signal.SIGALRM, None)
        self.opener.open.side_effect = timed_out
        with self.assertRaisesRegex(core.MailError, '^MAIL_NATIVE_TIMEOUT$'): self.http('GET', m.CERTS)
        self.assertEqual(signal.getsignal(signal.SIGALRM), before)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))
    def test_preexisting_timer_is_not_overwritten(self):
        with patch.object(signal, 'getitimer', return_value=(1.0, 0.0)), patch.object(signal, 'setitimer') as setter:
            with self.assertRaisesRegex(core.MailError, 'DEADLINE_REQUIRED'): self.http('GET', m.CERTS)
        setter.assert_not_called(); self.opener.open.assert_not_called()


class IdentityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        numbers = cls.key.public_key().public_numbers()
        cls.jwk = {'kid': 'synthetic-key-1', 'alg': 'RS256', 'kty': 'RSA', 'use': 'sig',
                   'n': core.b64(numbers.n.to_bytes(256, 'big')), 'e': core.b64(numbers.e.to_bytes(3, 'big'))}
    def setUp(self):
        self.claims = {'iss': 'https://accounts.google.com', 'aud': 'https://mail.example',
                       'iat': int(NOW.timestamp()), 'exp': int(NOW.timestamp())+3600,
                       'sub': '123456789012345678901', 'email': 'fixture@example.invalid', 'email_verified': True}
        self.header = {'alg': 'RS256', 'typ': 'JWT', 'kid': 'synthetic-key-1'}
        self.http = Mock(return_value=core.encode({'keys': [self.jwk]}))
        self.auth = m.GoogleIdentity(self.http, clock=lambda: NOW)
    def token(self, claims=None, header=None, signer=None):
        head, body = core.b64(core.encode(header or self.header)), core.b64(core.encode(claims or self.claims))
        sig = (signer or self.key).sign((head+'.'+body).encode(), padding.PKCS1v15(), hashes.SHA256())
        return head+'.'+body+'.'+core.b64(sig)
    def test_real_rsa_signature_exact_fixed_certs_and_audience(self):
        self.assertEqual(self.auth(self.token(), 'https://mail.example'), self.claims)
        self.http.assert_called_once_with('GET', m.CERTS, maximum=65536)
    def test_wrong_key_or_modified_signed_payload_is_rejected(self):
        token = self.token(); pieces = token.split('.'); claims = deepcopy(self.claims); claims['sub'] = '999'
        pieces[1] = core.b64(core.encode(claims))
        with self.assertRaisesRegex(core.MailError, 'SIGNATURE_INVALID'): self.auth('.'.join(pieces), 'https://mail.example')
        other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        with self.assertRaisesRegex(core.MailError, 'SIGNATURE_INVALID'): self.auth(self.token(signer=other), 'https://mail.example')
    def test_unknown_duplicate_or_small_key_rejected(self):
        for keys in ([], [dict(self.jwk, kid='other')], [self.jwk, self.jwk], [dict(self.jwk, n=core.b64(b'\xff'*128))]):
            self.http.return_value = core.encode({'keys': keys})
            with self.subTest(keys=len(keys)), self.assertRaises(core.MailError): self.auth(self.token(), 'https://mail.example')
    def test_alg_none_extra_header_and_type_confusion(self):
        for key, value in [('alg', 'none'), ('kid', 'https://evil.invalid'), ('typ', None), ('jku', 'https://evil.invalid')]:
            head = dict(self.header); head[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(core.MailError, 'HEADER'): self.auth(self.token(header=head), 'https://mail.example')
        self.http.assert_not_called()
    def test_signed_expiry_future_issue_duration_audience_issuer_and_bool_rejected(self):
        for key, value in [('exp', int(NOW.timestamp())), ('iat', int(NOW.timestamp())+1),
                           ('exp', int(NOW.timestamp())+3601), ('aud', 'https://other.example'),
                           ('iss', 'https://evil.invalid'), ('iat', True)]:
            claims = dict(self.claims); claims[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(core.MailError, 'CLAIMS_INVALID'):
                self.auth(self.token(claims=claims), 'https://mail.example')
    def test_key_fetch_consuming_token_lifetime_fails(self):
        now = [NOW]
        self.auth.clock = lambda: now[0]
        def fetch(*_a, **_kw):
            now[0] += timedelta(hours=1)
            return core.encode({'keys': [self.jwk]})
        self.http.side_effect = fetch
        with self.assertRaisesRegex(core.MailError, 'CLAIMS_INVALID'): self.auth(self.token(), 'https://mail.example')


class SecretTests(unittest.TestCase):
    def setUp(self):
        self.raw = bytes(range(32))
        self.payload = {'name': VERSION, 'payload': {'data': base64.b64encode(self.raw).decode(), 'dataCrc32c': str(m.crc32c(self.raw))}}
        self.http = Mock(side_effect=lambda *_a, **_kw: core.encode(self.payload))
        self.credential = Mock(return_value='SYNTHETIC_ADC')
        self.key = m.SecretKey(self.http, self.credential, VERSION)
    def test_numeric_exact_version_and_crc_known_vector(self):
        self.assertEqual(m.crc32c(b'123456789'), 0xe3069283)
        self.assertEqual(self.key(), self.raw)
        self.http.assert_called_once_with('GET', 'https://secretmanager.googleapis.com/v1/'+VERSION+':access', token='SYNTHETIC_ADC', maximum=4096)
    def test_latest_wrong_project_or_secret_checks_before_return(self):
        for version in (VERSION.replace('/1', '/latest'), VERSION.replace('/versions/1', '/versions/0'), VERSION+'?alt=media'):
            with self.subTest(version=version), self.assertRaisesRegex(core.MailError, 'VERSION_REQUIRED'):
                m.SecretKey(self.http, self.credential, version)
        self.http.assert_not_called()
        self.payload['name'] = VERSION.replace('/versions/1', '/versions/2')
        with self.assertRaisesRegex(core.MailError, 'VERSION_CHANGED'): self.key()
    def test_corrupt_crc_noncanonical_base64_wrong_length_and_extra_fields(self):
        original = deepcopy(self.payload)
        for mutation in (lambda p:p['payload'].update(dataCrc32c='0'), lambda p:p['payload'].update(data=p['payload']['data']+'\n'),
                         lambda p:p['payload'].update(data=base64.b64encode(b'x').decode(), dataCrc32c=str(m.crc32c(b'x'))),
                         lambda p:p['payload'].update(secret='SYNTHETIC_PRIVATE')):
            self.payload = deepcopy(original); mutation(self.payload)
            with self.assertRaises(core.MailError): self.key()
    def test_duplicate_json_nonfinite_and_invalid_unicode_rejected(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'\xff', b'['*10000):
            with self.subTest(raw=raw[:8]), self.assertRaises(core.MailError): m.document(raw)


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.raw = core.encode(core.initial_journal()); self.generation = '1'; self.calls = []
        self.fence = Mock(); self.credential = Mock(return_value='SYNTHETIC_ADC')
        self.on_post = None; self.after_media = None
        self.store = m.JournalStore(self.http, self.credential, bucket=BUCKET, name=NAME, fence=self.fence)
    def http(self, method, url, **kw):
        self.calls.append((method, url))
        if method == 'POST':
            kw['before_send']()
            if self.on_post: return self.on_post(kw)
            self.raw = kw['body']; self.generation = str(int(self.generation)+1)
            return core.encode(metadata(self.raw, self.generation))
        if 'alt=media' in url:
            self.assertIn('generation='+self.generation, url)
            raw = self.raw
            if self.after_media: self.after_media()
            return raw
        return core.encode(metadata(self.raw, self.generation))
    def test_read_generation_bytes_md5_and_current_before_return(self):
        self.assertEqual(self.store.load(), ('1', core.initial_journal()))
        self.assertEqual([a for a,_ in self.calls], ['GET']*3)
        self.assertIn('mail%2Fsynthetic-release%2Fjournal.json', self.calls[0][1])
    def test_readback_cas_is_single_post_fixed_object_positive_generation(self):
        self.assertEqual(self.store.compare_and_swap('1', core.initial_journal()), '2')
        self.assertEqual([a for a,_ in self.calls], ['POST', 'GET', 'GET', 'GET'])
        self.assertIn('ifGenerationMatch=1', self.calls[0][1]); self.fence.assert_called_once()
        with self.assertRaisesRegex(core.MailError, 'CAS_REPLAY'): self.store.compare_and_swap('1', core.initial_journal())
    def test_missing_or_changed_metadata_never_recreates(self):
        self.store.http = Mock(side_effect=core.MailError('MAIL_NATIVE_HTTP_404'))
        with self.assertRaisesRegex(core.MailError, '404'): self.store.load()
        self.store.http.assert_called_once()
        for value in ('0', '01', '', True):
            with self.subTest(generation=value), self.assertRaises(core.MailError):
                self.store.compare_and_swap(value, core.initial_journal())
    def test_generation_changes_during_media_cannot_return_document(self):
        self.after_media = lambda:setattr(self, 'generation', '2')
        with self.assertRaisesRegex(core.MailError, 'JOURNAL_CHANGED'): self.store.load()
    def test_lost_cas_ack_never_reposts_same_generation(self):
        def uncertain(kw):
            self.raw = kw['body']; self.generation = '2'
            raise core.MailError('MAIL_NATIVE_NETWORK_UNKNOWN')
        self.on_post = uncertain
        with self.assertRaisesRegex(core.MailError, 'UNKNOWN'): self.store.compare_and_swap('1', core.initial_journal())
        with self.assertRaisesRegex(core.MailError, 'CAS_REPLAY'): self.store.compare_and_swap('1', core.initial_journal())
        self.assertEqual(sum(method=='POST' for method,_ in self.calls), 1)
        self.assertEqual(self.store.load(), ('2', core.initial_journal()))
    def test_readback_semantically_equal_json_with_different_bytes_is_rejected(self):
        def different(kw):
            self.raw = kw['body'] + b'\n'; self.generation = '2'
            # Response initially describes submitted bytes; subsequent GET differs.
            return core.encode(metadata(kw['body'], '2'))
        self.on_post = different
        with self.assertRaisesRegex(core.MailError, 'CAS_UNCONFIRMED'): self.store.compare_and_swap('1', core.initial_journal())
    def test_written_metadata_must_bind_raw_bytes_before_readback(self):
        for field, value in [('size', '999'), ('md5Hash', 'invalid'), ('bucket', 'foreign'), ('contentEncoding', 'gzip')]:
            self.setUp()
            self.on_post = lambda kw:core.encode(dict(metadata(kw['body'], '2'), **{field:value}))
            with self.subTest(field=field), self.assertRaisesRegex(core.MailError, 'CAS_UNCONFIRMED'):
                self.store.compare_and_swap('1', core.initial_journal())
            self.assertEqual([method for method,_ in self.calls], ['POST'])
    def test_fence_after_credential_and_cas_expiry_failure_preserve_attempt(self):
        order = []
        self.credential.side_effect = lambda:order.append('credential') or 'SYNTHETIC'
        self.fence.side_effect = lambda:order.append('fence') or (_ for _ in ()).throw(core.MailError('EXPIRED'))
        with self.assertRaisesRegex(core.MailError, 'EXPIRED'): self.store.compare_and_swap('1', core.initial_journal())
        self.assertEqual(order, ['credential', 'fence'])
        with self.assertRaisesRegex(core.MailError, 'CAS_REPLAY'): self.store.compare_and_swap('1', core.initial_journal())
    def test_config_rejects_arbitrary_path_query_traversal_or_bucket(self):
        for field,value in [('name', '../journal.json'), ('name', NAME+'?alt=media'), ('bucket','other/bucket'), ('name','mail/journal.json')]:
            args = dict(bucket=BUCKET, name=NAME, fence=self.fence); args[field] = value
            with self.subTest(field=field,value=value), self.assertRaises(core.MailError):
                m.JournalStore(self.http,self.credential,**args)


if __name__ == '__main__': unittest.main()
