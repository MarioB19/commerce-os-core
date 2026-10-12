"""Offline synthetic linked native-shaped originals, never a real backup proof."""
import copy
import datetime as dt
import hashlib
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import privacy_backup_attestation as p
from test_runtime_boot_restore_gate import Fixture as HistoricalFixture, SOURCE, NOW, raw, ref

DEPLOYED = 'c' * 40


class Fixture:
    def __init__(self):
        self.native = HistoricalFixture()
        self.files = {**self.native.docs['source_manifest']['runtime_files'],
            **{'packages/db/migrations/' + k: v for k, v in
               self.native.docs['source_manifest']['migration_files'].items()},
            **{'packages/db/profile-transition/' + n + '_synthetic.sql': 'd' * 64
               for n in p.REQUIRED_TRANSITIONS}}
        run = self.native.docs['root_report']['run_id']
        deployed = {'schema_version': 1, 'kind': 'D18_DEPLOYED_SOURCE_MANIFEST',
            'run_id': run, 'deployed_source_sha': DEPLOYED,
            'backup_source_sha': self.native.docs['root_report']['backup_source_sha'],
            'files': self.files, 'root_report_ref': self.native.refs['root_report']}
        self.put('deployed_sources', deployed)
        roles = [{'name': n, **{flag: False for flag in p.ROLE_FLAGS},
            'connection_limit': -1, 'valid_until': None, 'config': []}
            for n in ('commerce_api', 'commerce_privacy_attestor')]
        memberships = [{'role': 'commerce_api', 'member': 'commerce_privacy_attestor',
            'grantor': 'commerce_api', 'admin_option': False,
            'inherit_option': False, 'set_option': True}]
        for key, phase, target, time in (
            ('source_topology_before', 'SOURCE_BEFORE_BACKUP', 'source-cluster/database', '2026-10-11T12:59:00Z'),
            ('source_topology_after', 'SOURCE_AFTER_BACKUP', 'source-cluster/database', '2026-10-11T13:11:00Z'),
            ('restored_topology', 'RESTORED_DATABASE', 'isolated-cluster/database', '2026-10-11T13:19:00Z')):
            self.put(key, {'schema_version': 1, 'kind': 'D18_NATIVE_TOPOLOGY_READBACK',
                'phase': phase, 'run_id': run, 'target': target,
                'query_sha256': p.QUERY_SHA256, 'source_manifest_ref': self.native.refs['deployed_sources'],
                'ciphertext_sha256': self.native.docs['staging_plan']['files']['ciphertext.backup.aes']['sha256'],
                'restore_receipt_ref': self.native.refs['restore_receipt'] if key == 'restored_topology' else None,
                'result': {'observed_at': time, 'topology_sha256': 'e' * 64,
                           'roles': copy.deepcopy(roles), 'memberships': copy.deepcopy(memberships)}})

    def put(self, key, value):
        return self.native.add(key, value)

    def change(self, key, callback):
        value = copy.deepcopy(self.native.docs[key]); callback(value); self.put(key, value)

    def validate(self, **kwargs):
        args = {'expected_backup_source_sha': 'b' * 40, 'expected_restore_source_sha': SOURCE,
            'expected_deployed_source_sha': DEPLOYED,
            'expected_readback_queries_sha256': self.native.refs['readback_queries']['sha256'],
            'expected_files': self.files, 'source_target': 'source-cluster/database',
            'restored_target': 'isolated-cluster/database', 'now': NOW}
        args.update(kwargs)
        return p.prepare_privacy_backup(self.native.refs, self.native.read, **args)


