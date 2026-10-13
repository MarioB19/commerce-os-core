"""Closed contracts and SQL for Root's source-isolation issuer.

No Cloud calls, credential handling, transport calls or business mutations.
Root must authenticate the protected input references before calling this core.
Synthetic test inputs are never a technical or human attestation.
"""
import datetime as dt
import hashlib
import json
import re
import uuid

MAX_INPUT = 64 * 1024
MIGRATION = '0067_copy_source_isolation.sql'
METHOD = 'source_billing_disabled_and_primary_device_revoked'
CONFIRMATION = 'REVOKED_PREVIOUS_COMMERCE_DEVICES_AFTER_CHALLENGE'
SOURCE_PROJECT = 'vibe-conversa-prod'
PRIVATE = '/opt/commerce-os/private'
EVIDENCE = PRIVATE + '/source-isolation/evidence/'
UTC = dt.timezone.utc


class IsolationError(RuntimeError):
    pass


def require(condition, code):
    if not condition:
        raise IsolationError(code)


def canonical(value):
    try:
        return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    except (TypeError, ValueError):
        raise IsolationError('ISOLATION_JSON_INVALID') from None


def digest(raw):
    require(type(raw) is bytes, 'ISOLATION_BYTES_REQUIRED')
    return hashlib.sha256(raw).hexdigest()


def parse(raw, maximum=MAX_INPUT):
    require(type(raw) is bytes and 0 < len(raw) <= maximum, 'ISOLATION_INPUT_BOUND')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'ISOLATION_DUPLICATE_FIELD')
            result[key] = value
        return result
    def invalid(_):
        raise IsolationError('ISOLATION_JSON_INVALID')
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise IsolationError('ISOLATION_JSON_INVALID') from None


def _hash(value, length=64):
    return type(value) is str and re.fullmatch('[a-f0-9]{' + str(length) + '}', value) is not None


def _id(value):
    return type(value) is str and re.fullmatch(r'[A-Za-z0-9_:.@+-]{1,160}', value) is not None


def _text(value, maximum=240):
    return type(value) is str and 0 < len(value) <= maximum and not any(ord(c) < 32 for c in value)


def _uuid(value):
    try:
        return type(value) is str and str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def instant(value):
    require(type(value) is str and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z', value) is not None,
            'ISOLATION_TIMESTAMP_INVALID')
    try:
        return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise IsolationError('ISOLATION_TIMESTAMP_INVALID') from None


def reference(value, exact=None):
    require(type(value) is dict and set(value) == {'path', 'bytes', 'sha256'}
            and type(value['path']) is str and value['path'].startswith('/')
            and '..' not in value['path'].split('/') and '\\' not in value['path']
            and '//' not in value['path'] and _text(value['path'], 1024)
            and type(value['bytes']) is int and 0 < value['bytes'] <= MAX_INPUT
            and _hash(value['sha256']), 'ISOLATION_REFERENCE_INVALID')
    require(exact is None or value['path'] == exact, 'ISOLATION_REFERENCE_PATH_INVALID')
    return value


def evidence_reference(value):
    reference(value)
    require(re.fullmatch(re.escape(EVIDENCE) + r'[a-z0-9][a-z0-9-]{0,100}\.json', value['path']) is not None,
            'ISOLATION_EVIDENCE_PATH_INVALID')
    return value


BINDING = {'account_id', 'workspace_id', 'account_version', 'session_id', 'session_revision',
           'previous_owner_id', 'generation', 'credential_generation', 'primary_device_id',
           'responsible_user_id', 'gateway_id', 'remote_session_name', 'expected_identity_fingerprint'}
BASE_CONTROL = {'schema_version', 'action', 'candidate_sha', 'migration67_sha256', 'adoption_ref',
                'billing_ref', 'challenge_id', 'ttl_seconds', 'binding'}


