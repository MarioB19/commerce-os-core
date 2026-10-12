import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from '../../packages/db/src/profile-context.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {replaceResultProjection,sealResultProjection,finishResultProjectionGeneration,verifyResultProjectionRebuild} from '../../packages/db/src/result-projections.js';
import {previewResultProjectionRebuild,rebuildResultProjection} from '../../packages/db/src/result-projection-rebuild.js';
import {emptyResultCounters} from '../../packages/domain/src/sales/result-projection.js';
const suffix=randomBytes(8).toString('hex'),writerLogin='result_rebuild_'+suffix,apiLogin='result_rebuild_api_'+suffix;
const grain={day:'2026-10-01',currency:'MXN',timezone:'America/Mexico_City',dimensions:{family_id:null,variant_id:null,market:null,account_id:null,campaign_id:null,ad_id:null,touch:'UNKNOWN' as const}};
let admin:pg.Pool,writer:pg.Pool,api:pg.Pool,scoped:ProfilePool,apiScope:ProfilePool;
function tx<T>(w:string,work:(db:ProfileExecutor)=>Promise<T>,pool=scoped,repeatable=true){
 const p:ProfilePool={async connect(){const c=await pool.connect();return{query:(sql,values)=>c.query(sql==='BEGIN'&&repeatable?'BEGIN ISOLATION LEVEL REPEATABLE READ':sql,values),release:c.release.bind(c)};}};
 return withProfileTransaction(p,w,async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");return work(db);});
}
async function seed(empty=false){
 const w='rebuild_'+randomUUID(),sources=[1,2].map(()=>({kind:'COHORT' as const,source_id:randomUUID(),revision:'1',facts:empty?[]:[{grain,counters:{...emptyResultCounters(),started:'1',responded:'1',response_samples:'1',response_ms_sum:'10',revenue_minor:'900719925474099101'},latencies:{response:{'10':'1'},sale:{}}}]}));
 await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic rebuild','UTC',1,5,100)",[w]);
 await tx(w,async db=>{for(const q of sources){const r=await replaceResultProjection(db,q);if(q===sources[0])await sealResultProjection(db,{kind:q.kind,source_id:q.source_id,revision:r.revision,fingerprint:r.fingerprint});}const watermark=(await db.query("SELECT to_char(clock_timestamp()-interval '1 second','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') watermark")).rows[0].watermark;await finishResultProjectionGeneration(db,{watermark,source_count:'2'});});return{w,sources};
}
async function request(w:string){const p=await tx(w,db=>previewResultProjectionRebuild(db));return{operation_id:randomUUID(),expected_generation:p.expected_generation,canonical_sha256:p.canonical_sha256};}
async function raw(w:string){return{state:(await admin.query('SELECT * FROM result_projection_state WHERE workspace_id=$1',[w])).rows,totals:(await admin.query('SELECT * FROM result_metric_daily WHERE workspace_id=$1 ORDER BY grain_hash',[w])).rows,sealed:(await admin.query('SELECT * FROM result_metric_sealed WHERE workspace_id=$1 ORDER BY grain_hash',[w])).rows,sources:(await admin.query('SELECT * FROM result_projection_sources WHERE workspace_id=$1 ORDER BY kind,source_digest',[w])).rows};}
describe('atomic anonymous projection rebuild',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');admin=new pg.Pool({connectionString:url.toString(),max:5});
  const c=await admin.connect();try{await c.query('BEGIN');for(const n of ['001_profile_identity.sql','008_market_variants.sql','017_results_and_goals.sql','022_result_projections.sql','027_result_latency_histograms.sql','026_result_rebuild_receipts.sql'])await c.query(await readFile(new URL('../../packages/db/profile-transition/'+n,import.meta.url),'utf8'));await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  for(const[name,role]of [[writerLogin,'commerce_results'],[apiLogin,'commerce_api']]){const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;GRANT ${role} TO "${name}"`);const native=new URL(url);native.username=name;native.password=secret;const p=new pg.Pool({connectionString:native.toString(),max:4});const port:ProfilePool={async connect(){const c=await p.connect();await c.query(`SET ROLE ${role}`);return{query:c.query.bind(c),release:()=>c.release()};}};if(role==='commerce_results'){writer=p;scoped=port;}else{api=p;apiScope=port;}}
 },60000);
 afterAll(async()=>{await writer?.end();await api?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${writerLogin}","${apiLogin}"`);}finally{await admin.end();}}});
 it('rebuilds exact huge integers from sealed and live anonymous sources without changing their ledger',async()=>{
  const {w}=await seed(),foreign=await seed(),before=await raw(w),other=await raw(foreign.w),q=await request(w);const r=await tx(w,db=>rebuildResultProjection(db,q));expect(r).toMatchObject({status:'REBUILT',generation_before:'1',generation_after:'2',phase:'READY',grain_count:1});const after=await raw(w);expect(after.totals[0].counters.revenue_minor).toBe('1801439850948198202');expect(after.totals[0].latencies).toEqual({response:{'10':'2'},sale:{}});expect(after.sealed).toEqual(before.sealed);expect(after.sources).toEqual(before.sources);expect(after.state[0].source_watermark).toEqual(before.state[0].source_watermark);expect(after.state[0].completed_at).toEqual(before.state[0].completed_at);expect(await raw(foreign.w)).toEqual(other);expect((await tx(w,db=>verifyResultProjectionRebuild(db))).fingerprint).toBe(q.canonical_sha256);
 });
 it('repairs corrupted derived counters but never turns prior PENDING into current coverage',async()=>{
  const {w}=await seed();await admin.query("UPDATE result_metric_daily SET counters=jsonb_set(counters,'{started}','\"900\"') WHERE workspace_id=$1",[w]);expect((await raw(w)).state[0].phase).toBe('PENDING');const q=await request(w);await expect(tx(w,db=>verifyResultProjectionRebuild(db))).rejects.toThrow('RESULT_REBUILD_DIFFERENCE');const r=await tx(w,db=>rebuildResultProjection(db,q));expect(r.phase).toBe('PENDING');expect((await raw(w)).totals[0].counters.started).toBe('2');expect((await tx(w,db=>db.query('SELECT * FROM result_metric_daily'),apiScope)).rows).toEqual([]);
 });
 it('rollback restores the entire prior generation and leaves no operation receipt',async()=>{
  const {w}=await seed(),q=await request(w),before=await raw(w);await expect(tx(w,async db=>{await rebuildResultProjection(db,q);throw Error('ABORT_REBUILD');})).rejects.toThrow('ABORT_REBUILD');expect(await raw(w)).toEqual(before);expect((await admin.query('SELECT operation_id FROM result_rebuild_receipts WHERE workspace_id=$1',[w])).rows).toEqual([]);
 });
 it('same UUID reconciles a lost COMMIT response without rebuilding twice',async()=>{
  const {w}=await seed(),q=await request(w),a=await tx(w,db=>rebuildResultProjection(db,q)),before=await raw(w),b=await tx(w,db=>rebuildResultProjection(db,q));expect(b).toEqual({...a,status:'NO_EFFECT'});expect(await raw(w)).toEqual(before);expect((await admin.query('SELECT operation_id FROM result_rebuild_receipts WHERE workspace_id=$1',[w])).rows).toHaveLength(1);
 });
 it('a reused operation UUID with altered source hash is rejected',async()=>{
  const {w}=await seed(),q=await request(w);await tx(w,db=>rebuildResultProjection(db,q));await expect(tx(w,db=>rebuildResultProjection(db,{...q,canonical_sha256:'a'.repeat(64)}))).rejects.toThrow('RESULT_REBUILD_OPERATION_CONFLICT');
 });
 it('source changes after preview reject before deleting any derived data',async()=>{
  const {w,sources}=await seed(),q=await request(w);await tx(w,db=>replaceResultProjection(db,{...sources[1],revision:'2',facts:[]}));const before=await raw(w);await expect(tx(w,db=>rebuildResultProjection(db,q))).rejects.toThrow('RESULT_REBUILD_SOURCE_CHANGED');expect(await raw(w)).toEqual(before);
 });
 it('a different completed operation invalidates the prior generation preview',async()=>{
  const {w}=await seed(),q=await request(w);await tx(w,db=>rebuildResultProjection(db,q));const before=await raw(w);await expect(tx(w,db=>rebuildResultProjection(db,{...q,operation_id:randomUUID()}))).rejects.toThrow('RESULT_REBUILD_GENERATION_CHANGED');expect(await raw(w)).toEqual(before);
 });
 it('ordinary API, wrong environment, substituted profile and READ COMMITTED cannot rebuild',async()=>{
  const {w}=await seed(),q=await request(w);await expect(tx(w,db=>rebuildResultProjection(db,q),apiScope)).rejects.toThrow('RESULT_REBUILD_CONTEXT_REQUIRED');await expect(tx(w,db=>rebuildResultProjection(db,q),scoped,false)).rejects.toThrow('RESULT_REBUILD_CONTEXT_REQUIRED');await expect(tx(w,db=>rebuildResultProjection({...db,workspaceId:'foreign'},q))).rejects.toThrow('RESULT_REBUILD_CONTEXT_REQUIRED');await expect(tx(w,async db=>{await db.query("SELECT set_config('app.environment','SIMULATION',true)");return rebuildResultProjection(db,q);})).rejects.toThrow('RESULT_REBUILD_CONTEXT_REQUIRED');
  await expect(tx(w,db=>db.query('SELECT * FROM result_rebuild_receipts'),apiScope)).rejects.toThrow('permission denied');
 });
 it('concurrent readers see an entire old generation until the atomic new generation commits',async()=>{
  const {w}=await seed(),q=await request(w);const read=()=>tx(w,db=>db.query("SELECT s.generation::text,d.counters FROM result_projection_state s JOIN result_metric_daily d USING(workspace_id,environment) WHERE s.workspace_id=$1",[w]),apiScope);const before=(await read()).rows;
  await tx(w,async db=>{await rebuildResultProjection(db,q);expect((await read()).rows).toEqual(before);});const after=(await read()).rows;expect(after[0].generation).toBe('2');expect(after[0].counters).toEqual(before[0].counters);
 });
 it('an empty canonical generation rebuilds without fabricating a zero cohort or changing coverage',async()=>{
  const {w}=await seed(true),q=await request(w),r=await tx(w,db=>rebuildResultProjection(db,q));expect(r.grain_count).toBe(0);expect(r.phase).toBe('READY');expect((await raw(w)).totals).toEqual([]);
 });
 it('concurrent identical requests leave one receipt and retry reconciles any serialization abort',async()=>{
  const {w}=await seed(),q=await request(w),attempts=await Promise.allSettled([1,2].map(()=>tx(w,db=>rebuildResultProjection(db,q))));expect(attempts.filter(a=>a.status==='fulfilled').length).toBeGreaterThan(0);for(const a of attempts)if(a.status==='rejected')expect(a.reason.code).toBe('40001');const final=await tx(w,db=>rebuildResultProjection(db,q));expect(final.status).toBe('NO_EFFECT');expect((await raw(w)).state[0].generation).toBe('2');expect((await admin.query('SELECT operation_id FROM result_rebuild_receipts WHERE workspace_id=$1',[w])).rows).toHaveLength(1);
 });
});
