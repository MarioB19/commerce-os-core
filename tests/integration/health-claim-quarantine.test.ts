import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';
import type {DomainRecord} from '../../packages/contracts/src/index.js';
import type {HealthSignal} from '../../packages/messaging/src/index.js';
import {fixtureProfilesOn,releaseFixtureNumbers} from '../support/profile-fixture.js';

const original=process.env.DATABASE_URL!,control=new pg.Pool({connectionString:original});
const database='health_claim_'+randomUUID().replaceAll('-',''),ownerUrl=new URL(original);ownerUrl.pathname='/'+database;
const workerUrl=new URL(ownerUrl);workerUrl.searchParams.set('options','-c role=commerce_channel');
const root=fileURLToPath(new URL('../../',import.meta.url));
// V7 F2: an installation admits three profiles and 20 connected numbers. The
// disabled batch keeps its own profile sorted first; other REAL accounts share
// one profile and peers without settings use the third. The >20 account worker
// bound keeps its pathological fixture by retiring quota reservations (test-only).
const disabledWorkspace='a-health-disabled-'+randomUUID(),sharedWorkspace='health-quarantine-'+randomUUID(),otherWorkspace='health-other-'+randomUUID();
let created=false,admin:pg.Pool,pool:pg.Pool,collectHealth:typeof import('../../apps/channel-worker/src/lifecycle.js').collectHealth,recordHealth:typeof import('../../apps/channel-worker/src/lifecycle.js').recordHealth;
let putRecord:typeof import('../../packages/db/src/index.js').putRecord,SimulatorProvider:typeof import('../../packages/messaging/src/index.js').SimulatorProvider;
beforeAll(async()=>{
 await control.query(`CREATE DATABASE "${database}" TEMPLATE template0`);created=true;
 await promisify(execFile)(process.execPath,['--import','tsx',realpathSync(fileURLToPath(new URL('../../packages/db/src/migrate.ts',import.meta.url)))],{cwd:root,env:{...process.env,DATABASE_URL:ownerUrl.toString()},timeout:30000});
 admin=new pg.Pool({connectionString:ownerUrl.toString()});
 {const c=await admin.connect();try{await c.query('BEGIN');await fixtureProfilesOn(c,disabledWorkspace,sharedWorkspace,otherWorkspace);await c.query('COMMIT');}finally{c.release();}}process.env.DATABASE_URL=workerUrl.toString();vi.resetModules();
 ({pool,putRecord}=await import('../../packages/db/src/index.js'));({collectHealth,recordHealth}=await import('../../apps/channel-worker/src/lifecycle.js'));
 ({SimulatorProvider}=await import('../../packages/messaging/src/index.js'));
 expect((await pool.query('SELECT current_user role')).rows[0].role).toBe('commerce_channel');
});
beforeEach(async()=>{await admin.query('DELETE FROM operational_settings');});
afterAll(async()=>{await pool?.end();await admin?.end();process.env.DATABASE_URL=original;try{if(created)await control.query(`DROP DATABASE "${database}"`);}finally{await control.end();}});
async function account(workspace=sharedWorkspace,environment:'REAL'|'SIMULATION'='REAL',disabled?:boolean){
 const ref='health-'+randomUUID();
 const a=await putRecord(admin,{workspaceId:workspace,environment,kind:'channel_account',body:{provider:'waha',gateway_ref:ref,sending_enabled:false,status:'UNKNOWN'}});
 if(environment==='REAL')await releaseFixtureNumbers(admin);
 if(disabled!==undefined)await admin.query("INSERT INTO integration_settings(workspace_id,environment,key,type,reference,label,version,enabled,updated_by,config) VALUES($1,$2,$3,'waha',$4,'Synthetic health profile',1,$5,'synthetic',$6)",[workspace,environment,'waha:'+ref,ref,!disabled,{base_url:'http://'+ref+'.example.invalid'}]);
 return a;
}
const healthy=():HealthSignal[]=>{const at=new Date(Date.now()-1);return[{dimension:'session',status:'OK',value:'WORKING',source:'provider_read',scope:'account',availability:'supported',observedAt:at.toISOString(),expiresAt:new Date(at.getTime()+60000).toISOString()}];};
function factory(seen:Set<string>){return(a:DomainRecord)=>{seen.add(a.id);const provider=new SimulatorProvider();provider.health=async()=>healthy();provider.lifecycle=async()=>{throw new Error('EXTERNAL_MUTATION_FORBIDDEN');};return provider;};}
async function frozen(workspace:string,hold=false){await admin.query("INSERT INTO operational_settings(workspace_id,environment,version,body,updated_by,release_hold) VALUES($1,'REAL',1,$2,'synthetic',$3) ON CONFLICT (workspace_id,environment) DO UPDATE SET release_hold=EXCLUDED.release_hold",[workspace,{dispatch_frozen:true,real_sends_enabled:false,allow_real_operations:false,allow_channel_onboarding:false,contact_messages_per_minute:1,channel_account_concurrency:1},hold]);}
async function state(ids:string[]){return(await admin.query(`SELECT json_build_object('accounts',(SELECT jsonb_agg(r ORDER BY r.id) FROM records r WHERE id=ANY($1::uuid[])), 'sessions',(SELECT jsonb_agg(s ORDER BY s.id) FROM channel_sessions s WHERE account_id=ANY($1::uuid[])), 'ownership',(SELECT coalesce(jsonb_agg(o ORDER BY o.account_id),'[]') FROM session_ownership o WHERE account_id=ANY($1::text[])), 'health',(SELECT coalesce(jsonb_agg(r ORDER BY r.id),'[]') FROM records r WHERE kind='health_signal' AND body->>'account_id'=ANY($1::text[])), 'events',(SELECT coalesce(jsonb_agg(e ORDER BY e.id),'[]') FROM domain_events e WHERE aggregate_id=ANY($1::text[]))) data`,[ids])).rows[0].data;}
async function recentOthers(ids:string[]){await admin.query('UPDATE channel_sessions SET last_health_at=clock_timestamp() WHERE NOT(account_id=ANY($1::uuid[]))',[ids]);}

