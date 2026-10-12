"""Bounded Mail API dispatch behind authenticated internal dependencies.

This module never obtains credentials, starts a service, sends SMTP, logs a
message, creates a missing journal or retries an effect. Production adapters
must authenticate the ID token and the fixed control/economic admission; those
dependencies are installed code, never request-supplied callbacks or claims.
"""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import base64
import hashlib
import json
import re
import uuid
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

MAX_BODY = 16 * 1024
MAX_ROWS = 4096
TEMPLATE = 'profile-invitation-v1'
STATES = {'INTENT', 'ACCEPTED', 'REJECTED', 'UNKNOWN'}


class MailError(RuntimeError):
    pass


def need(value, code):
    if not value:
        raise MailError(code)


def exact(value, fields, code):
    need(type(value) is dict and set(value) == set(fields.split()), code)


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def decode(raw):
    need(type(raw) is bytes and 0 < len(raw) <= MAX_BODY, 'MAIL_BODY_BOUND')
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, 'MAIL_DUPLICATE_FIELD')
            result[key] = value
        return result
    def invalid(_):
        raise MailError('MAIL_NONFINITE_JSON')
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)
    except (ValueError, UnicodeError, RecursionError):
        raise MailError('MAIL_INVALID_JSON') from None


def digest(value):
    need(type(value) is str and re.fullmatch('[a-f0-9]{64}', value), 'MAIL_DIGEST_INVALID')
    return value


def identifier(value):
    try:
        valid = type(value) is str and str(uuid.UUID(value)) == value and uuid.UUID(value).version == 4
    except (ValueError, AttributeError):
        valid = False
    need(valid, 'MAIL_ID_INVALID')
    return value


def utc(value):
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00')) if type(value) is str else value
        valid = type(result) is datetime and result.tzinfo is not None and result.utcoffset() == timedelta(0)
    except (ValueError, TypeError):
        valid = False
    need(valid, 'MAIL_TIME_INVALID')
    return result


def b64(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip('=')


def unb64(value, maximum):
    need(type(value) is str and 0 < len(value) <= maximum * 2 and re.fullmatch('[A-Za-z0-9_-]+', value),
         'MAIL_ENCODING_INVALID')
    try:
        raw = base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)
    except ValueError:
        raise MailError('MAIL_ENCODING_INVALID') from None
    need(len(raw) <= maximum and b64(raw) == value, 'MAIL_ENCODING_INVALID')
    return raw


def validate_config(config):
    exact(config, 'schema_version project sender origin audience dispatcher_email dispatcher_subject', 'MAIL_CONFIG_FIELDS')
    need(type(config['schema_version']) is int and config['schema_version'] == 1, 'MAIL_CONFIG_VERSION')
    project = config['project']
    need(type(project) is str and re.fullmatch('[a-z][a-z0-9-]{4,61}[a-z0-9]', project), 'MAIL_PROJECT_INVALID')
    need(config['sender'] == 'invitations@' + project + '.appspotmail.com', 'MAIL_SENDER_CHANGED')
    for key in ('origin', 'audience'):
        value = config[key]; need(type(value) is str, 'MAIL_ORIGIN_INVALID')
        parsed = urlsplit(value)
        need(parsed.scheme == 'https' and parsed.hostname and not parsed.username and not parsed.password
             and parsed.path == '' and not parsed.query and not parsed.fragment and parsed.port in (None, 443),
             'MAIL_ORIGIN_INVALID')
    need(type(config['dispatcher_email']) is str and re.fullmatch(
        '[a-z][a-z0-9-]{4,28}[a-z0-9]@' + re.escape(project) + r'\.iam\.gserviceaccount\.com',
        config['dispatcher_email']), 'MAIL_DISPATCHER_INVALID')
    need(type(config['dispatcher_subject']) is str and re.fullmatch('[1-9][0-9]{10,29}', config['dispatcher_subject']),
         'MAIL_DISPATCHER_INVALID')
    return config


