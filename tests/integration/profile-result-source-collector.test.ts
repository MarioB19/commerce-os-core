/** Actual017+019+022: synthetic commercial data, production schema and roles. */
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {requireMigratedProfileSchema,fixtureProfileRow} from '../support/migrated-database.js';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from '../../packages/db/src/profile-context.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {projectProfileResults,collectResultProjection} from '../../packages/db/src/result-projection-worker.js';
import {readProjectedResultRange} from '../../packages/db/src/result-projection-reader.js';
import {summarizeResults} from '../../packages/domain/src/sales/results.js';
import {resultFiltersSchema} from '../../packages/contracts/src/results.js';
import {PostgresAiPorts,storeAiCredential} from '../../packages/ai-providers/src/persistence.js';
import {configureAiGrant,configureAiBudget} from '../../packages/ai-providers/src/configuration.js';
import {credentialVerificationIdentity} from '../../packages/ai-providers/src/verification.js';
import {quote} from '../../packages/ai-providers/src/catalog.js';
import type {Model,Scope,RequestIdentity} from '../../packages/ai-providers/src/contracts.js';
import type {ProfileAuthority} from '../../packages/domain/src/core/profile-authorization.js';
import {resultsReport} from '../../packages/db/src/results.js';
import {resultsReportSchema} from '../../packages/contracts/src/results-client.js';
// V7 F2: an installation admits three profiles and 20 numbers; each fresh
// fixture profile is sealed and the oldest are disposed to make room.
const createdProfiles:string[]=[];
const suffix=randomBytes(8).toString('hex'),login='result_sources_api_'+suffix,workerLogin='result_sources_worker_'+suffix;
let admin:pg.Pool,api:pg.Pool,worker:pg.Pool,aiPool:pg.Pool,scoped:ProfilePool,workerScope:ProfilePool,serial=0;
const aiLogin='result_sources_ai_'+suffix;
const day='2026-10-10',started='2026-10-10T16:00:00.000Z',response='2026-10-10T16:00:30.000Z',paid='2026-10-10T17:00:00.000Z';
const query=resultFiltersSchema.parse({from:day,to:'2026-10-13',currency:'MXN'});
function tx<T>(w:string,work:(db:ProfileExecutor)=>Promise<T>){return withProfileTransaction(scoped,w,async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");return work(db);});}
async function profile(timezone='America/Mexico_City'){return fixtureProfileRow(admin,createdProfiles,'results_'+suffix+'_'+(++serial),{businessName:'Synthetic Results',timezone,numbers:1,products:5,daily:100});}
async function rec(w:string,kind:string,body:Record<string,unknown>,environment='REAL'){const id=randomUUID();await admin.query('INSERT INTO records(id,workspace_id,environment,kind,body,created_at) VALUES($1,$2,$3,$4,$5,$6)',[id,w,environment,kind,body,started]);return id;}
async function journey(w:string,patch:Record<string,unknown>={},environment='REAL'){
 const family=await rec(w,'product',{name:'Synthetic product'},environment),account=await rec(w,'channel_account',{provider:'simulator'},environment),offer=await rec(w,'offer',{currency:'MXN',product_id:family},environment);
 const conversation=await rec(w,'conversation',{started_at:started,account_id:account,product_id:family,offer_version_id:offer,origin:{classification:'observed',ad_id:'100',meta_ad_account_id:'act_1'},...patch},environment);
 const order=await rec(w,'order',{conversation_id:conversation,product_id:family,currency:'MXN',attribution:{classification:'observed',ad_id:'100',meta_ad_account_id:'act_1'}},environment);return{w,conversation,order,family,account,offer,environment};
}
type Journey=Awaited<ReturnType<typeof journey>>;
async function effect(j:Journey,purpose='offer',status='SENT',at=response){const id=randomUUID();await admin.query("INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,logical_key,kind,payload,config_hash,status,provider_message_id,result) VALUES($1,$2,$3,$4,$5,$6,$1::uuid::text,'message',$7,$8,$9,$10,$11)",[id,j.w,j.environment,j.account,j.conversation,randomUUID(),{kind:'text',purpose,text:'Synthetic non-customer text'},'a'.repeat(64),status,status==='SENT'?'synthetic-'+id:null,{accepted_at:at}]);return id;}
async function payment(j:Journey,amount='10000',at=paid,currency='MXN'){
 const receipt=await rec(j.w,'receipt',{order_id:j.order,conversation_id:j.conversation,status:'APPROVED',text:'synthetic'},j.environment),id=randomUUID();
 await admin.query('INSERT INTO payment_contributions(id,workspace_id,environment,order_id,receipt_id,payment_key,amount_minor,currency,currency_source,evidence_sha256,effective_at,provenance) VALUES($1,$2,$3,$4,$5,$1::uuid::text,$6,$7,$8,$9,$10,$11)',[id,j.w,j.environment,j.order,receipt,amount,currency,'SYNTHETIC_FIXTURE',randomBytes(32).toString('hex'),at,{}]);return{id,receipt};
}
async function metadata(w:string){await admin.query("INSERT INTO meta_ad_metadata(workspace_id,environment,meta_ad_account_id,ad_id,campaign_id,ad_name,campaign_name,source) VALUES($1,'REAL','act_1','100','10','Synthetic ad','Synthetic campaign','SYNTHETIC_FIXTURE')",[w]);}
async function variant(j:Journey,timezone='Pacific/Auckland'){
 const variantId=randomUUID(),release=randomUUID(),body={id:release,scope:{workspace_id:j.w,environment:'REAL'},family_id:j.family,variant_id:variantId,revision:1,locale:{market:'New Zealand',currency:'MXN',timezone,language:'es'}};
 await admin.query("INSERT INTO market_families(id,workspace_id,environment) VALUES($1,$2,'REAL')",[j.family,j.w]);
 await admin.query("INSERT INTO market_variants(id,workspace_id,environment,family_id,draft) VALUES($1,$2,'REAL',$3,'{}')",[variantId,j.w,j.family]);
 await admin.query("INSERT INTO market_releases(id,workspace_id,environment,variant_id,revision,body,sha256) VALUES($1,$2,'REAL',$3,1,$4,$5)",[release,j.w,variantId,body,'a'.repeat(64)]);
 await admin.query("INSERT INTO market_journey_snapshots(journey_id,workspace_id,environment,release_id,body) VALUES($1,$2,'REAL',$3,$4)",[j.conversation,j.w,release,{journey_id:j.conversation,chat:{workspace_id:j.w,environment:'REAL',account_id:j.account,contact_id:randomUUID()},release:body}]);return variantId;
}
async function reading(j:Journey){return tx(j.w,db=>readProjectedResultRange(db,query));}
async function summary(j:Journey){return summarizeResults((await reading(j)).facts,[],query);}
function wrapped(base:ProfilePool,hook:(sql:string)=>Promise<void>,lostCommit=false):ProfilePool{return{async connect(){const c=await base.connect();return{query:async(sql,values)=>{await hook(sql);const r=await c.query(sql,values);if(lostCommit&&sql==='COMMIT')throw Error('LOST_COMMIT_ACK');return r;},release:c.release.bind(c)};}};}
async function aiFixture(){
 const j=await journey(await profile()),variantId=await variant(j,'UTC'),owner=randomUUID(),key=randomBytes(32),now=(await admin.query('SELECT clock_timestamp() now')).rows[0].now.getTime();
 await admin.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,\'Synthetic AI source\',$2,true)',[owner,owner+'@example.invalid']);await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[owner,j.w]);
 const authority:ProfileAuthority={profile:{id:j.w,state:'ACTIVE'},membership:{userId:owner,workspaceId:j.w,role:'owner',active:true,version:1},credential:{kind:'session',userId:owner,workspaceId:j.w,revoked:false,expiresAt:new Date(now+3600000).toISOString(),scopes:[],membershipVersion:1}};
 const model:Model={provider:'openai',model:'source-model-'+randomUUID(),revision:'source-v1',transport:'responses',capabilities:['chat'],responseModels:[],inputTokenCeiling:100,outputTokenCeiling:10,price:{version:'source-price-v1',validFrom:new Date(now-86400000).toISOString(),validUntil:new Date(now+7*86400000).toISOString(),currency:'USD',input:1000000,output:2000000,cacheRead:500000,cacheWrite:1000000,audioInput:1000000}};model.responseModels=[model.model];
 await admin.query('INSERT INTO ai_model_prices(provider,model,model_revision,price_version,valid_from,valid_until,input_ceiling,output_ceiling,input_rate,output_rate,cache_read_rate,cache_write_rate,audio_input_rate,model_document) VALUES($1,$2,$3,$4,$5,$6,100,10,1000000,2000000,500000,1000000,1000000,$7)',[model.provider,model.model,model.revision,model.price.version,model.price.validFrom,model.price.validUntil,model]);
 const credential=await tx(j.w,db=>storeAiCredential(db,authority,{operationId:randomUUID(),environment:'REAL',provider:'openai',expectedRevision:0,key:'synthetic-result-source-key'},key));
 await tx(j.w,db=>configureAiBudget(db,authority,{periodId:randomUUID(),environment:'REAL',startsAt:new Date(now-86400000).toISOString(),endsAt:new Date(now+86400000).toISOString(),profileLimitMicrousd:10000,keyLimits:[{credentialId:credential.credentialId,limitMicrousd:10000}]}));
 async function makeGrant(isTest:boolean){const id=randomUUID();await tx(j.w,db=>configureAiGrant(db,authority,{grantId:id,environment:'REAL',credentialId:credential.credentialId,variantId:isTest?null:variantId,task:isTest?'credential.verify':'seller.reply',isTest,provider:model.provider,model:model.model,modelRevision:model.revision,priceVersion:model.price.version,expiresAt:new Date(now+3600000).toISOString()}));return id;}
 const q=quote(j.w,model,10000,now),testPorts=new PostgresAiPorts(aiPool,await makeGrant(true),key),testScope:Scope={workspaceId:j.w,profileId:j.w,variantId:'credential-verification',attemptId:credential.verificationAttemptId,task:'credential.verify',environment:'REAL'},testRequest=credentialVerificationIdentity(model);
 const success={state:'SUCCEEDED' as const,priceVersion:model.price.version,usage:{input:3,output:1,cacheRead:0,cacheWrite:0,audioInput:0},costMicrousd:5};
 await testPorts.reserve(testScope,q,testRequest);await testPorts.beforeSend(testScope,q,testScope.attemptId,{request:testRequest,credentialVersion:1});await testPorts.record(testScope,testScope.attemptId,success);
 const ports=new PostgresAiPorts(aiPool,await makeGrant(false),key),scope:Scope={...testScope,variantId,conversationId:j.conversation,task:'seller.reply',attemptId:randomUUID()},request:RequestIdentity={sha256:'b'.repeat(64),bytes:100,capability:'chat'};
 return{j,ports,scope,request,q,success};
}
describe('actual commercial ledger to anonymous result generations',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');admin=new pg.Pool({connectionString:url.toString(),max:5});await requireMigratedProfileSchema(admin);
  
  for(const [name,role]of[[login,'commerce_api'],[workerLogin,'commerce_results'],[aiLogin,'commerce_ai']]){
   const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;GRANT ${role} TO "${name}"`);const native=new URL(url);native.username=name;native.password=secret;const pool=new pg.Pool({connectionString:native.toString(),max:4});
   const context:ProfilePool={async connect(){const connection=await pool.connect();try{await connection.query(`SET ROLE ${role}`);return{query:connection.query.bind(connection),release:()=>connection.release()};}catch(e){connection.release();throw e;}}};
   if(role==='commerce_api'){api=pool;scoped=context;}else if(role==='commerce_results'){worker=pool;workerScope=context;}else aiPool=pool;
  }
 },60000);
 afterAll(async()=>{await api?.end();await worker?.end();await aiPool?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}","${workerLogin}","${aiLogin}"`);}finally{await admin.end();}}});
 it('collects all six observed funnel stages, exact payments and variant calendar',async()=>{
  const j=await journey(await profile());await variant(j);await metadata(j.w);await effect(j);await effect(j,'collection');await payment(j);
  const completed=await projectProfileResults(workerScope,j.w),r=await reading(j),s=await summary(j);expect(completed.applied).toBe(2);expect(r.timezones).toEqual(['Pacific/Auckland']);expect(r.facts.map(f=>f.day)).toEqual(['2026-10-11']);
  expect(s.funnel.map(v=>v.count)).toEqual(['1','1','1','1','1','1']);expect(s.totals.revenue_minor).toBe('10000');expect(s.first_response_ms.value).toBe('30000.000000');expect(s.latency_percentiles.response.p50.value).toBe('30000');expect(s.latency_percentiles.response.p95.value).toBe('30000');expect(s.latency_percentiles.sale.p95.value).not.toBeNull();
  const daily=(await admin.query('SELECT * FROM result_metric_daily WHERE workspace_id=$1',[j.w])).rows;expect(JSON.stringify(daily)).not.toContain(j.conversation);expect(JSON.stringify(daily)).not.toContain('Synthetic non-customer text');
 });
 it('replays the full snapshot without reapplying source contributions',async()=>{
  const j=await journey(await profile());await payment(j,'9007199254740991');await payment(j,'9007199254740991','2026-10-11T17:00:00Z');await projectProfileResults(workerScope,j.w);const before=await summary(j),r=await projectProfileResults(workerScope,j.w);
  expect(r.applied).toBe(0);expect(r.removed).toBe(0);expect(await summary(j)).toEqual(before);expect(before.totals.revenue_minor).toBe('18014398509481982');expect(before.totals.sales).toBe('1');
 });
 it('reverses FALSE and TEST receipt facts while preserving the financial ledger',async()=>{
  for(const classification of ['FALSE','TEST']){
   const j=await journey(await profile()),p=await payment(j);await projectProfileResults(workerScope,j.w);
   await admin.query('UPDATE records SET body=body||jsonb_build_object(\'commercial_classification\',$2::text),version=version+1 WHERE id=$1',[p.receipt,classification]);await projectProfileResults(workerScope,j.w);
   const s=await summary(j);expect(s.totals.revenue_minor).toBe('0');expect(s.funnel.at(-1)?.count).toBe('0');expect(s.funnel[4]?.count).toBe('0');expect((await admin.query('SELECT * FROM payment_contributions WHERE id=$1',[p.id])).rows).toHaveLength(1);
  }
 });
 it('reconciles a source excluded after order TEST classification without stale totals',async()=>{
  const j=await journey(await profile());await payment(j);await projectProfileResults(workerScope,j.w);
  await admin.query("UPDATE records SET body=body||'{\"commercial_classification\":\"TEST\"}',version=version+1 WHERE id=$1",[j.order]);const r=await projectProfileResults(workerScope,j.w);expect(r.removed).toBe(2);expect((await summary(j)).funnel[0]?.count).toBe('0');
  await admin.query("UPDATE records SET body=body-'commercial_classification',version=version+1 WHERE id=$1",[j.order]);await projectProfileResults(workerScope,j.w);expect((await summary(j)).totals.revenue_minor).toBe('10000');
 });
 it('a failure before completion rolls back totals, source revisions and marker',async()=>{
  const j=await journey(await profile());await payment(j);await projectProfileResults(workerScope,j.w);const prior=await reading(j);await payment(j,'75');
  const fail=wrapped(workerScope,async sql=>{if(sql.startsWith('INSERT INTO result_projection_state'))throw Error('GENERATION_FAILURE');});
  await expect(projectProfileResults(fail,j.w)).rejects.toThrow('GENERATION_FAILURE');expect(await reading(j)).toEqual(prior);
  await projectProfileResults(workerScope,j.w);expect((await summary(j)).totals.revenue_minor).toBe('10075');
 });
 it('lost COMMIT response can be reconciled without duplicating any amount',async()=>{
  const j=await journey(await profile());await payment(j);await expect(projectProfileResults(wrapped(workerScope,async()=>{},true),j.w)).rejects.toThrow('LOST_COMMIT_ACK');expect((await summary(j)).totals.revenue_minor).toBe('10000');
  const r=await projectProfileResults(workerScope,j.w);expect(r.applied).toBe(0);expect((await summary(j)).totals.revenue_minor).toBe('10000');
 });
 it('keeps one source snapshot while financial evidence changes concurrently',async()=>{
  const j=await journey(await profile());let changed=false;
  const interleave=wrapped(workerScope,async sql=>{if(!changed&&sql.startsWith('SELECT source_id,facts')){changed=true;await payment(j);}});
  await projectProfileResults(interleave,j.w);expect((await summary(j)).totals.revenue_minor).toBe('0');await projectProfileResults(workerScope,j.w);expect((await summary(j)).totals.revenue_minor).toBe('10000');
 });
 it('closed reader cannot be called from API or a missing/SIMULATION worker context',async()=>{
  const j=await journey(await profile());await expect(tx(j.w,db=>db.query("SELECT * FROM read_result_source_page('COHORT',NULL,250)"))).rejects.toThrow('permission denied');
  for(const environment of ['', 'SIMULATION'])await expect(withProfileTransaction(workerScope,j.w,async db=>{await db.query("SELECT set_config('app.environment',$1,true)",[environment]);return db.query("SELECT * FROM read_result_source_page('COHORT',NULL,250)");})).rejects.toThrow('RESULT_SOURCE_SCOPE_REQUIRED');
  await expect(withProfileTransaction(workerScope,j.w,collectResultProjection)).rejects.toThrow('RESULT_SNAPSHOT_CONTEXT_REQUIRED');
  await expect(withProfileTransaction(workerScope,j.w,db=>db.query('SELECT body FROM records'))).rejects.toThrow('permission denied');
  const foreign=await journey(await profile());await payment(foreign);await projectProfileResults(workerScope,j.w);expect((await summary(j)).totals.revenue_minor).toBe('0');
 });
 it('remarketing attribution expires after the contracted seven days',async()=>{
  const j=await journey(await profile());await effect(j,'remarketing','SENT','2026-10-01T17:00:00Z');await payment(j);await projectProfileResults(workerScope,j.w);
  const r=(await admin.query("SELECT grain FROM result_metric_daily WHERE workspace_id=$1 AND counters->>'revenue_minor'<>'0'",[j.w])).rows;expect(r).toHaveLength(1);expect(r[0].grain.dimensions.touch).toBe('FIRST_CONTACT');
 });
 it('projects actual019 measured AI usage and excludes reserves and credential tests',async()=>{
  const f=await aiFixture();await f.ports.reserve(f.scope,f.q,f.request);await projectProfileResults(workerScope,f.j.w);expect((await summary(f.j)).totals.ai_cost_microusd).toBe('0');
  await f.ports.beforeSend(f.scope,f.q,f.scope.attemptId,{request:f.request,credentialVersion:1});await f.ports.record(f.scope,f.scope.attemptId,f.success);await projectProfileResults(workerScope,f.j.w);
  const s=await summary(f.j);expect(s.totals).toMatchObject({ai_cost_microusd:'5',ai_input_tokens:'3',ai_output_tokens:'1',ai_cost_unknown_attempts:'0',ai_tokens_unknown_attempts:'0'});
  expect((await admin.query('SELECT sum(measured_cost_microusd)::text cost FROM ai_attempts WHERE workspace_id=$1',[f.j.w])).rows[0].cost).toBe('10');
 });
 it('keeps unknown AI cost/tokens as incomplete and never reports the reservation as expense',async()=>{
  const f=await aiFixture();await f.ports.reserve(f.scope,f.q,f.request);await f.ports.beforeSend(f.scope,f.q,f.scope.attemptId,{request:f.request,credentialVersion:1});await f.ports.record(f.scope,f.scope.attemptId,{state:'UNCERTAIN',code:'NETWORK_UNKNOWN',priceVersion:f.success.priceVersion});await projectProfileResults(workerScope,f.j.w);
  const s=await summary(f.j);expect(s.totals).toMatchObject({ai_cost_microusd:'0',ai_cost_unknown_attempts:'1',ai_tokens_unknown_attempts:'1'});expect(s.ai.cost.value).toBeNull();
 });
 it('retains non-conversation OPERATION cost separately across currency and known dimension filters',async()=>{
  const f=await aiFixture(),scope={...f.scope,conversationId:undefined};await f.ports.reserve(scope,f.q,f.request);await f.ports.beforeSend(scope,f.q,scope.attemptId,{request:f.request,credentialVersion:1});await f.ports.record(scope,scope.attemptId,f.success);await projectProfileResults(workerScope,f.j.w);
  for(const currency of ['MXN','USD']){const r=await tx(f.j.w,db=>resultsReport(db,{...query,currency,variant_id:f.scope.variantId}));expect(resultsReportSchema.parse(r)).toEqual(r);expect(r.summary.totals.ai_cost_microusd).toBe('0');expect(r.unattributed_ai).toMatchObject({cost_microusd:'5',input_tokens:'3',output_tokens:'1',cost_unknown_attempts:'0',calendar:'UTC',independent_of_sales_currency:true});}
  const foreign=await tx(f.j.w,db=>resultsReport(db,{...query,variant_id:randomUUID()}));expect(foreign.unattributed_ai).toMatchObject({cost_microusd:'0'});
  const accountCut=await tx(f.j.w,db=>resultsReport(db,{...query,account_id:f.j.account}));expect(accountCut.unattributed_ai).toMatchObject({cost_microusd:'0'});
  const same=await projectProfileResults(workerScope,f.j.w);expect(same.applied).toBe(0);
 });
 it('a subsequently TEST order moves operational AI cost out of commercial ratios without losing expense',async()=>{
  const f=await aiFixture();await f.ports.reserve(f.scope,f.q,f.request);await f.ports.beforeSend(f.scope,f.q,f.scope.attemptId,{request:f.request,credentialVersion:1});await f.ports.record(f.scope,f.scope.attemptId,f.success);await projectProfileResults(workerScope,f.j.w);expect((await summary(f.j)).totals.ai_cost_microusd).toBe('5');
  await admin.query("UPDATE records SET body=body||'{\"commercial_classification\":\"TEST\"}',version=version+1 WHERE id=$1",[f.j.order]);await projectProfileResults(workerScope,f.j.w);
  const r=await tx(f.j.w,db=>resultsReport(db,query));expect(r.summary.totals.ai_cost_microusd).toBe('0');expect(r.unattributed_ai).toMatchObject({cost_microusd:'5'});
 });
 it('unattributed uncertain usage remains unknown without treating held budget as measured cost',async()=>{
  const f=await aiFixture(),scope={...f.scope,conversationId:undefined};await f.ports.reserve(scope,f.q,f.request);await f.ports.beforeSend(scope,f.q,scope.attemptId,{request:f.request,credentialVersion:1});await f.ports.record(scope,scope.attemptId,{state:'UNCERTAIN',code:'NETWORK_UNKNOWN',priceVersion:f.success.priceVersion});await projectProfileResults(workerScope,f.j.w);
  const r=await tx(f.j.w,db=>resultsReport(db,query));expect(r.unattributed_ai).toMatchObject({cost_microusd:'0',cost_unknown_attempts:'1',tokens_unknown_attempts:'1'});
 });
 it('rejects preexisting projection/reader roles including prior memberships',async()=>{
  for(const [file,role,code]of [['022_result_projections.sql','commerce_results','RESULT_ROLE_ALREADY_EXISTS'],['components/022_result_source_reader.sql','commerce_results_reader','RESULT_READER_ROLE_ALREADY_EXISTS']]){
   const text=await readFile(new URL('../../packages/db/profile-transition/'+file,import.meta.url),'utf8'),guard=text.slice(text.indexOf('DO $$'),text.indexOf('END $$;')+7),c=await admin.connect();
   try{await c.query('BEGIN');await c.query(`GRANT ${role} TO commerce_api`);await expect(c.query(guard)).rejects.toThrow(code);}finally{await c.query('ROLLBACK');c.release();}
  }
 });
 it('public report uses the confirmed generation, snapshot watermark and closed client contract',async()=>{
  const j=await journey(await profile());await variant(j);await payment(j);await projectProfileResults(workerScope,j.w);
  const r=await tx(j.w,db=>resultsReport(db,query));expect(resultsReportSchema.parse(r)).toEqual(r);expect(r).toMatchObject({source:'profile_projection_v1',calendar:'MARKET_SNAPSHOT',timezones:['Pacific/Auckland'],generation:'1'});expect(r.measured_at).toBe((await reading(j)).watermark);
 });
 it('mixed market calendars preserve totals but cannot claim comparable advertising cost',async()=>{
  const workspace=await profile(),a=await journey(workspace),b=await journey(workspace);await variant(a,'UTC');await variant(b,'Pacific/Auckland');await payment(a);await payment(b);await projectProfileResults(workerScope,workspace);
  const r=await tx(workspace,db=>resultsReport(db,query));expect(r.timezones).toEqual(['Pacific/Auckland','UTC']);expect(r.summary.totals.revenue_minor).toBe('20000');expect(r.summary.cost_per_sale_minor).toEqual({value:null,reason:'SPEND_TIMEZONE_MIXED'});
 });
});
