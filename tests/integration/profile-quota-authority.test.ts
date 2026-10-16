import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withProfileTransaction,type ProfileExecutor} from '../../packages/db/src/profile-context.js';
import {openMigratedDatabase,isolatedAdminUrl,promotedSource} from '../support/migrated-database.js';

const suffix=randomBytes(8).toString('hex'),login='quota_'+suffix;
const one='quota_one_'+suffix,two='quota_two_'+suffix,three='quota_three_'+suffix;
let admin:pg.Pool,runtime:pg.Pool,closeDatabase:(()=>Promise<void>)|undefined;
const component=()=>promotedSource('components/020_global_quota_authority.sql');
const insert=async(db:ProfileExecutor,kind='conversation',body:object={},environment='REAL',id=randomUUID())=>{
 await db.query('INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,$3,$4,$5)',[id,db.workspaceId,environment,kind,body]);return id;
};
const work=<T>(workspace:string,fn:(db:ProfileExecutor)=>Promise<T>)=>withProfileTransaction(runtime,workspace,async db=>{
 await db.query('SET LOCAL ROLE commerce_automation');return fn(db);
});
const owner=<T>(workspace:string,fn:(db:ProfileExecutor)=>Promise<T>)=>withProfileTransaction(admin,workspace,fn);
const adopt=(workspace:string)=>owner(workspace,db=>db.query('SELECT adopt_profile_quota_inventory($1,profile_quota_inventory($1))',[workspace]));
const count=async(kind='conversation',workspace?:string)=>Number((await admin.query('SELECT count(*) n FROM profile_quota_entries WHERE kind=$1 AND ($2::text IS NULL OR workspace_id=$2)',[kind,workspace??null])).rows[0].n);
async function seedConversations(n:number,workspace=two){
 // Explicit synthetic fixture history, never a runtime reset or an adoption.
 await admin.query(`INSERT INTO profile_quota_entries(record_id,workspace_id,kind,admitted_at,profile_timezone,profile_day_start,profile_day_end,platform_day_start,platform_day_end,source)
 SELECT gen_random_uuid(),$1,'conversation',clock_timestamp(),'UTC',d.day_start,d.day_end,d.day_start,d.day_end,'NATIVE_BASELINE'
 FROM generate_series(1,$2),profile_quota_day(clock_timestamp(),'UTC') d`,[workspace,n]);
}

