from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudbuild_admission as ledger
import cloudbuild_meter_source_resume as recovery
import cloudbuild_source_resume as source
import cloudbuild_runtime_meter as meter

ATTEMPT = source.ATTEMPT
REQUEST = '1611c80d-ed62-43df-b510-1d6a234d952d'
PRIOR = '11111111-1111-4111-8111-111111111111'
ABORTED = '22222222-2222-4222-8222-222222222222'
NOW = datetime(2026, 10, 11, 21, 5, tzinfo=timezone.utc)


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def fixture(start=NOW):
    plan = {'identity': {'event_id': 'synthetic-event', 'repository_id': source.REPOSITORY_ID,
            'source_sha': source.SOURCE_SHA, 'source_tree': 'b' * 40},
        'stage': 'full', 'timeout_seconds': 5700, 'queue_seconds': 600,
        'config_sha256': 'c' * 64, 'verifier_sha256': 'd' * 64,
        'runner_sha256': 'e' * 64, 'workflow_sha256': 'f' * 64}
    approval = {'plan_sha256': ledger.canonical_hash(plan), 'review_sha256': '5' * 64,
                'expires_at': ledger.stamp(start + timedelta(hours=3))}
    admission = {'approval_sha256': ledger.canonical_hash(approval),
        'inventory_sha256': '2' * 64, 'expires_at': approval['expires_at'],
        'projected_gross_microusd': 99805223, 'credit_verified': True, 'inventory_complete': True}
    old = ledger.new_ledger()
    native = {'build_id': PRIOR, 'status': 'SUCCESS',
        'started_at': ledger.stamp(start - timedelta(hours=2)),
        'finished_at': ledger.stamp(start - timedelta(hours=2) + timedelta(seconds=4440)),
        'execution_not_started': False, 'evidence_sha256': '9' * 64}
    old = ledger.transition(old, {'op': 'account_external', 'observation': native,
                             'native_verified': True}, now=start).document
    historical_plan = deepcopy(plan); historical_plan['identity']['event_id'] = 'historical-aborted-event'
    historical_approval = dict(approval, plan_sha256=ledger.canonical_hash(historical_plan))
    historical_admission = dict(admission, approval_sha256=ledger.canonical_hash(historical_approval))
    for command in [{'op': 'discover', 'plan': historical_plan}, {'op': 'approve_source', 'approval': historical_approval},
                    {'op': 'reserve', 'admission': historical_admission},
                    {'op': 'abort_before_dispatch', 'evidence_sha256': '7' * 64, 'native_verified': True}]:
        old = ledger.transition(old, {**command, 'attempt_id': ABORTED}, now=start).document
    for command in [{'op': 'discover', 'plan': plan}, {'op': 'approve_source', 'approval': approval},
                    {'op': 'reserve', 'admission': admission}]:
        old = ledger.transition(old, {**command, 'attempt_id': ATTEMPT}, now=start).document
    doc = meter.initial_document()
    history_start = start - timedelta(minutes=30)
    for index, ceiling in enumerate([450000, 450000, 450000, 5000, 5000, 5000, 5000, 5000]):
        key = f'55555555-5555-4555-8555-{index:012d}'
        doc['requests'][key] = {'started_at': ledger.stamp(history_start),
            'ceiling_ms': ceiling, 'months': meter.months(history_start, ceiling),
            'state': 'COMPLETED', 'result_sha256': '8' * 64}
    before_meter = encoded(doc)
    doc['active_request'] = REQUEST
    doc['requests'][REQUEST] = {'started_at': ledger.stamp(start), 'ceiling_ms': 450000,
        'months': meter.months(start, 450000), 'state': 'RESERVED', 'result_sha256': None}
    raw_meter, raw_ledger = encoded(doc), encoded(old)
    observed = start + timedelta(seconds=500)
    proof = {'schema_version': 1, 'kind': source.KIND, 'attempt_id': ATTEMPT, 'request_id': REQUEST,
        'plan_sha256': ledger.canonical_hash(plan), 'source_sha': source.SOURCE_SHA,
        'task_sha256': '1' * 64, 'service_uid': '66666666-6666-4666-8666-666666666666',
        'revision': 'commerce-v7-controller-core-00002-857', 'image_digest': source.CONTROLLER_IMAGE,
        'ledger_generation': '10', 'ledger_sha256': recovery.sha(raw_ledger),
        'meter_generation': '20', 'meter_sha256': recovery.sha(raw_meter),
        'meter_before_sha256': recovery.sha(before_meter),
        'meter_request_started_at': ledger.stamp(start), 'meter_ceiling_ms': 450000,
        'source_journal_sha256': '3' * 64, 'source_journal_generation': '30',
        'source_approval_sha256': '6' * 64, 'source_object': 'full/' + ATTEMPT + '.tgz',
        'evidence_sha256': '4' * 64, 'observed_at': ledger.stamp(observed),
        'valid_until': ledger.stamp(observed + timedelta(seconds=120))}
    return dict(meter_raw=raw_meter, meter_generation='20', ledger_raw=raw_ledger,
        ledger_generation='10', proof=proof, now=observed + timedelta(seconds=1))


