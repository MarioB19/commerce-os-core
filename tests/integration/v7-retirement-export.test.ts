import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import type pg from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {migrate,migrationFiles} from '../../packages/db/src/migrate.js';
import {decrypt,hash} from '../../packages/db/src/index.js';
import {exportRetiredTables,retirementStatus,verifyRetirementExport,V7_RETIRED_TABLES} from '../../packages/db/src/retirement-export.js';
import {fixtureProfileRow,migrationSql,openMigratedDatabase,withMigratedDatabase} from '../support/migrated-database.js';

// V7 F8-E: 0109 drops the retired V5 tables only after a verified encrypted
// export of exactly the rows they hold; the export stays readable afterwards.
let db:Awaited<ReturnType<typeof openMigratedDatabase>>,root:string;
const workspace='retire-export-a',search=randomUUID();
async function withClient<T>(work:(c:pg.PoolClient)=>Promise<T>){const c=await db.pool.connect();try{return await work(c);}finally{c.release();}}
const tableExists=async(name:string)=>(await db.pool.query('SELECT to_regclass($1) IS NOT NULL AS ok',['public.'+name])).rows[0].ok as boolean;
const applied=async()=>(await db.pool.query("SELECT count(*)::int n FROM schema_migrations WHERE name='0109_v7_retire_modules.sql'")).rows[0].n as number;

