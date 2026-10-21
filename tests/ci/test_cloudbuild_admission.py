import concurrent.futures
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import sys
import threading
import unittest
import uuid
import urllib.parse


SPEC = importlib.util.spec_from_file_location('cloudbuild_admission',
    Path(__file__).resolve().parents[2] / 'scripts/cloudbuild_admission.py')
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)
NOW = datetime(2026, 10, 10, 12, tzinfo=timezone.utc)
ATTEMPT = '11111111-1111-4111-8111-111111111111'
BUILD = '22222222-2222-4222-8222-222222222222'
NONCE = '33333333-3333-4333-8333-333333333333'


def plan(event='event-1', repo=123, sha='a'*40, stage='full'):
    return {'identity': {'event_id': event, 'repository_id': repo,
                         'source_sha': sha, 'source_tree': 'b'*40},
            'stage': stage, 'timeout_seconds': m.STAGE_LIMITS[stage], 'queue_seconds': 600,
            'config_sha256': 'c'*64, 'verifier_sha256': 'd'*64,
            'runner_sha256': 'e'*64, 'workflow_sha256': 'f'*64}


def approval(now=NOW, value=None):
    return {'plan_sha256': m.canonical_hash(value or plan()), 'review_sha256': '5'*64,
            'expires_at': m.stamp(now + timedelta(hours=4))}


def admission(now=NOW, value=None):
    return {'approval_sha256': m.canonical_hash(approval(now, value)), 'inventory_sha256': '2'*64,
            'expires_at': m.stamp(now + timedelta(hours=4)),
            'projected_gross_microusd': 99_000_000,
            'credit_verified': True, 'inventory_complete': True}


def source(generation='10', obj='source/unique-1.tgz'):
    return {'bucket': 'ci-source', 'object': obj, 'generation': generation,
            'archive_sha256': '3'*64}


def observation(status='SUCCESS', build=BUILD, start=NOW, seconds=61):
    return {'build_id': build, 'status': status, 'started_at': m.stamp(start),
            'finished_at': m.stamp(start + timedelta(seconds=seconds)),
            'execution_not_started': False, 'evidence_sha256': '4'*64}


def step(doc, op, now=NOW, attempt=ATTEMPT, **fields):
    command = {'op': op, **fields}
    if op not in {'account_external', 'block'}:
        command['attempt_id'] = attempt
    return m.transition(doc, command, now=now)


def approved(doc=None, now=NOW, attempt=ATTEMPT, value=None):
    value = value or plan()
    doc = step(m.new_ledger() if doc is None else doc, 'discover', now, attempt, plan=value).document
    return step(doc, 'approve_source', now, attempt, approval=approval(now, value)).document


def reserved(now=NOW):
    return step(approved(now=now), 'reserve', now, admission=admission(now)).document


def intent_command():
    return {'op': 'submit_intent', 'attempt_id': ATTEMPT, 'source': source(),
            'nonce': NONCE, 'request_sha256': '6'*64}


def bound(now=NOW):
    doc = m.transition(reserved(now), intent_command(), now=now).document
    return step(doc, 'bind', now, build_id=BUILD, source=source(),
                config_sha256='c'*64, native_evidence_sha256='7'*64).document


class MemoryStore:
    """Atomic fake storage, not a mocked transition/approval implementation."""
    def __init__(self, document=None):
        self.document = deepcopy(document)
        self.generation = '1' if document is not None else '0'
        self.lock = threading.Lock()
        self.cas_count = 0
        self.barrier = None
        self.lose_response = False

    def load(self):
        with self.lock:
            result = self.generation, deepcopy(self.document)
        if self.barrier:
            self.barrier.wait(timeout=5)
        return result

    def compare_and_swap(self, expected_generation, document):
        with self.lock:
            self.cas_count += 1
            if expected_generation != self.generation:
                raise m.CASConflict('GENERATION_MISMATCH')
            self.generation = str(int(self.generation) + 1)
            self.document = deepcopy(document)
            if self.lose_response:
                raise m.CommitOutcomeUnknown('WRITE_RESPONSE_LOST')
            return self.generation