class SourceResumeMeterTests(unittest.TestCase):
    def test_only_state_result_and_exclusion_change_retaining1825s(self):
        args = fixture(); preserved = deepcopy(args); result = recovery.propose_recovery(**args)
        old = json.loads(args['meter_raw']); new = result['document']; receipt = result['receipt']
        self.assertEqual(meter.usage(new), meter.usage(old))
        self.assertEqual(meter.usage(new)['2026-10']['cpu_ms'], 1825000)
        self.assertIsNone(new['active_request'])
        expected = deepcopy(old); expected['active_request'] = None
        expected['requests'][REQUEST].update(state='COMPLETED', result_sha256=ledger.canonical_hash(receipt))
        self.assertEqual(new, expected); self.assertEqual(args, preserved)
        self.assertEqual(receipt['ledger_sha256'], recovery.sha(args['ledger_raw']))
        self.assertEqual(receipt['ledger_generation'], '10'); self.assertTrue(receipt['ledger_unchanged'])
        for field in ('ci_reservation_released', 'reservation_refunded', 'source_retry_authorized', 'build_success_claimed'):
            self.assertFalse(receipt[field])
        state = json.loads(args['ledger_raw'])
        self.assertEqual(state['active_attempt'], ATTEMPT); self.assertEqual(state['attempts'][ATTEMPT]['state'], 'RESERVED')
        self.assertEqual(state['attempts'][ABORTED]['state'], 'ABORTED_BEFORE_DISPATCH')
        self.assertEqual(state['attempts'][ABORTED]['abortion']['reserved_seconds'], 5700)
        self.assertEqual(ledger.budget_usage(state, now=args['now'])['2026-10']['confirmed_seconds'], 4440)
        self.assertEqual(ledger.budget_usage(state, now=args['now'])['2026-10']['reserved_seconds'], 5700)
        self.assertEqual(result['document_sha256'], recovery.sha(recovery.storage_encoded(new)))

    def test_both_generation_and_raw_originals_are_bound(self):
        for field, value in [('meter_generation', '21'), ('ledger_generation', '11'), ('meter_raw', b'{}'), ('ledger_raw', b'{}')]:
            args = fixture(); args[field] = value
            with self.subTest(field=field), self.assertRaises(ledger.AdmissionError): recovery.propose_recovery(**args)

    def test_equivalent_json_reserialization_is_not_native_original(self):
        args = fixture(); args['ledger_raw'] = json.dumps(json.loads(args['ledger_raw']), indent=2).encode()
        with self.assertRaisesRegex(ledger.AdmissionError, 'LEDGER_CHANGED'): recovery.propose_recovery(**args)

    def test_historical480_cannot_be_admitted(self):
        args = fixture(); old = json.loads(args['ledger_raw']); old['monthly_limit_seconds'] = 28800
        args['ledger_raw'] = encoded(old); args['proof']['ledger_sha256'] = recovery.sha(args['ledger_raw'])
        with self.assertRaisesRegex(ledger.AdmissionError, 'OPERATING_POOL_REDUCTION_REQUIRED'): recovery.propose_recovery(**args)

    def test_aborted_ledger_is_not_a_source_resume(self):
        args = fixture(); state = json.loads(args['ledger_raw'])
        state = ledger.transition(state, {'op': 'abort_before_dispatch', 'attempt_id': ATTEMPT,
            'evidence_sha256': '7' * 64, 'native_verified': True}, now=args['now']).document
        args['ledger_raw'] = encoded(state); args['proof']['ledger_sha256'] = recovery.sha(args['ledger_raw'])
        with self.assertRaisesRegex(ledger.AdmissionError, 'RESERVATION_CHANGED'): recovery.propose_recovery(**args)

    def test_submit_intent_cannot_be_ignored_even_without_uuid(self):
        args = fixture(); state = json.loads(args['ledger_raw'])
        state = ledger.transition(state, {'op': 'submit_intent', 'attempt_id': ATTEMPT,
            'source': {'bucket': 'synthetic-source', 'object': 'full/source.tgz', 'generation': '99', 'archive_sha256': '8' * 64},
            'nonce': PRIOR, 'request_sha256': '7' * 64}, now=args['now']).document
        args['ledger_raw'] = encoded(state); args['proof']['ledger_sha256'] = recovery.sha(args['ledger_raw'])
        with self.assertRaisesRegex(ledger.AdmissionError, 'NOT_PRE_DISPATCH'): recovery.propose_recovery(**args)

    def test_only_exact_incident_plan_source_and_kind(self):
        for field, value in [('plan_sha256', '0' * 64), ('source_sha', '0' * 40), ('kind', 'SOURCE_FAILED_BEFORE_UPLOAD'), ('image_digest', '0' * 64)]:
            args = fixture(); args['proof'][field] = value
            with self.subTest(field=field), self.assertRaises(Exception): recovery.propose_recovery(**args)

    def test_receipt_expired_and_future_do_not_clear(self):
        for seconds in (-2, 120):
            args = fixture(); args['now'] += timedelta(seconds=seconds)
            with self.subTest(seconds=seconds), self.assertRaises(Exception): recovery.propose_recovery(**args)

    def test_full_window_and_extra30s_required(self):
        for seconds in (449, 450, 479, 480):
            args = fixture(); args['now'] = NOW + timedelta(seconds=seconds)
            args['proof']['observed_at'] = ledger.stamp(args['now'])
            args['proof']['valid_until'] = ledger.stamp(args['now'] + timedelta(seconds=120))
            with self.subTest(seconds=seconds), self.assertRaises(Exception): recovery.propose_recovery(**args)

    def test_completed_or_unknown_row_does_not_get_recovered_again(self):
        for state in ('UNKNOWN', 'COMPLETED'):
            args = fixture(); doc = json.loads(args['meter_raw']); doc['requests'][REQUEST].update(state=state, result_sha256='7' * 64)
            if state == 'COMPLETED': doc['active_request'] = None
            args['meter_raw'] = encoded(doc); args['proof']['meter_sha256'] = recovery.sha(args['meter_raw'])
            with self.subTest(state=state), self.assertRaises(ledger.AdmissionError): recovery.propose_recovery(**args)

    def test_wrong_started_at_and_request_are_rejected(self):
        for field, value in [('request_id', PRIOR), ('meter_request_started_at', ledger.stamp(NOW-timedelta(seconds=1)))]:
            args = fixture(); args['proof'][field] = value
            with self.subTest(field=field), self.assertRaises(ledger.AdmissionError): recovery.propose_recovery(**args)

    def test_month_crossing_conserves_entire_ceiling(self):
        args = fixture(datetime(2026, 10, 31, 23, 58, tzinfo=timezone.utc))
        result = recovery.propose_recovery(**args)
        self.assertEqual(meter.usage(result['document']), meter.usage(json.loads(args['meter_raw'])))
        self.assertEqual(meter.usage(result['document'])['2026-11']['cpu_ms'], 450000)

    def test_strict_meter_schema_and_closed_header(self):
        for field, value in [('schema_version', True), ('cpu_limit_ms', 9_000_000)]:
            args = fixture(); doc = json.loads(args['meter_raw']); doc[field] = value
            args['meter_raw'] = encoded(doc); args['proof']['meter_sha256'] = recovery.sha(args['meter_raw'])
            with self.subTest(field=field), self.assertRaises(ledger.AdmissionError): recovery.propose_recovery(**args)

    def test_original_parser_rejects_duplicates_nonfinite_and_bound(self):
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{}' * 1048576):
            with self.subTest(raw=raw[:20]), self.assertRaises(ledger.AdmissionError): recovery.original(raw)


if __name__ == '__main__': unittest.main()
