"""Admission wiring tests; native provider contracts keep their F0 test suite.

The fixture provider below is explicit synthetic evidence, never proof of FULL.
Historical restore uses the actual pure validator and its linked fixture.
"""
import copy
import datetime as dt
from pathlib import Path
import re
import sys
import types
import unittest
from unittest.mock import Mock, patch
sys.path[:0] = [str(Path(__file__).resolve().parents[2]/'scripts'), str(Path(__file__).parent)]
import runtime_boot_install_gate as g
import copy_runtime_deployment as runtime
from test_runtime_boot_restore_gate import Fixture, SOURCE, NOW, raw, ref

class InstallGateTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture(); self.history = self.f.validate(); self.data = {}
        self.context = {'package_origin': 'cloud-build', 'source_sha': 'c'*40,
            'source_tree': 'd'*40, 'package_build_id': '11111111-2222-4333-8444-555555555555'}
        self.report = {'source_sha': 'c'*40, 'source_tree': 'd'*40, 'archive_sha256': 'f'*64,
            'run_id': 'cb-'+self.context['package_build_id']+'-1', 'provider_evidence': self.context}
        native = {}
        docs = {'project': {'projectId': 'synthetic', 'projectNumber': '123'},
            'admission': {'verification_manifest': {'synthetic': True}}, 'full_build': {}, 'full_commit': {},
            'full_logs': {'entries': []}, 'package_build': {}, 'package_logs': {'entries': []},
            'artifact_manifest': {}}
        for name, value in docs.items():
            data = raw(value); r = ref('/synthetic/native/'+name+'.json', data)
            self.data[r['path']] = data; native[name] = r
        self.approval = {'schema_version': 1, **{k:self.report[k] for k in ('source_sha', 'run_id', 'archive_sha256')},
            'host_id': '123456', 'gateway_start_ids': {'waha-01': '8'*64},
            'created_at': (NOW-dt.timedelta(minutes=1)).isoformat(), 'expires_at': (NOW+dt.timedelta(minutes=10)).isoformat(),
            'native_originals': native, 'restore_source_sha': SOURCE, 'restore_originals': self.f.refs,
            'restore_custody': {r['path']: dict(r) for r in self.f.refs.values()}}
        self.data.update(self.f.raws)
        self.full = types.SimpleNamespace(PROJECT='synthetic', validate_native=Mock(return_value='success'),
            log_filter=Mock(return_value='synthetic-full-query'),
            receipts_from_logs=Mock(return_value={'synthetic': True}), validate_full_receipt=Mock())
        self.release = types.SimpleNamespace(validate_admission=Mock(return_value=self.context),
            PACKAGE_GATE='synthetic-package-gate',
            package_native=Mock(return_value=('gs://synthetic/manifest#1', 'gs://synthetic/')),
            archive_record=Mock(), package_receipt=Mock(return_value={'archive_sha256': 'f'*64}))
        self.provider = types.SimpleNamespace(CLOUD_RUN=re.compile(r'cb-([a-f0-9-]{36})-([1-9][0-9]*)'))

    def validate(self, **changes):
        options = {'report': self.report, 'host_id': '123456', 'candidate_migrations': self.history['migration_files'],
            'candidate_restore_sources': self.history['restore_sources'], 'now': NOW,
            'reader': lambda r: self.data[r['path']]}; options.update(changes)
        with patch.dict(sys.modules, {'cloudbuild_full_evidence': self.full,
                'cloudbuild_release_evidence': self.release, 'ci_provider_evidence': self.provider}):
            return g.validate(self.approval, **options)

    def test_same_native_full_package_and_historical_restore_all_consumed(self):
        result = self.validate(); self.full.validate_native.assert_called_once()
        self.full.validate_full_receipt.assert_called_once(); self.release.package_native.assert_called_once()
        self.release.archive_record.assert_called_once(); self.release.package_receipt.assert_called_once()
        self.assertEqual(result['restore']['status'], 'HISTORICAL_RESTORE_CANDIDATE_COMPATIBLE')
        self.assertFalse(result['restore']['installation_authorized'])

    def test_no_true_flag_or_expired_admission_can_open_native_reads(self):
        for mutate in (lambda a:a.update(full=True), lambda a:a.update(expires_at=NOW.isoformat()),
                       lambda a:a.update(created_at=(NOW+dt.timedelta(seconds=1)).isoformat()),
                       lambda a:a.update(expires_at=(NOW+dt.timedelta(hours=1)).isoformat())):
            previous = copy.deepcopy(self.approval); mutate(self.approval)
            with self.assertRaises(RuntimeError): self.validate(reader=lambda _: self.fail('no read'))
            self.approval = previous

    def test_source_host_run_and_archive_changes_rejected_before_originals(self):
        for key in ('source_sha', 'run_id', 'archive_sha256', 'host_id'):
            previous = self.approval[key]; self.approval[key] = 'foreign'
            with self.subTest(key=key), self.assertRaisesRegex(RuntimeError, 'RELEASE_OR_HOST_CHANGED'):
                self.validate(reader=lambda _: self.fail('no read'))
            self.approval[key] = previous

    def test_full_failed_and_package_archive_mismatch_block(self):
        self.full.validate_native.return_value = 'failure'
        with self.assertRaisesRegex(RuntimeError, 'FULL_REQUIRED'): self.validate()
        self.release.package_native.assert_not_called()
        self.full.validate_native.return_value = 'success'; self.release.package_receipt.return_value['archive_sha256'] = '0'*64
        with self.assertRaisesRegex(RuntimeError, 'ARCHIVE_CHANGED'): self.validate()

    def test_partial_logging_response_and_unknown_original_set_block(self):
        p = self.approval['native_originals']['full_logs']['path']; self.data[p] = raw({'entries': [], 'nextPageToken':'more'})
        with self.assertRaisesRegex(RuntimeError, 'LOGS_INCOMPLETE'): self.validate()
        del self.approval['native_originals']['full_commit']
        with self.assertRaisesRegex(RuntimeError, 'NATIVE_SET_CHANGED'): self.validate()

    def test_compatible_schema_cannot_be_asserted_by_boolean(self):
        changed = dict(self.history['migration_files']); changed['0002_new.sql'] = '9'*64
        with self.assertRaisesRegex(RuntimeError, 'MIGRATIONS_CHANGED'): self.validate(candidate_migrations=changed)
        first = next(iter(self.approval['restore_custody'])); self.approval['restore_custody'][first]['sha256'] = '0'*64
        with self.assertRaisesRegex(RuntimeError, 'RESTORE_COPY_CHANGED'): self.validate()

    def test_original_reader_accepts_only_hash_named_fixed_root_custody(self):
        data = raw({'synthetic': True}); r = ref('/tmp/free.json', data)
        with patch.object(g.host, 'protected', side_effect=AssertionError('no read')):
            with self.assertRaisesRegex(RuntimeError, 'CUSTODY_REQUIRED'): g.read(r)
        r = ref(str(g.EVIDENCE/(runtime.sha256(data)+'.json')), data)
        with patch.object(g.host, 'protected', return_value=data): self.assertEqual(g.read(r), data)
        with patch.object(g.host, 'protected', return_value=data+b' '):
            with self.assertRaisesRegex(RuntimeError, 'ORIGINAL_CHANGED'): g.read(r)

if __name__ == '__main__': unittest.main()