class IdentityTests(unittest.TestCase):
    def test_event_replay_deduplicates_even_when_delivery_proposes_new_local_uuid(self):
        doc = approved()
        result = step(doc, 'discover', attempt=str(uuid.uuid4()), plan=plan())
        self.assertFalse(result.changed)
        self.assertEqual(result.attempt_id, ATTEMPT)
        self.assertEqual(len(result.document['attempts']), 1)

    def test_same_sha_different_events_or_repositories_are_not_deduplicated(self):
        doc = approved()
        for value in [plan(event='event-2'), plan(repo=456), plan(sha='9'*40)]:
            doc = step(doc, 'discover', attempt=str(uuid.uuid4()), plan=value).document
        self.assertEqual(len(doc['events']), 4)

    def test_event_cannot_change_tree_configuration_or_stage(self):
        for key, value in [('config_sha256', '9'*64), ('stage', 'diagnostic')]:
            modified = plan(); modified[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(m.AdmissionError, 'EVENT_CONTENT_CHANGED'):
                step(approved(), 'discover', plan=modified)
        modified = plan(); modified['identity']['source_tree'] = '9'*40
        with self.assertRaisesRegex(m.AdmissionError, 'EVENT_CONTENT_CHANGED'):
            step(approved(), 'discover', plan=modified)

    def test_approval_cannot_migrate_to_different_plan(self):
        doc = step(m.new_ledger(), 'discover', plan=plan()).document
        value = plan(); value['identity']['source_sha'] = '9'*40
        with self.assertRaisesRegex(m.AdmissionError, 'APPROVAL_PLAN_MISMATCH'):
            step(doc, 'approve_source', approval={'plan_sha256': m.canonical_hash(value),
                 'review_sha256': '5'*64, 'expires_at': m.stamp(NOW + timedelta(hours=1))})

    def test_invalid_identities_extra_fields_and_reduced_full_bound_fail(self):
        for mutate in [lambda p: p['identity'].update(repository_id=True),
                       lambda p: p['identity'].update(source_sha='main'),
                       lambda p: p.update(timeout_seconds=120),
                       lambda p: p.update(skip_ci=True)]:
            value = plan(); mutate(value)
            with self.subTest(value=value), self.assertRaises(m.AdmissionError):
                step(m.new_ledger(), 'discover', plan=value)

    def test_every_transition_preserves_input_and_replay_returns_separate_document(self):
        doc = approved(); before = deepcopy(doc)
        result = step(doc, 'reserve', admission=admission())
        self.assertEqual(doc, before)
        result.document['attempts'][ATTEMPT]['plan']['config_sha256'] = '0'*64
        self.assertEqual(doc, before)
        replay = step(doc, 'discover', plan=plan())
        replay.document['events'].clear()
        self.assertEqual(doc, before)


class BudgetAndStateTests(unittest.TestCase):
    def test_economic_approval_must_bind_exact_source_review(self):
        doc = approved()
        changed = admission(); changed['approval_sha256'] = '1'*64
        with self.assertRaisesRegex(m.AdmissionError, 'ECONOMIC_APPROVAL_MISMATCH'):
            step(doc, 'reserve', admission=changed)
        changed = deepcopy(doc); changed['attempts'][ATTEMPT]['approval']['review_sha256'] = '0'*64
        with self.assertRaisesRegex(m.AdmissionError, 'ECONOMIC_APPROVAL_MISMATCH'):
            step(changed, 'reserve', admission=admission())

    def test_one_global_reservation_covers_all_stages_and_events(self):
        other = str(uuid.uuid4())
        doc = approved(reserved(), attempt=other, value=plan(event='another', stage='attestation'))
        with self.assertRaisesRegex(m.AdmissionError, 'GLOBAL_RESERVATION_OCCUPIED'):
            step(doc, 'reserve', attempt=other, admission=admission())

    def test_missing_credit_over_cap_incomplete_inventory_and_expiry_fail(self):
        cases = [{'credit_verified': False}, {'inventory_complete': False},
                 {'projected_gross_microusd': 100_000_001},
                 {'projected_gross_microusd': True}, {'expires_at': m.stamp(NOW)}]
        for changes in cases:
            value = admission(); value.update(changes)
            with self.subTest(changes=changes), self.assertRaises(m.AdmissionError):
                step(approved(), 'reserve', admission=value)

    def test_1200_minute_limit_includes_imported_bootstrap_and_failures(self):
        end = NOW
        observed = observation('FAILURE', start=NOW-timedelta(minutes=1166), seconds=1166*60)
        doc = step(m.new_ledger(), 'account_external', observation=observed, native_verified=True).document
        doc = approved(doc)
        with self.assertRaisesRegex(m.AdmissionError, 'MONTHLY_POOL_EXCEEDED'):
            step(doc, 'reserve', admission=admission())
        self.assertEqual(m.budget_usage(doc, now=end)['2026-10']['confirmed_seconds'], 1166*60)

    def test_reduced_pool_document_still_admits_only_up_to_420(self):
        # A document that has not received the extension keeps its own ceiling.
        reduced = m.new_ledger(); reduced['monthly_limit_seconds'] = 25200
        observed = observation('FAILURE', start=NOW-timedelta(minutes=386), seconds=386*60)
        doc = step(reduced, 'account_external', observation=observed, native_verified=True).document
        with self.assertRaisesRegex(m.AdmissionError, 'MONTHLY_POOL_EXCEEDED'):
            step(approved(doc), 'reserve', admission=admission())
        observed = observation('FAILURE', start=NOW-timedelta(minutes=325), seconds=325*60)
        doc = step(deepcopy(reduced), 'account_external', observation=observed, native_verified=True).document
        doc = step(approved(doc), 'reserve', admission=admission()).document
        self.assertEqual(m.budget_usage(doc, now=NOW)['2026-10']['total_seconds'], 25200)

    def test_exact_1200_minutes_is_admitted(self):
        observed = observation('FAILURE', start=NOW-timedelta(minutes=1105), seconds=1105*60)
        doc = step(m.new_ledger(), 'account_external', observation=observed, native_verified=True).document
        doc = step(approved(doc), 'reserve', admission=admission()).document
        self.assertEqual(m.budget_usage(doc, now=NOW)['2026-10']['total_seconds'], 72000)

    def test_historical_74_minutes_are_preserved_under_the_extended_pool(self):
        obs = observation('FAILURE', start=NOW-timedelta(minutes=74), seconds=74*60)
        doc = step(m.new_ledger(), 'account_external', observation=obs, native_verified=True).document
        self.assertEqual(doc['monthly_limit_seconds'], 1200*60)
        usage = m.budget_usage(doc, now=NOW)['2026-10']
        self.assertEqual(usage['confirmed_seconds'], 74*60)
        self.assertEqual(doc['monthly_limit_seconds']-usage['total_seconds'], 1126*60)
        self.assertEqual(doc['external_builds'][BUILD]['observation'], obs)
        changed = deepcopy(doc); changed['monthly_limit_seconds'] = 600*60
        with self.assertRaisesRegex(m.AdmissionError, 'LEDGER_POLICY_CHANGED'):
            m.transition(changed, {'op': 'block', 'reason': 'POLICY_CHANGE',
                         'evidence_sha256': '9'*64}, now=NOW)
        self.assertEqual(changed['external_builds'][BUILD]['observation'], obs)

    def test_month_boundary_reserves_both_months_and_unknown_never_expires(self):
        start = datetime(2026, 10, 31, 23, 59, tzinfo=timezone.utc)
        doc = m.transition(reserved(start), intent_command(), now=start).document
        doc = step(doc, 'unknown', start, reason='HTTP_TIMEOUT', evidence_sha256='8'*64).document
        usage = m.budget_usage(doc, now=start + timedelta(days=32))
        self.assertEqual(set(usage), {'2026-10', '2026-11', '2026-12'})
        self.assertTrue(all(row['reserved_seconds'] == 5700 for row in usage.values()))
        self.assertEqual(doc['active_attempt'], ATTEMPT)

    def test_reconciliation_splits_native_time_and_counts_failure(self):
        start = datetime(2026, 10, 31, 23, 59, 30, tzinfo=timezone.utc)
        end = start + timedelta(seconds=100)
        doc = bound(start)
        obs = observation('FAILURE', start=start, seconds=100)
        doc = step(doc, 'terminal', end, observation=obs).document
        self.assertEqual(doc['active_attempt'], ATTEMPT)
        self.assertEqual(m.budget_usage(doc, now=end)['2026-10']['reserved_seconds'], 5700)
        result = step(doc, 'reconcile', end, evidence_sha256='9'*64, native_verified=True)
        self.assertIsNone(result.proposed_effect)
        self.assertIsNone(result.document['active_attempt'])
        usage = m.budget_usage(result.document, now=end)
        self.assertEqual(usage['2026-10']['confirmed_seconds'], 60)
        self.assertEqual(usage['2026-11']['confirmed_seconds'], 120)
        self.assertEqual(result.document['attempts'][ATTEMPT]['terminal']['status'], 'FAILURE')

    def test_success_is_not_reconciliation_and_reconciliation_never_publishes_pass(self):
        doc = bound(); end = NOW + timedelta(seconds=61)
        doc = step(doc, 'terminal', end, observation=observation()).document
        self.assertEqual(doc['attempts'][ATTEMPT]['state'], 'TERMINAL_UNRECONCILED')
        self.assertEqual(doc['active_attempt'], ATTEMPT)
        with self.assertRaisesRegex(m.AdmissionError, 'NATIVE_VERIFICATION_REQUIRED'):
            step(doc, 'reconcile', end, evidence_sha256='9'*64, native_verified=False)
        result = step(doc, 'reconcile', end, evidence_sha256='9'*64, native_verified=True)
        self.assertIsNone(result.proposed_effect)
        self.assertEqual(result.document['attempts'][ATTEMPT]['state'], 'RECONCILED')

    def test_cancel_request_unknown_and_out_of_order_terminal_do_not_release(self):
        doc = m.transition(reserved(), intent_command(), now=NOW).document
        doc = step(doc, 'unknown', reason='CANCEL_REQUESTED', evidence_sha256='8'*64).document
        with self.assertRaisesRegex(m.AdmissionError, 'NATIVE_UUID_MISMATCH'):
            step(doc, 'terminal', NOW+timedelta(seconds=61), observation=observation('CANCELLED'))
        with self.assertRaisesRegex(m.AdmissionError, 'NATIVE_TERMINAL_REQUIRED'):
            step(doc, 'reconcile', evidence_sha256='9'*64, native_verified=True)
        self.assertEqual(m.budget_usage(doc, now=NOW)['2026-10']['reserved_seconds'], 5700)

    def test_source_generation_nonce_configuration_and_native_uuid_cannot_drift(self):
        doc = m.transition(reserved(), intent_command(), now=NOW).document
        for changed in [{'source': source('11')}, {'config_sha256': '9'*64}]:
            args = {'build_id': BUILD, 'source': source(), 'config_sha256': 'c'*64,
                    'native_evidence_sha256': '7'*64, **changed}
            with self.subTest(changed=changed), self.assertRaises(m.AdmissionError):
                step(doc, 'bind', **args)
        cmd = intent_command(); cmd['nonce'] = str(uuid.uuid4())
        with self.assertRaisesRegex(m.AdmissionError, 'SUBMIT_INTENT_CHANGED'):
            m.transition(doc, cmd, now=NOW)
        with self.assertRaisesRegex(m.AdmissionError, 'NATIVE_UUID_CHANGED'):
            step(bound(), 'bind', build_id=str(uuid.uuid4()), source=source(),
                 config_sha256='c'*64, native_evidence_sha256='7'*64)

    def test_source_generation_required_and_no_intent_before_reservation(self):
        for value in [None, '', '0', 10, True]:
            cmd = intent_command(); cmd['source']['generation'] = value
            with self.subTest(value=value), self.assertRaisesRegex(m.AdmissionError, 'SOURCE_GENERATION_REQUIRED'):
                m.transition(reserved(), cmd, now=NOW)
        with self.assertRaisesRegex(m.AdmissionError, 'RESERVATION_REQUIRED'):
            m.transition(approved(), intent_command(), now=NOW)

    def test_completed_source_generation_cannot_be_reused_with_different_declared_hash(self):
        end = NOW + timedelta(minutes=1)
        doc = step(bound(), 'terminal', end, observation=observation(seconds=60)).document
        doc = step(doc, 'reconcile', end, evidence_sha256='9'*64, native_verified=True).document
        other = str(uuid.uuid4()); value = plan(event='new-event')
        doc = approved(doc, end, other, value)
        doc = step(doc, 'reserve', end, other, admission=admission(end, value)).document
        cmd = intent_command(); cmd.update(attempt_id=other, nonce=str(uuid.uuid4()))
        cmd['source']['archive_sha256'] = '0'*64
        with self.assertRaisesRegex(m.AdmissionError, 'SUBMIT_SOURCE_OR_NONCE_REUSED'):
            m.transition(doc, cmd, now=end)

    def test_overrun_is_counted_and_closes_admission_instead_of_discarding_cost(self):
        end = NOW + timedelta(minutes=96)
        doc = step(bound(), 'terminal', end, observation=observation('TIMEOUT', seconds=96*60)).document
        doc = step(doc, 'reconcile', end, evidence_sha256='9'*64, native_verified=True).document
        self.assertEqual(m.budget_usage(doc, now=end)['2026-10']['confirmed_seconds'], 96*60)
        self.assertEqual(doc['blocked']['reason'], 'OBSERVED_USAGE_EXCEEDS_RESERVATION')
        other = str(uuid.uuid4()); doc = approved(doc, end, other, plan(event='other'))
        with self.assertRaisesRegex(m.AdmissionError, 'ADMISSION_BLOCKED'):
            step(doc, 'reserve', end, other, admission=admission(end))

    def test_external_native_uuid_is_accounted_once_and_changed_receipt_rejected(self):
        obs = observation('FAILURE', start=NOW-timedelta(minutes=5), seconds=300)
        doc = step(m.new_ledger(), 'account_external', observation=obs, native_verified=True).document
        self.assertFalse(step(doc, 'account_external', observation=obs, native_verified=True).changed)
        changed = deepcopy(obs); changed['status'] = 'SUCCESS'
        with self.assertRaisesRegex(m.AdmissionError, 'EXTERNAL_OBSERVATION_CHANGED'):
            step(doc, 'account_external', observation=changed, native_verified=True)
        self.assertEqual(m.budget_usage(doc, now=NOW)['2026-10']['confirmed_seconds'], 300)

    def test_zero_usage_requires_native_nonexecution_and_cannot_claim_success(self):
        obs = observation('CANCELLED', seconds=0)
        obs.update(started_at=None, execution_not_started=True)
        doc = step(m.new_ledger(), 'account_external', observation=obs, native_verified=True).document
        self.assertEqual(m.budget_usage(doc, now=NOW), {})
        obs['status'] = 'SUCCESS'
        with self.assertRaisesRegex(m.AdmissionError, 'ZERO_USAGE_NOT_PROVEN'):
            step(m.new_ledger(), 'account_external', observation=obs, native_verified=True)

    def test_clock_rollback_naive_time_and_future_finish_fail_closed(self):
        with self.assertRaisesRegex(m.AdmissionError, 'CLOCK_MOVED_BACKWARD'):
            step(approved(), 'reserve', NOW-timedelta(seconds=1), admission=admission())
        with self.assertRaisesRegex(m.AdmissionError, 'UTC_TIMESTAMP_REQUIRED'):
            step(m.new_ledger(), 'discover', datetime(2026, 10, 10), plan=plan())
        with self.assertRaisesRegex(m.AdmissionError, 'FUTURE_NATIVE_FINISH'):
            step(bound(), 'terminal', observation=observation())


class CASTests(unittest.TestCase):
    def test_bootstrap_is_explicit_and_normal_transact_never_creates_missing_ledger(self):
        store = MemoryStore()
        command = {'op': 'discover', 'attempt_id': ATTEMPT, 'plan': plan()}
        with self.assertRaisesRegex(m.AdmissionError, 'LEDGER_MISSING_NO_RESET'):
            m.transact(store, command, now=NOW)
        self.assertEqual(store.cas_count, 0)
        initialized = m.bootstrap_store(store, m.new_ledger())
        self.assertEqual(initialized.generation, '1')
        self.assertIsNone(initialized.effect)
        first = m.transact(store, command, now=NOW)
        second = m.transact(store, command, now=NOW)
        self.assertEqual(first.generation, '2')
        self.assertIsNone(first.effect)
        self.assertFalse(second.changed)
        self.assertEqual(store.cas_count, 2)
        with self.assertRaisesRegex(m.AdmissionError, 'BOOTSTRAP_REQUIRES_ABSENT_STORE'):
            m.bootstrap_store(store, m.new_ledger())

    def test_ledger_disappearance_after_initialization_does_not_reset_usage_or_create(self):
        store = MemoryStore(reserved())
        store.document = None; store.generation = '0'
        with self.assertRaisesRegex(m.AdmissionError, 'LEDGER_MISSING_NO_RESET'):
            m.transact(store, intent_command(), now=NOW)
        self.assertEqual(store.cas_count, 0)

    def test_bootstrap_preserves_imported_failure_usage(self):
        observed = observation('FAILURE', start=NOW-timedelta(minutes=386), seconds=386*60)
        initial = step(m.new_ledger(), 'account_external', observation=observed, native_verified=True).document
        store = MemoryStore()
        m.bootstrap_store(store, initial)
        self.assertEqual(m.budget_usage(store.document, now=NOW)['2026-10']['confirmed_seconds'], 386*60)

    def test_concurrent_intents_yield_one_confirmed_create_and_one_conflict(self):
        store = MemoryStore(reserved()); store.barrier = threading.Barrier(2)
        def invoke():
            try: return m.transact(store, intent_command(), now=NOW)
            except m.CASConflict as error: return error
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: invoke(), range(2)))
        committed = [r for r in results if isinstance(r, m.Transaction)]
        self.assertEqual(len(committed), 1)
        self.assertEqual(committed[0].effect, {'type': 'CREATE_ONCE', 'attempt_id': ATTEMPT,
                                             'fencing_generation': '2'})
        self.assertEqual(sum(isinstance(r, m.CASConflict) for r in results), 1)
        self.assertEqual(store.cas_count, 2)
        store.barrier = None
        self.assertIsNone(m.transact(store, intent_command(), now=NOW).effect)
        self.assertEqual(store.cas_count, 2)

    def test_ambiguous_committed_intent_retains_lock_and_replay_never_resubmits(self):
        store = MemoryStore(reserved()); store.lose_response = True
        with self.assertRaisesRegex(m.CommitOutcomeUnknown, 'WRITE_RESPONSE_LOST'):
            m.transact(store, intent_command(), now=NOW)
        self.assertEqual(store.document['active_attempt'], ATTEMPT)
        store.lose_response = False
        replay = m.transact(store, intent_command(), now=NOW)
        self.assertFalse(replay.changed)
        self.assertIsNone(replay.effect)
        self.assertEqual(store.cas_count, 1)

    def test_uncertain_noncommitted_write_never_automatically_retries(self):
        class LostStore(MemoryStore):
            def compare_and_swap(self, generation, document):
                self.cas_count += 1
                raise m.CommitOutcomeUnknown('OUTCOME_UNKNOWN')
        store = LostStore(reserved())
        with self.assertRaises(m.CommitOutcomeUnknown):
            m.transact(store, intent_command(), now=NOW)
        self.assertEqual(store.cas_count, 1)
        self.assertEqual(store.document['attempts'][ATTEMPT]['state'], 'RESERVED')

    def test_invalid_cas_confirmation_never_yields_create(self):
        for result in [None, '0', '1', 2, True, 'abc']:
            class BadStore(MemoryStore):
                def compare_and_swap(self, generation, document): return result
            with self.subTest(result=result), self.assertRaises(m.CommitOutcomeUnknown):
                m.transact(BadStore(reserved()), intent_command(), now=NOW)

    def test_generation_contract_and_global_lock_corruption_are_rejected(self):
        class InvalidStore:
            def load(self): return '0', approved()
            def compare_and_swap(self, generation, document): raise AssertionError('must not write')
        with self.assertRaisesRegex(m.AdmissionError, 'STORE_ABSENCE_INCONSISTENT'):
            m.transact(InvalidStore(), intent_command(), now=NOW)
        doc = reserved(); doc['active_attempt'] = None
        with self.assertRaisesRegex(m.AdmissionError, 'GLOBAL_LOCK_INVALID'):
            m.transition(doc, intent_command(), now=NOW)


