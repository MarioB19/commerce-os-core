"""Fixed public-repository GitHub App credential, RAM only and one mint.

This module has no CLI and is not imported by the private SHADOW worker. The
public source profile wires it from an image-owned config. Crypto is imported
only while signing; controller/verifier processes never read the private key.
"""
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
import time
import urllib.error
import urllib.request
import uuid

from ci_release import require
from cloudbuild_native_reader import NoRedirect, decode

APP_ID = 5276479
INSTALLATION_ID = 170342995
REPOSITORY_ID = 1414365450
REPOSITORY = 'MarioB19/commerce-os-core'
ACCOUNT = 'commerce-v7-publisher-core@project-c6f43813-9ac9-47ab-9fe.iam.gserviceaccount.com'
SECRET_VERSION = 'projects/1065291779811/secrets/commerce-v7-publisher-github-key/versions/1'
PUBLIC_KEY_SHA256 = 'b4b127c27cf195d527d27baf99416b56cb71fccbd15c3347ada1ba278729d2e4'
PERMISSIONS = {'administration': 'read', 'actions_variables': 'read', 'contents': 'read',
               'deployments': 'write', 'metadata': 'read'}
SECRET_URL = 'https://secretmanager.googleapis.com/v1/'+SECRET_VERSION+':access'
INSTALLATION_URL = 'https://api.github.com/app/installations/'+str(INSTALLATION_ID)
TOKEN_URL = INSTALLATION_URL+'/access_tokens'
REPOSITORIES_URL = 'https://api.github.com/installation/repositories?per_page=100'
MAX_JSON = 128*1024
MAX_KEY = 16384


def validate_config(value):
    expected = {'app_id': APP_ID, 'installation_id': INSTALLATION_ID, 'repository_id': REPOSITORY_ID,
        'repository': REPOSITORY, 'secret_version': SECRET_VERSION, 'public_key_sha256': PUBLIC_KEY_SHA256}
    require(type(value) is dict and value == expected
            and all(type(value[k]) is int for k in ('app_id', 'installation_id', 'repository_id')),
            'GITHUB_APP_FIXED_CONFIG_REQUIRED')
    return dict(expected)


def acquire_once(credential, journal, attempt_id, configuration, identity):
    """Fence acquisition across processes in the current execution's journal.

    The caller supplies its admission-fenced DurableEffectJournal, including for
    a RECONCILE execution. The previous publication's journal is never reused.
    No RAM bearer or private-key data is written to intent/result documents.
    """
    config = validate_config(configuration)
    require(type(attempt_id) is str and str(uuid.UUID(attempt_id)) == attempt_id,
            'GITHUB_APP_ATTEMPT_REQUIRED')
    require(identity == ACCOUNT and credential.config == config,
            'GITHUB_APP_ACQUISITION_BINDING_CHANGED')
    require(callable(getattr(journal, 'fence', None)), 'GITHUB_APP_CURRENT_ADMISSION_FENCE_REQUIRED')
    payload = {'operation': 'GITHUB_APP_ACQUIRE', 'attempt_id': attempt_id,
        'configuration': config, 'identity': identity, 'permissions': dict(PERMISSIONS)}
    checksum = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    action = 'github-app-acquire:'+attempt_id
    intent = journal.commit_intent(action, payload)
    require(type(intent) is dict and intent.get('effect') == 'CREATE_ONCE'
            and intent.get('intent_sha256') == checksum and intent.get('attempt_id') == attempt_id
            and type(intent.get('fencing_generation')) is str
            and re.fullmatch('[1-9][0-9]*', intent['fencing_generation']),
            'GITHUB_APP_DURABLE_INTENT_NOT_NEW')
    try:
        observed = credential.acquire(before_mint=journal.fence)
        require(type(observed) is dict and set(observed) == {
            'requested_capability', 'repository_id', 'app_id', 'installation_id', 'expires_at', 'deployment_write_proven'}
            and observed['requested_capability'] == 'fixed-public-repository-deployments-write'
            and observed['repository_id'] == REPOSITORY_ID and observed['app_id'] == APP_ID
            and observed['installation_id'] == INSTALLATION_ID and observed['deployment_write_proven'] is False,
            'GITHUB_APP_ACQUISITION_RESULT_CHANGED')
        expiry = datetime.fromisoformat(observed['expires_at'].replace('Z', '+00:00'))
        require(expiry.tzinfo is not None and credential.now()+timedelta(minutes=15) < expiry,
                'GITHUB_APP_ACQUISITION_EXPIRED')
        journal.record_result(action, {'status': 'RESPONSE_RECEIVED', 'intent_sha256': checksum,
            'native_id': INSTALLATION_ID, 'repository_id': REPOSITORY_ID, 'app_id': APP_ID,
            'expires_at': expiry.isoformat(), 'deployment_write_proven': False})
        return observed
    except Exception:
        credential._token = None; credential._expires = None
        try: journal.record_result(action, {'status': 'UNKNOWN', 'intent_sha256': checksum})
        except Exception: pass
        raise RuntimeError('GITHUB_APP_ACQUISITION_UNKNOWN_NO_RETRY') from None