def validate_control(value):
    require(type(value) is dict and value.get('action') in {'prepare', 'finalize'}, 'ISOLATION_ACTION_INVALID')
    require(set(value) == BASE_CONTROL | ({'human_ref'} if value['action'] == 'finalize' else set())
            and type(value['schema_version']) is int and value['schema_version'] == 1,
            'ISOLATION_CONTROL_FIELDS_INVALID')
    require(_hash(value['candidate_sha'], 40) and _hash(value['migration67_sha256'])
            and _uuid(value['challenge_id']) and type(value['ttl_seconds']) is int
            and 1 <= value['ttl_seconds'] <= 12 * 3600, 'ISOLATION_CONTROL_IDENTITY_INVALID')
    reference(value['adoption_ref'], PRIVATE + '/api-web-adoption.json')
    evidence_reference(value['billing_ref'])
    if value['action'] == 'finalize':
        evidence_reference(value['human_ref'])
        require(value['human_ref']['path'] != value['billing_ref']['path'], 'ISOLATION_SEPARATE_HUMAN_EVIDENCE_REQUIRED')
    binding = value['binding']
    require(type(binding) is dict and set(binding) == BINDING, 'ISOLATION_BINDING_FIELDS_INVALID')
    require(_uuid(binding['account_id']) and _uuid(binding['session_id'])
            and all(type(binding[key]) is int and 0 < binding[key] <= 2147483647 for key in
                    ('account_version', 'generation', 'credential_generation'))
            and type(binding['session_revision']) is int and 0 < binding['session_revision'] <= 9007199254740991
            and all(_id(binding[key]) for key in ('workspace_id', 'previous_owner_id', 'responsible_user_id'))
            and all(_text(binding[key], 240) for key in ('primary_device_id', 'gateway_id', 'remote_session_name'))
            and (binding['expected_identity_fingerprint'] is None or _text(binding['expected_identity_fingerprint'], 240)),
            'ISOLATION_BINDING_INVALID')
    return value


def intent(control):
    validate_control(control)
    return {key: value for key, value in control.items() if key not in {'action', 'human_ref'}}


BILLING_FIELDS = {'schema_version', 'recorded_at_utc', 'status', 'source_project', 'credential_account',
                  'native_method', 'native_response', 'identity_verified_by', 'cloud_mutations',
                  'primary_devices_revoked', 'primary_revocation_evidence', 'live_compute_state_observed',
                  'docker_container_stop_attested', 'screenshot', 'authorizes_session_or_sending'}


def validate_billing(raw, ref, now, *, expected_actor):
    from operator_identity import account
    account(expected_actor)
    reference(ref); require(len(raw) == ref['bytes'] and digest(raw) == ref['sha256'], 'ISOLATION_BILLING_CHANGED')
    value = parse(raw)
    require(type(value) is dict and set(value) == BILLING_FIELDS
            and type(value['schema_version']) is int and value['schema_version'] == 1
            and value['status'] == 'ACTUAL_READONLY_SOURCE_BILLING_OBSERVED'
            and value['source_project'] == SOURCE_PROJECT and value['credential_account'] == expected_actor
            and value['native_method'] == 'gcloud billing projects describe vibe-conversa-prod --format=json(projectId,billingEnabled)'
            and type(value['native_response']) is dict and set(value['native_response']) == {'projectId', 'billingEnabled'}
            and value['native_response']['projectId'] == SOURCE_PROJECT and value['native_response']['billingEnabled'] is False
            and value['identity_verified_by'] == 'gcloud auth list ACTIVE actual output in the same Cloud Shell terminal'
            and type(value['cloud_mutations']) is int and value['cloud_mutations'] == 0
            and value['live_compute_state_observed'] is False and value['docker_container_stop_attested'] is False
            and value['authorizes_session_or_sending'] is False and value['primary_devices_revoked'] is False
            and value['primary_revocation_evidence'] == 'PENDING_HUMAN_USER_DEFERRED'
            and type(value['screenshot']) is str and re.fullmatch(r'[a-zA-Z0-9_.-]{1,160}\.jpg', value['screenshot']) is not None,
            'ISOLATION_NATIVE_BILLING_REQUIRED')
    observed = instant(value['recorded_at_utc'])
    require(now.tzinfo is not None and observed <= now and observed > now - dt.timedelta(hours=24),
            'ISOLATION_TECHNICAL_EVIDENCE_EXPIRED')
    # Root protection/provenance is an adapter precondition, not inferred here.
    return {'technical_evidence_sha256': digest(raw), 'technical_observed_at': value['recorded_at_utc']}


