import {createServer,type Server} from 'node:http';
import {createProfileWorkerRuntime} from '../../packages/db/src/profile-worker-scope.js';
import {currentProfileExecutor} from '../../packages/db/src/profile-query-routing.js';
import {processProfileReceiptAnalyses,type ReceiptAnalysisRuntime} from '../../apps/automation-worker/src/receipt-ai.js';
import {processReceiptAnalyses} from '../../apps/automation-worker/src/agents.js';
import {PostgresReceiptDocumentAi,receiptDocumentScope,type ReceiptAiDocument} from '../../packages/ai-providers/src/receipt-document.js';
import {PostgresAiPorts,storeAiCredential} from '../../packages/ai-providers/src/persistence.js';
import {configureAiGrant,configureAiBudget} from '../../packages/ai-providers/src/configuration.js';
import {credentialVerificationIdentity} from '../../packages/ai-providers/src/verification.js';
import {quote} from '../../packages/ai-providers/src/catalog.js';
import type {Model,Scope} from '../../packages/ai-providers/src/contracts.js';
import type {ProfileAuthority} from '../../packages/domain/src/core/profile-authorization.js';
const custodyKey=randomBytes(32),aiLogin='receipt_ai_'+randomBytes(8).toString('hex');
let aiPool:pg.Pool,automation:pg.Pool,credentialId:string,model:Model,clock:()=>number,server:Server,providerAddress:string;
let providerCalls=0,responseCode=200,responseDocument:Awaited<ReturnType<typeof observation>>,postHook:(()=>Promise<void>)|undefined;
const success={state:'SUCCEEDED' as const,priceVersion:'fixture-price-v1',usage:{input:3,output:1,cacheRead:0,cacheWrite:0,audioInput:0},costMicrousd:5};
function authority():ProfileAuthority{return{profile:{id:one,state:'ACTIVE'},membership:{userId:owner.user,workspaceId:one,role:'owner',active:true,version:1},credential:{kind:'session',userId:owner.user,workspaceId:one,revoked:false,expiresAt:new Date(clock()+3600000).toISOString(),scopes:[],membershipVersion:1}};}
async function setupAi(url:URL){
 const base=(await admin.query('SELECT clock_timestamp() now')).rows[0].now.getTime(),start=performance.now();clock=()=>base+performance.now()-start;
 const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${aiLogin}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;GRANT commerce_ai TO "${aiLogin}"`);const aiUrl=new URL(url);aiUrl.username=aiLogin;aiUrl.password=secret;aiPool=new pg.Pool({connectionString:aiUrl.toString(),options:'-c role=commerce_ai',max:4});automation=new pg.Pool({connectionString:url.toString(),options:'-c role=commerce_automation',max:4});
 model={provider:'openai',model:'synthetic-model',revision:'fixture-v1',transport:'responses',capabilities:['chat','vision'],responseModels:['synthetic-model'],inputTokenCeiling:100,outputTokenCeiling:10,price:{version:'fixture-price-v1',validFrom:new Date(base-86400000).toISOString(),validUntil:new Date(base+7*86400000).toISOString(),currency:'USD',input:1000000,output:2000000,cacheRead:500000,cacheWrite:1000000,audioInput:1000000}};
 await admin.query(`INSERT INTO ai_model_prices(provider,model,model_revision,price_version,valid_from,valid_until,input_ceiling,output_ceiling,input_rate,output_rate,cache_read_rate,cache_write_rate,audio_input_rate,model_document) VALUES($1,$2,$3,$4,$5,$6,100,10,1000000,2000000,500000,1000000,1000000,$7)`,[model.provider,model.model,model.revision,model.price.version,model.price.validFrom,model.price.validUntil,model]);
 const saved=await tx(db=>storeAiCredential(db,authority(),{operationId:randomUUID(),environment:'REAL',provider:'openai',expectedRevision:0,key:'synthetic-receipt-key'},custodyKey));credentialId=saved.credentialId;
 await tx(db=>configureAiBudget(db,authority(),{periodId:randomUUID(),environment:'REAL',startsAt:new Date(base-86400000).toISOString(),endsAt:new Date(base+86400000).toISOString(),profileLimitMicrousd:1000000,keyLimits:[{credentialId,limitMicrousd:1000000}]}));
 const grant=await newGrant(null,'credential.verify',true),scope:Scope={workspaceId:one,profileId:one,environment:'REAL',variantId:'credential-verification',task:'credential.verify',attemptId:saved.verificationAttemptId},ports=new PostgresAiPorts(aiPool,grant,custodyKey),q=quote(one,model,1000,clock()),request=credentialVerificationIdentity(model);
 await ports.reserve(scope,q,request);await ports.beforeSend(scope,q,scope.attemptId,{request,credentialVersion:1});await ports.record(scope,scope.attemptId,success);
 server=createServer(async(req,res)=>{try{let total=0;for await(const chunk of req){total+=chunk.length;if(total>8*1024*1024)throw Error('FIXTURE_BODY_BOUND');}providerCalls++;expect(currentProfileExecutor()).toBeUndefined();const rows=(await admin.query("SELECT state FROM ai_attempts WHERE workspace_id=$1 AND task='receipt.document' AND state='INTENT'",[one])).rows;expect(rows.length).toBeGreaterThan(0);if(postHook)await postHook();res.statusCode=responseCode;res.setHeader('content-type','application/json');res.end(JSON.stringify(responseCode===200?{model:'synthetic-model',status:'completed',service_tier:'default',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(responseDocument)}]}],usage:{input_tokens:3,output_tokens:1,input_tokens_details:{cached_tokens:0}}}:{}));}catch{res.statusCode=500;res.end('{}');}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw Error('FIXTURE_ADDRESS');providerAddress='http://127.0.0.1:'+address.port;
}
async function newGrant(variantId:string|null,task='receipt.document',isTest=false){const id=randomUUID();await tx(db=>configureAiGrant(db,authority(),{grantId:id,environment:'REAL',credentialId,variantId,task,isTest,provider:model.provider,model:model.model,modelRevision:model.revision,priceVersion:model.price.version,expiresAt:new Date(clock()+3600000).toISOString()}));return id;}
async function ready(){const f=await prepared(),bytes=Buffer.from('synthetic receipt '+randomUUID()),r=await receipt(f,{analysis_status:'PENDING'},createHash('sha256').update(bytes).digest('hex')),grantId=await newGrant(f.draft.id);responseDocument=await observation();const policy=(await tx(db=>policies.readOrderReceiptPolicy(db,'REAL',f.order.id)))!,document:ReceiptAiDocument={workspaceId:one,environment:'REAL',variantId:f.draft.id,conversationId:f.conversation.id,orderId:f.order.id,receiptId:r.id,policySha256:policy.sha256,asset:{id:r.body.asset_id,sha256:createHash('sha256').update(bytes).digest('hex'),mimeType:'image/png'}};
 const runtime:ReceiptAnalysisRuntime={bind:d=>{expect(d).toEqual(document);expect(currentProfileExecutor()).toBeDefined();return new PostgresReceiptDocumentAi({pool:aiPool,grantId,custodyKey,maximumMicrousd:1000,clock,fetcher:async(url,init)=>{expect(String(url)).toBe('https://api.openai.com/v1/responses');expect(currentProfileExecutor()).toBeUndefined();return fetch(providerAddress,init);}});},media:{read:async()=>{expect(currentProfileExecutor()).toBeUndefined();return Buffer.from(bytes);}}};return{...f,receipt:r,bytes,document,runtime,grantId};}
async function run(runtime:ReceiptAnalysisRuntime|undefined){const w=createProfileWorkerRuntime(automation,'commerce_automation','REAL'),p=(await w.discover()).find(p=>p.workspaceId===one)!;return w.run(p,()=>processProfileReceiptAnalyses(runtime));}
async function attempt(f:Awaited<ReturnType<typeof ready>>){return(await admin.query('SELECT * FROM ai_attempts WHERE workspace_id=$1 AND attempt_id=$2',[one,receiptDocumentScope(f.document).attemptId])).rows[0];}
async function pause(f:Awaited<ReturnType<typeof ready>>,paused:boolean){await admin.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'conversation',$2,$3,'synthetic pause',$4) ON CONFLICT(workspace_id,scope_type,scope_id) DO UPDATE SET paused=EXCLUDED.paused",[one,f.conversation.id,paused,owner.user]);}
import {withProfileQueryRouting} from '../../packages/db/src/profile-query-routing.js';
import {putRecord,encrypt,decrypt,type QueryExecutor} from '../../packages/db/src/index.js';
import {ensureOrder} from '../../apps/automation-worker/src/workflows.js';
import type {DomainRecord} from '../../packages/contracts/src/index.js';
const read=(c:QueryExecutor,id:string)=>c.query('SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND id=$3',[one,'REAL',id]).then(r=>r.rows[0] as DomainRecord);
async function prepared(automatic=true){
 const f=await fixture(),release=await publish(f.draft),conversationId=await journey(release);
 await tx(db=>store.captureMarketJourney(db,'REAL',conversationId,release.id));
 await tx(db=>policies.writeReceiptPolicy(db,'REAL',f.draft.id,{expectedRevision:0,override:{automaticApproval:automatic}},owner.user,randomUUID()));
 const conversation=await read(admin,conversationId),order=await worker(db=>ensureOrder(db,conversation));expect(order).toBeDefined();return{...f,release,conversation,order:order!};
}
async function receipt(f:Awaited<ReturnType<typeof prepared>>,patch:Record<string,unknown>={},imageHash=randomBytes(32).toString('hex')){
 const a=await record('asset',{status:'READY',storage_key:randomUUID(),sha256:imageHash,mime_type:'image/png'});
 return worker(db=>putRecord(db,{workspaceId:one,environment:'REAL',kind:'receipt',body:{order_id:f.order.id,conversation_id:f.conversation.id,product_id:f.release.family_id,asset_id:a.id,status:'HUMAN_REVIEW',analysis_status:'RUNNING',...patch}}));
}
async function observation(){const at=(await admin.query('SELECT clock_timestamp() now')).rows[0].now.toISOString();return{is_receipt:true,amount_minor:10000,currency:'MXN',destination_suffix:'6789',bank:'Synthetic',reference:randomUUID(),status:'completed',confidence:0.99,contradictions:[],destination:'123456789',beneficiary:'Synthetic Holder',paid_at:at,concept:null};}
const contributions=(order:string)=>admin.query('SELECT * FROM payment_contributions WHERE workspace_id=$1 AND order_id=$2',[one,order]).then(r=>r.rows);
import {readFile} from 'node:fs/promises';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import Fastify,{type FastifyInstance,type FastifyRequest} from 'fastify';
import {fromNodeHeaders} from 'better-auth/node';
import {hashPassword} from 'better-auth/crypto';
import {ZodError} from 'zod';
import pg from 'pg';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {listProfileChoicesFromSession,selectProfileFromSession} from '../../packages/db/src/profile-identity-bootstrap.js';
import {createAuth} from '../../apps/api/src/auth.js';
import {profileIdentityRoutes} from '../../apps/api/src/profile-identity.js';
import {type InteractiveSession} from '../../packages/db/src/profile-session.js';
import {withProfileTransaction,type ProfileExecutor} from '../../packages/db/src/profile-context.js';
import {withProfileSessionTransaction} from '../../packages/db/src/profile-session-transaction.js';
import {withPersonalProfileTransaction} from '../../packages/db/src/profile-personal-token.js';
import * as store from '../../packages/db/src/market-variants.js';
import {marketCopyReviewFields,type MarketRelease} from '../../packages/contracts/src/market-variants.js';
import {type MarketDraftFields} from '../../packages/contracts/src/market-variant-store.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';

const suffix=randomBytes(8).toString('hex'),login='f5_policy_worker_'+suffix;
const one='policy_one_'+suffix,two='policy_two_'+suffix,origin='http://localhost:5173';
const password='synthetic-market-password123',locale={market:'México',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'};
let admin:pg.Pool,runtime:pg.Pool,app:FastifyInstance,address:string,passwordHash:string,owner:{user:string;cookie:string;session:InteractiveSession};
async function transaction<T>(work:(c:pg.PoolClient)=>Promise<T>){const c=await runtime.connect();try{await c.query('BEGIN');const result=await work(c);expect((await c.query('COMMIT')).command).toBe('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function nativeSession(req:FastifyRequest){return transaction(async c=>{const v=await createAuth(c).api.getSession({headers:fromNodeHeaders(req.headers),query:{disableRefresh:true}});return v&&v.session.userId===v.user.id?{id:v.session.id,userId:v.user.id}:null;});}
function tx<T>(work:(db:ProfileExecutor)=>Promise<T>,account=owner){return withProfileSessionTransaction(runtime,account.session,{workspaceId:one,version:1},{scope:'receipt-rules:write',mutation:true},async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");return work(db);});}
function worker<T>(work:(db:ProfileExecutor)=>Promise<T>,routing=true){return withProfileTransaction(runtime,one,async db=>{await db.query("SET LOCAL ROLE commerce_automation");await db.query("SELECT set_config('app.environment','REAL',true)");return routing?withProfileQueryRouting(db,()=>work(db)):work(db);});}
async function request(path:string,body?:object,headers:Record<string,string>={},method=body?'POST':'GET'){
 return fetch(address+path,{method,redirect:'error',headers:{origin,...headers,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
}
async function account(role='owner'){
 const user=randomUUID(),email=user+'@example.invalid';
 await admin.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,\'Synthetic Market\',$2,true)',[user,email]);
 await admin.query('INSERT INTO account(id,"accountId","providerId","userId",password,issuer) VALUES($1,$2,\'credential\',$2,$3,\'local:credential\')',[randomUUID(),user,passwordHash]);
 await admin.query('INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,$3)',[user,one,role]);
 const r=await request('/api/auth/sign-in/email',{email,password});expect(r.status).toBe(200);
 const cookie=r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');expect(cookie).toContain('better-auth.session_token=');
 const selection=await request('/v2/me/profile-selection',{workspaceId:one,expectedVersion:0},{cookie});expect(selection.status).toBe(200);
 const native=(await admin.query('SELECT id,"userId" FROM session WHERE "userId"=$1',[user])).rows[0];
 return{user,cookie,session:{id:native.id,userId:user}};
}
async function record(kind:string,body:object,workspace=one,environment='REAL',old=false){
 const id=randomUUID(),at=new Date(Date.now()-(old?60*86400000:0));await admin.query('INSERT INTO records(id,workspace_id,environment,kind,body,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',[id,workspace,environment,kind,body,at]);
 const row=(await admin.query('SELECT * FROM record_versions WHERE record_id=$1 AND version=1',[id])).rows[0];
 return{id,revision:1,sha256:store.marketRecordVersionHash(row)};
}
async function fixture(){
 const product=await record('product',{name:'Synthetic product',status:'DRAFT'});
 const flow=await record('workflow',{name:'Receipt fixture',status:'PUBLISHED',product_id:product.id,entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]}),seller=await record('agent',{product_id:product.id});
 const collection=await record('bank_profile',{currency:'MXN',last4:'6789',secret_ciphertext:encrypt({account_number:'123456789',holder:'Synthetic Holder',instructions:'Fixture only'})}),material=await record('asset',{status:'READY'});
 const offer=await record('offer',{product_id:product.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:10000,
 workflow_version_id:flow.id,agent_version_id:seller.id,payment_profile_version_id:collection.id,fulfillment:[{asset_id:material.id}]});
 const fields:MarketDraftFields={locale:{...locale},amount_minor:10000,configuration:{offer,flow,seller,collection,remarketing:offer,materials:[material]}};
 await tx(db=>store.adoptMarketFamily(db,'REAL',{product_id:product.id,expected_product_version:1}));
 const draft=await tx(db=>store.createMarketDraft(db,'REAL',{family_id:product.id,fields},owner.user));return{product,fields,draft};
}
async function publish(draft:{id:string;version:number;draft_sha256:string}){return (await tx(db=>store.publishMarketRelease(db,'REAL',draft.id,{expected_version:draft.version,draft_sha256:draft.draft_sha256,reviewed_fields:[...marketCopyReviewFields]},owner.user))).release;}
async function journey(release:MarketRelease){
 const account=await record('channel_account',{status:'PAUSED'}),contact=await record('contact',{name:'Synthetic'}),c=release.configuration;
 const binding=await record('binding',{account_id:account.id,offer_version_id:c.offer.id,workflow_version_id:c.flow.id,agent_version_id:c.seller.id});
 return(await record('conversation',{product_id:release.family_id,account_id:account.id,contact_id:contact.id,binding_id:binding.id,offer_version_id:c.offer.id,workflow_version_id:c.flow.id,agent_version_id:c.seller.id})).id;
}

import {receiptPolicyRoutes} from '../../apps/api/src/receipt-policies.js';
import * as policies from '../../packages/db/src/receipt-policies.js';
import {defaultReceiptPolicy} from '../../packages/domain/src/sales/receipt-policy.js';

describe('receipt019 protected provider orchestration through native worker phases',()=>{
 beforeAll(async()=>{
  vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));vi.stubEnv('BETTER_AUTH_SECRET','synthetic-market-'+randomBytes(32).toString('hex'));passwordHash=await hashPassword(password);
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:4,connectionTimeoutMillis:5000});
  if((await admin.query("SELECT to_regclass('public.profiles') AS present")).rows[0].present)throw Error('TRANSITION_SCHEMA_ALREADY_PRESENT');
  const c=await admin.connect();try{await c.query('BEGIN');for(const name of ['001_profile_identity.sql','002_profile_personal_tokens.sql','003_profile_settings.sql','008_market_variants.sql','013_continuous_worker_profile.sql','018_worker_profile_discovery.sql','019_ai_admission.sql','023_receipt_policies.sql','components/023_receipt_worker.sql'])await c.query(await readFile(new URL('../../packages/db/profile-transition/'+name,import.meta.url),'utf8'));await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT commerce_api,commerce_automation TO "${login}"`);
  // Existing commercial tables receive fixture-owned policies only. New market
  // tables use exactly the production-proposed 008 FORCE RLS and grants.
  for(const table of ['records','record_versions','personal_access_tokens'])await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;CREATE POLICY market_fixture ON ${table} USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),''))`);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic Market','UTC',1,100,100),($2,'Synthetic Foreign','UTC',1,100,100)",[one,two]);
  url.username=login;url.password=secret;runtime=new pg.Pool({connectionString:url.toString(),options:'-c role=commerce_api',max:5,connectionTimeoutMillis:5000});
  app=Fastify({logger:false,disableRequestLogging:true});app.setErrorHandler((e:any,_r,reply)=>reply.code(e instanceof ZodError?400:e.statusCode??500).send({error:{code:e.code??'INTERNAL_ERROR'}}));
  await profileIdentityRoutes(app,{origins:[origin],session:nativeSession,list:s=>listProfileChoicesFromSession(runtime,s),select:(s,w,v)=>transaction(c=>selectProfileFromSession(c,s,w,v))});
  await receiptPolicyRoutes(app,{origins:[origin],nativeSession,session:(s,f,environment,action,work)=>withProfileSessionTransaction(runtime,s,f,action,(db,profile)=>db.query("SELECT set_config('app.environment',$1,true)",[environment]).then(()=>work({db,profile,environment}))),personal:(t,environment,action,work)=>withPersonalProfileTransaction(runtime,t,environment,action,(db,profile)=>db.query("SELECT set_config('app.environment',$1,true)",[environment]).then(()=>work({db,profile,environment})))});
  app.post('/api/auth/*',{bodyLimit:4096},async(req,reply)=>{if(req.headers.origin!==origin)return reply.code(403).send({error:'ORIGIN'});const result=await transaction(c=>createAuth(c).handler(new Request('http://localhost:3001'+req.url,{method:'POST',headers:fromNodeHeaders(req.headers),body:JSON.stringify(req.body)})));reply.code(result.status);if(result.ok)reply.header('set-cookie',result.headers.getSetCookie());return{signedIn:result.ok};});
  address=await app.listen({host:'127.0.0.1',port:0});owner=await account();await setupAi(url);await tx(db=>policies.writeReceiptPolicy(db,'REAL',null,{expectedRevision:0,policy:defaultReceiptPolicy()},owner.user,randomUUID()));
 });
 afterAll(async()=>{await app?.close();await automation?.end();await aiPool?.end();if(server)await new Promise<void>(r=>server!.close(()=>r()));await runtime?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}";DROP ROLE IF EXISTS "${aiLogin}"`);}finally{await admin.end();}}vi.unstubAllEnvs();});

 beforeEach(async()=>{await admin.query("UPDATE records SET version=version+1,body=jsonb_set(body,'{analysis_status}','\"FIXTURE_FINISHED\"') WHERE workspace_id=$1 AND kind='receipt'",[one]);responseCode=200;postHook=undefined;providerCalls=0;});
 it('commits native019 INTENT before TCP and applies policy with exact measured cost once',async()=>{
  const f=await ready(),r=await read(admin,f.receipt.id);expect(r.body.analysis_status).toBe('PENDING');await run(f.runtime);const result=await read(admin,r.id);expect(result.body.analysis_status).toBe('COMPLETED');expect(result.body.status).toBe('APPROVED');expect(providerCalls).toBe(1);expect(await contributions(f.order.id)).toHaveLength(1);const a=await attempt(f);expect(a).toMatchObject({state:'SUCCEEDED',task:'receipt.document',variant_id:f.draft.id,conversation_id:f.conversation.id,is_test:false,measured_cost_microusd:'5',input_tokens:'3',output_tokens:'1'});expect(JSON.stringify(result.body)).not.toContain('123456789');expect(JSON.parse(decrypt(result.body.analysis_evidence_ciphertext))).toEqual(responseDocument);await run(f.runtime);expect(providerCalls).toBe(1);
 });
 it('no runtime and legacy entry both refuse policy023 provider fallback',async()=>{
  const f=await ready();await run(undefined);expect((await read(admin,f.receipt.id)).body).toMatchObject({analysis_status:'HUMAN_REQUIRED',analysis_dependency:'RECEIPT_AI_019_REQUIRED'});expect(providerCalls).toBe(0);
  await admin.query("UPDATE records SET version=version+1,body=jsonb_set(body,'{analysis_status}','\"PENDING\"') WHERE id=$1",[f.receipt.id]);const legacy={receipt:vi.fn()} as any;await worker(()=>processReceiptAnalyses(3,legacy));expect(legacy.receipt).not.toHaveBeenCalled();expect((await read(admin,f.receipt.id)).body.analysis_dependency).toBe('RECEIPT_AI_019_REQUIRED');expect(await attempt(f)).toBeUndefined();
 });
 it('a pause during the provider response caches encrypted output and resumes without another POST',async()=>{
  const f=await ready();postHook=()=>pause(f,true);await run(f.runtime);const first=await read(admin,f.receipt.id);expect(first.body.analysis_status).toBe('AWAITING_POLICY');expect(first.body.receipt_ai_result).toEqual(expect.any(String));expect(await contributions(f.order.id)).toHaveLength(0);postHook=undefined;await run(f.runtime);expect(providerCalls).toBe(1);await pause(f,false);await run(f.runtime);expect((await read(admin,f.receipt.id)).body.status).toBe('APPROVED');expect(providerCalls).toBe(1);
 });
 it('a pause after media acquisition is reread before native INTENT and prevents POST',async()=>{
  const f=await ready();f.runtime.media.read=async()=>{await pause(f,true);return Buffer.from(f.bytes);};await run(f.runtime);expect(providerCalls).toBe(0);expect(await attempt(f)).toMatchObject({state:'REJECTED',charged_microusd:'120',measured_cost_microusd:null});expect((await read(admin,f.receipt.id)).body.analysis_status).toBe('HUMAN_REQUIRED');await pause(f,false);
 });
 it.each(['key','grant','expiry'] as const)('native019 rejects %s changed inside the final commercial callback before POST',async kind=>{
  const f=await ready(),adapter=await worker(async()=>f.runtime.bind(f.document));let callback=0;
  try{
   const result=await adapter.invoke(f.document,f.bytes,async()=>{
    callback++;expect(currentProfileExecutor()).toBeUndefined();expect(await attempt(f)).toMatchObject({state:'RESERVED',intent_at:null,charged_microusd:'120'});
    if(kind==='key')await keyEnabled(false);
    else await tx(async db=>{await db.query("SELECT ai_scope_lock($1,'REAL')",[one]);await db.query(kind==='grant'?"UPDATE ai_runtime_grants SET version=version+1,revoked_at=clock_timestamp() WHERE id=$1":"UPDATE ai_runtime_grants SET version=version+1,expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.grantId]);});
   });
   expect(callback).toBe(1);expect(result.state).toBe('REJECTED');expect(providerCalls).toBe(0);
   expect(await attempt(f)).toMatchObject({state:'REJECTED',intent_at:null,reserved_microusd:'120',charged_microusd:'120',measured_cost_microusd:null});
   expect((await admin.query("SELECT count(*)::int n FROM ai_attempt_events WHERE attempt_id=$1 AND state='INTENT'",[receiptDocumentScope(f.document).attemptId])).rows[0].n).toBe(0);
   if(kind==='key')expect(await adapter.invoke(f.document,f.bytes,async()=>{throw Error('CALLBACK_REPLAY');})).toMatchObject({state:'UNCERTAIN',code:'ALREADY_ATTEMPTED'});
   else await expect(adapter.invoke(f.document,f.bytes,async()=>{throw Error('CALLBACK_REPLAY');})).rejects.toThrow('AUTHORITY');
   expect(providerCalls).toBe(0);
  }finally{if(kind==='key')await keyEnabled(true);}
 });
 it('a 500 response stays uncertain and cannot cause a second provider request',async()=>{
  const f=await ready();responseCode=500;await run(f.runtime);expect(await attempt(f)).toMatchObject({state:'UNCERTAIN',measured_cost_microusd:null,charged_microusd:'120'});expect((await read(admin,f.receipt.id)).body.analysis_status).toBe('HUMAN_REQUIRED');await run(f.runtime);expect(providerCalls).toBe(1);
 });
 it('corrupt media never reserves, invokes or replaces policy authority',async()=>{
  const f=await ready();f.runtime.media.read=async()=>Buffer.from('changed');await run(f.runtime);expect(await attempt(f)).toBeUndefined();expect(providerCalls).toBe(0);expect((await read(admin,f.receipt.id)).body.analysis_status).toBe('HUMAN_REQUIRED');await run(f.runtime);expect(providerCalls).toBe(0);
 });
 it('current key revocation prevents provider IO while keeping admission denied history',async()=>{
  const f=await ready();f.runtime.media.read=async()=>{await keyEnabled(false);return Buffer.from(f.bytes);};try{await run(f.runtime);expect(providerCalls).toBe(0);expect(await attempt(f)).toBeUndefined();expect((await admin.query('SELECT cause FROM ai_admission_denials WHERE attempt_id=$1',[receiptDocumentScope(f.document).attemptId])).rows[0].cause).toBe('KEY_UNAVAILABLE');}finally{await keyEnabled(true);}
 });
 it('missing evidence stays REVIEW with measured usage rather than fabricating full fields',async()=>{
  const f=await ready();delete (responseDocument as any).destination;delete (responseDocument as any).beneficiary;delete (responseDocument as any).paid_at;await run(f.runtime);const r=await read(admin,f.receipt.id);expect(r.body.status).toBe('HUMAN_REVIEW');expect(r.body.assessment.reasons).toEqual(expect.arrayContaining(['DESTINATION_UNVERIFIED','BENEFICIARY_UNVERIFIED','DATE_MISSING']));expect(await contributions(f.order.id)).toHaveLength(0);expect(await attempt(f)).toMatchObject({state:'SUCCEEDED',measured_cost_microusd:'5'});
 });
 it('a native settlement ACK loss leaves an uncertain receipt and never repeats the POST',async()=>{
  const f=await ready();const real=f.runtime.bind;f.runtime.bind=d=>{const a=real(d),verify=a.verifySettlement.bind(a);a.verifySettlement=async(...args)=>{await verify(...args);throw Error('SYNTHETIC_COMMIT_ACK_LOST');};return a;};await run(f.runtime);expect(providerCalls).toBe(1);expect((await attempt(f)).state).toBe('SUCCEEDED');expect((await read(admin,f.receipt.id)).body.analysis_status).toBe('HUMAN_REQUIRED');await run(f.runtime);expect(providerCalls).toBe(1);
 });
 it('altered cached evidence or a missing encrypted result never falls back to provider',async()=>{
  const f=await ready();postHook=()=>pause(f,true);await run(f.runtime);postHook=undefined;await pause(f,false);await admin.query("UPDATE records SET version=version+1,body=body-'receipt_ai_result' WHERE id=$1",[f.receipt.id]);await expect(run(f.runtime)).rejects.toThrow('RECEIPT_AI_CACHE_REQUIRED');expect(providerCalls).toBe(1);expect(await contributions(f.order.id)).toHaveLength(0);
 });
 it('a foreign or suspended profile cannot enter provider orchestration',async()=>{const f=await ready();await expect(processProfileReceiptAnalyses(f.runtime)).rejects.toThrow('RECEIPT_AI_WORKER_SCOPE_REQUIRED');const runtime=createProfileWorkerRuntime(automation,'commerce_automation','REAL'),selection=(await runtime.discover()).find(p=>p.workspaceId===one)!;await admin.query("UPDATE profiles SET state='SUSPENDED' WHERE id=$1",[one]);try{await expect(runtime.run(selection,()=>processProfileReceiptAnalyses(f.runtime))).rejects.toThrow('WORKER_PROFILE_AUTHORITY_CHANGED');expect(providerCalls).toBe(0);}finally{await admin.query("UPDATE profiles SET state='ACTIVE' WHERE id=$1",[one]);}});
 it('privacy erasure or explicit closure blocks new analysis before media or provider IO',async()=>{for(const field of ['privacy_erased','closed_at']){const f=await ready();await admin.query('UPDATE records SET version=version+1,body=body||jsonb_build_object($2::text,$3::jsonb) WHERE id=$1',[f.conversation.id,field,JSON.stringify(field==='privacy_erased'?true:new Date(clock()).toISOString())]);const broker=vi.spyOn(f.runtime.media,'read');await run(f.runtime);expect(broker).not.toHaveBeenCalled();expect(providerCalls).toBe(0);expect(await attempt(f)).toBeUndefined();await admin.query("UPDATE records SET version=version+1,body=jsonb_set(body,'{analysis_status}','\"FIXTURE_FINISHED\"') WHERE id=$1",[f.receipt.id]);}});

});

async function keyEnabled(enabled:boolean){await withProfileTransaction(runtime,one,async db=>{await db.query("SELECT ai_scope_lock($1,'REAL')",[one]);await db.query('UPDATE ai_credentials SET enabled=$2 WHERE id=$1',[credentialId,enabled]);});}
