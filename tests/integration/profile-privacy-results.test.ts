import {PostgresAiPorts,storeAiCredential} from '../../packages/ai-providers/src/persistence.js';
import {configureAiGrant,configureAiBudget} from '../../packages/ai-providers/src/configuration.js';
import {credentialVerificationIdentity} from '../../packages/ai-providers/src/verification.js';
import {quote} from '../../packages/ai-providers/src/catalog.js';
import type {Model,Scope,RequestIdentity} from '../../packages/ai-providers/src/contracts.js';
import type {ProfileAuthority} from '../../packages/domain/src/core/profile-authorization.js';
import type {ProfileExecutor} from '../../packages/db/src/profile-context.js';
import {readFile,readdir} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {requireMigratedProfileSchema} from '../support/migrated-database.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {readProfileCatalog} from '../../packages/db/src/profile-inventory.js';
import {buildPrivacyInventoryPlan,privacyInventoryPolicy,type PrivacyInventoryCatalog} from '../../packages/db/src/privacy-inventory-plan.js';
import {buildPrivacyWriterFencePlan,withPrivacyWriterFence} from '../../packages/db/src/privacy-writer-fence.js';
import {readProjectedResultRange} from '../../packages/db/src/result-projection-reader.js';
import {resultFiltersSchema} from '../../packages/contracts/src/results.js';
import {collectResultProjection} from '../../packages/db/src/result-projection-worker.js';
import {verifyResultProjectionRebuild} from '../../packages/db/src/result-projections.js';
import {preservePrivacyResults,verifyPrivacyResultsAfterErasure} from '../../packages/db/src/privacy-results.js';
import {preparePrivacyJob,PRIVACY_JOB_INVENTORY_BINDING_SQL} from '../../packages/db/src/privacy-jobs.js';
const w='privacy_results_a',other='privacy_results_b',owner='synthetic-privacy-owner';
const suffix=randomBytes(8).toString('hex'),workerLogin='privacy_jobs_'+suffix,attestorLogin='privacy_attestor_'+suffix,apiLogin='privacy_api_'+suffix,aiLogin='privacy_ai_'+suffix;
let admin:pg.Pool,worker:pg.Pool,attestor:pg.Pool,api:pg.Pool,ai:pg.Pool;
async function tx<T>(pool:pg.Pool,role:string,work:(c:pg.PoolClient)=>Promise<T>,workspace=w,isolation:'READ COMMITTED'|'REPEATABLE READ'='REPEATABLE READ'){const c=await pool.connect();try{await c.query('BEGIN ISOLATION LEVEL '+isolation);await c.query('SET LOCAL ROLE '+role);await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[workspace]);const r=await work(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function importPolicy(workspace=w,version=0,evidence='a'.repeat(64),id:string=randomUUID()){return tx(attestor,'commerce_privacy_attestor',async c=>(await c.query('SELECT import_privacy_policy($1,$2,$3,$4) r',[id,owner,evidence,version])).rows[0].r,workspace);}
async function backup(workspace=w,patch:Record<string,unknown>={}){const id=randomUUID();return tx(attestor,'commerce_privacy_attestor',async c=>{const times=(await c.query("SELECT clock_timestamp()-interval '1 hour' snapshot,clock_timestamp()-interval '30 minutes' restored,privacy_runtime_fingerprint() topology")).rows[0];const v={id,run:'gcp-'+'a'.repeat(32),originals:'b'.repeat(64),restore:'c'.repeat(64),...times,...patch};return (await c.query('SELECT import_privacy_backup($1,$2,$3,$4,$5,$6,$7) r',[v.id,v.run,v.snapshot,v.restored,v.originals,v.restore,v.topology])).rows[0].r;},workspace);}
async function seedJourney(workspace=w,age=200,classification='COMMERCIAL'){
 // Only synthetic restore fixtures: all timestamps/commands/events/versions are
 // inserted as one internally consistent historical image by the fixture admin.
 // Runtime tests below use real non-superuser logins and all original triggers.
 const id=randomUUID(),cmd=randomUUID();return tx(admin,'postgres',async c=>{
  const at=(await c.query("SELECT clock_timestamp()-($1::integer*interval '24 hours') AS clock_value",[age])).rows[0].clock_value;
  const offer=randomUUID();await c.query("INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,'REAL','offer','{\"currency\":\"MXN\"}')",[offer,workspace]);
  const body={offer_version_id:offer,status:'CLOSED',closed_at:at.toISOString(),closed_by:owner,closed_reason:'SYNTHETIC_RESOLVED',commercial_classification:classification,private_note:'PRIVATE_SENTINEL'};
  await c.query('SET LOCAL session_replication_role=replica');
  await c.query("INSERT INTO records(id,workspace_id,environment,kind,version,body,created_at,updated_at) VALUES($1,$2,'REAL','conversation',2,$3,$4,$4)",[id,workspace,body,at]);
  await c.query("INSERT INTO record_versions(record_id,workspace_id,environment,kind,version,body,created_at) VALUES($1,$2,'REAL','conversation',1,'{\"status\":\"OPEN\"}',$4::timestamptz-interval '1 day'),($1,$2,'REAL','conversation',2,$3,$4)",[id,workspace,body,at]);
  await c.query("INSERT INTO commands(id,workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key,status,result,created_at,updated_at) VALUES($1,$2,'REAL','conversation_command',$3,$4,$5,$6,'APPLIED',$7,$8,$8)",[cmd,workspace,id,owner,{type:'close_conversation',reason:'SYNTHETIC_RESOLVED'},randomUUID(),{status:'CLOSED',conversation_id:id},at]);
  await c.query("INSERT INTO domain_events(workspace_id,environment,event_type,aggregate_id,correlation_id,causation_id,actor,payload,occurred_at,recorded_at) VALUES($1,'REAL','conversation.closed',$2,$3,$3,$4,$5,$6,$6)",[workspace,id,cmd,{type:'automation'},{actor_id:owner,reason:'SYNTHETIC_RESOLVED'},at]);
  await c.query('SET LOCAL session_replication_role=origin');return{id,w:workspace,version:2};
 },workspace);
}
async function prepared(j:Awaited<ReturnType<typeof seedJourney>>,b:string,id:string=randomUUID()){return preparePrivacyJob(worker,{workspaceId:j.w,jobId:id,journeyId:j.id,sourceVersion:j.version,backupId:b});}
async function hold(journey:string|null,active=true,holdId:string=randomUUID(),revision=0,workspace=w){return tx(attestor,'commerce_privacy_attestor',async c=>(await c.query('SELECT import_privacy_hold($1,$2,$3,$4,$5,$6) r',[randomUUID(),holdId,journey,active,'d'.repeat(64),revision])).rows[0].r,workspace);}
async function preserved(j:Awaited<ReturnType<typeof seedJourney>>,jobId:string,work?: (db:any,proof:any)=>Promise<void>){return withPrivacyWriterFence(worker,j.w,async(c,lease)=>{const db={workspaceId:j.w,query:c.query.bind(c)};const proof=await preservePrivacyResults(db,{jobId,leaseId:lease});if(work)await work(db,proof);return proof;});}
async function apiTx<T>(work:(db:ProfileExecutor)=>Promise<T>){return tx(api,'commerce_api',c=>work({workspaceId:w,query:c.query.bind(c)}));}
async function aiFixture(){
 const j=await seedJourney(),variantId=randomUUID(),family=randomUUID(),key=randomBytes(32),now=(await admin.query('SELECT clock_timestamp() now')).rows[0].now.getTime();
 await tx(admin,'postgres',async c=>{await c.query("INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,'REAL','product','{\"name\":\"Synthetic AI family\"}')",[family,w]);await c.query("INSERT INTO market_families(id,workspace_id,environment) VALUES($1,$2,'REAL')",[family,w]);await c.query("INSERT INTO market_variants(id,workspace_id,environment,family_id,draft) VALUES($1,$2,'REAL',$3,'{}')",[variantId,w,family]);});
 const release=randomUUID(),releaseBody={id:release,scope:{workspace_id:w,environment:'REAL'},family_id:family,variant_id:variantId,revision:1,locale:{market:'Mexico',currency:'MXN',timezone:'UTC',language:'es'}};
 await tx(admin,'postgres',c=>c.query("INSERT INTO market_releases(id,workspace_id,environment,variant_id,revision,body,sha256) VALUES($1,$2,'REAL',$3,1,$4,$5)",[release,w,variantId,releaseBody,'a'.repeat(64)]));
 const bind=async(id:string)=>tx(admin,'postgres',c=>c.query("INSERT INTO market_journey_snapshots(journey_id,workspace_id,environment,release_id,body) VALUES($1,$2,'REAL',$3,$4)",[id,w,release,{journey_id:id,chat:{workspace_id:w,environment:'REAL'},release:releaseBody}]));await bind(j.id);
 const authority:ProfileAuthority={profile:{id:j.w,state:'ACTIVE'},membership:{userId:owner,workspaceId:j.w,role:'owner',active:true,version:1},credential:{kind:'session',userId:owner,workspaceId:j.w,revoked:false,expiresAt:new Date(now+3600000).toISOString(),scopes:[],membershipVersion:1}};
 const model:Model={provider:'openai',model:'source-model-'+randomUUID(),revision:'source-v1',transport:'responses',capabilities:['chat'],responseModels:[],inputTokenCeiling:100,outputTokenCeiling:10,price:{version:'source-price-v1',validFrom:new Date(now-86400000).toISOString(),validUntil:new Date(now+7*86400000).toISOString(),currency:'USD',input:1000000,output:2000000,cacheRead:500000,cacheWrite:1000000,audioInput:1000000}};model.responseModels=[model.model];
 await admin.query('INSERT INTO ai_model_prices(provider,model,model_revision,price_version,valid_from,valid_until,input_ceiling,output_ceiling,input_rate,output_rate,cache_read_rate,cache_write_rate,audio_input_rate,model_document) VALUES($1,$2,$3,$4,$5,$6,100,10,1000000,2000000,500000,1000000,1000000,$7)',[model.provider,model.model,model.revision,model.price.version,model.price.validFrom,model.price.validUntil,model]);
 const credential=await apiTx(db=>storeAiCredential(db,authority,{operationId:randomUUID(),environment:'REAL',provider:'openai',expectedRevision:0,key:'synthetic-result-source-key'},key));
 await apiTx(db=>configureAiBudget(db,authority,{periodId:randomUUID(),environment:'REAL',startsAt:new Date(now-86400000).toISOString(),endsAt:new Date(now+86400000).toISOString(),profileLimitMicrousd:10000,keyLimits:[{credentialId:credential.credentialId,limitMicrousd:10000}]}));
 async function makeGrant(isTest:boolean){const id=randomUUID();await apiTx(db=>configureAiGrant(db,authority,{grantId:id,environment:'REAL',credentialId:credential.credentialId,variantId:isTest?null:variantId,task:isTest?'credential.verify':'seller.reply',isTest,provider:model.provider,model:model.model,modelRevision:model.revision,priceVersion:model.price.version,expiresAt:new Date(now+3600000).toISOString()}));return id;}
 const q=quote(j.w,model,10000,now),testPorts=new PostgresAiPorts(ai,await makeGrant(true),key),testScope:Scope={workspaceId:j.w,profileId:j.w,variantId:'credential-verification',attemptId:credential.verificationAttemptId,task:'credential.verify',environment:'REAL'},testRequest=credentialVerificationIdentity(model);
 const success={state:'SUCCEEDED' as const,priceVersion:model.price.version,usage:{input:3,output:1,cacheRead:0,cacheWrite:0,audioInput:0},costMicrousd:5};
 await testPorts.reserve(testScope,q,testRequest);await testPorts.beforeSend(testScope,q,testScope.attemptId,{request:testRequest,credentialVersion:1});await testPorts.record(testScope,testScope.attemptId,success);
 const ports=new PostgresAiPorts(ai,await makeGrant(false),key),scope:Scope={...testScope,variantId,conversationId:j.id,task:'seller.reply',attemptId:randomUUID()},request:RequestIdentity={sha256:'b'.repeat(64),bytes:100,capability:'chat'};
 return{j,ports,scope,request,q,success,bind};
}
describe('D18 native result preservation before erasure',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');admin=new pg.Pool({connectionString:url.toString(),max:4});
  // V7 F2: the canonical chain, its components and the isolation model are
  // installed by the migrations (0069-0097); no transition source is applied here.
  await requireMigratedProfileSchema(admin);
  for(const[id,email]of[[owner,'privacy@example.invalid'],[owner+'-backup','privacy-backup@example.invalid']])await admin.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',[id,'Synthetic privacy Owner',email]);
  for(const workspace of[w,other]){await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic privacy jobs','UTC',0,5,100)",[workspace]);for(const id of[owner,owner+'-backup'])await admin.query("INSERT INTO memberships(user_id,workspace_id,role,active) VALUES($1,$2,'owner',true)",[id,workspace]);await tx(admin,'postgres',c=>c.query('SELECT adopt_profile_quota_inventory($1,profile_quota_inventory($1))',[workspace]),workspace);}
  // Fixture-only content replacement tests result preservation independently
  // of033. It is never shipped or treated as complete erasure authority.
  await admin.query(`CREATE FUNCTION fixture_privacy_result_stub(target uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ UPDATE public.records SET body='{"privacy_erased":true}',version=version+1 WHERE id=target AND workspace_id=current_setting('app.workspace_id') AND environment='REAL' AND kind='conversation' $$; REVOKE ALL ON FUNCTION fixture_privacy_result_stub(uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION fixture_privacy_result_stub(uuid) TO commerce_privacy_job_worker;`);
  const catalog=await readProfileCatalog(admin,[]) as PrivacyInventoryCatalog;
  await admin.query(buildPrivacyWriterFencePlan(catalog).sql);
  const plan=buildPrivacyInventoryPlan(catalog,privacyInventoryPolicy(catalog.tables.map(t=>t.name)));await admin.query(plan.prepare_sql);await admin.query(PRIVACY_JOB_INVENTORY_BINDING_SQL);
  for(const[name,roles]of[[workerLogin,'commerce_privacy_job_worker,commerce_privacy_fence_worker,commerce_results'],[attestorLogin,'commerce_privacy_attestor'],[apiLogin,'commerce_api'],[aiLogin,'commerce_ai']]){const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT ${roles} TO "${name}"`);const u=new URL(url);u.username=name;u.password=secret;const pool=new pg.Pool({connectionString:u.toString(),max:3});if(name===workerLogin)worker=pool;else if(name===attestorLogin)attestor=pool;else if(name===aiLogin)ai=pool;else api=pool;}
  await admin.query(plan.seal_sql);await importPolicy();await importPolicy(other);
 },60000);
 afterAll(async()=>{await ai?.end();await worker?.end();await attestor?.end();await api?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${workerLogin}","${attestorLogin}","${apiLogin}","${aiLogin}"`);}finally{await admin.end();}}});

 it('seals nonfinancial cohorts and preserves complete aggregates after a synthetic stub',async()=>{
  const j=await seedJourney(),b=await backup(),job=await prepared(j,b.id);
  const proof=await preserved(j,job.job_id,async(db,proof)=>{await db.query('SELECT fixture_privacy_result_stub($1)',[j.id]);expect((await verifyPrivacyResultsAfterErasure(db,proof)).status).toBe('UNCHANGED');});
  expect(proof).toMatchObject({financial_context:false,sealed:2});
  const report=await apiTx(db=>readProjectedResultRange(db,resultFiltersSchema.parse({from:'2026-01-01',to:'2026-12-31',currency:'MXN'})));expect(report.facts.length).toBeGreaterThan(0);expect((await admin.query('SELECT phase FROM result_projection_state WHERE workspace_id=$1',[w])).rows[0].phase).toBe('READY');
  const rows=(await admin.query('SELECT kind,facts,sealed_at FROM result_projection_sources WHERE workspace_id=$1',[w])).rows;expect(rows.filter(r=>r.sealed_at&&r.facts===null)).toHaveLength(2);
  const totals=(await admin.query('SELECT counters FROM result_metric_daily WHERE workspace_id=$1',[w])).rows;expect(totals[0].counters.started).toBe('1');
  expect(JSON.stringify(await admin.query('SELECT * FROM privacy_result_seals WHERE job_id=$1',[job.job_id]))).not.toContain('PRIVATE_SENTINEL');
 });
 it('rollback preserves source content and removes all new seals and metric mutations',async()=>{
  const j=await seedJourney(),b=await backup(),job=await prepared(j,b.id),before=(await admin.query('SELECT * FROM result_metric_daily WHERE workspace_id=$1 ORDER BY grain_hash',[w])).rows;
  await expect(preserved(j,job.job_id,async(db)=>{await db.query('SELECT fixture_privacy_result_stub($1)',[j.id]);throw Error('ABORT_ERASURE');})).rejects.toThrow('ABORT_ERASURE');
  expect((await admin.query('SELECT * FROM privacy_result_seals WHERE job_id=$1',[job.job_id])).rows).toEqual([]);
  expect((await admin.query('SELECT body FROM records WHERE id=$1',[j.id])).rows[0].body.private_note).toBe('PRIVATE_SENTINEL');
  expect((await admin.query('SELECT * FROM result_metric_daily WHERE workspace_id=$1 ORDER BY grain_hash',[w])).rows).toEqual(before);
 });
 it('a native legal hold added after preparation prevents projection work',async()=>{const j=await seedJourney(),b=await backup(),job=await prepared(j,b.id),h=randomUUID();await hold(j.id,true,h);try{await expect(preserved(j,job.job_id)).rejects.toThrow('LEGAL_HOLD');}finally{await hold(j.id,false,h,1);}});
 it('changed source is rejected before any seal is written',async()=>{const j=await seedJourney(),b=await backup(),job=await prepared(j,b.id);await tx(admin,'postgres',c=>c.query("UPDATE records SET body=body||'{\"stage\":\"CHANGED\"}',version=version+1 WHERE id=$1",[j.id]));await expect(preserved(j,job.job_id)).rejects.toThrow('SOURCE_CHANGED');expect((await admin.query('SELECT * FROM privacy_result_seals WHERE job_id=$1',[job.job_id])).rows).toEqual([]);});
 it('TEST has no invented commercial contribution or required nonexistent seal',async()=>{const j=await seedJourney(w,40,'TEST'),b=await backup(),job=await prepared(j,b.id);expect(await preserved(j,job.job_id)).toMatchObject({financial_context:false,sealed:0});});
 it('financial history captures024 and keeps its projections mutable',async()=>{
  const j=await seedJourney();await tx(admin,'postgres',c=>c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','order',$2)",[w,{conversation_id:j.id,currency:'MXN',amount_minor:100,offer_snapshot:{currency:'MXN'}}]));
  const b=await backup(),job=await prepared(j,b.id);const proof=await preserved(j,job.job_id,async(db,proof)=>{await db.query('SELECT fixture_privacy_result_stub($1)',[j.id]);expect((await verifyPrivacyResultsAfterErasure(db,proof)).status).toBe('UNCHANGED');});
  expect(proof).toMatchObject({financial_context:true,sealed:0});expect((await admin.query('SELECT source_hash FROM result_financial_context WHERE journey_id=$1',[j.id])).rowCount).toBe(1);
 });
 it('another profile cannot use the job even while it owns its own lease',async()=>{const j=await seedJourney(other),b=await backup(other),job=await prepared(j,b.id);await expect(preserved({...j,w},job.job_id)).rejects.toThrow('query returned no rows');});
 it('API cannot write seals, invoke preservation or impersonate its private owner',async()=>{for(const sql of['SELECT privacy_result_context(NULL,NULL)','SELECT confirm_privacy_result_seals(NULL,NULL)','SELECT * FROM privacy_result_seals','SET ROLE commerce_privacy_job_owner'])await expect(api.query(sql)).rejects.toThrow('permission denied');});
 it('standalone calls cannot manufacture a lease or bypass RR',async()=>{await expect(tx(worker,'commerce_privacy_job_worker',c=>c.query('SELECT privacy_result_context($1,$2)',[randomUUID(),randomUUID()]))).rejects.toThrow();});
 it('after-erasure equality gate refuses altered aggregates and rolls back',async()=>{const j=await seedJourney(),b=await backup(),job=await prepared(j,b.id);await expect(preserved(j,job.job_id,async(db,proof)=>{await db.query('SELECT fixture_privacy_result_stub($1)',[j.id]);await verifyPrivacyResultsAfterErasure(db,{...proof,before_sha256:'f'.repeat(64)});})).rejects.toThrow('ERASURE_DIFFERENCE');expect((await admin.query('SELECT body FROM records WHERE id=$1',[j.id])).rows[0].body.private_note).toBe('PRIVATE_SENTINEL');});
 it('a preservation receipt cannot make another transaction ready',async()=>{
  const j=await seedJourney(),b=await backup(),job=await prepared(j,b.id);await preserved(j,job.job_id);
  await expect(withPrivacyWriterFence(worker,w,async(c,lease)=>{await c.query('SET LOCAL ROLE commerce_privacy_job_worker');await c.query('SELECT finish_privacy_result_preservation($1,$2)',[job.job_id,lease]);})).rejects.toThrow('SAME_TRANSACTION_REQUIRED');
  expect((await admin.query('SELECT * FROM privacy_result_confirmations WHERE job_id=$1',[job.job_id])).rows).toEqual([]);
 });
 it('the native completion rejects a changed generation even with the same totals',async()=>{
  const j=await seedJourney(),b=await backup(),job=await prepared(j,b.id);
  await expect(preserved(j,job.job_id,async(db,proof)=>{await db.query('SET LOCAL ROLE commerce_results');await db.query("UPDATE result_projection_state SET generation=generation+1 WHERE workspace_id=$1 AND environment='REAL'",[w]);await db.query('SET LOCAL ROLE commerce_privacy_job_worker');await db.query('SELECT finish_privacy_result_preservation($1,$2)',[job.job_id,proof.lease_id]);})).rejects.toThrow('GENERATION_CHANGED');
 });
 it('native aggregate equality is enforced even when the TypeScript check is bypassed',async()=>{
  const j=await seedJourney(),b=await backup(),job=await prepared(j,b.id);
  await expect(preserved(j,job.job_id,async(db,proof)=>{await db.query('SET LOCAL ROLE commerce_results');await db.query("UPDATE result_metric_daily SET counters=jsonb_set(counters,'{started}',to_jsonb(((counters->>'started')::bigint+1)::text)) WHERE workspace_id=$1 AND environment='REAL'",[w]);await db.query('SET LOCAL ROLE commerce_privacy_job_worker');await db.query('SELECT finish_privacy_result_preservation($1,$2)',[job.job_id,proof.lease_id]);})).rejects.toThrow('NATIVE_DIFFERENCE');
 });
 let actualAi:Awaited<ReturnType<typeof aiFixture>>;
 it('native019 settled AI retains cost and attribution after a nonfinancial stub without replay',async()=>{
  const f=actualAi=await aiFixture();await f.ports.reserve(f.scope,f.q,f.request);await f.ports.beforeSend(f.scope,f.q,f.scope.attemptId,{request:f.request,credentialVersion:1});await f.ports.record(f.scope,f.scope.attemptId,f.success);
  const clock=(await admin.query('SELECT clock_timestamp()::text instant')).rows[0].instant,b=await backup(w,{snapshot:clock,restored:clock}),job=await prepared(f.j,b.id);
  const p=await preserved(f.j,job.job_id,async(db,proof)=>{await db.query('SELECT fixture_privacy_result_stub($1)',[f.j.id]);expect((await verifyPrivacyResultsAfterErasure(db,proof)).status).toBe('UNCHANGED');});expect(p.sealed).toBe(3);
  const marker=(await admin.query("SELECT * FROM privacy_result_seals WHERE job_id=$1 AND kind='AI'",[job.job_id])).rows[0];expect(marker.source_id).toBe(f.scope.attemptId);expect(marker.source_sha256).toMatch(/^[a-f0-9]{64}$/);
  await tx(worker,'commerce_results',async c=>{const db={workspaceId:w,query:c.query.bind(c)};await collectResultProjection(db);expect((await verifyResultProjectionRebuild(db)).fingerprint).toBe(p.before_sha256);});
 });
 it('reserved native019 work blocks erasure even if the conversation closure is old',async()=>{
  const f=actualAi,j=await seedJourney(),scope={...f.scope,conversationId:j.id,attemptId:randomUUID()};await f.bind(j.id);await f.ports.reserve(scope,f.q,f.request);const clock=(await admin.query('SELECT clock_timestamp()::text instant')).rows[0].instant,b=await backup(w,{snapshot:clock,restored:clock}),job=await prepared(j,b.id);
  await expect(preserved(j,job.job_id)).rejects.toThrow('AI_UNSETTLED');await f.ports.record(scope,scope.attemptId,{state:'REJECTED',code:'AUTHORITY',priceVersion:f.q.priceVersion});
 });
 it('uncertain native019 cost remains pending and is never sealed as known spending',async()=>{
  const f=actualAi,j=await seedJourney(),scope={...f.scope,conversationId:j.id,attemptId:randomUUID()};await f.bind(j.id);await f.ports.reserve(scope,f.q,f.request);await f.ports.beforeSend(scope,f.q,scope.attemptId,{request:f.request,credentialVersion:1});await f.ports.record(scope,scope.attemptId,{state:'UNCERTAIN',code:'NETWORK_UNKNOWN',priceVersion:f.q.priceVersion});
  const clock=(await admin.query('SELECT clock_timestamp()::text instant')).rows[0].instant,b=await backup(w,{snapshot:clock,restored:clock}),job=await prepared(j,b.id);await expect(preserved(j,job.job_id)).rejects.toThrow('AI_UNSETTLED');expect((await admin.query("SELECT * FROM privacy_result_seals WHERE source_id=$1",[scope.attemptId])).rows).toEqual([]);
 });
 it('the original source-reader pin cannot be silently reapplied after extension',async()=>{const sql=await readFile(new URL('../../packages/db/profile-transition/034_privacy_result_preservation.sql',import.meta.url),'utf8');await expect(admin.query(sql.slice(sql.indexOf('DO $patch$')))).rejects.toThrow('READER_CHANGED');});
});
