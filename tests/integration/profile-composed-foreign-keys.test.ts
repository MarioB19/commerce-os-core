import {readFile,writeFile} from 'node:fs/promises';
import {isAbsolute,relative,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {requireMigratedProfileSchema} from '../support/migrated-database.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {readProfileCatalog,type ProfileCatalog} from '../../packages/db/src/profile-inventory.js';
import {commerceProfileForeignKeyPolicy} from '../../packages/db/src/commerce-profile-foreign-key-policy.js';
import {planProfileForeignKeys,type ProfileForeignKeyPlan} from '../../packages/db/src/profile-foreign-key-plan.js';
let admin:pg.Pool,catalog:ProfileCatalog,plan:ProfileForeignKeyPlan;
const a='composed-fk-a',b='composed-fk-b';
async function transaction(work:(c:pg.PoolClient)=>Promise<void>){const c=await admin.connect();try{await c.query('BEGIN');await work(c);}finally{await c.query('ROLLBACK');c.release();}}
async function health(c:pg.PoolClient,w=a,environment='REAL'){return(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,$2,'health_signal','{\"scope\":\"account\",\"status\":\"OK\"}') RETURNING id",[w,environment])).rows[0].id as string;}
describe('complete composed V7 FK proposal over the native schema',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');admin=new pg.Pool({connectionString:url.toString(),max:3});
  // V7 F2: the canonical chain, its components and the isolation model are
  // installed by the migrations (0069-0100); no transition source is applied here.
  await requireMigratedProfileSchema(admin);
  catalog=await readProfileCatalog(admin,['commerce_api','commerce_ingress','commerce_automation','commerce_channel','commerce_maintenance','commerce_ai','commerce_mail_dispatch','commerce_number_lab','commerce_results']);plan=planProfileForeignKeys(catalog,commerceProfileForeignKeyPolicy(catalog));
  for(const w of [a,b])await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic FK','UTC',0,0,0)",[w]);
 },60000);
 afterAll(async()=>{await admin?.end();});
 it('installs exactly the planner proposal over the native schema through migration 0098',async()=>{
  // The migrated catalog already holds the 145 composed keys; replanning it yields
  // the same proposal because composed keys already carry their scope columns.
  const raw=await readFile(new URL('../../packages/db/migrations/0098_v7_composed_foreign_keys.sql',import.meta.url),'utf8');
  expect(raw.slice(raw.indexOf('-- Local proposal only'))).toBe(plan.sql);
  expect(catalog.tables.length+catalog.non_public_tables!.length).toBe(226);expect(plan.changes).toHaveLength(145);expect(plan.changes.filter(c=>c.original.on_delete==='c').map(c=>c.source_table)).toEqual(['health_observation_index','outbox_gate_schedule']);expect(plan.changes.some(c=>c.source_table.startsWith('commerce_number_lab.'))).toBe(false);
 });
 it('does not permit an application role to execute the DDL proposal',async()=>{await transaction(async c=>{await c.query('SET LOCAL ROLE commerce_api');await expect(c.query(plan.sql)).rejects.toThrow('PROFILE_MIGRATION_OWNER_REQUIRED');});});
 it('revalidates nullable scope before any FK addition',async()=>{await transaction(async c=>{await c.query('ALTER TABLE records ALTER COLUMN environment DROP NOT NULL');await expect(c.query(plan.sql)).rejects.toThrow('PROFILE_FK_SCOPE_DRIFT');});});
 it('revalidates an unchanged RF19 bridge under its locks instead of trusting only the offline review',async()=>{await transaction(async c=>{await c.query('ALTER TABLE ai_attempts RENAME CONSTRAINT number_lab_attempt_binding TO altered_binding');await expect(c.query(plan.sql)).rejects.toThrow('PROFILE_FK_ORIGINAL_DRIFT');});});
 it('keeps every original key, its actions and validation next to its validated composed key',async()=>{
  const installed=(await admin.query("SELECT conname,convalidated FROM pg_constraint WHERE contype='f' AND conname LIKE 'profile_scope_f_%'")).rows as {conname:string;convalidated:boolean}[];
  expect(installed.map(r=>r.conname).sort()).toEqual(plan.changes.map(c=>c.foreign_key_name).sort());expect(installed.every(r=>r.convalidated)).toBe(true);
  const keys=[...catalog.foreign_keys,...catalog.non_public_foreign_keys!];expect(keys).toHaveLength(536);const native=new Map(keys.map(k=>[k.table+'.'+k.name,k]));for(const change of plan.changes){const k=native.get(change.original.table+'.'+change.original.name);expect(k?.validated).toBe(true);expect(change.original).toMatchObject(k!);}
  const output=process.env.PROFILE_FK_CATALOG_PATH;if(output){if(!isAbsolute(output)||!relative(process.cwd(),resolve(output)).startsWith('../'))throw Error('PROFILE_FK_EXTERNAL_PATH_REQUIRED');await writeFile(output,JSON.stringify({schema_version:1,state:'LOCAL_MIGRATED_COMPOSED_FK_CATALOG',catalog_sha256:plan.catalog_sha256,policy_sha256:plan.policy_sha256,changes:plan.changes.length,catalog,production_affected:false},null,2)+'\n',{flag:'wx',mode:0o600});}
 });
 it('blocks a new cross-profile relation even through an owner that bypasses row policies',async()=>{await transaction(async c=>{const id=await health(c);await expect(c.query('UPDATE health_observation_index SET workspace_id=$2 WHERE record_id=$1',[id,b])).rejects.toMatchObject({code:'23503'});});});
 it('blocks a new cross-environment relation while a native same-scope insertion still succeeds',async()=>{await transaction(async c=>{const id=await health(c,a,'SIMULATION');expect((await c.query('SELECT environment FROM health_observation_index WHERE record_id=$1',[id])).rows[0].environment).toBe('SIMULATION');await expect(c.query("UPDATE health_observation_index SET environment='REAL' WHERE record_id=$1",[id])).rejects.toMatchObject({code:'23503'});});});
 it('retains actual outbox scheduler CASCADE semantics alongside the old FK',async()=>{await transaction(async c=>{
  await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[a]);const id=randomUUID();await c.query("INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,config_hash) VALUES($1,$2,'REAL','synthetic-account','synthetic-conversation','synthetic-contact',$3,'{}','synthetic-config')",[id,a,id]);await c.query("INSERT INTO outbox_gate_schedule(effect_id,next_check_at,last_reason) VALUES($1,clock_timestamp(),'synthetic')",[id]);expect((await c.query('SELECT effect_id FROM outbox_gate_schedule WHERE effect_id=$1',[id])).rowCount).toBe(1);await c.query('DELETE FROM outbox WHERE id=$1',[id]);expect((await c.query('SELECT effect_id FROM outbox_gate_schedule WHERE effect_id=$1',[id])).rowCount).toBe(0);
 });});
 it('keeps health evidence history protection despite retaining its cascade action',async()=>{await transaction(async c=>{const id=await health(c);await expect(c.query('DELETE FROM records WHERE id=$1',[id])).rejects.toThrow();});const rows=(await admin.query("SELECT confdeltype::text action FROM pg_constraint WHERE conrelid='health_observation_index'::regclass AND contype='f' AND confrelid='records'::regclass")).rows;expect(rows).toEqual([{action:'c'},{action:'c'}]);});
 it('preserves manual nullable environment only in the exact pre-existing composite relationship',async()=>{expect(plan.changes.some(c=>c.source_table==='manual_controls')).toBe(false);expect((await admin.query("SELECT attnotnull FROM pg_attribute WHERE attrelid='manual_controls'::regclass AND attname='environment'")).rows[0].attnotnull).toBe(false);expect((await admin.query("SELECT convalidated FROM pg_constraint WHERE conrelid='manual_controls'::regclass AND conname='profile_control_parent'")).rows[0].convalidated).toBe(true);});
 it('rejects replay while retaining every installed key and its validation',async()=>{await expect(admin.query(plan.sql)).rejects.toThrow();expect((await admin.query("SELECT count(*)::int n FROM pg_constraint WHERE contype='f' AND conname LIKE 'profile_scope_f_%' AND convalidated")).rows[0].n).toBe(145);});
});
