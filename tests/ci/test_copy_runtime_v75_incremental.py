"""V7.5.3: the exact 121→122 post-cutover tail on an OPERATING V7 base (V7.5 was 120→121); synthetic services only."""
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'scripts'))
import copy_runtime_deployment as c
from ci_release import ReleaseError

TAIL = '0122_v753_number_lab_plans.sql'


def history(count=68):
    baseline = {'%04d_fixture.sql'%i: 'a'*64 for i in range(1, 66)}
    if count >= 67: baseline.update({name: 'b'*64 for name in c.MIGRATION_NAMES})
    if count == 68: baseline.update({name: 'c'*64 for name in c.OPERATING_MIGRATION_NAMES})
    return baseline


def v7(): return history() | {name: 'd'*64 for name in c.V7_PROFILE_MIGRATION_NAMES}


def v7_base(): value = v7(); value.pop(TAIL); return value


class V75IncrementalMigration(unittest.TestCase):
    def test_the_tail_is_exactly_the_v74_migration_on_the_v7_base(self):
        self.assertEqual(c.V7_INCREMENTAL_MIGRATION_NAMES, frozenset({TAIL}))
        self.assertTrue(c.V7_INCREMENTAL_MIGRATION_NAMES < c.V7_PROFILE_MIGRATION_NAMES)
        self.assertEqual((c.V7_PROFILE_MIGRATION_TOTAL, c.V7_INCREMENTAL_BASELINE), (122, 121))

    def test_guard_admits_121_to_122_and_keeps_every_previous_boundary(self):
        meta = {'migration_hashes': v7()}
        for applied in (history(), v7_base(), v7()):
            c.migration_stage_guard(applied, meta, stage='OPERATING')
        missing_other = v7(); missing_other.pop('0117_v7_profile_deletion_request.sql')
        changed = v7_base(); changed['0117_v7_profile_deletion_request.sql'] = 'e'*64
        partial = history() | {'0069_v7_cutover_preflight.sql': 'd'*64}
        for applied in (missing_other, changed, partial, v7_base() | {'unreviewed.sql': 'e'*64}):
            with self.subTest(size=len(applied)), self.assertRaises(ReleaseError):
                c.migration_stage_guard(applied, meta, stage='OPERATING')
        for kwargs in ({'initial': True}, {'stage': 'CORE_PREPARED'}, {'stage': 'UNKNOWN'}):
            with self.assertRaises(ReleaseError): c.migration_stage_guard(v7_base(), meta, **kwargs)

    def test_incremental_detection_requires_identical_history(self):
        self.assertTrue(c.v7_incremental_baseline(v7_base(), v7()))
        self.assertFalse(c.v7_incremental_baseline(v7(), v7()))
        self.assertFalse(c.v7_incremental_baseline(history(), v7()))
        drift = v7_base(); drift['0001_fixture.sql'] = 'f'*64
        self.assertFalse(c.v7_incremental_baseline(drift, v7()))

    def test_bounded_script_carries_the_closed_incremental_profile(self):
        self.assertIn("{stage:'OPERATING',baseline:121,total:122,names:[\"" + TAIL + "\"]}", c.BOUNDED_MIGRATION_JS)
        self.assertNotIn('V7_BASE', c.BOUNDED_MIGRATION_JS); self.assertNotIn('V7_INC', c.BOUNDED_MIGRATION_JS)
        self.assertIn("baseline:68,total:122", c.BOUNDED_MIGRATION_JS)

    def test_apply_runs_only_the_tail_without_cutover_work(self):
        expected = v7(); review = {'migration_hashes': {n: expected[n] for n in c.V7_PROFILE_MIGRATION_NAMES}}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); assets = root/'assets'; assets.mkdir()
            (root/'release.env').write_text('COMMERCE_PRIVATE_ASSETS_DIR='+str(assets)+'\nCOMMERCE_IMAGE=commerce-os@sha256:'+'1'*64+'\n')
            (root/'admin.env').write_text('X=1\n')
            calls = {'plan': None, 'tasks': []}; state = {'applied': v7_base()}
            def write(path, value): calls['plan'] = value; Path(path).write_text(json.dumps(value))
            def task(_root, _dir, args, name, timeout):
                calls['tasks'].append((name, args, timeout)); state['applied'] = dict(expected)
            server = types.SimpleNamespace(PRIVATE=root, migrations=lambda _: dict(state['applied']),
                                           _write_report=write, run_deployment_task=task)
            metadata = {'source_sha': 'b'*40, 'migration_hashes': dict(expected)}
            with patch.object(c.native, 'protected_bytes', side_effect=lambda path: Path(path).read_bytes()), \
                 patch.object(c, 'export_retired_modules', side_effect=AssertionError('cutover-only export ran')):
                result = c.apply_reviewed_migrations(server, root, root, metadata, review, 600, stage='OPERATING')
        self.assertEqual(result, {'status': 'APPLIED_BOUNDED_INCREMENTAL', 'migration_count': 122, 'bootstrap_or_import': False,
                                  'applied_migrations': [TAIL], 'lab_storage': 'READY',
                                  'namespace_locks': {'source': 'CREATED', 'laboratory': 'CREATED'}})
        self.assertEqual(calls['plan'], {'stage': 'OPERATING', 'baseline': v7_base(), 'additions': {TAIL: expected[TAIL]}})
        (name, args, timeout), = calls['tasks']
        mounts = [args[i+1] for i, part in enumerate(args) if part == '-v' and '/copy-sql/' in args[i+1]]
        self.assertEqual((name, timeout, len(mounts)), ('copy-migrations', 600, 1))
        self.assertTrue(mounts[0].endswith('/copy-sql/'+TAIL+':ro'))
        # Token versions only move with the 68→117 cutover; the owner comparison stays historical.
        self.assertFalse(c.v7_tokens_migrated(result))


if __name__ == '__main__':
    unittest.main()