class AbortBeforeDispatchTests(unittest.TestCase):
    def command(self, evidence='9'*64):
        return {'op': 'abort_before_dispatch', 'attempt_id': ATTEMPT,
                'evidence_sha256': evidence, 'native_verified': True}

    def abort(self, doc=None, now=NOW):
        return m.transition(reserved() if doc is None else doc, self.command(), now=now)

    def test_preserves_74_minutes_and_95_minute_history_without_native_uuid(self):
        observed = observation('FAILURE', start=NOW-timedelta(minutes=74), seconds=74*60)
        old = step(m.new_ledger(), 'account_external', observation=observed, native_verified=True).document
        old = step(approved(old), 'reserve', admission=admission()).document
        before = deepcopy(old)
        result = self.abort(old, NOW+timedelta(minutes=16))
        self.assertEqual(old, before)
        self.assertIsNone(result.proposed_effect)
        row = result.document['attempts'][ATTEMPT]
        self.assertEqual(row['state'], 'ABORTED_BEFORE_DISPATCH')
        self.assertEqual(row['abortion'], {'evidence_sha256': '9'*64,
            'aborted_at': m.stamp(NOW+timedelta(minutes=16)), 'reserved_seconds': 95*60})
        self.assertEqual({k: row[k] for k in before['attempts'][ATTEMPT]},
            dict(before['attempts'][ATTEMPT], state='ABORTED_BEFORE_DISPATCH'))
        self.assertFalse({'intent', 'submitted_at', 'build_id', 'terminal'} & set(row))
        for key in ('events', 'external_builds', 'monthly_limit_seconds', 'blocked'):
            self.assertEqual(result.document[key], before[key])
        self.assertIsNone(result.document['active_attempt'])
        self.assertEqual(m.budget_usage(result.document, now=NOW+timedelta(minutes=16))['2026-10'],
            {'confirmed_seconds': 74*60, 'reserved_seconds': 0, 'total_seconds': 74*60})

    def test_rejects_unverified_invalid_hash_and_injected_fields_without_mutation(self):
        old = reserved()
        for fields in ({'native_verified': False}, {'native_verified': 1},
                       {'evidence_sha256': ''}, {'build_id': BUILD},
                       {'reservation_refunded': True}):
            store = MemoryStore(old)
            with self.subTest(fields=fields), self.assertRaises(m.AdmissionError):
                m.transact(store, dict(self.command(), **fields), now=NOW)
            self.assertEqual(store.document, old)
            self.assertEqual(store.cas_count, 0)

    def test_all_nonreserved_states_reject_including_unknown_and_native_terminal(self):
        end = NOW+timedelta(minutes=1)
        pending = m.transition(reserved(), intent_command(), now=NOW).document
        terminal = step(bound(), 'terminal', end, observation=observation(seconds=60)).document
        cases = [step(m.new_ledger(), 'discover', plan=plan()).document, approved(), pending,
                 step(pending, 'unknown', reason='TIMEOUT', evidence_sha256='8'*64).document,
                 bound(), step(bound(), 'running', build_id=BUILD).document, terminal,
                 step(terminal, 'reconcile', end, evidence_sha256='9'*64, native_verified=True).document]
        for doc in cases:
            with self.subTest(state=doc['attempts'][ATTEMPT]['state']):
                store = MemoryStore(doc)
                with self.assertRaisesRegex(m.AdmissionError, 'UNDISPATCHED_RESERVATION_REQUIRED'):
                    m.transact(store, self.command(), now=end)
                self.assertEqual(store.document, doc)
                self.assertEqual(store.cas_count, 0)

    def test_same_event_never_reopens_or_dispatches_after_abort(self):
        doc = self.abort().document
        rediscovered = step(doc, 'discover', attempt=str(uuid.uuid4()), plan=plan())
        self.assertFalse(rediscovered.changed)
        self.assertEqual(rediscovered.attempt_id, ATTEMPT)
        self.assertFalse(step(doc, 'approve_source', approval=approval()).changed)
        self.assertFalse(step(doc, 'reserve', admission=admission()).changed)
        with self.assertRaisesRegex(m.AdmissionError, 'RESERVATION_REQUIRED'):
            m.transition(doc, intent_command(), now=NOW)
        self.assertIsNone(doc['active_attempt'])

    def test_identical_abort_is_read_only_and_different_evidence_rejected(self):
        store = MemoryStore(reserved())
        first = m.transact(store, self.command(), now=NOW)
        second = m.transact(store, self.command(), now=NOW+timedelta(seconds=1))
        self.assertTrue(first.changed)
        self.assertIsNone(first.effect)
        self.assertFalse(second.changed)
        self.assertIsNone(second.effect)
        self.assertEqual(first.document, second.document)
        with self.assertRaisesRegex(m.AdmissionError, 'ABORTION_EVIDENCE_CHANGED'):
            m.transact(store, self.command('8'*64), now=NOW)
        self.assertEqual(store.cas_count, 1)

    def test_unreviewed_stage_abort_is_not_inferred_from_absent_submit_intent(self):
        for stage in set(m.STAGE_LIMITS) - {'full'}:
            value = plan(stage=stage)
            doc = step(approved(value=value), 'reserve', admission=admission(value=value)).document
            store = MemoryStore(doc)
            with self.subTest(stage=stage), self.assertRaisesRegex(m.AdmissionError, 'UNDISPATCHED_FULL_REQUIRED'):
                m.transact(store, self.command(), now=NOW)
            self.assertEqual(store.document, doc)
            self.assertEqual(store.cas_count, 0)

    def test_later_recovery_may_release_old_unexecuted_reservation_after_approval_expiry(self):
        end = NOW+timedelta(days=35)
        doc = reserved()
        self.assertGreater(len(m.budget_usage(doc, now=end)), 1)
        result = self.abort(doc, end)
        self.assertEqual(m.budget_usage(result.document, now=end), {})
        self.assertEqual(result.document['attempts'][ATTEMPT]['abortion']['reserved_seconds'], 5700)
        self.assertEqual(result.document['attempts'][ATTEMPT]['admission'], doc['attempts'][ATTEMPT]['admission'])

    def test_abort_never_reopens_blocked_ledger_or_changes_another_attempt(self):
        other = str(uuid.uuid4())
        doc = approved(reserved(), attempt=other, value=plan(event='next'))
        doc = step(doc, 'block', reason='OPERATOR_PAUSED', evidence_sha256='8'*64).document
        result = self.abort(doc).document
        self.assertEqual(result['blocked'], doc['blocked'])
        self.assertEqual(result['attempts'][other], doc['attempts'][other])
        with self.assertRaisesRegex(m.AdmissionError, 'ADMISSION_BLOCKED'):
            step(result, 'reserve', attempt=other, admission=admission(value=plan(event='next')))

    def test_next_distinct_event_requires_new_approval_and_reserves_full_amount(self):
        doc = self.abort().document
        other = str(uuid.uuid4()); value = plan(event='new-explicit-event')
        doc = approved(doc, attempt=other, value=value)
        doc = step(doc, 'reserve', attempt=other, admission=admission(value=value)).document
        self.assertEqual(doc['active_attempt'], other)
        self.assertEqual(m.budget_usage(doc, now=NOW)['2026-10']['reserved_seconds'], 5700)
        self.assertEqual(doc['attempts'][ATTEMPT]['abortion']['reserved_seconds'], 5700)

    def test_race_against_submit_has_one_cas_winner_never_abort_and_dispatch(self):
        store = MemoryStore(reserved()); store.barrier = threading.Barrier(2)
        def invoke(command):
            try: return m.transact(store, command, now=NOW)
            except m.CASConflict as error: return error
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(invoke, [self.command(), intent_command()]))
        winners = [r for r in results if isinstance(r, m.Transaction)]
        self.assertEqual(len(winners), 1)
        self.assertEqual(sum(isinstance(r, m.CASConflict) for r in results), 1)
        state = store.document['attempts'][ATTEMPT]['state']
        if state == 'ABORTED_BEFORE_DISPATCH':
            self.assertIsNone(winners[0].effect)
            self.assertIsNone(store.document['active_attempt'])
        else:
            self.assertEqual(state, 'SUBMIT_INTENT')
            self.assertEqual(winners[0].effect['type'], 'CREATE_ONCE')
            self.assertEqual(store.document['active_attempt'], ATTEMPT)
            with self.assertRaisesRegex(m.AdmissionError, 'UNDISPATCHED_RESERVATION_REQUIRED'):
                self.abort(store.document)

    def test_ambiguous_committed_abort_only_reads_back_proposal_without_retry(self):
        before = reserved(); proposal = self.abort(before).document
        store = MemoryStore(before); store.lose_response = True
        with self.assertRaisesRegex(m.CommitOutcomeUnknown, 'WRITE_RESPONSE_LOST'):
            m.transact(store, self.command(), now=NOW)
        generation, readback = store.load()
        self.assertEqual(generation, '2')
        self.assertEqual(readback, proposal)
        self.assertEqual(store.cas_count, 1)

    def test_uncommitted_or_conflicted_abort_retains_reservation_without_retry(self):
        for error in (m.CommitOutcomeUnknown, m.CASConflict):
            class FailedStore(MemoryStore):
                def compare_and_swap(self, generation, document):
                    self.cas_count += 1
                    raise error('NO_CONFIRMATION')
            store = FailedStore(reserved())
            with self.subTest(error=error), self.assertRaises(error):
                m.transact(store, self.command(), now=NOW)
            self.assertEqual(store.document['active_attempt'], ATTEMPT)
            self.assertEqual(m.budget_usage(store.document, now=NOW)['2026-10']['reserved_seconds'], 5700)
            self.assertEqual(store.cas_count, 1)

    def test_corrupt_abortion_or_native_fields_cannot_be_loaded_as_terminal(self):
        base = self.abort().document
        changes = [lambda a: a.update(abortion=None),
            lambda a: a['abortion'].update(reserved_seconds=0),
            lambda a: a['abortion'].update(reserved_seconds=True),
            lambda a: a['abortion'].update(evidence_sha256='bad'),
            lambda a: a['abortion'].update(aborted_at=m.stamp(NOW-timedelta(seconds=1))),
            lambda a: a['abortion'].update(aborted_at=m.stamp(NOW+timedelta(seconds=1))),
            lambda a: a.update(build_id=BUILD), lambda a: a.update(intent=intent_command()),
            lambda a: a.update(terminal=observation()), lambda a: a['abortion'].update(refunded=True)]
        for change in changes:
            doc = deepcopy(base); change(doc['attempts'][ATTEMPT])
            with self.subTest(change=change), self.assertRaises(m.AdmissionError):
                m.validate_ledger(doc)


