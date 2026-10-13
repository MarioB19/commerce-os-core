import {recoverSending} from '../../apps/channel-worker/src/dispatch.js';
import {processWarmupSimulations} from '../../apps/automation-worker/src/warmup-simulation.js';
import {afterAll,beforeEach,it,expect} from 'vitest';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {disposeAllFixtureProfiles} from '../support/migrated-database.js';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {pool,withTransaction} from '../../packages/db/src/index.js';
import {createWarmupSimulation,readWarmupSimulation} from '../../packages/db/src/warmup-simulation.js';
afterAll(()=>pool.end());
// V7 F2: a laboratory run executes inside its requesting profile; every case
// starts from fresh synthetic profiles (an installation admits three).
beforeEach(()=>disposeAllFixtureProfiles(pool));
async function labRun<T>(workspace:string,work:(c:Parameters<Parameters<typeof withTransaction>[0]>[0])=>Promise<T>){await fixtureProfiles(workspace);return withTransaction(work);}
it('entrypoint worker processes complete the persisted virtual run without a test-side dispatcher',async()=>{
 const workspace='v5-process-'+randomUUID(),run=await labRun(workspace,c=>createWarmupSimulation(c,workspace,{seed:16,at:'2026-09-14T12:00:00Z',participants:2,fault:'none'}));
 const children:ChildProcess[]=[],errors:string[]=[];
 try{
 for(const worker of ['automation-worker','channel-worker']){const child=spawn(process.execPath,['--import','tsx',`apps/${worker}/src/index.ts`],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',LOG_LEVEL:'silent'},stdio:['ignore','ignore','pipe']});child.stderr?.on('data',(chunk:Buffer)=>{const value=chunk.toString();if(value.includes('failed'))errors.push(value.slice(0,200));});children.push(child);}
 let result=await readWarmupSimulation(pool,run.id,workspace);const until=Date.now()+50000;while(Date.now()<until&&result?.status==='RUNNING'){await new Promise(resolve=>setTimeout(resolve,500));result=await readWarmupSimulation(pool,run.id,workspace);}
 expect(result?.status,JSON.stringify({result,errors})).toBe('COMPLETED');expect(result?.turns).toHaveLength(6);expect(result?.turns.every(t=>t.received_envelope_id&&t.status==='DELIVERED'&&t.attempts===1)).toBe(true);
 }finally{await Promise.all(children.map(async child=>{if(child.exitCode!==null)return;child.kill('SIGTERM');await Promise.race([once(child,'exit'),new Promise<void>(resolve=>setTimeout(()=>{child.kill('SIGKILL');resolve();},5000))]);}));}
},60000);

it('abandoned virtual sends use the run clock, while retaining UNKNOWN after actual virtual expiry',async()=>{
 const workspace='v5-clock-'+randomUUID(),run=await labRun(workspace,c=>createWarmupSimulation(c,workspace,{seed:17,at:'2026-09-14T12:00:00Z',participants:2,fault:'none'}));
 await processWarmupSimulations();
 const effect=(await pool.query("SELECT o.id,r.virtual_now FROM outbox o JOIN warmup_simulation_runs r ON r.execution_workspace=o.workspace_id WHERE r.id=$1 LIMIT 1",[run.id])).rows[0];expect(effect).toBeTruthy();
 await pool.query("UPDATE outbox SET status='SENDING',claimed_at=$2 WHERE id=$1",[effect.id,effect.virtual_now]);await recoverSending(60);expect((await pool.query('SELECT status FROM outbox WHERE id=$1',[effect.id])).rows[0].status).toBe('SENDING');
 await pool.query("UPDATE warmup_simulation_runs SET virtual_now=virtual_now+interval '2 minutes' WHERE id=$1",[run.id]);await recoverSending(60);expect((await pool.query('SELECT status FROM outbox WHERE id=$1',[effect.id])).rows[0].status).toBe('UNKNOWN');
});
