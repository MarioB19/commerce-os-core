import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from '../../packages/db/src/profile-context.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {replaceResultProjection,sealResultProjection,finishResultProjectionGeneration,verifyResultProjectionRebuild,resultSourceDigest,readResultProjectionGeneration} from '../../packages/db/src/result-projections.js';
import {readProjectedResultRange} from '../../packages/db/src/result-projection-reader.js';
import {summarizeResults} from '../../packages/domain/src/sales/results.js';
import {resultFiltersSchema} from '../../packages/contracts/src/results.js';
import {emptyResultCounters} from '../../packages/domain/src/sales/result-projection.js';
const suffix=randomBytes(8).toString('hex'),workspace='result_projection_'+suffix,foreign=workspace+'_foreign';
const grain={day:'2026-10-01',currency:'MXN',timezone:'America/Mexico_City',dimensions:{family_id:null,variant_id:null,market:null,account_id:null,campaign_id:null,ad_id:null,touch:'UNKNOWN' as const}};
const fact=(patch:Partial<ReturnType<typeof emptyResultCounters>>={},g=grain)=>({grain:g,counters:{...emptyResultCounters(),...patch}});
const source=()=>({kind:'COHORT' as const,source_id:randomUUID(),revision:'1',facts:[fact({started:'1',responded:'1'})]});
let admin:pg.Pool,writer:pg.Pool,api:pg.Pool,scoped:ProfilePool,apiScoped:ProfilePool;
const writerLogin='result_writer_'+suffix,apiLogin='result_reader_'+suffix;
function tx<T>(work:(db:ProfileExecutor)=>Promise<T>,scope=workspace){return withProfileTransaction(scoped,scope,async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");return work(db);});}
function read<T>(work:(db:ProfileExecutor)=>Promise<T>){return withProfileTransaction(apiScoped,workspace,async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");return work(db);});}
async function login(url:URL,name:string,role:string){const password=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT ${role} TO "${name}"`);const native=new URL(url);native.username=name;native.password=password;const pool=new pg.Pool({connectionString:native.toString(),max:5,connectionTimeoutMillis:5000});return{pool,scoped:{async connect(){const c=await pool.connect();try{await c.query(`SET ROLE ${role}`);return{query:c.query.bind(c),release:()=>c.release()};}catch(e){c.release();throw e;}}}};}
describe('durable anonymous projections / PostgreSQL dedicated role',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:5000});
  if((await admin.query("SELECT to_regclass('public.profiles') present")).rows[0].present)throw Error('TRANSITION_SCHEMA_ALREADY_PRESENT');
  const c=await admin.connect();try{await c.query('BEGIN');for(const name of ['001_profile_identity.sql','008_market_variants.sql','017_results_and_goals.sql','022_result_projections.sql','027_result_latency_histograms.sql'])await c.query(await readFile(new URL('../../packages/db/profile-transition/'+name,import.meta.url),'utf8'));await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic projection','America/Mexico_City',1,5,100),($2,'Foreign projection','UTC',1,5,100)",[workspace,foreign]);
  const w=await login(url,writerLogin,'commerce_results'),a=await login(url,apiLogin,'commerce_api');writer=w.pool;scoped=w.scoped;api=a.pool;apiScoped=a.scoped;
 },60000);
 afterAll(async()=>{await writer?.end();await api?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${writerLogin}","${apiLogin}"`);}finally{await admin.end();}}});
 it('persists exact integer deltas and rolls source/totals back together',async()=>{
  const q=source();q.facts=[fact({started:'1',revenue_minor:'900719925474099101'})];await tx(db=>replaceResultProjection(db,q));
  const total=async()=>(await admin.query('SELECT counters FROM result_metric_daily WHERE workspace_id=$1',[workspace])).rows[0].counters.revenue_minor;
  expect(await total()).toBe('900719925474099101');
  await expect(tx(async db=>{await replaceResultProjection(db,{...q,revision:'2',facts:[fact({started:'1',revenue_minor:'1'})]});throw Error('FAIL_BEFORE_COMMIT');})).rejects.toThrow('FAIL_BEFORE_COMMIT');expect(await total()).toBe('900719925474099101');
  await tx(db=>replaceResultProjection(db,{...q,revision:'2',facts:[fact({started:'1',revenue_minor:'17'})]}));expect(await total()).toBe('17');
 });
 it('ambiguous response is reconciled by the same revision without doubling',async()=>{
  const q=source(),a=await tx(db=>replaceResultProjection(db,q)),b=await tx(db=>replaceResultProjection(db,q));expect(a.status).toBe('APPLIED');expect(b).toEqual({...a,status:'NO_EFFECT'});
  await expect(tx(db=>replaceResultProjection(db,{...q,facts:[]}))).rejects.toThrow('RESULT_SOURCE_CONFLICT');
  await tx(db=>replaceResultProjection(db,{...q,revision:'2',facts:[]}));await expect(tx(db=>replaceResultProjection(db,q))).rejects.toThrow('RESULT_SOURCE_STALE');
 });
 it('serializes concurrent identical and conflicting source revisions',async()=>{
  const q=source(),a=await Promise.all([1,2].map(()=>tx(db=>replaceResultProjection(db,q))));expect(a.map(x=>x.status).sort()).toEqual(['APPLIED','NO_EFFECT']);
  const b=await Promise.allSettled([1,2].map(i=>tx(db=>replaceResultProjection(db,{...q,revision:'2',facts:[fact({started:String(i)})]}))));expect(b.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(b.filter(x=>x.status==='rejected')).toHaveLength(1);
 });
 it('seals without changing totals and drops per-source fact linkage',async()=>{
  const q=source(),receipt=await tx(db=>replaceResultProjection(db,q));const before=await tx(db=>verifyResultProjectionRebuild(db));
  expect(await tx(db=>sealResultProjection(db,{revision:receipt.revision,fingerprint:receipt.fingerprint,kind:q.kind,source_id:q.source_id}))).toEqual({status:'SEALED'});
  const row=(await admin.query('SELECT * FROM result_projection_sources WHERE workspace_id=$1 AND source_digest=$2',[workspace,resultSourceDigest(workspace,q.kind,q.source_id)])).rows[0];expect(row.facts).toBeNull();expect(row.sealed_at).toBeTruthy();expect(JSON.stringify(row)).not.toContain(q.source_id);
  expect(await tx(db=>verifyResultProjectionRebuild(db))).toEqual(before);expect((await tx(db=>replaceResultProjection(db,q))).status).toBe('NO_EFFECT');
  await expect(tx(db=>replaceResultProjection(db,{...q,revision:'2',facts:[]}))).rejects.toThrow('RESULT_SOURCE_SEALED');
 });
 it('does not seal a changed source and preserves data after a sealing rollback',async()=>{
  const q=source(),r=await tx(db=>replaceResultProjection(db,q)),seal={kind:q.kind,source_id:q.source_id,revision:r.revision,fingerprint:r.fingerprint};
  await expect(tx(db=>sealResultProjection(db,{...seal,revision:'2'}))).rejects.toThrow('RESULT_SEAL_SOURCE_CHANGED');
  await expect(tx(async db=>{await sealResultProjection(db,seal);throw Error('PURGE_FAILED');})).rejects.toThrow('PURGE_FAILED');
  expect((await admin.query('SELECT sealed_at,facts FROM result_projection_sources WHERE workspace_id=$1 AND source_digest=$2',[workspace,resultSourceDigest(workspace,q.kind,q.source_id)])).rows[0]).toMatchObject({sealed_at:null,facts:q.facts});
 });
 it('financial revisions remain reversible after a cohort seal',async()=>{
  const q=source(),r=await tx(db=>replaceResultProjection(db,q));await tx(db=>sealResultProjection(db,{kind:q.kind,source_id:q.source_id,revision:r.revision,fingerprint:r.fingerprint}));
  const p={...source(),kind:'FINANCIAL',facts:[fact({payment_approved:'1',revenue_minor:'800',sales:'1'})]};await tx(db=>replaceResultProjection(db,p));const before=await tx(db=>verifyResultProjectionRebuild(db));
  await tx(db=>replaceResultProjection(db,{...p,revision:'2',facts:[]}));expect((await tx(db=>verifyResultProjectionRebuild(db))).fingerprint).not.toBe(before.fingerprint);
 });
 it('enforces profile scope in SQL and prevents API access to source digests',async()=>{
  const q=source();await tx(db=>replaceResultProjection(db,q),foreign);
  expect((await tx(db=>db.query('SELECT * FROM result_projection_sources WHERE workspace_id=$1',[foreign]))).rows).toEqual([]);
  await expect(tx(db=>replaceResultProjection({...db,workspaceId:foreign},source()))).rejects.toThrow('RESULT_WRITER_CONTEXT_REQUIRED');
  await expect(withProfileTransaction(apiScoped,workspace,db=>replaceResultProjection(db,source()))).rejects.toThrow('RESULT_WRITER_CONTEXT_REQUIRED');
  await expect(withProfileTransaction(apiScoped,workspace,db=>db.query('SELECT * FROM result_projection_sources'))).rejects.toThrow('permission denied');
  await expect(withProfileTransaction(apiScoped,workspace,db=>db.query('DELETE FROM result_metric_daily'))).rejects.toThrow('permission denied');
  expect((await withProfileTransaction(apiScoped,workspace,db=>db.query('SELECT * FROM result_metric_daily'))).rows.every(r=>r.workspace_id===workspace)).toBe(true);
 });
 it('dedicated role has no commercial/credential read or mutation privilege',async()=>{
  for(const table of ['records','outbox','profiles','market_journey_snapshots'])await expect(tx(db=>db.query(`SELECT * FROM ${table} LIMIT 1`))).rejects.toThrow('permission denied');
  const role=(await admin.query("SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname='commerce_results'")).rows[0];expect(Object.values(role).every(v=>v===false)).toBe(true);
 });
 it('rejects PII/extra JSON and malformed counters at SQL boundary',async()=>{
  for(const patch of [{grain:{...grain,phone:'synthetic'}},{grain:{...grain,dimensions:{...grain.dimensions,contact_id:randomUUID()}}},{counters:{...emptyResultCounters(),text:'synthetic'}},{counters:{...emptyResultCounters(),started:'-1'}}]){
   const f={...fact(),...patch};await expect(tx(db=>db.query('INSERT INTO result_metric_daily(workspace_id,grain_hash,grain,counters) VALUES($1,$2,$3,$4)',[workspace,randomBytes(32).toString('hex'),f.grain,f.counters]))).rejects.toThrow('check constraint');
  }
  await expect(tx(db=>db.query("INSERT INTO result_projection_sources(workspace_id,environment,kind,source_digest,revision,fingerprint,facts) VALUES($1,'SIMULATION','COHORT',$2,1,$2,'[]')",[workspace,'a'.repeat(64)]))).rejects.toThrow();
 });
 it('verifies full rebuild from sealed plus live without duplicate replay',async()=>{const a=await tx(db=>verifyResultProjectionRebuild(db)),b=await tx(db=>verifyResultProjectionRebuild(db));expect(a).toEqual(b);expect(a.status).toBe('VERIFIED');});
 it('generation watermark is monotonic and cannot claim future coverage',async()=>{
  const watermark=(await admin.query("SELECT to_char(clock_timestamp()-interval '2 second','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') watermark")).rows[0].watermark;
  const a=await tx(db=>finishResultProjectionGeneration(db,{watermark,source_count:'10'}));expect(BigInt(a.generation)).toBeGreaterThan(0n);
  await expect(tx(db=>finishResultProjectionGeneration(db,{watermark,source_count:'10'}))).rejects.toThrow('RESULT_WATERMARK_STALE_OR_FUTURE');
  await expect(tx(db=>finishResultProjectionGeneration(db,{watermark:'2099-01-01T00:00:00Z',source_count:'10'}))).rejects.toThrow('RESULT_WATERMARK_STALE_OR_FUTURE');
 });
 it('missing or SIMULATION environment cannot access or mutate REAL projections',async()=>{
  for(const environment of ['', 'SIMULATION']){
   await expect(tx(async db=>{await db.query("SELECT set_config('app.environment',$1,true)",[environment]);return replaceResultProjection(db,source());})).rejects.toThrow('RESULT_WRITER_CONTEXT_REQUIRED');
   expect((await tx(async db=>{await db.query("SELECT set_config('app.environment',$1,true)",[environment]);return db.query('SELECT * FROM result_metric_daily');})).rows).toEqual([]);
   await expect(tx(async db=>{await db.query("SELECT set_config('app.environment',$1,true)",[environment]);return db.query('INSERT INTO result_metric_daily(workspace_id,grain_hash,grain,counters) VALUES($1,$2,$3,$4)',[workspace,'b'.repeat(64),grain,emptyResultCounters()]);})).rejects.toThrow('row-level security');
  }
 });
 it('a committed partial batch invalidates prior coverage and hides totals until finish',async()=>{
  const previous=await read(db=>readResultProjectionGeneration(db));expect(previous.phase).toBe('READY');
  expect((await read(db=>db.query('SELECT * FROM result_metric_daily'))).rows.length).toBeGreaterThan(0);
  const q=source();await tx(db=>replaceResultProjection(db,q));
  await expect(read(db=>readResultProjectionGeneration(db))).rejects.toThrow('RESULT_PROJECTION_NOT_READY');
  expect((await read(db=>db.query('SELECT * FROM result_metric_daily'))).rows).toEqual([]);
  await tx(async db=>{const watermark=(await db.query("SELECT to_char(clock_timestamp(),'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') watermark")).rows[0].watermark;return finishResultProjectionGeneration(db,{watermark,source_count:'11'});});
  const complete=await read(db=>readResultProjectionGeneration(db));expect(BigInt(complete.generation)).toBe(BigInt(previous.generation)+1n);
  await expect(tx(async db=>{await replaceResultProjection(db,source());throw Error('ROLLBACK_PARTIAL');})).rejects.toThrow('ROLLBACK_PARTIAL');
  expect(await read(db=>readResultProjectionGeneration(db))).toEqual(complete);
  // Direct SQL mutations by the internal role cannot bypass the pending marker.
  await tx(db=>db.query('UPDATE result_metric_daily SET counters=counters WHERE workspace_id=$1',[workspace]));
  await expect(read(db=>readResultProjectionGeneration(db))).rejects.toThrow('RESULT_PROJECTION_NOT_READY');
 });
 it('corrects an equal-count/equal-sum distribution and carries exact percentiles through API daily aggregation',async()=>{
  const g={...grain,day:'2026-09-29'},q={...source(),facts:[{grain:g,counters:{...emptyResultCounters(),started:'2',responded:'2',response_samples:'2',response_ms_sum:'40'},latencies:{response:{'10':'1','30':'1'},sale:{}}}]};
  await tx(db=>replaceResultProjection(db,q));const old=await tx(db=>verifyResultProjectionRebuild(db));
  await tx(async db=>{await replaceResultProjection(db,{...q,revision:'2',facts:[{...q.facts[0],latencies:{response:{'20':'2'},sale:{}}}]});const watermark=(await db.query("SELECT to_char(clock_timestamp(),'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') watermark")).rows[0].watermark;await finishResultProjectionGeneration(db,{watermark,source_count:'50'});});
  const next=await tx(db=>verifyResultProjectionRebuild(db));expect(next.fingerprint).not.toBe(old.fingerprint);
  const filters=resultFiltersSchema.parse({from:g.day,to:g.day,currency:'MXN'}),range=await read(db=>readProjectedResultRange(db,filters)),report=summarizeResults(range.facts,[],filters);expect(report.latency_percentiles.response).toEqual({p50:{value:'20',reason:null},p95:{value:'20',reason:null}});
 });
 it('seals anonymous frequencies and preserves them after dropping per-source linkage',async()=>{
  const g={...grain,day:'2026-09-28'},q={...source(),facts:[{grain:g,counters:{...emptyResultCounters(),started:'1',responded:'1',response_samples:'1',response_ms_sum:'0'},latencies:{response:{'0':'1'},sale:{}}}]};
  const receipt=await tx(db=>replaceResultProjection(db,q)),before=await tx(db=>verifyResultProjectionRebuild(db));await tx(db=>sealResultProjection(db,{kind:q.kind,source_id:q.source_id,revision:receipt.revision,fingerprint:receipt.fingerprint}));
  expect(await tx(db=>verifyResultProjectionRebuild(db))).toEqual(before);const row=(await admin.query("SELECT latencies FROM result_metric_sealed WHERE workspace_id=$1 AND grain->>'day'=$2",[workspace,g.day])).rows[0];expect(row.latencies).toEqual(q.facts[0]!.latencies);
  expect((await admin.query('SELECT facts FROM result_projection_sources WHERE workspace_id=$1 AND source_digest=$2',[workspace,resultSourceDigest(workspace,q.kind,q.source_id)])).rows[0].facts).toBeNull();
 });
 it('rolls back histogram-only corrections along with their revision',async()=>{
  const g={...grain,day:'2026-09-27'},q={...source(),facts:[{grain:g,counters:{...emptyResultCounters(),started:'2',responded:'2',response_samples:'2',response_ms_sum:'40'},latencies:{response:{'10':'1','30':'1'},sale:{}}}]};await tx(db=>replaceResultProjection(db,q));const before=await tx(db=>verifyResultProjectionRebuild(db));
  await expect(tx(async db=>{await replaceResultProjection(db,{...q,revision:'2',facts:[{...q.facts[0],latencies:{response:{'20':'2'},sale:{}}}]});throw Error('LOST_BEFORE_COMMIT');})).rejects.toThrow('LOST_BEFORE_COMMIT');expect(await tx(db=>verifyResultProjectionRebuild(db))).toEqual(before);expect((await tx(db=>replaceResultProjection(db,q))).status).toBe('NO_EFFECT');
 });
 it('SQL rejects PII, fractional/negative weights and moments inconsistent with counters',async()=>{
  for(const latencies of [{response:{phone:'1'},sale:{}},{response:{'1':'1.5'},sale:{}},{response:{'1':'-1'},sale:{}},{response:{'1':'1'},sale:{},contact_id:'synthetic'},{response:{'30':'1'},sale:{}},{response:{'10':'2'},sale:{}}])await expect(tx(db=>db.query('INSERT INTO result_metric_daily(workspace_id,grain_hash,grain,counters,latencies) VALUES($1,$2,$3,$4,$5)',[workspace,randomBytes(32).toString('hex'),grain,{...emptyResultCounters(),response_samples:'1',response_ms_sum:'20'},latencies]))).rejects.toThrow('check constraint');
 });
 it('historical samples without frequencies return incomplete rather than a fabricated median',async()=>{
  const g={...grain,day:'2026-09-26'},q={...source(),facts:[{grain:g,counters:{...emptyResultCounters(),started:'1',responded:'1',response_samples:'1',response_ms_sum:'100'}}]};await tx(async db=>{await replaceResultProjection(db,q);const watermark=(await db.query("SELECT to_char(clock_timestamp(),'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') watermark")).rows[0].watermark;await finishResultProjectionGeneration(db,{watermark,source_count:'51'});});
  const filters=resultFiltersSchema.parse({from:g.day,to:g.day,currency:'MXN'}),range=await read(db=>readProjectedResultRange(db,filters)),report=summarizeResults(range.facts,[],filters);expect(report.first_response_ms.value).toBe('100.000000');expect(report.latency_percentiles.response.p50).toEqual({value:null,reason:'LATENCY_COVERAGE_INCOMPLETE'});
 });
 it('goal event/receipt tables are explicitly REAL and reject cross-environment writes',async()=>{
  const columns=(await admin.query("SELECT table_name,column_default,is_nullable FROM information_schema.columns WHERE table_name IN('result_goal_events','result_goal_operations') AND column_name='environment' ORDER BY table_name")).rows;expect(columns).toHaveLength(2);expect(columns.every(r=>r.is_nullable==='NO'&&r.column_default.includes('REAL'))).toBe(true);
  await expect(withProfileTransaction(apiScoped,workspace,db=>db.query("INSERT INTO result_goal_operations(workspace_id,environment,actor_id,operation_id,request_hash,result) VALUES($1,'SIMULATION','synthetic',$2,$3,'{}')",[workspace,randomUUID(),'a'.repeat(64)]))).rejects.toThrow('check constraint');
 });
});
