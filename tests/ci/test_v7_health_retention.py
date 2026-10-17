import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import v7_health_retention as m  # noqa: E402

CONFIG = {'compose': ['docker', 'compose', '-p', 'commerce-os'], 'workdir': '/opt/commerce-os/current', 'postgres_service': 'postgres',
          'pg_user': 'commerce_owner', 'main_database': 'commerce', 'keep_days': 8, 'batch': 1000, 'max_seconds': 600}
CUTOFF = '2026-10-08T09:30:00.000000Z'
KEY = {'ws': 'workspace-a', 'env': 'REAL', 'account': '11111111-1111-4111-8111-111111111111', 'dimension': 'session',
       'bound': CUTOFF, 'candidates': 2500}
SILENT = {**KEY, 'dimension': 'quality', 'bound': '2026-10-01T00:00:00.000000Z', 'candidates': 3}


class FakeRunner:
    def __init__(self, keys, batches, clock=None):
        self.calls, self.keys, self.batches, self.clock = [], keys, list(batches), clock

    def __call__(self, argv, input=None, capture_output=True, timeout=None, cwd=None):
        sql = input.decode() if input else ''
        self.calls.append((argv, sql))
        if self.clock:
            self.clock.now += 10
        if 'make_interval(days=>' in sql:
            out = CUTOFF
        elif 'json_agg(k ORDER BY' in sql:
            out = json.dumps(self.keys)
        elif 'health_retention_result' in sql:
            d, v = self.batches.pop(0)
            out = 'HEALTH_RETENTION_RESULT|%d|%d|%d|%d' % (d, d, v, d)
        else:
            raise AssertionError('unexpected SQL')
        return SimpleNamespace(returncode=0, stdout=out.encode(), stderr=b'')


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def variables(argv):
    return dict(argv[i + 1].split('=', 1) for i, a in enumerate(argv) if a == '-v' and '=' in argv[i + 1]
                and not argv[i + 1].startswith(('ON_ERROR', 'VERBOSITY')))