class AbandonWithoutNativeTests(unittest.TestCase):
    """20-oct-2026: an UNKNOWN DISPATCH whose CreateBuild never reached Cloud Build."""
    def unknown(self, now=NOW, value=None):
        doc = reserved(now) if value is None else step(approved(now=now, value=value), 'reserve', now,
                                                       admission=admission(now, value)).document
        doc = m.transition(doc, intent_command(), now=now).document
        return step(doc, 'unknown', now, reason='CREATE_OR_BIND_OUTCOME_UNKNOWN', evidence_sha256='8'*64).document

    def command(self, evidence='9'*64):
        return {'op': 'abandon_without_native', 'attempt_id': ATTEMPT,
                'evidence_sha256': evidence, 'native_verified': True}

    def test_charges_whole_reservation_keeps_history_and_releases_only_the_lock(self):
        old = self.unknown(); before = deepcopy(old)
        later = NOW + timedelta(minutes=20)
        result = m.transition(old, self.command(), now=later)
        self.assertEqual(old, before)
        self.assertIsNone(result.proposed_effect)
        row = result.document['attempts'][ATTEMPT]
        self.assertEqual(row['state'], 'ABANDONED_WITHOUT_NATIVE')
        self.assertEqual(row['abandonment'], {'evidence_sha256': '9'*64, 'abandoned_at': m.stamp(later),
                                              'charged_seconds': 95*60})
        self.assertEqual({k: row[k] for k in before['attempts'][ATTEMPT]},
                         dict(before['attempts'][ATTEMPT], state='ABANDONED_WITHOUT_NATIVE'))
        self.assertFalse({'build_id', 'terminal', 'bind_evidence_sha256'} & set(row))
        for key in ('events', 'external_builds', 'monthly_limit_seconds', 'blocked'):
            self.assertEqual(result.document[key], before[key])
        self.assertIsNone(result.document['active_attempt'])
        self.assertEqual(m.budget_usage(result.document, now=later)['2026-10'],
                         {'confirmed_seconds': 95*60, 'reserved_seconds': 0, 'total_seconds': 95*60})
        # Another event may reserve; the abandoned event, nonce and source stay consumed.
        other = '44444444-4444-4444-8444-444444444444'
        value = plan(event='event-2', sha='9'*40)
        doc = approved(result.document, later, other, value)
        doc = step(doc, 'reserve', later, other, admission=admission(later, value)).document
        self.assertEqual(doc['active_attempt'], other)
        again = step(result.document, 'discover', later, other, plan=plan())
        self.assertFalse(again.changed)
        with self.assertRaises(m.AdmissionError):
            m.transition(doc, {'op': 'submit_intent', 'attempt_id': other, 'source': source(),
                               'nonce': NONCE, 'request_sha256': '6'*64}, now=later)

    def test_replay_is_idempotent_and_evidence_cannot_change(self):
        doc = m.transition(self.unknown(), self.command(), now=NOW).document
        replay = m.transition(doc, self.command(), now=NOW + timedelta(minutes=1))
        self.assertFalse(replay.changed)
        with self.assertRaises(m.AdmissionError):
            m.transition(doc, self.command('a'*64), now=NOW)

    def test_rejects_states_with_possible_native_build_or_without_intent(self):
        bound_unknown = step(bound(), 'unknown', reason='CREATE_OR_BIND_OUTCOME_UNKNOWN', evidence_sha256='8'*64).document
        submitted = m.transition(reserved(), intent_command(), now=NOW).document
        for doc in (reserved(), submitted, bound(), bound_unknown):
            with self.subTest(state=doc['attempts'][ATTEMPT]['state']), self.assertRaises(m.AdmissionError):
                m.transition(doc, self.command(), now=NOW)

    def test_rejects_non_full_stage(self):
        value = plan(stage='diagnostic')
        with self.assertRaises(m.AdmissionError):
            m.transition(self.unknown(value=value), self.command(), now=NOW)

    def test_rejects_unverified_invalid_hash_and_injected_fields_without_mutation(self):
        old = self.unknown()
        for fields in ({'native_verified': False}, {'native_verified': 1}, {'evidence_sha256': ''},
                       {'build_id': BUILD}, {'reservation_refunded': True}):
            store = MemoryStore(old)
            with self.subTest(fields=fields), self.assertRaises(m.AdmissionError):
                m.transact(store, {**self.command(), **fields}, now=NOW)
            self.assertEqual(store.document, old); self.assertEqual(store.cas_count, 0)

    def test_durable_shape_is_strict(self):
        doc = m.transition(self.unknown(), self.command(), now=NOW + timedelta(minutes=5)).document
        m.validate_ledger(doc)
        def tampered(change):
            value = deepcopy(doc); change(value['attempts'][ATTEMPT]); return value
        cases = [lambda a: a['abandonment'].update(charged_seconds=60),
                 lambda a: a['abandonment'].update(refunded=True),
                 lambda a: a['abandonment'].update(abandoned_at=m.stamp(NOW - timedelta(minutes=1))),
                 lambda a: a.pop('uncertainty'), lambda a: a.pop('intent'),
                 lambda a: a.update(build_id=BUILD, bind_evidence_sha256='7'*64)]
        for change in cases:
            with self.assertRaises(m.AdmissionError):
                m.validate_ledger(tampered(change))
        live = deepcopy(doc); live['active_attempt'] = ATTEMPT
        with self.assertRaises(m.AdmissionError):
            m.validate_ledger(live)

    def test_charge_covers_every_month_the_intent_could_reach(self):
        start = datetime(2026, 10, 31, 23, 0, tzinfo=timezone.utc)
        doc = m.transition(self.unknown(start), self.command(), now=start + timedelta(minutes=10)).document
        usage = m.budget_usage(doc, now=start + timedelta(minutes=10))
        self.assertEqual(usage['2026-10']['confirmed_seconds'], 95*60)
        self.assertEqual(usage['2026-11']['confirmed_seconds'], 95*60)


