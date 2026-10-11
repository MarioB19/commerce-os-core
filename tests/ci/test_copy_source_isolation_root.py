import copy
import datetime as dt
import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
import uuid

HERE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(HERE / 'scripts'))
import copy_source_isolation_root as core


def ref(path, raw):
    return {'path': path, 'bytes': len(raw), 'sha256': core.digest(raw)}


class RootIssuerContracts(unittest.TestCase):
    def setUp(self):
        self.now = dt.datetime(2026, 10, 8, 10, 0, 0, tzinfo=dt.timezone.utc)
        self.billing = {'schema_version': 1, 'recorded_at_utc': '2026-10-08T09:59:00Z',
            'status': 'ACTUAL_READONLY_SOURCE_BILLING_OBSERVED', 'source_project': 'vibe-conversa-prod',
            'credential_account': 'synthetic-billing@example.invalid',
            'native_method': 'gcloud billing projects describe vibe-conversa-prod --format=json(projectId,billingEnabled)',
            'native_response': {'projectId': 'vibe-conversa-prod', 'billingEnabled': False},
            'identity_verified_by': 'gcloud auth list ACTIVE actual output in the same Cloud Shell terminal',
            'cloud_mutations': 0, 'primary_devices_revoked': False, 'primary_revocation_evidence': 'PENDING_HUMAN_USER_DEFERRED',
            'live_compute_state_observed': False, 'docker_container_stop_attested': False,
            'screenshot': 'synthetic.jpg', 'authorizes_session_or_sending': False}
        self.billing_raw = core.canonical(self.billing)
        self.control = {'schema_version': 1, 'action': 'prepare', 'candidate_sha': 'a' * 40,
            'migration67_sha256': 'b' * 64, 'adoption_ref': ref(core.PRIVATE + '/api-web-adoption.json', b'synthetic'),
            'billing_ref': ref(core.EVIDENCE + 'synthetic-billing.json', self.billing_raw),
            'challenge_id': str(uuid.uuid4()), 'ttl_seconds': 3600,
            'binding': {'account_id': str(uuid.uuid4()), 'workspace_id': 'synthetic-workspace', 'account_version': 1,
                'session_id': str(uuid.uuid4()), 'session_revision': 1, 'previous_owner_id': 'synthetic-old-owner',
                'generation': 3, 'credential_generation': 1, 'primary_device_id': 'synthetic-primary',
                'responsible_user_id': 'synthetic-user', 'gateway_id': 'synthetic-gateway',
                'remote_session_name': 'synthetic-default', 'expected_identity_fingerprint': None}}

    def billing_value(self, changed):
        value = copy.deepcopy(self.billing); changed(value); raw = core.canonical(value)
        return core.validate_billing(raw, ref(core.EVIDENCE + 'synthetic-billing.json', raw), self.now, expected_actor="synthetic-billing@example.invalid")

    def human(self):
        common = {'challenge_id': self.control['challenge_id'], 'account_id': self.control['binding']['account_id'],
            'workspace_id': 'synthetic-workspace', 'actor_user_id': 'synthetic-user',
            'responsible_user_id': 'synthetic-user', 'primary_device_id': 'synthetic-primary',
            'performed_at': '2026-10-08T09:59:10Z', 'confirmation': core.CONFIRMATION}
        source = {'schema_version': 1, 'kind': 'DIRECT_HUMAN_PRIMARY_DEVICE_CONFIRMATION', **common,
            'received_at': '2026-10-08T09:59:20Z', 'source_message_id': 'synthetic-source',
            'statement': 'Synthetic explicit human statement; no real phone action occurred.'}
        message_raw = core.canonical(source)
        doc = {'schema_version': 1, 'status': 'HUMAN_PRIMARY_DEVICE_REVOCATION_ATTESTED', **common,
            'recorded_at': '2026-10-08T09:59:30Z', 'canonical_event_id': str(uuid.uuid4()),
            'idempotency_key': 'synthetic-key', 'authentication_method': 'personal_access_token',
            'credential_id': str(uuid.uuid4()), 'source_message_ref': ref(core.EVIDENCE + 'synthetic-source.json', message_raw)}
        human_raw = core.canonical(doc); control = self.control | {'action': 'finalize', 'human_ref': ref(core.EVIDENCE + 'synthetic-human.json', human_raw)}
        return control, doc, source, human_raw, message_raw

    def test_valid_closed_prepare(self):
        self.assertEqual(core.validate_control(self.control), self.control)
        self.assertEqual(core.validate_billing(self.billing_raw, self.control['billing_ref'], self.now, expected_actor="synthetic-billing@example.invalid")['technical_evidence_sha256'], core.digest(self.billing_raw))

    def test_unknown_approval_flags_cannot_substitute_proof(self):
        for field in ('approved', 'api_proof', 'human_verified', 'test_mode'):
            with self.subTest(field=field), self.assertRaisesRegex(core.IsolationError, 'CONTROL_FIELDS'):
                core.validate_control(self.control | {field: True})

    def test_strict_stdin_limit_and_duplicate_fields(self):
        with self.assertRaisesRegex(core.IsolationError, 'INPUT_BOUND'): core.parse(b' ' * (core.MAX_INPUT + 1))
        with self.assertRaisesRegex(core.IsolationError, 'DUPLICATE_FIELD'): core.parse(b'{"a":1,"a":2}')
        with self.assertRaisesRegex(core.IsolationError, 'JSON_INVALID'): core.parse(b'{"a":NaN}')

    def test_identifiers_versions_and_ttl_closed(self):
        for field, value in (('ttl_seconds', 43201), ('ttl_seconds', True), ('candidate_sha', 'a' * 39), ('challenge_id', 'invalid')):
            with self.subTest(field=field), self.assertRaises(core.IsolationError): core.validate_control(self.control | {field: value})
        changed = copy.deepcopy(self.control); changed['binding']['credential_generation'] = True
        with self.assertRaises(core.IsolationError): core.validate_control(changed)

    def test_private_reference_paths(self):
        for path in ('/tmp/synthetic.json', core.EVIDENCE + '../escape.json', core.EVIDENCE + 'x.json/child', core.EVIDENCE + 'x.json\n'):
            with self.subTest(path=path), self.assertRaises(core.IsolationError): core.evidence_reference(ref(path, b'{}'))

    def test_native_billing_cannot_be_asset_snapshot_service_identity_or_truthy_flag(self):
        changes = [lambda b: b.update(native_method='Asset Inventory indexed snapshot'),
            lambda b: b.update(credential_account='synthetic-service@example.invalid'),
            lambda b: b['native_response'].update(billingEnabled=0),
            lambda b: b['native_response'].update(billingEnabled=True),
            lambda b: b.update(docker_container_stop_attested=True),
            lambda b: b.update(cloud_mutations=False)]
        for change in changes:
            with self.subTest(change=change), self.assertRaisesRegex(core.IsolationError, 'NATIVE_BILLING'): self.billing_value(change)

    def test_technical_freshness_has_strict_24h_bound_and_rejects_future(self):
        for at in ('2026-10-07T10:00:00Z', '2026-10-08T10:00:01Z'):
            with self.subTest(at=at), self.assertRaisesRegex(core.IsolationError, 'TECHNICAL_EVIDENCE_EXPIRED'):
                self.billing_value(lambda b: b.update(recorded_at_utc=at))

    def test_billing_reference_digest_cannot_be_changed(self):
        with self.assertRaisesRegex(core.IsolationError, 'BILLING_CHANGED'):
            core.validate_billing(self.billing_raw + b' ', self.control['billing_ref'], self.now, expected_actor="synthetic-billing@example.invalid")

    def test_human_is_a_separate_bound_original_source(self):
        c, _, _, human, message = self.human()
        verified = core.validate_human(human, c['human_ref'], message, c, self.now)
        self.assertEqual(verified['human_evidence_sha256'], core.digest(human))
        self.assertEqual(verified['source_message_sha256'], core.digest(message))

    def test_human_generic_permission_or_service_source_rejected(self):
        c, doc, source, _, _ = self.human()
        for changed in ({'confirmation': 'AUTHORIZED_MIGRATION'}, {'authentication_method': 'service_token'}):
            value = doc | changed; human = core.canonical(value); changed_control = c | {'human_ref': ref(c['human_ref']['path'], human)}
            with self.subTest(changed=changed), self.assertRaisesRegex(core.IsolationError, 'EXPLICIT_HUMAN'):
                core.validate_human(human, changed_control['human_ref'], core.canonical(source), changed_control, self.now)

    def test_changed_source_account_actor_and_action_time_rejected(self):
        c, doc, source, _, _ = self.human()
        for field, value in (('account_id', str(uuid.uuid4())), ('actor_user_id', 'synthetic-other'), ('performed_at', '2026-10-08T09:59:11Z')):
            changed_source = source | {field: value}; message = core.canonical(changed_source)
            changed_doc = doc | {'source_message_ref': ref(doc['source_message_ref']['path'], message)}
            human = core.canonical(changed_doc); changed_control = c | {'human_ref': ref(c['human_ref']['path'], human)}
            with self.subTest(field=field), self.assertRaises(core.IsolationError):
                core.validate_human(human, changed_control['human_ref'], message, changed_control, self.now)

    def test_human_recording_cannot_precede_action_or_be_future(self):
        c, doc, _, _, message = self.human()
        for at in ('2026-10-08T09:59:00Z', '2026-10-08T10:00:01Z'):
            human = core.canonical(doc | {'recorded_at': at}); changed_control = c | {'human_ref': ref(c['human_ref']['path'], human)}
            with self.subTest(at=at), self.assertRaisesRegex(core.IsolationError, 'HUMAN_TIME'):
                core.validate_human(human, changed_control['human_ref'], message, changed_control, self.now)

    def test_finalize_requires_human_and_digest_covers_exact_intent(self):
        c, _, _, human_raw, message = self.human(); technical = core.validate_billing(self.billing_raw, c['billing_ref'], self.now, expected_actor="synthetic-billing@example.invalid")
        with self.assertRaisesRegex(core.IsolationError, 'HUMAN_REQUIRED_FOR_FINALIZE'): core.sql_payload(c, technical)
        human = core.validate_human(human_raw, c['human_ref'], message, c, self.now)
        one = core.sql_payload(c, technical, human)
        two = core.sql_payload(c | {'candidate_sha': 'c' * 40}, technical, human)
        self.assertNotEqual(one['evidence_sha256'], two['evidence_sha256'])

    def test_sql_only_allowed_writes_and_hex_serialization(self):
        technical = core.validate_billing(self.billing_raw, self.control['billing_ref'], self.now, expected_actor="synthetic-billing@example.invalid")
        sql = core.transaction_sql(core.sql_payload(self.control, technical))
        self.assertIn('clock_timestamp()', sql); self.assertIn('pg_advisory_xact_lock', sql)
        self.assertLess(sql.index("pg_advisory_xact_lock_shared(hashtextextended('operations:'"),
                        sql.index("pg_advisory_xact_lock(hashtextextended('channel-command:'"))
        last_authority = sql.index("ISOLATION_CANONICAL_REPLAY_REQUIRED")
        final_deadline = sql.index('tick:=clock_timestamp();', last_authority)
        self.assertLess(last_authority, final_deadline)
        self.assertLess(final_deadline, sql.index('IF c.completed_receipt_id IS NOT NULL THEN', final_deadline))
        for target in ('records', 'channel_sessions', 'session_ownership', 'commands', 'outbox', 'memberships', 'operational_settings'):
            self.assertNotIn('UPDATE public.' + target + ' ', sql)
            self.assertNotIn('INSERT INTO public.' + target + '(', sql)
        self.assertNotIn('DELETE ', sql); self.assertNotIn('GRANT ', sql)
        self.assertIn('UPDATE public.copy_source_isolation_challenges SET completed_receipt_id', sql)
        self.assertNotIn('synthetic-primary', sql)  # data is carried by hex, not SQL interpolation

    def test_root_cli_fails_closed_on_this_non_root_mac_without_reading_files(self):
        if sys.platform == 'linux' and hasattr(__import__('os'), 'geteuid') and __import__('os').geteuid() == 0:
            self.skipTest('This check is specifically the non-Root execution boundary')
        result = subprocess.run([sys.executable, '-I', str(HERE / 'scripts/copy-source-isolation-root.py')], input=b'{}', capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(core.parse(result.stdout)['code'], 'ISOLATION_ROOT_LINUX_STDIN_ONLY')
        self.assertEqual(result.stderr, b'')


if __name__ == '__main__':
    unittest.main()
