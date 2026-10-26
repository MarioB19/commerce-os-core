"""Conservative CAS admission for the trusted controller, never a billing cap.

Only a separately reviewed bootstrap creates the ledger. Reservations persist
after completion; unknown effects retain global exclusion until external review.
No callback, credential, URL or workflow is supplied by an HTTP request.
"""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import uuid

from cloudbuild_admission import AdmissionError, canonical_hash

# Companion to the FULL pool; existing reservations are never reset.
# Raised on 20-oct-2026 (owner-approved) after October reached 40,000 s, and on
# 26-oct-2026 (owner-approved) to 70,000 s after October reached 49,150 s.
CPU_LIMIT_MS = 70_000_000
MEMORY_LIMIT_MIB_MS = 140_000_000 * 1024
REQUEST_LIMIT = 2000
MEMORY_MIB = 2048
MAX_SECONDS = 450


def need(value, code):
    if not value:
        raise AdmissionError(code)


def utc(value):
    need(type(value) is str, 'METER_TIMESTAMP_INVALID')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise AdmissionError('METER_TIMESTAMP_INVALID') from None
    need(parsed.tzinfo is not None and parsed.utcoffset() == timedelta(0),
         'METER_TIMESTAMP_INVALID')
    return parsed


def identifier(value):
    try:
        parsed = uuid.UUID(value)
    except (ValueError, TypeError, AttributeError):
        raise AdmissionError('METER_REQUEST_ID_INVALID') from None
    need(str(parsed) == value and parsed.version == 4, 'METER_REQUEST_ID_INVALID')
    return value


def months(start, ceiling_ms):
    # Reserve the entire ceiling on both sides of a possible month boundary.
    finish = start + timedelta(milliseconds=ceiling_ms)
    return sorted({start.strftime('%Y-%m'), finish.strftime('%Y-%m')})


def initial_document():
    """For the explicit, separate bootstrap only; never called by RuntimeMeter."""
    return {'schema_version': 1, 'active_request': None, 'requests': {}}


def validate(document):
    need(type(document) is dict and set(document) ==
         {'schema_version', 'active_request', 'requests'} and
         document['schema_version'] == 1 and type(document['requests']) is dict,
         'METER_LEDGER_INVALID')
    active = document['active_request']
    if active is not None:
        identifier(active)
        need(active in document['requests'], 'METER_ACTIVE_MISSING')
    pending = []
    for key, row in document['requests'].items():
        identifier(key)
        need(type(row) is dict and set(row) ==
             {'started_at', 'ceiling_ms', 'months', 'state', 'result_sha256'},
             'METER_ENTRY_INVALID')
        start = utc(row['started_at'])
        need(type(row['ceiling_ms']) is int and 5000 <= row['ceiling_ms'] <= MAX_SECONDS * 1000
             and row['months'] == months(start, row['ceiling_ms']), 'METER_CEILING_INVALID')
        need(row['state'] in {'RESERVED', 'UNKNOWN', 'COMPLETED'}, 'METER_STATE_INVALID')
        if row['state'] != 'COMPLETED':
            pending.append(key)
        digest = row['result_sha256']
        need((row['state'] == 'RESERVED' and digest is None) or
             (row['state'] != 'RESERVED' and type(digest) is str and len(digest) == 64
              and all(c in '0123456789abcdef' for c in digest)), 'METER_RESULT_INVALID')
    need(pending == ([] if active is None else [active]), 'METER_EXCLUSION_INVALID')
    usage(document)
    return document


def usage(document):
    result = {}
    for row in document['requests'].values():
        for month in row['months']:
            totals = result.setdefault(month, {'requests': 0, 'cpu_ms': 0, 'memory_mib_ms': 0})
            totals['requests'] += 1
            totals['cpu_ms'] += row['ceiling_ms']
            totals['memory_mib_ms'] += row['ceiling_ms'] * MEMORY_MIB
    for totals in result.values():
        need(totals['requests'] <= REQUEST_LIMIT and totals['cpu_ms'] <= CPU_LIMIT_MS
             and totals['memory_mib_ms'] <= MEMORY_LIMIT_MIB_MS, 'METER_MONTHLY_CEILING')
    return result


