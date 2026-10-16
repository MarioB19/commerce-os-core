"""Protected, once-only continuation after the fixed pre-acquisition 429.

The pure producer cannot publish custody or authorize an HTTP caller. The runtime
loads its output only through generation-bound Root-managed task custody.
"""
import base64
from copy import deepcopy
import hashlib
from datetime import timedelta

import cloudbuild_admission as ledger
import cloudbuild_runtime_meter as meter
from cloudbuild_gcs_store import decode, encode
from cloudbuild_protected_storage import validate_descriptor
from cloudbuild_source_resume import ATTEMPT, SOURCE_SHA, validate_receipt
from cloudbuild_meter_source_resume import propose_recovery

KIND = 'SOURCE_RATE_LIMIT_CONTINUATION'
FIELDS = 'schema_version kind proof meter_receipt meter_before_raw ledger_raw meter_after expires_at'
MAX_ORIGINAL_BYTES = 1024 * 1024


def original(value):
    ledger.need(type(value) is str and len(value) <= 4*((MAX_ORIGINAL_BYTES+2)//3), 'SOURCE_CONTINUATION_ORIGINAL_BOUND')
    try: raw = base64.b64decode(value, validate=True)
    except (ValueError, TypeError): raise ledger.AdmissionError('SOURCE_CONTINUATION_ORIGINAL_INVALID') from None
    ledger.need(0 < len(raw) <= MAX_ORIGINAL_BYTES, 'SOURCE_CONTINUATION_ORIGINAL_BOUND')
    return raw


def descriptor_matches(descriptor, raw):
    validate_descriptor(descriptor)
    ledger.need(descriptor['sha256'] == hashlib.sha256(raw).hexdigest() and descriptor['size'] == len(raw)
        and descriptor['md5'] == base64.b64encode(hashlib.md5(raw).digest()).decode(), 'SOURCE_CONTINUATION_DESCRIPTOR_CHANGED')


def produce(proof, meter_before_raw, ledger_raw, meter_after, *, recovered_at, expires_at):
    """Compose a proposal after native meter reconciliation; no storage writes."""
    ledger.need(all(type(raw) is bytes and 0 < len(raw) <= MAX_ORIGINAL_BYTES
        for raw in (meter_before_raw, ledger_raw)), 'SOURCE_CONTINUATION_ORIGINAL_BOUND')
    moment = ledger.timestamp(recovered_at)
    proposed = propose_recovery(meter_before_raw, meter_generation=proof['meter_generation'],
        ledger_raw=ledger_raw, ledger_generation=proof['ledger_generation'], proof=proof, now=moment)
    descriptor_matches(meter_after, encode(proposed['document']))
    ledger.need(int(meter_after['generation']) > int(proof['meter_generation']), 'SOURCE_CONTINUATION_METER_GENERATION')
    end = ledger.timestamp(expires_at)
    ledger.need(moment < end <= moment + timedelta(hours=4), 'SOURCE_CONTINUATION_WINDOW_INVALID')
    return {'schema_version':1, 'kind':KIND, 'proof':deepcopy(proof), 'meter_receipt':proposed['receipt'],
        'meter_before_raw':base64.b64encode(meter_before_raw).decode(),
        'ledger_raw':base64.b64encode(ledger_raw).decode(), 'meter_after':deepcopy(meter_after), 'expires_at':expires_at}


def validate(document, *, now):
    ledger.exact(document, FIELDS, 'SOURCE_CONTINUATION_FIELDS')
    ledger.need(type(document['schema_version']) is int and document['schema_version'] == 1
        and document['kind'] == KIND, 'SOURCE_CONTINUATION_KIND')
    receipt = document['meter_receipt']; ledger.need(type(receipt) is dict, 'SOURCE_CONTINUATION_RECEIPT_REQUIRED')
    historical = ledger.timestamp(receipt.get('recovered_at'))
    # Historical freshness authenticates the recovery, never the new execution.
    validate_receipt(document['proof'], now=historical)
    expected = produce(document['proof'], original(document['meter_before_raw']), original(document['ledger_raw']),
        document['meter_after'], recovered_at=receipt['recovered_at'], expires_at=document['expires_at'])
    ledger.need(document == expected, 'SOURCE_CONTINUATION_DERIVATION_CHANGED')
    ledger.need(historical <= now < ledger.timestamp(document['expires_at']), 'SOURCE_CONTINUATION_EXPIRED')
    return propose_recovery(original(document['meter_before_raw']), meter_generation=document['proof']['meter_generation'],
        ledger_raw=original(document['ledger_raw']), ledger_generation=document['proof']['ledger_generation'],
        proof=document['proof'], now=historical)


def validate_current(document, *, ledger_generation, ledger_document, journal_generation,
                     journal_document, meter_generation, meter_document, source_approval, now):
    proposed = validate(document, now=now); proof = document['proof']
    ledger.validate_ledger(ledger_document)
    ledger.need(ledger_generation == proof['ledger_generation']
        and hashlib.sha256(encode(ledger_document)).hexdigest() == proof['ledger_sha256'], 'SOURCE_CONTINUATION_LEDGER_CHANGED')
    ledger.need(journal_generation == proof['source_journal_generation']
        and hashlib.sha256(encode(journal_document)).hexdigest() == proof['source_journal_sha256'], 'SOURCE_CONTINUATION_JOURNAL_CHANGED')
    action = 'source-acquire:'+ATTEMPT
    ledger.need(set(journal_document['actions']) == {action}
        and journal_document['actions'][action]['result'] is None and journal_document['actions'][action]['history'] == []
        and journal_document['actions'][action]['intent_sha256'] == ledger.canonical_hash(source_approval)
        == proof['source_approval_sha256'], 'SOURCE_CONTINUATION_ACQUISITION_CHANGED')
    meter.validate(meter_document)
    ledger.need(int(meter_generation) >= int(document['meter_after']['generation']), 'SOURCE_CONTINUATION_METER_REWOUND')
    recovered = proposed['document']
    ledger.need({k:v for k,v in recovered.items() if k not in ('active_request','requests')}
        == {k:v for k,v in meter_document.items() if k not in ('active_request','requests')}
        and all(meter_document['requests'].get(k) == row for k,row in recovered['requests'].items()),
        'SOURCE_CONTINUATION_METER_HISTORY_CHANGED')
    active = meter_document['active_request']; row = meter_document['requests'].get(active,{})
    ledger.need(active is not None and active not in recovered['requests'] and row.get('state') == 'RESERVED'
        and row.get('ceiling_ms') == 450000 and row.get('result_sha256') is None
        and meter.utc(row['started_at']) <= now < meter.utc(row['started_at'])+timedelta(seconds=450),
        'SOURCE_CONTINUATION_NEW_RESERVATION_REQUIRED')
    return {'attempt_id':ATTEMPT, 'source_sha':SOURCE_SHA,
        'proof_sha256':ledger.canonical_hash(proof), 'meter_receipt_sha256':ledger.canonical_hash(document['meter_receipt']),
        'source_approval_sha256':proof['source_approval_sha256'], 'source_journal_sha256':proof['source_journal_sha256']}


def resume_task(original_task, recovery_descriptor, *, custody, now):
    """Keep the exact admitted plan/event/source approval; attach only custody."""
    from cloudbuild_runtime import validate_task
    validate_task(original_task, lambda:now)
    ledger.need(original_task['operation'] == 'SOURCE' and original_task['phase'] == 'ACQUIRE'
        and original_task['attempt_id'] == ATTEMPT and original_task['plan']['identity']['source_sha'] == SOURCE_SHA,
        'SOURCE_CONTINUATION_TASK_CHANGED')
    ledger.exact(original_task['payload'], 'source_approval journal', 'SOURCE_CONTINUATION_SOURCE_PAYLOAD')
    validate_descriptor(recovery_descriptor)
    ledger.need(recovery_descriptor['bucket'] == custody['bucket'] and recovery_descriptor['object'] ==
        custody['prefix']+'/tasks/'+ATTEMPT+'/source-resume-recovery.json', 'SOURCE_CONTINUATION_TASK_CUSTODY')
    value = deepcopy(original_task); value['phase'] = 'RESUME'; value['payload']['recovery'] = deepcopy(recovery_descriptor)
    validate_task(value, lambda:now)
    return value
