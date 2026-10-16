import io
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import v7_lab_retention as m  # noqa: E402

CONFIG = {'compose': ['docker', 'compose', '-p', 'commerce-os'], 'workdir': '/opt/commerce-os/current', 'postgres_service': 'postgres',
          'pg_user': 'commerce_owner', 'main_database': 'commerce', 'worker_service': 'automation-worker', 'lab_storage_dir': '/data/lab'}
RUN = '11111111-1111-4111-8111-111111111111'
KEY = '22222222-2222-4222-8222-222222222222-' + 'a' * 64


class FakeRunner:
    def __init__(self, pending):
        self.calls, self.pending = [], pending

    def __call__(self, argv, input=None, capture_output=True, timeout=None, cwd=None):
        sql = input.decode() if input else ''
        self.calls.append((argv, sql))
        out = ''
        if 'purge_expired_runs' in sql:
            out = json.dumps([{'workspace_id': 'p', 'run_id': RUN, 'operations': 3, 'attachment_keys': [KEY]}])
        elif 'FROM commerce_number_lab.retention_receipts WHERE' in sql:
            out = json.dumps(self.pending)
        elif 'pg_database' in sql:
            out = 'commerce_lab_engine_abc\n'
        elif 'purge_run' in sql:
            out = '17'
        return SimpleNamespace(returncode=0, stdout=out.encode(), stderr=b'')


class RetentionTests(unittest.TestCase):
    def test_shreds_then_purges_engine_and_files_once(self):
        runner = FakeRunner([{'run_id': RUN, 'engine': True, 'files': True, 'keys': [KEY]}])
        result = m.run(CONFIG, m.Host(CONFIG, runner))
        self.assertEqual(result, {'state': 'LAB_RETENTION_APPLIED', 'runs_shredded': 1, 'engine_runs_purged': 1, 'engine_rows_deleted': 17, 'receipt_files_removed': 1})
        engine_calls = [a for a, s in runner.calls if 'purge_run' in s]
        self.assertIn('commerce_lab_engine_abc', engine_calls[0])
        rm = [a for a, s in runner.calls if 'rm' in a][0]
        self.assertEqual(rm[-1], '/data/lab/assets/' + KEY + '.enc')
        self.assertEqual(rm[rm.index('rm') + 1:rm.index('rm') + 3], ['-f', '--'])
        marks = [s for a, s in runner.calls if 'engine_purged_at=clock_timestamp()' in s or 'files_purged_at=clock_timestamp()' in s]
        self.assertEqual(len(marks), 2)

    def test_rejects_a_file_key_that_is_not_a_receipt(self):
        runner = FakeRunner([{'run_id': RUN, 'engine': False, 'files': True, 'keys': ['../../etc/passwd']}])
        with self.assertRaises(m.RetentionError):
            m.run(CONFIG, m.Host(CONFIG, runner))
        self.assertFalse(any('rm' in a for a, s in runner.calls))

    def test_config_is_closed(self):
        import tempfile
        path = Path(tempfile.mkdtemp()) / 'operator.json'
        try:
            path.write_text(json.dumps({**CONFIG, 'extra': 1}))
            out = io.StringIO()
            import contextlib
            with contextlib.redirect_stdout(out):
                self.assertEqual(m.main(['run', str(path)]), 1)
            self.assertEqual(json.loads(out.getvalue())['error'], 'LAB_RETENTION_CONFIG_FIELDS')
        finally:
            path.unlink(missing_ok=True)


if __name__ == '__main__':
    unittest.main()
