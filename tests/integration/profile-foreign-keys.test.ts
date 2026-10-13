import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {readProfileCatalog,type ProfileCatalog} from '../../packages/db/src/profile-inventory.js';
import {planProfileForeignKeys,type ProfileForeignKeyPlan} from '../../packages/db/src/profile-foreign-key-plan.js';
const suffix=randomBytes(6).toString('hex'),login='fk_'+suffix,one=randomUUID(),other=randomUUID(),sim=randomUUID(),row=randomUUID();
let admin:pg.Pool,runtime:pg.Pool,plan:ProfileForeignKeyPlan;
describe('native scoped foreign key proposal atomicity',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');admin=new pg.Pool({connectionString:url.toString(),max:3});
  await admin.query(`CREATE TABLE profile_fk_parents(id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL);
   CREATE TABLE profile_fk_children(id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,parent_id uuid NOT NULL CONSTRAINT old_parent_fk REFERENCES profile_fk_parents(id),payload jsonb NOT NULL);
   GRANT SELECT,INSERT,UPDATE ON profile_fk_parents,profile_fk_children TO commerce_channel;`);
  await admin.query("INSERT INTO profile_fk_parents VALUES($1,'one','REAL'),($2,'other','REAL'),($3,'one','SIMULATION')",[one,other,sim]);
  await admin.query("INSERT INTO profile_fk_children VALUES($1,'one','REAL',$2,'{\"synthetic\":true}')",[row,one]);
  // Native metadata for two deliberately synthetic tables. This subset is a
  // DDL mechanism fixture, not an authenticated full-commercial-schema review.
  const full=await readProfileCatalog(admin,['commerce_channel']);
  // PostgreSQL name[] otherwise reaches node-pg as an opaque string. The
  // native catalog must return actual arrays before any isolation assessment.
  expect(full.foreign_keys.every(f=>Array.isArray(f.columns)&&Array.isArray(f.referenced_columns))).toBe(true);
  expect(full.policies.every(p=>Array.isArray(p.roles))).toBe(true);
  expect(full.roles.length).toBeGreaterThan(0);expect(full.roles.every(r=>Array.isArray(r.runtime_memberships))).toBe(true);
  const catalog:ProfileCatalog={...full,tables:full.tables.filter(t=>t.name.startsWith('profile_fk_')),foreign_keys:full.foreign_keys.filter(f=>f.table.startsWith('profile_fk_')),non_public_tables:[],non_public_foreign_keys:[],other_relations:full.other_relations.filter(r=>r.schema==='public')};
  plan=planProfileForeignKeys(catalog,{schema_version:1,tables:{profile_fk_parents:{workspace:'workspace_id',environment:'environment'},profile_fk_children:{workspace:'workspace_id',environment:'environment'}}});
  const password=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;GRANT commerce_channel TO "${login}"`);url.username=login;url.password=password;runtime=new pg.Pool({connectionString:url.toString(),max:2});
 },60000);
 afterAll(async()=>{await runtime?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}});
 it('does not allow a runtime role to apply the schema proposal',async()=>{
  expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});await expect(runtime.query(plan.sql)).rejects.toThrow('PROFILE_MIGRATION_OWNER_REQUIRED');
 });
 it('detects original constraint drift before adding any new key',async()=>{
  await admin.query('ALTER TABLE profile_fk_children RENAME CONSTRAINT old_parent_fk TO changed_fk');try{await expect(admin.query(plan.sql)).rejects.toThrow('PROFILE_FK_ORIGINAL_DRIFT');expect((await admin.query("SELECT 1 FROM pg_constraint WHERE conname LIKE 'profile_scope_%' AND conrelid IN('profile_fk_parents'::regclass,'profile_fk_children'::regclass)")).rows).toEqual([]);}finally{await admin.query('ALTER TABLE profile_fk_children RENAME CONSTRAINT changed_fk TO old_parent_fk');}
 });
 it('rejects a timing change in the original FK before adding constraints',async()=>{
  const c=await admin.connect();try{await c.query('BEGIN');await c.query('ALTER TABLE profile_fk_children ALTER CONSTRAINT old_parent_fk DEFERRABLE INITIALLY DEFERRED');await expect(c.query(plan.sql)).rejects.toThrow('PROFILE_FK_ORIGINAL_DRIFT');}finally{await c.query('ROLLBACK');c.release();}
  expect((await admin.query("SELECT condeferrable FROM pg_constraint WHERE conrelid='profile_fk_children'::regclass AND conname='old_parent_fk'")).rows[0].condeferrable).toBe(false);
 });
 it('rejects scope nullability drift before permitting null to bypass a composite key',async()=>{
  const c=await admin.connect();try{await c.query('BEGIN');await c.query('ALTER TABLE profile_fk_children ALTER COLUMN environment DROP NOT NULL');await expect(c.query(plan.sql)).rejects.toThrow('PROFILE_FK_SCOPE_DRIFT');}finally{await c.query('ROLLBACK');c.release();}
  expect((await admin.query("SELECT attnotnull FROM pg_attribute WHERE attrelid='profile_fk_children'::regclass AND attname='environment'")).rows[0].attnotnull).toBe(true);
 });
 it('rolls the entire DDL back on historical cross-profile data without correcting it',async()=>{
  await admin.query('UPDATE profile_fk_children SET parent_id=$1 WHERE id=$2',[other,row]);
  try{await expect(admin.query(plan.sql)).rejects.toMatchObject({code:'23503'});expect((await admin.query("SELECT 1 FROM pg_constraint WHERE conname LIKE 'profile_scope_%' AND conrelid IN('profile_fk_parents'::regclass,'profile_fk_children'::regclass)")).rows).toEqual([]);expect((await admin.query('SELECT parent_id,payload FROM profile_fk_children WHERE id=$1',[row])).rows[0]).toEqual({parent_id:other,payload:{synthetic:true}});}
  finally{await admin.query('UPDATE profile_fk_children SET parent_id=$1 WHERE id=$2',[one,row]);}
 });
 it('adds validated composite keys while preserving original rows and the original FK',async()=>{
  const before=(await admin.query('SELECT to_jsonb(c) raw FROM profile_fk_children c')).rows;await admin.query(plan.sql);expect((await admin.query('SELECT to_jsonb(c) raw FROM profile_fk_children c')).rows).toEqual(before);
  expect((await admin.query("SELECT conname,convalidated FROM pg_constraint WHERE conrelid='profile_fk_children'::regclass AND contype='f' ORDER BY conname")).rows).toEqual([{conname:'old_parent_fk',convalidated:true},{conname:plan.changes[0]!.foreign_key_name,convalidated:true}]);
 });
 it('enforces profile and environment even when a runtime has table INSERT rights',async()=>{
  for(const parent of [other,sim])await expect(runtime.query("INSERT INTO profile_fk_children VALUES($1,'one','REAL',$2,'{}')",[randomUUID(),parent])).rejects.toMatchObject({code:'23503'});
  expect((await runtime.query("INSERT INTO profile_fk_children VALUES($1,'one','REAL',$2,'{}') RETURNING workspace_id,environment",[randomUUID(),one])).rows[0]).toEqual({workspace_id:'one',environment:'REAL'});
 });
 it('blocks moving the parent scope and rejects a replay without weakening constraints',async()=>{
  await expect(runtime.query("UPDATE profile_fk_parents SET environment='SIMULATION' WHERE id=$1",[one])).rejects.toMatchObject({code:'23503'});
  await expect(admin.query(plan.sql)).rejects.toThrow();expect((await admin.query('SELECT environment FROM profile_fk_parents WHERE id=$1',[one])).rows[0].environment).toBe('REAL');
 });
 it('keeps a deferred relationship usable until COMMIT while still rejecting a crossed scope at COMMIT',async()=>{
  await admin.query(`CREATE TABLE profile_fk_deferred_parents(id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL);
   CREATE TABLE profile_fk_deferred_children(id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,parent_id uuid NOT NULL REFERENCES profile_fk_deferred_parents(id) DEFERRABLE INITIALLY DEFERRED);`);
  const full=await readProfileCatalog(admin,['commerce_channel']),prefix='profile_fk_deferred_',catalog={...full,tables:full.tables.filter(t=>t.name.startsWith(prefix)),foreign_keys:full.foreign_keys.filter(f=>f.table.startsWith(prefix)),non_public_tables:[],non_public_foreign_keys:[],other_relations:full.other_relations.filter(r=>r.schema==='public')};
  const deferred=planProfileForeignKeys(catalog,{schema_version:1,tables:{profile_fk_deferred_parents:{workspace:'workspace_id',environment:'environment'},profile_fk_deferred_children:{workspace:'workspace_id',environment:'environment'}}});await admin.query(deferred.sql);
  expect((await admin.query("SELECT condeferrable,condeferred FROM pg_constraint WHERE conrelid='profile_fk_deferred_children'::regclass AND contype='f'")).rows).toEqual([{condeferrable:true,condeferred:true},{condeferrable:true,condeferred:true}]);
  const parent=randomUUID(),child=randomUUID(),c=await admin.connect();try{
   await c.query('BEGIN');await c.query("INSERT INTO profile_fk_deferred_children VALUES($1,'one','REAL',$2)",[child,parent]);await c.query("INSERT INTO profile_fk_deferred_parents VALUES($1,'one','REAL')",[parent]);await c.query('COMMIT');
   await c.query('BEGIN');await c.query("INSERT INTO profile_fk_deferred_children VALUES($1,'other','REAL',$2)",[randomUUID(),parent]);await expect(c.query('COMMIT')).rejects.toMatchObject({code:'23503'});await c.query('ROLLBACK');
  }finally{await c.query('ROLLBACK');c.release();}
  expect((await admin.query('SELECT id FROM profile_fk_deferred_children')).rows).toEqual([{id:child}]);
 });

 it('reads and scopes native public-to-private and private-to-public bindings without exemptions',async()=>{
  await admin.query(`CREATE SCHEMA profile_fk_private;
   CREATE TABLE profile_fk_bridge_parents(id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL);
   INSERT INTO profile_fk_bridge_parents SELECT * FROM profile_fk_parents;
   CREATE TABLE profile_fk_private.bindings(id uuid PRIMARY KEY,workspace_id text NOT NULL,budget_environment text NOT NULL,parent_id uuid NOT NULL REFERENCES public.profile_fk_bridge_parents(id));
   CREATE TABLE profile_fk_bridge_attempts(id uuid PRIMARY KEY,workspace_id text NOT NULL,environment text NOT NULL,binding_id uuid NOT NULL REFERENCES profile_fk_private.bindings(id));`);
  const a=randomUUID(),b=randomUUID();await admin.query("INSERT INTO profile_fk_private.bindings VALUES($1,'one','REAL',$2),($3,'other','REAL',$4)",[a,one,b,other]);
  await admin.query("INSERT INTO profile_fk_bridge_attempts VALUES($1,'one','REAL',$2)",[randomUUID(),a]);
  const full=await readProfileCatalog(admin,['commerce_channel']),wanted=['profile_fk_bridge_parents','profile_fk_bridge_attempts'];
  const catalog={...full,tables:full.tables.filter(t=>wanted.includes(t.name)),foreign_keys:full.foreign_keys.filter(f=>f.table==='profile_fk_bridge_attempts'),non_public_tables:full.non_public_tables!.filter(t=>t.schema==='profile_fk_private'),non_public_foreign_keys:full.non_public_foreign_keys!.filter(t=>t.schema==='profile_fk_private'),other_relations:full.other_relations.filter(t=>t.schema==='profile_fk_private')};
  expect(catalog.non_public_tables).toHaveLength(1);expect(catalog.non_public_foreign_keys).toHaveLength(1);expect(catalog.non_public_foreign_keys[0]!.referenced_schema).toBe('public');
  const policy={schema_version:1 as const,tables:{profile_fk_bridge_parents:{workspace:'workspace_id',environment:'environment'},profile_fk_bridge_attempts:{workspace:'workspace_id',environment:'environment'},'profile_fk_private.bindings':{workspace:'workspace_id',environment:'budget_environment'}}};
  expect(()=>planProfileForeignKeys({...catalog,non_public_tables:undefined},policy)).toThrow('PROFILE_FK_PRIVATE_CATALOG_REQUIRED');
  const p=planProfileForeignKeys(catalog,policy);expect(p.changes).toHaveLength(2);await admin.query(p.sql);
  await expect(admin.query("INSERT INTO profile_fk_bridge_attempts VALUES($1,'one','REAL',$2)",[randomUUID(),b])).rejects.toMatchObject({code:'23503'});
  await expect(admin.query("INSERT INTO profile_fk_private.bindings VALUES($1,'one','REAL',$2)",[randomUUID(),other])).rejects.toMatchObject({code:'23503'});
  await expect(admin.query("INSERT INTO profile_fk_private.bindings VALUES($1,'one','SIMULATION',$2)",[randomUUID(),one])).rejects.toMatchObject({code:'23503'});
  expect((await admin.query("SELECT count(*)::int n FROM pg_constraint WHERE conname=ANY($1::text[]) AND convalidated",[p.changes.map(c=>c.foreign_key_name)])).rows[0].n).toBe(2);
 });

});
