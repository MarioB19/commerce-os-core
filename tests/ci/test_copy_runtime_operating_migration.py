"""67→68 publication boundaries; synthetic services, real private plan writes."""
import contextlib
import io
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'scripts'))
import copy_runtime_deployment as c
import copy_runtime_approvals as a
from ci_release import ReleaseError
from deployment_scope import NO_PORTAL


def history(count=68):
    baseline = {'%04d_fixture.sql'%i: 'a'*64 for i in range(1, 66)}
    if count >= 67: baseline.update({name: 'b'*64 for name in c.MIGRATION_NAMES})
    if count == 68: baseline.update({name: 'c'*64 for name in c.OPERATING_MIGRATION_NAMES})
    return baseline


class OperatingMigration(unittest.TestCase):
    def test_only_exact_reviewed_transition_or_complete_operating_schema(self):
        meta = {'migration_hashes': history()}
        for applied in (history(67), history()):
            c.migration_stage_guard(applied, meta, stage='OPERATING')
        invalid = [history(65), history(67) | {'unreviewed.sql': 'd'*64},
                   {k: 'f'*64 for k in history(67)}]
        for applied in invalid:
            with self.assertRaises(ReleaseError): c.migration_stage_guard(applied, meta, stage='OPERATING')
        for kwargs in ({'initial': True}, {'stage': 'CORE_PREPARED'}, {'stage': 'UNKNOWN'}):
            with self.assertRaises(ReleaseError): c.migration_stage_guard(history(67), meta, **kwargs)
        wrong = history(); wrong['0068_arbitrary.sql'] = wrong.pop(next(iter(c.OPERATING_MIGRATION_NAMES)))
        with self.assertRaises(ReleaseError): c.reviewed_migration_names({'migration_hashes': wrong})
        c.migration_stage_guard(history(65), {'migration_hashes': history(67)}, initial=True)
        c.migration_stage_guard(history(67), {'migration_hashes': history(67)}, stage='CORE_PREPARED')

    def test_same_schema_68_uses_real_candidate_hashes_without_sql_or_new_migration_plan(self):
        # Current V7 candidate still has exactly the historical 68 migrations.
        migrations = Path(__file__).resolve().parents[2]/'packages/db/migrations'
        expected = {p.name: c.sha256(p.read_bytes()) for p in migrations.glob('*.sql')}
        self.assertEqual(len(expected), 68)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); installed = {'source_sha':'a'*40, 'migration_hashes':expected}
            (root/'RELEASE.json').write_text(json.dumps(installed))
            c.installed_migration_identity(root, {'COMMERCE_RELEASE_SHA':'a'*40}, expected)
            server = types.SimpleNamespace(migrations=lambda _:dict(expected),
                _write_report=lambda *_:self.fail('no migration plan write'),
                run_deployment_task=lambda *_:self.fail('no SQL/container dispatch'))
            metadata = {'source_sha':'b'*40, 'migration_hashes':dict(expected)}
            review = {'migration_hashes':{n:expected[n] for n in c.OPERATING_MIGRATION_NAMES}}
            result = c.apply_reviewed_migrations(server, root, root, metadata, review, stage='OPERATING')
            self.assertEqual(result, {'status':'ALREADY_APPLIED','migration_count':68})
            metadata['migration_hashes']['0069_unadmitted_f2.sql'] = 'c'*64
            with self.assertRaisesRegex(ReleaseError,'MIGRATION_SET_INVALID'):
                c.apply_reviewed_migrations(server, root, root, metadata, review, stage='OPERATING')

    def test_installed_release_must_match_db_and_private_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); metadata = {'source_sha': 'a'*40, 'migration_hashes': history(67)}
            (root/'RELEASE.json').write_text(json.dumps(metadata))
            c.installed_migration_identity(root, {'COMMERCE_RELEASE_SHA': 'a'*40}, history(67))
            for source, applied in [('b'*40, history(67)), ('a'*40, history())]:
                with self.assertRaises(ReleaseError):
                    c.installed_migration_identity(root, {'COMMERCE_RELEASE_SHA': source}, applied)

    def test_adapter_writes_only_0068_plan_and_requires_complete_readback(self):
        for good in (True, False):
            with self.subTest(good=good), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp); (root/'release.env').write_text('COMMERCE_IMAGE=old-image\n')
                samples = [history(67), history() if good else history(67)]; tasks = []
                server = types.SimpleNamespace(PRIVATE=root, migrations=lambda _: samples.pop(0),
                    _write_report=lambda path, value: path.write_text(json.dumps(value)),
                    run_deployment_task=lambda *args: tasks.append(args))
                review = {'migration_hashes': {name: 'c'*64 for name in c.OPERATING_MIGRATION_NAMES}}
                with patch.object(c.native, 'protected_bytes', side_effect=lambda path: path.read_bytes()):
                    if good:
                        result = c.apply_reviewed_migrations(server, root, root, {'migration_hashes': history()}, review, stage='OPERATING')
                        self.assertEqual(result['migration_count'], 68)
                    else:
                        with self.assertRaises(ReleaseError):
                            c.apply_reviewed_migrations(server, root, root, {'migration_hashes': history()}, review, stage='OPERATING')
                plan = json.loads((root/'migrations.json').read_text())
                self.assertEqual(plan, {'stage': 'OPERATING', 'baseline': history(67), 'additions': review['migration_hashes']})
                self.assertEqual(len(tasks), 1)
                args = tasks[0][2]
                self.assertEqual([arg for arg in args if ':/copy-sql/' in arg],
                                 [str(root/'packages/db/migrations/0068_operational_metric_writer.sql')+':/copy-sql/0068_operational_metric_writer.sql:ro'])
                self.assertEqual(args[-1], c.BOUNDED_MIGRATION_JS)

    def test_native_operating_review_retains_original_edge_with_new_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp); current = base/'old'; current.mkdir(); (base/'current').symlink_to(current)
            (current/'RELEASE.json').write_text(json.dumps({'source_sha': 'a'*40, 'migration_hashes': history(67)}))
            adapter = object.__new__(a.Native); adapter.base = base; adapter.private = base/'private'
            adapter.server = types.SimpleNamespace(migrations=lambda _: history(67), command=lambda *_: None)
            edge_ref = {'synthetic': 'original-edge'}; receipt_ref = {'synthetic': 'receipt'}
            before = {'state': {'schema_version': 3, 'runtime_stage': 'OPERATING',
                               'preserved_runtime': {'container': 'hash'}, 'consumer_edge_ref': receipt_ref},
                      'state_raw': b'state', 'plan_raw': b'plan', 'files': {}, 'policy': {}, 'owner': {},
                      'services': {'api': {}}, 'release': {'COMMERCE_RELEASE_SHA': 'a'*40}}
            def read(ref):
                return json.dumps({'approval_ref': edge_ref} if ref == receipt_ref else {}).encode()
            with patch.object(c, 'snapshot', return_value=before), \
                 patch.object(c, 'edge_preflight', return_value={'container_ids': {'container'}, 'hashes': {}}), \
                 patch.object(a.native, 'read_reference', side_effect=read), \
                 patch.object(c, 'reviewed_migrations', side_effect=AssertionError('old pointer must not authorize new source')), \
                 patch.object(c, 'first_start_guard', side_effect=AssertionError('not a cold start')):
                result = adapter.observe_native(base/'package', {'source_sha': 'b'*40, 'migration_hashes': history()},
                                                base/'releases/ci-123-1-bbbbbbbbbbbb')
            self.assertEqual(result['runtime_stage'], 'OPERATING')
            self.assertEqual(result['consumer_edge_approval_ref'], edge_ref)

    def test_publication_migrates_only_after_hold_stop_and_drain_and_never_activates_on_failure(self):
        for fail_migration, unsafe_history in ((False, False), (True, False), (False, True)):
            with self.subTest(fail_migration=fail_migration, unsafe_history=unsafe_history), tempfile.TemporaryDirectory() as tmp:
                base = Path(tmp); private = base/'private'; private.mkdir(mode=0o700); previous = base/'old'; previous.mkdir()
                if unsafe_history:
                    (private/'ownership-attestations').mkdir(mode=0o700)
                    (private/'ownership-attestations').chmod(0o755)
                (base/'current').symlink_to(previous); (base/'releases').mkdir()
                release = {'COMMERCE_RELEASE_SHA': 'a'*40}
                (previous/'RELEASE.json').write_text(json.dumps({'source_sha': 'a'*40, 'migration_hashes': history(67)}))
                (private/'release.env').write_text('COMMERCE_RELEASE_SHA='+'a'*40+'\n')
                archive = base/'archive'; archive.write_bytes(b'synthetic'); events = []; policy = {'version': 98}
                before = {'state': {'schema_version': 3, 'runtime_stage': 'OPERATING', 'portal': {}},
                    'state_raw': b'state', 'plan_raw': b'plan', 'policy': policy, 'owner': {}, 'workspace': 'test',
                    'services': {'api': {'Id': 'a'*64}}, 'release': release}
                def extract(_archive, root, _hash):
                    root.mkdir(); (root/'RELEASE.json').write_text(json.dumps({'source_sha': 'b'*40, 'run_id': '123', 'migration_hashes': history()}))
                def command(args, _root):
                    if 'supports' in args: return '1'
                    events.append('stop' if 'stop' in args else args[2]); return ''
                def task(_root, _dir, _args, phase, _timeout):
                    self.assertEqual((private/'ownership-attestations').stat().st_mode & 0o777, 0o700)
                    events.append(phase)
                    if phase == 'activate': raise RuntimeError('synthetic-activation-stop')
                def migrate(*_args, **kwargs):
                    self.assertEqual(kwargs['stage'], 'OPERATING'); events.append('migrate')
                    if fail_migration: raise RuntimeError('synthetic-migration-failure')
                    return {'migration_count': 68}
                server = types.SimpleNamespace(BASE=base, PRIVATE=private, PREPARE_TIMEOUT_SECONDS=300, INSTALL_TIMEOUT_SECONDS=300,
                    command=command, run_deployment_task=task, migrations=lambda _: history(67),
                    _write_report=lambda path, value: path.write_text(json.dumps(value)), compare_owner_auth=lambda *_: None,
                    raw_policy_snapshot=lambda _: json.dumps({'test': policy}), snapshot_api_deployment_status=lambda *_: None,
                    preserved_containers=lambda: {}, error_code=lambda error: str(error))
                lock = types.SimpleNamespace(close=lambda: None)
                replacements = {(c, 'deadline_fuse'): lambda _: contextlib.nullcontext(),
                    (c.native, 'acquire_locks_for_prepare'): lambda _: lock, (c.native, 'acquire_locks'): lambda _: [lock]*4,
                    (c, 'snapshot'): lambda *_: before, (c, 'extract_release'): extract,
                    (c, 'reviewed_migrations'): lambda *_: {}, (c.native, 'verify_predeploy_backup'): lambda *_: {'synthetic': True},
                    (c, 'loaded_candidate_image'): lambda *_: 'image', (c, 'copy_hold_capability'): lambda *_: True,
                    (c, 'in_flight_guard'): lambda *_: events.append('drain'), (c, 'commercial_snapshot'): lambda *_: 'same',
                    (c, 'apply_reviewed_migrations'): migrate}
                with contextlib.ExitStack() as stack, contextlib.redirect_stdout(io.StringIO()):
                    for (module, name), value in replacements.items(): stack.enter_context(patch.object(module, name, value))
                    if unsafe_history:
                        with self.assertRaisesRegex(ReleaseError, 'COPY_RUNTIME_HISTORY_DIRECTORY_UNSAFE'):
                            c.publish(server, str(archive), 'c'*64, 'b'*40, '123-1', NO_PORTAL)
                    else:
                        with self.assertRaisesRegex(RuntimeError, 'synthetic-'):
                            c.publish(server, str(archive), 'c'*64, 'b'*40, '123-1', NO_PORTAL)
                report = json.loads((private/'deployments/123-1/report.json').read_text())
                if unsafe_history:
                    self.assertEqual(events, [])
                    self.assertNotIn('rollback', report)
                    self.assertEqual((private/'ownership-attestations').stat().st_mode & 0o777, 0o755)
                    continue
                self.assertEqual(events[:6], ['prepare', 'capture', 'hold', 'stop', 'drain', 'migrate'])
                self.assertEqual('activate' in events, not fail_migration)
                self.assertNotIn('release', events); self.assertNotIn('attest', events)
                report = json.loads((private/'deployments/123-1/report.json').read_text())
                self.assertEqual(report['status'], 'FAILED'); self.assertTrue(report['rollback']['transient_hold_active'])
                self.assertFalse((private/'api-web-adoption.json').exists())


