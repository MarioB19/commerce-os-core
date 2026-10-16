"""Synthetic authenticated-reader fixtures; these are not backup receipts."""
import copy
import datetime as dt
from pathlib import Path
import sys
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import privacy_backup_files as p
from test_privacy_backup_attestation import Fixture as BaseFixture, SOURCE, NOW, DEPLOYED


class Fixture:
    def __init__(self):
        self.base = BaseFixture(); self.native = self.base.native
        self.backup = str(uuid.uuid4()); asset = str(uuid.uuid4())
        entry = {'asset_id': asset, 'storage_key': asset + '-' + 'a' * 64,
            'ciphertext_sha256': 'b' * 64, 'ciphertext_bytes': '128',
            'mtime_ns': str(p.nanos('2026-10-11T12:00:00Z'))}
        for key, phase, target, start, end in (
                ('source_files_before', 'SOURCE_BEFORE_BACKUP', 'source-cluster/database',
                 '2026-10-11T12:58:00Z', '2026-10-11T12:59:00Z'),
                ('source_files_after', 'SOURCE_AFTER_BACKUP', 'source-cluster/database',
                 '2026-10-11T13:10:30Z', '2026-10-11T13:11:00Z'),
                ('restored_files', 'RESTORED_VOLUME', 'isolated-cluster/database',
                 '2026-10-11T13:18:00Z', '2026-10-11T13:19:00Z')):
            self.base.put(key, {'schema_version': 1, 'kind': 'D18_NATIVE_FILE_READBACK',
                'phase': phase, 'run_id': self.native.docs['root_report']['run_id'],
                'target': target, 'capture_sha256': 'f' * 64,
                'source_manifest_ref': self.native.refs['deployed_sources'],
                'ciphertext_sha256': self.native.docs['staging_plan']['files']['ciphertext.backup.aes']['sha256'],
                'restore_receipt_ref': self.native.refs['restore_receipt'] if key == 'restored_files' else None,
                'result': {'schema_version': 1, 'kind': 'PRIVATE_CIPHERTEXT_INVENTORY',
                           'started_at': start, 'finished_at': end, 'files': [copy.deepcopy(entry)]}})

    def validate(self, **extra):
        args = {'expected_backup_source_sha': 'b' * 40, 'expected_restore_source_sha': SOURCE,
            'expected_deployed_source_sha': DEPLOYED,
            'expected_readback_queries_sha256': self.native.refs['readback_queries']['sha256'],
            'expected_files': self.base.files, 'source_target': 'source-cluster/database',
            'restored_target': 'isolated-cluster/database', 'now': NOW,
            'backup_id': self.backup, 'expected_capture_sha256': 'f' * 64}
        args.update(extra)
        return p.prepare_privacy_backup_files(self.native.refs, self.native.read, **args)

    def change(self, key, fn):
        self.base.change(key, fn)


