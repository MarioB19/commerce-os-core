import contextlib
import copy
import sys
from pathlib import Path
import unittest

sys.path[:0] = [str(Path(__file__).resolve().parents[2] / 'scripts'), str(Path(__file__).parent)]
import runtime_boot_runner as runner
from ci_release import ReleaseError
import test_runtime_boot_policy as fixtures

BOOT = fixtures.BOOT


class Adapter:
    def __init__(self):
        fixture = fixtures.BootPolicyTests(); fixture.setUp()
        self.facts = {'policy': fixture.policy, 'host_id': '123456',
            'adoption_raw': fixture.raw, 'plan_raw': fixture.plan,
            'rows': fixture.rows, 'boot_id': BOOT}
        self.journal = fixture.journal
        self.events = []; self.failure = None; self.locked = False
        self.observations = 0; self.change_at = None

    @contextlib.contextmanager
    def locks(self):
        assert not self.locked
        self.locked = True
        try: yield
        finally: self.locked = False

    def observe(self):
        assert self.locked
        self.observations += 1
        value = copy.deepcopy(self.facts)
        if self.observations == self.change_at:
            value['boot_id'] = 'dffab729-085c-471d-9ad5-f599794f8e92'
        return value

    def read_journal(self, _):
        return copy.deepcopy(self.journal)

    def compare_and_swap_journal(self, old, new):
        assert self.locked and old == self.journal
        if self.failure == 'journal': raise RuntimeError('journal unavailable')
        self.journal = copy.deepcopy(new)
        self.events.append(new['gateways']['waha-01']['status'])

    def start_once(self, cid):
        assert self.locked
        assert self.journal['gateways']['waha-01'] == {'container_id': cid, 'status': 'START_INTENT'}
        self.events.append('docker start')
        if self.failure == 'stopped': raise TimeoutError('unknown')
        row = next(v for v in self.facts['rows'] if v['Id'] == cid)
        row['State'].update(Running=True, Pid=123)
        if self.failure == 'running': raise TimeoutError('response lost')

    def wait_healthy(self, _):
        if self.failure == 'health': raise TimeoutError('health pending')

    def complete(self, boot):
        assert boot == BOOT
        self.events.append('complete')


class BootRunnerTests(unittest.TestCase):
    def test_intent_precedes_start_and_success_and_all_effects_locked(self):
        a = Adapter(); result = runner.run(a)
        self.assertEqual(a.events, ['START_INTENT', 'docker start', 'RUNNING', 'complete'])
        self.assertFalse(a.locked); self.assertEqual(result['sessions_started'], 0)

    def test_persistence_failure_prevents_start(self):
        a = Adapter(); a.failure = 'journal'
        with self.assertRaises(RuntimeError): runner.run(a)
        self.assertNotIn('docker start', a.events)

    def test_timeout_stopped_cannot_retry_after_new_invocation(self):
        a = Adapter(); a.failure = 'stopped'
        with self.assertRaises(TimeoutError): runner.run(a)
        a.failure = None
        with self.assertRaisesRegex(ReleaseError, 'BOOT_START_UNCERTAIN'): runner.run(a)
        self.assertEqual(a.events.count('docker start'), 1)

    def test_response_lost_running_is_reconciled_without_second_start(self):
        a = Adapter(); a.failure = 'running'
        with self.assertRaises(TimeoutError): runner.run(a)
        a.failure = None; runner.run(a)
        self.assertEqual(a.events.count('docker start'), 1)
        self.assertEqual(a.journal['gateways']['waha-01']['status'], 'RUNNING')

    def test_health_timeout_keeps_consumed_intent(self):
        a = Adapter(); a.failure = 'health'
        with self.assertRaises(TimeoutError): runner.run(a)
        self.assertEqual(a.journal['gateways']['waha-01']['status'], 'START_INTENT')
        self.assertNotIn('complete', a.events)

    def test_boot_change_before_effect_prevents_dispatch(self):
        a = Adapter(); a.change_at = 2
        with self.assertRaisesRegex(ReleaseError, 'BOOT_ADOPTION_CHANGED'): runner.run(a)
        self.assertEqual(a.events, [])

    def test_boot_change_after_dispatch_cannot_claim_success(self):
        a = Adapter(); a.change_at = 3
        with self.assertRaisesRegex(ReleaseError, 'BOOT_ADOPTION_CHANGED'): runner.run(a)
        self.assertEqual(a.events, ['START_INTENT', 'docker start'])


if __name__ == '__main__': unittest.main()