class DurableValidationTests(unittest.TestCase):
    def assert_closed(self, doc, now=NOW):
        store = MemoryStore(doc)
        with self.assertRaises(m.AdmissionError):
            m.budget_usage(doc, now=now)
        with self.assertRaises(m.AdmissionError):
            m.transact(store, {'op': 'block', 'reason': 'CORRUPTION', 'evidence_sha256': '9'*64}, now=now)
        self.assertEqual(store.cas_count, 0)

    def test_stored_external_zero_usage_success_cannot_erase_cost(self):
        obs = observation('SUCCESS', start=NOW-timedelta(minutes=5), seconds=300)
        doc = step(m.new_ledger(), 'account_external', observation=obs, native_verified=True).document
        doc['external_builds'][BUILD]['observation'].update(execution_not_started=True, started_at=None)
        self.assert_closed(doc)

    def test_missing_unknown_or_extra_fields_in_every_state_fail_closed(self):
        end = NOW + timedelta(minutes=1)
        discovered = step(m.new_ledger(), 'discover', plan=plan()).document
        pending = m.transition(reserved(), intent_command(), now=NOW).document
        unknown = step(pending, 'unknown', reason='TIMEOUT', evidence_sha256='8'*64).document
        terminal = step(bound(), 'terminal', end, observation=observation(seconds=60)).document
        reconciled = step(terminal, 'reconcile', end, evidence_sha256='9'*64, native_verified=True).document
        aborted = step(reserved(), 'abort_before_dispatch', end,
                       evidence_sha256='9'*64, native_verified=True).document
        docs = [discovered, approved(), reserved(), pending, unknown, bound(), aborted,
                step(bound(), 'running', build_id=BUILD).document, terminal, reconciled]
        for base in docs:
            for field in base['attempts'][ATTEMPT]:
                doc = deepcopy(base); del doc['attempts'][ATTEMPT][field]
                with self.subTest(state=base['attempts'][ATTEMPT]['state'], missing=field):
                    self.assert_closed(doc, end)
            doc = deepcopy(base); doc['attempts'][ATTEMPT]['skip_ci'] = True
            self.assert_closed(doc, end)

    def test_durable_nested_corruption_is_admission_error_not_unhandled_key_or_type_error(self):
        corruptions = [
            lambda d: d['attempts'].update({ATTEMPT: None}),
            lambda d: d['attempts'][ATTEMPT].update(state=[]),
            lambda d: d['attempts'][ATTEMPT]['plan'].update(stage=[]),
            lambda d: d['attempts'][ATTEMPT].update(intent=None),
            lambda d: d['attempts'][ATTEMPT]['intent']['source'].update(generation=0),
            lambda d: d['attempts'][ATTEMPT]['intent'].update(nonce='bad'),
            lambda d: d['attempts'][ATTEMPT]['admission'].update(approval_sha256='0'*64),
            lambda d: d['attempts'][ATTEMPT].update(submitted_at=m.stamp(NOW-timedelta(seconds=1))),
            lambda d: d['attempts'][ATTEMPT].update(discovered_at=m.stamp(NOW+timedelta(seconds=1))),
            lambda d: d.update(blocked={}),
            lambda d: d.update(schema_version=True),
            lambda d: d.update(updated_at=None),
        ]
        for corrupt in corruptions:
            doc = bound(); corrupt(doc)
            with self.subTest(corrupt=corrupt): self.assert_closed(doc)

    def test_terminal_uuid_interval_flags_and_reconciliation_timestamps_are_revalidated(self):
        end = NOW + timedelta(minutes=1)
        terminal = step(bound(), 'terminal', end, observation=observation(seconds=60)).document
        base = step(terminal, 'reconcile', end, evidence_sha256='9'*64, native_verified=True).document
        for changes in [{'build_id': str(uuid.uuid4())}, {'status': []},
                        {'started_at': m.stamp(NOW-timedelta(seconds=1))},
                        {'finished_at': m.stamp(end+timedelta(seconds=1))},
                        {'execution_not_started': 1}, {'evidence_sha256': 'bad'},
                        {'execution_not_started': True, 'started_at': None}]:
            doc = deepcopy(base); doc['attempts'][ATTEMPT]['terminal'].update(changes)
            with self.subTest(changes=changes): self.assert_closed(doc, end)
        doc = deepcopy(base); doc['attempts'][ATTEMPT]['reconciled_at'] = m.stamp(NOW)
        self.assert_closed(doc, end)


