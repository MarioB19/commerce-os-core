import {unlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {configDir} from './local-env.mjs';
import { spawn } from 'node:child_process';
import { applyLocalEnv } from './local-env.mjs';
import { assertSourceTreeUnchanged, sourceTreeSnapshot } from './source-tree-guard.mjs';
applyLocalEnv();
const before = sourceTreeSnapshot();
async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio:'inherit', env:process.env });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}
const tests = await run('playwright', ['test', ...process.argv.slice(2)]);
// Sanitize failed reports too; Playwright embeds step titles in a base64 ZIP.
const sanitized = await run('python3', ['scripts/sanitize-test-artifacts.py']);
const secrets=join(configDir,'identity-test-secrets.env');if(sanitized===0&&existsSync(secrets))unlinkSync(secrets);
process.exitCode = tests || sanitized || assertSourceTreeUnchanged(before, { suite: 'e2e' });