describe('closed quota owner retains global caps under native FORCE RLS',()=>{
 beforeAll(async()=>{
  // V7 F2: a database migrated through 0079 (profiles, settings and quotas) is
  // the state the promoted 0084 quota authority component is exercised on.
  const database=await openMigratedDatabase('0079');admin=database.pool;closeDatabase=database.close;const url=new URL(database.url);
  await admin.query("INSERT INTO profile_quota_policy(singleton,max_profiles,max_numbers,daily_conversations,calendar_timezone,adoption_sha256) VALUES(true,3,20,300,'UTC',$1)",['a'.repeat(64)]);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'One','UTC',2,2,2),($2,'Two','UTC',18,10,1000),($3,'Three','UTC',0,0,0)",[one,two,three]);
  // Test-owned RLS on the actual migrated tables, not a production policy claim.
  for(const table of ['records','record_versions'])await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;CREATE POLICY quota_fixture ON ${table} USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),''))`);
  const secret=randomBytes(32).toString('hex');
  await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT commerce_api,commerce_automation TO "${login}"`);
  url.username=login;url.password=secret;runtime=new pg.Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:5000});
 });
 beforeEach(async()=>{
  // Each test resets only its isolated synthetic database, using its owner.
  await admin.query('TRUNCATE profile_quota_entries,profile_quota_coverage,profile_quota_load_admissions,profile_quota_policy,records CASCADE');
  await admin.query("INSERT INTO profile_quota_policy(singleton,max_profiles,max_numbers,daily_conversations,calendar_timezone,adoption_sha256) VALUES(true,3,20,300,'UTC',$1)",['a'.repeat(64)]);
  await admin.query('UPDATE profiles SET number_limit=0,product_limit=10,daily_conversation_limit=1000');
  for(const [id,numbers,products,daily]of [[one,2,2,2],[two,18,10,1000],[three,0,0,0]]as const){
   await owner(id,db=>db.query("UPDATE profiles SET state='ACTIVE',timezone='UTC',number_limit=$2,product_limit=$3,daily_conversation_limit=$4 WHERE id=$1",[id,numbers,products,daily]));
  }
  await admin.query('DELETE FROM session_ownership WHERE workspace_id=ANY($1)',[[one,two,three]]);
  await admin.query('DELETE FROM manual_controls WHERE workspace_id=ANY($1)',[[one,two,three]]);
  for(const id of [one,two,three])await adopt(id);
 });
 afterAll(async()=>{await runtime?.end();await closeDatabase?.();const parent=new pg.Pool({connectionString:isolatedAdminUrl().toString(),max:1});try{await parent.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await parent.end();}});
 it('rejects altered definitions before creating an authority role',async()=>{const c=await admin.connect();try{await c.query('BEGIN');await c.query('ALTER FUNCTION profile_quota_inventory(text) SET search_path=public');await expect(c.query(await component())).rejects.toThrow('PROFILE_QUOTA_DEFINITION_DRIFT');}finally{await c.query('ROLLBACK');c.release();}expect((await admin.query("SELECT count(*)::int n FROM pg_shdepend d JOIN pg_roles r ON r.oid=d.refobjid WHERE r.rolname='commerce_quota_owner' AND d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].n).toBe(0);});
 it('rejects an extra function caller rather than retaining a wider adoption port',async()=>{const c=await admin.connect();try{await c.query('BEGIN');await c.query('GRANT EXECUTE ON FUNCTION profile_quota_inventory(text) TO commerce_api');await expect(c.query(await component())).rejects.toThrow('PROFILE_QUOTA_ACL_DRIFT');}finally{await c.query('ROLLBACK');c.release();}});
 it('never reuses a preexisting quota role with unrelated authority',async()=>{const c=await admin.connect();try{await c.query('BEGIN');// The reviewed owner exists in this cluster; an unsafe variant is refused, never adopted.
  await c.query('ALTER ROLE commerce_quota_owner INHERIT');await c.query('GRANT commerce_api TO commerce_quota_owner');await expect(c.query(await component())).rejects.toThrow(/V7_ROLE_EXISTING/);}finally{await c.query('ROLLBACK');c.release();}});
 it('transfers only the unchanged four functions to a non-inheriting private owner',async()=>{
  const names=['profile_quota_allocation_guard','profile_quota_inventory','adopt_profile_quota_inventory','profile_quota_record_guard'];
  const original=(await admin.query("SELECT proname,pg_get_functiondef(oid) body FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1) ORDER BY proname",[names])).rows;
  await admin.query(await component());
  expect((await admin.query("SELECT proname,pg_get_functiondef(oid) body FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1) ORDER BY proname",[names])).rows).toEqual(original);
  expect((await admin.query("SELECT rolcanlogin,rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname='commerce_quota_owner'")).rows[0]).toEqual({rolcanlogin:false,rolsuper:false,rolbypassrls:false,rolinherit:false});
  expect((await admin.query("SELECT 1 FROM pg_auth_members WHERE roleid='commerce_quota_owner'::regrole OR member='commerce_quota_owner'::regrole")).rows).toEqual([]);
  await expect(runtime.query('SET ROLE commerce_quota_owner')).rejects.toMatchObject({code:'42501'});
  await admin.query("ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;ALTER TABLE profiles FORCE ROW LEVEL SECURITY;CREATE POLICY fixture_runtime_profile ON profiles TO commerce_api,commerce_automation USING(id=NULLIF(current_setting('app.workspace_id',true),''))");
 });
 it('uses native non-superuser roles and refuses direct quota authority/history writes',async()=>{
  expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
  for(const table of ['profile_quota_policy','profile_quota_coverage','profile_quota_entries','profile_quota_load_admissions'])await expect(runtime.query('SELECT * FROM '+table)).rejects.toMatchObject({code:'42501'});
  await expect(runtime.query('SELECT adopt_profile_quota_inventory($1,$2)',[one,'a'.repeat(64)])).rejects.toMatchObject({code:'42501'});
  await expect(runtime.query('UPDATE profiles SET daily_conversation_limit=1000 WHERE id=$1',[one])).rejects.toMatchObject({code:'42501'});
 });
 it('requires both explicit policy and native baseline coverage before REAL creation',async()=>{
  await admin.query('TRUNCATE profile_quota_policy');await expect(work(one,db=>insert(db))).rejects.toThrow('PROFILE_QUOTA_POLICY_REQUIRED');
  await admin.query("INSERT INTO profile_quota_policy VALUES(true,3,20,300,'UTC',$1,clock_timestamp())",['b'.repeat(64)]);
  await admin.query('TRUNCATE profile_quota_coverage');await expect(work(one,db=>insert(db))).rejects.toThrow('PROFILE_QUOTA_INVENTORY_REQUIRED');expect(await count()).toBe(0);
 });
 it('blocks global admission until other native profile inventories are covered',async()=>{
  await admin.query('TRUNCATE profile_quota_coverage,profile_quota_entries');
  // Reproduce native history predating installation, only in this synthetic DB.
  await admin.query('ALTER TABLE records DISABLE TRIGGER profile_quota_record');
  try{await admin.query("INSERT INTO records(workspace_id,environment,kind,body) SELECT $1,'REAL','conversation','{}'::jsonb FROM generate_series(1,299)",[two]);}
  finally{await admin.query('ALTER TABLE records ENABLE TRIGGER profile_quota_record');}
  await adopt(one);await adopt(three);
  for(const kind of ['conversation','channel_account','product'])await expect(work(one,async db=>{
   if(kind!=='conversation')await db.query('SET LOCAL ROLE commerce_api');
   return insert(db,kind);
  })).rejects.toThrow('PLATFORM_QUOTA_INVENTORY_REQUIRED');
  expect(await count()).toBe(0);
  await adopt(two);expect(await count()).toBe(299);
  await work(one,db=>insert(db));await expect(work(two,db=>insert(db))).rejects.toThrow('PLATFORM_CONVERSATION_QUOTA_EXCEEDED');expect(await count()).toBe(300);
 });
 it('includes suspended profile history without enabling that profile',async()=>{
  await admin.query('TRUNCATE profile_quota_coverage,profile_quota_entries');
  await admin.query('ALTER TABLE records DISABLE TRIGGER profile_quota_record');
  try{await admin.query("INSERT INTO records(workspace_id,environment,kind,body) SELECT $1,'REAL','conversation','{}'::jsonb FROM generate_series(1,300)",[two]);}
  finally{await admin.query('ALTER TABLE records ENABLE TRIGGER profile_quota_record');}
  await admin.query("UPDATE profiles SET state='SUSPENDED' WHERE id=$1",[two]);
  for(const id of [one,two,three])await adopt(id);
  expect((await admin.query('SELECT state FROM profiles WHERE id=$1',[two])).rows[0].state).toBe('SUSPENDED');
  await expect(work(one,db=>insert(db))).rejects.toThrow('PLATFORM_CONVERSATION_QUOTA_EXCEEDED');
  await expect(work(two,db=>insert(db))).rejects.toThrow('PROFILE_QUOTA_PROFILE_REQUIRED');expect(await count()).toBe(300);
 });
 it('commits the record and reservation together without using supplied record time',async()=>{
  const before=Date.now();const id=await work(one,async db=>{
   const id=randomUUID();await db.query("INSERT INTO records(id,workspace_id,environment,kind,body,created_at) VALUES($1,$2,'REAL','conversation','{}','2000-01-01')",[id,one]);return id;
  });
  const entry=(await admin.query('SELECT * FROM profile_quota_entries WHERE record_id=$1',[id])).rows[0];expect(entry.admitted_at.getTime()).toBeGreaterThanOrEqual(before-1000);expect(entry.source).toBe('RUNTIME');
  expect(await count()).toBe(1);await expect(work(one,db=>insert(db,'conversation',{},'REAL',id))).rejects.toMatchObject({code:'23505'});expect(await count()).toBe(1);
 });
 it('rolls back both sides after a later business failure',async()=>{
  let id='';await expect(work(one,async db=>{id=await insert(db);throw Error('SYNTHETIC_LATE_FAILURE');})).rejects.toThrow('SYNTHETIC_LATE_FAILURE');
  expect(await count()).toBe(0);expect((await admin.query('SELECT id FROM records WHERE id=$1',[id])).rows).toEqual([]);
 });
 it('enforces the per-profile conversation limit and preserves consumed history',async()=>{
  await work(one,async db=>{await insert(db);await insert(db);});await expect(work(one,db=>insert(db))).rejects.toThrow('PROFILE_CONVERSATION_QUOTA_EXCEEDED');
  expect(await count()).toBe(2);await expect(admin.query('DELETE FROM profile_quota_entries')).rejects.toThrow('PROFILE_QUOTA_HISTORY_IMMUTABLE');
 });
 it('enforces total platform 300 even when another profile permits 1000',async()=>{
  await seedConversations(299);await work(one,db=>insert(db));await expect(work(two,db=>insert(db))).rejects.toThrow('PLATFORM_CONVERSATION_QUOTA_EXCEEDED');expect(await count()).toBe(300);
 });
 it('cannot exceed a final slot when two native transactions compete',async()=>{
  await seedConversations(299);const first=await runtime.connect();
  try{
   await first.query('BEGIN');await first.query('SET LOCAL ROLE commerce_automation');await first.query("SELECT set_config('app.workspace_id',$1,true)",[one]);
   await first.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','conversation','{}')",[one]);
   await expect(work(two,db=>insert(db))).rejects.toThrow('PROFILE_QUOTA_BUSY');await first.query('COMMIT');
  }finally{await first.query('ROLLBACK');first.release();}
  await expect(work(two,db=>insert(db))).rejects.toThrow('PLATFORM_CONVERSATION_QUOTA_EXCEEDED');expect(await count()).toBe(300);
 });
 it('requires an owner-adopted measured LOAD window and closes it at expiry',async()=>{
  await seedConversations(300);
  await expect(work(two,db=>insert(db))).rejects.toThrow('PLATFORM_CONVERSATION_QUOTA_EXCEEDED');
  await admin.query("INSERT INTO profile_quota_load_admissions VALUES($1,$2,$3,1000,clock_timestamp()-interval '2 seconds',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour')",[randomUUID(),'b'.repeat(64),'c'.repeat(64)]);
  await work(two,db=>insert(db));expect(await count()).toBe(301);
  await admin.query('TRUNCATE profile_quota_load_admissions');
  await admin.query("INSERT INTO profile_quota_load_admissions VALUES($1,$2,$3,1000,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',clock_timestamp())",[randomUUID(),'d'.repeat(64),'e'.repeat(64)]);
  await expect(work(two,db=>insert(db))).rejects.toThrow('PLATFORM_CONVERSATION_QUOTA_EXCEEDED');
 });
 it('rejects overlapping LOAD authority instead of selecting the larger window',async()=>{
  for(let i=0;i<2;i++)await admin.query("INSERT INTO profile_quota_load_admissions VALUES($1,$2,$3,1000,clock_timestamp()-interval '2 seconds',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour')",[randomUUID(),'b'.repeat(64),'c'.repeat(64)]);
  await expect(work(two,db=>insert(db))).rejects.toThrow('PROFILE_QUOTA_LOAD_AMBIGUOUS');
 });
 it('preserves calendar DST lengths and rejects unrecognized zones',async()=>{
  for(const [moment,hours]of [['2026-03-08T12:00:00Z',23],['2026-11-01T12:00:00Z',25]]as const){
   const d=(await admin.query("SELECT extract(epoch FROM day_end-day_start)/3600 hours FROM profile_quota_day($1,'America/Los_Angeles')",[moment])).rows[0];expect(Number(d.hours)).toBe(hours);
  }
  await expect(admin.query("SELECT * FROM profile_quota_day(clock_timestamp(),'not/a-zone')")).rejects.toThrow('PROFILE_QUOTA_TIMEZONE_INVALID');
 });
 it('does not reset profile consumption when its timezone changes',async()=>{
  await work(one,async db=>{await insert(db);await insert(db);});const previous=(await admin.query('SELECT * FROM profile_quota_entries ORDER BY record_id')).rows;
  await owner(one,db=>db.query("UPDATE profiles SET timezone='Pacific/Kiritimati' WHERE id=$1",[one]));
  await expect(work(one,db=>insert(db))).rejects.toThrow('PROFILE_CONVERSATION_QUOTA_EXCEEDED');expect((await admin.query('SELECT * FROM profile_quota_entries ORDER BY record_id')).rows).toEqual(previous);
 });
 it('keeps SIMULATION outside REAL consumption and rejects mismatched context',async()=>{
  await work(three,db=>insert(db,'conversation',{},'SIMULATION'));expect(await count()).toBe(0);
  await expect(work(one,db=>db.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','conversation','{}')",[two]))).rejects.toThrow('PROFILE_QUOTA_CONTEXT_REQUIRED');
  await expect(work(three,db=>insert(db))).rejects.toThrow('PROFILE_CONVERSATION_QUOTA_EXCEEDED');
 });
 it('blocks suspended profiles without consuming a reservation',async()=>{
  await admin.query("UPDATE profiles SET state='SUSPENDED' WHERE id=$1",[one]);await expect(work(one,db=>insert(db))).rejects.toThrow('PROFILE_QUOTA_PROFILE_REQUIRED');expect(await count()).toBe(0);
 });
 it('counts retained products including archived ones and disallows lowering below usage',async()=>{
  await owner(one,async db=>{await insert(db,'product',{status:'ARCHIVED'});await insert(db,'product');});
  await expect(owner(one,db=>insert(db,'product'))).rejects.toThrow('PROFILE_PRODUCT_QUOTA_EXCEEDED');
  await expect(admin.query('UPDATE profiles SET product_limit=1 WHERE id=$1',[one])).rejects.toThrow('PROFILE_QUOTA_BELOW_CONSUMED');expect(await count('product')).toBe(2);
 });
 it('blocks aggregate allocation beyond 20 and creation of a fourth profile',async()=>{
  await expect(admin.query('UPDATE profiles SET number_limit=3 WHERE id=$1',[one])).rejects.toThrow('PROFILE_QUOTA_ALLOCATION_EXCEEDED');
  await expect(admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES('four','Four','UTC',0,0,0)")).rejects.toThrow('PROFILE_QUOTA_ALLOCATION_EXCEEDED');
 });
 it('requires safe retirement before releasing a number and retains its immutable entry',async()=>{
  const id=await owner(one,db=>insert(db,'channel_account',{status:'STOPPED',provider:'waha'}));
  const retire=(db:ProfileExecutor)=>db.query("UPDATE records SET version=version+1,body=body||jsonb_build_object('deleted_at',clock_timestamp(),'sending_enabled',false,'identity_verified',false,'active_authorization_id',NULL) WHERE id=$1",[id]);
  await expect(owner(one,retire)).rejects.toThrow('PROFILE_QUOTA_RETIREMENT_PAUSE_REQUIRED');
  await admin.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'channel_account',$2,true,'synthetic','fixture')",[one,id]);
  await owner(one,retire);expect((await admin.query('SELECT retired_at FROM profile_quota_entries WHERE record_id=$1',[id])).rows[0].retired_at).toBeInstanceOf(Date);expect(await count('channel_account')).toBe(1);
  await expect(owner(one,db=>db.query("UPDATE records SET version=version+1,body=body-'deleted_at' WHERE id=$1",[id]))).rejects.toThrow('PROFILE_QUOTA_RETIRED_IMMUTABLE');
  await owner(one,async db=>{await insert(db,'channel_account');await insert(db,'channel_account');});await expect(owner(one,db=>insert(db,'channel_account'))).rejects.toThrow('PROFILE_NUMBER_QUOTA_EXCEEDED');
 });
 it('cannot acquire a free number with a fabricated retired marker',async()=>{
  await expect(owner(one,db=>insert(db,'channel_account',{deleted_at:'synthetic'}))).rejects.toThrow('PROFILE_QUOTA_RETIRED_INSERT_FORBIDDEN');expect(await count('channel_account')).toBe(0);
 });
 it('will not retire an owned QR session without native unlink and frozen ownership',async()=>{
  const id=await owner(one,db=>insert(db,'channel_account',{status:'STOPPED',provider:'waha'}));
  await admin.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'channel_account',$2,true,'synthetic','fixture')",[one,id]);
  await admin.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,frozen,lease_expires_at) VALUES($1,$2,'synthetic',true,clock_timestamp())",[id,one]);
  await expect(owner(one,db=>db.query("UPDATE records SET version=version+1,body=body||'{\"deleted_at\":\"fixture\",\"sending_enabled\":false,\"identity_verified\":false}'::jsonb WHERE id=$1",[id]))).rejects.toThrow('PROFILE_QUOTA_OWNERSHIP_UNRESOLVED');
 });
 it('adopts existing native history once and refuses an altered inventory hash',async()=>{
  await admin.query('TRUNCATE profile_quota_coverage,profile_quota_entries');
  await admin.query('ALTER TABLE records DISABLE TRIGGER profile_quota_record');
  try{await admin.query("INSERT INTO records(workspace_id,environment,kind,body,created_at) VALUES($1,'REAL','conversation','{}',clock_timestamp()-interval '1 hour')",[one]);}finally{await admin.query('ALTER TABLE records ENABLE TRIGGER profile_quota_record');}
  await expect(owner(one,db=>db.query('SELECT adopt_profile_quota_inventory($1,$2)',[one,'f'.repeat(64)]))).rejects.toThrow('PROFILE_QUOTA_INVENTORY_CHANGED');
  expect(await count()).toBe(0);await adopt(one);const entries=(await admin.query('SELECT * FROM profile_quota_entries')).rows;expect(entries).toHaveLength(1);expect(entries[0].source).toBe('NATIVE_BASELINE');
  await expect(adopt(one)).rejects.toThrow('PROFILE_QUOTA_ALREADY_ADOPTED');expect((await admin.query('SELECT * FROM profile_quota_entries')).rows).toEqual(entries);
 });
});
