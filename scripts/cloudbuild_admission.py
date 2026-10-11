"""Pure CI admission ledger; this module never performs a network or build call.

The trusted controller verifies approvals, native inventory and native evidence
before supplying their hashes here. Hashes/booleans are bindings, not signatures.
This module neither authenticates a webhook nor attests tests nor publishes PASS.

``transition(doc, command, now=UTC)`` proposes an immutable JSON update.
``transact(store, command, now=UTC)`` performs exactly one CAS. A CREATE_ONCE
effect is returned ONLY after compare_and_swap has confirmed the committed bytes.
The store must read back generation + hash before returning; an ambiguous write
raises CommitOutcomeUnknown. Replaying a committed intent returns NO effect,
including when its original caller died before sending the POST. Never turn a
CAS conflict, expired lease, HTTP timeout or cancellation request into a retry.

Commands (unknown fields are rejected):
* discover: attempt_id (local UUID), plan. A plan binds identity(event_id,
  repository_id, source_sha, source_tree), stage, timeout_seconds,
  queue_seconds and config/verifier/runner/workflow_sha256. Event identity is
  (event_id, repository_id, SHA), not SHA alone. Explicit retries use new events.
* approve_source: attempt_id, approval(plan_sha256, review_sha256, expires_at).
* reserve: attempt_id, admission(approval_sha256, inventory_sha256, expires_at,
  projected_gross_microusd, credit_verified=True, inventory_complete=True).
* submit_intent: attempt_id, source(bucket, object, generation, archive_sha256),
  nonce (UUID), request_sha256. Persist source generation before the only POST.
* bind: attempt_id, build_id (native UUID), source, config_sha256,
  native_evidence_sha256. The source must equal the persisted intent exactly.
* unknown: attempt_id, reason, evidence_sha256; keeps reservation and global lock.
* running: attempt_id, build_id.
* terminal: attempt_id, observation(build_id, status, started_at, finished_at,
  execution_not_started, evidence_sha256). This never releases a reservation.
* reconcile: attempt_id, evidence_sha256, native_verified=True. Accounts the
  stored terminal interval, regardless of failure/success, then releases lock.
* account_external: observation, native_verified=True. Imports already-terminal
  bootstrap/unmanaged builds into the same budget, deduplicated by native UUID.
* block: reason, evidence_sha256. Closed admission is not automatically reopened.

Only one attempt may reserve globally. The fixed pool is 480 minutes per UTC
month, including every stage, bootstrap and failures. Unknown work retains its
full reservation in every touched month, also reserving a possible queue/run
crossing into the next month. Verified usage is conservatively rounded UP to a
minute per touched month. It is never refunded simply because a build failed.
An observed overrun is recorded, then blocks admission; it is not discarded.

GCS adapter contract: absent object is ('0', None); generations are decimal
strings. compare_and_swap('0', doc) means exclusive creation. A 412 raises
CASConflict; uncertain POST/readback raises CommitOutcomeUnknown. No CAS or
mutation retry is implemented here. The adapter must reject redirects/retries.
transact refuses an absent ledger. bootstrap_store is a separate, explicitly
authorized initialization operation, never called by an event or reconciler.
Deleting a ledger must not silently reset monthly usage or UNKNOWN reservations.
"""

from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
from typing import Protocol
import uuid

MONTHLY_LIMIT_SECONDS = 480 * 60
GROSS_CAP_MICROUSD = 100 * 1_000_000
STAGE_LIMITS = {'full': 5700, 'attestation': 120, 'package': 1800,
                'publisher': 900, 'toolchain': 5700, 'diagnostic': 5700}
LIVE_STATES = {'RESERVED', 'SUBMIT_INTENT', 'UNKNOWN', 'UUID_BOUND',
               'RUNNING', 'TERMINAL_UNRECONCILED'}
TERMINAL_STATUSES = {'SUCCESS', 'FAILURE', 'INTERNAL_ERROR', 'TIMEOUT',
                     'CANCELLED', 'EXPIRED'}


