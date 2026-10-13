import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {openMigratedDatabase,isolatedAdminUrl,promotedSource} from '../support/migrated-database.js';
let closeDatabase:(()=>Promise<void>)|undefined;
let admin:pg.Pool,sql:string,original:unknown,grants:unknown;
const device='51000000-0000-4000-8000-000000000001',pairing='52000000-0000-4000-8000-000000000001';
async function tx<T>(work:(c:pg.PoolClient)=>Promise<T>,role?:string){const c=await admin.connect();try{await c.query('BEGIN');if(role)await c.query(`SET LOCAL ROLE ${role}`);const value=await work(c);await c.query('ROLLBACK');return value;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
const rows=async()=>(await admin.query("SELECT 'device' kind,to_jsonb(d) data FROM creative_devices d UNION ALL SELECT 'pairing',to_jsonb(p) FROM creative_pairings p ORDER BY kind")).rows;
const acl=async()=>(await admin.query("SELECT oid::regclass::text relation,relacl::text acl FROM pg_class WHERE oid IN('creative_devices'::regclass,'creative_pairings'::regclass) ORDER BY relation")).rows;
describe('retired creative credentials remain closed administrative history',()=>{
 beforeAll(async()=>{
  const database=await openMigratedDatabase('0082');admin=database.pool;closeDatabase=database.close;const url=new URL(database.url);
  sql=await promotedSource('components/020_retired_creative_custody.sql');
  await admin.query("INSERT INTO creative_devices(id,workspace_id,owner_id,name,platform,engine_version,token_hash,project_ids,status,revoked_at) VALUES($1,'synthetic-retired','synthetic-owner','Synthetic retired','darwin-arm64','1.0.0','synthetic-not-a-token','{}','REVOKED',clock_timestamp())",[device]);
  await admin.query("INSERT INTO creative_pairings(id,user_code_hash,poll_secret_hash,name,platform,engine_version,api_version,capabilities,status,workspace_id,token_ciphertext,expires_at) VALUES($1,'synthetic-code','synthetic-poll','Synthetic expired','darwin-arm64','1.0.0',1,'{}','EXPIRED',NULL,'synthetic-opaque-history',clock_timestamp()-interval '1 day')",[pairing]);
  original=await rows();grants=await acl();
 },60000);
 afterAll(async()=>{await closeDatabase?.();});
 it('requires migration authority without changing rows',async()=>{await expect(tx(c=>c.query(sql),'commerce_api')).rejects.toThrow('PROFILE_MIGRATION_OWNER_REQUIRED');expect(await rows()).toEqual(original);});
 it('requires the exact original retirement migration',async()=>{await expect(tx(async c=>{await c.query("UPDATE schema_migrations SET sha256=repeat('0',64) WHERE name='0042_v5_platform_retirement.sql'");return c.query(sql);})).rejects.toThrow('PROFILE_CREATIVE_RETIREMENT_SOURCE_REQUIRED');});
 it('rejects an active device instead of retiring it implicitly',async()=>{await expect(tx(async c=>{await c.query("UPDATE creative_devices SET status='CONNECTED',revoked_at=NULL WHERE id=$1",[device]);return c.query(sql);})).rejects.toThrow('PROFILE_CREATIVE_RETIREMENT_INCOMPLETE');expect(await rows()).toEqual(original);});
 it('rejects a pending or approved pairing and a missing revocation timestamp',async()=>{
  for(const state of ['PENDING','APPROVED'])await expect(tx(async c=>{await c.query('UPDATE creative_pairings SET status=$1 WHERE id=$2',[state,pairing]);return c.query(sql);})).rejects.toThrow('PROFILE_CREATIVE_RETIREMENT_INCOMPLETE');
  await expect(tx(async c=>{await c.query('UPDATE creative_devices SET revoked_at=NULL WHERE id=$1',[device]);return c.query(sql);})).rejects.toThrow('PROFILE_CREATIVE_RETIREMENT_INCOMPLETE');
 });
 it('rejects unreviewed policies before enabling RLS',async()=>{await expect(tx(async c=>{await c.query('CREATE POLICY unexpected ON creative_pairings USING(true)');return c.query(sql);})).rejects.toThrow('PROFILE_CREATIVE_CUSTODY_ALREADY_ALTERED');});
 it('preserves all original rows, nullable workspace and ACL when closing RLS',async()=>{await admin.query(sql);expect(await rows()).toEqual(original);expect(await acl()).toEqual(grants);expect((await admin.query("SELECT bool_and(relrowsecurity AND relforcerowsecurity) closed FROM pg_class WHERE oid IN('creative_devices'::regclass,'creative_pairings'::regclass)")).rows[0].closed).toBe(true);});
 it('exposes no credential history to the API even with matching profile context',async()=>{await tx(async c=>{await c.query("SELECT set_config('app.workspace_id','synthetic-retired',true),set_config('app.environment','REAL',true)");expect((await c.query('SELECT token_hash FROM creative_devices')).rows).toEqual([]);expect((await c.query('SELECT token_ciphertext FROM creative_pairings')).rows).toEqual([]);},'commerce_api');});
 it('denies runtime mutation and does not silently remove history',async()=>{
  await expect(tx(c=>c.query("INSERT INTO creative_pairings(id,user_code_hash,poll_secret_hash,name,platform,engine_version,api_version,capabilities,expires_at) VALUES('52000000-0000-4000-8000-000000000002','synthetic-code','synthetic-poll','Synthetic','darwin-arm64','1.0.0',1,'{}',clock_timestamp())"),'commerce_api')).rejects.toThrow(/row-level security/);
  await tx(async c=>{expect((await c.query("UPDATE creative_devices SET status='CONNECTED' RETURNING id")).rows).toEqual([]);expect((await c.query('DELETE FROM creative_pairings RETURNING id')).rows).toEqual([]);},'commerce_api');expect(await rows()).toEqual(original);
 });
 it('retains the deny when an additional permissive policy exists',async()=>{await tx(async c=>{await c.query('CREATE POLICY accidental_allow ON creative_pairings TO commerce_api USING(true) WITH CHECK(true)');await c.query('SET LOCAL ROLE commerce_api');expect((await c.query('SELECT * FROM creative_pairings')).rows).toEqual([]);});});
 it('rejects replay without changing preserved history',async()=>{await expect(admin.query(sql)).rejects.toThrow('PROFILE_CREATIVE_CUSTODY_ALREADY_ALTERED');expect(await rows()).toEqual(original);});
});
