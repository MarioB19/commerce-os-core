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

    def test_480_minute_limit_includes_imported_bootstrap_and_failures(self):
        end = NOW
        observed = observation('FAILURE', start=NOW-timedelta(minutes=386), seconds=386*60)
        doc = step(m.new_ledger(), 'account_external', observation=observed, native_verified=True).document
        doc = approved(doc)
        with self.assertRaisesRegex(m.AdmissionError, 'MONTHLY_POOL_EXCEEDED'):
            step(doc, 'reserve', admission=admission())
        self.assertEqual(m.budget_usage(doc, now=end)['2026-10']['confirmed_seconds'], 386*60)

    def test_exact_480_minutes_is_admitted(self):
        observed = observation('FAILURE', start=NOW-timedelta(minutes=385), seconds=385*60)
        doc = step(m.new_ledger(), 'account_external', observation=observed, native_verified=True).document
        doc = step(approved(doc), 'reserve', admission=admission()).document
        self.assertEqual(m.budget_usage(doc, now=NOW)['2026-10']['total_seconds'], 28800)

    def test_historical_74_minutes_are_preserved_under_reduced_future_pool(self):
        obs = observation('FAILURE', start=NOW-timedelta(minutes=74), seconds=74*60)
        doc = step(m.new_ledger(), 'account_external', observation=obs, native_verified=True).document
        self.assertEqual(doc['monthly_limit_seconds'], 480*60)
        usage = m.budget_usage(doc, now=NOW)['2026-10']
        self.assertEqual(usage['confirmed_seconds'], 74*60)
        self.assertEqual(doc['monthly_limit_seconds']-usage['total_seconds'], 406*60)
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
        docs = [discovered, approved(), reserved(), pending, unknown, bound(),
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


if __name__ == '__main__':
    unittest.main()
