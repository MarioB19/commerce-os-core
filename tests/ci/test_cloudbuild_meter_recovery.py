from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudbuild_admission as ledger
import cloudbuild_meter_recovery as recovery
import cloudbuild_runtime_meter as meter
from cloudbuild_full_evidence import EvidenceError

ATTEMPT = '11111111-1111-4111-8111-111111111111'
REQUEST = '22222222-2222-4222-8222-222222222222'
HISTORY = '33333333-3333-4333-8333-333333333333'
PRIOR = '44444444-4444-4444-8444-444444444444'
NOW = datetime(2026, 10, 11, 20, tzinfo=timezone.utc)


def fixture(start=NOW):
    plan = {'identity': {'event_id': 'synthetic-event', 'repository_id': 123,
            'source_sha': 'a' * 40, 'source_tree': 'b' * 40},
        'stage': 'full', 'timeout_seconds': 5700, 'queue_seconds': 600,
        'config_sha256': 'c' * 64, 'verifier_sha256': 'd' * 64,
        'runner_sha256': 'e' * 64, 'workflow_sha256': 'f' * 64}
    approval = {'plan_sha256': ledger.canonical_hash(plan), 'review_sha256': '5' * 64,
                'expires_at': ledger.stamp(start + timedelta(hours=4))}
    admission = {'approval_sha256': ledger.canonical_hash(approval),
        'inventory_sha256': '2' * 64, 'expires_at': approval['expires_at'],
        'projected_gross_microusd': 99000000, 'credit_verified': True, 'inventory_complete': True}
    old = ledger.new_ledger()
    native = {'build_id': PRIOR, 'status': 'SUCCESS',
        'started_at': ledger.stamp(start - timedelta(hours=2)),
        'finished_at': ledger.stamp(start - timedelta(hours=2) + timedelta(seconds=4440)),
        'execution_not_started': False, 'evidence_sha256': '9' * 64}
    old = ledger.transition(old, {'op': 'account_external', 'observation': native,
                             'native_verified': True}, now=start).document
    for command in [{'op': 'discover', 'plan': plan}, {'op': 'approve_source', 'approval': approval},
                    {'op': 'reserve', 'admission': admission}]:
        old = ledger.transition(old, {**command, 'attempt_id': ATTEMPT}, now=start).document
    # Fixture models the immutable pre-reduction incident, after constructing
    # its shape with the current pure state machine.
    old['monthly_limit_seconds'] = ledger.HISTORICAL_MONTHLY_LIMIT_SECONDS
    original_meter = meter.initial_document()
    # 470 seconds history + 450 seconds retained failed request = 920 seconds.
    history_start = start - timedelta(minutes=10)
    original_meter['requests'][HISTORY] = {'started_at': ledger.stamp(history_start),
        'ceiling_ms': 450000, 'months': meter.months(history_start, 450000),
        'state': 'COMPLETED', 'result_sha256': '8' * 64}
    for index in range(4):
        key = f'55555555-5555-4555-8555-{index:012d}'
        original_meter['requests'][key] = {'started_at': ledger.stamp(history_start),
            'ceiling_ms': 5000, 'months': meter.months(history_start, 5000),
            'state': 'COMPLETED', 'result_sha256': '8' * 64}
    before_meter = recovery.encoded(original_meter)
    original_meter['active_request'] = REQUEST
    original_meter['requests'][REQUEST] = {'started_at': ledger.stamp(start),
        'ceiling_ms': 450000, 'months': meter.months(start, 450000),
        'state': 'RESERVED', 'result_sha256': None}
    raw_meter = recovery.encoded(original_meter)
    observed = start + timedelta(seconds=500)
    proof = {'schema_version': 1, 'kind': 'SOURCE_FAILED_BEFORE_UPLOAD',
        'attempt_id': ATTEMPT, 'request_id': REQUEST,
        'plan_sha256': ledger.canonical_hash(plan), 'source_sha': 'a' * 40,
        'task_sha256': '1' * 64, 'service_uid': '66666666-6666-4666-8666-666666666666', 'revision': 'commerce-v7-controller-core-00001',
        'image_digest': '2' * 64,
        'ledger_generation': '10', 'ledger_sha256': recovery.sha(recovery.encoded(old)),
        'meter_generation': '20', 'meter_sha256': recovery.sha(raw_meter),
        'meter_before_sha256': recovery.sha(before_meter),
        'meter_request_started_at': ledger.stamp(start), 'meter_ceiling_ms': 450000,
        'source_journal_sha256': '3' * 64, 'source_object': 'full/' + ATTEMPT + '.tgz',
        'evidence_sha256': '4' * 64, 'observed_at': ledger.stamp(observed),
        'valid_until': ledger.stamp(observed + timedelta(seconds=120))}
    after = ledger.transition_historical_abort(old, {'op': 'abort_before_dispatch', 'attempt_id': ATTEMPT,
        'evidence_sha256': proof['evidence_sha256'], 'native_verified': True},
        now=observed + timedelta(seconds=1)).document
    return dict(meter_raw=raw_meter, meter_generation='20', ledger_before_raw=recovery.encoded(old),
        ledger_after_raw=recovery.encoded(after), ledger_after_generation='11', proof=proof,
        now=observed + timedelta(seconds=2))


