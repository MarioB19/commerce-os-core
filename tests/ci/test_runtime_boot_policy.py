"""Boot policy adversarial tests; no host or physical connection claim."""
import copy
import sys
from pathlib import Path
import unittest

sys.path[:0] = [str(Path(__file__).resolve().parents[2]/'scripts'), str(Path(__file__).parent)]
import runtime_boot_policy as boot
import copy_runtime_deployment as runtime
from ci_release import ReleaseError
from test_copy_runtime_deployment import fixture, ref, refresh

BOOT = '133d632f-e93c-4d36-9887-a1eb2b9bd366'


class BootPolicyTests(unittest.TestCase):
    def setUp(self):
        self.state, self.rows, self.plan = fixture(2)
        for row in self.rows:
            row['State']['OOMKilled'] = False
        self.raw = runtime.sealed_bytes(self.state)
        self.policy = {'schema_version': 1, 'host_id': '123456',
            'adoption_ref': ref(boot.ADOPTION, self.raw), 'plan_ref': ref(boot.PLAN, self.plan),
            'gateway_start_ids': {'waha-01': self.rows[-2]['Id']}, 'sessions_autostart': False}
        self.journal = {'schema_version': 1, 'boot_id': BOOT,
            'policy_sha256': runtime.sha256(runtime.sealed_bytes(self.policy)), 'gateways': {}}

    def decide(self):
        return boot.decisions(self.policy, host_id='123456', adoption_raw=self.raw,
            plan_raw=self.plan, rows=self.rows, journal=self.journal, boot_id=BOOT)

    def attempt(self, status='START_INTENT'):
        self.journal['gateways']['waha-01'] = {
            'container_id': self.rows[-2]['Id'], 'status': status}

    def running(self, row):
        row['State'].update(Running=True, Pid=777)

    def test_starts_only_explicit_gateway_never_other_containers_or_sessions(self):
        result = self.decide()
        self.assertEqual(result, [{'service': 'waha-01', 'container_id': self.rows[-2]['Id'],
                                  'action': 'PERSIST_INTENT_THEN_START_ONCE'}])

    def test_unknown_dispatch_cannot_repeat_when_daemon_reports_stopped(self):
        self.attempt()
        with self.assertRaisesRegex(ReleaseError, 'BOOT_START_UNCERTAIN'):
            self.decide()

    def test_lost_success_response_can_only_reconcile_same_healthy_container(self):
        self.attempt(); self.running(self.rows[-2])
        self.assertEqual(self.decide()[0]['action'], 'RECONCILE_RUNNING')

    def test_already_running_server_is_observed_without_another_start(self):
        self.running(self.rows[-2])
        self.assertEqual(self.decide()[0]['action'], 'OBSERVE_RUNNING')

    def test_recrash_same_boot_does_not_reset_consumed_attempt(self):
        self.attempt('RUNNING')
        with self.assertRaisesRegex(ReleaseError, 'BOOT_START_UNCERTAIN'):
            self.decide()

    def test_new_boot_cannot_reuse_old_journal_or_changed_policy(self):
        for field, value in [('boot_id', 'dffab729-085c-471d-9ad5-f599794f8e92'),
                             ('policy_sha256', 'f'*64)]:
            with self.subTest(field=field):
                original = self.journal[field]; self.journal[field] = value
                with self.assertRaises(ReleaseError): self.decide()
                self.journal[field] = original

    def test_stale_adoption_and_b02_bytes_are_not_rebased(self):
        for field in ('raw', 'plan'):
            original = getattr(self, field); setattr(self, field, original+b' ')
            with self.subTest(field=field), self.assertRaises(ReleaseError): self.decide()
            setattr(self, field, original)

    def test_gateway_image_mount_id_and_network_changes_fail_closed(self):
        for field, value in [('Image', 'sha256:'+'e'*64), ('Id', 'd'*64),
                             ('Mounts', [{'Destination': '/foreign'}]), ('NetworkSettings', {'Networks': {}})]:
            row = self.rows[-2]; original = row[field]; row[field] = value
            with self.subTest(field=field), self.assertRaises(ReleaseError): self.decide()
            row[field] = original

    def test_even_freshly_pinned_session_autostart_cannot_pass(self):
        self.rows[-2]['Config']['Env'][4] = 'WHATSAPP_RESTART_ALL_SESSIONS=true'
        self.plan = refresh(self.state, self.rows); self.raw = runtime.sealed_bytes(self.state)
        self.policy['plan_ref'] = ref(boot.PLAN, self.plan)
        self.policy['adoption_ref'] = ref(boot.ADOPTION, self.raw)
        with self.assertRaises(ReleaseError): self.decide()

    def test_unhealthy_core_prevents_gateway_effects(self):
        for patch in ({'OOMKilled': True}, {'Health': {'Status': 'starting'}},
                      {'Running': False, 'Pid': 0}):
            before = copy.deepcopy(self.rows[0]['State']); self.rows[0]['State'].update(patch)
            with self.subTest(patch=patch), self.assertRaises(ReleaseError): self.decide()
            self.rows[0]['State'] = before

    def test_missing_configured_health_is_not_running_success(self):
        self.rows[0]['Config']['Healthcheck'] = {'Test': ['CMD', 'synthetic-health']}
        self.plan = refresh(self.state, self.rows); self.raw = runtime.sealed_bytes(self.state)
        self.policy['plan_ref'] = ref(boot.PLAN, self.plan)
        self.policy['adoption_ref'] = ref(boot.ADOPTION, self.raw)
        with self.assertRaisesRegex(ReleaseError, 'BOOT_PROCESS_NOT_HEALTHY'): self.decide()

    def test_journal_cannot_add_unapproved_gateway_or_change_cid(self):
        self.attempt(); self.journal['gateways']['waha-01']['container_id'] = 'f'*64
        with self.assertRaises(ReleaseError): self.decide()
        self.attempt(); self.journal['gateways']['waha-02'] = dict(self.journal['gateways']['waha-01'])
        with self.assertRaises(ReleaseError): self.decide()


if __name__ == '__main__': unittest.main()