class RuntimeMeter:
    def __init__(self, store, *, clock=lambda: datetime.now(timezone.utc)):
        self.store = store
        self.clock = clock

    def _load(self):
        generation, document = self.store.load()
        need(document is not None and generation != '0', 'METER_MISSING_NO_RESET')
        return generation, validate(document)

    def reserve(self, request_id, seconds=5):
        identifier(request_id)
        need(type(seconds) is int and 5 <= seconds <= MAX_SECONDS, 'METER_SECONDS_INVALID')
        generation, old = self._load()
        need(old['active_request'] is None, 'METER_PREVIOUS_REQUEST_UNRESOLVED')
        need(request_id not in old['requests'], 'METER_REQUEST_ALREADY_RESERVED')
        now = self.clock()
        need(now.tzinfo is not None and now.utcoffset() == timedelta(0), 'METER_CLOCK_INVALID')
        need(all(utc(row['started_at']) <= now for row in old['requests'].values()), 'METER_CLOCK_REVERSED')
        document = deepcopy(old)
        document['active_request'] = request_id
        document['requests'][request_id] = {'started_at': now.isoformat(), 'ceiling_ms': seconds * 1000,
            'months': months(now, seconds * 1000), 'state': 'RESERVED', 'result_sha256': None}
        validate(document)
        self.store.compare_and_swap(generation, document)
        return {'request_id': request_id, 'ceiling_ms': seconds * 1000, 'started_at': now.isoformat()}

    def extend(self, reservation, seconds):
        need(type(seconds) is int and 5 <= seconds <= MAX_SECONDS, 'METER_SECONDS_INVALID')
        generation, old, row = self._active(reservation)
        need(seconds * 1000 >= row['ceiling_ms'], 'METER_RESERVATION_CANNOT_SHRINK')
        if seconds * 1000 == row['ceiling_ms']:
            return reservation
        document = deepcopy(old)
        changed = document['requests'][reservation['request_id']]
        changed['ceiling_ms'] = seconds * 1000
        changed['months'] = months(utc(changed['started_at']), changed['ceiling_ms'])
        validate(document)
        self.store.compare_and_swap(generation, document)
        return dict(reservation, ceiling_ms=seconds * 1000)

    def _active(self, reservation):
        need(type(reservation) is dict and set(reservation) ==
             {'request_id', 'ceiling_ms', 'started_at'}, 'METER_RESERVATION_INVALID')
        identifier(reservation['request_id'])
        generation, document = self._load()
        need(document['active_request'] == reservation['request_id'], 'METER_EXCLUSION_LOST')
        row = document['requests'][reservation['request_id']]
        need(row['state'] == 'RESERVED' and row['ceiling_ms'] == reservation['ceiling_ms']
             and row['started_at'] == reservation['started_at'], 'METER_RESERVATION_CHANGED')
        start = utc(row['started_at'])
        need(start <= self.clock() <= start + timedelta(milliseconds=row['ceiling_ms']),
             'METER_REQUEST_WINDOW_EXPIRED')
        return generation, document, row

    def finish(self, reservation, result, *, unknown=False):
        generation, old, _ = self._active(reservation)
        need(type(result) is dict and type(unknown) is bool, 'METER_RESULT_REQUIRED')
        document = deepcopy(old)
        row = document['requests'][reservation['request_id']]
        row['state'] = 'UNKNOWN' if unknown else 'COMPLETED'
        row['result_sha256'] = canonical_hash(result)
        if not unknown:
            document['active_request'] = None
        validate(document)
        self.store.compare_and_swap(generation, document)
        return {'state': row['state'], 'reserved_cpu_ms': row['ceiling_ms'],
                'reservation_refunded': False}
