"""Synthetic RSA/native responses only. No installed key, Google or GitHub IO."""
import base64
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch
import urllib.error
sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'scripts'))
import cloudbuild_github_app_credential as g

NOW = datetime(2026, 10, 11, 18, 10, tzinfo=timezone.utc)
CONFIG = {'app_id': g.APP_ID, 'installation_id': g.INSTALLATION_ID, 'repository_id': g.REPOSITORY_ID,
    'repository': g.REPOSITORY, 'secret_version': g.SECRET_VERSION, 'public_key_sha256': g.PUBLIC_KEY_SHA256}
REPO = {'id': g.REPOSITORY_ID, 'full_name': g.REPOSITORY, 'private': False, 'archived': False, 'disabled': False}


class Transport:
    def __init__(self, pem):
        self.calls = []; self.change = None; self.failure = None
        self.values = {g.SECRET_URL: {'name': g.SECRET_VERSION, 'payload': {
            'data': base64.b64encode(pem).decode(), 'dataCrc32c': str(g.crc32c(pem))}},
            g.INSTALLATION_URL: {'id': g.INSTALLATION_ID, 'app_id': g.APP_ID,
                'account': {'login': 'MarioB19'}, 'repository_selection': 'selected', 'permissions': dict(g.PERMISSIONS),
                'suspended_at': None, 'suspended_by': None},
            g.TOKEN_URL: {'token': 'synthetic-token-not-real', 'expires_at': (NOW+timedelta(hours=1)).isoformat(),
                'permissions': dict(g.PERMISSIONS), 'repository_selection': 'selected', 'repositories': [dict(REPO)]},
            g.REPOSITORIES_URL: {'total_count': 1, 'repositories': [dict(REPO)]}}
    def request(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if self.change: self.change(url)
        if url == self.failure: raise RuntimeError('SYNTHETIC_UNKNOWN')
        return copy.deepcopy(self.values[url])
    def posts(self): return [r for r in self.calls if r[1].get('method') == 'POST']


class AppCredentialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Mandatory actual crypto test, not skipped when the dependency is absent.
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.pem = cls.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        public = cls.key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        cls.public_hash = hashlib.sha256(public).hexdigest()

    def setUp(self):
        self.transport = Transport(self.pem); self.moment = NOW; self.buffers = []
        self.credential = g.GitHubAppCredential(CONFIG, lambda:'synthetic-google', lambda:g.ACCOUNT,
            transport=self.transport, now=lambda:self.moment)
        self.real_sign = g.sign_jwt
    def acquire(self):
        def signer(value, **kwargs):
            self.buffers.append(value)
            return self.real_sign(value, expected_public_sha256=self.public_hash, **kwargs)
        with patch.object(g, 'sign_jwt', signer): return self.credential.acquire()

    def test_crc32c_standard_vector(self): self.assertEqual(g.crc32c(b'123456789'), 0xe3069283)

    def test_real_rsa_signature_key_pin_and_exact_sixty_second_jwt(self):
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding
        token, expiry = self.real_sign(self.pem, now=NOW, expected_public_sha256=self.public_hash)
        header, payload, signature = token.split('.')
        decode = lambda v: base64.urlsafe_b64decode(v+'='*((4-len(v)%4)%4))
        self.assertEqual(json.loads(decode(header)), {'alg':'RS256', 'typ':'JWT'})
        claims = json.loads(decode(payload)); self.assertEqual(claims['exp']-claims['iat'], 60)
        self.assertEqual(claims['iss'], str(g.APP_ID)); self.assertEqual(expiry, claims['exp'])
        self.key.public_key().verify(decode(signature), (header+'.'+payload).encode(), padding.PKCS1v15(), hashes.SHA256())
        with self.assertRaisesRegex(RuntimeError, 'PUBLIC_KEY_CHANGED'): self.real_sign(self.pem, now=NOW)

    def test_single_repository_and_permissions_are_explicit_not_native_write_proof(self):
        result = self.acquire(); self.assertFalse(result['deployment_write_proven'])
        self.assertEqual(self.credential.credential(), 'synthetic-token-not-real')
        posts = self.transport.posts(); self.assertEqual(len(posts), 1)
        self.assertEqual(json.loads(posts[0][1]['body']), {'repository_ids':[g.REPOSITORY_ID], 'permissions':g.PERMISSIONS})
        self.assertEqual([r[0] for r in self.transport.calls], [g.SECRET_URL, g.INSTALLATION_URL, g.TOKEN_URL, g.REPOSITORIES_URL])
        self.assertTrue(self.buffers and all(not any(value) for value in self.buffers))

    def test_no_retry_after_unknown_token_post(self):
        self.transport.failure = g.TOKEN_URL
        with self.assertRaisesRegex(RuntimeError, 'SYNTHETIC_UNKNOWN'): self.acquire()
        with self.assertRaisesRegex(RuntimeError, 'ALREADY_ATTEMPTED'): self.acquire()
        self.assertEqual(len(self.transport.posts()), 1)
        with self.assertRaisesRegex(RuntimeError, 'UNAVAILABLE'): self.credential.credential()

    def test_admission_lost_during_installation_read_blocks_mint_after_cas(self):
        import cloudbuild_effect_journal as effect
        import test_cloudbuild_admission as fixture
        parent=fixture.MemoryStore(fixture.reserved());store=fixture.MemoryStore()
        binding=effect.initialize_journal(store,parent,fixture.ATTEMPT,now=fixture.NOW)['binding']
        journal=effect.DurableEffectJournal(store,parent,binding,clock=lambda:fixture.NOW)
        current=[True]
        journal.fence=lambda:g.require(current[0],'SYNTHETIC_ADMISSION_EXPIRED')
        self.transport.change=lambda url:current.__setitem__(0,False) if url==g.INSTALLATION_URL else None
        def sign(raw,**kwargs):return self.real_sign(raw,expected_public_sha256=self.public_hash,**kwargs)
        with patch.object(g,'sign_jwt',sign),self.assertRaisesRegex(RuntimeError,'ACQUISITION_UNKNOWN_NO_RETRY'):
            g.acquire_once(self.credential,journal,fixture.ATTEMPT,CONFIG,g.ACCOUNT)
        self.assertEqual(self.transport.posts(),[])
        self.assertEqual(next(iter(store.document['actions'].values()))['result']['status'],'UNKNOWN')
        self.assertIsNone(self.credential._token)

    def test_wrong_workload_or_image_config_cannot_read_secret(self):
        for key, value in (('repository_id', 1359063164), ('secret_version', g.SECRET_VERSION.replace('/1','/latest')),
                           ('public_key_sha256', '0'*64), ('app_id', True)):
            config = {**CONFIG, key:value}
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'FIXED_CONFIG_REQUIRED'):
                g.GitHubAppCredential(config, lambda:'x', lambda:g.ACCOUNT)
        self.credential.identity_provider = lambda:'foreign'
        with self.assertRaisesRegex(RuntimeError, 'WORKLOAD_IDENTITY_CHANGED'): self.acquire()
        self.assertEqual(self.transport.calls, [])

    def test_late_identity_read_precedes_final_admission_fence(self):
        identity_calls=[];current=[True]
        def identity():
            identity_calls.append(True)
            if len(identity_calls)==2:current[0]=False
            return g.ACCOUNT
        self.credential.identity_provider=identity
        fence=lambda:g.require(current[0],'SYNTHETIC_ADMISSION_EXPIRED_AFTER_IDENTITY')
        def sign(raw,**kwargs):return self.real_sign(raw,expected_public_sha256=self.public_hash,**kwargs)
        with patch.object(g,'sign_jwt',sign),self.assertRaisesRegex(RuntimeError,'EXPIRED_AFTER_IDENTITY'):
            self.credential.acquire(before_mint=fence)
        self.assertEqual(len(identity_calls),2);self.assertEqual(self.transport.posts(),[])

    def test_secret_version_or_checksum_change_stops_before_sign_and_mint(self):
        for key in ('version', 'checksum'):
            self.setUp()
            if key == 'version': self.transport.values[g.SECRET_URL]['name'] += '0'
            else: self.transport.values[g.SECRET_URL]['payload']['dataCrc32c'] = '0'
            with self.subTest(key=key), self.assertRaises(RuntimeError): self.acquire()
            self.assertFalse(self.transport.posts()); self.assertEqual(len(self.transport.calls), 1)

    def test_broader_installation_or_suspension_stops_before_mint(self):
        for key in ('permissions', 'repository_selection', 'suspended_at', 'app_id'):
            self.setUp(); value = self.transport.values[g.INSTALLATION_URL]
            if key == 'permissions': value[key]['contents'] = 'write'
            else: value[key] = 'foreign'
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'INSTALLATION_CHANGED'): self.acquire()
            self.assertFalse(self.transport.posts())

    def test_jwt_expiry_during_get_has_zero_post(self):
        def change(url):
            if url == g.INSTALLATION_URL: self.moment = NOW+timedelta(seconds=60)
        self.transport.change = change
        with self.assertRaisesRegex(RuntimeError, 'SIGNING_AUTHORITY_EXPIRED'): self.acquire()
        self.assertFalse(self.transport.posts())

    def test_foreign_repo_or_pagination_total_rejects_minted_credential(self):
        for kind in ('repo', 'total', 'private'):
            self.setUp(); value = self.transport.values[g.REPOSITORIES_URL]
            if kind == 'repo': value['repositories'][0]['id'] = 1359063164
            elif kind == 'total': value['total_count'] = 2
            else: value['repositories'][0]['private'] = True
            with self.subTest(kind=kind), self.assertRaises(RuntimeError): self.acquire()
            self.assertEqual(len(self.transport.posts()), 1)
            with self.assertRaisesRegex(RuntimeError, 'UNAVAILABLE'): self.credential.credential()

    def test_token_permissions_or_ttl_cannot_widen(self):
        for kind in ('permissions', 'ttl'):
            self.setUp(); value = self.transport.values[g.TOKEN_URL]
            if kind == 'permissions': value['permissions']['contents'] = 'write'
            else: value['expires_at'] = (NOW+timedelta(minutes=2)).isoformat()
            with self.subTest(kind=kind), self.assertRaises(RuntimeError): self.acquire()
            self.assertEqual(len(self.transport.posts()), 1)


