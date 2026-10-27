import importlib
import io
import json
import signal
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(ROOT / 'infra/mail-appengine'))
import gcp_mail_dispatch as core  # noqa: E402
import v7_mail_appengine as stager  # noqa: E402
import gcp_mail_native as native  # noqa: E402
main = importlib.import_module('main')

PROJECT = 'project-c6f43813-9ac9-47ab-9fe'
CONFIG = {'project': PROJECT, 'region_code': 'ue', 'service_account': 'commerce-v7-mail@' + PROJECT + '.iam.gserviceaccount.com',
          'dispatcher_email': 'commerce-v7-vm@' + PROJECT + '.iam.gserviceaccount.com', 'dispatcher_subject': '123456789012345678901',
          'web_origin': 'https://commerce-os.inovaris.online', 'key_version': 'projects/1065291779811/secrets/commerce-v7-mail-key/versions/1',
          'bucket': 'commerce-v7-mail-1065291779811'}
KEY = bytes(range(32))
ATTEMPT = '11111111-1111-4111-8111-111111111111'


class Store:
    def __init__(self):
        self.document, self.generation = core.initial_journal(), '1'

    def load(self):
        return self.generation, json.loads(json.dumps(self.document))

    def compare_and_swap(self, expected, document):
        assert expected == self.generation
        self.document, self.generation = document, str(int(self.generation) + 1)
        return self.generation


def wsgi(app, method, path, body=b'', headers=None, query=''):
    environ = {'REQUEST_METHOD': method, 'PATH_INFO': path, 'QUERY_STRING': query, 'wsgi.input': io.BytesIO(body),
               'CONTENT_LENGTH': str(len(body)), 'CONTENT_TYPE': 'application/json'}
    environ.update(headers or {})
    status = []
    raw = b''.join(app(environ, lambda s, h: status.append(s)))
    return status[0], json.loads(raw)