def crc32c(raw):
    value = 0xffffffff
    for byte in raw:
        value ^= byte
        for _ in range(8): value = (value >> 1) ^ (0x82f63b78 if value & 1 else 0)
    return value ^ 0xffffffff


def encode(value):
    return base64.urlsafe_b64encode(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).rstrip(b'=')


def sign_jwt(key_bytes, *, now, expected_public_sha256=PUBLIC_KEY_SHA256):
    """Pure signer; no files, subprocesses or network; RSA object is discarded."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    require(type(key_bytes) in (bytes, bytearray) and 0 < len(key_bytes) <= MAX_KEY,
            'GITHUB_APP_KEY_BOUND')
    try: key = serialization.load_pem_private_key(bytes(key_bytes), password=None)
    except (ValueError, TypeError): raise RuntimeError('GITHUB_APP_KEY_INVALID') from None
    require(isinstance(key, rsa.RSAPrivateKey) and 2048 <= key.key_size <= 4096,
            'GITHUB_APP_RSA_REQUIRED')
    public = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    require(hashlib.sha256(public).hexdigest() == expected_public_sha256, 'GITHUB_APP_PUBLIC_KEY_CHANGED')
    issued = int(now.timestamp())-5
    payload = {'iat': issued, 'exp': issued+60, 'iss': str(APP_ID)}
    signed = encode({'alg': 'RS256', 'typ': 'JWT'})+b'.'+encode(payload)
    signature = key.sign(signed, padding.PKCS1v15(), hashes.SHA256())
    del key
    return (signed+b'.'+base64.urlsafe_b64encode(signature).rstrip(b'=')).decode(), issued+60


class AppTransport:
    def __init__(self, *, opener=None, clock=time.monotonic):
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.clock = clock

    def request(self, url, *, token, method='GET', body=None):
        require(url in {SECRET_URL, INSTALLATION_URL, TOKEN_URL, REPOSITORIES_URL}
                and method == ('POST' if url == TOKEN_URL else 'GET')
                and ((method == 'GET' and body is None) or
                     (method == 'POST' and body == json.dumps({'repository_ids': [REPOSITORY_ID],
                        'permissions': PERMISSIONS}, sort_keys=True, separators=(',', ':')).encode())),
                'GITHUB_APP_ENDPOINT_OR_BODY_REJECTED')
        require(type(token) is str and 0 < len(token) <= 16384 and not any(c.isspace() for c in token),
                'GITHUB_APP_BEARER_REQUIRED')
        headers = {'Authorization': 'Bearer '+token, 'Accept': 'application/json',
                   'Accept-Encoding': 'identity', 'User-Agent': 'Commerce-OS-public-publisher'}
        if url.startswith('https://api.github.com/'):
            headers.update({'X-GitHub-Api-Version': '2022-11-28', 'Accept': 'application/vnd.github+json'})
        if body is not None: headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(url, headers=headers, method=method, data=body)
        raw = bytearray(); expires = self.clock()+30
        try:
            with self.opener.open(request, timeout=10) as response:
                require(response.status == (201 if method == 'POST' else 200)
                        and response.geturl() == url and response.headers.get('Content-Encoding', 'identity') == 'identity'
                        and not response.headers.get('Link'), 'GITHUB_APP_RESPONSE_UNCONFIRMED')
                while True:
                    require(self.clock() < expires, 'GITHUB_APP_RESPONSE_DEADLINE')
                    chunk = response.read1(min(16384, MAX_JSON-len(raw)+1))
                    require(self.clock() < expires, 'GITHUB_APP_RESPONSE_DEADLINE')
                    if not chunk: break
                    raw.extend(chunk); require(len(raw) <= MAX_JSON, 'GITHUB_APP_RESPONSE_BOUND')
        except urllib.error.HTTPError as error:
            status = error.code; error.close(); raise RuntimeError('GITHUB_APP_HTTP_'+str(status)) from None
        except (OSError, ValueError): raise RuntimeError('GITHUB_APP_OUTCOME_UNKNOWN') from None
        return decode(bytes(raw))


def repository(value):
    require(type(value) is dict and type(value.get('id')) is int and value['id'] == REPOSITORY_ID
            and value.get('full_name') == REPOSITORY and value.get('private') is False
            and value.get('archived') is False and value.get('disabled', False) is False,
            'GITHUB_APP_PUBLIC_REPOSITORY_CHANGED')


class GitHubAppCredential:
    def __init__(self, config, google_token_provider, identity_provider, *, transport=None,
                 now=lambda: datetime.now(timezone.utc)):
        self.config = validate_config(config); self.google_token_provider = google_token_provider
        self.identity_provider = identity_provider; self.transport = transport or AppTransport(); self.now = now
        self._attempted = False; self._token = None; self._expires = None

    def acquire(self, *, before_mint=None):
        require(not self._attempted, 'GITHUB_APP_ACQUISITION_ALREADY_ATTEMPTED'); self._attempted = True
        require(self.identity_provider() == ACCOUNT, 'GITHUB_APP_WORKLOAD_IDENTITY_CHANGED')
        value = self.transport.request(SECRET_URL, token=self.google_token_provider())
        require(type(value) is dict and set(value) == {'name', 'payload'} and value['name'] == SECRET_VERSION,
                'GITHUB_APP_SECRET_VERSION_CHANGED')
        payload = value['payload']
        require(type(payload) is dict and set(payload) == {'data', 'dataCrc32c'}
                and type(payload['data']) is str and len(payload['data']) <= (MAX_KEY+2)//3*4
                and type(payload['dataCrc32c']) is str and re.fullmatch('[0-9]{1,10}', payload['dataCrc32c']),
                'GITHUB_APP_SECRET_PAYLOAD_INVALID')
        try: key_bytes = bytearray(base64.b64decode(payload['data'], validate=True))
        except ValueError: raise RuntimeError('GITHUB_APP_SECRET_ENCODING_INVALID') from None
        try:
            require(0 < len(key_bytes) <= MAX_KEY and crc32c(key_bytes) == int(payload['dataCrc32c']),
                    'GITHUB_APP_SECRET_CHECKSUM_CHANGED')
            jwt, expires = sign_jwt(key_bytes, now=self.now())
        finally:
            key_bytes[:] = b'\x00'*len(key_bytes)
            del key_bytes, payload, value
        installation = self.transport.request(INSTALLATION_URL, token=jwt)
        require(type(installation) is dict and installation.get('id') == INSTALLATION_ID
                and installation.get('app_id') == APP_ID and installation.get('account', {}).get('login') == 'MarioB19'
                and installation.get('repository_selection') == 'selected' and installation.get('permissions') == PERMISSIONS
                and installation.get('suspended_at') is None and installation.get('suspended_by') is None,
                'GITHUB_APP_INSTALLATION_CHANGED')
        require(self.identity_provider() == ACCOUNT, 'GITHUB_APP_SIGNING_AUTHORITY_EXPIRED')
        if before_mint is not None: before_mint()
        require(int(self.now().timestamp())+2 < expires, 'GITHUB_APP_SIGNING_AUTHORITY_EXPIRED')
        request_body = json.dumps({'repository_ids': [REPOSITORY_ID], 'permissions': PERMISSIONS},
                                  sort_keys=True, separators=(',', ':')).encode()
        credential = self.transport.request(TOKEN_URL, token=jwt, method='POST', body=request_body)
        del jwt
        require(type(credential) is dict and set(credential) <= {'token', 'expires_at', 'permissions', 'repository_selection', 'repositories'}
                and credential.get('permissions') == PERMISSIONS
                and credential.get('repository_selection') == 'selected', 'GITHUB_APP_TOKEN_SCOPE_CHANGED')
        token = credential.get('token'); expiration = credential.get('expires_at')
        require(type(token) is str and 0 < len(token) <= 16384 and not any(c.isspace() for c in token)
                and type(expiration) is str, 'GITHUB_APP_TOKEN_INVALID')
        try: expiry = datetime.fromisoformat(expiration.replace('Z', '+00:00'))
        except ValueError: raise RuntimeError('GITHUB_APP_TOKEN_EXPIRATION_INVALID') from None
        require(expiry.tzinfo is not None and self.now()+timedelta(minutes=16) <= expiry <= self.now()+timedelta(minutes=61),
                'GITHUB_APP_TOKEN_TTL_INVALID')
        if 'repositories' in credential:
            require(type(credential['repositories']) is list and len(credential['repositories']) == 1,
                    'GITHUB_APP_TOKEN_REPOSITORIES_CHANGED')
            repository(credential['repositories'][0])
        observed = self.transport.request(REPOSITORIES_URL, token=token)
        require(type(observed) is dict and set(observed) == {'total_count', 'repositories'}
                and type(observed['total_count']) is int and observed['total_count'] == 1
                and type(observed['repositories']) is list and len(observed['repositories']) == 1,
                'GITHUB_APP_TOKEN_REPOSITORIES_CHANGED')
        repository(observed['repositories'][0])
        require(self.now()+timedelta(minutes=15) < expiry, 'GITHUB_APP_TOKEN_EXPIRED_AFTER_READBACK')
        self._token = token; self._expires = expiry
        return {'requested_capability': 'fixed-public-repository-deployments-write', 'repository_id': REPOSITORY_ID,
                'app_id': APP_ID, 'installation_id': INSTALLATION_ID, 'expires_at': expiry.isoformat(),
                'deployment_write_proven': False}

    def credential(self, *, remaining_seconds=120):
        require(type(remaining_seconds) is int and 0 < remaining_seconds <= 900 and self._token is not None
                and self.now()+timedelta(seconds=remaining_seconds) < self._expires, 'GITHUB_APP_TOKEN_UNAVAILABLE_OR_EXPIRED')
        return self._token
