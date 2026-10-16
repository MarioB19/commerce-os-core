"""Synthetic ledgers and receipts; no claim of native-original authentication."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudbuild_admission as ledger
import cloudbuild_meter_dispatch_recovery as recovery
import cloudbuild_dispatch_recovery as source
import cloudbuild_runtime_meter as meter

ATTEMPT = source.ATTEMPT
REQUEST = 'e266f560-d6ac-4def-adf8-9127d8512fdd'
BUILD = '33333333-3333-4333-8333-333333333333'
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
    submit = {'source': {'bucket': source.SOURCE_BUCKET, 'object': 'full/' + ATTEMPT + '.tgz',
        'generation': '99', 'archive_sha256': '8' * 64}, 'nonce': PRIOR, 'request_sha256': '7' * 64}
    old = ledger.transition(old, {'op': 'submit_intent', 'attempt_id': ATTEMPT, **submit}, now=start).document
    old = ledger.transition(old, {'op': 'unknown', 'attempt_id': ATTEMPT,
        'reason': 'CREATE_OR_BIND_OUTCOME_UNKNOWN', 'evidence_sha256': '6' * 64}, now=start).document
    doc = meter.initial_document()
    history_start = start - timedelta(minutes=30)
    for index, ceiling in enumerate([450000] * 7 + [5000] * 5):
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
        'build_id': BUILD, 'build_sha256': '3' * 64, 'manifest_sha256': '6' * 64,
        'submit_intent_sha256': ledger.canonical_hash(submit), 'source_object': 'full/' + ATTEMPT + '.tgz',
        'evidence_sha256': '4' * 64, 'observed_at': ledger.stamp(observed),
        'valid_until': ledger.stamp(observed + timedelta(seconds=120))}
    return dict(meter_raw=raw_meter, meter_generation='20', ledger_raw=raw_ledger,
        ledger_generation='10', proof=proof, now=observed + timedelta(seconds=1))


def change_document(args, key, mutate):
    document = json.loads(args[key + '_raw']); mutate(document)
    args[key + '_raw'] = encoded(document)
    args['proof'][key + '_sha256'] = recovery.sha(args[key + '_raw'])


class DispatchMeterRecoveryTests(unittest.TestCase):
    def test_only_three_meter_fields_change_retaining3625s_and95ci(self):
        args = fixture(); preserved = deepcopy(args)
        result = recovery.propose_recovery(**args); old = json.loads(args['meter_raw'])
        expected = deepcopy(old); expected['active_request'] = None
        expected['requests'][REQUEST].update(state='COMPLETED',
            result_sha256=ledger.canonical_hash(result['receipt']))
        self.assertEqual(result['document'], expected); self.assertEqual(args, preserved)
        self.assertEqual(meter.usage(expected), meter.usage(old))
        self.assertEqual(meter.usage(expected)['2026-10']['cpu_ms'], 3625000)
        self.assertEqual(meter.usage(expected)['2026-10']['requests'], 13)
        state = json.loads(args['ledger_raw'])
        self.assertEqual(state['attempts'][ATTEMPT]['state'], 'UNKNOWN')
        self.assertNotIn('build_id', state['attempts'][ATTEMPT])
        self.assertEqual(state['active_attempt'], ATTEMPT)
        self.assertEqual(state['attempts'][ABORTED]['abortion']['reserved_seconds'], 5700)
        self.assertEqual(ledger.budget_usage(state, now=args['now'])['2026-10'],
            {'confirmed_seconds': 4440, 'reserved_seconds': 5700, 'total_seconds': 10140})
        self.assertEqual(result['receipt']['ledger_sha256'], recovery.sha(args['ledger_raw']))
        self.assertTrue(result['receipt']['ledger_unchanged'])
        for flag in ('ci_reservation_released', 'reservation_refunded', 'dispatch_retry_authorized', 'build_success_claimed'):
            self.assertFalse(result['receipt'][flag])

    def test_output_hash_is_exact_gcs_wire_including_newline(self):
        result = recovery.propose_recovery(**fixture())
        self.assertEqual(result['document_sha256'], recovery.sha(recovery.storage_encoded(result['document'])))
        self.assertNotEqual(result['document_sha256'], recovery.sha(encoded(result['document'])))

    def test_generations_and_raw_originals_bound(self):
        for key, value in [('meter_generation','21'), ('ledger_generation','11'),
                           ('meter_raw',b'{}'), ('ledger_raw',b'{}')]:
            args = fixture(); args[key] = value
            with self.subTest(key=key), self.assertRaises(ledger.AdmissionError): recovery.propose_recovery(**args)

    def test_equivalent_reserialization_is_not_the_original(self):
        args = fixture(); args['ledger_raw'] = json.dumps(json.loads(args['ledger_raw']), indent=2).encode()
        with self.assertRaisesRegex(ledger.AdmissionError, 'LEDGER_CHANGED'): recovery.propose_recovery(**args)

    def test_historical480_not_operational(self):
        args = fixture(); change_document(args, 'ledger', lambda x:x.update(monthly_limit_seconds=28800))
        with self.assertRaisesRegex(ledger.AdmissionError, 'OPERATING_POOL_REDUCTION_REQUIRED'): recovery.propose_recovery(**args)

    def test_pre_submit_and_already_bound_states_rejected(self):
        for state in ('SUBMIT_INTENT', 'UUID_BOUND'):
            args = fixture()
            def change(x):
                row = x['attempts'][ATTEMPT]; row['state'] = state
                row.pop('uncertainty')
                if state == 'UUID_BOUND': row.update(build_id=BUILD, bind_evidence_sha256='5'*64)
            change_document(args, 'ledger', change)
            with self.subTest(state=state), self.assertRaisesRegex(ledger.AdmissionError, 'UNKNOWN_INTENT_REQUIRED'):
                recovery.propose_recovery(**args)

    def test_unknown_with_bound_uuid_not_eligible(self):
        args = fixture(); change_document(args, 'ledger', lambda x:x['attempts'][ATTEMPT].update(
            build_id=BUILD, bind_evidence_sha256='5'*64))
        with self.assertRaisesRegex(ledger.AdmissionError, 'UNKNOWN_INTENT_REQUIRED'): recovery.propose_recovery(**args)

    def test_changed_submit_nonce_source_or_request_hash_rejected(self):
        for key in ('nonce', 'source', 'request_sha256'):
            args = fixture()
            def change(x):
                intent = x['attempts'][ATTEMPT]['intent']
                if key == 'source': intent[key]['generation'] = '100'
                else: intent[key] = BUILD if key == 'nonce' else '0'*64
            change_document(args, 'ledger', change)
            with self.subTest(key=key), self.assertRaisesRegex(ledger.AdmissionError, 'SUBMIT_INTENT_CHANGED'):
                recovery.propose_recovery(**args)

    def test_another_attempt_source_kind_or_plan_cannot_recover(self):
        for key, value in [('attempt_id',PRIOR), ('source_sha','0'*40),
                           ('kind','SOURCE_RATE_LIMIT_BEFORE_ACQUISITION'), ('plan_sha256','0'*64)]:
            args = fixture(); args['proof'][key] = value
            with self.subTest(key=key), self.assertRaises(Exception): recovery.propose_recovery(**args)

    def test_full450_plus30_seconds_strictly_elapsed(self):
        for seconds in (449, 450, 479, 480):
            args = fixture(); args['now'] = NOW + timedelta(seconds=seconds)
            args['proof']['observed_at'] = ledger.stamp(args['now'])
            args['proof']['valid_until'] = ledger.stamp(args['now']+timedelta(seconds=120))
            with self.subTest(seconds=seconds), self.assertRaisesRegex(Exception, 'EXECUTION_WINDOW_OPEN'):
                recovery.propose_recovery(**args)

    def test_expired_or_future_proof_cannot_clear(self):
        for offset in (-2, 120):
            args = fixture(); args['now'] += timedelta(seconds=offset)
            with self.subTest(offset=offset), self.assertRaisesRegex(Exception, 'EVIDENCE_EXPIRED'):
                recovery.propose_recovery(**args)

    def test_completed_or_unknown_meter_cannot_replay(self):
        for state in ('UNKNOWN', 'COMPLETED'):
            args = fixture()
            def change(x):
                x['requests'][REQUEST].update(state=state, result_sha256='7'*64)
                if state == 'COMPLETED': x['active_request'] = None
            change_document(args, 'meter', change)
            with self.subTest(state=state), self.assertRaises(ledger.AdmissionError): recovery.propose_recovery(**args)

    def test_request_and_started_at_exact(self):
        for key, value in [('request_id',PRIOR), ('meter_request_started_at',ledger.stamp(NOW-timedelta(seconds=1)))]:
            args = fixture(); args['proof'][key] = value
            with self.subTest(key=key), self.assertRaises(ledger.AdmissionError): recovery.propose_recovery(**args)

    def test_schema_boolean_and_extra_quota_fields_rejected(self):
        for key, value in [('schema_version',True), ('cpu_limit_ms',9_000_000)]:
            args = fixture(); change_document(args, 'meter', lambda x:x.update({key:value}))
            with self.subTest(key=key), self.assertRaises(ledger.AdmissionError): recovery.propose_recovery(**args)

    def test_month_crossing_keeps_entire_reservation_both_months(self):
        args = fixture(datetime(2026,10,31,23,58,tzinfo=timezone.utc)); result = recovery.propose_recovery(**args)
        self.assertEqual(meter.usage(result['document']), meter.usage(json.loads(args['meter_raw'])))
        self.assertEqual(meter.usage(result['document'])['2026-11']['cpu_ms'], 450000)

    def test_pure_call_has_no_file_socket_or_process_effect(self):
        from unittest.mock import patch
        args = fixture()
        with patch('builtins.open', side_effect=AssertionError('file I/O')), \
             patch('socket.socket', side_effect=AssertionError('network I/O')), \
             patch('subprocess.Popen', side_effect=AssertionError('process I/O')):
            result = recovery.propose_recovery(**args)
        self.assertEqual(result['receipt']['build_id'], BUILD)

    def test_duplicate_json_keys_nonfinite_and_bound_rejected(self):
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{}'*1048576):
            with self.subTest(raw=raw[:20]), self.assertRaises(ledger.AdmissionError): recovery.original(raw)


if __name__ == '__main__': unittest.main()


