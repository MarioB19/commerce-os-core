"""Pure, second-stage SOURCE recovery; no I/O, CAS, reset, or cost refund.

Call only from a protected recovery adapter after validate_evidence and native
metadata/media/current authentication. Receipt structure is not authentication.
The existing HTTP runtime deliberately does not import or expose this operation.
"""
from copy import deepcopy
from datetime import timedelta
import hashlib
import json
import re

import cloudbuild_admission as ledger
import cloudbuild_runtime_meter as meter
from cloudbuild_source_recovery import validate_receipt
from cloudbuild_gcs_store import encode as storage_encoded

MAX_ORIGINAL_BYTES = 1024 * 1024


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def original(raw):
    ledger.need(type(raw) is bytes and 0 < len(raw) <= MAX_ORIGINAL_BYTES,
                'RECOVERY_ORIGINAL_SIZE_INVALID')

    def pairs(items):
        result = {}
        for key, value in items:
            ledger.need(key not in result, 'RECOVERY_DUPLICATE_JSON_KEY')
            result[key] = value
        return result

    def nonfinite(_value):
        raise ledger.AdmissionError('RECOVERY_NONFINITE_JSON')

    try:
        result = json.loads(raw, object_pairs_hook=pairs, parse_constant=nonfinite)
    except (ValueError, UnicodeError, RecursionError):
        raise ledger.AdmissionError('RECOVERY_INVALID_JSON') from None
    ledger.need(type(result) is dict, 'RECOVERY_DOCUMENT_REQUIRED')
    return result


def generation(value):
    ledger.need(type(value) is str and re.fullmatch('[1-9][0-9]{0,29}', value),
                'RECOVERY_GENERATION_INVALID')
    return int(value)


def propose_recovery(meter_raw, *, meter_generation, ledger_before_raw,
                     ledger_after_raw, ledger_after_generation, proof, now):
    """Derive the only allowed meter change after authenticated ledger abort.

    The caller must obtain ``proof`` from validate_evidence using adopted native
    originals, and authenticate the readback origin/generation of ledger_after.
    Historical 480-minute originals use the closed historical-abort API; they
    never become operational admission under the current 420-minute limit.
    No write permission is returned: expected_generation only binds an external
    reviewed single-CAS adapter. All input documents are left unchanged.
    """
    moment = ledger.utc(now)
    validate_receipt(proof, now=moment)
    ledger.need(proof['kind'] == 'SOURCE_FAILED_BEFORE_UPLOAD', 'RECOVERY_CASE_INVALID')
    ledger.need(meter_generation == proof['meter_generation']
                and sha(meter_raw) == proof['meter_sha256'], 'RECOVERY_METER_CHANGED')
    generation(meter_generation)
    ledger.need(sha(ledger_before_raw) == proof['ledger_sha256'], 'RECOVERY_LEDGER_BEFORE_CHANGED')
    ledger.need(generation(ledger_after_generation) > generation(proof['ledger_generation']),
                'RECOVERY_LEDGER_ABORT_READBACK_REQUIRED')
    old = meter.validate(original(meter_raw))
    before, after = original(ledger_before_raw), original(ledger_after_raw)
    ledger.validate_historical_ledger(before)
    ledger.validate_historical_ledger(after)
    attempt_id = proof['attempt_id']
    attempt = after['attempts'].get(attempt_id, {})
    ledger.need(attempt.get('state') == 'ABORTED_BEFORE_DISPATCH', 'RECOVERY_LEDGER_NOT_ABORTED')
    abortion = attempt['abortion']
    aborted_at = ledger.timestamp(abortion['aborted_at'])
    ledger.need(ledger.timestamp(proof['observed_at']) <= aborted_at <= moment,
                'RECOVERY_ABORT_CHRONOLOGY_INVALID')
    ledger.need(abortion['evidence_sha256'] == proof['evidence_sha256'],
                'RECOVERY_ABORT_EVIDENCE_CHANGED')
    expected = ledger.transition_historical_abort(before, {'op': 'abort_before_dispatch',
        'attempt_id': attempt_id, 'evidence_sha256': proof['evidence_sha256'],
        'native_verified': True}, now=aborted_at).document
    ledger.need(after == expected, 'RECOVERY_LEDGER_ABORT_CHANGED')
    ledger.need(ledger.canonical_hash(attempt['plan']) == proof['plan_sha256']
                and attempt['plan']['identity']['source_sha'] == proof['source_sha'],
                'RECOVERY_PLAN_CHANGED')
    request_id = proof['request_id']
    ledger.need(old['active_request'] == request_id and request_id in old['requests'],
                'RECOVERY_METER_ACTIVE_CHANGED')
    row = old['requests'][request_id]
    ledger.need(row['state'] in {'RESERVED', 'UNKNOWN'}
                and row['started_at'] == proof['meter_request_started_at']
                and row['ceiling_ms'] == proof['meter_ceiling_ms'] == 450000,
                'RECOVERY_METER_RESERVATION_CHANGED')
    start = meter.utc(row['started_at'])
    ledger.need(start + timedelta(milliseconds=row['ceiling_ms']) <= moment,
                'RECOVERY_REQUEST_WINDOW_STILL_OPEN')
    ledger.need(all(meter.utc(item['started_at']) <= moment for item in old['requests'].values()),
                'RECOVERY_METER_CLOCK_REVERSED')
    receipt = {'schema_version': 1, 'kind': 'SOURCE_METER_RECOVERED_WITHOUT_REFUND',
        'attempt_id': attempt_id, 'request_id': request_id,
        'source_evidence_sha256': proof['evidence_sha256'],
        'source_receipt_sha256': ledger.canonical_hash(proof),
        'ledger_generation': ledger_after_generation, 'ledger_sha256': sha(ledger_after_raw),
        'meter_generation': meter_generation, 'meter_sha256': sha(meter_raw),
        'recovered_at': ledger.stamp(moment), 'reserved_cpu_ms': row['ceiling_ms'],
        'usage': meter.usage(old), 'reservation_refunded': False,
        'source_retry_authorized': False, 'build_success_claimed': False}
    document = deepcopy(old)
    document['requests'][request_id]['state'] = 'COMPLETED'
    document['requests'][request_id]['result_sha256'] = ledger.canonical_hash(receipt)
    document['active_request'] = None
    meter.validate(document)
    ledger.need(meter.usage(document) == meter.usage(old), 'RECOVERY_METER_USAGE_CHANGED')
    return {'expected_generation': meter_generation, 'expected_sha256': sha(meter_raw),
            'document': document, 'document_sha256': sha(storage_encoded(document)), 'receipt': receipt}
