/** Isolated PostgreSQL bootstrap component of 020, not production RLS. */
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {listProfileChoicesFromSession,selectProfileFromSession} from '../../packages/db/src/profile-identity-bootstrap.js';
import {withProfileTransaction} from '../../packages/db/src/profile-context.js';
import {resolveSessionProfile} from '../../packages/db/src/profile-session.js';
const tag=randomBytes(6).toString('hex'),login='bootstrap_'+tag,user='user_'+tag,outsider='outsider_'+tag,one='one_'+tag,two='two_'+tag,other='other_'+tag;
let admin:pg.Pool,runtime:pg.Pool;
async function freshSession(owner=user,life='1 hour'){
 const id='session_'+randomBytes(8).toString('hex');await admin.query('INSERT INTO session(id,"userId",token,"expiresAt") VALUES($1,$2,$1,clock_timestamp()+$3::interval)',[id,owner,life]);return{id,userId:owner};
}
async function transaction<T>(work:(c:pg.PoolClient)=>Promise<T>){const c=await runtime.connect();try{await c.query('BEGIN');const result=await work(c);expect((await c.query('COMMIT')).command).toBe('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
describe('closed identity bootstrap with native RLS and restricted runtime',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:5000});
  if((await admin.query("SELECT to_regclass('public.profiles') present")).rows[0].present)throw Error('TRANSITION_SCHEMA_ALREADY_PRESENT');
  await admin.query(await readFile(new URL('../../packages/db/profile-transition/001_profile_identity.sql',import.meta.url),'utf8'));
  await admin.query(await readFile(new URL('../../packages/db/profile-transition/components/020_profile_identity_bootstrap.sql',import.meta.url),'utf8'));
  // Only these fixture tables are closed. Commercial 020 remains a separate gate.
  for(const table of ['memberships','profile_session_context','profiles']){
   await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;CREATE POLICY fixture_runtime_scope ON ${table} TO commerce_api USING(${table==='profiles'?'id':'workspace_id'}=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK(${table==='profiles'?'id':'workspace_id'}=NULLIF(current_setting('app.workspace_id',true),''))`);
  }
  await admin.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$1||\'@example.test\'),($2,$2,$2||\'@example.test\')',[user,outsider]);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'One','UTC',1,10,10),($2,'Two','UTC',1,10,10),($3,'Private Other','UTC',1,10,10)",[one,two,other]);
  await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'operator'),($1,$3,'viewer'),($4,$5,'owner')",[user,one,two,outsider,other]);
  const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT commerce_api TO "${login}"`);
  url.username=login;url.password=secret;runtime=new pg.Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:5000});
 },60000);
 afterAll(async()=>{await runtime?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}});
 it('has no global visibility or privilege to become the closed function owner',async()=>{
  expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
  for(const table of ['memberships','profile_session_context','profiles'])expect((await runtime.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
  await expect(runtime.query('SET ROLE commerce_profile_bootstrap_owner')).rejects.toMatchObject({code:'42501'});
  const owner=(await admin.query("SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname='commerce_profile_bootstrap_owner'")).rows[0];expect(owner).toEqual({rolcanlogin:false,rolsuper:false,rolbypassrls:false,rolcreaterole:false});
 });
 it('lists only active memberships of the authenticated session without a default selection',async()=>{
  const s=await freshSession();const rows=await listProfileChoicesFromSession(runtime,s);
  expect(rows.map(r=>r.id).sort()).toEqual([one,two].sort());expect(rows.every(r=>r.selected===false&&r.selection_version===null)).toBe(true);expect(JSON.stringify(rows)).not.toContain('Private Other');
 });
 it('keeps listed membership and profile authority locked until the identity transaction commits',async()=>{
  const session=await freshSession(),reader=await runtime.connect(),memberWriter=await admin.connect(),profileWriter=await admin.connect();let pending:Promise<unknown>[]=[];
  try{
   await reader.query('BEGIN');expect((await listProfileChoicesFromSession(reader,session)).map(r=>r.id).sort()).toEqual([one,two].sort());
   const memberPid=(await memberWriter.query('SELECT pg_backend_pid() pid')).rows[0].pid,profilePid=(await profileWriter.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   pending=[memberWriter.query('UPDATE memberships SET active=false WHERE user_id=$1 AND workspace_id=$2',[user,one]),profileWriter.query("UPDATE profiles SET state='SUSPENDED',version=version+1 WHERE id=$1",[two])];
   let waiting=0;for(let i=0;i<100&&waiting<2;i++){waiting=(await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock'",[[memberPid,profilePid]])).rows[0].n;if(waiting<2)await new Promise(r=>setTimeout(r,5));}expect(waiting).toBe(2);
   expect((await admin.query('SELECT active FROM memberships WHERE user_id=$1 AND workspace_id=$2',[user,one])).rows[0].active).toBe(true);
   await reader.query('COMMIT');await Promise.all(pending);pending=[];
   const after=await listProfileChoicesFromSession(runtime,session);expect(after.map(r=>r.id)).toEqual([two]);expect(after[0].state).toBe('SUSPENDED');
  }finally{
   await reader.query('ROLLBACK');await Promise.allSettled(pending);reader.release();memberWriter.release();profileWriter.release();
   await admin.query('UPDATE memberships SET active=true WHERE user_id=$1 AND workspace_id=$2',[user,one]);await admin.query("UPDATE profiles SET state='ACTIVE',version=version+1 WHERE id=$1",[two]);
  }
 });
 it('rejects another native owner and expiry without returning selector data',async()=>{
  const s=await freshSession();await expect(listProfileChoicesFromSession(runtime,{...s,userId:outsider})).rejects.toMatchObject({code:'PROFILE_SESSION_EXPIRED'});
  const expired=await freshSession(user,'-1 second');await expect(listProfileChoicesFromSession(runtime,expired)).rejects.toMatchObject({code:'PROFILE_SESSION_EXPIRED'});
 });
 it('selects with exact CAS and keeps sessions independent',async()=>{
  const a=await freshSession(),b=await freshSession();expect(await transaction(c=>selectProfileFromSession(c,a,one,0))).toEqual({workspaceId:one,version:1});expect(await transaction(c=>selectProfileFromSession(c,b,two,0))).toEqual({workspaceId:two,version:1});
  expect((await listProfileChoicesFromSession(runtime,a)).find(r=>r.selected)?.id).toBe(one);expect((await listProfileChoicesFromSession(runtime,b)).find(r=>r.selected)?.id).toBe(two);
  await expect(transaction(c=>selectProfileFromSession(c,a,two,0))).rejects.toThrow('PROFILE_SELECTION_CHANGED');
  expect((await listProfileChoicesFromSession(runtime,a)).find(r=>r.selected)?.id).toBe(one);
 });
 it('allows exactly one concurrent first selection and never selects an injected foreign profile',async()=>{
  const s=await freshSession();const result=await Promise.allSettled([transaction(c=>selectProfileFromSession(c,s,one,0)),transaction(c=>selectProfileFromSession(c,s,two,0))]);expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(result.filter(r=>r.status==='rejected')).toHaveLength(1);
  await expect(transaction(c=>selectProfileFromSession(c,s,other,1))).rejects.toThrow('PROFILE_MEMBERSHIP_REQUIRED');expect((await listProfileChoicesFromSession(runtime,s)).filter(r=>r.selected)).toHaveLength(1);
 });
 it('hides revoked membership and rejects selection until the native membership is active again',async()=>{
  const s=await freshSession();await transaction(c=>selectProfileFromSession(c,s,one,0));await admin.query('UPDATE memberships SET active=false WHERE user_id=$1 AND workspace_id=$2',[user,one]);
  try{expect((await listProfileChoicesFromSession(runtime,s)).map(r=>r.id)).toEqual([two]);await expect(transaction(c=>selectProfileFromSession(c,s,one,1))).rejects.toThrow('PROFILE_MEMBERSHIP_REQUIRED');}
  finally{await admin.query('UPDATE memberships SET active=true WHERE user_id=$1 AND workspace_id=$2',[user,one]);}
  expect((await listProfileChoicesFromSession(runtime,s)).every(r=>!r.selected)).toBe(true);
 });
 it('feeds the unchanged scoped authority resolver and rejects its stale membership version',async()=>{
  const s=await freshSession();const fence=await transaction(c=>selectProfileFromSession(c,s,one,0));
  expect((await withProfileTransaction(runtime,one,db=>resolveSessionProfile(db,s,fence,{lock:true}))).profile.id).toBe(one);
  await admin.query("UPDATE memberships SET role='viewer' WHERE user_id=$1 AND workspace_id=$2",[user,one]);
  try{await expect(withProfileTransaction(runtime,one,db=>resolveSessionProfile(db,s,fence,{lock:true}))).rejects.toThrow('PROFILE_SESSION_ACCESS_CHANGED');}
  finally{await admin.query("UPDATE memberships SET role='operator' WHERE user_id=$1 AND workspace_id=$2",[user,one]);}
 });
 it('retains suspended profiles as metadata without granting commercial authority',async()=>{
  const s=await freshSession();await admin.query("UPDATE profiles SET state='SUSPENDED',version=version+1 WHERE id=$1",[two]);
  try{const fence=await transaction(c=>selectProfileFromSession(c,s,two,0));expect(fence.workspaceId).toBe(two);expect((await listProfileChoicesFromSession(runtime,s)).find(r=>r.id===two)?.state).toBe('SUSPENDED');}
  finally{await admin.query("UPDATE profiles SET state='ACTIVE',version=version+1 WHERE id=$1",[two]);}
 });
 it('cannot switch a selection from inside a commercial scope',async()=>{
  const s=await freshSession();await expect(withProfileTransaction(runtime,one,db=>selectProfileFromSession(db,s,two,0))).rejects.toThrow('PROFILE_BOOTSTRAP_OUTSIDE_SCOPE_REQUIRED');expect((await listProfileChoicesFromSession(runtime,s)).every(r=>!r.selected)).toBe(true);
 });
 it('rolls selection back together with a failed identity audit/callback',async()=>{
  const s=await freshSession();await expect(transaction(async c=>{await selectProfileFromSession(c,s,one,0);throw Error('SYNTHETIC_AUDIT_FAILURE');})).rejects.toThrow('SYNTHETIC_AUDIT_FAILURE');expect((await listProfileChoicesFromSession(runtime,s)).every(r=>!r.selected)).toBe(true);
 });
 it('rechecks native expiry after waiting on a membership/profile lock',async()=>{
  const blocker=await admin.connect();let call:Promise<unknown>|undefined;try{
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM profiles WHERE id=$1 FOR UPDATE',[one]);const s=await freshSession(user,'400 milliseconds');
   call=transaction(c=>selectProfileFromSession(c,s,one,0));const assertion=expect(call).rejects.toThrow('PROFILE_SESSION_EXPIRED');
   let blocked=false;for(let i=0;i<100&&!blocked;i++){blocked=Boolean((await admin.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",[login])).rowCount);if(!blocked)await new Promise(r=>setTimeout(r,5));}expect(blocked).toBe(true);
   await admin.query('SELECT pg_sleep(0.5)');await blocker.query('COMMIT');await assertion;
   expect((await admin.query('SELECT * FROM profile_session_context WHERE session_id=$1',[s.id])).rows).toEqual([]);
  }finally{await blocker.query('ROLLBACK');blocker.release();if(call)await call.catch(()=>{});}
 });
 it('rejects an unadopted legacy role rather than widening its permissions',async()=>{
  const s=await freshSession();await admin.query("UPDATE memberships SET role='seller' WHERE user_id=$1 AND workspace_id=$2",[user,one]);
  try{await expect(listProfileChoicesFromSession(runtime,s)).rejects.toThrow('PROFILE_ROLE_ADOPTION_REQUIRED');await expect(transaction(c=>selectProfileFromSession(c,s,one,0))).rejects.toThrow('PROFILE_ROLE_ADOPTION_REQUIRED');}
  finally{await admin.query("UPDATE memberships SET role='operator' WHERE user_id=$1 AND workspace_id=$2",[user,one]);}
 });
 it('rejects an excessive selector inventory without truncating it',async()=>{
  const s=await freshSession(),extra='extra_'+tag;
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Extra','UTC',0,0,0)",[extra]);
  await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'viewer'),($1,$3,'viewer')",[user,other,extra]);
  try{await expect(listProfileChoicesFromSession(runtime,s)).rejects.toThrow('PROFILE_BOOTSTRAP_BOUND');}
  finally{await admin.query('DELETE FROM memberships WHERE user_id=$1 AND workspace_id=ANY($2)',[user,[other,extra]]);await admin.query('DELETE FROM profiles WHERE id=$1',[extra]);}
 });
 it('does not grant the worker role access to the identity bootstrap',async()=>{
  const c=await admin.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE commerce_channel');await expect(c.query('SELECT * FROM list_authenticated_profile_choices($1,$2)',['none','none'])).rejects.toMatchObject({code:'42501'});}finally{await c.query('ROLLBACK');c.release();}
 });
});