def validate_identity(claims, config, now):
    need(type(claims) is dict and claims.get('iss') in {'accounts.google.com', 'https://accounts.google.com'}
         and claims.get('aud') == config['audience'] and claims.get('email') == config['dispatcher_email']
         and claims.get('sub') == config['dispatcher_subject'] and claims.get('email_verified') is True,
         'MAIL_IDENTITY_CHANGED')
    need(type(claims.get('iat')) is int and type(claims.get('exp')) is int and
         claims['iat'] <= now.timestamp() < claims['exp'] <= claims['iat'] + 3600, 'MAIL_IDENTITY_EXPIRED')


def validate_payload(value, attempt_id, now):
    exact(value, 'schema_version event_id workspace_id entity_id entity_version template recipient recipient_hmac '
          'link_token dispatched_at link_expires_at authorized_until budget_reservation_id', 'MAIL_PAYLOAD_FIELDS')
    need(type(value['schema_version']) is int and value['schema_version'] == 1 and value['template'] == TEMPLATE,
         'MAIL_TEMPLATE_INVALID')
    identifier(attempt_id)
    for key in ('event_id', 'entity_id', 'budget_reservation_id'):
        identifier(value[key])
    # Existing workspace IDs are text. Match the shared profileIdSchema's
    # 256 UTF-16-unit boundary, retain exact bytes, and never normalize an ID.
    workspace = value['workspace_id']
    need(type(workspace) is str and '\0' not in workspace and
         0 < len(workspace.encode('utf-16-le', errors='surrogatepass')) // 2 <= 256,
         'MAIL_WORKSPACE_INVALID')
    need(value['budget_reservation_id'] == attempt_id, 'MAIL_BUDGET_ATTEMPT_CHANGED')
    need(type(value['entity_version']) is int and 1 <= value['entity_version'] <= 9007199254740991, 'MAIL_VERSION_INVALID')
    digest(value['recipient_hmac'])
    recipient = value['recipient']
    need(type(recipient) is str and len(recipient.encode()) <= 254 and re.fullmatch(
        r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
        r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+", recipient), 'MAIL_RECIPIENT_INVALID')
    local = recipient.split('@')[0]
    need(not local.startswith('.') and not local.endswith('.') and '..' not in local, 'MAIL_RECIPIENT_INVALID')
    token = value['link_token']
    need(type(token) is str and token.startswith('cos_inv_') and len(unb64(token[8:], 32)) == 32,
         'MAIL_LINK_TOKEN_INVALID')
    start, limit, expiry = (utc(value[k]) for k in ('dispatched_at', 'authorized_until', 'link_expires_at'))
    need(start <= now < limit <= start + timedelta(seconds=120) and expiry == start + timedelta(hours=24),
         'MAIL_AUTHORIZATION_EXPIRED')
    return value


def seal(payload, attempt_id, key, nonce):
    """Trusted outbox encryption only. Nonce comes from the OS CSPRNG per call."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    identifier(attempt_id)
    need(type(key) is bytes and len(key) == 32 and type(nonce) is bytes and len(nonce) == 12, 'MAIL_KEY_INVALID')
    ciphertext = AESGCM(key).encrypt(nonce, encode(payload), b'commerce-mail-v1:' + attempt_id.encode())
    raw = encode({'schema_version': 1, 'attempt_id': attempt_id, 'nonce': b64(nonce), 'ciphertext': b64(ciphertext)})
    need(len(raw) <= MAX_BODY, 'MAIL_BODY_BOUND')
    return raw


def open_envelope(raw, key):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    outer = decode(raw)
    exact(outer, 'schema_version attempt_id nonce ciphertext', 'MAIL_ENVELOPE_FIELDS')
    need(type(outer['schema_version']) is int and outer['schema_version'] == 1, 'MAIL_ENVELOPE_VERSION')
    attempt = identifier(outer['attempt_id']); nonce = unb64(outer['nonce'], 12)
    need(type(key) is bytes and len(key) == 32 and len(nonce) == 12, 'MAIL_KEY_INVALID')
    try:
        plaintext = AESGCM(key).decrypt(nonce, unb64(outer['ciphertext'], MAX_BODY), b'commerce-mail-v1:' + attempt.encode())
    except Exception:
        raise MailError('MAIL_ENVELOPE_AUTHENTICATION_FAILED') from None
    return attempt, decode(plaintext)


def event_key(payload):
    return hashlib.sha256(encode([payload[k] for k in
        ('workspace_id', 'template', 'entity_id', 'entity_version', 'recipient_hmac')])).hexdigest()


def possible_send_days(start, end):
    """Native Pacific days touched by the half-open, at-most120s send lease."""
    start, end = utc(start), utc(end)
    need(start < end <= start + timedelta(seconds=120), 'MAIL_SEND_WINDOW_INVALID')
    zone = ZoneInfo('America/Los_Angeles')
    return {start.astimezone(zone).date(), (end-timedelta(microseconds=1)).astimezone(zone).date()}


def initial_journal():
    """Explicit native provisioning only; a request never calls this function."""
    return {'schema_version': 1, 'events': {}, 'attempts': {}}


def validate_journal(doc):
    exact(doc, 'schema_version events attempts', 'MAIL_JOURNAL_FIELDS')
    need(type(doc['schema_version']) is int and doc['schema_version'] == 1 and
         type(doc['events']) is dict and type(doc['attempts']) is dict and
         len(doc['events']) == len(doc['attempts']) <= MAX_ROWS, 'MAIL_JOURNAL_INVALID')
    for attempt_id, row in doc['attempts'].items():
        identifier(attempt_id)
        exact(row, 'event_key payload_sha256 event_id authorized_until intent_at state result_at', 'MAIL_ROW_FIELDS')
        digest(row['event_key']); digest(row['payload_sha256']); identifier(row['event_id'])
        need(doc['events'].get(row['event_key']) == attempt_id, 'MAIL_DEDUPE_CHANGED')
        need(row['state'] in STATES and utc(row['intent_at']) < utc(row['authorized_until']), 'MAIL_ROW_INVALID')
        possible_send_days(row['intent_at'], row['authorized_until'])
        need((row['state'] == 'INTENT' and row['result_at'] is None) or
             (row['state'] != 'INTENT' and utc(row['result_at']) >= utc(row['intent_at'])), 'MAIL_RESULT_INVALID')
    return doc


class DispatchService:
    """All injected adapters are trusted installed code, not HTTP parameters.

    store.compare_and_swap must confirm generation+bytes by readback; uncertainty
    raises. fence(payload) authenticates current pause, economic admission and
    native configuration against the GCM-authenticated lease produced by the
    trusted DB outbox. It does not query the database or send a message.
    authenticate(token, audience) validates Google's signature before returning
    claims. provider is the one Mail API call below, never a URL from a request.
    """
    def __init__(self, config, *, store, authenticate, key_provider, fence, provider,
                 clock=lambda: datetime.now(timezone.utc)):
        self.config = deepcopy(validate_config(config))
        self.store, self.authenticate, self.key_provider = store, authenticate, key_provider
        self.fence, self.provider, self.clock = fence, provider, clock

    def response(self, attempt_id, state):
        return {'attempt_id': attempt_id, 'state': state, 'delivery_proven': False}

    def dispatch(self, raw, token):
        claims = self.authenticate(token, self.config['audience'])
        validate_identity(claims, self.config, utc(self.clock()))
        attempt_id, payload = open_envelope(raw, self.key_provider())
        validate_payload(payload, attempt_id, utc(self.clock()))
        key, payload_sha = event_key(payload), hashlib.sha256(encode(payload)).hexdigest()
        generation, old = self.store.load()
        need(type(generation) is str and re.fullmatch('[1-9][0-9]*', generation) and old is not None,
             'MAIL_JOURNAL_MISSING_NO_RESET')
        validate_journal(old)
        if attempt_id in old['attempts']:
            previous = old['attempts'][attempt_id]
            need(previous['payload_sha256'] == payload_sha and previous['event_key'] == key, 'MAIL_ATTEMPT_CHANGED')
            return self.response(attempt_id, 'UNKNOWN' if previous['state'] == 'INTENT' else previous['state'])
        need(key not in old['events'], 'MAIL_EVENT_ALREADY_CONSUMED')
        need(len(old['attempts']) < MAX_ROWS, 'MAIL_JOURNAL_CAPACITY_REQUIRES_ADMISSION')
        self.fence(payload)
        now = utc(self.clock()); validate_payload(payload, attempt_id, now); validate_identity(claims, self.config, now)
        dates = [utc(row['intent_at']) for row in old['attempts'].values()]
        need(all(date <= now for date in dates), 'MAIL_JOURNAL_CLOCK_REVERSED')
        # Intent precedes a possibly delayed provider call. Retain its whole
        # authorized send window, including failures/unknowns, so two groups of
        # reservations cannot concentrate their late sends inside one window.
        ends = [utc(row['authorized_until']) for row in old['attempts'].values()]
        need(sum(end >= now-timedelta(seconds=60) for end in ends) < 8, 'MAIL_RECIPIENT_QUOTA')
        history_days = [possible_send_days(row['intent_at'], row['authorized_until'])
                        for row in old['attempts'].values()]
        need(all(sum(day in days for days in history_days) < 100
                 for day in possible_send_days(now, payload['authorized_until'])), 'MAIL_RECIPIENT_QUOTA')
        proposed = deepcopy(old)
        proposed['events'][key] = attempt_id
        proposed['attempts'][attempt_id] = {'event_key': key, 'payload_sha256': payload_sha,
            'event_id': payload['event_id'], 'authorized_until': payload['authorized_until'],
            'intent_at': now.isoformat(), 'state': 'INTENT', 'result_at': None}
        validate_journal(proposed)
        try:
            committed = self.store.compare_and_swap(generation, proposed)
            need(type(committed) is str and re.fullmatch('[1-9][0-9]*', committed) and committed != generation,
                 'MAIL_CAS_UNCONFIRMED')
        except Exception:
            return self.response(attempt_id, 'UNKNOWN')
        # Final I/O admission follows the committed intent. Only local checks
        # remain between that fence and the single provider call.
        try:
            self.fence(payload)
            now = utc(self.clock()); validate_payload(payload, attempt_id, now); validate_identity(claims, self.config, now)
            link = self.config['origin'] + '/accept-invitation#' + payload['link_token']
            body = 'Te invitaron a un perfil de Commerce OS.\n\n' + link + '\n\nEl enlace vence en 24 horas. Si no lo esperabas, ignora este correo.'
            self.provider(sender=self.config['sender'], recipient=payload['recipient'],
                          subject='Invitación a Commerce OS', body=body)
            state = 'ACCEPTED'
        except Exception:
            state = 'UNKNOWN'
        try:
            observed_generation, actual = self.store.load()
            need(observed_generation == committed and actual == proposed, 'MAIL_JOURNAL_CHANGED_AFTER_SEND')
            finished = deepcopy(actual)
            finished['attempts'][attempt_id].update(state=state, result_at=utc(self.clock()).isoformat())
            validate_journal(finished)
            confirmed = self.store.compare_and_swap(committed, finished)
            need(type(confirmed) is str and re.fullmatch('[1-9][0-9]*', confirmed) and confirmed != committed,
                 'MAIL_RESULT_UNCONFIRMED')
        except Exception:
            return self.response(attempt_id, 'UNKNOWN')
        return self.response(attempt_id, state)


def appengine_mail_api(*, sender, recipient, subject, body):
    """One bundled Mail API RPC. No SDK .send() SMTP branch or error logging."""
    from google.appengine.api import api_base_pb2, apiproxy_stub_map, mail
    message = mail.EmailMessage(sender=sender, to=recipient, subject=subject, body=body)
    rpc = apiproxy_stub_map.UserRPC('mail', deadline=10)
    rpc.make_call('Send', message.ToProto(), api_base_pb2.VoidProto())
    rpc.wait()
    rpc.check_success()
