import {readFile} from 'node:fs/promises';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {withPersonalProfileTransaction} from '../../packages/db/src/profile-personal-token.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';

const suffix=randomBytes(8).toString('hex'),login='f2_pat_'+suffix,user='pat_user_'+suffix;
const one='pat_one_'+suffix,two='pat_two_'+suffix,table='pat_fixture_'+suffix;
let admin:pg.Pool|undefined,runtime:pg.Pool|undefined,tokenOwner:string;
function hash(value:string){return createHash('sha256').update(value).digest('hex');}
async function issue(workspace=one,scopes:unknown=['products:read','products:write'],seconds=3600){
 const id=randomUUID(),secret='cos_pat_'+randomBytes(32).toString('base64url');
 await admin!.query(`INSERT INTO personal_access_tokens(id,workspace_id,user_id,name,token_hash,allowed_environments,profile_scopes,expires_at)
 VALUES($1,$2,$3,'Synthetic',$4,'["SIMULATION"]',$5,clock_timestamp()+$6*interval '1 second')`,[id,workspace,user,hash(secret),scopes===null?null:JSON.stringify(scopes),seconds]);
 return{id,secret};
}
const act=(secret:string,work:Parameters<typeof withPersonalProfileTransaction>[4]=async db=>db.query(`INSERT INTO "${table}" VALUES($1,'write')`,[db.workspaceId]))=>
 withPersonalProfileTransaction(runtime!,secret,'SIMULATION',{scope:'products:write',mutation:true},work);