class PrivateBackupFilesTests(unittest.TestCase):
    def test_prepares_exact_restored_ciphertext_pins_without_importing(self):
        f = Fixture(); before = copy.deepcopy(f.native.refs); out = f.validate()
        self.assertEqual(out['file_arguments']['backup_id'], f.backup)
        self.assertEqual(out['file_arguments']['restore_receipt'], f.native.refs['restore_receipt']['sha256'])
        self.assertEqual(out['file_arguments']['evidence_sha256'], out['originals_sha256'])
        self.assertEqual(out['file_arguments']['entries'], [{k: v for k, v in
            f.native.docs['restored_files']['result']['files'][0].items() if k != 'mtime_ns'}])
        self.assertFalse(out['import_authorized']); self.assertFalse(out['erasure_authorized'])
        self.assertEqual(out['valid_until'], '2026-10-12T13:00:00+00:00')
        self.assertEqual(f.native.refs, before)

    def test_reads_all23_originals_once_on_every_call(self):
        f = Fixture(); read = f.native.read; calls = []
        def reader(ref):
            calls.append(ref['path']); return read(ref)
        f.native.read = reader; f.validate(); f.validate()
        self.assertEqual(len(calls), 46); self.assertEqual(len(set(calls)), 23)

    def test_the20_historical_originals_cannot_substitute_for_new_measurement(self):
        f = Fixture(); del f.native.refs['restored_files']
        with self.assertRaisesRegex(Exception, 'ORIGINAL_SET'): f.validate()

    def test_changed_authentic_originals_are_not_accepted_by_relabeling(self):
        f = Fixture(); old = f.native.read
        f.native.read = lambda ref: old(ref) + b'changed' if ref == f.native.refs['restored_files'] else old(ref)
        with self.assertRaisesRegex(Exception, 'ORIGINAL_CHANGED'): f.validate()

    def test_cannot_borrow_target_run_archive_receipt_or_capture_implementation(self):
        for field, value in [('target', 'source-cluster/database'), ('run_id', 'gcp-' + 'e' * 32),
                ('capture_sha256', '0' * 64), ('ciphertext_sha256', '0' * 64),
                ('restore_receipt_ref', None), ('source_manifest_ref', None)]:
            f = Fixture(); f.change('restored_files', lambda d: d.update({field: value}))
            with self.subTest(field=field), self.assertRaisesRegex(Exception, 'BINDING'): f.validate()

    def test_source_change_between_backup_boundaries_blocks(self):
        f = Fixture(); f.change('source_files_after', lambda d: d['result']['files'][0].update(ciphertext_sha256='d' * 64))
        with self.assertRaisesRegex(Exception, 'RESTORE_DIFFERENCE'): f.validate()

    def test_restored_missing_extra_or_different_bytes_blocks(self):
        for kind in ('missing', 'extra', 'different-size', 'different-hash'):
            f = Fixture()
            def change(d):
                rows = d['result']['files']
                if kind == 'missing': rows.clear()
                if kind == 'extra':
                    entry = dict(rows[0]); entry['asset_id'] = str(uuid.uuid4()); entry['storage_key'] = entry['asset_id']; rows.append(entry)
                if kind == 'different-size': rows[0]['ciphertext_bytes'] = '127'
                if kind == 'different-hash': rows[0]['ciphertext_sha256'] = 'c' * 64
            f.change('restored_files', change)
            with self.subTest(kind=kind), self.assertRaisesRegex(Exception, 'RESTORE_DIFFERENCE'): f.validate()

    def test_closed_shapes_prevent_plaintext_or_customer_names_from_being_imported(self):
        f = Fixture(); f.change('restored_files', lambda d: d['result']['files'][0].update(original_filename='private customer'))
        with self.assertRaisesRegex(Exception, 'FIELDS'): f.validate()

    def test_invalid_sizes_duplicates_keys_and_hashes_block(self):
        for field, value in [('storage_key', '../outside'), ('asset_id', 'invalid'),
                ('ciphertext_bytes', 128), ('ciphertext_bytes', '536870913'),
                ('ciphertext_sha256', 'not a hash'), ('mtime_ns', '0')]:
            f = Fixture(); f.change('restored_files', lambda d: d['result']['files'][0].update({field: value}))
            with self.subTest(field=field, value=value), self.assertRaises(Exception): f.validate()
        f = Fixture(); f.change('restored_files', lambda d: d['result']['files'].append(dict(d['result']['files'][0])))
        with self.assertRaisesRegex(Exception, 'IDENTITY'): f.validate()

    def test_nanosecond_after_snapshot_blocks_even_when_millisecond_rounded_same(self):
        f = Fixture(); f.change('restored_files', lambda d: d['result']['files'][0].update(mtime_ns=str(p.nanos('2026-10-11T13:00:00Z') + 1)))
        with self.assertRaisesRegex(Exception, 'NEWER_THAN_BACKUP'): f.validate()

    def test_mtime_restoration_rounding_is_not_a_ciphertext_difference(self):
        f = Fixture(); f.change('restored_files', lambda d: d['result']['files'][0].update(mtime_ns=str(p.nanos('2026-10-11T11:59:59Z'))))
        self.assertEqual(len(f.validate()['file_arguments']['entries']), 1)

    def test_all_phase_bounds_and_order_are_enforced(self):
        for key, field, value in [('source_files_before', 'finished_at', '2026-10-11T13:00:01Z'),
                ('source_files_after', 'started_at', '2026-10-11T13:09:59Z'),
                ('source_files_after', 'finished_at', '2026-10-11T13:21:00Z'),
                ('restored_files', 'started_at', '2026-10-11T13:10:00Z'),
                ('restored_files', 'finished_at', '2026-10-11T13:20:01Z'),
                ('restored_files', 'finished_at', '2026-10-11T13:17:00Z')]:
            f = Fixture(); f.change(key, lambda d: d['result'].update({field: value}))
            with self.subTest(key=key, field=field), self.assertRaisesRegex(Exception, 'FILES_TIME'): f.validate()

    def test_earlier_SQL_restore_gate_is_revalidated_without_promoting_prior_results(self):
        f = Fixture(); f.change('restored_topology', lambda d: d['result'].update(topology_sha256='0' * 64))
        with self.assertRaisesRegex(Exception, 'TOPOLOGY_CHANGED'): f.validate()

    def test_expiry_is_original_snapshot_based_and_replay_never_extends_it(self):
        f = Fixture(); first = f.validate(); self.assertEqual(first, f.validate(now=NOW + dt.timedelta(hours=12)))
        with self.assertRaisesRegex(Exception, 'WINDOW_EXPIRED'): f.validate(now=NOW + dt.timedelta(hours=13))

    def test_authentic_empty_directories_are_distinct_from_a_missing_measurement(self):
        f = Fixture()
        for key in p.EXTRA: f.change(key, lambda d: d['result'].update(files=[]))
        self.assertEqual(f.validate()['file_arguments']['entries'], [])

    def test_no_aliasing_of_original_references(self):
        f = Fixture(); f.native.refs['restored_files'] = dict(f.native.refs['source_files_before'])
        with self.assertRaisesRegex(Exception, 'ORIGINAL_BOUND'): f.validate()


if __name__ == '__main__':
    unittest.main()
