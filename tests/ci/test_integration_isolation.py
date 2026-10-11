"""Exercise the real orchestration with disposable, in-memory process/SQL ports."""
import json
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
HARNESS = (ROOT / 'scripts/test-isolated.mjs').as_uri()


class IntegrationIsolationTests(unittest.TestCase):
    def exercise(self, *, args=(), results=(0, 0, 0, 0), throws_at=None):
        source = """
import {runIntegration} from HARNESS;
const input = INPUT, queries = [], calls = [], logs = [];
const initial = {DATABASE_URL:'postgres://fixture:fixture@localhost/operator_db', KEEP:'yes'};
let ended = false, thrown = null, code = null;
const client = {connect:async()=>{}, query:async sql=>queries.push(sql), end:async()=>{ended=true}};
try {
  code = await runIntegration({args:input.args, env:initial,
    createClient:()=>client, log:line=>logs.push(line),
    run:async(cmd,args,env)=>{
      calls.push({cmd,args,env});
      if(calls.length===input.throws_at)throw Error('FIXTURE_SPAWN_FAILURE');
      return input.results[calls.length-1];
    }});
} catch(error) { thrown=error.message; }
console.log(JSON.stringify({queries,calls,logs,ended,thrown,code,initial}));
""".replace('HARNESS', json.dumps(HARNESS)).replace('INPUT', json.dumps({
            'args': list(args), 'results': list(results), 'throws_at': throws_at,
        }))
        node = shutil.which('node')
        self.assertIsNotNone(node, 'Node is required by the integration harness')
        result = subprocess.run([node, '--input-type=module', '-e', source],
                                text=True, capture_output=True, timeout=20, cwd=ROOT)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_full_suite_runs_complement_and_calendar_once_in_distinct_databases(self):
        result = self.exercise()
        self.assertEqual(result['code'], 0)
        self.assertTrue(result['ended'])
        calls = result['calls']
        self.assertEqual(len(calls), 4)
        calendar = 'tests/integration/numbers-mcp-stdio.test.ts'
        self.assertEqual(calls[1]['args'], ['exec', 'vitest', 'run', '--config',
                         'vitest.integration.config.ts', '--exclude', calendar])
        self.assertEqual(calls[3]['args'], ['exec', 'vitest', 'run', '--config',
                         'vitest.integration.config.ts', calendar])
        urls = [c['env']['DATABASE_URL'] for c in calls]
        self.assertEqual(urls[0], urls[1])
        self.assertEqual(urls[2], urls[3])
        self.assertNotEqual(urls[0], urls[2])
        self.assertTrue(all(url != result['initial']['DATABASE_URL'] for url in urls))
        for call in (calls[0], calls[2]):
            self.assertEqual(call['args'], ['--import', 'tsx', 'packages/db/src/migrate.ts'])
        self.assertEqual(sum(q.startswith('CREATE DATABASE') for q in result['queries']), 2)
        self.assertEqual(sum(q.startswith('DROP DATABASE') for q in result['queries']), 2)
        self.assertEqual(result['initial']['DATABASE_URL'], 'postgres://fixture:fixture@localhost/operator_db')

    def test_first_failure_is_not_masked_by_calendar_success_and_only_failed_database_remains(self):
        result = self.exercise(results=(0, 7, 0, 0))
        self.assertEqual(result['code'], 7)
        self.assertEqual(len(result['calls']), 4)
        created = [q.split('"')[1] for q in result['queries'] if q.startswith('CREATE')]
        dropped = [q.split('"')[1] for q in result['queries'] if q.startswith('DROP')]
        self.assertEqual(dropped, [created[1]])
        self.assertTrue(any(created[0] in line and 'Retained' in line for line in result['logs']))

    def test_calendar_failure_is_propagated(self):
        result = self.exercise(results=(0, 0, 0, 9))
        self.assertEqual(result['code'], 9)
        self.assertEqual(sum(q.startswith('DROP') for q in result['queries']), 1)

    def test_migration_failure_never_runs_tests_against_partial_schema(self):
        result = self.exercise(results=(4, 0, 0))
        self.assertEqual(result['code'], 4)
        self.assertEqual(len(result['calls']), 3)
        self.assertEqual(result['calls'][1]['args'], ['--import', 'tsx', 'packages/db/src/migrate.ts'])
        self.assertEqual(result['calls'][2]['args'][-1], 'tests/integration/numbers-mcp-stdio.test.ts')

    def test_targeted_invocation_preserves_selection_and_uses_one_new_database(self):
        args = ['tests/integration/warmup-runtime.test.ts', '-t', 'request']
        result = self.exercise(args=args, results=(0, 0))
        self.assertEqual(result['code'], 0)
        self.assertEqual(len(result['calls']), 2)
        self.assertEqual(result['calls'][1]['args'][5:], args)
        self.assertEqual(sum(q.startswith('CREATE') for q in result['queries']), 1)

    def test_spawn_failure_closes_admin_without_dropping_failed_database(self):
        result = self.exercise(throws_at=2)
        self.assertEqual(result['thrown'], 'FIXTURE_SPAWN_FAILURE')
        self.assertIsNone(result['code'])
        self.assertTrue(result['ended'])
        self.assertFalse(any(q.startswith('DROP') for q in result['queries']))
        self.assertTrue(any('Retained failed' in line for line in result['logs']))


if __name__ == '__main__':
    unittest.main()
