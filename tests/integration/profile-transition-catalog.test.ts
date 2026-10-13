import {readFile,writeFile} from 'node:fs/promises';
import {isAbsolute,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {readProfileCatalog,type ProfileCatalog} from '../../packages/db/src/profile-inventory.js';
import {commerceProfileRowPolicy} from '../../packages/db/src/commerce-profile-row-policy.js';
import {requireMigratedProfileSchema} from '../support/migrated-database.js';
let admin:pg.Pool,catalog:ProfileCatalog;
const runtimeRoles=['commerce_api','commerce_ingress','commerce_automation','commerce_channel','commerce_maintenance','commerce_ai','commerce_mail_dispatch','commerce_number_lab','commerce_results'];
// V7 F2: the transition sources became the canonical migration chain
// (0069-0100). This suite now pins the migrated catalog instead of a local
// combined transition, including native separation of records by both dimensions.
describe('canonical V7 migrated catalog',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');admin=new pg.Pool({connectionString:url.toString(),max:2});
  await requireMigratedProfileSchema(admin);
  catalog=await readProfileCatalog(admin,runtimeRoles);
 },60000);
 afterAll(async()=>{await admin?.end();});
 it('keeps the 68 historical migration hashes byte-identical under the V7 chain',async()=>{
  const rows=(await admin.query('SELECT name,sha256 FROM schema_migrations ORDER BY name')).rows as {name:string;sha256:string}[];
  expect(rows).toHaveLength(117);
  for(const row of rows){const bytes=await readFile(new URL('../../packages/db/migrations/'+row.name,import.meta.url));expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256);}
  expect(rows.filter(r=>r.name<'0069')).toHaveLength(68);
 });
 it('captures typed metadata for every new tenant subsystem and every validated FK',()=>{
  const tables=new Set(catalog.tables.map(t=>t.name));for(const table of ['profiles','profile_invitations','market_variants','continuous_authorizations','result_goals','ai_attempts','ai_admission_denials','warmup_effect_origins','result_projection_sources','result_metric_daily','result_projection_state','result_financial_context','privacy_closure_receipts','result_rebuild_receipts','commercial_resolution_receipts','privacy_writer_epochs','privacy_writer_leases'])expect(tables.has(table)).toBe(true);
  // Five RF-19 control tables, plus example receipts (0113), retention receipts (0114) and suites (0115).
  expect(catalog.non_public_tables).toHaveLength(9);expect(catalog.non_public_foreign_keys!.length).toBeGreaterThan(0);
  for(const table of ['runs','run_releases','ai_bindings'])expect(catalog.other_relations.some(r=>r.schema==='commerce_number_lab'&&r.name===table)).toBe(true);
  expect(catalog.tables.find(t=>t.name==='ai_attempts')?.columns.some(c=>c.name==='lab_binding_id')).toBe(true);
  expect(catalog.primary_keys!.find(k=>k.schema==='public'&&k.table==='records')?.columns).toEqual(['id']);expect(catalog.primary_keys!.find(k=>k.schema==='commerce_number_lab'&&k.table==='runs')?.columns).toEqual(['workspace_id','id']);
  expect(catalog.foreign_keys.every(f=>f.validated&&Array.isArray(f.columns)&&Array.isArray(f.referenced_columns))).toBe(true);expect(catalog.roles.every(r=>Array.isArray(r.runtime_memberships))).toBe(true);expect(catalog.policies.every(p=>Array.isArray(p.roles))).toBe(true);
  // V7 F8-E: 0109 dropped the 39 retired V5 tables (227 relations through 0108).
  expect(Object.keys(commerceProfileRowPolicy(catalog).tables)).toHaveLength(197);for(const table of ['creative_budgets','intelligence_searches','mcl_sponsorships'])expect(tables.has(table)).toBe(false);
 });
 it('does not fabricate profile adoption, quota allocation, credentials or business grants',async()=>{
  for(const table of ['profiles','ai_credentials','ai_runtime_grants','result_goals','profile_session_context'])expect((await admin.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(0);
 });
 it('installs forced row security and no privileged runtime role',()=>{
  for(const name of ['records','effect_attempts','ai_attempts','memberships'])expect(catalog.tables.find(t=>t.name===name)).toMatchObject({rls:true,force_rls:true});
  expect(catalog.roles.filter(r=>r.name.startsWith('commerce_')).every(r=>!r.superuser&&!r.bypass_rls)).toBe(true);
 });
 it('emits metadata only to an explicit external evidence path when requested',async()=>{
  const path=process.env.PROFILE_TRANSITION_CATALOG_PATH;if(!path)return;
  if(!isAbsolute(path)||!relative(process.cwd(),resolve(path)).startsWith('../'))throw Error('PROFILE_CATALOG_EXTERNAL_PATH_REQUIRED');
  await writeFile(path,JSON.stringify({schema_version:1,state:'LOCAL_MIGRATED_V7_CATALOG',catalog,production_affected:false},null,2)+'\n',{flag:'wx',mode:0o600});
 });
 it('separates nonempty native records by both dimensions for the API role',async()=>{
  const c=await admin.connect();try{
   await c.query('BEGIN');
   await c.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES('scope-combined-a','Synthetic A','UTC',0,0,0),('scope-combined-b','Synthetic B','UTC',0,0,0)");
   for(const [workspace,environment]of [['scope-combined-a','REAL'],['scope-combined-a','SIMULATION'],['scope-combined-b','REAL'],['scope-combined-b','SIMULATION']] as const){await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment',$2,true)",[workspace,environment]);await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,$2,'asset',$3)",[workspace,environment,{name:`Synthetic ${workspace} ${environment}`}]);}
   await c.query("SELECT set_config('app.workspace_id','',true),set_config('app.environment','',true)");
   await c.query('SET LOCAL ROLE commerce_api');
   expect((await c.query('SELECT id FROM records')).rows).toEqual([]);
   for(const [workspace,environment]of [['scope-combined-a','REAL'],['scope-combined-a','SIMULATION'],['scope-combined-b','REAL']] as const){await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment',$2,true)",[workspace,environment]);const rows=(await c.query('SELECT workspace_id,environment FROM records')).rows;expect(rows).toEqual([{workspace_id:workspace,environment}]);expect((await c.query('SELECT id FROM profiles')).rows).toEqual([{id:workspace}]);}
  }finally{await c.query('ROLLBACK');c.release();}
  expect((await admin.query('SELECT count(*)::int n FROM records')).rows[0].n).toBe(0);
 });
 it('keeps the global quota owner intact after the retired creative counters were dropped',async()=>{
  expect((await admin.query("SELECT to_regclass('public.creative_budgets') IS NULL AS table_gone,to_regprocedure('read_profile_global_budget(text)') IS NULL AS reader_gone")).rows).toEqual([{table_gone:true,reader_gone:true}]);
  const c=await admin.connect();try{
   await c.query('BEGIN');
   await c.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES('scope-budget-a','Synthetic A','UTC',10,0,0),('scope-budget-b','Synthetic B','UTC',10,0,0)");
   await c.query('SAVEPOINT exceed_global');await expect(c.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES('scope-budget-c','Synthetic C','UTC',1,0,0)")).rejects.toThrow('PROFILE_QUOTA_ALLOCATION_EXCEEDED');await c.query('ROLLBACK TO SAVEPOINT exceed_global');
  }finally{await c.query('ROLLBACK');c.release();}
 });
});