class AdmissionError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class CASConflict(AdmissionError):
    pass


class CommitOutcomeUnknown(AdmissionError):
    pass


class AdmissionStore(Protocol):
    def load(self) -> tuple[str, dict | None]: ...
    def compare_and_swap(self, expected_generation: str, document: dict) -> str: ...


@dataclass(frozen=True)
class Transition:
    document: dict
    changed: bool
    proposed_effect: str | None = None
    attempt_id: str | None = None


@dataclass(frozen=True)
class Transaction:
    generation: str
    document: dict
    changed: bool
    effect: dict | None = None
    attempt_id: str | None = None


def need(condition, code):
    if not condition:
        raise AdmissionError(code)


def exact(value, keys, code):
    need(type(value) is dict and set(value) == set(keys.split()), code)


def digest(value, code='DIGEST_REQUIRED', size=64):
    need(type(value) is str and re.fullmatch('[a-f0-9]{'+str(size)+'}', value), code)
    return value


def identifier(value, code='IDENTIFIER_REQUIRED'):
    need(type(value) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}', value), code)
    return value


def native_uuid(value):
    try:
        valid = type(value) is str and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        valid = False
    need(valid, 'UUID_REQUIRED')
    return value


def utc(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00')) if type(value) is str else value
        valid = type(parsed) is datetime and parsed.tzinfo is not None and parsed.utcoffset() == timedelta(0)
    except (TypeError, ValueError):
        valid = False
    need(valid, 'UTC_TIMESTAMP_REQUIRED')
    return parsed.astimezone(timezone.utc)


def stamp(value):
    return utc(value).isoformat().replace('+00:00', 'Z')


def timestamp(value):
    need(type(value) is str, 'UTC_TIMESTAMP_REQUIRED')
    return utc(value)


def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     allow_nan=False).encode()).hexdigest()


def event_key(identity):
    exact(identity, 'event_id repository_id source_sha source_tree', 'IDENTITY_FIELDS_INVALID')
    identifier(identity['event_id'], 'EVENT_ID_REQUIRED')
    need(type(identity['repository_id']) is int and identity['repository_id'] > 0, 'REPOSITORY_ID_REQUIRED')
    digest(identity['source_sha'], 'SOURCE_SHA_REQUIRED', 40)
    digest(identity['source_tree'], 'SOURCE_TREE_REQUIRED', 40)
    return canonical_hash([identity[k] for k in ('event_id', 'repository_id', 'source_sha')])


def validate_plan(plan):
    exact(plan, 'identity stage timeout_seconds queue_seconds config_sha256 verifier_sha256 runner_sha256 workflow_sha256',
          'PLAN_FIELDS_INVALID')
    event_key(plan['identity'])
    need(type(plan['stage']) is str and plan['stage'] in STAGE_LIMITS, 'STAGE_INVALID')
    timeout = plan['timeout_seconds']
    need(type(timeout) is int and 0 < timeout <= STAGE_LIMITS[plan['stage']], 'STAGE_TIMEOUT_INVALID')
    if plan['stage'] == 'full':
        need(timeout == 5700, 'FULL_BOUND_CHANGED')
    need(type(plan['queue_seconds']) is int and 0 <= plan['queue_seconds'] <= 14400, 'QUEUE_BOUND_INVALID')
    for key in ('config_sha256', 'verifier_sha256', 'runner_sha256', 'workflow_sha256'):
        digest(plan[key])


def new_ledger():
    return {'schema_version': 1, 'revision': 0, 'updated_at': None,
            'monthly_limit_seconds': MONTHLY_LIMIT_SECONDS, 'events': {},
            'attempts': {}, 'external_builds': {}, 'active_attempt': None, 'blocked': None}


