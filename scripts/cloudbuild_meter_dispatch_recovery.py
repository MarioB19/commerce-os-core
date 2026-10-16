"""Pure meter reconciliation for the identified uncertain DISPATCH request.

No I/O, CAS, ledger transition, refund, UUID binding or permission to dispatch.
Only a protected adapter authenticating native originals may call this module.
"""
from copy import deepcopy
from datetime import timedelta

import cloudbuild_admission as ledger
import cloudbuild_runtime_meter as meter
from cloudbuild_dispatch_recovery import validate_receipt
from cloudbuild_gcs_store import encode as storage_encoded
from cloudbuild_meter_recovery import original, generation, sha


def propose_recovery(meter_raw, *, meter_generation, ledger_raw,
                     ledger_generation, proof, now):
    """Complete only the reserved controller request, retaining all ceilings.

    ``proof`` must come from validate_evidence with protected native originals;
    its shape alone is not authentication. The reviewed single-CAS caller must
    revalidate the proof and both generations at its final effect fence.
    """
    moment = ledger.utc(now)
    validate_receipt(proof, now=moment)
    ledger.need(proof['kind'] == 'DISPATCH_REQUEST_ENDED_BUILD_IDENTIFIED',
                'DISPATCH_METER_CASE_INVALID')
    generation(meter_generation); generation(ledger_generation)
    ledger.need(meter_generation == proof['meter_generation']
                and sha(meter_raw) == proof['meter_sha256'], 'DISPATCH_METER_ORIGINAL_CHANGED')
    ledger.need(ledger_generation == proof['ledger_generation']
                and sha(ledger_raw) == proof['ledger_sha256'], 'DISPATCH_METER_LEDGER_CHANGED')
    state = original(ledger_raw); ledger.validate_ledger(state)
    attempt_id = proof['attempt_id']
    ledger.need(state['active_attempt'] == attempt_id and state['blocked'] is None,
                'DISPATCH_METER_RESERVATION_CHANGED')
    attempt = state['attempts'].get(attempt_id, {})
    ledger.need(attempt.get('state') == 'UNKNOWN' and 'intent' in attempt
                and 'build_id' not in attempt, 'DISPATCH_METER_UNKNOWN_INTENT_REQUIRED')
    plan = attempt['plan']
    ledger.need(plan['stage'] == 'full' and plan['timeout_seconds'] == 5700
                and ledger.canonical_hash(plan) == proof['plan_sha256']
                and plan['identity']['source_sha'] == proof['source_sha'],
                'DISPATCH_METER_PLAN_CHANGED')
    intent = attempt['intent']
    ledger.need(ledger.canonical_hash(intent) == proof['submit_intent_sha256']
                and intent['source']['object'] == proof['source_object'],
                'DISPATCH_METER_SUBMIT_INTENT_CHANGED')
    ledger.need(proof['build_id'] not in state['external_builds'] and not any(
        row.get('build_id') == proof['build_id'] for row in state['attempts'].values()),
        'DISPATCH_METER_BUILD_ALREADY_BOUND')
    old = meter.validate(original(meter_raw))
    ledger.need(type(old['schema_version']) is int, 'DISPATCH_METER_SCHEMA_CHANGED')
    request_id = proof['request_id']
    ledger.need(old['active_request'] == request_id and request_id in old['requests'],
                'DISPATCH_METER_ACTIVE_CHANGED')
    row = old['requests'][request_id]
    ledger.need(row['state'] == 'RESERVED' and row['result_sha256'] is None
                and row['started_at'] == proof['meter_request_started_at']
                and row['ceiling_ms'] == proof['meter_ceiling_ms'] == 450000,
                'DISPATCH_METER_RESERVATION_CHANGED')
    ledger.need(meter.utc(row['started_at']) + timedelta(seconds=480) < moment,
                'DISPATCH_METER_REQUEST_WINDOW_OPEN')
    ledger.need(all(meter.utc(item['started_at']) <= moment for item in old['requests'].values()),
                'DISPATCH_METER_CLOCK_REVERSED')
    receipt = {'schema_version': 1, 'kind': 'DISPATCH_METER_RECONCILED_WITHOUT_REFUND',
        'attempt_id': attempt_id, 'request_id': request_id,
        'dispatch_evidence_sha256': proof['evidence_sha256'],
        'dispatch_receipt_sha256': ledger.canonical_hash(proof),
        'build_id': proof['build_id'], 'build_sha256': proof['build_sha256'],
        'manifest_sha256': proof['manifest_sha256'],
        'submit_intent_sha256': proof['submit_intent_sha256'],
        'ledger_generation': ledger_generation, 'ledger_sha256': sha(ledger_raw),
        'meter_generation': meter_generation, 'meter_sha256': sha(meter_raw),
        'recovered_at': ledger.stamp(moment), 'reserved_cpu_ms': row['ceiling_ms'],
        'usage': meter.usage(old), 'ledger_unchanged': True,
        'ci_reservation_released': False, 'reservation_refunded': False,
        'dispatch_retry_authorized': False, 'build_success_claimed': False}
    document = deepcopy(old)
    document['requests'][request_id]['state'] = 'COMPLETED'
    document['requests'][request_id]['result_sha256'] = ledger.canonical_hash(receipt)
    document['active_request'] = None
    meter.validate(document)
    ledger.need(meter.usage(document) == meter.usage(old), 'DISPATCH_METER_USAGE_CHANGED')
    return {'expected_generation': meter_generation, 'expected_sha256': sha(meter_raw),
            'document': document, 'document_sha256': sha(storage_encoded(document)), 'receipt': receipt}
