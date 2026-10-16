"""Pure meter reconciliation for a pre-acquisition SOURCE rate limit.

No I/O, CAS, refunds, ledger transition, or authorization to acquire source.
Only the protected adapter may authenticate raw originals and call this module.
"""
from copy import deepcopy
from datetime import timedelta

import cloudbuild_admission as ledger
import cloudbuild_runtime_meter as meter
from cloudbuild_gcs_store import encode as storage_encoded
from cloudbuild_meter_recovery import original, generation, sha
from cloudbuild_source_resume import validate_receipt


def propose_recovery(meter_raw, *, meter_generation, ledger_raw,
                     ledger_generation, proof, now):
    """Bind an immutable RESERVED ledger and retire only the active meter row.

    ``proof`` must originate in validate_evidence with protected native originals;
    its shape alone is not authentication. The caller must revalidate that proof
    and both native generations immediately before its one reviewed CAS.
    """
    moment = ledger.utc(now)
    validate_receipt(proof, now=moment)
    ledger.need(proof['kind'] == 'SOURCE_RATE_LIMIT_BEFORE_ACQUISITION', 'SOURCE_RESUME_CASE_INVALID')
    generation(meter_generation); generation(ledger_generation)
    ledger.need(meter_generation == proof['meter_generation'] and sha(meter_raw) == proof['meter_sha256'],
                'SOURCE_RESUME_METER_CHANGED')
    ledger.need(ledger_generation == proof['ledger_generation'] and sha(ledger_raw) == proof['ledger_sha256'],
                'SOURCE_RESUME_LEDGER_CHANGED')
    state = original(ledger_raw); ledger.validate_ledger(state)
    attempt_id = proof['attempt_id']
    ledger.need(state['active_attempt'] == attempt_id and state['blocked'] is None,
                'SOURCE_RESUME_RESERVATION_CHANGED')
    attempt = state['attempts'].get(attempt_id, {})
    ledger.need(attempt.get('state') == 'RESERVED' and 'intent' not in attempt and 'build_id' not in attempt,
                'SOURCE_RESUME_NOT_PRE_DISPATCH')
    plan = attempt['plan']
    ledger.need(plan['stage'] == 'full' and plan['timeout_seconds'] == 5700
                and ledger.canonical_hash(plan) == proof['plan_sha256']
                and plan['identity']['source_sha'] == proof['source_sha'], 'SOURCE_RESUME_PLAN_CHANGED')
    old = meter.validate(original(meter_raw))
    ledger.need(type(old['schema_version']) is int, 'SOURCE_RESUME_METER_SCHEMA_CHANGED')
    request_id = proof['request_id']
    ledger.need(old['active_request'] == request_id and request_id in old['requests'],
                'SOURCE_RESUME_METER_ACTIVE_CHANGED')
    row = old['requests'][request_id]
    ledger.need(row['state'] == 'RESERVED' and row['result_sha256'] is None
                and row['started_at'] == proof['meter_request_started_at']
                and row['ceiling_ms'] == proof['meter_ceiling_ms'] == 450000,
                'SOURCE_RESUME_METER_RESERVATION_CHANGED')
    start = meter.utc(row['started_at'])
    ledger.need(start + timedelta(seconds=480) <= moment, 'SOURCE_RESUME_REQUEST_WINDOW_OPEN')
    ledger.need(all(meter.utc(item['started_at']) <= moment for item in old['requests'].values()),
                'SOURCE_RESUME_METER_CLOCK_REVERSED')
    receipt = {'schema_version': 1, 'kind': 'SOURCE_RATE_LIMIT_METER_RECONCILED_WITHOUT_REFUND',
        'attempt_id': attempt_id, 'request_id': request_id,
        'source_evidence_sha256': proof['evidence_sha256'],
        'source_receipt_sha256': ledger.canonical_hash(proof),
        'source_journal_generation': proof['source_journal_generation'],
        'source_journal_sha256': proof['source_journal_sha256'],
        'source_approval_sha256': proof['source_approval_sha256'],
        'ledger_generation': ledger_generation, 'ledger_sha256': sha(ledger_raw),
        'meter_generation': meter_generation, 'meter_sha256': sha(meter_raw),
        'recovered_at': ledger.stamp(moment), 'reserved_cpu_ms': row['ceiling_ms'],
        'usage': meter.usage(old), 'ledger_unchanged': True, 'ci_reservation_released': False,
        'reservation_refunded': False, 'source_retry_authorized': False, 'build_success_claimed': False}
    document = deepcopy(old)
    document['requests'][request_id]['state'] = 'COMPLETED'
    document['requests'][request_id]['result_sha256'] = ledger.canonical_hash(receipt)
    document['active_request'] = None
    meter.validate(document)
    ledger.need(meter.usage(document) == meter.usage(old), 'SOURCE_RESUME_METER_USAGE_CHANGED')
    return {'expected_generation': meter_generation, 'expected_sha256': sha(meter_raw),
            'document': document, 'document_sha256': sha(storage_encoded(document)), 'receipt': receipt}