describe('V7 retirement export and migration 0109',()=>{
 beforeAll(async()=>{
  vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));
  root=await mkdtemp(join(tmpdir(),'v7-retirement-'));
  db=await openMigratedDatabase('0108');
  await fixtureProfileRow(db.pool,[],workspace);
  await db.pool.query("INSERT INTO creative_settings(workspace_id,environment,provider,enabled,config) VALUES($1,'REAL','searchapi',true,'{\"engine\":\"synthetic\"}')",[workspace]);
  await db.pool.query("INSERT INTO intelligence_searches(id,workspace_id,environment,name,query,fingerprint,created_by) VALUES($1,$2,'REAL','Synthetic search','{\"q\":\"synthetic\"}','fp-synthetic','fixture')",[search,workspace]);
 },120000);
 afterAll(async()=>{await db?.close();if(root)await rm(root,{recursive:true,force:true});vi.unstubAllEnvs();});

 it('lists every retired table with its rows and no receipt yet, without changing anything',async()=>{
  const status=await withClient(c=>retirementStatus(c));
  expect(status.map(s=>s.table)).toEqual([...V7_RETIRED_TABLES]);
  expect(status.filter(s=>s.rows>0)).toEqual([{table:'intelligence_searches',rows:1,receipt:false},{table:'creative_settings',rows:1,receipt:false}]);
  expect((await db.pool.query("SELECT count(*)::int n FROM platform_retirement_ledger WHERE kind='V7_RETIREMENT_EXPORT'")).rows[0].n).toBe(0);
 });

 it('runs as an operator CLI that prints counts and identifiers only, never row data',async()=>{
  const run=(...args:string[])=>spawnSync(process.execPath,['--import','tsx','scripts/v7-retirement-export.ts',...args],{env:{...process.env,DATABASE_URL:db.url.toString()},encoding:'utf8',timeout:60000});
  const status=run('status');expect(status.status).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({with_rows:2,missing_receipts:['intelligence_searches','creative_settings']});
  expect(status.stdout).not.toMatch(/Synthetic|synthetic|retire-export-a/);
  const inside=run('export',join(process.cwd(),'retirement-export-inside'));expect(inside.status).toBe(1);expect(inside.stderr.trim()).toBe('RETIREMENT_DIRECTORY_INSIDE_REPOSITORY');
  const missing=run('verify',join(root,'absent'));expect(missing.status).toBe(1);expect(missing.stderr.trim()).toBe('RETIREMENT_MANIFEST_UNREADABLE');
  expect(run('export','relative/path').status).toBe(2);
 },120000);

 it('refuses to drop tables with rows that have no verified export',async()=>{
  await expect(migrate({pool:db.pool,log:()=>undefined})).rejects.toThrow('RETIREMENT_EXPORT_REQUIRED:intelligence_searches');
  expect(await applied()).toBe(0);expect(await tableExists('creative_settings')).toBe(true);
 });

 it('refuses a role that row security could blind, for the plan, the export and the migration',async()=>{
  await withClient(async c=>{
   await c.query('SET ROLE commerce_api');
   try{
    await expect(retirementStatus(c)).rejects.toThrow('RETIREMENT_OWNER_BYPASS_REQUIRED');
    await expect(exportRetiredTables(c,join(root,'blind'))).rejects.toThrow('RETIREMENT_OWNER_BYPASS_REQUIRED');
   }finally{await c.query('RESET ROLE');}
   await c.query('BEGIN');
   try{await c.query('SET LOCAL ROLE commerce_api');await expect(c.query(await migrationSql('0109'))).rejects.toThrow('RETIREMENT_OWNER_BYPASS_REQUIRED');}
   finally{await c.query('ROLLBACK');}
  });
 });

 it('rejects a changed source after export, then drops only what a fresh verified export covers',async()=>{
  const first=join(root,'first');
  const manifest=await withClient(c=>exportRetiredTables(c,first));
  expect(manifest.tables).toHaveLength(39);
  expect(manifest.lastMigration.startsWith('0108_')).toBe(true);
  expect((await withClient(c=>retirementStatus(c))).every(s=>s.receipt||s.rows===0)).toBe(true);
  // A row changed after the export no longer matches its receipt.
  await db.pool.query("UPDATE creative_settings SET enabled=false WHERE workspace_id=$1",[workspace]);
  await expect(migrate({pool:db.pool,log:()=>undefined})).rejects.toThrow('RETIREMENT_EXPORT_REQUIRED:creative_settings');
  expect(await applied()).toBe(0);
  const second=join(root,'second');
  const fresh=await withClient(c=>exportRetiredTables(c,second));
  await migrate({pool:db.pool,log:()=>undefined});
  expect(await applied()).toBe(1);
  for(const table of V7_RETIRED_TABLES)expect(await tableExists(table)).toBe(false);
  for(const fn of ['creative_immutable_row()','v5_block_new_sponsorship()','v5_block_remote_production()','read_profile_global_budget(text)'])
   expect((await db.pool.query('SELECT to_regprocedure($1) IS NULL AS gone',[fn])).rows[0].gone).toBe(true);
  // The receipts of both exports stay; the export reads back without the database.
  const receipts=(await db.pool.query("SELECT resource_id,snapshot FROM platform_retirement_ledger WHERE workspace_id='@v7-retirement' AND kind='V7_RETIREMENT_EXPORT' ORDER BY id")).rows;
  expect(receipts).toHaveLength(78);
  expect(receipts.filter(r=>r.snapshot.export_id===fresh.exportId&&r.snapshot.row_count>0).map(r=>r.snapshot.table).sort()).toEqual(['creative_settings','intelligence_searches']);
  const verified=await verifyRetirementExport(second);
  expect(verified.exportId).toBe(fresh.exportId);
  const lines=(await readFile(join(second,'creative_settings.jsonl.enc'),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(decrypt(line)));
  expect(lines).toEqual([expect.objectContaining({workspace_id:workspace,provider:'searchapi',enabled:false,config:{engine:'synthetic'}})]);
  expect(JSON.parse(decrypt((await readFile(join(second,'intelligence_searches.jsonl.enc'),'utf8')).trim()))).toMatchObject({id:search,name:'Synthetic search'});
  expect(await migrationFiles()).toContain('0109_v7_retire_modules.sql');
 });

 it('detects a tampered, missing or foreign-key export file',async()=>{
  const source=join(root,'second'),tampered=join(root,'tampered');
  await cp(source,tampered,{recursive:true});
  const file=join(tampered,'creative_settings.jsonl.enc'),text=await readFile(file,'utf8');
  await writeFile(file,text.slice(0,-3)+(text.at(-3)==='A'?'B':'A')+text.slice(-2));
  await expect(verifyRetirementExport(tampered)).rejects.toThrow('RETIREMENT_FILE_DIGEST_MISMATCH:creative_settings');
  await rm(file);
  await expect(verifyRetirementExport(tampered)).rejects.toThrow('RETIREMENT_FILE_MISSING:creative_settings');
  vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));
  await expect(verifyRetirementExport(source)).rejects.toThrow('RETIREMENT_EXPORT_KEY_MISMATCH');
 });
});