class PrivacyBackupTests(unittest.TestCase):
    def test_prepares_inert_import_with_conservative_original_deadline(self):
        f = Fixture(); before = copy.deepcopy(f.native.refs); out = f.validate()
        self.assertEqual(out['import_arguments']['snapshot'], '2026-10-11T13:00:00+00:00')
        self.assertEqual(out['valid_until'], '2026-10-12T13:00:00+00:00')
        self.assertEqual(out['import_arguments']['restored'], '2026-10-11T13:20:00+00:00')
        self.assertFalse(out['import_authorized']); self.assertFalse(out['erasure_authorized'])
        self.assertTrue(out['restore_history']['historical_only'])
        self.assertFalse(out['restore_history']['fresh_backup_proven'])
        self.assertEqual(before, f.native.refs)

    def test_all_twenty_originals_are_read_once_on_every_invocation(self):
        f = Fixture(); calls = []; old = f.native.read
        def read(r):
            calls.append(r['path']); return old(r)
        with patch.object(f.native, 'read', side_effect=read):
            f.validate(); f.validate()
        self.assertEqual(len(calls), 40)
        self.assertEqual(len(set(calls)), 20)

    def test_historical_only_inputs_cannot_be_promoted(self):
        f = Fixture(); del f.native.refs['restored_topology']
        with self.assertRaisesRegex(Exception, 'ORIGINAL_SET'): f.validate()

    def test_exact_24h_deadline_rejects_and_replay_never_renews(self):
        f = Fixture(); before = f.validate()
        self.assertEqual(before, f.validate(now=NOW + dt.timedelta(hours=12)))
        for later in (dt.timedelta(hours=13), dt.timedelta(days=10)):
            with self.assertRaisesRegex(Exception, 'WINDOW_EXPIRED'):
                f.validate(now=NOW + later)

    def test_cannot_substitute_archive_or_restore_time_for_snapshot_bound(self):
        f = Fixture(); f.change('source_topology_before', lambda d: d['result'].update(observed_at='2026-10-11T13:00:01Z'))
        with self.assertRaisesRegex(Exception, 'TOPOLOGY_TIME'): f.validate()

    def test_before_after_and_restored_time_bounds(self):
        for key, time in [('source_topology_before', '2026-10-13T00:00:00Z'),
                ('source_topology_after', '2026-10-11T13:09:00Z'),
                ('source_topology_after', '2026-10-11T13:21:00Z'),
                ('restored_topology', '2026-10-11T13:11:00Z'),
                ('restored_topology', '2026-10-11T13:21:00Z')]:
            f = Fixture(); f.change(key, lambda d: d['result'].update(observed_at=time))
            with self.subTest(key=key, time=time), self.assertRaisesRegex(Exception, 'TOPOLOGY_TIME'): f.validate()

    def test_timezone_naive_and_non_utc_observations_reject(self):
        for time in ('2026-10-11T13:19:00', '2026-10-11T07:19:00-06:00'):
            f = Fixture(); f.change('restored_topology', lambda d: d['result'].update(observed_at=time))
            with self.subTest(time=time), self.assertRaises(Exception): f.validate()

    def test_native_target_isolation_and_exact_identity(self):
        with self.assertRaisesRegex(Exception, 'TARGET_ALIAS'):
            Fixture().validate(restored_target='source-cluster/database')
        f = Fixture(); f.change('restored_topology', lambda d: d.update(target='source-cluster/database'))
        with self.assertRaisesRegex(Exception, 'TOPOLOGY_BINDING'): f.validate()

    def test_topology_fingerprint_cannot_omit_owners_acl_or_triggers(self):
        for key in p.EXTRA - {'deployed_sources'}:
            f = Fixture(); f.change(key, lambda d: d['result'].update(topology_sha256='f' * 64))
            with self.subTest(key=key), self.assertRaisesRegex(Exception, 'TOPOLOGY_CHANGED'): f.validate()

    def test_every_role_flag_config_connlimit_and_expiry_is_compared(self):
        for field, value in [(k, True) for k in p.ROLE_FLAGS] + [
                ('config', ['statement_timeout=1000']), ('connection_limit', 2),
                ('valid_until', '2030-01-01T00:00:00Z'), ('name', 'isolated_login')]:
            f = Fixture(); f.change('restored_topology', lambda d: d['result']['roles'][0].update({field: value}))
            with self.subTest(field=field), self.assertRaises(Exception): f.validate()

    def test_extra_or_missing_role_and_membership_reject(self):
        changes = [lambda d: d['result']['roles'].pop(),
            lambda d: d['result']['roles'].append({**d['result']['roles'][0], 'name': 'extra_local_login'}),
            lambda d: d['result']['memberships'].clear(),
            lambda d: d['result']['memberships'][0].update(admin_option=True)]
        for change in changes:
            f = Fixture(); f.change('restored_topology', change)
            with self.assertRaises(Exception): f.validate()

    def test_duplicate_roles_and_memberships_and_truthy_flags_reject(self):
        for change in [lambda d: d['result']['roles'].append(d['result']['roles'][0]),
            lambda d: d['result']['memberships'].append(d['result']['memberships'][0]),
            lambda d: d['result']['roles'][0].update(login=1)]:
            f = Fixture(); f.change('restored_topology', change)
            with self.assertRaises(Exception): f.validate()

    def test_row_order_has_no_authority_but_config_content_is_preserved(self):
        f = Fixture(); before = f.validate()
        f.change('restored_topology', lambda d: d['result']['roles'].reverse())
        after = f.validate()
        self.assertEqual(before['import_arguments']['topology'], after['import_arguments']['topology'])
        self.assertNotEqual(before['import_arguments']['originals'], after['import_arguments']['originals'])

    def test_each_readback_binds_query_dump_run_manifest_and_restore(self):
        for field, value in [('query_sha256', 'f' * 64), ('ciphertext_sha256', 'f' * 64),
                ('run_id', 'gcp-' + 'f' * 32), ('source_manifest_ref', None),
                ('restore_receipt_ref', None), ('phase', 'SOURCE_BEFORE_BACKUP')]:
            f = Fixture(); f.change('restored_topology', lambda d: d.update({field: value}))
            with self.subTest(field=field), self.assertRaisesRegex(Exception, 'TOPOLOGY_BINDING'): f.validate()

    def test_deployment_source_is_independently_expected(self):
        with self.assertRaisesRegex(Exception, 'DEPLOYMENT_CHANGED'):
            Fixture().validate(expected_deployed_source_sha='f' * 40)
        with self.assertRaisesRegex(Exception, 'DEPLOYMENT_CHANGED'):
            Fixture().validate(expected_backup_source_sha='f' * 40)
        with self.assertRaises(Exception):
            Fixture().validate(expected_restore_source_sha='f' * 40)

    def test_readback_safety_contract_requires_independent_adopted_pin(self):
        with self.assertRaisesRegex(Exception, 'READBACK_CONTRACT_CHANGED'):
            Fixture().validate(expected_readback_queries_sha256='f' * 64)
        f = Fixture()
        with patch.object(f.native, 'read', side_effect=AssertionError('NO_READ')):
            with self.assertRaisesRegex(Exception, 'HASH_REQUIRED'):
                f.validate(expected_readback_queries_sha256=None)

    def test_role_names_are_compared_as_native_names_without_regrole_quoting(self):
        f = Fixture()
        for key in p.EXTRA - {'deployed_sources'}:
            def quoted_name(d):
                d['result']['roles'][0]['name'] = 'Native Role'
                d['result']['memberships'][0].update(role='Native Role', grantor='Native Role')
            f.change(key, quoted_name)
        self.assertEqual(f.validate()['status'], 'PRIVACY_BACKUP_IMPORT_PREPARED')
        self.assertNotIn('::regrole', p.TOPOLOGY_SQL)

    def test_every_v7_dependency_and_exact_adopted_sources_are_required(self):
        for number in p.REQUIRED_TRANSITIONS:
            f = Fixture(); altered = dict(f.files); del altered['packages/db/profile-transition/' + number + '_synthetic.sql']
            with self.subTest(number=number), self.assertRaisesRegex(Exception, 'V7_INCOMPLETE'):
                f.validate(expected_files=altered)
        f = Fixture(); altered = dict(f.files); altered['packages/db/profile-transition/032_synthetic.sql'] = 'f' * 64
        with self.assertRaisesRegex(Exception, 'DEPLOYMENT_CHANGED'): f.validate(expected_files=altered)

    def test_historical_migrations_and_restore_tools_must_match(self):
        for key in ('packages/db/migrations/0001_synthetic.sql', 'scripts/restore.mjs'):
            f = Fixture(); files = dict(f.files); files[key] = 'f' * 64
            with self.subTest(key=key), self.assertRaisesRegex(Exception, '(MIGRATIONS|RESTORE_SOURCES)_CHANGED'):
                f.validate(expected_files=files)

    def test_raw_drift_duplicate_json_unknown_fields_and_boolean_schema_reject(self):
        f = Fixture(); f.native.raws[f.native.refs['source_topology_before']['path']] += b' '
        with self.assertRaisesRegex(Exception, 'ORIGINAL_CHANGED'): f.validate()
        f = Fixture(); path = f.native.refs['source_topology_before']['path']; value = b'{"x":1,"x":2}'
        f.native.raws[path] = value; f.native.refs['source_topology_before'] = ref(path, value)
        with self.assertRaisesRegex(Exception, 'DUPLICATE_JSON'): f.validate()
        for change in [lambda d: d.update(authority=True), lambda d: d.update(schema_version=True)]:
            f = Fixture(); f.change('restored_topology', change)
            with self.assertRaises(Exception): f.validate()

    def test_reference_alias_and_total_bound_fail_before_reader(self):
        f = Fixture(); f.native.refs['restored_topology'] = f.native.refs['source_topology_before']
        with patch.object(f.native, 'read', side_effect=AssertionError('NO_READ')):
            with self.assertRaisesRegex(Exception, 'ORIGINAL_BOUND'): f.validate()
        f = Fixture()
        for r in f.native.refs.values(): r['bytes'] = 1024 * 1024
        with patch.object(f.native, 'read', side_effect=AssertionError('NO_READ')):
            with self.assertRaisesRegex(Exception, 'ORIGINAL_BOUND'): f.validate()

    def test_query_contains_native031_fingerprint_and_all_role_boundaries(self):
        self.assertEqual(p.QUERY_SHA256, hashlib.sha256(p.TOPOLOGY_SQL.encode()).hexdigest())
        for fragment in ('privacy_runtime_fingerprint()', 'rolsuper', 'rolcanlogin',
                'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolinherit', 'rolreplication',
                'rolconnlimit', 'rolvaliduntil', 'rolconfig', 'pg_auth_members',
                'admin_option', 'inherit_option', 'set_option'):
            self.assertIn(fragment, p.TOPOLOGY_SQL)


if __name__ == '__main__':
    unittest.main()
