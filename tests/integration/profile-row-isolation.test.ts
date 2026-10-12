import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {readProfileCatalog} from '../../packages/db/src/profile-inventory.js';
import {planProfileRowIsolation,type ProfileRowIsolationPolicy} from '../../packages/db/src/profile-row-isolation-plan.js';
let admin:pg.Pool,sql:string,grants:unknown;
async function scoped<T>(workspace:string|null,environment:string|null,work:(c:pg.PoolClient)=>Promise<T>,role='commerce_api'){
 const c=await admin.connect();try{await c.query('BEGIN');await c.query(`SET LOCAL ROLE ${role}`);if(workspace!==null)await c.query("SELECT set_config('app.workspace_id',$1,true)",[workspace]);if(environment!==null)await c.query("SELECT set_config('app.environment',$1,true)",[environment]);const value=await work(c);await c.query('ROLLBACK');return value;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
describe('row isolation proposal against native PostgreSQL catalogs',()=>{
 beforeAll(async()=>{
  const url=localInventoryTarget(process.env.DATABASE_URL);if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(new URL(url).pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');admin=new pg.Pool({connectionString:url,max:2});
  await admin.query(`CREATE TABLE profile_row_items(id text PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,visible boolean NOT NULL);
   CREATE TABLE profile_row_ready(LIKE profile_row_items INCLUDING ALL);CREATE TABLE profile_row_shared(LIKE profile_row_items INCLUDING ALL);
   CREATE SCHEMA profile_row_private;CREATE TABLE profile_row_private."Items"(LIKE profile_row_items INCLUDING ALL);
   GRANT USAGE ON SCHEMA profile_row_private TO commerce_api;GRANT SELECT,INSERT,UPDATE,DELETE ON profile_row_items,profile_row_ready,profile_row_shared,profile_row_private."Items" TO commerce_api;
   GRANT SELECT ON profile_row_items TO commerce_maintenance;
   CREATE POLICY closed_counter ON profile_row_items TO commerce_maintenance USING(true);
   ALTER TABLE profile_row_ready ENABLE ROW LEVEL SECURITY;ALTER TABLE profile_row_ready FORCE ROW LEVEL SECURITY;
   CREATE POLICY ready_only ON profile_row_ready TO commerce_api USING(visible) WITH CHECK(visible);
   INSERT INTO profile_row_items VALUES('ar','a','REAL',true),('as','a','SIMULATION',true),('br','b','REAL',true),('hidden','a','REAL',false);
   INSERT INTO profile_row_ready SELECT * FROM profile_row_items;INSERT INTO profile_row_shared SELECT * FROM profile_row_items;INSERT INTO profile_row_private."Items" SELECT * FROM profile_row_items;`);
  const catalog=await readProfileCatalog(admin,['commerce_api']),policy:ProfileRowIsolationPolicy={schema_version:1,tables:{}};
  for(const t of catalog.tables)policy.tables[t.name]={mode:'preserve',reason:'Synthetic mechanism fixture preserves every canonical relation.'};
  for(const t of catalog.non_public_tables??[])policy.tables[t.schema+'.'+t.name]={mode:'preserve',reason:'Synthetic fixture preserves unrelated private relations.'};
  for(const name of ['profile_row_items','profile_row_ready','profile_row_shared','profile_row_private.Items'])policy.tables[name]={mode:'scope',workspace:'workspace_id',environment:name==='profile_row_shared'?null:'environment',roles:['commerce_api'],initialize_permission:name!=='profile_row_ready'};
  sql=planProfileRowIsolation(catalog,policy).sql;grants=(await admin.query("SELECT table_schema,table_name,grantee,privilege_type FROM information_schema.table_privileges WHERE table_name LIKE 'profile_row_%' OR table_schema='profile_row_private' ORDER BY 1,2,3,4")).rows;
 },60000);
 afterAll(async()=>{await admin?.end();});
 it('rejects a new unclassified relation before changing any flags',async()=>{
  const c=await admin.connect();try{await c.query('BEGIN');await c.query('CREATE TABLE profile_row_drift(id text)');await expect(c.query(sql)).rejects.toThrow('PROFILE_ROW_TABLE_DRIFT');await c.query('ROLLBACK');}finally{c.release();}
  expect((await admin.query("SELECT relrowsecurity FROM pg_class WHERE oid='profile_row_items'::regclass")).rows[0].relrowsecurity).toBe(false);
 });
 it('rejects column drift before DDL and preserves the old rows',async()=>{
  const c=await admin.connect();try{await c.query('BEGIN');await c.query('ALTER TABLE profile_row_items ADD COLUMN drift text');await expect(c.query(sql)).rejects.toThrow('PROFILE_ROW_METADATA_DRIFT');await c.query('ROLLBACK');}finally{c.release();}
  expect((await admin.query('SELECT count(*)::int n FROM profile_row_items')).rows[0].n).toBe(4);
 });
 it('rejects policy-command drift even when expressions and roles are identical',async()=>{
  const c=await admin.connect();try{await c.query('BEGIN');await c.query('DROP POLICY closed_counter ON profile_row_items; CREATE POLICY closed_counter ON profile_row_items FOR SELECT TO commerce_maintenance USING(true)');await expect(c.query(sql)).rejects.toThrow('PROFILE_ROW_POLICY_DRIFT');await c.query('ROLLBACK');}finally{c.release();}
 });
 it('applies the proposal with unchanged SQL grants and row contents',async()=>{
  await admin.query(sql);const after=(await admin.query("SELECT table_schema,table_name,grantee,privilege_type FROM information_schema.table_privileges WHERE table_name LIKE 'profile_row_%' OR table_schema='profile_row_private' ORDER BY 1,2,3,4")).rows;expect(after).toEqual(grants);
  expect((await admin.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='profile_row_items'::regclass")).rows[0]).toEqual({relrowsecurity:true,relforcerowsecurity:true});expect((await admin.query('SELECT count(*)::int n FROM profile_row_items')).rows[0].n).toBe(4);
 });
 it('requires both profile and environment for a tenant-environment table',async()=>{
  for(const [w,e]of [[null,null],['a',null],[null,'REAL'],['a','OTHER']] as const)expect(await scoped(w,e,async c=>(await c.query('SELECT id FROM profile_row_items')).rows)).toEqual([]);
 });
 it('isolates the same profile across REAL and SIMULATION and another profile',async()=>{
  expect(await scoped('a','REAL',async c=>(await c.query('SELECT id FROM profile_row_items ORDER BY id')).rows.map(r=>r.id))).toEqual(['ar','hidden']);
  expect(await scoped('a','SIMULATION',async c=>(await c.query('SELECT id FROM profile_row_items ORDER BY id')).rows.map(r=>r.id))).toEqual(['as']);
  expect(await scoped('b','REAL',async c=>(await c.query('SELECT id FROM profile_row_items')).rows.map(r=>r.id))).toEqual(['br']);
 });
 it('rejects cross-profile and cross-environment INSERT and UPDATE',async()=>{
  await expect(scoped('a','REAL',c=>c.query("INSERT INTO profile_row_items VALUES('new','b','REAL',true)"))).rejects.toThrow(/row-level security/);
  await expect(scoped('a','REAL',c=>c.query("UPDATE profile_row_items SET environment='SIMULATION' WHERE id='ar'"))).rejects.toThrow(/row-level security/);
 });
 it('DELETE cannot target another profile and scoped deletion is transactional',async()=>{
  expect(await scoped('a','REAL',async c=>(await c.query("DELETE FROM profile_row_items WHERE id='br'")).rowCount)).toBe(0);
  expect(await scoped('a','REAL',async c=>(await c.query("DELETE FROM profile_row_items WHERE id='ar'")).rowCount)).toBe(1);
  expect((await admin.query('SELECT count(*)::int n FROM profile_row_items')).rows[0].n).toBe(4);
 });
 it('preserves preexisting READY restrictions instead of adding permissive access',async()=>{
  expect(await scoped('a','REAL',async c=>(await c.query('SELECT id FROM profile_row_ready ORDER BY id')).rows.map(r=>r.id))).toEqual(['ar']);
  await expect(scoped('a','REAL',c=>c.query("INSERT INTO profile_row_ready VALUES('new','a','REAL',false)"))).rejects.toThrow(/row-level security/);
 });
 it('preserves the separately scoped closed global counter policy',async()=>{
  expect(await scoped('a','REAL',async c=>(await c.query('SELECT count(*)::int n FROM profile_row_items')).rows[0].n,'commerce_maintenance')).toBe(4);
 });
 it('binds quoted private relations and explicit profile-only controls',async()=>{
  expect(await scoped('a','REAL',async c=>(await c.query('SELECT id FROM profile_row_private."Items" ORDER BY id')).rows.map(r=>r.id))).toEqual(['ar','hidden']);
  expect(await scoped('a',null,async c=>(await c.query('SELECT id FROM profile_row_shared ORDER BY id')).rows.map(r=>r.id))).toEqual(['ar','as','hidden']);
 });
 it('rejects replay against changed native flags and policies',async()=>{await expect(admin.query(sql)).rejects.toThrow('PROFILE_ROW_METADATA_DRIFT');});
});