class MeterRecoveryTests(unittest.TestCase):
    def test_preserves_all_consumption_and_history_and_inputs(self):
        inputs = fixture(); preserved = deepcopy(inputs)
        result = recovery.propose_recovery(**inputs)
        old = json.loads(inputs['meter_raw']); new = result['document']
        self.assertEqual(meter.usage(old), meter.usage(new))
        self.assertEqual(meter.usage(new)['2026-10']['cpu_ms'], 920000)
        self.assertIsNone(new['active_request'])
        for key, row in old['requests'].items():
            if key == REQUEST:
                for field in ('started_at', 'ceiling_ms', 'months'):
                    self.assertEqual(row[field], new['requests'][key][field])
            else:
                self.assertEqual(row, new['requests'][key])
        self.assertEqual(inputs, preserved)
        self.assertFalse(result['receipt']['reservation_refunded'])
        self.assertFalse(result['receipt']['source_retry_authorized'])
        self.assertFalse(result['receipt']['build_success_claimed'])
        self.assertEqual(result['document_sha256'], recovery.sha(recovery.storage_encoded(new)))
        self.assertTrue(recovery.storage_encoded(new).endswith(b'\n'))
        self.assertNotEqual(result['document_sha256'], ledger.canonical_hash(new))
        self.assertEqual(new['requests'][REQUEST]['result_sha256'],
                         ledger.canonical_hash(result['receipt']))

    def test_historical_pool_never_reenters_operational_admission(self):
        inputs = fixture()
        historical = json.loads(inputs['ledger_before_raw'])
        self.assertEqual(historical['monthly_limit_seconds'], 480 * 60)
        with self.assertRaisesRegex(ledger.AdmissionError, 'OPERATING_POOL_REDUCTION_REQUIRED'):
            ledger.validate_ledger(historical)
        with self.assertRaisesRegex(ledger.AdmissionError, 'HISTORICAL_ABORT_ONLY'):
            ledger.transition_historical_abort(historical, {'op': 'discover'}, now=inputs['now'])
        self.assertEqual(recovery.propose_recovery(**inputs)['receipt']['usage']['2026-10']['cpu_ms'], 920000)

    def test_month_crossing_retains_full_ceiling_in_both_months(self):
        inputs = fixture(datetime(2026, 10, 31, 23, 58, tzinfo=timezone.utc))
        old = meter.usage(json.loads(inputs['meter_raw']))
        new = meter.usage(recovery.propose_recovery(**inputs)['document'])
        self.assertEqual(old, new)
        self.assertEqual(new['2026-11']['cpu_ms'], 450000)

    def test_meter_generation_or_raw_bytes_changed(self):
        for change in ({'meter_generation': '21'}, {'meter_raw': b'{}'}):
            with self.subTest(change=change), self.assertRaisesRegex(ledger.AdmissionError, 'METER_CHANGED'):
                recovery.propose_recovery(**dict(fixture(), **change))

    def test_ledger_uncertain_or_unadvanced_does_not_clear_meter(self):
        inputs = fixture()
        for generation in ('10', '9', '0', True):
            with self.subTest(generation=generation), self.assertRaises(ledger.AdmissionError):
                recovery.propose_recovery(**dict(inputs, ledger_after_generation=generation))
        inputs['ledger_after_raw'] = inputs['ledger_before_raw']
        with self.assertRaisesRegex(ledger.AdmissionError, 'LEDGER_NOT_ABORTED'):
            recovery.propose_recovery(**inputs)

    def test_different_abort_evidence_is_rejected(self):
        inputs = fixture(); after = json.loads(inputs['ledger_after_raw'])
        after['attempts'][ATTEMPT]['abortion']['evidence_sha256'] = '0' * 64
        inputs['ledger_after_raw'] = recovery.encoded(after)
        with self.assertRaisesRegex(ledger.AdmissionError, 'ABORT_EVIDENCE_CHANGED'):
            recovery.propose_recovery(**inputs)

    def test_any_other_ledger_change_is_rejected(self):
        inputs = fixture(); after = json.loads(inputs['ledger_after_raw'])
        after['external_builds'][PRIOR]['observation']['evidence_sha256'] = '0' * 64
        inputs['ledger_after_raw'] = recovery.encoded(after)
        with self.assertRaisesRegex(ledger.AdmissionError, 'LEDGER_ABORT_CHANGED'):
            recovery.propose_recovery(**inputs)

    def test_before_raw_reserialization_requires_its_own_authenticated_pin(self):
        inputs = fixture()
        inputs['ledger_before_raw'] = json.dumps(json.loads(inputs['ledger_before_raw']), indent=2).encode()
        with self.assertRaisesRegex(ledger.AdmissionError, 'LEDGER_BEFORE_CHANGED'):
            recovery.propose_recovery(**inputs)

    def test_wrong_plan_or_source_is_rejected(self):
        for field, value in [('plan_sha256', '0' * 64), ('source_sha', '0' * 40)]:
            inputs = fixture(); inputs['proof'][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ledger.AdmissionError, 'PLAN_CHANGED'):
                recovery.propose_recovery(**inputs)

    def test_unknown_row_retains_ceiling_when_evidence_authenticates_it(self):
        inputs = fixture(); old = json.loads(inputs['meter_raw'])
        old['requests'][REQUEST].update(state='UNKNOWN', result_sha256='7' * 64)
        inputs['meter_raw'] = recovery.encoded(old)
        inputs['proof']['meter_sha256'] = recovery.sha(inputs['meter_raw'])
        result = recovery.propose_recovery(**inputs)
        self.assertEqual(meter.usage(old), meter.usage(result['document']))

    def test_wrong_request_or_started_at_is_rejected(self):
        for field, value in [('request_id', HISTORY), ('meter_request_started_at', ledger.stamp(NOW - timedelta(seconds=1)))]:
            inputs = fixture(); inputs['proof'][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ledger.AdmissionError, 'METER_(ACTIVE|RESERVATION)_CHANGED'):
                recovery.propose_recovery(**inputs)

    def test_expired_receipt_and_future_abort_are_rejected(self):
        inputs = fixture(); inputs['now'] += timedelta(seconds=121)
        with self.assertRaises((ledger.AdmissionError, EvidenceError)): recovery.propose_recovery(**inputs)
        inputs = fixture(); inputs['now'] -= timedelta(seconds=2)
        with self.assertRaisesRegex(ledger.AdmissionError, 'ABORT_CHRONOLOGY_INVALID'):
            recovery.propose_recovery(**inputs)

    def test_duplicate_nonfinite_and_oversized_originals(self):
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":Infinity}', b'{}' * (1024 * 1024)):
            with self.subTest(raw=raw[:20]), self.assertRaises(ledger.AdmissionError):
                recovery.original(raw)


if __name__ == '__main__':
    unittest.main()
