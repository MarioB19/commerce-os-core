import {unlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {configDir} from './local-env.mjs';
import { spawn } from 'node:child_process';
import { applyLocalEnv } from './local-env.mjs';
import { runBrowserVerification } from './browser-contracts.mjs';
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
const {code, sanitized} = await runBrowserVerification(run, process.argv.slice(2));
const secrets=join(configDir,'identity-test-secrets.env');if(sanitized===0&&existsSync(secrets))unlinkSync(secrets);
process.exitCode = code || assertSourceTreeUnchanged(before, { suite: 'e2e' });
