"""V7 F1 transactional mail on App Engine standard (ADR-V7-13).

One authenticated route. The VM dispatcher posts an AES-GCM envelope with a
Google ID token of its own service account; scripts/gcp_mail_dispatch.py
(DispatchService) verifies identity, opens the envelope with the key from
Secret Manager, deduplicates in a GCS journal with generation CAS, checks the
control fence and makes exactly one Mail API call. A lost answer is UNKNOWN,
never a resend. Nothing here logs recipients, links or tokens.
"""
import json
import os
import time
from urllib import parse, request

import gcp_mail_dispatch as core
import gcp_mail_native as native

TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token'
CONTROL = 'mail/control.json'
MAX_REQUEST = core.MAX_BODY


def settings(env=os.environ):
    config = core.validate_config(json.loads(env['MAIL_CONFIG']))
    version = env['MAIL_KEY_VERSION']
    bucket = env['MAIL_JOURNAL_BUCKET']
    journal = env.get('MAIL_JOURNAL_NAME', 'mail/invitations/journal.json')
    return config, version, bucket, journal


def metadata_credential(opener=None):
    """Service identity token from the metadata server, cached for one request."""
    cached = {}

    def credential():
        if 'token' not in cached:
            req = request.Request(TOKEN_URL, headers={'Metadata-Flavor': 'Google'})
            with (opener or request.build_opener(request.ProxyHandler({}))).open(req, timeout=5) as response:
                core.need(response.status == 200, 'MAIL_IDENTITY_UNAVAILABLE')
                value = native.document(response.read(8192))
            core.need(type(value) is dict and type(value.get('access_token')) is str, 'MAIL_IDENTITY_UNAVAILABLE')
            cached['token'] = value['access_token']
        return cached['token']
    return credential


def control_fence(http, credential, bucket):
    """Emergency stop without redeploy: mail/control.json must say enabled."""
    url = ('https://storage.googleapis.com/storage/v1/b/' + bucket + '/o/' + parse.quote(CONTROL, safe='') + '?alt=media')

    def fence(_payload=None):
        value = native.document(http('GET', url, token=credential(), maximum=4096))
        core.need(value == {'schema_version': 1, 'enabled': True}, 'MAIL_CONTROL_PAUSED')
    return fence


def service_for(env=os.environ, *, http=None, credential=None, provider=None):
    config, version, bucket, journal = settings(env)
    http = http or native.NativeHTTP(finish_at=time.monotonic() + 25)
    credential = credential or metadata_credential()
    fence = control_fence(http, credential, bucket)
    store = native.JournalStore(http, credential, bucket=bucket, name=journal, fence=fence)
    return core.DispatchService(config, store=store, authenticate=native.GoogleIdentity(http),
                                key_provider=native.SecretKey(http, credential, version), fence=fence,
                                provider=provider or core.appengine_mail_api)


def respond(start_response, status, body):
    raw = json.dumps(body, sort_keys=True).encode()
    start_response(status, [('Content-Type', 'application/json'), ('Cache-Control', 'no-store'),
                            ('Content-Length', str(len(raw)))])
    return [raw]


def application(environ, start_response, service_factory=service_for):
    method, path = environ.get('REQUEST_METHOD'), environ.get('PATH_INFO')
    if method == 'GET' and path == '/livez':
        return respond(start_response, '200 OK', {'ok': True, 'service': 'mail'})
    if method != 'POST' or path != '/v1/dispatch' or environ.get('QUERY_STRING'):
        return respond(start_response, '404 Not Found', {'error': {'code': 'NOT_FOUND'}})
    auth = environ.get('HTTP_AUTHORIZATION', '')
    if not auth.startswith('Bearer ') or not environ.get('CONTENT_TYPE', '').startswith('application/json'):
        return respond(start_response, '401 Unauthorized', {'error': {'code': 'MAIL_IDENTITY_REQUIRED'}})
    try:
        length = int(environ.get('CONTENT_LENGTH') or 0)
    except ValueError:
        length = -1
    if not 0 < length <= MAX_REQUEST:
        return respond(start_response, '413 Payload Too Large', {'error': {'code': 'MAIL_BODY_BOUND'}})
    raw = environ['wsgi.input'].read(length)
    try:
        with native.deadline(25):
            result = service_factory().dispatch(raw, auth[7:])
    except core.MailError as error:
        code = str(error)
        status = '401 Unauthorized' if code.startswith(('MAIL_ID', 'MAIL_IDENTITY')) else '409 Conflict'
        return respond(start_response, status, {'error': {'code': code}})
    return respond(start_response, '200 OK', result)


def build_app():
    from google.appengine.api import wrap_wsgi_app
    return wrap_wsgi_app(application)


if os.environ.get('GAE_ENV', '').startswith('standard'):
    app = build_app()