def validate_ledger(doc):
    exact(doc, 'schema_version revision updated_at monthly_limit_seconds events attempts external_builds active_attempt blocked',
          'LEDGER_FIELDS_INVALID')
    need(type(doc['schema_version']) is int and doc['schema_version'] == 1
         and type(doc['monthly_limit_seconds']) is int and doc['monthly_limit_seconds'] == MONTHLY_LIMIT_SECONDS,
         'LEDGER_POLICY_CHANGED')
    need(type(doc['revision']) is int and doc['revision'] >= 0, 'LEDGER_REVISION_INVALID')
    for key in ('events', 'attempts', 'external_builds'):
        need(type(doc[key]) is dict, 'LEDGER_MAP_REQUIRED')
    if doc['updated_at'] is None:
        need(doc == new_ledger(), 'LEDGER_INITIAL_STATE_INVALID')
        return
    updated = timestamp(doc['updated_at'])
    if doc['blocked'] is not None:
        validate_reason(doc['blocked'])
    active = []
    build_ids = set(doc['external_builds'])
    nonces, sources = set(), set()
    for attempt_id, attempt in doc['attempts'].items():
        native_uuid(attempt_id)
        need(type(attempt) is dict, 'ATTEMPT_FIELDS_INVALID')
        state = attempt.get('state')
        need(type(state) is str and state in LIVE_STATES | {'DISCOVERED', 'SOURCE_APPROVED', 'RECONCILED'}, 'STATE_INVALID')
        fields = {'plan', 'state', 'discovered_at'}
        if state != 'DISCOVERED':
            fields |= {'approval'}
        if state not in {'DISCOVERED', 'SOURCE_APPROVED'}:
            fields |= {'reserved_at', 'admission'}
        if state not in {'DISCOVERED', 'SOURCE_APPROVED', 'RESERVED'}:
            fields |= {'intent', 'submitted_at'}
        if state == 'UNKNOWN':
            fields |= {'uncertainty'}
        if state in {'UUID_BOUND', 'RUNNING', 'TERMINAL_UNRECONCILED', 'RECONCILED'} or (
                state == 'UNKNOWN' and 'build_id' in attempt):
            fields |= {'build_id', 'bind_evidence_sha256'}
        if state in {'TERMINAL_UNRECONCILED', 'RECONCILED'}:
            fields |= {'terminal'}
        if state == 'RECONCILED':
            fields |= {'reconciliation_sha256', 'reconciled_at'}
        if state in {'UUID_BOUND', 'RUNNING', 'TERMINAL_UNRECONCILED', 'RECONCILED'} and 'uncertainty' in attempt:
            fields |= {'uncertainty'}
        need(set(attempt) == fields, 'ATTEMPT_FIELDS_INVALID')
        validate_plan(attempt['plan'])
        key = event_key(attempt['plan']['identity'])
        need(doc['events'].get(key) == attempt_id, 'EVENT_INDEX_MISMATCH')
        discovered = timestamp(attempt['discovered_at'])
        need(discovered <= updated, 'DURABLE_CHRONOLOGY_INVALID')
        if 'approval' in attempt:
            validate_approval(attempt['approval'], attempt['plan'], discovered)
        if 'reserved_at' in attempt:
            reserved = timestamp(attempt['reserved_at'])
            need(discovered <= reserved <= updated, 'DURABLE_CHRONOLOGY_INVALID')
            validate_approval(attempt['approval'], attempt['plan'], reserved)
            validate_admission(attempt['admission'], reserved, attempt['approval'])
        if 'intent' in attempt:
            submitted = timestamp(attempt['submitted_at'])
            need(reserved <= submitted <= updated, 'DURABLE_CHRONOLOGY_INVALID')
            validate_approval(attempt['approval'], attempt['plan'], submitted)
            validate_admission(attempt['admission'], submitted, attempt['approval'])
            exact(attempt['intent'], 'source nonce request_sha256', 'SUBMIT_INTENT_FIELDS_INVALID')
            intent = attempt['intent']
            validate_source(intent['source']); native_uuid(intent['nonce']); digest(intent['request_sha256'])
            locator = source_locator(intent['source'])
            need(intent['nonce'] not in nonces and locator not in sources, 'SUBMIT_SOURCE_OR_NONCE_REUSED')
            nonces.add(intent['nonce']); sources.add(locator)
        if 'uncertainty' in attempt:
            validate_reason(attempt['uncertainty'])
        if state in LIVE_STATES:
            active.append(attempt_id)
        if 'build_id' in attempt:
            native_uuid(attempt['build_id'])
            digest(attempt['bind_evidence_sha256'])
            need(attempt['build_id'] not in build_ids, 'DUPLICATE_NATIVE_BUILD')
            build_ids.add(attempt['build_id'])
        if 'terminal' in attempt:
            validate_observation(attempt['terminal'], updated)
            need(attempt['terminal']['build_id'] == attempt['build_id'], 'NATIVE_UUID_MISMATCH')
            need(timestamp(attempt['terminal']['finished_at']) >= submitted, 'NATIVE_INTERVAL_BEFORE_INTENT')
            if attempt['terminal']['started_at'] is not None:
                need(timestamp(attempt['terminal']['started_at']) >= submitted, 'NATIVE_INTERVAL_BEFORE_INTENT')
        if state == 'RECONCILED':
            digest(attempt['reconciliation_sha256'])
            need(timestamp(attempt['terminal']['finished_at']) <= timestamp(attempt['reconciled_at']) <= updated,
                 'DURABLE_CHRONOLOGY_INVALID')
    need(len(doc['events']) == len(doc['attempts']), 'EVENT_INDEX_MISMATCH')
    need(len(active) <= 1 and doc['active_attempt'] == (active[0] if active else None), 'GLOBAL_LOCK_INVALID')
    for build_id, record in doc['external_builds'].items():
        exact(record, 'observation', 'EXTERNAL_FIELDS_INVALID')
        validate_observation(record['observation'], updated)
        need(native_uuid(build_id) == record['observation']['build_id'], 'EXTERNAL_BUILD_ID_INVALID')


