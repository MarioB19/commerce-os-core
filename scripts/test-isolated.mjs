import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { applyLocalEnv } from './local-env.mjs';

export const calendarTest = 'tests/integration/numbers-mcp-stdio.test.ts';

export function integrationGroups(args) {
  // A targeted invocation keeps its selection. The full suite runs every file
  // once, with the calendar's global workers isolated from other test fixtures.
  return args.length ? [{ name: 'selected', args: [...args] }] : [
    { name: 'integration', args: ['--exclude', calendarTest] },
    { name: 'mcp-calendar', args: [calendarTest] },
  ];
}

export async function runIntegration({ args, env, createClient, run, log = console.log }) {
  const connection = new URL(env.DATABASE_URL);
  const admin = createClient({ connectionString: connection.toString() });
  await admin.connect();
  let exitCode = 0;
  try {
    for (const group of integrationGroups(args)) {
      const database = `commerce_test_${Date.now()}_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
      const isolated = new URL(connection);
      isolated.pathname = '/' + database;
      const childEnv = { ...env, DATABASE_URL: isolated.toString(), LOG_LEVEL: 'silent' };
      let code = 1;
      let removed = false;
      log(`Integration group: ${group.name}; isolated database: ${database}`);
      try {
        code = await run(process.execPath, ['--import', 'tsx', 'packages/db/src/migrate.ts'], childEnv);
        if (code === 0) {
          code = await run('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts', ...group.args], childEnv);
        }
        if (code === 0) {
          await admin.query(`DROP DATABASE "${database}"`);
          removed = true;
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
  const { default: pg } = await import('pg');
  const run = (cmd, args, env) => new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
  process.exitCode = await runIntegration({
    args: process.argv.slice(2), env: process.env,
    createClient: options => new pg.Client(options), run,
  });
}