class Response(io.BytesIO):
    def __init__(self, raw=b'{}', *, status=200, url=g.SECRET_URL, headers=None):
        super().__init__(raw); self.status=status; self.url=url; self.headers=headers or {}
    def geturl(self): return self.url

class TransportTests(unittest.TestCase):
    def test_google_media_type_is_json_not_github_vendor(self):
        opener=Mock(); opener.open.return_value=Response()
        g.AppTransport(opener=opener).request(g.SECRET_URL, token='synthetic')
        request=opener.open.call_args.args[0]
        self.assertEqual(request.get_header('Accept'), 'application/json')
        self.assertIsNone(request.get_header('X-github-api-version'))
    def test_unsupported_url_method_or_extra_repo_never_open(self):
        opener=Mock(); transport=g.AppTransport(opener=opener)
        for args in ((g.TOKEN_URL, {'method':'GET'}), ('https://foreign.invalid', {}),
                     (g.TOKEN_URL, {'method':'POST','body':b'{"repository_ids":[1,2]}'})):
            with self.subTest(args=args[0]), self.assertRaises(RuntimeError): transport.request(args[0], token='synthetic', **args[1])
        opener.open.assert_not_called()
    def test_pagination_redirect_and_encoding_rejected_before_read(self):
        for kwargs in ({'headers':{'Link':'next'}}, {'headers':{'Content-Encoding':'gzip'}}, {'url':g.TOKEN_URL}):
            response=Response(**kwargs); opener=Mock(); opener.open.return_value=response
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(RuntimeError, 'RESPONSE_UNCONFIRMED'):
                g.AppTransport(opener=opener).request(g.SECRET_URL, token='synthetic')
            self.assertTrue(response.closed)
    def test_http_error_closed_and_error_payload_never_returned(self):
        fp=io.BytesIO(b'synthetic-secret-must-not-escape'); error=urllib.error.HTTPError(g.TOKEN_URL,403,'private',{},fp)
        opener=Mock(); opener.open.side_effect=error
        with self.assertRaisesRegex(RuntimeError, '^GITHUB_APP_HTTP_403$'):
            g.AppTransport(opener=opener).request(g.SECRET_URL,token='synthetic')
        self.assertTrue(fp.closed)
    def test_network_error_message_sanitized(self):
        opener=Mock(); opener.open.side_effect=OSError('synthetic-secret')
        with self.assertRaisesRegex(RuntimeError, '^GITHUB_APP_OUTCOME_UNKNOWN$'):
            g.AppTransport(opener=opener).request(g.SECRET_URL,token='synthetic')
    def test_response_bound(self):
        opener=Mock(); opener.open.return_value=Response(b' '*(g.MAX_JSON+1))
        with self.assertRaisesRegex(RuntimeError, 'RESPONSE_BOUND'):
            g.AppTransport(opener=opener).request(g.SECRET_URL,token='synthetic')