class GCSIntegrationTests(unittest.TestCase):
    """Exercise the real domain and GCS adapter together, with only HTTP faked."""
    def test_effect_requires_generation_readback_and_unknown_replay_never_recreates(self):
        store_spec = importlib.util.spec_from_file_location('admission_integration_store',
            Path(__file__).resolve().parents[2] / 'scripts/cloudbuild_gcs_store.py')
        store_module = importlib.util.module_from_spec(store_spec)
        store_spec.loader.exec_module(store_module)

        class HTTP:
            def __init__(self):
                self.generation = '0'
                self.versions = {}
                self.calls = []
                self.lose_readback = False

            def metadata(self):
                return json.dumps({'bucket': 'synthetic-ci', 'name': 'controller/ledger.json',
                                   'generation': self.generation,
                                   'size': str(len(self.versions[self.generation]))}).encode()

            def __call__(self, method, url, body=None):
                self.calls.append((method, url))
                query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
                if method == 'POST':
                    if query['ifGenerationMatch'][0] != self.generation:
                        return 412, b'{}'
                    self.generation = str(int(self.generation) + 1)
                    self.versions[self.generation] = body
                    return 200, self.metadata()
                if query.get('alt') == ['media']:
                    # Readback fails only for the newly committed intent; the
                    # initial load succeeded and the conditional write happened.
                    raw = self.versions[query['generation'][0]]
                    if self.lose_readback and b'SUBMIT_INTENT' in raw:
                        raise TimeoutError('synthetic lost readback')
                    return 200, raw
                return (200, self.metadata()) if self.generation != '0' else (404, b'{}')

        for uncertain in (False, True):
            with self.subTest(uncertain=uncertain):
                http = HTTP()
                store = store_module.GCSAdmissionStore('synthetic-ci', 'controller/ledger.json', http)
                with self.assertRaisesRegex(m.AdmissionError, 'LEDGER_MISSING_NO_RESET'):
                    m.transact(store, intent_command(), now=NOW)
                self.assertFalse(any(method == 'POST' for method, _ in http.calls))
                m.bootstrap_store(store, reserved())
                http.lose_readback = uncertain
                if uncertain:
                    with self.assertRaises(m.CommitOutcomeUnknown):
                        m.transact(store, intent_command(), now=NOW)
                else:
                    result = m.transact(store, intent_command(), now=NOW)
                    self.assertEqual(result.effect, {'type': 'CREATE_ONCE', 'attempt_id': ATTEMPT,
                                                     'fencing_generation': '2'})
                http.lose_readback = False
                generation, stored = store.load()
                self.assertEqual(generation, '2')
                self.assertEqual(stored['active_attempt'], ATTEMPT)
                self.assertEqual(stored['attempts'][ATTEMPT]['state'], 'SUBMIT_INTENT')
                replay = m.transact(store, intent_command(), now=NOW)
                self.assertFalse(replay.changed)
                self.assertIsNone(replay.effect)
                self.assertEqual(sum(method == 'POST' for method, _ in http.calls), 2)




class ProspectivePoolReductionTests(unittest.TestCase):
    def command(self, **changes):
        return {'op': 'reduce_monthly_limit', 'from_seconds': 28800, 'to_seconds': 25200,
                'evidence_sha256': 'a'*64, 'native_verified': True, **changes}

    def historical(self, doc=None):
        # Synthetic prior policy. Native documents are never rewritten this way.
        doc = deepcopy(m.new_ledger() if doc is None else doc)
        doc['monthly_limit_seconds'] = 28800
        m.validate_historical_ledger(doc)
        return doc

    def used(self, minutes=74, when=NOW):
        obs = observation('FAILURE', start=when-timedelta(minutes=minutes), seconds=minutes*60)
        doc = step(m.new_ledger(), 'account_external', now=when, observation=obs, native_verified=True).document
        # The historical limit was480; a421min usage was not an overrun then.
        doc['blocked'] = None
        return self.historical(doc)

    def test_preserves_74_minutes_and_aborted_95_history_and_full_bound(self):
        doc = self.used()
        # Compose genuine historical abort through its explicitly closed helper.
        future = step(approved(), 'reserve', admission=admission()).document['attempts'][ATTEMPT]
        doc['attempts'][ATTEMPT] = future
        doc['events'][m.event_key(future['plan']['identity'])] = ATTEMPT
        doc['active_attempt'] = ATTEMPT
        doc = m.transition_historical_abort(doc, {'op':'abort_before_dispatch', 'attempt_id':ATTEMPT,
            'evidence_sha256':'9'*64, 'native_verified':True}, now=NOW).document
        prior = deepcopy(doc)
        out = m.transition(doc, self.command(), now=NOW)
        self.assertIsNone(out.proposed_effect); self.assertIsNone(out.attempt_id)
        self.assertEqual(doc, prior)
        for key in ('attempts','events','external_builds','active_attempt','blocked'):
            self.assertEqual(out.document[key], prior[key])
        self.assertEqual(out.document['monthly_limit_seconds'],25200)
        self.assertEqual(out.document['revision'],prior['revision']+1)
        self.assertEqual(m.budget_usage(out.document,now=NOW)['2026-10']['confirmed_seconds'],4440)
        self.assertEqual(out.document['attempts'][ATTEMPT]['abortion']['reserved_seconds'],5700)
        self.assertEqual(m.STAGE_LIMITS['full'],5700)
        self.assertEqual(out.document['limit_reduction'],{
            'from_seconds':28800,'to_seconds':25200,'evidence_sha256':'a'*64,'reduced_at':m.stamp(NOW)})

    def test_default_runtime_validation_and_all_operational_commands_reject_480(self):
        doc = self.historical(approved())
        for method in (lambda:m.validate_ledger(doc), lambda:m.budget_usage(doc,now=NOW),
                       lambda:step(doc,'reserve',admission=admission()),
                       lambda:step(doc,'block',reason='REOPEN',evidence_sha256='a'*64)):
            with self.subTest(method=method), self.assertRaisesRegex(m.AdmissionError,'OPERATING_POOL_REDUCTION_REQUIRED'):
                method()
        self.assertEqual(m.budget_usage_historical(doc,now=NOW),{})
        for cmd in (intent_command(), self.command(), {'op':'discover'}):
            with self.subTest(cmd=cmd), self.assertRaisesRegex(m.AdmissionError,'HISTORICAL_ABORT_ONLY'):
                m.transition_historical_abort(doc,cmd,now=NOW)

    def test_exact_420_allowed_and_421_in_any_recorded_month_rejected(self):
        out=m.transition(self.used(420),self.command(),now=NOW).document
        self.assertEqual(m.budget_usage(out,now=NOW)['2026-10']['total_seconds'],25200)
        for when in (NOW,NOW-timedelta(days=32)):
            with self.subTest(when=when),self.assertRaisesRegex(m.AdmissionError,'REDUCED_MONTHLY_POOL_EXCEEDED'):
                m.transition(self.used(421,when),self.command(),now=NOW)

    def test_active_reserved_unknown_terminal_and_blocked_reject_without_cas(self):
        pending=m.transition(reserved(),intent_command(),now=NOW).document
        unknown=step(pending,'unknown',reason='NETWORK',evidence_sha256='8'*64).document
        terminal=step(bound(),'terminal',now=NOW+timedelta(seconds=1),observation=observation(seconds=1)).document
        blocked=step(m.new_ledger(),'block',reason='STOP',evidence_sha256='8'*64).document
        for doc in (reserved(),pending,unknown,terminal,blocked):
            store=MemoryStore(self.historical(doc))
            with self.subTest(state=doc),self.assertRaises(m.AdmissionError):
                m.transact(store,self.command(),now=NOW+timedelta(seconds=2))
            self.assertEqual(store.cas_count,0)

    def test_only_fixed_reduction_and_native_evidence_shape(self):
        for change in ({'from_seconds':25200},{'to_seconds':27000},{'to_seconds':28800},
                       {'to_seconds':True},{'from_seconds':True},{'native_verified':1},
                       {'native_verified':False},{'evidence_sha256':'bad'},{'reset':False}):
            store=MemoryStore(self.used())
            with self.subTest(change=change),self.assertRaises(m.AdmissionError):
                m.transact(store,self.command(**change),now=NOW)
            self.assertEqual(store.cas_count,0)
        with self.assertRaisesRegex(m.AdmissionError,'HISTORICAL_POOL_REQUIRED'):
            m.transition(m.new_ledger(),self.command(),now=NOW)

    def test_same_evidence_replay_no_write_changed_evidence_rejected(self):
        store=MemoryStore(self.used())
        first=m.transact(store,self.command(),now=NOW)
        replay=m.transact(store,self.command(),now=NOW+timedelta(seconds=2))
        self.assertFalse(replay.changed);self.assertIsNone(replay.effect)
        self.assertEqual(store.cas_count,1);self.assertEqual(first.document,replay.document)
        with self.assertRaisesRegex(m.AdmissionError,'LIMIT_REDUCTION_EVIDENCE_CHANGED'):
            m.transact(store,self.command(evidence_sha256='b'*64),now=NOW)
        self.assertEqual(store.cas_count,1)

    def test_durable_receipt_policy_and_chronology_corruption_rejected(self):
        base=m.transition(self.used(),self.command(),now=NOW).document
        changes=(lambda d:d['limit_reduction'].update(from_seconds=27000),
                 lambda d:d['limit_reduction'].update(to_seconds=True),
                 lambda d:d['limit_reduction'].update(evidence_sha256='bad'),
                 lambda d:d['limit_reduction'].update(reduced_at=m.stamp(NOW+timedelta(seconds=1))),
                 lambda d:d['limit_reduction'].update(refund=True),
                 lambda d:d.update(monthly_limit_seconds=28800))
        for change in changes:
            doc=deepcopy(base);change(doc)
            with self.subTest(change=change),self.assertRaises(m.AdmissionError):m.validate_ledger(doc)

    def test_legacy_schema_and_invalid_initial_state_do_not_bypass_validation(self):
        for change in (lambda d:d.update(schema_version=True),lambda d:d.update(extra='x'),
                       lambda d:d.update(revision=2),lambda d:d.update(monthly_limit_seconds=27000)):
            doc=self.historical();change(doc)
            with self.subTest(change=change),self.assertRaises(m.AdmissionError):
                m.transition(doc,self.command(),now=NOW)

    def test_cas_race_has_single_winner_and_no_dispatch(self):
        store=MemoryStore(self.used());store.barrier=threading.Barrier(2)
        def go():
            try:return m.transact(store,self.command(),now=NOW)
            except m.CASConflict:return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:go(),range(2)))
        self.assertEqual(sum(r is not None for r in results),1)
        self.assertTrue(all(r is None or r.effect is None for r in results))
        self.assertEqual(store.document['monthly_limit_seconds'],25200)

    def test_unknown_commit_is_not_retried_and_exact_readback_replay_has_no_effect(self):
        store=MemoryStore(self.used());store.lose_response=True
        with self.assertRaises(m.CommitOutcomeUnknown):m.transact(store,self.command(),now=NOW)
        self.assertEqual(store.cas_count,1)
        store.lose_response=False
        outcome=m.transact(store,self.command(),now=NOW)
        self.assertFalse(outcome.changed);self.assertIsNone(outcome.effect);self.assertEqual(store.cas_count,1)
        with self.assertRaises(m.AdmissionError):
            m.transact(store,self.command(evidence_sha256='b'*64),now=NOW)

    def test_reduction_does_not_reset_any_future_month_usage(self):
        doc=self.used(400)
        later=NOW+timedelta(days=32)
        second=observation('FAILURE',build='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',start=later-timedelta(minutes=74),seconds=4440)
        # Construct historical native usage which is valid in each distinct month.
        doc['external_builds'][second['build_id']]={'observation':second}
        doc['updated_at']=m.stamp(later)
        before=m.budget_usage_historical(doc,now=later)
        out=m.transition(doc,self.command(),now=later).document
        self.assertEqual(m.budget_usage(out,now=later),before)
        self.assertEqual(set(before),{'2026-10','2026-11'})

    def test_new_bootstrap_is_1200_but_missing_durable_store_never_resets(self):
        self.assertEqual(m.new_ledger()['monthly_limit_seconds'],72000)
        store=MemoryStore()
        with self.assertRaisesRegex(m.AdmissionError,'LEDGER_MISSING_NO_RESET'):
            m.transact(store,self.command(),now=NOW)
        self.assertEqual(store.cas_count,0)