class HealthRetentionTests(unittest.TestCase):
    def test_runs_online_sweep_chunks_until_short_and_keeps_counts(self):
        runner = FakeRunner([KEY], [(1000, 1000), (1000, 1002), (500, 500)])
        result = m.run(CONFIG, m.Host(CONFIG, runner))
        self.assertEqual(result['state'], 'HEALTH_RETENTION_APPLIED')
        self.assertEqual((result['records_deleted'], result['versions_deleted'], result['chunks']), (2500, 2502, 3))
        chunks = [(a, s) for a, s in runner.calls if 'health_retention_result' in s]
        self.assertEqual(len(chunks), 3)
        for argv, sql in chunks:
            self.assertEqual(argv[:4], ['docker', 'compose', '-p', 'commerce-os'])
            self.assertIn('VERBOSITY=verbose', argv)
            self.assertEqual(variables(argv), {'bound': CUTOFF, 'lim': '1000'})
            self.assertIn('BEGIN;', sql); self.assertTrue(sql.rstrip().endswith('COMMIT;'))
            self.assertIn("SET LOCAL lock_timeout='5s'", sql)
            self.assertIn('SET LOCAL enable_nestloop=off;', sql)
            self.assertIn("set_config('commerce.health_retention_mode','sweep',true)", sql)
        # The sweep needs no key enumeration: no per-key probes, no aggregate pass.
        self.assertFalse(any('json_agg(k ORDER BY' in s for a, s in runner.calls))

    def test_stops_between_chunks_at_the_time_budget(self):
        clock = Clock()
        runner = FakeRunner([KEY], [(1000, 1000)] * 100, clock)
        config = {**CONFIG, 'max_seconds': 60}
        result = m.run(config, m.Host(config, runner, clock))
        self.assertEqual(result['state'], 'HEALTH_RETENTION_PARTIAL')
        self.assertLessEqual(result['chunks'], 6)

    def test_rejects_inconsistent_chunk_results(self):
        class Bad(FakeRunner):
            def __call__(self, argv, input=None, **kw):
                r = super().__call__(argv, input=input, **kw)
                if 'health_retention_result' in input.decode():
                    r.stdout = b'HEALTH_RETENTION_RESULT|10|9|10|10'
                return r
        with self.assertRaises(m.RetentionError):
            m.run(CONFIG, m.Host(CONFIG, Bad([KEY], [(10, 10)])))

    def test_plan_rejects_keys_outside_the_cutoff_or_malformed(self):
        for bad in ({**KEY, 'bound': '2026-10-15T00:00:00.000000Z'}, {**KEY, 'env': 'STAGING'}, {**KEY, 'account': ''},
                    {**KEY, 'candidates': 0}, {**KEY, 'extra': 1}):
            with self.subTest(bad=bad), self.assertRaises(m.RetentionError):
                m.plan(CONFIG, m.Host(CONFIG, FakeRunner([bad], [])))

    def test_plan_counts_without_deleting(self):
        runner = FakeRunner([KEY, SILENT], [])
        self.assertEqual(m.plan(CONFIG, m.Host(CONFIG, runner)),
                         {'state': 'HEALTH_RETENTION_PLAN', 'keep_days': 8, 'keys': 2, 'candidates': 2503})
        self.assertFalse(any('DISABLE TRIGGER' in s for a, s in runner.calls))

    def test_config_is_closed_and_bounded(self):
        path = Path(tempfile.mkdtemp()) / 'operator.json'
        for bad in ({**CONFIG, 'extra': 1}, {**CONFIG, 'keep_days': 1}, {**CONFIG, 'batch': 10}, {**CONFIG, 'batch': 2000001},
                    {**CONFIG, 'max_seconds': True},
                    {k: v for k, v in CONFIG.items() if k != 'batch'}):
            path.write_text(json.dumps(bad))
            with self.subTest(bad=bad), self.assertRaises(m.RetentionError):
                m.load_config(path)
        path.write_text(json.dumps(CONFIG))
        self.assertEqual(m.load_config(path), CONFIG)

    def test_failure_reports_only_a_code(self):
        def failing(argv, input=None, **kw):
            return SimpleNamespace(returncode=3, stdout=b'', stderr=b'ERROR:  HEALTH_RETENTION_COUNT_MISMATCH\nCONTEXT: secret-ish row text')
        with self.assertRaises(m.RetentionError) as e:
            m.run(CONFIG, m.Host(CONFIG, failing))
        self.assertIn('HEALTH_RETENTION_COUNT_MISMATCH', str(e.exception))
        self.assertNotIn('secret-ish', str(e.exception))
        # A PostgreSQL error is reported by its SQLSTATE, never by words of the failing statement.
        def timeout(argv, input=None, **kw):
            return SimpleNamespace(returncode=3, stdout=b'', stderr=b'ERROR:  57014: canceling statement due to statement timeout\n'
                                   b'CONTEXT:  SQL statement "SELECT EXISTS(SELECT 1 FROM public.x c JOIN ...)"')
        with self.assertRaises(m.RetentionError) as e:
            m.run(CONFIG, m.Host(CONFIG, timeout))
        self.assertIn('SQLSTATE_57014', str(e.exception))
        self.assertNotIn('EXISTS', str(e.exception))

    def test_cutover_is_one_transaction_over_every_key_then_compacts(self):
        class Cut(FakeRunner):
            def __call__(self, argv, input=None, **kw):
                sql = input.decode()
                self.calls.append((argv, sql))
                out = {True: 'HEALTH_RETENTION_RESULT|3300000|3300000|3300001|3300000'}.get('health_retention_result' in sql)
                if out is None:
                    out = CUTOFF if 'make_interval' in sql else ('2000000000' if 'pg_database_size' in sql else '')
                return SimpleNamespace(returncode=0, stdout=out.encode(), stderr=b'')
        runner = Cut([], [])
        config = {**CONFIG, 'keep_days': 2}
        result = m.cutover(config, m.Host(config, runner))
        self.assertEqual((result['state'], result['records_deleted'], result['versions_deleted']),
                         ('HEALTH_RETENTION_CUT_APPLIED', 3300000, 3300001))
        argv, sql = [c for c in runner.calls if 'health_retention_result' in c[1]][0]
        self.assertIn("set_config('commerce.health_retention_mode','all',true)", sql)
        self.assertIn('SET LOCAL enable_nestloop=off;', sql)
        self.assertEqual(variables(argv), {'bound': CUTOFF, 'lim': str(m.CUT_LIMIT)})
        compacted = m.compact(config, m.Host(config, runner))
        vacuums = [s for a, s in runner.calls if 'VACUUM' in s]
        self.assertEqual([s.split('public.')[1].split(';')[0] for s in vacuums], ['health_observation_index', 'record_versions', 'records'])
        self.assertEqual(compacted['database_bytes'], 2000000000)

    def test_batch_sql_guards_the_latest_the_superuser_and_references(self):
        sql = m.BATCH_SQL.read_text()
        self.assertIn('HEALTH_RETENTION_SUPERUSER_REQUIRED', sql)
        self.assertIn("bound>now()-interval '2 days'", sql)
        self.assertIn('n.observed_at>=bound', sql)
        self.assertIn('OVER(PARTITION BY workspace_id,environment,account_id,dimension)', sql)
        self.assertIn("kind='health_signal'", sql)
        self.assertIn('HEALTH_RETENTION_PRODUCERS_RUNNING', sql)
        # Only the Fase C cut requires stopped producers; the daily sweep row-locks and keeps writers running.
        self.assertIn("IF mode='all' AND EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity", sql)
        self.assertIn("IF mode IN('key','sweep') OR ws<>'' THEN", sql)
        self.assertIn("WHEN 'sweep' THEN 2000000", sql)
        # References are verified set-based before the trigger-less delete; origin is restored after it.
        self.assertLess(sql.index('HEALTH_RETENTION_REFERENCED'), sql.index("set_config('session_replication_role','replica',true)"))
        self.assertLess(sql.index("'replica',true)"), sql.index("set_config('session_replication_role','origin',true)"))
        self.assertNotIn('DISABLE TRIGGER', sql)


if __name__ == '__main__':
    unittest.main()
