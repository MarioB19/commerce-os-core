import {afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {pool,putRecord} from '../../packages/db/src/index.js';
import {readEffectiveHealth} from '../../packages/db/src/effective-health.js';
import {numberHealth} from '../../packages/db/src/number-health.js';
import {withReadBudget} from '../../packages/db/src/read-budget.js';
import {operationalStatistics} from '../../packages/domain/src/health/operational-statistics.js';
import type {Evidence} from '../../packages/domain/src/health/number-health.js';

afterAll(async()=>{await pool.end();});

it('indexes valid instants without changing evidence and ignores malformed/future/invalid windows',async()=>{
 const workspaceId='health-projection-'+randomUUID(),now=new Date('2026-09-27T12:00:00Z');
 const account=await putRecord(pool,{workspaceId,environment:'SIMULATION',kind:'channel_account',body:{name:'Projection fixture',provider:'simulator'}});
 const base={account_id:account.id,dimension:'session',scope:'account',status:'OK',source:'provider_read',observed_at:'2026-09-27T11:59:00Z',expires_at:'2026-09-27T12:01:00Z'};
 const valid=await putRecord(pool,{workspaceId,environment:'SIMULATION',kind:'health_signal',body:base});
 for(const body of [{observed_at:'not-a-time'},{expires_at:'bad'},{observed_at:'2026-09-27T13:00:00Z',expires_at:'2026-09-27T14:00:00Z'},{expires_at:'2026-09-27T11:58:00Z'},{expires_at:'infinity'}])await putRecord(pool,{workspaceId,environment:'SIMULATION',kind:'health_signal',body:{...base,...body,status:'BLOCKED'}});
 const selected=await readEffectiveHealth(pool,{workspaceId,environment:'SIMULATION',accountId:account.id,now});
 expect(selected.by_dimension.session).toMatchObject({id:valid.id,status:'OK',current:true});
 expect((await pool.query('SELECT body,version FROM records WHERE id=$1',[valid.id])).rows[0]).toEqual({body:base,version:1});
 const updated=await putRecord(pool,{id:valid.id,version:valid.version,workspaceId,environment:'SIMULATION',kind:'health_signal',body:{...base,status:'BLOCKED'}});
 expect((await readEffectiveHealth(pool,{workspaceId,environment:'SIMULATION',accountId:account.id,now})).by_dimension.session).toMatchObject({id:updated.id,status:'BLOCKED'});
 const c=await pool.connect();
 try{
  await c.query('BEGIN');await c.query('SET LOCAL ROLE commerce_channel');
  await expect(c.query("UPDATE health_observation_index SET status='OK' WHERE record_id=$1",[valid.id])).rejects.toThrow(/permission denied/);
  await c.query('ROLLBACK');
  await c.query('BEGIN');await c.query('SET LOCAL ROLE commerce_channel');
  const next=await putRecord(c,{workspaceId,environment:'SIMULATION',kind:'health_signal',body:{...base,observed_at:'2026-09-27T11:59:30Z'}});
  expect((await readEffectiveHealth(c,{workspaceId,environment:'SIMULATION',accountId:account.id,now})).by_dimension.session?.id).toBe(next.id);
  await c.query('ROLLBACK');
 }finally{c.release();}
});

it('keeps operational window coverage and boundary transitions while reading only the session dimension',async()=>{
 const workspaceId='health-window-'+randomUUID(),now=new Date('2026-09-27T12:00:00Z');
 const account=await putRecord(pool,{workspaceId,environment:'SIMULATION',kind:'channel_account',body:{name:'Window fixture',provider:'simulator'}});
 const observations=[
  {dimension:'session',status:'BLOCKED',observed_at:'2026-09-20T11:59:00Z',expires_at:'2026-09-20T12:02:00Z'},
  {dimension:'session',status:'OK',observed_at:'2026-09-20T12:01:00Z',expires_at:'2026-09-20T12:02:00Z'},
  {dimension:'session',status:'OK',observed_at:'2026-09-27T11:59:00Z',expires_at:'2026-09-27T12:01:00Z'},
  {dimension:'transport',status:'BLOCKED',observed_at:'2026-09-27T11:59:00Z',expires_at:'2026-09-27T12:01:00Z'},
 ];
 const history:Evidence[]=[];
 for(const signal of observations){const body={account_id:account.id,scope:'account',source:'fixture',...signal};const r=await putRecord(pool,{workspaceId,environment:'SIMULATION',kind:'health_signal',body});history.push({id:r.id,...body});}
 const actual=await numberHealth(pool,account,now);
 expect(actual.operational_statistics).toEqual([1,24,168].map(hours=>operationalStatistics({now,hours,signals:history,dimension:'session',envelopes:[],queue:[],simulation:true})));
 expect(actual.operational_statistics[2]?.session.reconnections_observed).toBe(1);
});

it('cancels a slow read on the server and leaves the pooled connection usable',async()=>{
 const started=Date.now();
 await expect(withReadBudget(pool,150,c=>c.query('SELECT pg_sleep(2)'))).rejects.toThrow(/statement timeout|READ_BUDGET_EXCEEDED|Query read timeout/);
 expect(Date.now()-started).toBeLessThan(1500);
 expect((await pool.query('SELECT 1 ok')).rows[0].ok).toBe(1);
 expect((await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND query='SELECT pg_sleep(2)'" )).rows[0].n).toBe(0);
});

it('does not permit mutations inside a bounded read projection',async()=>{
 await expect(withReadBudget(pool,1000,c=>c.query("INSERT INTO operational_settings(workspace_id,environment,body) VALUES('budget-write','SIMULATION','{}')"))).rejects.toThrow(/read-only/);
});


it('bounds an exhausted pool and releases a client acquired after the deadline',async()=>{
 const limited=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1}),held=await limited.connect();
 let reads=0;
 try{
  const started=Date.now();
  await expect(withReadBudget(limited,100,async()=>{reads++;return 1;})).rejects.toThrow('READ_BUDGET_EXCEEDED');
  expect(Date.now()-started).toBeLessThan(1000);
  expect(reads).toBe(0);
 }finally{held.release();}
 try{
  expect(await withReadBudget(limited,1000,async c=>(await c.query('SELECT 1 ok')).rows[0].ok)).toBe(1);
  expect(limited.waitingCount).toBe(0);expect(limited.idleCount).toBe(1);
 }finally{await limited.end();}
});


it('does not count a locally released claim as a physical send or a duplicate attempt',async()=>{
 const workspaceId='health-unsent-'+randomUUID(),now=new Date(),account=await putRecord(pool,{workspaceId,environment:'SIMULATION',kind:'channel_account',body:{name:'Unsent fixture',provider:'simulator'}}),effect=randomUUID();
 await pool.query("INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,status,config_hash,created_at) VALUES($1,$2,'SIMULATION',$3,$4,$5,$6,'{}','BLOCKED','fixture',$7)",[effect,workspaceId,account.id,randomUUID(),randomUUID(),randomUUID(),new Date(now.getTime()-1000)]);
 await pool.query("INSERT INTO effect_attempts(id,effect_id,claim_id,status,started_at,result) VALUES($1,$2,$3,'NOT_SENT',$4,$5)",[randomUUID(),effect,randomUUID(),new Date(now.getTime()-500),{external_attempt:false}]);
 const read=async()=>(await numberHealth(pool,account,now)).statistics.find(row=>row.purpose==='SIMULATION')!.windows[0];
 expect(await read()).toMatchObject({attempted:0,physical_attempts:0,queued_without_attempt:1});
 await pool.query("INSERT INTO effect_attempts(id,effect_id,claim_id,status,started_at) VALUES($1,$2,$3,'SENT',$4)",[randomUUID(),effect,randomUUID(),new Date(now.getTime()-100)]);
 await pool.query("UPDATE outbox SET status='SENT',attempts=1 WHERE id=$1",[effect]);
 expect(await read()).toMatchObject({attempted:1,physical_attempts:1,queued_without_attempt:0});
});