describe('V7 retirement export on the V5 schema before the one-transaction V7 publication',()=>{
 it('exports at 68 migrations, keeps the receipt valid across derived columns added by 0083 and drops in the same transaction',async()=>{
  vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));
  const directory=await mkdtemp(join(tmpdir(),'v7-retirement-v5-'));
  try{await withMigratedDatabase('0068',async pool=>{
   const project=randomUUID(),brief=randomUUID(),version=randomUUID(),w='retire-v5-a';
   await pool.query("INSERT INTO creative_projects(id,workspace_id,environment,title,product_id,created_by) VALUES($1,$2,'REAL','Synthetic V5 project',$3,'fixture')",[project,w,randomUUID()]);
   await pool.query("INSERT INTO creative_voice_briefs(id,workspace_id,environment,project_id,title,created_by) VALUES($1,$2,'REAL',$3,'Synthetic brief','fixture')",[brief,w,project]);
   await pool.query("INSERT INTO creative_voice_brief_versions(id,brief_id,version,body,sha256,created_by) VALUES($1,$2,1,'{\"script\":\"synthetic <&> text\"}',repeat('b',64),'fixture')",[version,brief]);
   const c=await pool.connect();
   try{
    const manifest=await exportRetiredTables(c,directory);
    expect(manifest.lastMigration.startsWith('0068_')).toBe(true);
    expect(manifest.tables.find(t=>t.table==='creative_voice_brief_versions')).toMatchObject({rowCount:1,columns:['body','brief_id','created_at','created_by','id','sha256','version']});
    // The V7 publication applies 0069-0109 as one transaction (copy-runtime bounded migration).
    const names=(await migrationFiles()).filter(name=>name.slice(0,4)>'0068');
    await c.query('BEGIN');
    try{for(const name of names){const sql=await migrationSql(name.slice(0,4));await c.query(sql);await c.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[name,hash(sql)]);}await c.query('COMMIT');}
    catch(error){await c.query('ROLLBACK');throw error;}
   }finally{c.release();}
   expect((await pool.query("SELECT max(name) m,count(*)::int n FROM schema_migrations")).rows[0]).toEqual({m:'0113_v7_number_lab_attachments.sql',n:113});
   expect((await pool.query("SELECT to_regclass('public.creative_voice_brief_versions') IS NULL gone")).rows[0].gone).toBe(true);
   const rows=(await readFile(join(directory,'creative_voice_brief_versions.jsonl.enc'),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(decrypt(line)));
   expect(rows).toEqual([expect.objectContaining({id:version,brief_id:brief,body:{script:'synthetic <&> text'}})]);
  });}finally{await rm(directory,{recursive:true,force:true});vi.unstubAllEnvs();}
 },240000);
 it('aborts the whole one-transaction publication when a V5 table holds rows without an export',async()=>{
  await withMigratedDatabase('0068',async pool=>{
   await pool.query("INSERT INTO intelligence_searches(id,workspace_id,environment,name,query,fingerprint,created_by) VALUES($1,'retire-v5-b','REAL','Synthetic','{}','fp','fixture')",[randomUUID()]);
   const c=await pool.connect();
   try{
    await c.query('BEGIN');
    await expect((async()=>{for(const name of (await migrationFiles()).filter(n=>n.slice(0,4)>'0068'))await c.query(await migrationSql(name.slice(0,4)));})()).rejects.toThrow('RETIREMENT_EXPORT_REQUIRED:intelligence_searches');
    await c.query('ROLLBACK');
   }finally{c.release();}
   expect((await pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n).toBe(68);
   expect((await pool.query("SELECT to_regclass('public.profiles') IS NULL v7_absent")).rows[0].v7_absent).toBe(true);
  });
 },240000);
});