HUMAN_FIELDS = {'schema_version', 'status', 'challenge_id', 'account_id', 'workspace_id',
                'actor_user_id', 'responsible_user_id', 'primary_device_id', 'performed_at', 'recorded_at',
                'confirmation', 'canonical_event_id', 'idempotency_key', 'authentication_method',
                'credential_id', 'source_message_ref'}
MESSAGE_FIELDS = {'schema_version', 'kind', 'challenge_id', 'account_id', 'workspace_id',
                  'actor_user_id', 'responsible_user_id', 'primary_device_id', 'performed_at',
                  'received_at', 'confirmation', 'source_message_id', 'statement'}


def validate_human(raw, ref, message_raw, control, now):
    evidence_reference(ref)
    require(len(raw) == ref['bytes'] and digest(raw) == ref['sha256'], 'ISOLATION_HUMAN_CHANGED')
    value = parse(raw)
    require(type(value) is dict and set(value) == HUMAN_FIELDS and type(value['schema_version']) is int
            and value['schema_version'] == 1 and value['status'] == 'HUMAN_PRIMARY_DEVICE_REVOCATION_ATTESTED'
            and value['confirmation'] == CONFIRMATION and _id(value['actor_user_id'])
            and _uuid(value['canonical_event_id']) and _text(value['idempotency_key'], 160)
            and len(value['idempotency_key']) >= 8
            and value['authentication_method'] in {'session', 'personal_access_token'}
            and (value['credential_id'] is None if value['authentication_method'] == 'session' else _uuid(value['credential_id'])),
            'ISOLATION_EXPLICIT_HUMAN_EVIDENCE_REQUIRED')
    evidence_reference(value['source_message_ref'])
    require(value['source_message_ref']['path'] not in {ref['path'], control['billing_ref']['path']}
            and len(message_raw) == value['source_message_ref']['bytes']
            and digest(message_raw) == value['source_message_ref']['sha256'], 'ISOLATION_HUMAN_SOURCE_CHANGED')
    source = parse(message_raw)
    require(type(source) is dict and set(source) == MESSAGE_FIELDS
            and type(source['schema_version']) is int and source['schema_version'] == 1
            and source['kind'] == 'DIRECT_HUMAN_PRIMARY_DEVICE_CONFIRMATION'
            and _text(source['source_message_id'], 160) and _text(source['statement'], 2000)
            and source['confirmation'] == CONFIRMATION,
            'ISOLATION_DIRECT_HUMAN_SOURCE_REQUIRED')
    for key in ('challenge_id', 'account_id', 'workspace_id', 'responsible_user_id', 'primary_device_id'):
        expected = control['challenge_id'] if key == 'challenge_id' else control['binding'][key]
        require(value[key] == expected and source[key] == expected, 'ISOLATION_HUMAN_SCOPE_CHANGED')
    for key in ('actor_user_id', 'performed_at', 'confirmation'):
        require(value[key] == source[key], 'ISOLATION_HUMAN_SOURCE_CHANGED')
    performed, received, recorded = map(instant, (value['performed_at'], source['received_at'], value['recorded_at']))
    require(performed <= received <= recorded <= now, 'ISOLATION_HUMAN_TIME_INVALID')
    # This source must be captured from an actual explicit human reply by Root.
    # A PAT declaration, generic authorization or assistant-generated JSON alone
    # never supplies this separate source, even if it has the right shape.
    return {key: value[key] for key in HUMAN_FIELDS - {'source_message_ref', 'status', 'schema_version'}} | {
        'human_evidence_sha256': digest(raw), 'source_message_sha256': digest(message_raw)}


