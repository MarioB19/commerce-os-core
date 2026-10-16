import {readFile,readdir} from 'node:fs/promises';
import {randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {withProfileTransaction} from '../../packages/db/src/profile-context.js';
import {assessProfileCatalog,readProfileCatalog,type ProfileInventoryPolicy,type ProfileCatalog} from '../../packages/db/src/profile-inventory.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {withMigratedDatabase} from '../support/migrated-database.js';

// Synthetic PostgreSQL primitive proof only. It does not activate domain RLS.
const suffix=randomBytes(8).toString('hex'),login='f2_test_'+suffix;
const parent='f2_parent_'+suffix,child='f2_child_'+suffix;
let admin:pg.Pool|undefined,runtime:pg.Pool|undefined,baseline:ProfileCatalog;
let policy:ProfileInventoryPolicy;
const sources=new URL('../../packages/db/migrations/',import.meta.url);
describe('profile foundation with PostgreSQL and an actual restricted login',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));
  if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw new Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:1,connectionTimeoutMillis:5000});
  policy=JSON.parse(await readFile(new URL('../../packages/db/profile-inventory-policy.json',import.meta.url),'utf8'));
  // The F0 inventory policy pins the 68-migration historical schema (production
  // before the V7 cutover); read it from a sub-database migrated through 0068.
  await withMigratedDatabase('0068',async historical=>{baseline=await readProfileCatalog(historical,policy.runtime_roles);});
  const password=randomBytes(32).toString('hex');
  await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT`);
  await admin.query(`GRANT commerce_api TO "${login}"`);
  await admin.query(`CREATE TABLE "${parent}"(workspace_id text NOT NULL,id integer NOT NULL,content text NOT NULL,PRIMARY KEY(workspace_id,id));
   CREATE TABLE "${child}"(workspace_id text NOT NULL,id integer NOT NULL,parent_id integer NOT NULL,PRIMARY KEY(workspace_id,id),FOREIGN KEY(workspace_id,parent_id) REFERENCES "${parent}"(workspace_id,id) ON DELETE CASCADE);
   INSERT INTO "${parent}" VALUES('one',1,'synthetic-one'),('two',2,'synthetic-two');
   GRANT SELECT,INSERT,UPDATE,DELETE ON "${parent}","${child}" TO commerce_api;
   ALTER TABLE "${parent}" ENABLE ROW LEVEL SECURITY;ALTER TABLE "${parent}" FORCE ROW LEVEL SECURITY;
   ALTER TABLE "${child}" ENABLE ROW LEVEL SECURITY;ALTER TABLE "${child}" FORCE ROW LEVEL SECURITY;
   CREATE POLICY tenant ON "${parent}" USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));
   CREATE POLICY tenant ON "${child}" USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),''));`);
  url.username=login;url.password=password;
  runtime=new pg.Pool({connectionString:url.toString(),max:1,connectionTimeoutMillis:5000});
 });
 afterAll(async()=>{
  await runtime?.end();
  if(admin){
   try{await admin.query(`DROP TABLE IF EXISTS "${child}","${parent}";DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}
  }
 });
 it('reads the migrated native catalog and exact historical hashes without declaring isolation complete',async()=>{
  const files=(await readdir(sources)).filter(x=>x.endsWith('.sql')&&x<'0069').sort();
  const expected=await Promise.all(files.map(async name=>({name,sha256:createHash('sha256').update(await readFile(new URL(name,sources))).digest('hex')})));
  expect(baseline.migrations).toEqual(expected);
  const report=assessProfileCatalog(baseline,policy);
  expect(report.issues.filter(x=>['TABLE_MISSING','TABLE_NOT_CLASSIFIED'].includes(x.code))).toEqual([]);
  expect(report.issues.map(x=>x.code)).toContain('RLS_DISABLED');
  expect(report.behavioral_isolation_verified).toBe(false);expect(report.production_installation_proven).toBe(false);
 });
 it('connects as the actual restricted login rather than impersonating it through a superuser session',async()=>{
  const row=(await runtime!.query('SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  expect(row).toEqual({current_user:login,session_user:login,rolsuper:false,rolbypassrls:false});
  expect((await runtime!.query('SELECT c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) owner FROM pg_class c WHERE c.relname=$1',[parent])).rows[0].owner).toBe(false);
 });
 it('denies an absent profile and foreign writes',async()=>{
  expect((await runtime!.query(`SELECT * FROM "${parent}"`)).rows).toEqual([]);
  await expect(runtime!.query(`INSERT INTO "${parent}" VALUES('one',9,'denied')`)).rejects.toMatchObject({code:'42501'});
  await expect(withProfileTransaction(runtime!,'one',db=>db.query(`INSERT INTO "${parent}" VALUES('two',9,'denied')`))).rejects.toMatchObject({code:'42501'});
 });
 it('reuses a single pooled connection without leaking the prior profile through commit or rollback',async()=>{
  const select=async(id:string)=>withProfileTransaction(runtime!,id,async db=>(await db.query(`SELECT content FROM "${parent}" ORDER BY id`)).rows);
  expect(await select('one')).toEqual([{content:'synthetic-one'}]);expect(await select('two')).toEqual([{content:'synthetic-two'}]);
  await expect(withProfileTransaction(runtime!,'one',async db=>{await db.query(`UPDATE "${parent}" SET content='rolled-back'`);throw new Error('injected');})).rejects.toThrow('injected');
  expect(await select('one')).toEqual([{content:'synthetic-one'}]);
  expect((await runtime!.query(`SELECT * FROM "${parent}"`)).rows).toEqual([]);
 });
 it('rejects cross-profile references and preserves the other profile during cascading deletes',async()=>{
  await expect(withProfileTransaction(runtime!,'one',db=>db.query(`INSERT INTO "${child}" VALUES('one',1,2)`))).rejects.toMatchObject({code:'23503'});
  await withProfileTransaction(runtime!,'one',db=>db.query(`INSERT INTO "${parent}" VALUES('one',3,'cascade');INSERT INTO "${child}" VALUES('one',3,3);DELETE FROM "${parent}" WHERE id=3`));
  expect((await withProfileTransaction(runtime!,'one',db=>db.query(`SELECT * FROM "${child}"`))).rows).toEqual([]);
  expect((await withProfileTransaction(runtime!,'two',db=>db.query(`SELECT content FROM "${parent}"`))).rows).toEqual([{content:'synthetic-two'}]);
 });
 it('refuses success if the consumer catches a PostgreSQL transaction-aborting error',async()=>{
  await expect(withProfileTransaction(runtime!,'one',async db=>{
   try{await db.query('SELECT 1/0');}catch{/* expected native error; transaction must still fail */}
   return 'not committed';
  })).rejects.toThrow('PROFILE_TRANSACTION_QUERY_FAILED');
  expect((await withProfileTransaction(runtime!,'two',db=>db.query(`SELECT count(*)::integer total FROM "${parent}"`))).rows).toEqual([{total:1}]);
 });
 it('discovers pg-boss schemas, foreign tables, materialized views and direct privilege paths from PostgreSQL',async()=>{
  const schema='pgboss_f2_'+suffix,foreign='f2_foreign_'+suffix,fdw='f2_fdw_'+suffix,server='f2_server_'+suffix;
  try{
   // No foreign handler, options or connection: catalog metadata only, never foreign IO.
   await admin!.query(`CREATE SCHEMA "${schema}";CREATE TABLE "${schema}".job(id integer,data text);
    CREATE MATERIALIZED VIEW "${schema}".cached_jobs AS SELECT id FROM "${schema}".job WITH NO DATA;
    CREATE SEQUENCE "${schema}".synthetic_sequence;
    GRANT USAGE,CREATE ON SCHEMA "${schema}" TO commerce_api;GRANT SELECT ON "${schema}".job TO commerce_api;
    GRANT SELECT(data) ON "${schema}".job TO PUBLIC;
    CREATE FUNCTION "${schema}".fixture_definer() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT ''synthetic''::text';
    CREATE FOREIGN DATA WRAPPER "${fdw}" NO HANDLER NO VALIDATOR;CREATE SERVER "${server}" FOREIGN DATA WRAPPER "${fdw}";
    CREATE FOREIGN TABLE public."${foreign}"(workspace_id text) SERVER "${server}";GRANT SELECT ON public."${foreign}" TO commerce_api;`);
   const actual=await readProfileCatalog(admin!,policy.runtime_roles),report=assessProfileCatalog(actual,policy);
   expect(actual.other_relations).toEqual(expect.arrayContaining([
    expect.objectContaining({schema,name:'job',kind:'r'}),expect.objectContaining({schema,name:'synthetic_sequence',kind:'S'}),
    expect.objectContaining({schema:'public',name:foreign,kind:'f'}),
   ]));
   expect(actual.views).toContainEqual(expect.objectContaining({schema,name:'cached_jobs',kind:'m'}));
   expect(actual.grants).toContainEqual(expect.objectContaining({schema,table:'job',grantee:'commerce_api',privilege:'SELECT'}));
   expect(actual.column_grants).toContainEqual(expect.objectContaining({schema,table:'job',column:'data',grantee:'PUBLIC'}));
   expect(actual.function_grants).toContainEqual(expect.objectContaining({identity:schema+'.fixture_definer()',security_definer:true,grantee:'PUBLIC',privilege:'EXECUTE'}));
   expect(report.issues).toContainEqual({code:'RUNTIME_SCHEMA_WRITE_OR_GRANT',object:schema+'.commerce_api.CREATE'});
   expect(report.issues).toContainEqual({code:'SECURITY_DEFINER_REVIEW_REQUIRED',object:schema+'.fixture_definer()'});
  }finally{
   await admin!.query(`DROP FOREIGN TABLE IF EXISTS public."${foreign}";DROP SERVER IF EXISTS "${server}";DROP FOREIGN DATA WRAPPER IF EXISTS "${fdw}";
    DROP MATERIALIZED VIEW IF EXISTS "${schema}".cached_jobs;DROP TABLE IF EXISTS "${schema}".job;DROP SEQUENCE IF EXISTS "${schema}".synthetic_sequence;
    DROP FUNCTION IF EXISTS "${schema}".fixture_definer();DROP SCHEMA IF EXISTS "${schema}";`);
  }
 });
 it('enumerates both runtime members and roles inherited by their login',async()=>{
  const ancestor='f2_ancestor_'+suffix;
  await admin!.query(`CREATE ROLE "${ancestor}" NOLOGIN NOBYPASSRLS;GRANT "${ancestor}" TO "${login}"`);
  try{
   const roles=(await readProfileCatalog(admin!,policy.runtime_roles)).roles;
   expect(roles.find(x=>x.name===login)?.runtime_memberships).toContain('commerce_api');
   expect(roles.find(x=>x.name===ancestor)?.runtime_memberships).toContain('commerce_api');
  }finally{await admin!.query(`DROP ROLE "${ancestor}"`);}
 });
});