it('explicitly disabled REAL profiles do not call factory or alter account/session/health/probe and do not consume the global 20 limit',async()=>{
 const workspace=disabledWorkspace,disabled=[];for(let i=0;i<21;i++)disabled.push(await account(workspace,'REAL',true));
 const eligible=[];for(let i=0;i<21;i++)eligible.push(await account(workspace));
 const disabledIds=disabled.map(a=>a.id),before=await state(disabledIds),seen=new Set<string>();
 expect(await collectHealth(factory(seen),'synthetic-quarantine-owner')).toBe(20);
 expect(seen.size).toBe(20);expect(eligible.filter(a=>seen.has(a.id))).toHaveLength(20);expect(disabled.some(a=>seen.has(a.id))).toBe(false);
 expect(await state(disabledIds)).toEqual(before);
 // One remaining eligible account is not starved by the 21 disabled sessions.
 const later=new Set<string>();expect(await collectHealth(factory(later),'synthetic-next-owner')).toBe(1);expect(later.size).toBe(1);
 expect(await state(disabledIds)).toEqual(before);
});
it('release hold skips the health claim and transport factory with an exact unchanged session',async()=>{
 const a=await account();await recentOthers([a.id]);await frozen(a.workspace_id,true);const before=await state([a.id]),seen=new Set<string>();
 expect(await collectHealth(factory(seen),'synthetic-hold-owner')).toBe(0);expect(seen.size).toBe(0);expect(await state([a.id])).toEqual(before);
});
it('missing REAL profiles and disabled SIMULATION profiles retain the previous polling behavior',async()=>{
 const missing=await account(),sim=await account(otherWorkspace,'SIMULATION',true);await recentOthers([missing.id,sim.id]);
 const seen=new Set<string>();expect(await collectHealth(factory(seen),'synthetic-compatible-owner')).toBe(2);expect(seen).toEqual(new Set([missing.id,sim.id]));
 const rows=(await admin.query('SELECT health_probe_until,health_probe_owner,last_health_at FROM channel_sessions WHERE account_id=ANY($1::uuid[])',[[missing.id,sim.id]])).rows;
 expect(rows.every(s=>s.health_probe_until===null&&s.health_probe_owner==='synthetic-compatible-owner'&&s.last_health_at!==null)).toBe(true);
});
it('waits for operations authority before claiming session rows so the policy writer can lock the session without deadlock',async()=>{
 const a=await account();await recentOthers([a.id]);await frozen(a.workspace_id);const before=await state([a.id]),holder=await admin.connect(),seen=new Set<string>();let pending:Promise<number>|undefined;
 try{
  await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['operations:'+a.workspace_id+':REAL']);
  await holder.query("SELECT 1 FROM operational_settings WHERE workspace_id=$1 AND environment='REAL' FOR UPDATE",[a.workspace_id]);
  const lockPid=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  pending=collectHealth(factory(seen),'synthetic-ordered-owner');const deadline=performance.now()+5000;let blocked=false;
  while(performance.now()<deadline){const waiting=(await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory' AND $1=ANY(pg_blocking_pids(pid))) waiting",[lockPid])).rows[0].waiting;if(waiting){blocked=true;break;}await admin.query('SELECT pg_sleep(0.01)');}
  expect(blocked,'actual operations advisory waiter').toBe(true);expect(seen.size).toBe(0);expect(await state([a.id])).toEqual(before);
  await holder.query('SET LOCAL lock_timeout=\'1s\'');await holder.query('SELECT account_id FROM channel_sessions WHERE account_id=$1 FOR UPDATE',[a.id]);
  await holder.query('COMMIT');expect(await pending).toBe(1);pending=undefined;expect(seen).toEqual(new Set([a.id]));
 }finally{await holder.query('ROLLBACK').catch(()=>{});await pending?.catch(()=>{});holder.release();}
});

it('discards an SDK health read without account/session/ownership/health/event writes when hold wins before persistence',async()=>{
 const a=await account();await frozen(a.workspace_id);await admin.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,frozen,lease_expires_at) VALUES($1,$2,'synthetic-held-owner',1,true,clock_timestamp()-interval '1 minute')",[a.id,a.workspace_id]);
 const before=await state([a.id]),holder=await admin.connect();let writer:Promise<void>|undefined,pending:Promise<HealthSignal[]>|undefined;let calls=0,blocked=false;
 try{
  await holder.query('BEGIN');await holder.query("SET LOCAL lock_timeout='5s'");const writerPid=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  pending=recordHealth(a,()=>{const provider=new SimulatorProvider();provider.health=async()=>{
   calls++;writer=(async()=>{await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['operations:'+a.workspace_id+':REAL']);await holder.query("UPDATE operational_settings SET release_hold=true WHERE workspace_id=$1 AND environment='REAL'",[a.workspace_id]);await holder.query('COMMIT');})();
   // The writer is enqueued while the SDK transaction holds operations SHARE.
   // It receives authority before the later persistence SHARE can pass.
   const deadline=performance.now()+4000;while(performance.now()<deadline){if((await admin.query('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[writerPid])).rows[0].waiting){blocked=true;break;}await admin.query('SELECT pg_sleep(0.01)');}
   expect(blocked,'actual policy writer waiting for SDK operations share').toBe(true);return healthy();
  };provider.lifecycle=async()=>{throw new Error('EXTERNAL_MUTATION_FORBIDDEN');};return provider;});
  expect(await pending).toEqual([]);pending=undefined;await writer;writer=undefined;expect(calls).toBe(1);expect(blocked).toBe(true);
  expect((await admin.query("SELECT release_hold FROM operational_settings WHERE workspace_id=$1 AND environment='REAL'",[a.workspace_id])).rows[0].release_hold).toBe(true);
  expect(await state([a.id])).toEqual(before);
 }finally{await holder.query('ROLLBACK').catch(()=>{});await writer?.catch(()=>{});await pending?.catch(()=>{});holder.release();}
});

async function stoppedFrozen(a:DomainRecord){
 await admin.query("UPDATE channel_sessions SET desired_state='STOPPED',operational_pause=true,recovery_enabled=false WHERE account_id=$1",[a.id]);
 await admin.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,frozen,lease_expires_at) VALUES($1,$2,'preserved-frozen-owner',9,true,now()-interval '1 minute')",[a.id,a.workspace_id]);
}
it('does not probe an enabled REAL profile in a frozen stopped session or consume its global health slot',async()=>{
 const quiet=await account(undefined,'REAL',false),normal=await account(otherWorkspace,'REAL',false),sim=await account(otherWorkspace,'SIMULATION',false);
 await frozen(quiet.workspace_id);await stoppedFrozen(quiet);await stoppedFrozen(sim);await recentOthers([quiet.id,normal.id,sim.id]);
 const before=await state([quiet.id]),seen=new Set<string>();
 expect(await collectHealth(factory(seen),'synthetic-enabled-frozen-owner')).toBe(2);expect(seen).toEqual(new Set([normal.id,sim.id]));expect(await state([quiet.id])).toEqual(before);
});
it('retains automatic health for other eligible REAL sessions and explicit health for a frozen session',async()=>{
 const quiet=await account(undefined,'REAL',false),running=await account(undefined,'REAL',false),unpaused=await account(undefined,'REAL',false),recovering=await account(undefined,'REAL',false);
 for(const a of [quiet,running,unpaused,recovering]){await frozen(a.workspace_id);await stoppedFrozen(a);}
 await admin.query("UPDATE channel_sessions SET desired_state='RUNNING' WHERE account_id=$1",[running.id]);
 await admin.query('UPDATE channel_sessions SET operational_pause=false WHERE account_id=$1',[unpaused.id]);
 await admin.query('UPDATE channel_sessions SET recovery_enabled=true WHERE account_id=$1',[recovering.id]);
 await recentOthers([quiet.id,running.id,unpaused.id,recovering.id]);const seen=new Set<string>();
 expect(await collectHealth(factory(seen),'synthetic-enabled-other-owner')).toBe(3);expect(seen).toEqual(new Set([running.id,unpaused.id,recovering.id]));
 const explicit=new Set<string>();await recordHealth(quiet,factory(explicit));expect(explicit).toEqual(new Set([quiet.id]));
});
