import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {asProfileOwner,requireMigratedProfileSchema,selectFixtureSession} from '../support/migrated-database.js';
import {listProfileChoicesFromSession} from '../../packages/db/src/profile-identity-bootstrap.js';
import {withProfileTransaction} from '../../packages/db/src/profile-context.js';
import {resolveSessionProfile,type ProfileFence} from '../../packages/db/src/profile-session.js';
import {withProfileSessionTransaction} from '../../packages/db/src/profile-session-transaction.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';

const suffix=randomBytes(8).toString('hex'),login='f2_identity_'+suffix;
const user='identity_'+suffix,outsider='outsider_'+suffix,one='one_'+suffix,two='two_'+suffix;
const session={id:'session_'+suffix,userId:user},otherSession={id:'other_session_'+suffix,userId:user};
const observationTable='profile_transaction_fixture_'+suffix;
let admin:pg.Pool|undefined,runtime:pg.Pool|undefined,created=false;
const select=(target:string,expected:number,s=session)=>selectFixtureSession(runtime!,s,target,expected);
// V7 F2: profile_session_context is under forced profile RLS for commerce_api.
// Like the browser, the caller presents the profile it selected (read here by
// the fixture owner); resolution then runs inside that profile's context.
async function resolve(s:typeof session,...rest:[ProfileFence?,{lock?:boolean}?]){
 const selected=(await admin!.query('SELECT workspace_id FROM profile_session_context WHERE session_id=$1',[s.id])).rows[0]?.workspace_id as string|undefined;
 return selected?withProfileTransaction(runtime!,selected,db=>resolveSessionProfile(db,s,...rest)):resolveSessionProfile(runtime!,s,...rest);
}
describe('per-session profile authority on actual PostgreSQL',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));
  if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw new Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:2,connectionTimeoutMillis:5000});
  // V7 F2: the identity schema is installed by the migrations (0070).
  await requireMigratedProfileSchema(admin);created=true;
  const password=randomBytes(32).toString('hex');
  await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT`);
  await admin.query(`GRANT commerce_api TO "${login}"`);
  await admin.query(`CREATE TABLE "${observationTable}"(workspace_id text NOT NULL,marker text NOT NULL);
   ALTER TABLE "${observationTable}" ENABLE ROW LEVEL SECURITY;ALTER TABLE "${observationTable}" FORCE ROW LEVEL SECURITY;
   CREATE POLICY profile_fixture ON "${observationTable}" USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));
   GRANT SELECT,INSERT ON "${observationTable}" TO commerce_api`);
  await admin.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$1||\'@example.test\'),($2,$2,$2||\'@example.test\')',[user,outsider]);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic One','America/Mexico_City',1,10,10),($2,'Synthetic Two','America/Mexico_City',1,10,10)",[one,two]);
  await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'operator'),($1,$3,'viewer'),($4,$2,'owner')",[user,one,two,outsider]);
  await admin.query('INSERT INTO session(id,"userId",token,"expiresAt") VALUES($1,$3,$1,now()+interval \'1 hour\'),($2,$3,$2,now()+interval \'1 hour\')',[session.id,otherSession.id,user]);
  url.username=login;url.password=password;runtime=new pg.Pool({connectionString:url.toString(),max:2,connectionTimeoutMillis:5000});
 });
 afterAll(async()=>{
  await runtime?.end();
  if(admin){try{
   if(created){
    await admin.query(`DROP TABLE IF EXISTS "${observationTable}"`);
   }
   await admin.query(`DROP ROLE IF EXISTS "${login}"`);
  }finally{await admin.end();}}
 });
 it('uses a restricted login and refuses unselected sessions without an arbitrary workspace',async()=>{
  expect((await runtime!.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({current_user:login,rolsuper:false,rolbypassrls:false});
  await expect(resolve(session)).rejects.toMatchObject({code:'PROFILE_SELECTION_REQUIRED'});
  expect((await listProfileChoicesFromSession(runtime!,session)).map(x=>x.id).sort()).toEqual([one,two].sort());
 });
 it('selects independently for two sessions and fences requests from the previous profile',async()=>{
  expect(await select(one,0)).toEqual({workspaceId:one,version:1});
  expect(await select(two,0,otherSession)).toEqual({workspaceId:two,version:1});
  expect((await resolve(session)).profile.id).toBe(one);
  expect((await resolve(otherSession)).profile.id).toBe(two);
  expect(await select(two,1)).toEqual({workspaceId:two,version:2});
  await expect(resolve(session,{workspaceId:one,version:1})).rejects.toMatchObject({code:'PROFILE_SELECTION_CHANGED'});
 });
 it('allows exactly one competing CAS and does not change profile on replay',async()=>{
  const result=await Promise.allSettled([select(one,2),select(two,2)]);
  expect(result.filter(x=>x.status==='fulfilled')).toHaveLength(1);
  expect(result.filter(x=>x.status==='rejected')).toHaveLength(1);
  expect((await resolve(session)).selection.version).toBe(3);
  await expect(select(one,2)).rejects.toMatchObject({code:'PROFILE_SELECTION_CHANGED'});
 });
 it('holds the session fence until the current transaction completes, then exposes the new selection',async()=>{
  const before=await resolve(session);
  const db=await runtime!.connect();let waiting:Promise<unknown>|undefined;
  try{
   await db.query('BEGIN');await db.query("SELECT set_config('app.workspace_id',$1,true)",[before.profile.id]);await resolveSessionProfile(db,session,before.selection,{lock:true});
   waiting=select(before.profile.id===one?two:one,3);
   // Inspect actual wait locks instead of claiming serialization from a timer.
   let blocked=false;
   for(let i=0;i<50&&!blocked;i++){
    blocked=Boolean((await admin!.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND (query LIKE '%FROM session%' OR query LIKE '%select_authenticated_profile%')",[login])).rowCount);
    if(!blocked)await new Promise(r=>setTimeout(r,10));
   }
   expect(blocked).toBe(true);
   await db.query('COMMIT');await waiting;
  }finally{await db.query('ROLLBACK');db.release();if(waiting)await waiting;}
  expect((await resolve(session)).selection.version).toBe(4);
 });
 it('immediately invalidates removed or downgraded membership and does not allow a version rewind',async()=>{
  const current=await resolve(session);
  // V7 F2: membership changes are owner/employee operations in the profile's
  // context (004); the fixture owner performs them, not the session runtime.
  await asProfileOwner(admin!,current.profile.id,c=>c.query("UPDATE memberships SET role='viewer',active=false,version=999 WHERE user_id=$1 AND workspace_id=$2",[user,current.profile.id]));
  expect((await admin!.query('SELECT version FROM memberships WHERE user_id=$1 AND workspace_id=$2',[user,current.profile.id])).rows[0].version).toBe(2);
  await expect(resolve(session)).rejects.toMatchObject({code:'PROFILE_MEMBERSHIP_REQUIRED'});
  await asProfileOwner(admin!,current.profile.id,c=>c.query('UPDATE memberships SET active=true,version=1 WHERE user_id=$1 AND workspace_id=$2',[user,current.profile.id]));
  await expect(resolve(session)).rejects.toMatchObject({code:'PROFILE_SESSION_ACCESS_CHANGED'});
  await select(current.profile.id,4);
  expect((await resolve(session)).membership).toEqual({role:'viewer',version:3});
 });
 it('permits native read locks without granting profile state, quota or ID mutation',async()=>{
  const current=await resolve(session);
  await withProfileTransaction(runtime!,current.profile.id,db=>resolveSessionProfile(db,session,current.selection,{lock:true}));
  await expect(runtime!.query("UPDATE profiles SET state='SUSPENDED' WHERE id=$1",[one])).rejects.toMatchObject({code:'42501'});
  await expect(runtime!.query('UPDATE profiles SET number_limit=20 WHERE id=$1',[one])).rejects.toMatchObject({code:'42501'});
  await expect(withProfileTransaction(runtime!,one,db=>db.query('UPDATE profiles SET id=$2 WHERE id=$1',[one,'changed_'+one]))).rejects.toThrow('PROFILE_IDENTITY_IMMUTABLE');
 });
 it('combines native session authorization with the scoped SQL executor and actual RLS before content',async()=>{
  const before=await resolve(session);
  await admin!.query("UPDATE memberships SET role='operator' WHERE user_id=$1 AND workspace_id=$2",[user,before.profile.id]);
  const fence=await select(before.profile.id,before.selection.version);
  await withProfileSessionTransaction(runtime!,session,fence,{scope:'products:write',mutation:true},async db=>{
   expect((await db.query("SELECT current_setting('app.workspace_id') AS workspace")).rows[0].workspace).toBe(fence.workspaceId);
   await db.query(`INSERT INTO "${observationTable}" VALUES($1,'committed')`,[db.workspaceId]);
  });
  expect((await admin!.query(`SELECT marker FROM "${observationTable}"`)).rows).toEqual([{marker:'committed'}]);
  let called=false;
  await expect(withProfileSessionTransaction(runtime!,session,{...fence,workspaceId:fence.workspaceId===one?two:one},{scope:'products:read',mutation:false},async()=>{called=true;})).rejects.toMatchObject({code:'PROFILE_SELECTION_CHANGED'});
  expect(called).toBe(false);
  await expect(withProfileSessionTransaction(runtime!,session,fence,{scope:'products:write',mutation:true},async db=>{
   await db.query(`INSERT INTO "${observationTable}" VALUES($1,'crossed')`,[db.workspaceId===one?two:one]);
  })).rejects.toMatchObject({code:'42501'});
  expect((await admin!.query(`SELECT marker FROM "${observationTable}"`)).rows).toEqual([{marker:'committed'}]);
 });
 it('rolls back an otherwise valid commercial write if the native session expires during SQL work',async()=>{
  const before=await resolve(session);
  try{
   await admin!.query('UPDATE session SET "expiresAt"=clock_timestamp()+interval \'1 second\' WHERE id=$1',[session.id]);
   await expect(withProfileSessionTransaction(runtime!,session,before.selection,{scope:'products:write',mutation:true},async db=>{
    await db.query(`INSERT INTO "${observationTable}" VALUES($1,'must_rollback')`,[db.workspaceId]);
    await db.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM "expiresAt"-clock_timestamp()))+0.02) FROM session WHERE id=$1',[session.id]);
   })).rejects.toMatchObject({code:'PROFILE_SESSION_EXPIRED'});
   expect((await admin!.query(`SELECT marker FROM "${observationTable}" WHERE marker='must_rollback'`)).rowCount).toBe(0);
  }finally{await admin!.query('UPDATE session SET "expiresAt"=clock_timestamp()+interval \'1 hour\' WHERE id=$1',[session.id]);}
 });
 it('does not commit selection after the native session expires while waiting on a membership lock',async()=>{
  const before=await resolve(session),blocker=await admin!.connect();
  let selecting:Promise<unknown>|undefined;
  try{
   await admin!.query('UPDATE session SET "expiresAt"=clock_timestamp()+interval \'2 seconds\' WHERE id=$1',[session.id]);
   await blocker.query('BEGIN');
   await blocker.query('SELECT 1 FROM memberships WHERE user_id=$1 AND workspace_id=$2 FOR UPDATE',[user,one]);
   selecting=select(one,before.selection.version);void selecting.catch(()=>{});
   let blocked=false;
   for(let i=0;i<100&&!blocked;i++){
    blocked=Boolean((await admin!.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND (query LIKE '%FROM memberships%' OR query LIKE '%select_authenticated_profile%')",[login])).rowCount);
    if(!blocked)await new Promise(r=>setTimeout(r,10));
   }
   expect(blocked).toBe(true);
   await admin!.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM "expiresAt"-clock_timestamp()))+0.02) FROM session WHERE id=$1',[session.id]);
   await blocker.query('COMMIT');
   await expect(selecting).rejects.toMatchObject({code:'PROFILE_SESSION_EXPIRED'});
   const unchanged=(await admin!.query('SELECT workspace_id,version FROM profile_session_context WHERE session_id=$1',[session.id])).rows[0];
   expect(unchanged).toEqual({workspace_id:before.selection.workspaceId,version:before.selection.version});
  }finally{
   await blocker.query('ROLLBACK');blocker.release();if(selecting)await selecting.catch(()=>{});
   await admin!.query('UPDATE session SET "expiresAt"=clock_timestamp()+interval \'1 hour\' WHERE id=$1',[session.id]);
  }
 });
 it('enforces session-user and membership-profile relationships in PostgreSQL, then cascades session revocation',async()=>{
  // V7 F2: selection writes go only through the closed bootstrap port (0091);
  // the runtime role has no direct write privilege; the FKs still hold for the owner.
  await expect(runtime!.query('UPDATE profile_session_context SET user_id=$2 WHERE session_id=$1',[session.id,outsider])).rejects.toMatchObject({code:'42501'});
  await expect(admin!.query('UPDATE profile_session_context SET user_id=$2 WHERE session_id=$1',[session.id,outsider])).rejects.toMatchObject({code:'23503'});
  await expect(admin!.query('UPDATE profile_session_context SET workspace_id=$2 WHERE session_id=$1',[session.id,'foreign_'+suffix])).rejects.toMatchObject({code:'23503'});
  // Refresh the other session if its shared membership was changed above.
  await select(two,1,otherSession);
  await admin!.query('DELETE FROM session WHERE id=$1',[session.id]);
  expect((await admin!.query('SELECT 1 FROM profile_session_context WHERE session_id=$1',[session.id])).rowCount).toBe(0);
  await expect(resolve(session)).rejects.toMatchObject({code:'PROFILE_SESSION_EXPIRED'});
  expect((await resolve(otherSession)).profile.id).toBe(two);
 });
});
