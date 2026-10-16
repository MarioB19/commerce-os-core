import {afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type pg from 'pg';
import {pool,putRecord} from '../../packages/db/src/index.js';

// V7 F1 (RNF-03.e): scripts/v7_health_retention_batch.sql, exactly as the Root
// operator sends it, on the full V7 schema (privacy guards, composed keys, RLS).
const batchSql=await readFile(new URL('../../scripts/v7_health_retention_batch.sql',import.meta.url),'utf8');
afterAll(async()=>{await pool.end();});

const day=86400000;
async function batch(c:pg.PoolClient,key:{ws:string;env:string;account:string;dimension:string;bound:Date;limit:number}){
 await c.query(`SELECT set_config('commerce.health_retention_mode','key',true),set_config('app.workspace_id',$1,true),set_config('app.environment',$2,true),
  set_config('commerce.health_retention_account',$3,true),set_config('commerce.health_retention_dimension',$4,true),
  set_config('commerce.health_retention_bound',$5,true),set_config('commerce.health_retention_limit',$6,true)`,
  [key.ws,key.env,key.account,key.dimension,key.bound.toISOString(),String(key.limit)]);
 await c.query(batchSql);
 return (await c.query('SELECT doomed::int,projection::int,versions::int,records::int FROM health_retention_result')).rows[0];
}
// The Fase C cut over every key, scoped to this fixture's profile (the window passes no scope).
async function cut(c:pg.PoolClient,scope:string,bound:Date){
 await c.query(`SELECT set_config('commerce.health_retention_mode','all',true),set_config('commerce.health_retention_scope',$1,true),
  set_config('commerce.health_retention_bound',$2,true),set_config('commerce.health_retention_limit','50000000',true)`,[scope,bound.toISOString()]);
 await c.query(batchSql);
 return (await c.query('SELECT doomed::int,projection::int,versions::int,records::int FROM health_retention_result')).rows[0];
}
const left=async(c:pg.PoolClient,ws:string,account:string,dimension:string)=>(await c.query(
 `SELECT h.observed_at,(SELECT count(*)::int FROM record_versions v WHERE v.record_id=h.record_id) versions
  FROM health_observation_index h WHERE h.workspace_id=$1 AND h.account_id=$2 AND h.dimension=$3 ORDER BY h.observed_at NULLS FIRST`,
 [ws,account,dimension])).rows;

it('deletes old health telemetry by key, keeps the latest and recent evidence, and never leaves the immutability trigger off',async()=>{
 const c=await pool.connect(),ws='health-retention-'+randomUUID(),now=Date.now();
 try{
  await c.query('BEGIN');
  const account=await putRecord(c,{workspaceId:ws,environment:'SIMULATION',kind:'channel_account',body:{provider:'simulator',name:'Retention fixture'}});
  const other=await putRecord(c,{workspaceId:ws,environment:'SIMULATION',kind:'channel_account',body:{provider:'simulator',name:'Other number'}});
  const signal=(id:string,dimension:string,ago:number|string,extra:Record<string,unknown>={})=>putRecord(c,{workspaceId:ws,environment:'SIMULATION',kind:'health_signal',
   body:{account_id:id,dimension,scope:'account',status:'OK',source:'local_probe',observed_at:typeof ago==='string'?ago:new Date(now-ago).toISOString(),
    expires_at:typeof ago==='string'?ago:new Date(now-ago+60000).toISOString(),...extra}});
  for(const ago of [20*day,15*day,10*day,3*day,3600000])await signal(account.id,'session',ago);
  const updated=await signal(account.id,'session',12*day);
  await putRecord(c,{id:updated.id,version:updated.version,workspaceId:ws,environment:'SIMULATION',kind:'health_signal',body:{...updated.body,status:'BLOCKED'}});
  for(const ago of [30*day,25*day])await signal(account.id,'quality',ago);
  await signal(account.id,'session','invalid');
  for(const ago of [20*day,3600000])await signal(other.id,'session',ago);
  const cutoff=new Date(now-8*day);
  await c.query('SAVEPOINT s');
  // A batch for one key touches only that key, deletes projection, every version and the record.
  expect(await batch(c,{ws,env:'SIMULATION',account:account.id,dimension:'session',bound:cutoff,limit:2})).toEqual({doomed:2,projection:2,versions:2,records:2});
  expect(await batch(c,{ws,env:'SIMULATION',account:account.id,dimension:'session',bound:cutoff,limit:1000})).toEqual({doomed:2,projection:2,versions:3,records:2});
  expect(await batch(c,{ws,env:'SIMULATION',account:account.id,dimension:'session',bound:cutoff,limit:1000})).toEqual({doomed:0,projection:0,versions:0,records:0});
  const session=await left(c,ws,account.id,'session');
  expect(session.map(r=>r.observed_at===null?'invalid':Math.round((now-new Date(r.observed_at).getTime())/day))).toEqual(['invalid',3,0]);
  expect(session.every(r=>r.versions===1)).toBe(true);
  expect((await left(c,ws,other.id,'session')).length).toBe(2);
  // A key silent for longer than the cutoff keeps its latest observation.
  const latestQuality=new Date(now-25*day);
  expect(await batch(c,{ws,env:'SIMULATION',account:account.id,dimension:'quality',bound:latestQuality,limit:1000})).toEqual({doomed:1,projection:1,versions:1,records:1});
  expect(await batch(c,{ws,env:'SIMULATION',account:account.id,dimension:'quality',bound:new Date(now-20*day),limit:1000})).toEqual({doomed:0,projection:0,versions:0,records:0});
  expect((await left(c,ws,account.id,'quality')).length).toBe(1);
  // Immutability never changed for anybody, including the superuser.
  const kept=(await c.query("SELECT record_id FROM health_observation_index WHERE workspace_id=$1 AND account_id=$2 AND dimension='session' AND observed_at IS NOT NULL LIMIT 1",[ws,account.id])).rows[0].record_id;
  await c.query('SAVEPOINT immutable');
  await expect(c.query('DELETE FROM record_versions WHERE record_id=$1',[kept])).rejects.toThrow(/IMMUTABLE_EVIDENCE/);
  await c.query('ROLLBACK TO SAVEPOINT immutable');
  const triggers=(await c.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.record_versions'::regclass AND tgname='immutable_versions'")).rows;
  expect(triggers).toEqual([{tgenabled:'O'}]);
  expect((await c.query('SHOW session_replication_role')).rows[0].session_replication_role).toBe('origin');
  await c.query('ROLLBACK TO SAVEPOINT s');

  // The Fase C cut applies the same rule to every key at once.
  await c.query('SAVEPOINT cut');
  expect(await cut(c,ws,cutoff)).toEqual({doomed:6,projection:6,versions:7,records:6});
  expect((await left(c,ws,account.id,'session')).length).toBe(3);
  expect((await left(c,ws,account.id,'quality')).length).toBe(1);
  expect((await left(c,ws,other.id,'session')).length).toBe(1);
  expect(await cut(c,ws,cutoff)).toEqual({doomed:0,projection:0,versions:0,records:0});
  expect((await c.query('SHOW session_replication_role')).rows[0].session_replication_role).toBe('origin');
  await c.query('ROLLBACK TO SAVEPOINT cut');

  // Bounds: never within two days, never an application role, never a referenced signal.
  await c.query('SAVEPOINT recent');
  await expect(batch(c,{ws,env:'SIMULATION',account:account.id,dimension:'session',bound:new Date(now-day),limit:10})).rejects.toThrow(/HEALTH_RETENTION_BOUNDS_INVALID/);
  await c.query('ROLLBACK TO SAVEPOINT recent');
  await c.query('SAVEPOINT role');
  await c.query('SET LOCAL ROLE commerce_api');
  await expect(batch(c,{ws,env:'SIMULATION',account:account.id,dimension:'session',bound:cutoff,limit:10})).rejects.toThrow(/HEALTH_RETENTION_SUPERUSER_REQUIRED/);
  await c.query('ROLLBACK TO SAVEPOINT role');
  const oldest=(await c.query("SELECT record_id FROM health_observation_index WHERE workspace_id=$1 AND account_id=$2 AND dimension='session' ORDER BY observed_at LIMIT 1",[ws,account.id])).rows[0].record_id;
  // Rolled back with the test transaction; a temporary table cannot reference records.
  const reference='retention_reference_'+randomUUID().replaceAll('-','');
  await c.query(`CREATE TABLE ${reference}(record_id uuid REFERENCES records(id))`);
  await c.query(`INSERT INTO ${reference} VALUES($1)`,[oldest]);
  await c.query('SAVEPOINT referenced');
  await expect(batch(c,{ws,env:'SIMULATION',account:account.id,dimension:'session',bound:cutoff,limit:1000})).rejects.toThrow(/HEALTH_RETENTION_REFERENCED/);
  await c.query('ROLLBACK TO SAVEPOINT referenced');
  await c.query('SAVEPOINT referenced_cut');
  await expect(cut(c,ws,cutoff)).rejects.toThrow(/HEALTH_RETENTION_REFERENCED/);
  await c.query('ROLLBACK TO SAVEPOINT referenced_cut');
  expect((await left(c,ws,account.id,'session')).length).toBe(7);
  expect((await c.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.record_versions'::regclass AND tgname='immutable_versions'")).rows).toEqual([{tgenabled:'O'}]);
 }finally{await c.query('ROLLBACK');c.release();}
});
