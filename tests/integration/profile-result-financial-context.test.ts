/** Actual024 financial context; synthetic stubs prove metric independence, not full erasure. */
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {requireMigratedProfileSchema,fixtureProfileRow} from '../support/migrated-database.js';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from '../../packages/db/src/profile-context.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {projectProfileResults} from '../../packages/db/src/result-projection-worker.js';
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
// The range must include facts the fixtures create at the current time (AI
// attempts, projections); a fixed end date turned these into a time bomb.
const until=new Date(Date.now()+86400000).toISOString().slice(0,10);
const query=resultFiltersSchema.parse({from:day,to:until>'2026-10-13'?until:'2026-10-13',currency:'MXN'});
function tx<T>(w:string,work:(db:ProfileExecutor)=>Promise<T>){return withProfileTransaction(scoped,w,async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");return work(db);});}
async function profile(timezone='America/Mexico_City'){return fixtureProfileRow(admin,createdProfiles,'results_'+suffix+'_'+(++serial),{businessName:'Synthetic Results',timezone,numbers:6,products:20,daily:100});}
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
async function custody(j:Journey,expectedVersion=1,abort=false){return withProfileTransaction({async connect(){const c=await workerScope.connect();return{query:(sql,values)=>c.query(sql==='BEGIN'?'BEGIN ISOLATION LEVEL REPEATABLE READ':sql,values),release:c.release.bind(c)};}},j.w,async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");const result=await db.query('SELECT capture_result_financial_context($1,$2) result',[j.conversation,expectedVersion]);if(abort)throw Error('ABORT_BEFORE_ERASE');return result;});}
async function eraseStub(j:Journey){await admin.query("UPDATE records SET body='{\"privacy_erased\":true}',version=version+1 WHERE id=$1",[j.conversation]);}
describe('retained financial context independent of conversation content',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');admin=new pg.Pool({connectionString:url.toString(),max:5});await requireMigratedProfileSchema(admin);
  
  for(const [name,role]of[[login,'commerce_api'],[workerLogin,'commerce_results'],[aiLogin,'commerce_ai']]){
   const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;GRANT ${role} TO "${name}"`);const native=new URL(url);native.username=name;native.password=secret;const pool=new pg.Pool({connectionString:native.toString(),max:4});
   const context:ProfilePool={async connect(){const connection=await pool.connect();try{await connection.query(`SET ROLE ${role}`);return{query:connection.query.bind(connection),release:()=>connection.release()};}catch(e){connection.release();throw e;}}};
   if(role==='commerce_api'){api=pool;scoped=context;}else if(role==='commerce_results'){worker=pool;workerScope=context;}else aiPool=pool;
  }
 },60000);
 afterAll(async()=>{await api?.end();await worker?.end();await aiPool?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}","${workerLogin}","${aiLogin}"`);}finally{await admin.end();}}});
 it('preserves all funnel denominators, money and calendar after replacing the live conversation',async()=>{
  const j=await journey(await profile(),{last_customer_text:'SYNTHETIC_PRIVATE_CONTENT',phone:'SYNTHETIC_PRIVATE_PHONE'});await variant(j);await metadata(j.w);await effect(j);await effect(j,'collection');await payment(j);await projectProfileResults(workerScope,j.w);const before=await summary(j);
  expect((await custody(j)).rows[0].result.status).toBe('CAPTURED');const retained=(await admin.query('SELECT * FROM result_financial_context WHERE workspace_id=$1',[j.w])).rows[0];expect(JSON.stringify(retained)).not.toContain('SYNTHETIC_PRIVATE');expect(Object.keys(retained).sort()).toEqual(['workspace_id','environment','journey_id','journey_kind','source_version','source_hash','grain','started_at','first_response_at','offered','collection_sent','remarketing_accepted_at','captured_at'].sort());
  await eraseStub(j);await projectProfileResults(workerScope,j.w);expect(await summary(j)).toEqual(before);
 });
 it('later FALSE/TEST corrections and partial payments update income without the conversation',async()=>{
  const j=await journey(await profile()),a=await payment(j,'10000'),b=await payment(j,'500');await custody(j);await eraseStub(j);await projectProfileResults(workerScope,j.w);expect((await summary(j)).totals.revenue_minor).toBe('10500');
  for(const [id,kind]of [[a.receipt,'FALSE'],[b.receipt,'TEST']])await admin.query("UPDATE records SET body=body||jsonb_build_object('commercial_classification',$2::text),version=version+1 WHERE id=$1",[id,kind]);await projectProfileResults(workerScope,j.w);expect((await summary(j)).totals.revenue_minor).toBe('0');expect((await summary(j)).funnel.at(-1)?.count).toBe('0');
  await payment(j,'250','2026-10-11T18:00:00Z');await projectProfileResults(workerScope,j.w);expect((await summary(j)).totals).toMatchObject({revenue_minor:'250',sales:'1'});expect((await admin.query('SELECT count(*)::text n FROM payment_contributions WHERE workspace_id=$1',[j.w])).rows[0].n).toBe('3');
 });
 it('financial TEST reversal removes and restores historical cohort and expense correctly',async()=>{
  const j=await journey(await profile());await payment(j);await custody(j);await eraseStub(j);await projectProfileResults(workerScope,j.w);const before=await summary(j);
  await admin.query("UPDATE records SET body=body||'{\"commercial_classification\":\"TEST\"}',version=version+1 WHERE id=$1",[j.order]);await projectProfileResults(workerScope,j.w);expect((await summary(j)).funnel[0]?.count).toBe('0');
  await admin.query("UPDATE records SET body=body-'commercial_classification',version=version+1 WHERE id=$1",[j.order]);await projectProfileResults(workerScope,j.w);expect(await summary(j)).toEqual(before);
 });
 it('exact replay is no-effect and changed evidence/version cannot replace immutable context',async()=>{
  const j=await journey(await profile());expect((await custody(j)).rows[0].result.status).toBe('CAPTURED');expect((await custody(j)).rows[0].result.status).toBe('NO_EFFECT');await expect(custody(j,2)).rejects.toThrow('RESULT_CUSTODY_SOURCE_CHANGED');
  await effect(j);await expect(custody(j)).rejects.toThrow('RESULT_CUSTODY_SNAPSHOT_CHANGED');
 });
 it('API cannot capture or mutate; missing environment, isolation and foreign IDs reject',async()=>{
  const j=await journey(await profile()),foreign=await journey(await profile());await expect(tx(j.w,db=>db.query('SELECT capture_result_financial_context($1,1)',[j.conversation]))).rejects.toThrow('permission denied');
  await expect(withProfileTransaction(workerScope,j.w,db=>db.query('SELECT capture_result_financial_context($1,1)',[j.conversation]))).rejects.toThrow('RESULT_CUSTODY_CONTEXT_REQUIRED');
  await expect(custody({...j,conversation:foreign.conversation})).rejects.toThrow('RESULT_CUSTODY_SOURCE_CHANGED');
  await expect(tx(j.w,db=>db.query('DELETE FROM result_financial_context WHERE workspace_id=$1',[j.w]))).rejects.toThrow('permission denied');
 });
 it('captured financial context keeps accepted remarketing attribution after source payload removal',async()=>{
  const j=await journey(await profile());const e=await effect(j,'remarketing');await payment(j);await custody(j);await projectProfileResults(workerScope,j.w);const before=await summary(j);expect((await admin.query("SELECT touch FROM result_payment_facts WHERE workspace_id=$1",[j.w])).rows).toEqual([]);
  await eraseStub(j);await admin.query("UPDATE outbox SET payload='{}',result='{}' WHERE id=$1",[e]);await projectProfileResults(workerScope,j.w);expect(await summary(j)).toEqual(before);
  const rows=await tx(j.w,db=>db.query('SELECT touch FROM result_payment_facts WHERE workspace_id=$1',[j.w]));expect(rows.rows).toEqual([{touch:'REMARKETING'}]);
 });
 it('actual019 settled AI stays in the same attributed grain after financial conversation removal',async()=>{
  const f=await aiFixture();await f.ports.reserve(f.scope,f.q,f.request);await f.ports.beforeSend(f.scope,f.q,f.scope.attemptId,{request:f.request,credentialVersion:1});await f.ports.record(f.scope,f.scope.attemptId,f.success);await custody(f.j);await projectProfileResults(workerScope,f.j.w);const before=await tx(f.j.w,db=>resultsReport(db,query));await eraseStub(f.j);await projectProfileResults(workerScope,f.j.w);const after=await tx(f.j.w,db=>resultsReport(db,query));expect(after.summary).toEqual(before.summary);expect(after.unattributed_ai).toEqual(before.unattributed_ai);expect(resultsReportSchema.parse(after)).toEqual(after);
 });
 it('capture rolls back with its caller and never leaves a context after aborted erasure',async()=>{
  const j=await journey(await profile());await expect(custody(j,1,true)).rejects.toThrow('ABORT_BEFORE_ERASE');expect((await admin.query('SELECT journey_id FROM result_financial_context WHERE workspace_id=$1',[j.w])).rows).toEqual([]);expect((await custody(j)).rows[0].result.status).toBe('CAPTURED');
 });
 it('cross-profile context remains invisible and preexisting custody role is rejected',async()=>{
  const j=await journey(await profile()),other=await journey(await profile());await custody(j);expect((await tx(other.w,db=>db.query('SELECT journey_id FROM result_financial_context'))).rows).toEqual([]);
  const text=await readFile(new URL('../../packages/db/profile-transition/024_result_financial_context.sql',import.meta.url),'utf8'),guard=text.slice(text.indexOf('DO $$'),text.indexOf('END $$;')+7);await expect(admin.query(guard)).rejects.toThrow('RESULT_CUSTODY_ROLE_ALREADY_EXISTS');
 });
});
