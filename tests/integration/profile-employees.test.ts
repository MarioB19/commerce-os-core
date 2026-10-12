import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import Fastify,{type FastifyInstance} from 'fastify';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {requireMigratedProfileSchema,selectFixtureSession} from '../support/migrated-database.js';
import {profileEmployeeRoutes} from '../../apps/api/src/profile-employees.js';
import {withProfileTransaction} from '../../packages/db/src/profile-context.js';
import {withProfileSessionTransaction} from '../../packages/db/src/profile-session-transaction.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
const suffix=randomBytes(8).toString('hex'),login='f2_employees_'+suffix,one='employees_one_'+suffix,two='employees_two_'+suffix;
const actor='owner_a_'+suffix,other='owner_b_'+suffix,employee='employee_'+suffix,foreign='foreign_'+suffix;
const sessions=new Map([actor,other].map(userId=>[userId,{id:'session_'+userId,userId}]));
let admin:pg.Pool|undefined,runtime:pg.Pool|undefined,app:FastifyInstance|undefined;
const selections=new Map<string,number>();
const read=async(userId=employee,workspace=one)=>(await admin!.query('SELECT user_id,role,active,version FROM memberships WHERE workspace_id=$1 AND user_id=$2',[workspace,userId])).rows[0];
const events=async()=>Number((await admin!.query("SELECT count(*) FROM domain_events WHERE workspace_id=$1 AND event_type='profile.employee.access.changed'",[one])).rows[0].count);
const update=async(userId:string,body:Record<string,unknown>,as=actor)=>app!.inject({method:'PATCH',url:'/v2/employees/'+encodeURIComponent(userId),headers:{origin:'https://fixture.test','x-commerce-profile-id':one,'x-commerce-profile-version':String(selections.get(as)),'x-fixture-actor':as},payload:body});
async function refresh(as:string){selections.set(as,(await selectFixtureSession(runtime!,sessions.get(as)!,one,selections.get(as)??0)).version);}
describe('employee authority on restricted native PostgreSQL',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw new Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:5000});await requireMigratedProfileSchema(admin);
  const password=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT`);await admin.query(`GRANT commerce_api TO "${login}"`);
  for(const id of [actor,other,employee,foreign])await admin.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$1||\'@example.test\')',[id]);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic One','UTC',1,10,10),($2,'Synthetic Two','UTC',1,10,10)",[one,two]);
  for(const id of [actor,other,employee])await admin.query('INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,$3)',[id,one,id===employee?'operator':'owner']);await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[foreign,two]);
  for(const session of sessions.values())await admin.query('INSERT INTO session(id,"userId",token,"expiresAt") VALUES($1,$2,$1,now()+interval \'1 hour\')',[session.id,session.userId]);
  url.username=login;url.password=password;runtime=new pg.Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:5000});await refresh(actor);await refresh(other);
  app=Fastify();await profileEmployeeRoutes(app,{origins:['https://fixture.test'],nativeSession:async req=>sessions.get(String(req.headers['x-fixture-actor']))??null,session:(native,fence,environment,action,work)=>withProfileSessionTransaction(runtime!,native,fence,action,(db,profile)=>work({db,profile,environment})),personal:async()=>{throw new Error('NO_PAT_IN_THIS_FIXTURE');}});
 });
 afterAll(async()=>{await app?.close();await runtime?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}});
 it('limits native runtime grants and rejects missing/foreign context and historical roles',async()=>{
  expect((await runtime!.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
  for(const sql of ['DELETE FROM memberships WHERE user_id=$1','UPDATE memberships SET user_id=user_id WHERE user_id=$1','UPDATE memberships SET version=99 WHERE user_id=$1'])await expect(runtime!.query(sql,[employee])).rejects.toMatchObject({code:'42501'});
  // V7 F2: commerce_api runs under FORCE RLS; a row outside the transaction's
  // profile context is invisible, so the write matches no row (ADR v7 isolation).
  expect((await runtime!.query("UPDATE memberships SET role='viewer' WHERE user_id=$1",[employee])).rowCount).toBe(0);
  expect((await withProfileTransaction(runtime!,two,db=>db.query("UPDATE memberships SET role='viewer' WHERE user_id=$1 AND workspace_id=$2",[employee,one]))).rowCount).toBe(0);
  await expect(withProfileTransaction(runtime!,one,db=>db.query("UPDATE memberships SET role='seller' WHERE user_id=$1 AND workspace_id=$2",[employee,one]))).rejects.toThrow('PROFILE_MEMBERSHIP_CONTEXT_OR_ROLE_INVALID');
 });
 it('commits one access revision and audit with no global-user changes',async()=>{
  const before=await read(),count=await events();const r=await update(employee,{expectedVersion:before.version,role:'viewer',active:false});expect(r.statusCode).toBe(200);expect(await read()).toEqual({...before,role:'viewer',active:false,version:before.version+1});expect(await events()).toBe(count+1);
  expect((await admin!.query('SELECT name,email FROM "user" WHERE id=$1',[employee])).rows[0]).toEqual({name:employee,email:employee+'@example.test'});
  const event=(await admin!.query("SELECT actor,payload,aggregate_id,environment FROM domain_events WHERE workspace_id=$1 AND event_type='profile.employee.access.changed' ORDER BY occurred_at DESC LIMIT 1",[one])).rows[0];expect(event).toEqual({actor:{id:actor,type:'human'},payload:{before:{role:before.role,active:before.active,version:before.version},after:{role:'viewer',active:false,version:before.version+1}},aggregate_id:employee,environment:'REAL'});
 });
 it('does not duplicate no-op changes or accept stale replay',async()=>{
  const before=await read(),count=await events();expect((await update(employee,{expectedVersion:before.version,role:before.role,active:before.active})).json().data.changed).toBe(false);expect((await update(employee,{expectedVersion:before.version-1,role:'owner',active:true})).statusCode).toBe(409);expect(await read()).toEqual(before);expect(await events()).toBe(count);
 });
 it('denies own access changes and foreign profile targets',async()=>{
  const before=await read(actor),outside=await read(foreign,two);expect((await update(actor,{expectedVersion:before.version,role:'viewer',active:false})).statusCode).toBe(409);expect((await update(foreign,{expectedVersion:outside.version,role:'viewer',active:false})).statusCode).toBe(404);expect(await read(actor)).toEqual(before);expect(await read(foreign,two)).toEqual(outside);
 });
 it('serializes two Owners revoking each other without deadlock and preserves one active Owner',async()=>{
  const a=await read(actor),b=await read(other);const results=await Promise.all([update(other,{expectedVersion:b.version,role:'viewer',active:false},actor),update(actor,{expectedVersion:a.version,role:'viewer',active:false},other)]);
  expect(results.filter(r=>r.statusCode===200)).toHaveLength(1);expect(results.every(r=>[200,403,409].includes(r.statusCode))).toBe(true);expect(Number((await admin!.query("SELECT count(*) FROM memberships WHERE workspace_id=$1 AND role='owner' AND active",[one])).rows[0].count)).toBe(1);
  await admin!.query("UPDATE memberships SET role='owner',active=true WHERE workspace_id=$1 AND user_id=ANY($2::text[])",[one,[actor,other]]);await refresh(actor);await refresh(other);
 });
 it('protects the last Owner in native SQL and refuses stale isolation snapshots',async()=>{
  await withProfileTransaction(runtime!,one,db=>db.query("UPDATE memberships SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[one,other]));
  await expect(withProfileTransaction(runtime!,one,db=>db.query("UPDATE memberships SET active=false WHERE workspace_id=$1 AND user_id=$2",[one,actor]))).rejects.toThrow('PROFILE_LAST_OWNER_REQUIRED');
  const client=await runtime!.connect();try{await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');await client.query("SELECT set_config('app.workspace_id',$1,true)",[one]);await expect(client.query("UPDATE memberships SET role='operator' WHERE workspace_id=$1 AND user_id=$2",[one,employee])).rejects.toThrow('PROFILE_MEMBERSHIP_READ_COMMITTED_REQUIRED');}finally{await client.query('ROLLBACK');client.release();}
  await admin!.query("UPDATE memberships SET role='owner',active=true WHERE workspace_id=$1 AND user_id=$2",[one,other]);await refresh(other);
 });
 it('allows only one versioned employee mutation in a race',async()=>{
  const before=await read(),count=await events();const rows=await Promise.all(['operator','owner'].map(role=>update(employee,{expectedVersion:before.version,role,active:true})));expect(rows.map(r=>r.statusCode).sort()).toEqual([200,409]);expect((await read()).version).toBe(before.version+1);expect(await events()).toBe(count+1);
 });
 it('rolls back access and audit if session expires while the target row is locked',async()=>{
  const before=await read(),count=await events(),blocker=await admin!.connect();let pending:ReturnType<typeof update>|undefined;
  try{await admin!.query('UPDATE session SET "expiresAt"=clock_timestamp()+interval \'2 seconds\' WHERE id=$1',[sessions.get(actor)!.id]);await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[one,employee]);pending=update(employee,{expectedVersion:before.version,role:'viewer',active:false});
   let blocked=false;for(let i=0;i<100&&!blocked;i++){blocked=Boolean((await admin!.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT user_id,role%'",[login])).rowCount);if(!blocked)await new Promise(r=>setTimeout(r,10));}expect(blocked).toBe(true);
   await admin!.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM "expiresAt"-clock_timestamp()))+0.02) FROM session WHERE id=$1',[sessions.get(actor)!.id]);await blocker.query('COMMIT');expect((await pending).statusCode).toBe(401);
  }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;await admin!.query('UPDATE session SET "expiresAt"=clock_timestamp()+interval \'1 hour\' WHERE id=$1',[sessions.get(actor)!.id]);}
  expect(await read()).toEqual(before);expect(await events()).toBe(count);
 });
});