def sql_payload(control, technical, human=None):
    validate_control(control)
    require(type(technical) is dict and set(technical) == {'technical_evidence_sha256', 'technical_observed_at'}
            and technical['technical_evidence_sha256'] == control['billing_ref']['sha256'], 'ISOLATION_TECHNICAL_BINDING_INVALID')
    instant(technical['technical_observed_at'])
    require((human is None) == (control['action'] == 'prepare'), 'ISOLATION_HUMAN_REQUIRED_FOR_FINALIZE')
    value = {'action': control['action'], 'challenge_id': control['challenge_id'], 'binding': control['binding'],
             'ttl_seconds': control['ttl_seconds'], 'migration67_sha256': control['migration67_sha256'], **technical}
    if human is not None:
        value['human'] = human
        value['evidence_sha256'] = digest(canonical({'method': METHOD, 'intent': intent(control),
                                                    'technical': technical, 'human': human}))
    return value


def transaction_sql(payload):
    """One bounded transaction; only challenge/receipt writes are permitted.

    Hex serialization carries data through SQL without interpolation or psql
    variable expansion. Deadlines are checked after all locks and at DML time.
    Queue SHARE locks prevent a producer from inserting a phantom during issue.
    """
    encoded = canonical(payload).hex()
    require(len(encoded) <= MAX_INPUT * 2, 'ISOLATION_SQL_INPUT_BOUND')
    return _SQL.replace('__HEX_PAYLOAD__', encoded)


