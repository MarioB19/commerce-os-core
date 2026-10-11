import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const folder=mkdtempSync(join(tmpdir(),'mcl-attempts-')),path=join(folder,'attempts.sqlite');
const script=`import {accessAttempts} from './lib/access-attempts.ts';import assert from 'node:assert/strict';const a=accessAttempts(process.env.MCL_ACCESS_DB);`;
function run(code){const r=spawnSync(process.execPath,['--experimental-strip-types','--experimental-sqlite','--input-type=module','-e',script+code],{encoding:'utf8',env:{...process.env,MCL_ACCESS_DB:path}});assert.equal(r.status,0,r.stderr);}
try{
 run(`for(let i=0;i<10;i++)assert.equal(a.record('client-a',false,1000),true);assert.equal(a.record('client-a',true,1001),false);assert.equal(a.record('client-b',true,1001),true);`);
 run(`assert.equal(a.record('client-a',true,1002),false);assert.equal(a.record('client-a',true,901001),true);assert.equal(a.record('client-a',false,901002),true);assert.equal(a.record('client-a',true,901003),true);`);
 console.log('Access limit: persisted after restart, independent clients, expiry and valid access PASS.');
}finally{rmSync(folder,{recursive:true,force:true});}