class OwnershipHistoryPreflight(unittest.TestCase):
    def test_missing_directory_created_private_and_existing_proof_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp).resolve(); folder = c.prepare_ownership_history(parent)
            self.assertEqual(folder.stat().st_mode & 0o777, 0o700)
            self.assertEqual(folder.stat().st_uid, os.geteuid())
            proof = folder/'proof-existing.attested.json'; proof.write_bytes(b'existing-evidence')
            inode = proof.stat().st_ino
            self.assertEqual(c.prepare_ownership_history(parent), folder)
            self.assertEqual(proof.read_bytes(), b'existing-evidence')
            self.assertEqual(proof.stat().st_ino, inode)

    def test_symlink_file_and_open_permissions_are_rejected_without_repair(self):
        for kind in ('symlink', 'file', 'permissions'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                parent = Path(tmp).resolve(); folder = parent/'ownership-attestations'
                if kind == 'symlink':
                    target = parent/'foreign'; target.mkdir(mode=0o700); folder.symlink_to(target)
                elif kind == 'file': folder.write_bytes(b'preserve')
                else:
                    folder.mkdir(mode=0o700); folder.chmod(0o755)
                before = folder.lstat()
                with self.assertRaises(ReleaseError): c.prepare_ownership_history(parent)
                after = folder.lstat()
                self.assertEqual((before.st_ino, before.st_mode), (after.st_ino, after.st_mode))

    def test_unsafe_parent_is_rejected_before_child_creation(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp).resolve(); parent.chmod(0o755)
            with self.assertRaisesRegex(ReleaseError, 'COPY_RUNTIME_HISTORY_PARENT_UNSAFE'):
                c.prepare_ownership_history(parent)
            self.assertFalse((parent/'ownership-attestations').exists())

    def test_other_owner_is_rejected_without_permission_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp).resolve(); folder = parent/'ownership-attestations'; folder.mkdir(mode=0o700)
            with patch.object(c.os, 'geteuid', side_effect=[os.geteuid(), os.geteuid()+1]):
                with self.assertRaisesRegex(ReleaseError, 'COPY_RUNTIME_HISTORY_DIRECTORY_UNSAFE'):
                    c.prepare_ownership_history(parent)
            self.assertEqual(folder.stat().st_mode & 0o777, 0o700)


if __name__ == '__main__': unittest.main()