def months(start, finish):
    current = utc(start).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = utc(finish)
    need(end >= utc(start), 'INTERVAL_REVERSED')
    result = []
    while current <= end:
        need(len(result) < 240, 'INTERVAL_BOUND_EXCEEDED')
        following = (current.replace(day=28) + timedelta(days=4)).replace(day=1)
        result.append((current.strftime('%Y-%m'), current, following))
        current = following
    return result


def charges(observation):
    if observation['execution_not_started']:
        return {}
    start, finish = utc(observation['started_at']), utc(observation['finished_at'])
    result = {}
    for month, lower, upper in months(start, finish):
        delta = min(finish, upper) - max(start, lower)
        micros = delta // timedelta(microseconds=1)
        if micros > 0:
            result[month] = ((micros + 60_000_000 - 1) // 60_000_000) * 60
    # Even a sub-clock-resolution executed build retains a one-minute charge.
    if not result:
        result[start.strftime('%Y-%m')] = 60
    return result


def budget_usage(document, *, now):
    validate_ledger(document)
    moment = utc(now)
    if document['updated_at'] is not None:
        need(moment >= timestamp(document['updated_at']), 'CLOCK_MOVED_BACKWARD')
    totals = {}
    def add(month, field, seconds):
        row = totals.setdefault(month, {'confirmed_seconds': 0, 'reserved_seconds': 0})
        row[field] += seconds
    for attempt in document['attempts'].values():
        if attempt['state'] == 'RECONCILED':
            for month, seconds in charges(attempt['terminal']).items():
                add(month, 'confirmed_seconds', seconds)
        elif attempt['state'] in LIVE_STATES:
            plan = attempt['plan']
            end = moment + timedelta(seconds=plan['timeout_seconds'] + plan['queue_seconds'])
            for month, _, _ in months(attempt['reserved_at'], end):
                add(month, 'reserved_seconds', plan['timeout_seconds'])
    for record in document['external_builds'].values():
        for month, seconds in charges(record['observation']).items():
            add(month, 'confirmed_seconds', seconds)
    return {month: {**row, 'total_seconds': sum(row.values())}
            for month, row in sorted(totals.items())}


def validate_approval(approval, plan, now):
    exact(approval, 'plan_sha256 review_sha256 expires_at', 'SOURCE_APPROVAL_FIELDS_INVALID')
    need(digest(approval['plan_sha256']) == canonical_hash(plan), 'APPROVAL_PLAN_MISMATCH')
    digest(approval['review_sha256'])
    need(timestamp(approval['expires_at']) > now, 'SOURCE_APPROVAL_EXPIRED')


def validate_admission(admission, now, approval):
    exact(admission, 'approval_sha256 inventory_sha256 expires_at projected_gross_microusd credit_verified inventory_complete',
          'ECONOMIC_ADMISSION_FIELDS_INVALID')
    digest(admission['approval_sha256']); digest(admission['inventory_sha256'])
    need(admission['approval_sha256'] == canonical_hash(approval), 'ECONOMIC_APPROVAL_MISMATCH')
    amount = admission['projected_gross_microusd']
    need(type(amount) is int and 0 <= amount <= GROSS_CAP_MICROUSD, 'GROSS_CAP_EXCEEDED')
    need(admission['credit_verified'] is True and admission['inventory_complete'] is True, 'CREDIT_AND_INVENTORY_REQUIRED')
    need(timestamp(admission['expires_at']) > now, 'ECONOMIC_ADMISSION_EXPIRED')


def validate_reason(value):
    exact(value, 'reason evidence_sha256', 'REASON_FIELDS_INVALID')
    identifier(value['reason']); digest(value['evidence_sha256'])


def source_locator(source):
    return tuple(source[key] for key in ('bucket', 'object', 'generation'))


def validate_source(source):
    exact(source, 'bucket object generation archive_sha256', 'SOURCE_FIELDS_INVALID')
    need(type(source['bucket']) is str and re.fullmatch(r'[a-z0-9][a-z0-9._-]{1,220}', source['bucket']), 'SOURCE_BUCKET_INVALID')
    obj = source['object']
    need(type(obj) is str and re.fullmatch(r'[A-Za-z0-9_./-]+', obj)
         and not obj.startswith('/') and '..' not in obj.split('/')
         and obj.endswith(('.tgz', '.tar.gz')), 'SOURCE_OBJECT_INVALID')
    need(type(source['generation']) is str and re.fullmatch(r'[1-9][0-9]*', source['generation']), 'SOURCE_GENERATION_REQUIRED')
    digest(source['archive_sha256'])


def validate_observation(value, now):
    exact(value, 'build_id status started_at finished_at execution_not_started evidence_sha256', 'OBSERVATION_FIELDS_INVALID')
    native_uuid(value['build_id']); digest(value['evidence_sha256'])
    need(type(value['status']) is str and value['status'] in TERMINAL_STATUSES, 'NATIVE_TERMINAL_REQUIRED')
    finish = timestamp(value['finished_at'])
    need(finish <= now, 'FUTURE_NATIVE_FINISH')
    need(type(value['execution_not_started']) is bool, 'EXECUTION_STATE_REQUIRED')
    if value['execution_not_started']:
        need(value['started_at'] is None and value['status'] in {'EXPIRED', 'CANCELLED', 'FAILURE'}, 'ZERO_USAGE_NOT_PROVEN')
    else:
        need(timestamp(value['started_at']) <= finish, 'INTERVAL_REVERSED')


def transition(document, command, *, now):
    """Return a proposal. Never execute proposed_effect before a confirmed CAS."""
    validate_ledger(document)
    moment = utc(now)
    if document['updated_at']:
        need(moment >= utc(document['updated_at']), 'CLOCK_MOVED_BACKWARD')
    need(type(command) is dict and type(command.get('op')) is str, 'COMMAND_REQUIRED')
    op = command['op']
    fields = {
        'discover': 'op attempt_id plan', 'approve_source': 'op attempt_id approval',
        'reserve': 'op attempt_id admission',
        'submit_intent': 'op attempt_id source nonce request_sha256',
        'bind': 'op attempt_id build_id source config_sha256 native_evidence_sha256',
        'unknown': 'op attempt_id reason evidence_sha256', 'running': 'op attempt_id build_id',
        'terminal': 'op attempt_id observation',
        'reconcile': 'op attempt_id evidence_sha256 native_verified',
        'account_external': 'op observation native_verified', 'block': 'op reason evidence_sha256',
    }
    need(op in fields, 'COMMAND_UNKNOWN')
    exact(command, fields[op], 'COMMAND_FIELDS_INVALID')
    doc = deepcopy(document)
    doc['updated_at'] = stamp(moment)
    attempt_id = command.get('attempt_id')
    effect = None
    def replay():
        return Transition(deepcopy(document), False, attempt_id=attempt_id)
    if op == 'discover':
        validate_plan(command['plan']); native_uuid(attempt_id)
        key = event_key(command['plan']['identity'])
        existing = doc['events'].get(key)
        if existing:
            need(doc['attempts'][existing]['plan'] == command['plan'], 'EVENT_CONTENT_CHANGED')
            attempt_id = existing
            return replay()
        need(attempt_id not in doc['attempts'], 'ATTEMPT_ID_REUSED')
        doc['events'][key] = attempt_id
        doc['attempts'][attempt_id] = {'plan': deepcopy(command['plan']), 'state': 'DISCOVERED',
                                      'discovered_at': stamp(moment)}
    elif op == 'block':
        identifier(command['reason']); digest(command['evidence_sha256'])
        value = {'reason': command['reason'], 'evidence_sha256': command['evidence_sha256']}
        if doc['blocked'] == value:
            return replay()
        need(doc['blocked'] is None, 'ALREADY_BLOCKED')
        doc['blocked'] = value
    elif op == 'account_external':
        need(command['native_verified'] is True, 'NATIVE_VERIFICATION_REQUIRED')
        value = command['observation']; validate_observation(value, moment)
        build_id = value['build_id']
        need(not any(a.get('build_id') == build_id for a in doc['attempts'].values()), 'DUPLICATE_NATIVE_BUILD')
        if build_id in doc['external_builds']:
            need(doc['external_builds'][build_id]['observation'] == value, 'EXTERNAL_OBSERVATION_CHANGED')
            return replay()
        doc['external_builds'][build_id] = {'observation': deepcopy(value)}
    else:
        native_uuid(attempt_id)
        need(attempt_id in doc['attempts'], 'ATTEMPT_NOT_DISCOVERED')
        attempt = doc['attempts'][attempt_id]
        state = attempt['state']
        if op == 'approve_source':
            validate_approval(command['approval'], attempt['plan'], moment)
            if attempt.get('approval') == command['approval']:
                return replay()
            need(state == 'DISCOVERED', 'SOURCE_APPROVAL_OUT_OF_ORDER')
            attempt.update(approval=deepcopy(command['approval']), state='SOURCE_APPROVED')
        elif op == 'reserve':
            if 'reserved_at' in attempt:
                need(attempt['admission'] == command['admission'], 'RESERVATION_CHANGED')
                return replay()
            need(doc['blocked'] is None, 'ADMISSION_BLOCKED')
            need(state == 'SOURCE_APPROVED', 'SOURCE_NOT_APPROVED')
            need(doc['active_attempt'] is None, 'GLOBAL_RESERVATION_OCCUPIED')
            validate_approval(attempt['approval'], attempt['plan'], moment)
            validate_admission(command['admission'], moment, attempt['approval'])
            attempt.update(state='RESERVED', reserved_at=stamp(moment), admission=deepcopy(command['admission']))
            doc['active_attempt'] = attempt_id
            need(all(row['total_seconds'] <= MONTHLY_LIMIT_SECONDS for row in budget_usage(doc, now=moment).values()),
                 'MONTHLY_POOL_EXCEEDED')
        elif op == 'submit_intent':
            validate_source(command['source']); native_uuid(command['nonce']); digest(command['request_sha256'])
            intent = {k: deepcopy(command[k]) for k in ('source', 'nonce', 'request_sha256')}
            if 'intent' in attempt:
                need(attempt['intent'] == intent, 'SUBMIT_INTENT_CHANGED')
                return replay()
            need(state == 'RESERVED' and doc['active_attempt'] == attempt_id, 'RESERVATION_REQUIRED')
            need(doc['blocked'] is None, 'ADMISSION_BLOCKED')
            validate_approval(attempt['approval'], attempt['plan'], moment)
            validate_admission(attempt['admission'], moment, attempt['approval'])
            need(all(row['total_seconds'] <= MONTHLY_LIMIT_SECONDS for row in budget_usage(doc, now=moment).values()),
                 'MONTHLY_POOL_EXCEEDED')
            for other in doc['attempts'].values():
                if 'intent' in other:
                    need(other['intent']['nonce'] != intent['nonce']
                         and source_locator(other['intent']['source']) != source_locator(intent['source']),
                         'SUBMIT_SOURCE_OR_NONCE_REUSED')
            attempt.update(state='SUBMIT_INTENT', intent=intent, submitted_at=stamp(moment))
            effect = 'CREATE_ONCE'
        elif op == 'bind':
            native_uuid(command['build_id']); validate_source(command['source']); digest(command['native_evidence_sha256'])
            need('intent' in attempt and command['source'] == attempt['intent']['source'], 'NATIVE_SOURCE_MISMATCH')
            need(command['config_sha256'] == attempt['plan']['config_sha256'], 'NATIVE_CONFIG_MISMATCH')
            if attempt.get('build_id'):
                need(attempt['build_id'] == command['build_id'], 'NATIVE_UUID_CHANGED')
                return replay()
            need(state in {'SUBMIT_INTENT', 'UNKNOWN'}, 'BIND_OUT_OF_ORDER')
            need(command['build_id'] not in doc['external_builds'] and not any(
                a.get('build_id') == command['build_id'] for a in doc['attempts'].values()), 'DUPLICATE_NATIVE_BUILD')
            attempt.update(build_id=command['build_id'], state='UUID_BOUND', bind_evidence_sha256=command['native_evidence_sha256'])
        elif op == 'unknown':
            identifier(command['reason']); digest(command['evidence_sha256'])
            need(state in {'SUBMIT_INTENT', 'UNKNOWN', 'UUID_BOUND', 'RUNNING'}, 'UNKNOWN_OUT_OF_ORDER')
            value = {'reason': command['reason'], 'evidence_sha256': command['evidence_sha256']}
            if state == 'UNKNOWN' and attempt.get('uncertainty') == value:
                return replay()
            attempt.update(state='UNKNOWN', uncertainty=value)
        elif op == 'running':
            need(attempt.get('build_id') == native_uuid(command['build_id']), 'NATIVE_UUID_MISMATCH')
            if state in {'RUNNING', 'TERMINAL_UNRECONCILED', 'RECONCILED'}:
                return replay()
            need(state in {'UUID_BOUND', 'UNKNOWN'}, 'RUNNING_OUT_OF_ORDER')
            attempt['state'] = 'RUNNING'
        elif op == 'terminal':
            value = command['observation']; validate_observation(value, moment)
            need(attempt.get('build_id') == value['build_id'], 'NATIVE_UUID_MISMATCH')
            if 'terminal' in attempt:
                need(attempt['terminal'] == value, 'TERMINAL_OBSERVATION_CHANGED')
                return replay()
            need(state in {'UUID_BOUND', 'RUNNING', 'UNKNOWN'}, 'TERMINAL_OUT_OF_ORDER')
            need(utc(value['finished_at']) >= utc(attempt['submitted_at']), 'NATIVE_INTERVAL_BEFORE_INTENT')
            if value['started_at'] is not None:
                need(utc(value['started_at']) >= utc(attempt['submitted_at']), 'NATIVE_INTERVAL_BEFORE_INTENT')
            attempt.update(state='TERMINAL_UNRECONCILED', terminal=deepcopy(value))
        elif op == 'reconcile':
            need(command['native_verified'] is True, 'NATIVE_VERIFICATION_REQUIRED')
            digest(command['evidence_sha256'])
            if state == 'RECONCILED':
                need(attempt['reconciliation_sha256'] == command['evidence_sha256'], 'RECONCILIATION_CHANGED')
                return replay()
            need(state == 'TERMINAL_UNRECONCILED' and doc['active_attempt'] == attempt_id, 'NATIVE_TERMINAL_REQUIRED')
            attempt.update(state='RECONCILED', reconciliation_sha256=command['evidence_sha256'], reconciled_at=stamp(moment))
            doc['active_attempt'] = None
            if sum(charges(attempt['terminal']).values()) > attempt['plan']['timeout_seconds']:
                doc['blocked'] = {'reason': 'OBSERVED_USAGE_EXCEEDS_RESERVATION', 'evidence_sha256': command['evidence_sha256']}
    if op in {'reconcile', 'account_external'}:
        if any(row['total_seconds'] > MONTHLY_LIMIT_SECONDS for row in budget_usage(doc, now=moment).values()):
            doc['blocked'] = {'reason': 'OBSERVED_MONTHLY_POOL_EXCEEDED',
                              'evidence_sha256': command.get('evidence_sha256', command.get('observation', {}).get('evidence_sha256'))}
    doc['revision'] += 1
    doc['updated_at'] = stamp(moment)
    validate_ledger(doc)
    return Transition(doc, True, effect, attempt_id)


def transact(store: AdmissionStore, command, *, now):
    """One load and at most one confirmed CAS; no implicit retries or I/O effects."""
    generation, document = store.load()
    need(type(generation) is str and re.fullmatch(r'0|[1-9][0-9]*', generation), 'STORE_GENERATION_INVALID')
    need((document is None) == (generation == '0'), 'STORE_ABSENCE_INCONSISTENT')
    need(document is not None, 'LEDGER_MISSING_NO_RESET')
    proposal = transition(document, command, now=now)
    if not proposal.changed:
        return Transaction(generation, proposal.document, False, attempt_id=proposal.attempt_id)
    committed = store.compare_and_swap(generation, deepcopy(proposal.document))
    if not (type(committed) is str and re.fullmatch(r'[1-9][0-9]*', committed) and committed != generation):
        raise CommitOutcomeUnknown('CAS_CONFIRMATION_INVALID_NO_EFFECT')
    effect = ({'type': proposal.proposed_effect, 'attempt_id': proposal.attempt_id,
               'fencing_generation': committed} if proposal.proposed_effect else None)
    return Transaction(committed, proposal.document, True, effect, proposal.attempt_id)


def bootstrap_store(store: AdmissionStore, initial_document):
    """Explicit operator bootstrap, never called by normal admission automation.

    The operator must establish no previous ledger was deleted and import every
    prior native build/reservation into initial_document. This function cannot
    prove that inventory or authorize a reset. It only creates if still absent.
    """
    validate_ledger(initial_document)
    generation, document = store.load()
    need(generation == '0' and document is None, 'BOOTSTRAP_REQUIRES_ABSENT_STORE')
    committed = store.compare_and_swap('0', deepcopy(initial_document))
    if not (type(committed) is str and re.fullmatch(r'[1-9][0-9]*', committed)):
        raise CommitOutcomeUnknown('CAS_CONFIRMATION_INVALID_NO_EFFECT')
    return Transaction(committed, deepcopy(initial_document), True)