class PoolExtensionTests(unittest.TestCase):
    """2026-10-18: the owner raised the pool from 420 to 1,200 minutes per month."""
    def command(self, **changes):
        return {'op': 'raise_monthly_limit', 'from_seconds': 25200, 'to_seconds': 72000,
                'evidence_sha256': 'c'*64, 'native_verified': True, **changes}

    def reduced(self, minutes=355, when=NOW):
        # The native shape of the live ledger: reduced on 11-oct, then operated.
        obs = observation('FAILURE', start=when-timedelta(minutes=minutes), seconds=minutes*60)
        doc = step(m.new_ledger(), 'account_external', now=when, observation=obs, native_verified=True).document
        doc['monthly_limit_seconds'] = 28800
        reduce = {'op':'reduce_monthly_limit','from_seconds':28800,'to_seconds':25200,'evidence_sha256':'a'*64,'native_verified':True}
        doc = m.transition(doc, reduce, now=when).document
        m.validate_ledger(doc)
        return doc

    def test_extension_preserves_history_adds_receipt_and_opens_the_pool(self):
        doc = self.reduced()
        prior = deepcopy(doc)
        with self.assertRaisesRegex(m.AdmissionError, 'MONTHLY_POOL_EXCEEDED'):
            step(approved(deepcopy(doc)), 'reserve', admission=admission())
        out = m.transition(doc, self.command(), now=NOW)
        self.assertIsNone(out.proposed_effect); self.assertIsNone(out.attempt_id)
        self.assertEqual(doc, prior)
        for key in ('attempts','events','external_builds','active_attempt','blocked','limit_reduction'):
            self.assertEqual(out.document[key], prior[key])
        self.assertEqual(out.document['monthly_limit_seconds'], 72000)
        self.assertEqual(out.document['revision'], prior['revision']+1)
        self.assertEqual(out.document['limit_extension'], {
            'from_seconds':25200,'to_seconds':72000,'evidence_sha256':'c'*64,'extended_at':m.stamp(NOW)})
        usage = m.budget_usage(out.document, now=NOW)['2026-10']
        self.assertEqual(usage['confirmed_seconds'], 355*60)
        # The same 95-minute reservation that the reduced pool refused is now admitted.
        admitted = step(approved(out.document), 'reserve', admission=admission()).document
        self.assertEqual(m.budget_usage(admitted, now=NOW)['2026-10']['total_seconds'], 355*60+5700)

    def test_only_fixed_extension_and_native_evidence_shape(self):
        for change in ({'from_seconds':28800},{'to_seconds':60000},{'to_seconds':True},{'from_seconds':True},
                       {'native_verified':1},{'native_verified':False},{'evidence_sha256':'bad'},{'reset':False}):
            store=MemoryStore(self.reduced())
            with self.subTest(change=change),self.assertRaises(m.AdmissionError):
                m.transact(store,self.command(**change),now=NOW)
            self.assertEqual(store.cas_count,0)
        with self.assertRaisesRegex(m.AdmissionError,'REDUCED_POOL_REQUIRED'):
            m.transition(m.new_ledger(),self.command(),now=NOW)
        historical = m.new_ledger(); historical['monthly_limit_seconds'] = 28800
        with self.assertRaisesRegex(m.AdmissionError,'OPERATING_POOL_REDUCTION_REQUIRED'):
            m.transition(historical,self.command(),now=NOW)

    def test_active_blocked_reject_without_cas(self):
        base = self.reduced()
        active = approved(self.reduced(200)); active = step(active,'reserve',admission=admission()).document
        blocked = deepcopy(base); blocked['blocked'] = {'reason':'STOP','evidence_sha256':'8'*64}
        for doc, code in ((active,'LIMIT_EXTENSION_ACTIVE_ATTEMPT'),(blocked,'LIMIT_EXTENSION_BLOCKED')):
            store=MemoryStore(doc)
            with self.subTest(code=code),self.assertRaisesRegex(m.AdmissionError,code):
                m.transact(store,self.command(),now=NOW+timedelta(seconds=2))
            self.assertEqual(store.cas_count,0)

    def test_same_evidence_replay_no_write_changed_evidence_rejected(self):
        store=MemoryStore(self.reduced())
        first=m.transact(store,self.command(),now=NOW)
        replay=m.transact(store,self.command(),now=NOW+timedelta(seconds=2))
        self.assertFalse(replay.changed);self.assertIsNone(replay.effect)
        self.assertEqual(store.cas_count,1);self.assertEqual(first.document,replay.document)
        with self.assertRaisesRegex(m.AdmissionError,'LIMIT_EXTENSION_EVIDENCE_CHANGED'):
            m.transact(store,self.command(evidence_sha256='d'*64),now=NOW)
        self.assertEqual(store.cas_count,1)

    def test_durable_receipt_policy_and_chronology_corruption_rejected(self):
        base=m.transition(self.reduced(),self.command(),now=NOW).document
        changes=(lambda d:d['limit_extension'].update(from_seconds=28800),
                 lambda d:d['limit_extension'].update(to_seconds=True),
                 lambda d:d['limit_extension'].update(evidence_sha256='bad'),
                 lambda d:d['limit_extension'].update(extended_at=m.stamp(NOW+timedelta(seconds=1))),
                 lambda d:d['limit_extension'].update(refund=True),
                 lambda d:d.update(monthly_limit_seconds=25200),
                 lambda d:d.update(monthly_limit_seconds=28800),
                 lambda d:d.__delitem__('limit_extension'),
                 lambda d:d['limit_reduction'].update(reduced_at=m.stamp(NOW+timedelta(seconds=1))))
        for change in changes:
            doc=deepcopy(base);change(doc)
            with self.subTest(change=change),self.assertRaises(m.AdmissionError):m.validate_ledger(doc)
        # Without the extension receipt the reduced document still validates at 420.
        back=deepcopy(base); del back['limit_extension']; back['monthly_limit_seconds']=25200
        m.validate_ledger(back)

    def test_reduction_can_no_longer_follow_the_extension(self):
        base=m.transition(self.reduced(),self.command(),now=NOW).document
        reduce={'op':'reduce_monthly_limit','from_seconds':28800,'to_seconds':25200,'evidence_sha256':'e'*64,'native_verified':True}
        with self.assertRaisesRegex(m.AdmissionError,'LIMIT_REDUCTION_EVIDENCE_CHANGED'):
            m.transition(base,reduce,now=NOW)

    def test_cas_race_has_single_winner_and_no_dispatch(self):
        store=MemoryStore(self.reduced());store.barrier=threading.Barrier(2)
        def go():
            try:return m.transact(store,self.command(),now=NOW)
            except m.CASConflict:return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:go(),range(2)))
        self.assertEqual(sum(r is not None for r in results),1)
        self.assertTrue(all(r is None or r.effect is None for r in results))
        self.assertEqual(store.document['monthly_limit_seconds'],72000)

    def test_unknown_commit_is_not_retried_and_exact_readback_replay_has_no_effect(self):
        store=MemoryStore(self.reduced());store.lose_response=True
        with self.assertRaises(m.CommitOutcomeUnknown):m.transact(store,self.command(),now=NOW)
        self.assertEqual(store.cas_count,1)
        store.lose_response=False
        outcome=m.transact(store,self.command(),now=NOW)
        self.assertFalse(outcome.changed);self.assertIsNone(outcome.effect);self.assertEqual(store.cas_count,1)

    def test_extension_does_not_reset_any_month_usage(self):
        doc=self.reduced(400)
        later=NOW+timedelta(days=32)
        second=observation('FAILURE',build='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',start=later-timedelta(minutes=74),seconds=4440)
        doc['external_builds'][second['build_id']]={'observation':second}
        doc['updated_at']=m.stamp(later)
        before=m.budget_usage(doc,now=later)
        out=m.transition(doc,self.command(),now=later).document
        self.assertEqual(m.budget_usage(out,now=later),before)
        self.assertEqual(set(before),{'2026-10','2026-11'})



