"""Finite diagnostics through the real tick/factory/ledger/journal composition."""
import copy
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import cloudbuild_diagnostics as diagnostics
import cloudbuild_connected_source as source
from cloudbuild_full_evidence import EvidenceError
from cloudbuild_source_limits import ProcessResult
from cloudbuild_runtime_meter import initial_document, usage
from test_cloudbuild_runtime import SourcePipelineTests
from test_cloudbuild_runtime_meter import Store, http


class DiagnosticTests(unittest.TestCase):
    def test_only_exact_trusted_exception_and_literal_code_are_exposed(self):
        self.assertEqual(http.safe_error(EvidenceError('SOURCE_GIT_FETCH_FAILED')), 'SOURCE_GIT_FETCH_FAILED')
        self.assertEqual(http.safe_error(EvidenceError('SOURCE_PUBLIC_PROFILE_REQUIRED')), 'SOURCE_PUBLIC_PROFILE_REQUIRED')
        for e in (RuntimeError('SOURCE_GIT_FETCH_FAILED'), EvidenceError('SECRET_VALUE_ABC'),
                  EvidenceError('SOURCE_GIT_FETCH_FAILED\nAuthorization: secret'),
                  EvidenceError({'token': 'secret'}), ValueError('SOURCE_GIT_FETCH_FAILED')):
            self.assertEqual(http.safe_error(e), 'CONTROLLER_REQUEST_FAILED')
        class Subclass(EvidenceError): pass
        self.assertEqual(http.safe_error(Subclass('SOURCE_GIT_FETCH_FAILED')), 'CONTROLLER_REQUEST_FAILED')
        self.assertEqual(diagnostics.phase('token=secret'), 'UNCLASSIFIED')

    def factory(self):
        fixture = SourcePipelineTests('test_source_acquisition_result_persists_before_upload')
        fixture.setUp(); fixture.source_fixture()
        fixture.factory.meter_store = Store(initial_document())
        return fixture

    def check_preserved(self, f, result, code, phase, revision):
        self.assertEqual(result['status'], 'STOP_PRESERVE')
        self.assertEqual(result['code'], code); self.assertEqual(result['phase'], phase)
        meter = f.factory.meter_store.document
        self.assertIsNotNone(meter['active_request'])
        self.assertEqual(meter['requests'][meter['active_request']]['state'], 'RESERVED')
        self.assertEqual(usage(meter)[next(iter(usage(meter)))]['cpu_ms'], 450000)
        self.assertEqual(f.journal_store.document['revision'], revision)
        f.factory.sources.upload_source_once.assert_not_called()
        f.fixture.api.create_once.assert_not_called()

    def test_real_factory_connect_error_keeps_reserved_meter_without_source_intent(self):
        f = self.factory()
        f.factory.source_reader.connect.side_effect = EvidenceError('SOURCE_READ_HTTP_ERROR')
        result = http.tick(lambda: f.factory)
        self.check_preserved(f, result, 'SOURCE_READ_HTTP_ERROR', 'SOURCE_CONNECT', 0)

    def test_real_factory_post_cas_inventory_error_keeps_source_intent(self):
        f = self.factory(); baseline = copy.deepcopy(f.fixture.store.document)
        f.factory.inventory_snapshot.side_effect = [
            {'complete': True, 'inventory_sha256': f.task['admission']['inventory_sha256']},
            EvidenceError('INVENTORY_HTTP_403')]
        result = http.tick(lambda: f.factory)
        self.check_preserved(f, result, 'INVENTORY_HTTP_403', 'SOURCE_POST_INTENT_FENCE', 1)
        self.assertEqual(f.fixture.store.document, baseline)

    def test_real_factory_archive_path_reports_git_operation_without_stderr(self):
        f = self.factory(); approval = f.task['payload']['source_approval']
        f.factory.source_reader.commit.return_value = {'sha': approval['source_sha'], 'tree': {'sha': approval['source_tree']}}
        f.factory.source_reader.tree.return_value = {'sha': approval['source_tree'], 'truncated': False,
            'tree': [{'path': 'one.txt', 'type': 'blob', 'mode': '100644', 'sha': '1' * 40, 'size': 1}]}
        original = tempfile.TemporaryDirectory
        def private_dir(**kwargs): return original(dir=Path(tempfile.gettempdir()).resolve(), **kwargs)
        with patch.object(source, 'clock', return_value=f.moment), \
             patch.object(tempfile, 'TemporaryDirectory', side_effect=private_dir), \
             patch.object(source, 'run_git', return_value=ProcessResult(1, b'')) as git:
            result = http.tick(lambda: f.factory)
        self.check_preserved(f, result, 'SOURCE_GIT_INIT_FAILED', 'SOURCE_ACQUIRE', 1)
        self.assertEqual(git.call_count, 1)
        self.assertIsNone(next(iter(f.journal_store.document['actions'].values()))['result'])

    def test_real_factory_unknown_exception_never_exposes_provider_content(self):
        f = self.factory()
        f.factory.source_reader.connect.side_effect = OSError('https://private/?token=SECRET')
        result = http.tick(lambda: f.factory)
        self.check_preserved(f, result, 'CONTROLLER_REQUEST_FAILED', 'SOURCE_CONNECT', 0)
        self.assertNotIn('SECRET', str(result)); self.assertNotIn('https', str(result))


def load_tests(loader, tests, pattern):
    return loader.loadTestsFromTestCase(DiagnosticTests)


if __name__ == '__main__': unittest.main()
