import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { applyLocalEnv } from './local-env.mjs';
import { integrationTestGroups, integrationGroupArgs } from './integration-test-groups.ts';
import { captureIntegrationRoles, prepareIntegrationRoleCleanup, finishIntegrationRoleCleanup } from './integration-role-custody.mjs';
import { assertSourceTreeUnchanged, sourceTreeSnapshot } from './source-tree-guard.mjs';

export const calendarTest = 'tests/integration/numbers-mcp-stdio.test.ts';

export function integrationGroups(args, entries, root = process.cwd()) {
  // Vitest owns the exact selection; partition only those files and retain all
  // caller filters. Calendar workers and each profile transition get a fresh DB.
  const groups = integrationTestGroups(root, entries);
  return groups.map(group => ({
    name: group.length === 1 && group[0] === calendarTest ? 'mcp-calendar' : group.join(', '),
    args: integrationGroupArgs(args, groups, group),
  }));
}

export async function runIntegration({ args, entries, env, createClient, run, log = console.log }) {
  const groups = integrationGroups(args, entries);
  const connection = new URL(env.DATABASE_URL);
  const admin = createClient({ connectionString: connection.toString() });
  await admin.connect();
  let exitCode = 0;
  try {
    for (const group of groups) {
      const database = `commerce_test_${Date.now()}_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
      const isolated = new URL(connection);
      isolated.pathname = '/' + database;
      const childEnv = { ...env, DATABASE_URL: isolated.toString(), LOG_LEVEL: 'silent' };
      let code = 1;
      let removed = false;
      let roleBaseline;
      log(`Integration group: ${group.name}; isolated database: ${database}`);
      try {
        code = await run(process.execPath, ['--import', 'tsx', 'packages/db/src/migrate.ts'], childEnv);
        if (code === 0) {
          // Historical migration roles are a shared baseline. Additive fixture
          // owners must not escape their successful isolated database lifetime.
          roleBaseline = await captureIntegrationRoles(admin);
          code = await run('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts', ...group.args], childEnv);
        }
        if (code === 0) {
          const roleCleanup = await prepareIntegrationRoleCleanup(admin, roleBaseline, database);
          await admin.query(`DROP DATABASE "${database}"`);
          removed = true;
          log(JSON.stringify(await finishIntegrationRoleCleanup(admin, roleCleanup)));
        }
      } finally {
        if (!removed) log(`Retained failed verification database: ${database}. No live data or gateway sessions are used.`);
      }
      if (code !== 0 && exitCode === 0) exitCode = code;
    }
  } finally {
    await admin.end();
  }
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  applyLocalEnv();
  const before = sourceTreeSnapshot();
  const args = process.argv.slice(2);
  // filesOnly evaluates native selection without executing tests or hooks.
  const listed = await promisify(execFile)(process.execPath,
    ['node_modules/vitest/vitest.mjs', 'list', '--config', 'vitest.integration.config.ts',
      ...args, '--filesOnly', '--json'],
    { env: process.env, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  const entries = JSON.parse(listed.stdout);
  const { default: pg } = await import('pg');
  const run = (cmd, args, env) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
  const tests = await runIntegration({
    args, entries, env: process.env,
    createClient: options => new pg.Client(options), run,
  });
  process.exitCode = tests || assertSourceTreeUnchanged(before, { suite: 'integration' });
}