class SecondPoolExtensionTests(unittest.TestCase):
    """2026-10-20: the owner raised the pool from 1,200 to 1,500 minutes per month."""
    def command(self, **changes):
        return {'op': 'raise_monthly_limit_second', 'from_seconds': 72000, 'to_seconds': 90000,
                'evidence_sha256': 'f'*64, 'native_verified': True, **changes}

    def extended(self, minutes=1133, when=NOW):
        # The live shape: reduced on 11-oct, extended to 1,200 on 18-oct, then operated.
        early = when - timedelta(hours=3)
        obs = observation('FAILURE', start=early-timedelta(minutes=74), seconds=74*60)
        doc = step(m.new_ledger(), 'account_external', now=early, observation=obs, native_verified=True).document
        doc['monthly_limit_seconds'] = 28800
        reduce = {'op':'reduce_monthly_limit','from_seconds':28800,'to_seconds':25200,'evidence_sha256':'a'*64,'native_verified':True}
        doc = m.transition(doc, reduce, now=early).document
        raise_ = {'op':'raise_monthly_limit','from_seconds':25200,'to_seconds':72000,'evidence_sha256':'c'*64,'native_verified':True}
        doc = m.transition(doc, raise_, now=early).document
        rest = observation('FAILURE', build='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', start=when-timedelta(minutes=minutes-74),
                           seconds=(minutes-74)*60)
        doc = step(doc, 'account_external', now=when, observation=rest, native_verified=True).document
        m.validate_ledger(doc)
        return doc

    def test_second_extension_preserves_history_and_admits_one_more_full(self):
        doc = self.extended(); prior = deepcopy(doc)
        with self.assertRaisesRegex(m.AdmissionError, 'MONTHLY_POOL_EXCEEDED'):
            step(approved(deepcopy(doc)), 'reserve', admission=admission())
        out = m.transition(doc, self.command(), now=NOW)
        self.assertIsNone(out.proposed_effect); self.assertEqual(doc, prior)
        for key in ('attempts','events','external_builds','active_attempt','blocked','limit_reduction','limit_extension'):
            self.assertEqual(out.document[key], prior[key])
        self.assertEqual(out.document['monthly_limit_seconds'], 90000)
        self.assertEqual(out.document['limit_second_extension'], {
            'from_seconds':72000,'to_seconds':90000,'evidence_sha256':'f'*64,'extended_at':m.stamp(NOW)})
        self.assertEqual(m.budget_usage(out.document, now=NOW), m.budget_usage(prior, now=NOW))
        admitted = step(approved(out.document), 'reserve', admission=admission()).document
        self.assertEqual(m.budget_usage(admitted, now=NOW)['2026-10']['total_seconds'], 1133*60+5700)

    def test_born_at_1200_without_receipt_can_also_extend(self):
        obs = observation('FAILURE', start=NOW-timedelta(minutes=10), seconds=600)
        doc = step(m.new_ledger(), 'account_external', observation=obs, native_verified=True).document
        out = m.transition(doc, self.command(), now=NOW).document
        m.validate_ledger(out); self.assertEqual(out['monthly_limit_seconds'], 90000)

    def test_only_fixed_extension_from_the_1200_pool(self):
        for change in ({'from_seconds':25200},{'to_seconds':120000},{'to_seconds':True},{'native_verified':False},
                       {'native_verified':1},{'evidence_sha256':'bad'},{'reset':False}):
            store = MemoryStore(self.extended())
            with self.subTest(change=change), self.assertRaises(m.AdmissionError):
                m.transact(store, self.command(**change), now=NOW)
            self.assertEqual(store.cas_count, 0)
        reduced = self.extended(); del reduced['limit_extension']; reduced['monthly_limit_seconds'] = 25200
        with self.assertRaisesRegex(m.AdmissionError, 'EXTENDED_POOL_REQUIRED'):
            m.transition(reduced, self.command(), now=NOW)

    def test_active_or_blocked_rejects_without_cas(self):
        active = step(approved(self.extended(600)), 'reserve', admission=admission()).document
        blocked = self.extended(); blocked['blocked'] = {'reason':'STOP','evidence_sha256':'8'*64}
        for doc, code in ((active,'LIMIT_EXTENSION_ACTIVE_ATTEMPT'),(blocked,'LIMIT_EXTENSION_BLOCKED')):
            store = MemoryStore(doc)
            with self.subTest(code=code), self.assertRaisesRegex(m.AdmissionError, code):
                m.transact(store, self.command(), now=NOW+timedelta(seconds=2))
            self.assertEqual(store.cas_count, 0)

    def test_replay_and_changed_evidence(self):
        store = MemoryStore(self.extended())
        m.transact(store, self.command(), now=NOW)
        replay = m.transact(store, self.command(), now=NOW+timedelta(seconds=2))
        self.assertFalse(replay.changed); self.assertEqual(store.cas_count, 1)
        with self.assertRaisesRegex(m.AdmissionError, 'LIMIT_SECOND_EXTENSION_EVIDENCE_CHANGED'):
            m.transact(store, self.command(evidence_sha256='d'*64), now=NOW)
        self.assertEqual(store.cas_count, 1)

    def test_durable_receipt_and_implicit_growth_rejected(self):
        base = m.transition(self.extended(), self.command(), now=NOW).document
        changes = (lambda d: d['limit_second_extension'].update(from_seconds=25200),
                   lambda d: d['limit_second_extension'].update(to_seconds=120000),
                   lambda d: d['limit_second_extension'].update(evidence_sha256='bad'),
                   lambda d: d['limit_second_extension'].update(extended_at=m.stamp(NOW+timedelta(seconds=1))),
                   lambda d: d['limit_second_extension'].update(refund=True),
                   lambda d: d['limit_extension'].update(extended_at=m.stamp(NOW+timedelta(seconds=1))),
                   lambda d: d.update(monthly_limit_seconds=72000),
                   lambda d: d.__delitem__('limit_second_extension'))
        for change in changes:
            doc = deepcopy(base); change(doc)
            with self.subTest(change=change), self.assertRaises(m.AdmissionError):
                m.validate_ledger(doc)
        grown = self.extended(); grown['monthly_limit_seconds'] = 90000
        with self.assertRaisesRegex(m.AdmissionError, 'LIMIT_SECOND_EXTENSION_RECEIPT_REQUIRED'):
            m.validate_ledger(grown)
        first = {'op':'raise_monthly_limit','from_seconds':25200,'to_seconds':72000,'evidence_sha256':'c'*64,'native_verified':True}
        self.assertFalse(m.transition(base, first, now=NOW).changed)

if __name__ == '__main__':
    unittest.main()