describe('PAT locator and scoped authority on actual PostgreSQL',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));
  if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw new Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:3,connectionTimeoutMillis:5000});
  if((await admin.query("SELECT to_regclass('public.profiles') AS existing")).rows[0].existing)throw new Error('TRANSITION_SCHEMA_ALREADY_PRESENT');
  const db=await admin.connect();try{
   await db.query('BEGIN');
   for(const name of ['001_profile_identity.sql','002_profile_personal_tokens.sql'])await db.query(await readFile(new URL('../../packages/db/profile-transition/'+name,import.meta.url),'utf8'));
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  const password=randomBytes(32).toString('hex');
  await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT commerce_api TO "${login}"`);
  await admin.query(`CREATE TABLE "${table}"(workspace_id text NOT NULL,marker text NOT NULL);ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;
   CREATE POLICY fixture_profile ON "${table}" USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));GRANT SELECT,INSERT ON "${table}" TO commerce_api;
   ALTER TABLE personal_access_tokens ENABLE ROW LEVEL SECURITY;ALTER TABLE personal_access_tokens FORCE ROW LEVEL SECURITY;
   CREATE POLICY fixture_token_profile ON personal_access_tokens USING(workspace_id=current_setting('app.workspace_id',true)) WITH CHECK(workspace_id=current_setting('app.workspace_id',true));`);
  await admin.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$1||\'@example.test\')',[user]);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic One','UTC',1,10,10),($2,'Synthetic Two','UTC',1,10,10)",[one,two]);
  await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'operator'),($1,$3,'operator')",[user,one,two]);
  tokenOwner=(await admin.query("SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid='public.personal_access_tokens'::regclass")).rows[0].owner;
  if(!/^[a-z_][a-z0-9_]*$/.test(tokenOwner))throw new Error('FIXTURE_OWNER_INVALID');
  url.username=login;url.password=password;runtime=new pg.Pool({connectionString:url.toString(),max:3,connectionTimeoutMillis:5000});
 });
 afterAll(async()=>{await runtime?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}});
 it('uses a restricted role; exposes only the exact locator and no direct global index or unscoped token rows',async()=>{
  const credential=await issue();
  expect((await runtime!.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
  await expect(runtime!.query('SELECT * FROM profile_personal_token_routes')).rejects.toMatchObject({code:'42501'});
  expect((await runtime!.query('SELECT * FROM personal_access_tokens')).rows).toEqual([]);
  expect((await runtime!.query('SELECT * FROM locate_personal_profile_token($1)',[hash(credential.secret)])).rows).toEqual([{token_id:credential.id,workspace_id:one,user_id:user}]);
  expect((await runtime!.query('SELECT * FROM locate_personal_profile_token($1)',[hash('not a token')])).rows).toEqual([]);
  const db=await admin!.connect();try{await db.query('SET ROLE commerce_channel');await expect(db.query('SELECT * FROM locate_personal_profile_token($1)',[hash(credential.secret)])).rejects.toMatchObject({code:'42501'});}finally{await db.query('RESET ROLE');db.release();}
 });
 it('authorizes the fixed token profile under actual RLS and rejects cross-profile writes',async()=>{
  const credential=await issue();await act(credential.secret);
  await expect(act(credential.secret,async db=>db.query(`INSERT INTO "${table}" VALUES($1,'crossed')`,[two]))).rejects.toMatchObject({code:'42501'});
  expect((await admin!.query(`SELECT workspace_id,marker FROM "${table}"`)).rows).toEqual([{workspace_id:one,marker:'write'}]);
  const other=await issue(two);await act(other.secret,async db=>{expect(db.workspaceId).toBe(two);expect((await db.query(`SELECT * FROM "${table}"`)).rows).toEqual([]);});
 });
 it('locks issued identities and prevents runtime adoption, escalation, TTL extension or unrevocation',async()=>{
  const credential=await issue(),legacy=await issue(one,null);
  const db=await runtime!.connect();try{
   await db.query('BEGIN');await db.query("SELECT set_config('app.workspace_id',$1,true)",[one]);
   await expect(db.query('UPDATE personal_access_tokens SET profile_scopes=$2 WHERE id=$1',[credential.id,JSON.stringify(['employees:write'])])).rejects.toThrow('PROFILE_TOKEN_SCOPES_IMMUTABLE');await db.query('ROLLBACK');
   for(const [set,value] of [['expires_at=expires_at+interval \'1 hour\'',null],['workspace_id=$2',two],['profile_scopes=$2',JSON.stringify(['products:read'])]] as const){
    await db.query('BEGIN');await db.query("SELECT set_config('app.workspace_id',$1,true)",[one]);
    await expect(db.query('UPDATE personal_access_tokens SET '+set+' WHERE id=$1',value===null?[credential.id]:[set.startsWith('profile_scopes')?legacy.id:credential.id,value])).rejects.toThrow(/PROFILE_TOKEN_(IDENTITY|SCOPES)_IMMUTABLE/);await db.query('ROLLBACK');
   }
   await db.query('BEGIN');await db.query("SELECT set_config('app.workspace_id',$1,true)",[one]);await db.query('UPDATE personal_access_tokens SET revoked_at=clock_timestamp(),version=999 WHERE id=$1',[credential.id]);await db.query('COMMIT');
   expect((await admin!.query('SELECT version FROM personal_access_tokens WHERE id=$1',[credential.id])).rows[0].version).toBe(2);
   await db.query('BEGIN');await db.query("SELECT set_config('app.workspace_id',$1,true)",[one]);await expect(db.query('UPDATE personal_access_tokens SET revoked_at=NULL WHERE id=$1',[credential.id])).rejects.toThrow('PROFILE_TOKEN_REVOCATION_IMMUTABLE');await db.query('ROLLBACK');
  }finally{await db.query('ROLLBACK');db.release();}
  await expect(act(credential.secret)).rejects.toMatchObject({code:'PROFILE_PERSONAL_TOKEN_INVALID'});
  await expect(act(legacy.secret)).rejects.toMatchObject({code:'PROFILE_TOKEN_SCOPE_ADOPTION_REQUIRED'});
  const adoption=await admin!.connect();try{
   await adoption.query('BEGIN');await adoption.query('SET LOCAL ROLE "'+tokenOwner+'"');await adoption.query("SELECT set_config('app.workspace_id',$1,true)",[one]);
   await adoption.query('UPDATE personal_access_tokens SET profile_scopes=$2 WHERE id=$1',[legacy.id,JSON.stringify(['products:read','products:write'])]);await adoption.query('COMMIT');
  }finally{await adoption.query('ROLLBACK');adoption.release();}
  await act(legacy.secret,async()=>true);
 });
 it('applies current membership immediately without widening stored scopes and preserves environment bounds',async()=>{
  const credential=await issue();
  await admin!.query("UPDATE memberships SET role='viewer' WHERE user_id=$1 AND workspace_id=$2",[user,one]);
  await expect(act(credential.secret)).rejects.toMatchObject({code:'PROFILE_ACTION_FORBIDDEN'});
  await admin!.query("UPDATE memberships SET role='owner' WHERE user_id=$1 AND workspace_id=$2",[user,one]);
  await expect(withPersonalProfileTransaction(runtime!,credential.secret,'SIMULATION',{scope:'employees:write',mutation:true},async()=>true)).rejects.toMatchObject({code:'PROFILE_ACTION_FORBIDDEN'});
  await expect(withPersonalProfileTransaction(runtime!,credential.secret,'REAL',{scope:'products:read',mutation:false},async()=>true)).rejects.toMatchObject({code:'PROFILE_TOKEN_ENVIRONMENT_DENIED'});
  await admin!.query('UPDATE memberships SET active=false WHERE user_id=$1 AND workspace_id=$2',[user,one]);
  await expect(act(credential.secret)).rejects.toMatchObject({code:'PROFILE_TOKEN_MEMBERSHIP_REQUIRED'});
  await admin!.query("UPDATE memberships SET active=true,role='operator' WHERE user_id=$1 AND workspace_id=$2",[user,one]);
 });
 it('rechecks server expiry after waiting for membership locks, before commercial work',async()=>{
  const credential=await issue(one,undefined,2),blocker=await admin!.connect();let pending:Promise<unknown>|undefined,called=false;
  try{
   await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM memberships WHERE user_id=$1 AND workspace_id=$2 FOR UPDATE',[user,one]);
   pending=act(credential.secret,async()=>{called=true;});void pending.catch(()=>{});
   let blocked=false;for(let i=0;i<100&&!blocked;i++){blocked=Boolean((await admin!.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query LIKE '%FROM memberships%'",[login])).rowCount);if(!blocked)await new Promise(r=>setTimeout(r,10));}
   expect(blocked).toBe(true);await admin!.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.02) FROM personal_access_tokens WHERE id=$1',[credential.id]);
   await blocker.query('COMMIT');await expect(pending).rejects.toMatchObject({code:'PROFILE_PERSONAL_TOKEN_INVALID'});expect(called).toBe(false);
  }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending.catch(()=>{});}
 });
 it('rolls back a write when the token expires during SQL work',async()=>{
  const credential=await issue(one,undefined,1);
  await expect(act(credential.secret,async db=>{
   await db.query(`INSERT INTO "${table}" VALUES($1,'expired')`,[one]);
   await db.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.02) FROM personal_access_tokens WHERE id=$1',[credential.id]);
  })).rejects.toMatchObject({code:'PROFILE_PERSONAL_TOKEN_INVALID'});
  expect((await admin!.query(`SELECT * FROM "${table}" WHERE marker='expired'`)).rows).toEqual([]);
 });
 it('serializes mutual PAT revocation before either actor locks its own credential',async()=>{
  await admin!.query("UPDATE memberships SET role='owner' WHERE user_id=$1 AND workspace_id=$2",[user,one]);
  const first=await issue(one,['tokens:write']),second=await issue(one,['tokens:write']);
  let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
  const mutate=(secret:string,work:Parameters<typeof withPersonalProfileTransaction>[4])=>withPersonalProfileTransaction(runtime!,secret,'SIMULATION',{scope:'tokens:write',mutation:true},work);
  const active=mutate(first.secret,async db=>{entered();await hold;await db.query('UPDATE personal_access_tokens SET revoked_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2',[second.id,one]);});
  void active.catch(()=>{});
  try{
   await ready;let called=false;
   await expect(mutate(second.secret,async()=>{called=true;})).rejects.toMatchObject({code:'PROFILE_AUTHORITY_BUSY'});expect(called).toBe(false);
   release();await active;
   await expect(mutate(second.secret,async()=>true)).rejects.toMatchObject({code:'PROFILE_PERSONAL_TOKEN_INVALID'});
   expect((await admin!.query('SELECT revoked_at IS NULL AS active FROM personal_access_tokens WHERE id=$1',[first.id])).rows[0].active).toBe(true);
  }finally{release();await active.catch(()=>{});await admin!.query("UPDATE memberships SET role='operator' WHERE user_id=$1 AND workspace_id=$2",[user,one]);}
 });
 it('allows separate profiles and releases the administrative lock on rollback',async()=>{
  await admin!.query("UPDATE memberships SET role='owner' WHERE user_id=$1",[user]);
  const first=await issue(one,['tokens:write']),other=await issue(two,['tokens:write']);
  const mutate=(secret:string,work:Parameters<typeof withPersonalProfileTransaction>[4])=>withPersonalProfileTransaction(runtime!,secret,'SIMULATION',{scope:'tokens:write',mutation:true},work);
  try{
   await expect(mutate(first.secret,async()=>{await mutate(other.secret,async db=>{expect(db.workspaceId).toBe(two);});throw new Error('SYNTHETIC_ROLLBACK');})).rejects.toThrow('SYNTHETIC_ROLLBACK');
   expect(await mutate(first.secret,async()=> 'lock-released')).toBe('lock-released');
  }finally{await admin!.query("UPDATE memberships SET role='operator' WHERE user_id=$1",[user]);}
 });
 it('holds credential locks through work so revocation becomes effective on the next transaction',async()=>{
  const credential=await issue();let revoke:Promise<unknown>|undefined;
  try{
   await act(credential.secret,async()=>{
    revoke=admin!.query('UPDATE personal_access_tokens SET revoked_at=clock_timestamp() WHERE id=$1',[credential.id]);
    let blocked=false;for(let i=0;i<100&&!blocked;i++){blocked=Boolean((await admin!.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'UPDATE personal_access_tokens SET revoked_at=%'")).rowCount);if(!blocked)await new Promise(r=>setTimeout(r,10));}expect(blocked).toBe(true);
   });await revoke;
   await expect(act(credential.secret)).rejects.toMatchObject({code:'PROFILE_PERSONAL_TOKEN_INVALID'});
  }finally{if(revoke)await revoke;}
 });
});