_SQL = r"""BEGIN;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='10s';
SET LOCAL idle_in_transaction_session_timeout='25s';
SET LOCAL search_path=pg_catalog,public,pg_temp;
DO $isolation_root$
DECLARE p jsonb:=convert_from(decode('__HEX_PAYLOAD__','hex'),'UTF8')::jsonb;
 b jsonb:=p->'binding'; a public.records%ROWTYPE; s public.channel_sessions%ROWTYPE;
 o public.session_ownership%ROWTYPE; c public.copy_source_isolation_challenges%ROWTYPE;
 r public.ownership_isolation_receipts%ROWTYPE; e public.domain_events%ROWTYPE;
 h jsonb:=p->'human'; tick timestamptz; expiry timestamptz; observed timestamptz:=(p->>'technical_observed_at')::timestamptz;
 source text; actor_type text; idem_actor text; n integer; receipt_id uuid;
BEGIN
 IF current_user<>'commerce_owner' THEN RAISE EXCEPTION 'ISOLATION_ROOT_DATABASE_OWNER_REQUIRED'; END IF;
 -- V7: profile tables enforce RLS; bind this transaction to the bound profile.
 PERFORM pg_catalog.set_config('app.workspace_id',b->>'workspace_id',true),pg_catalog.set_config('app.environment','REAL',true);
 -- Canonical API order: operations/policy before account lifecycle.
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('operations:'||(b->>'workspace_id')||':REAL',0));
 PERFORM pg_advisory_xact_lock(hashtextextended('channel-command:'||(b->>'account_id'),0));
 PERFORM 1 FROM public.schema_migrations WHERE name='0067_copy_source_isolation.sql' AND sha256=p->>'migration67_sha256' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ISOLATION_INSTALLED_MIGRATION_CHANGED'; END IF;
 SELECT * INTO a FROM public.records WHERE id=(b->>'account_id')::uuid FOR SHARE;
 SELECT * INTO s FROM public.channel_sessions WHERE account_id=(b->>'account_id')::uuid FOR UPDATE;
 SELECT * INTO o FROM public.session_ownership WHERE account_id=b->>'account_id' FOR UPDATE;
 PERFORM 1 FROM public.memberships WHERE workspace_id=b->>'workspace_id' AND user_id=b->>'responsible_user_id' AND active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ISOLATION_RESPONSIBLE_INACTIVE'; END IF;
 PERFORM 1 FROM public.operational_settings WHERE workspace_id=b->>'workspace_id' AND environment='REAL'
  AND body @> '{"dispatch_frozen":true,"real_sends_enabled":false,"allow_real_operations":false}'::jsonb FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ISOLATION_REAL_POLICY_NOT_FROZEN'; END IF;
 PERFORM 1 FROM public.manual_controls WHERE workspace_id=b->>'workspace_id' AND scope_type='workspace'
  AND scope_id=b->>'workspace_id' AND paused FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ISOLATION_WORKSPACE_NOT_PAUSED'; END IF;
 -- Freeze prevents external attempts; these short SHARE locks additionally
 -- exclude queue phantoms while retaining all existing rows without edits.
 LOCK TABLE public.commands,public.outbox,public.effect_attempts,public.inbound_envelopes IN SHARE MODE;
 IF p->>'action'='finalize' THEN
  SELECT * INTO c FROM public.copy_source_isolation_challenges WHERE id=(p->>'challenge_id')::uuid FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'ISOLATION_CHALLENGE_REQUIRED'; END IF;
  IF c.completed_receipt_id IS NOT NULL THEN
   SELECT * INTO r FROM public.ownership_isolation_receipts WHERE id=c.completed_receipt_id FOR UPDATE;
  END IF;
 ELSE
  SELECT * INTO c FROM public.copy_source_isolation_challenges WHERE id=(p->>'challenge_id')::uuid FOR UPDATE;
 END IF;
 -- Every actual-time test below occurs after row/advisory/table lock waits.
 tick:=clock_timestamp();
 IF a.id IS NULL OR a.workspace_id IS DISTINCT FROM b->>'workspace_id' OR a.environment<>'REAL'
  OR a.kind<>'channel_account' OR a.body->>'provider' IS DISTINCT FROM 'waha'
  OR a.body->>'deleted_at' IS NOT NULL OR a.version IS DISTINCT FROM (b->>'account_version')::integer
  OR a.body->'sending_enabled' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'ISOLATION_ACCOUNT_CHANGED'; END IF;
 IF s.id IS DISTINCT FROM (b->>'session_id')::uuid OR s.workspace_id IS DISTINCT FROM a.workspace_id OR s.environment IS DISTINCT FROM 'REAL'
  OR s.archived_at IS NOT NULL OR s.provider IS DISTINCT FROM 'waha'
  OR s.revision IS DISTINCT FROM (b->>'session_revision')::bigint
  OR s.credential_generation IS DISTINCT FROM (b->>'credential_generation')::integer
  OR s.primary_device_id IS DISTINCT FROM b->>'primary_device_id' OR s.responsible_user_id IS DISTINCT FROM b->>'responsible_user_id'
  OR s.gateway_id IS DISTINCT FROM b->>'gateway_id' OR s.remote_session_name IS DISTINCT FROM b->>'remote_session_name'
  OR s.expected_identity_fingerprint IS DISTINCT FROM b->>'expected_identity_fingerprint'
  OR s.desired_state IS DISTINCT FROM 'STOPPED' OR s.operational_pause IS DISTINCT FROM true OR s.recovery_enabled IS DISTINCT FROM false
  THEN RAISE EXCEPTION 'ISOLATION_SESSION_CHANGED'; END IF;
 IF o.account_id IS NULL OR o.workspace_id IS DISTINCT FROM a.workspace_id OR o.owner_id IS DISTINCT FROM b->>'previous_owner_id'
  OR o.generation IS DISTINCT FROM (b->>'generation')::integer OR o.frozen IS DISTINCT FROM true OR o.lease_expires_at>tick
  THEN RAISE EXCEPTION 'ISOLATION_OWNERSHIP_CHANGED'; END IF;
 IF observed>tick OR observed<=tick-interval '24 hours' THEN RAISE EXCEPTION 'ISOLATION_TECHNICAL_EVIDENCE_EXPIRED'; END IF;
 IF EXISTS(SELECT 1 FROM public.commands WHERE workspace_id=a.workspace_id AND environment='REAL' AND resource_id=a.id::text AND kind='channel_command'
  AND (status='PENDING' OR (status='FAILED' AND COALESCE(result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(result?'reconciled_at'))))
  OR EXISTS(SELECT 1 FROM public.outbox WHERE workspace_id=a.workspace_id AND environment='REAL' AND account_id=a.id::text AND status IN('READY','SENDING','UNKNOWN'))
  OR EXISTS(SELECT 1 FROM public.effect_attempts t JOIN public.outbox x ON x.id=t.effect_id
   WHERE x.workspace_id=a.workspace_id AND x.environment='REAL' AND x.account_id=a.id::text AND t.finished_at IS NULL)
  OR EXISTS(SELECT 1 FROM public.inbound_envelopes WHERE workspace_id=a.workspace_id AND environment='REAL' AND account_id=a.id::text AND status='PENDING')
  THEN RAISE EXCEPTION 'ISOLATION_RECONCILIATION_REQUIRED'; END IF;
 IF c.id IS NOT NULL AND (c.account_id IS DISTINCT FROM a.id OR c.workspace_id IS DISTINCT FROM a.workspace_id OR c.environment IS DISTINCT FROM 'REAL'
  OR c.account_version IS DISTINCT FROM a.version OR c.session_revision IS DISTINCT FROM s.revision
  OR c.previous_owner_id IS DISTINCT FROM o.owner_id OR c.generation IS DISTINCT FROM o.generation
  OR c.credential_generation IS DISTINCT FROM s.credential_generation OR c.primary_device_id IS DISTINCT FROM s.primary_device_id
  OR c.responsible_user_id IS DISTINCT FROM s.responsible_user_id OR c.source_project IS DISTINCT FROM 'vibe-conversa-prod'
  OR c.billing_enabled IS DISTINCT FROM false OR c.technical_evidence_sha256 IS DISTINCT FROM p->>'technical_evidence_sha256'
  OR c.technical_observed_at IS DISTINCT FROM observed) THEN RAISE EXCEPTION 'ISOLATION_CHALLENGE_TUPLE_CHANGED'; END IF;
 IF c.id IS NOT NULL AND (c.expires_at<=clock_timestamp() OR c.technical_observed_at<=clock_timestamp()-interval '24 hours')
  THEN RAISE EXCEPTION 'ISOLATION_CHALLENGE_EXPIRED'; END IF;
 IF p->>'action'='prepare' THEN
  IF c.id IS NULL THEN
   tick:=clock_timestamp(); expiry:=LEAST(tick+make_interval(secs=>(p->>'ttl_seconds')::integer),observed+interval '24 hours');
   IF observed>tick OR observed<=tick-interval '24 hours' OR expiry<=tick THEN RAISE EXCEPTION 'ISOLATION_TECHNICAL_EVIDENCE_EXPIRED'; END IF;
   INSERT INTO public.copy_source_isolation_challenges(id,workspace_id,environment,account_id,account_version,session_revision,
    previous_owner_id,generation,credential_generation,primary_device_id,responsible_user_id,source_project,billing_enabled,
    technical_evidence_sha256,technical_observed_at,issued_at,expires_at)
   VALUES((p->>'challenge_id')::uuid,a.workspace_id,'REAL',a.id,a.version,s.revision,o.owner_id,o.generation,s.credential_generation,
    s.primary_device_id,s.responsible_user_id,'vibe-conversa-prod',false,p->>'technical_evidence_sha256',observed,tick,expiry) RETURNING * INTO c;
  END IF;
  PERFORM set_config('commerce.isolation_result',json_build_object('status','CHALLENGE_PREPARED','challenge_id',c.id,
    'expires_at',c.expires_at,'root_receipt_issued',false,'authorizes_operations',false)::text,true);
 ELSE
  IF h IS NULL OR c.primary_revocation_reported_at IS NULL THEN RAISE EXCEPTION 'ISOLATION_HUMAN_REPORT_REQUIRED'; END IF;
  source:=CASE h->>'authentication_method' WHEN 'session' THEN 'owner_confirmation' WHEN 'personal_access_token' THEN 'personal_owner_report' END;
  actor_type:=CASE h->>'authentication_method' WHEN 'session' THEN 'human' WHEN 'personal_access_token' THEN 'personal_api' END;
  idem_actor:=CASE h->>'authentication_method' WHEN 'session' THEN h->>'actor_user_id' ELSE 'personal:'||(h->>'credential_id') END;
  PERFORM 1 FROM public.memberships WHERE workspace_id=a.workspace_id AND user_id=h->>'actor_user_id' AND active AND role='owner' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ISOLATION_REPORT_OWNER_INACTIVE'; END IF;
  IF c.primary_revocation_reported_by IS DISTINCT FROM h->>'actor_user_id' OR c.primary_report_source IS DISTINCT FROM source
   OR (h->>'performed_at')::timestamptz<c.issued_at OR (h->>'performed_at')::timestamptz>c.primary_revocation_reported_at
   OR (h->>'recorded_at')::timestamptz<c.primary_revocation_reported_at OR (h->>'recorded_at')::timestamptz>clock_timestamp()
   OR c.primary_revocation_reported_at>clock_timestamp() THEN RAISE EXCEPTION 'ISOLATION_HUMAN_REPORT_CHANGED'; END IF;
  IF source='personal_owner_report' THEN
   PERFORM 1 FROM public.personal_access_tokens WHERE id=(h->>'credential_id')::uuid AND workspace_id=a.workspace_id
    AND user_id=h->>'actor_user_id' AND revoked_at IS NULL AND expires_at>clock_timestamp() AND allowed_environments ? 'REAL' FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'ISOLATION_REPORT_CREDENTIAL_INACTIVE'; END IF;
  END IF;
  SELECT * INTO e FROM public.domain_events WHERE id=(h->>'canonical_event_id')::uuid;
  IF e.id IS NULL OR e.workspace_id IS DISTINCT FROM a.workspace_id OR e.environment IS DISTINCT FROM 'REAL'
   OR e.aggregate_id IS DISTINCT FROM a.id::text OR e.event_type IS DISTINCT FROM 'channel.source_isolation.primary_reported'
   OR e.actor->>'id' IS DISTINCT FROM h->>'actor_user_id' OR e.actor->>'type' IS DISTINCT FROM actor_type
   OR (source='personal_owner_report' AND e.actor->>'credential_id' IS DISTINCT FROM h->>'credential_id')
   OR e.payload->>'challenge_id' IS DISTINCT FROM c.id::text OR e.payload->>'source' IS DISTINCT FROM source
   OR e.payload->'previous_devices_revoked_declared' IS DISTINCT FROM 'true'::jsonb
   OR e.payload->'root_receipt_issued' IS DISTINCT FROM 'false'::jsonb OR e.payload->'remote_calls' IS DISTINCT FROM '0'::jsonb
   OR e.recorded_at<c.issued_at OR e.recorded_at>c.primary_revocation_reported_at OR e.recorded_at>(h->>'recorded_at')::timestamptz
   THEN RAISE EXCEPTION 'ISOLATION_CANONICAL_REPORT_REQUIRED'; END IF;
  PERFORM 1 FROM public.idempotency WHERE workspace_id=a.workspace_id AND actor_id=idem_actor
   AND operation='channel.source_isolation.confirm:'||a.id::text AND key=h->>'idempotency_key' AND status_code=200
   AND response->>'challenge_id'=c.id::text AND response->>'account_id'=a.id::text
   AND response->>'status'='PRIMARY_REVOCATION_DECLARED' AND response->>'source'=source
   -- HTTP/pg Date serializes milliseconds; retain the DB's exact microseconds.
   AND (response->>'reported_at')::timestamptz=date_trunc('milliseconds',c.primary_revocation_reported_at)
   AND response->>'root_verification'='PENDING' AND response->'authorizes_operations'='false'::jsonb FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ISOLATION_CANONICAL_REPLAY_REQUIRED'; END IF;
  -- Membership/PAT/idempotency locks above can wait beyond the earlier check.
  -- Re-read actual deadlines only after every blocking authority lookup.
  tick:=clock_timestamp();
  IF c.expires_at<=tick OR observed<=tick-interval '24 hours' THEN RAISE EXCEPTION 'ISOLATION_CHALLENGE_EXPIRED'; END IF;
  IF source='personal_owner_report' AND NOT EXISTS(SELECT 1 FROM public.personal_access_tokens
   WHERE id=(h->>'credential_id')::uuid AND workspace_id=a.workspace_id AND user_id=h->>'actor_user_id'
    AND revoked_at IS NULL AND expires_at>clock_timestamp() AND allowed_environments ? 'REAL')
   THEN RAISE EXCEPTION 'ISOLATION_REPORT_CREDENTIAL_INACTIVE'; END IF;
  IF c.completed_receipt_id IS NOT NULL THEN
   IF r.id IS NULL OR r.account_id IS DISTINCT FROM a.id OR r.workspace_id IS DISTINCT FROM a.workspace_id
    OR r.previous_owner_id IS DISTINCT FROM o.owner_id OR r.generation IS DISTINCT FROM o.generation OR r.method IS DISTINCT FROM 'source_billing_disabled_and_primary_device_revoked'
    OR r.evidence_sha256 IS DISTINCT FROM p->>'evidence_sha256' OR r.consumed_at IS NOT NULL
    OR r.verified_at>clock_timestamp() OR r.verified_at<=clock_timestamp()-interval '24 hours'
    THEN RAISE EXCEPTION 'ISOLATION_COMPLETED_RECEIPT_CHANGED'; END IF;
   receipt_id:=r.id;
  ELSE
   tick:=clock_timestamp();
   IF c.expires_at<=tick OR observed<=tick-interval '24 hours' THEN RAISE EXCEPTION 'ISOLATION_CHALLENGE_EXPIRED'; END IF;
   INSERT INTO public.ownership_isolation_receipts(account_id,workspace_id,previous_owner_id,generation,method,evidence_sha256,verified_at)
   VALUES(a.id,a.workspace_id,o.owner_id,o.generation,'source_billing_disabled_and_primary_device_revoked',p->>'evidence_sha256',tick) RETURNING id INTO receipt_id;
   UPDATE public.copy_source_isolation_challenges SET completed_receipt_id=receipt_id
    WHERE id=c.id AND completed_receipt_id IS NULL AND expires_at>clock_timestamp() AND technical_observed_at>clock_timestamp()-interval '24 hours';
   GET DIAGNOSTICS n=ROW_COUNT;
   IF n<>1 THEN RAISE EXCEPTION 'ISOLATION_FINAL_DEADLINE_CHANGED'; END IF;
  END IF;
  PERFORM set_config('commerce.isolation_result',json_build_object('status','ROOT_RECEIPT_READY','challenge_id',c.id,
    'receipt_id',receipt_id,'root_receipt_issued',true,'authorizes_operations',false)::text,true);
 END IF;
END
$isolation_root$;
SELECT current_setting('commerce.isolation_result');
COMMIT;
"""
