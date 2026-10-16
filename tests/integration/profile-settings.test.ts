import {randomBytes} from 'node:crypto';
import pg from 'pg';
import Fastify,{type FastifyInstance} from 'fastify';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {asProfileOwner,requireMigratedProfileSchema,selectFixtureSession} from '../support/migrated-database.js';
import {profileSettingsRoutes} from '../../apps/api/src/profile-settings.js';
import {withProfileTransaction} from '../../packages/db/src/profile-context.js';
import {withProfileSessionTransaction} from '../../packages/db/src/profile-session-transaction.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';

const suffix=randomBytes(8).toString('hex'),login='f2_settings_'+suffix;
const user='settings_user_'+suffix,one='settings_one_'+suffix,two='settings_two_'+suffix;
const session={id:'settings_session_'+suffix,userId:user};
let admin:pg.Pool|undefined,runtime:pg.Pool|undefined,app:FastifyInstance|undefined;
let selection=0;
const headers=()=>({origin:'https://fixture.test','x-commerce-profile-id':one,'x-commerce-profile-version':String(selection)});
const read=async(id=one)=>(await admin!.query('SELECT id,business_name,timezone,version,updated_at FROM profiles WHERE id=$1',[id])).rows[0];
const patch=async(payload:Record<string,unknown>)=>app!.inject({method:'PATCH',url:'/v2/profile',headers:headers(),payload});
const events=async()=>Number((await admin!.query("SELECT count(*) FROM domain_events WHERE workspace_id=$1 AND event_type='profile.settings.changed'",[one])).rows[0].count);
async function refresh(){selection=(await selectFixtureSession(runtime!,session,one,selection)).version;}
describe('own profile settings on restricted native PostgreSQL',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));
  if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw new Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:3,connectionTimeoutMillis:5000});
  await requireMigratedProfileSchema(admin);
  const password=randomBytes(32).toString('hex');
  await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT`);
  await admin.query(`GRANT commerce_api TO "${login}"`);
  await admin.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$1||\'@example.test\')',[user]);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic One','UTC',1,10,10),($2,'Synthetic Two','UTC',1,10,10)",[one,two]);
  await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[user,one]);
  // V7 F2: a profile keeps at least one owner (004); a synthetic co-owner lets
  // the fixture downgrade the acting user.
  await admin.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$1||\'@example.test\')',['co_'+user]);
  await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",['co_'+user,one]);
  await admin.query('INSERT INTO session(id,"userId",token,"expiresAt") VALUES($1,$2,$1,now()+interval \'1 hour\')',[session.id,user]);
  url.username=login;url.password=password;runtime=new pg.Pool({connectionString:url.toString(),max:3,connectionTimeoutMillis:5000});
  await refresh();
  app=Fastify();await profileSettingsRoutes(app,{origins:['https://fixture.test'],nativeSession:async()=>session,
   session:(native,fence,environment,action,work)=>withProfileSessionTransaction(runtime!,native,fence,action,(db,profile)=>work({db,profile,environment})),
   personal:async()=>{throw new Error('NO_PAT_IN_THIS_FIXTURE');}});
 });
 afterAll(async()=>{await app?.close();await runtime?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}});
 it('grants only the business fields and preserves IDs, state, quota, timestamps and version authority',async()=>{
  const role=(await runtime!.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];expect(role).toEqual({rolsuper:false,rolbypassrls:false});
  for(const assignment of ["state='SUSPENDED'",'number_limit=20','product_limit=100','daily_conversation_limit=1000','version=99','updated_at=now()'])await expect(runtime!.query('UPDATE profiles SET '+assignment+' WHERE id=$1',[one])).rejects.toMatchObject({code:'42501'});
  await expect(withProfileTransaction(runtime!,one,db=>db.query('UPDATE profiles SET id=$2 WHERE id=$1',[one,'changed_'+one]))).rejects.toThrow('PROFILE_IDENTITY_IMMUTABLE');
  // V7 F2: commerce_api runs under FORCE RLS; a row outside the transaction's
  // profile context is invisible, so the write matches no row (ADR v7 isolation).
  expect((await runtime!.query("UPDATE profiles SET business_name='No context' WHERE id=$1",[one])).rowCount).toBe(0);
 });
 it('commits one authenticated-profile update and its immutable actor/version event atomically',async()=>{
  const before=await read(),count=await events();
  const r=await patch({expectedVersion:before.version,businessName:'Updated synthetic',timezone:'America/Mexico_City'});
  expect(r.statusCode).toBe(200);expect(r.json().data.version).toBe(before.version+1);expect(await events()).toBe(count+1);
  const after=await read();expect(after.business_name).toBe('Updated synthetic');expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(before.updated_at.getTime());
  const event=(await admin!.query("SELECT actor,payload,environment,aggregate_id FROM domain_events WHERE workspace_id=$1 AND event_type='profile.settings.changed' ORDER BY occurred_at DESC LIMIT 1",[one])).rows[0];
  expect(event).toEqual({actor:{type:'human',id:user},payload:{previous_version:before.version,version:before.version+1,fields:['business_name','timezone']},environment:'REAL',aggregate_id:one});
  expect((await read(two)).business_name).toBe('Synthetic Two');
 });
 it('serializes competing versioned updates so only one succeeds and replay cannot overwrite it',async()=>{
  const before=await read(),count=await events();
  const results=await Promise.all(['First competing','Second competing'].map(businessName=>patch({expectedVersion:before.version,businessName,timezone:'UTC'})));
  expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);expect((await read()).version).toBe(before.version+1);expect(await events()).toBe(count+1);
  expect((await patch({expectedVersion:before.version,businessName:'Stale replay',timezone:'UTC'})).statusCode).toBe(409);expect((await read()).business_name).not.toBe('Stale replay');
 });
 it('keeps both version and event count unchanged on an identical request',async()=>{
  const before=await read(),count=await events();const r=await patch({expectedVersion:before.version,businessName:before.business_name,timezone:before.timezone});
  expect(r.statusCode).toBe(200);expect(r.json().data.changed).toBe(false);expect(await read()).toEqual(before);expect(await events()).toBe(count);
 });
 it('rejects a foreign row even through the column grant with another profile context',async()=>{
  const before=await read(two);
  // V7 F2: commerce_api runs under FORCE RLS; a row outside the transaction's
  // profile context is invisible, so the write matches no row (ADR v7 isolation).
  expect((await withProfileTransaction(runtime!,one,db=>db.query("UPDATE profiles SET business_name='Crossed' WHERE id=$1",[two]))).rowCount).toBe(0);
  expect(await read(two)).toEqual(before);
  expect((await app!.inject({method:'PATCH',url:'/v2/profile?workspace_id='+two,headers:headers(),payload:{expectedVersion:1,businessName:'Crossed',timezone:'UTC'}})).statusCode).toBe(400);
 });
 it('blocks downgraded members and suspended profiles without updates or events',async()=>{
  const before=await read(),count=await events();
  try{
   await admin!.query("UPDATE memberships SET role='operator' WHERE user_id=$1 AND workspace_id=$2",[user,one]);await refresh();
   expect((await patch({expectedVersion:before.version,businessName:'Forbidden',timezone:'UTC'})).statusCode).toBe(403);
   await admin!.query("UPDATE memberships SET role='owner' WHERE user_id=$1 AND workspace_id=$2",[user,one]);await refresh();
   await asProfileOwner(admin!,one,c=>c.query("UPDATE profiles SET state='SUSPENDED' WHERE id=$1",[one]));
   expect((await patch({expectedVersion:before.version,businessName:'Forbidden',timezone:'UTC'})).statusCode).toBe(403);
  }finally{await asProfileOwner(admin!,one,c=>c.query("UPDATE profiles SET state='ACTIVE' WHERE id=$1",[one]));}
  // V7 RF-01.5: suspend and reactivate are two versioned state changes (0100);
  // the rejected settings writes changed nothing else.
  const after=await read();expect({...after,version:after.version-2,updated_at:before.updated_at}).toEqual(before);expect(await events()).toBe(count);
 });
 it('checks expiration after a real profile lock wait before writing',async()=>{
  const before=await read(),count=await events(),blocker=await admin!.connect();let waiting:ReturnType<typeof patch>|undefined;
  try{
   await admin!.query('UPDATE session SET "expiresAt"=clock_timestamp()+interval \'2 seconds\' WHERE id=$1',[session.id]);
   await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM profiles WHERE id=$1 FOR UPDATE',[one]);
   waiting=patch({expectedVersion:before.version,businessName:'Expired waiting',timezone:'UTC'});
   let blocked=false;
   for(let i=0;i<100&&!blocked;i++){blocked=Boolean((await admin!.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query LIKE '%FROM profiles%'",[login])).rowCount);if(!blocked)await new Promise(r=>setTimeout(r,10));}
   expect(blocked).toBe(true);
   await admin!.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM "expiresAt"-clock_timestamp()))+0.02) FROM session WHERE id=$1',[session.id]);
   await blocker.query('COMMIT');const expired=await waiting;expect([{status:401,code:'PROFILE_SESSION_EXPIRED'},{status:403,code:'PROFILE_CREDENTIAL_INVALID'}]).toContainEqual({status:expired.statusCode,code:expired.json().code});
  }finally{await blocker.query('ROLLBACK');blocker.release();if(waiting)await waiting;await admin!.query('UPDATE session SET "expiresAt"=clock_timestamp()+interval \'1 hour\' WHERE id=$1',[session.id]);}
  expect(await read()).toEqual(before);expect(await events()).toBe(count);
 });
 it('rolls back the settings and audit when the session expires during the write itself',async()=>{
  const before=await read(),count=await events();
  await admin!.query(`CREATE FUNCTION fixture_wait_settings() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(1.2); RETURN NEW; END$$;CREATE TRIGGER fixture_wait_settings BEFORE UPDATE OF business_name ON profiles FOR EACH ROW EXECUTE FUNCTION fixture_wait_settings()`);
  try{
   await admin!.query('UPDATE session SET "expiresAt"=clock_timestamp()+interval \'1 second\' WHERE id=$1',[session.id]);
   expect((await patch({expectedVersion:before.version,businessName:'Expired during write',timezone:'UTC'})).statusCode).toBe(401);
  }finally{await admin!.query('DROP TRIGGER fixture_wait_settings ON profiles;DROP FUNCTION fixture_wait_settings()');await admin!.query('UPDATE session SET "expiresAt"=clock_timestamp()+interval \'1 hour\' WHERE id=$1',[session.id]);}
  expect(await read()).toEqual(before);expect(await events()).toBe(count);
 });
});
