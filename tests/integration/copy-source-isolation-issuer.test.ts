import {it,expect} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

// Uses only this integration job's DATABASE_URL to create/drop its own DB.
// The child sets the actual API pool to commerce_api before dynamic imports.
// Linux Root custody and real Billing/human provenance are separate checks.
it('Root issuer preserves custody boundaries and proves real PostgreSQL races with synthetic evidence',async()=>{
 const root=process.env.COMMERCE_SOURCE_WT??fileURLToPath(new URL('../../',import.meta.url));
 const fixture=fileURLToPath(new URL('../fixtures/copy-source-isolation-root-postgresql.mjs',import.meta.url));
 const result=await promisify(execFile)(process.execPath,['--import','tsx',fixture],{
  cwd:root,env:{...process.env,COMMERCE_SOURCE_WT:root},timeout:90000,maxBuffer:512*1024,
 });
 const summary=JSON.parse(result.stdout) as {status:string;all_evidence_synthetic:boolean;root_cli_executed:boolean;node:string;owner_role:string;database_owner:string;tests:{name:string;status:string}[]};
 expect(summary.status).toBe('PASS');expect(summary.all_evidence_synthetic).toBe(true);expect(summary.root_cli_executed).toBe(false);
 expect(summary.node).toMatch(/^v24\./);expect(summary.owner_role).toBe('commerce_owner');expect(summary.database_owner).toBe('commerce_owner');expect(summary.tests).toHaveLength(18);expect(summary.tests.every(test=>test.status==='PASS')).toBe(true);
 expect(summary.tests.map(test=>test.name)).toEqual(expect.arrayContaining([
  'prepare exact replay changes only one challenge and no business table',
  'canonical PAT report alone never supplies Root human proof',
  'separate bound human fixture plus canonical API report finalizes once without business effects',
  'actual challenge row-lock wait crosses expiry and rolls back finalize',
  'two finalizers wait on the canonical channel advisory lock then reuse one exact receipt',
  'issuer waits for the API operations lock before taking channel and avoids the inverted-order deadlock',
  'completed replay waits on canonical idempotency then rejects expiry without reviving a receipt',
  'completed replay rechecks PAT expiry after its actual row-lock wait',
  'runtime API role cannot invoke owner issuer or manufacture completion',
 ]));
},95000);
