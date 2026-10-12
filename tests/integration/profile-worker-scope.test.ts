/** Synthetic isolated PostgreSQL; no scheduler, provider or production access. */
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {asProfileOwner,requireMigratedProfileSchema} from '../support/migrated-database.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {createProfileWorkerRuntime} from '../../packages/db/src/profile-worker-scope.js';
import {profileRoutedPool,currentProfileExecutor} from '../../packages/db/src/profile-query-routing.js';
import {bindProfileEnvironment} from '../../packages/db/src/profile-environment.js';
import {withTransaction} from '../../packages/db/src/index.js';
import type {ProfilePool} from '../../packages/db/src/profile-context.js';

const suffix=randomBytes(6).toString('hex'),one='worker_one_'+suffix,two='worker_two_'+suffix,login='worker_'+suffix;
let admin:pg.Pool,worker:pg.Pool,scoped:ProfilePool;
let runtime:ReturnType<typeof createProfileWorkerRuntime>;
let routed:{query:(sql:string,values?:unknown[])=>Promise<pg.QueryResult>;connect:ProfilePool['connect']};
describe('worker phases use native profile transactions with committed intent before IO',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:5000});
  await requireMigratedProfileSchema(admin);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'One','UTC',1,1,1),($2,'Two','UTC',1,1,1)",[one,two]);
  // Explicit fixture RLS. This is not an assertion that production policies were installed.
  await admin.query(`CREATE TABLE worker_phase_fixture(id text PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,state text NOT NULL,xid bigint NOT NULL);
   ALTER TABLE worker_phase_fixture ENABLE ROW LEVEL SECURITY;ALTER TABLE worker_phase_fixture FORCE ROW LEVEL SECURITY;
   CREATE POLICY worker_fixture_scope ON worker_phase_fixture USING(workspace_id=current_setting('app.workspace_id',true) AND environment=current_setting('app.environment',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true) AND environment=current_setting('app.environment',true));
   GRANT SELECT,INSERT,UPDATE ON worker_phase_fixture TO commerce_automation`);
  const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT commerce_automation TO "${login}"`);
  url.username=login;url.password=secret;worker=new pg.Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:5000});
  scoped={async connect(){const c=await worker.connect();try{await c.query('SET ROLE commerce_automation');return{query:c.query.bind(c),release:c.release.bind(c)};}catch(e){c.release();throw e;}}};
  runtime=createProfileWorkerRuntime(scoped,'commerce_automation','REAL');
  routed=profileRoutedPool({connect:scoped.connect.bind(scoped),query:async()=>{throw Error('GLOBAL_QUERY_FORBIDDEN');}});
 },60000);
 afterAll(async()=>{await worker?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}});
 async function selected(workspace=one){return(await runtime.discover()).find(row=>row.workspaceId===workspace)!;}
 it('uses restricted native role and discovers only facts without global table access',async()=>{
  expect((await worker.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
  expect((await runtime.discover()).map(row=>row.workspaceId).sort()).toEqual([one,two].sort());
  const c=await scoped.connect();try{await expect(c.query('SELECT * FROM profiles')).rejects.toMatchObject({code:'42501'});}finally{c.release();}
 });
 it('commits PREPARE before a separate observer and reconciles in a different transaction',async()=>{
  let xid:string|number=0,pid=0;
  await runtime.run(await selected(),async()=>{
   await withTransaction(async c=>{const row=(await c.query('SELECT txid_current() AS xid,pg_backend_pid() AS pid')).rows[0];xid=row.xid;pid=row.pid;await c.query("INSERT INTO worker_phase_fixture VALUES('commit',$1,'REAL','PREPARED',$2)",[one,xid]);});
   expect(currentProfileExecutor()).toBeUndefined();
   expect((await admin.query("SELECT state FROM worker_phase_fixture WHERE id='commit'")).rows[0].state).toBe('PREPARED');
   expect((await admin.query('SELECT xact_start FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0].xact_start).toBeNull();
   await withTransaction(async c=>{expect(String((await c.query('SELECT txid_current() xid')).rows[0].xid)).not.toBe(String(xid));await c.query("UPDATE worker_phase_fixture SET state='RECONCILED' WHERE id='commit'");});
  });
  expect((await admin.query("SELECT state FROM worker_phase_fixture WHERE id='commit'")).rows[0].state).toBe('RECONCILED');
 });
 it('uses RLS for both the profile and fixed environment in automatic phases',async()=>{
  await admin.query("INSERT INTO worker_phase_fixture VALUES('other',$1,'REAL','UNCHANGED',1),('sim',$2,'SIMULATION','UNCHANGED',1)",[two,one]);
  await runtime.run(await selected(),async()=>{
   expect((await routed.query("SELECT * FROM worker_phase_fixture WHERE id IN('other','sim')")).rows).toEqual([]);
   await expect(routed.query("INSERT INTO worker_phase_fixture VALUES('foreign',$1,'REAL','BAD',1)",[two])).rejects.toMatchObject({code:'42501'});
   await expect(routed.query("INSERT INTO worker_phase_fixture VALUES('badenv',$1,'SIMULATION','BAD',1)",[one])).rejects.toMatchObject({code:'42501'});
  });
 });
 it('binds the environment to the live native transaction without allowing a switch',async()=>{
  await runtime.run(await selected(),()=>withTransaction(async()=>{
   const db=currentProfileExecutor()!;await bindProfileEnvironment(db,'REAL');
   expect((await db.query("SELECT current_setting('app.environment') environment")).rows[0].environment).toBe('REAL');
  }));
  await expect(runtime.run(await selected(),()=>withTransaction(async()=>{
   const db=currentProfileExecutor()!;await bindProfileEnvironment(db,'SIMULATION');
  }))).rejects.toThrow('PROFILE_ENVIRONMENT_CONTEXT_MISMATCH');
 });
 it('does not roll back an earlier committed intent when authority changes before reconcile',async()=>{
  await expect(runtime.run(await selected(),async()=>{
   await routed.query("INSERT INTO worker_phase_fixture VALUES('uncertain',$1,'REAL','PREPARED',1)",[one]);
   await asProfileOwner(admin,one,c=>c.query("UPDATE profiles SET state='SUSPENDED',version=version+1 WHERE id=$1",[one]));
   await withTransaction(c=>c.query("UPDATE worker_phase_fixture SET state='BAD' WHERE id='uncertain'"));
  })).rejects.toThrow('WORKER_PROFILE_AUTHORITY_CHANGED');
  expect((await admin.query("SELECT state FROM worker_phase_fixture WHERE id='uncertain'")).rows[0].state).toBe('PREPARED');
  await expect(runtime.run(await selected(),async()=>{})).rejects.toThrow('WORKER_PROFILE_INACTIVE');
  await asProfileOwner(admin,one,c=>c.query("UPDATE profiles SET state='ACTIVE',version=version+1 WHERE id=$1",[one]));
 });
 it('locks profile authority through the phase commit',async()=>{
  const other=await admin.connect();try{
   await other.query("SET statement_timeout='100ms'");
   // V7 F2: a profile row is privacy-fenced; the owner writes from its context.
   await other.query("SELECT set_config('app.workspace_id',$1,false)",[one]);
   await runtime.run(await selected(),()=>withTransaction(async()=>{await expect(other.query('UPDATE profiles SET version=version+1 WHERE id=$1',[one])).rejects.toMatchObject({code:'57014'});}));
   await other.query('UPDATE profiles SET version=version+1 WHERE id=$1',[one]);
  }finally{await other.query('RESET statement_timeout');await other.query("SELECT set_config('app.workspace_id','',false)");other.release();}
 });
 it('rolls back a joined business failure even when caught by the caller',async()=>{
  await expect(runtime.run(await selected(),()=>withTransaction(async()=>{
   try{await withTransaction(async c=>{await c.query("INSERT INTO worker_phase_fixture VALUES('partial',$1,'REAL','BAD',1)",[one]);throw Error('SYNTHETIC_BUSINESS_FAILURE');});}catch{/* outer must still reject */}
  }))).rejects.toThrow('PROFILE_QUERY_CONTEXT_REJECTED');
  expect((await admin.query("SELECT * FROM worker_phase_fixture WHERE id='partial'")).rowCount).toBe(0);
 });
 it('forbids taking a raw pool connection during the cycle',async()=>{
  await expect(runtime.run(await selected(),async()=>{await expect(routed.connect()).rejects.toThrow('WORKER_RAW_CONNECTION_FORBIDDEN');})).rejects.toThrow('WORKER_PROFILE_REJECTED');
 });
 it('never executes a manufactured selection',async()=>{
  const real=await selected();await expect(runtime.run({...real},async()=>{throw Error('NOT_REACHED');})).rejects.toThrow('WORKER_SELECTION_REQUIRED');
 });
});