class DurableAcquireTests(unittest.TestCase):
    def setUp(self):
        import cloudbuild_effect_journal as effect
        import test_cloudbuild_admission as fixture
        self.fixture=fixture;self.effect=effect
        self.parent=fixture.MemoryStore(fixture.reserved());self.store=fixture.MemoryStore()
        self.binding=effect.initialize_journal(self.store,self.parent,fixture.ATTEMPT,now=fixture.NOW)['binding']
        self.journal=effect.DurableEffectJournal(self.store,self.parent,self.binding,clock=lambda:fixture.NOW)
        self.journal.fence=lambda:effect.fresh_binding(self.parent,fixture.ATTEMPT,fixture.NOW)
        self.meta={'requested_capability':'fixed-public-repository-deployments-write','repository_id':g.REPOSITORY_ID,
            'app_id':g.APP_ID,'installation_id':g.INSTALLATION_ID,'expires_at':(NOW+timedelta(hours=1)).isoformat(),
            'deployment_write_proven':False}
        self.credential=Mock(config=dict(CONFIG),now=lambda:NOW)
        self.credential.acquire.return_value=self.meta
        self.credential._token='synthetic-bearer';self.credential._expires=NOW+timedelta(hours=1)
    def acquire(self,credential=None,journal=None):
        return g.acquire_once(credential or self.credential,journal or self.journal,
            self.fixture.ATTEMPT,CONFIG,g.ACCOUNT)
    def test_real_journal_precedes_acquisition_and_stores_no_material(self):
        def observed(**kwargs):
            row=next(iter(self.store.document['actions'].values()))
            self.assertIs(kwargs['before_mint'],self.journal.fence)
            self.assertIsNone(row['result']);return self.meta
        self.credential.acquire.side_effect=observed
        self.assertEqual(self.acquire(),self.meta)
        row=next(iter(self.store.document['actions'].values()))
        self.assertEqual(row['result']['status'],'RESPONSE_RECEIVED')
        self.assertNotIn('synthetic-bearer',json.dumps(self.store.document))
        self.assertNotIn('token',json.dumps(row['result']).lower())
    def test_new_instance_cannot_mint_after_prior_success_or_unknown(self):
        self.credential.acquire.side_effect=OSError('synthetic-private-detail')
        with self.assertRaisesRegex(RuntimeError,'^GITHUB_APP_ACQUISITION_UNKNOWN_NO_RETRY$'):self.acquire()
        self.assertIsNone(self.credential._token)
        row=next(iter(self.store.document['actions'].values()));self.assertEqual(row['result']['status'],'UNKNOWN')
        fresh=Mock(config=dict(CONFIG))
        with self.assertRaisesRegex(RuntimeError,'DURABLE_INTENT_NOT_NEW'):self.acquire(fresh)
        fresh.acquire.assert_not_called();self.credential.acquire.assert_called_once()
    def test_successful_prior_acquisition_cannot_be_replayed(self):
        self.acquire()
        with self.assertRaisesRegex(RuntimeError,'DURABLE_INTENT_NOT_NEW'):self.acquire()
        self.credential.acquire.assert_called_once()
    def test_lost_cas_response_blocks_first_and_next_process_before_acquire(self):
        self.store.lose_response=True
        with self.assertRaisesRegex(RuntimeError,'WRITE_RESPONSE_LOST'):self.acquire()
        self.store.lose_response=False
        with self.assertRaisesRegex(RuntimeError,'DURABLE_INTENT_NOT_NEW'):self.acquire()
        self.credential.acquire.assert_not_called()
    def test_result_unknown_discards_ram_bearer_and_preserves_committed_result(self):
        def observed(**_kwargs):self.store.lose_response=True;return self.meta
        self.credential.acquire.side_effect=observed
        with self.assertRaisesRegex(RuntimeError,'ACQUISITION_UNKNOWN_NO_RETRY'):self.acquire()
        self.assertIsNone(self.credential._token);self.assertIsNone(self.credential._expires)
        self.assertEqual(next(iter(self.store.document['actions'].values()))['result']['status'],'RESPONSE_RECEIVED')
        self.store.lose_response=False
        with self.assertRaisesRegex(RuntimeError,'DURABLE_INTENT_NOT_NEW'):self.acquire()
        self.credential.acquire.assert_called_once()
    def test_expired_parent_and_wrong_identity_block_before_acquire(self):
        with self.assertRaisesRegex(RuntimeError,'BINDING_CHANGED'):
            g.acquire_once(self.credential,self.journal,self.fixture.ATTEMPT,CONFIG,'foreign')
        self.journal.clock=lambda:self.fixture.NOW+timedelta(days=1)
        with self.assertRaisesRegex(RuntimeError,'SOURCE_APPROVAL_EXPIRED'):self.acquire()
        self.credential.acquire.assert_not_called();self.assertEqual(self.store.document['actions'],{})
    def test_forged_cas_attempt_hash_or_generation_never_mints(self):
        real=self.journal.commit_intent
        for key in ('attempt_id','intent_sha256','fencing_generation'):
            journal=Mock()
            result=real('github-app-acquire:'+self.fixture.ATTEMPT,{
                'operation':'GITHUB_APP_ACQUIRE','attempt_id':self.fixture.ATTEMPT,
                'configuration':CONFIG,'identity':g.ACCOUNT,'permissions':dict(g.PERMISSIONS)})
            # The helper must independently authenticate the callback response.
            result.update(effect='CREATE_ONCE');result[key]='wrong'
            journal.commit_intent.return_value=result
            with self.assertRaisesRegex(RuntimeError,'DURABLE_INTENT_NOT_NEW'):self.acquire(journal=journal)
        self.credential.acquire.assert_not_called()

if __name__ == '__main__': unittest.main()