class MailAppEngineTests(unittest.TestCase):
    def test_stage_renders_closed_config_without_secret_values(self):
        with tempfile.TemporaryDirectory() as out:
            receipt = stager.stage(out, CONFIG)
            self.assertEqual(receipt['audience'], 'https://' + PROJECT + '.ue.r.appspot.com')
            self.assertEqual(receipt['sender'], 'invitations@' + PROJECT + '.appspotmail.com')
            app = (Path(out) / 'app.yaml').read_text()
            self.assertIn('service_account: commerce-v7-mail@', app)
            self.assertIn('max_instances: 1', app)
            self.assertIn('--threads 1', app)
            config = json.loads(app.split("MAIL_CONFIG: '")[1].split("'")[0])
            self.assertEqual(core.validate_config(config)['dispatcher_subject'], '123456789012345678901')
            self.assertEqual(set(receipt['files']), {'main.py', 'requirements.txt', 'gcp_mail_dispatch.py', 'gcp_mail_native.py', 'app.yaml'})
            with self.assertRaises(core.MailError):
                stager.stage(out, CONFIG)
        for change in ({'bucket': 'other'}, {'key_version': 'projects/1/secrets/other/versions/1'}, {'region_code': 'useast'},
                       {'web_origin': 'http://commerce-os.inovaris.online'}, {'service_account': 'x@other.iam.gserviceaccount.com'}):
            with self.subTest(change=change), self.assertRaises(core.MailError):
                stager.render(CONFIG | change)

    def test_routes_identity_and_body_bounds(self):
        app = lambda e, s: main.application(e, s, service_factory=Mock(side_effect=AssertionError('not reached')))
        self.assertEqual(wsgi(app, 'GET', '/livez')[0], '200 OK')
        self.assertEqual(wsgi(app, 'POST', '/other')[0], '404 Not Found')
        self.assertEqual(wsgi(app, 'POST', '/v1/dispatch', b'{}', query='x=1')[0], '404 Not Found')
        self.assertEqual(wsgi(app, 'POST', '/v1/dispatch', b'{}')[0], '401 Unauthorized')
        self.assertEqual(wsgi(app, 'POST', '/v1/dispatch', b'x' * (core.MAX_BODY + 1), {'HTTP_AUTHORIZATION': 'Bearer t'})[0],
                         '413 Payload Too Large')

    def test_one_dispatch_one_mail_call_and_duplicate_is_not_resent(self):
        now = datetime.now(timezone.utc).replace(microsecond=0)
        _text, config = stager.render(CONFIG)
        provider, fence, store = Mock(), Mock(), Store()
        claims = {'iss': 'https://accounts.google.com', 'aud': config['audience'], 'email': config['dispatcher_email'],
                  'sub': config['dispatcher_subject'], 'email_verified': True, 'iat': int(now.timestamp()) - 5,
                  'exp': int(now.timestamp()) - 5 + 3600}
        service = core.DispatchService(config, store=store, authenticate=Mock(return_value=claims), key_provider=lambda: KEY,
                                       fence=fence, provider=provider)
        payload = {'schema_version': 1, 'event_id': '22222222-2222-4222-8222-222222222222', 'workspace_id': 'operacion-brandon',
                   'entity_id': '44444444-4444-4444-8444-444444444444', 'entity_version': 1, 'template': core.TEMPLATE,
                   'recipient': 'fixture@example.invalid', 'recipient_hmac': 'a' * 64, 'link_token': 'cos_inv_' + core.b64(bytes(range(32))),
                   'dispatched_at': now.isoformat(), 'authorized_until': (now + timedelta(seconds=120)).isoformat(),
                   'link_expires_at': (now + timedelta(hours=24)).isoformat(), 'budget_reservation_id': ATTEMPT}
        raw = core.seal(payload, ATTEMPT, KEY, bytes(range(12)))
        app = lambda e, s: main.application(e, s, service_factory=lambda: service)
        status, body = wsgi(app, 'POST', '/v1/dispatch', raw, {'HTTP_AUTHORIZATION': 'Bearer id-token'})
        self.assertEqual((status, body), ('200 OK', {'attempt_id': ATTEMPT, 'state': 'ACCEPTED', 'delivery_proven': False}))
        provider.assert_called_once()
        self.assertTrue(provider.call_args.kwargs['body'].count('https://commerce-os.inovaris.online/accept-invitation#cos_inv_') == 1)
        status, body = wsgi(app, 'POST', '/v1/dispatch', raw, {'HTTP_AUTHORIZATION': 'Bearer id-token'})
        self.assertEqual(body['state'], 'ACCEPTED')
        provider.assert_called_once()
        broken = core.DispatchService(config, store=Store(), authenticate=Mock(side_effect=core.MailError('MAIL_ID_SIGNATURE_INVALID')),
                                      key_provider=lambda: KEY, fence=fence, provider=provider)
        status, body = wsgi(lambda e, s: main.application(e, s, service_factory=lambda: broken), 'POST', '/v1/dispatch', raw,
                            {'HTTP_AUTHORIZATION': 'Bearer forged'})
        self.assertEqual((status, body['error']['code']), ('401 Unauthorized', 'MAIL_ID_SIGNATURE_INVALID'))
        provider.assert_called_once()

    def test_native_calls_can_arm_their_alarm_inside_a_request(self):
        # V7.1.1: production refused every dispatch in 8 ms with MAIL_NATIVE_DEADLINE_REQUIRED,
        # because the request held an outer alarm when the first native call armed its own.
        class Service:
            def dispatch(self, raw, token):
                with native.deadline(5):
                    pass
                return {'attempt_id': ATTEMPT, 'state': 'UNKNOWN', 'delivery_proven': False}
        app = lambda e, s: main.application(e, s, service_factory=Service)
        status, body = wsgi(app, 'POST', '/v1/dispatch', b'{}', {'HTTP_AUTHORIZATION': 'Bearer id-token'})
        self.assertEqual((status, body['state']), ('200 OK', 'UNKNOWN'))
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))

    def test_control_fence_requires_explicit_enable(self):
        http = Mock(return_value=b'{"schema_version":1,"enabled":false}')
        fence = main.control_fence(http, lambda: 'token', 'commerce-v7-mail-1065291779811')
        with self.assertRaisesRegex(core.MailError, 'MAIL_CONTROL_PAUSED'):
            fence()
        self.assertIn('/o/mail%2Fcontrol.json?alt=media', http.call_args.args[1])
        http.return_value = b'{"schema_version":1,"enabled":true}'
        fence({'any': 'payload'})


if __name__ == '__main__':
    unittest.main()
