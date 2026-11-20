import {withProfileQueryRouting} from '../../packages/db/src/profile-query-routing.js';
import {putRecord,encrypt,decrypt,type QueryExecutor} from '../../packages/db/src/index.js';
import {ensureOrder,eligibleFulfillmentItems} from '../../apps/automation-worker/src/workflows.js';
import {applyReceiptAnalysis} from '../../apps/automation-worker/src/commands.js';
import type {DomainRecord} from '../../packages/contracts/src/index.js';
import {receiptDocumentEvidence} from '../../packages/contracts/src/receipt-extraction.js';
const read=(c:QueryExecutor,id:string)=>c.query('SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND id=$3',[one,'REAL',id]).then(r=>r.rows[0] as DomainRecord);
async function prepared(automatic=true){
 const f=await fixture(),release=await publish(f.draft),conversationId=await journey(release);
 await tx(db=>store.captureMarketJourney(db,'REAL',conversationId,release.id));
 await tx(db=>policies.writeReceiptPolicy(db,'REAL',f.draft.id,{expectedRevision:0,override:{automaticApproval:automatic}},owner.user,randomUUID()));
 const conversation=await read(admin,conversationId),order=await worker(db=>ensureOrder(db,conversation));expect(order).toBeDefined();return{...f,release,conversation,order:order!};
}
async function receipt(f:Pick<Awaited<ReturnType<typeof prepared>>,'release'|'conversation'|'order'>,patch:Record<string,unknown>={},imageHash=randomBytes(32).toString('hex')){
 const a=await record('asset',{status:'READY',storage_key:randomUUID(),sha256:imageHash,mime_type:'image/png'});
 return worker(db=>putRecord(db,{workspaceId:one,environment:'REAL',kind:'receipt',body:{order_id:f.order.id,conversation_id:f.conversation.id,product_id:f.release.family_id,asset_id:a.id,status:'HUMAN_REVIEW',analysis_status:'RUNNING',...patch}}));
}
async function observation(){const at=(await admin.query('SELECT clock_timestamp() now')).rows[0].now.toISOString();return{is_receipt:true,amount_minor:10000,currency:'MXN',destination_suffix:'6789',bank:'Synthetic',reference:randomUUID(),status:'completed',confidence:0.99,contradictions:[],destination:'123456789',beneficiary:'Synthetic Holder',paid_at:at,concept:null};}
async function analyze(r:DomainRecord,raw:unknown,cause=r.id){return worker(async db=>{await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[r.body.conversation_id]);await applyReceiptAnalysis(db,await read(db,r.id),raw,cause);return read(db,r.id);});}
const contributions=(order:string)=>admin.query('SELECT * FROM payment_contributions WHERE workspace_id=$1 AND order_id=$2',[one,order]).then(r=>r.rows);
import {randomBytes,randomUUID} from 'node:crypto';
import Fastify,{type FastifyInstance,type FastifyRequest} from 'fastify';
import {fromNodeHeaders} from 'better-auth/node';
import {hashPassword} from 'better-auth/crypto';
import {ZodError} from 'zod';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi,beforeEach} from 'vitest';
import {releaseFixtureNumbers} from '../support/profile-fixture.js';
import {requireMigratedProfileSchema,sealFixtureProfiles} from '../support/migrated-database.js';
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
type CatalogOffer={product:string;tiers:{id:string;name:string;minimum_total_minor:number;included_extra_from_minor?:number}[];amounts:number[]};
async function fixture(catalog?:CatalogOffer){
 const product=await record('product',{name:catalog?.product??'Synthetic product',status:'DRAFT'});
 const flow=await record('workflow',{name:'Receipt fixture',status:'PUBLISHED',product_id:product.id,entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]}),seller=await record('agent',{product_id:product.id});
 const collection=await record('bank_profile',{currency:'MXN',last4:'6789',...(catalog?{methods:{spei:true,spin:true},secret_ciphertext:encrypt({spin:{card_number:'4242424242424242',holder:'Synthetic Holder'},spei:{clabe:'012345678901234567',holder:'Synthetic Holder'}})}:{secret_ciphertext:encrypt({account_number:'123456789',holder:'Synthetic Holder',instructions:'Fixture only'})})}),material=await record('asset',{status:'READY'});
 const extra=[];
 for(const min of catalog?.amounts??[]){const ref=await record('asset',{kind:'link',url:'https://example.invalid/material',status:'READY'});extra.push({ref,min});}
 const offer=await record('offer',{product_id:product.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:catalog?9700:10000,...(catalog?{accept_positive_contributions:true,tiers:catalog.tiers}:{}),
 workflow_version_id:flow.id,agent_version_id:seller.id,payment_profile_version_id:collection.id,fulfillment:catalog?extra.map(({ref,min})=>({asset_id:ref.id,release_on:'receipt_approved',min_amount_minor:min})):[{asset_id:material.id}]});
 const fields:MarketDraftFields={locale:{...locale},amount_minor:catalog?9700:10000,configuration:{offer,flow,seller,collection,remarketing:offer,materials:[material,...extra.map(x=>x.ref)]}};
 await tx(db=>store.adoptMarketFamily(db,'REAL',{product_id:product.id,expected_product_version:1}));
 const draft=await tx(db=>store.createMarketDraft(db,'REAL',{family_id:product.id,fields},owner.user));return{product,fields,draft};
}
async function publish(draft:{id:string;version:number;draft_sha256:string}){return (await tx(db=>store.publishMarketRelease(db,'REAL',draft.id,{expected_version:draft.version,draft_sha256:draft.draft_sha256,reviewed_fields:[...marketCopyReviewFields]},owner.user))).release;}
async function journey(release:MarketRelease,sharedAccount?:{id:string}){
 const account=sharedAccount??await record('channel_account',{status:'PAUSED'}),contact=await record('contact',{name:'Synthetic'}),c=release.configuration;
 const binding=await record('binding',{account_id:account.id,offer_version_id:c.offer.id,workflow_version_id:c.flow.id,agent_version_id:c.seller.id});
 return(await record('conversation',{product_id:release.family_id,account_id:account.id,contact_id:contact.id,binding_id:binding.id,offer_version_id:c.offer.id,workflow_version_id:c.flow.id,agent_version_id:c.seller.id})).id;
}

import {receiptPolicyRoutes} from '../../apps/api/src/receipt-policies.js';
import * as policies from '../../packages/db/src/receipt-policies.js';
import {defaultReceiptPolicy} from '../../packages/domain/src/sales/receipt-policy.js';

// V7 F2: cases admit their own REAL numbers; earlier cases' reservations are
// retired (test-only) so the installation stays within 20 connected numbers.
beforeEach(async()=>{if(admin)await releaseFixtureNumbers(admin);});
describe('F5 policy023 canonical order and receipt workers',()=>{
 beforeAll(async()=>{
  vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));vi.stubEnv('BETTER_AUTH_SECRET','synthetic-market-'+randomBytes(32).toString('hex'));passwordHash=await hashPassword(password);
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:4,connectionTimeoutMillis:5000});
  await requireMigratedProfileSchema(admin);
  const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT commerce_api,commerce_automation TO "${login}"`);
  // Existing commercial tables receive fixture-owned policies only. New market
  // tables use exactly the production-proposed 008 FORCE RLS and grants.
  for(const table of ['records','record_versions','personal_access_tokens'])await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;CREATE POLICY market_fixture ON ${table} USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),''))`);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic Market','UTC',10,100,250),($2,'Synthetic Foreign','UTC',10,100,100)",[one,two]);await sealFixtureProfiles(admin,one,two);
  url.username=login;url.password=secret;runtime=new pg.Pool({connectionString:url.toString(),options:'-c role=commerce_api',max:5,connectionTimeoutMillis:5000});
  app=Fastify({logger:false,disableRequestLogging:true});app.setErrorHandler((e:any,_r,reply)=>reply.code(e instanceof ZodError?400:e.statusCode??500).send({error:{code:e.code??'INTERNAL_ERROR'}}));
  await profileIdentityRoutes(app,{origins:[origin],session:nativeSession,list:s=>listProfileChoicesFromSession(runtime,s),select:(s,w,v)=>transaction(c=>selectProfileFromSession(c,s,w,v))});
  await receiptPolicyRoutes(app,{origins:[origin],nativeSession,session:(s,f,environment,action,work)=>withProfileSessionTransaction(runtime,s,f,action,(db,profile)=>db.query("SELECT set_config('app.environment',$1,true)",[environment]).then(()=>work({db,profile,environment}))),personal:(t,environment,action,work)=>withPersonalProfileTransaction(runtime,t,environment,action,(db,profile)=>db.query("SELECT set_config('app.environment',$1,true)",[environment]).then(()=>work({db,profile,environment})))});
  app.post('/api/auth/*',{bodyLimit:4096},async(req,reply)=>{if(req.headers.origin!==origin)return reply.code(403).send({error:'ORIGIN'});const result=await transaction(c=>createAuth(c).handler(new Request('http://localhost:3001'+req.url,{method:'POST',headers:fromNodeHeaders(req.headers),body:JSON.stringify(req.body)})));reply.code(result.status);if(result.ok)reply.header('set-cookie',result.headers.getSetCookie());return{signedIn:result.ok};});
  address=await app.listen({host:'127.0.0.1',port:0});owner=await account();await tx(db=>policies.writeReceiptPolicy(db,'REAL',null,{expectedRevision:0,policy:defaultReceiptPolicy()},owner.user,randomUUID()));
 });
 afterAll(async()=>{await app?.close();await runtime?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}vi.unstubAllEnvs();});
 it('captures the policy in the creation transaction before order version2 and reuses it unchanged',async()=>{
  const f=await prepared(),first=await tx(db=>policies.readOrderReceiptPolicy(db,'REAL',f.order.id));expect(first?.sha256).toBe(f.order.body.receipt_policy_snapshot_sha256);expect(f.order.version).toBe(2);
  await tx(db=>policies.writeReceiptPolicy(db,'REAL',f.draft.id,{expectedRevision:1,override:{automaticApproval:false}},owner.user,randomUUID()));
  expect((await worker(db=>ensureOrder(db,f.conversation)))?.id).toBe(f.order.id);expect(await tx(db=>policies.readOrderReceiptPolicy(db,'REAL',f.order.id))).toEqual(first);
 });
 it('without ALS a mismatched SQL context rolls back the whole new order; the record profile itself is bound',async()=>{
  // V7 F2: worker paths bind the explicit record's own profile (bindRecordProfile);
  // an established different context is never switched and aborts the order.
  const f=await fixture(),release=await publish(f.draft),id=await journey(release);await tx(db=>store.captureMarketJourney(db,'REAL',id,release.id));const c=await read(admin,id);
  await expect(worker(async db=>{await db.query("SELECT set_config('app.environment','SIMULATION',true)");return ensureOrder(db,c);},false)).rejects.toThrow();expect((await admin.query("SELECT id FROM records WHERE workspace_id=$1 AND kind='order' AND body->>'conversation_id'=$2",[one,id])).rows).toEqual([]);
  const order=await worker(db=>ensureOrder(db,c),false);expect(order?.body.receipt_policy_snapshot_sha256).toMatch(/^[a-f0-9]{64}$/);
 });
 it('uses immutable captured rules rather than a later variant edit',async()=>{
  const f=await prepared(false);await tx(db=>policies.writeReceiptPolicy(db,'REAL',f.draft.id,{expectedRevision:1,override:{automaticApproval:true}},owner.user,randomUUID()));const r=await receipt(f),result=await analyze(r,await observation());expect(result.body.status).toBe('HUMAN_REVIEW');expect(result.body.assessment.reasons).toContain('HUMAN_APPROVAL_REQUIRED');expect(await contributions(f.order.id)).toEqual([]);
 });
 it('full documentary match recognizes once without storing full extraction in its public projection',async()=>{
  const f=await prepared(),r=await receipt(f),raw=await observation(),result=await analyze(r,raw);expect(result.body.status).toBe('APPROVED');expect(result.body.assessment).toMatchObject({decision:'APPROVED',bankReconciled:false,effectsAuthorized:false});expect(result.body.extraction).not.toHaveProperty('destination');expect(result.body.extraction).not.toHaveProperty('beneficiary');expect(JSON.parse(decrypt(result.body.analysis_evidence_ciphertext))).toEqual(raw);expect(await contributions(f.order.id)).toHaveLength(1);expect((await admin.query('SELECT id FROM outbox WHERE workspace_id=$1 AND conversation_id=$2',[one,f.conversation.id])).rows).toEqual([]);
 });
 it('legacy-only extraction never supplies an invented complete account, holder or date',async()=>{
  const f=await prepared(),r=await receipt(f),raw=receiptDocumentEvidence(await observation(),true).legacy,result=await analyze(r,raw);expect(result.body.status).toBe('HUMAN_REVIEW');expect(result.body.assessment.reasons).toEqual(expect.arrayContaining(['DESTINATION_UNVERIFIED','BENEFICIARY_UNVERIFIED','DATE_MISSING']));expect(await contributions(f.order.id)).toEqual([]);
 });
 it('documentary mismatch is review by default and can reject only under the captured explicit rule',async()=>{
  const f=await prepared();await tx(db=>policies.writeReceiptPolicy(db,'REAL',f.draft.id,{expectedRevision:1,override:{automaticApproval:true,failureDisposition:'REJECT'}},owner.user,randomUUID()));const r=await receipt(f),raw={...await observation(),amount_minor:1},v=await analyze(r,raw);expect(v.body.status).toBe('HUMAN_REVIEW');expect(v.body.assessment.reasons).toContain('AMOUNT_MISMATCH');expect(await contributions(f.order.id)).toEqual([]);
 });
 it('same protected image on a second receipt cannot produce another contribution',async()=>{
  const f=await prepared(),image=randomBytes(32).toString('hex'),a=await receipt(f,{},image),raw=await observation();await analyze(a,raw);const b=await receipt(f,{},image),result=await analyze(b,{...await observation(),reference:randomUUID()});expect(result.body.status).toBe('HUMAN_REVIEW');expect(result.body.assessment.reasons).toContain('DUPLICATE_EVIDENCE');expect(await contributions(f.order.id)).toHaveLength(1);
 });
 it('a matching reference is conservatively reviewed even on a distinct protected image',async()=>{
  const f=await prepared(),a=await receipt(f),raw=await observation();await analyze(a,raw);const b=await receipt(f),v=await analyze(b,{...await observation(),reference:'  '+raw.reference.toUpperCase()+'  '});expect(v.body.assessment.reasons).toContain('DUPLICATE_EVIDENCE');expect(await contributions(f.order.id)).toHaveLength(1);
 });
 it('TEST and FALSE remain classified and never generate income automatically',async()=>{
  for(const classification of ['TEST','FALSE']){const f=await prepared(),r=await receipt(f,{commercial_classification:classification}),v=await analyze(r,await observation());expect(v.body.assessment.decision).toBe(classification);expect(v.body.status).toBe('HUMAN_REVIEW');expect(await contributions(f.order.id)).toEqual([]);}
 });
 it('malformed or self-authorizing extraction rolls back before changing the receipt',async()=>{
  const f=await prepared(),r=await receipt(f);await expect(analyze(r,{...await observation(),approved:true})).rejects.toThrow();expect((await read(admin,r.id)).version).toBe(r.version);expect(await contributions(f.order.id)).toEqual([]);
 });
 it('a queued human review prevents automatic replacement and recognition',async()=>{
  const f=await prepared(),r=await receipt(f);await admin.query("INSERT INTO commands(id,workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key) VALUES($1,$2,'REAL','receipt_review',$3,$4,'{}',$1::uuid::text)",[randomUUID(),one,r.id,owner.user]);await expect(analyze(r,await observation())).rejects.toThrow('RECEIPT_POLICY_HUMAN_REVIEW_PENDING');expect((await read(admin,r.id)).version).toBe(r.version);expect(await contributions(f.order.id)).toEqual([]);
 });
 it('exact replay has no second transition; a changed model result cannot overwrite the assessment',async()=>{
  const f=await prepared(),r=await receipt(f),raw=await observation(),first=await analyze(r,raw);expect((await analyze(r,raw)).version).toBe(first.version);expect(await contributions(f.order.id)).toHaveLength(1);await expect(analyze(r,{...raw,amount_minor:5})).rejects.toThrow('RECEIPT_POLICY_ANALYSIS_CONFLICT');expect((await read(admin,r.id)).version).toBe(first.version);
 });
 it('a final business failure rolls back assessment and contribution together',async()=>{
  const f=await prepared(),r=await receipt(f),raw=await observation();await expect(worker(async db=>{await applyReceiptAnalysis(db,r,raw,r.id);throw Error('FINAL_AUTHORITY_FAILED');})).rejects.toThrow('FINAL_AUTHORITY_FAILED');expect((await read(admin,r.id)).version).toBe(r.version);expect(await contributions(f.order.id)).toEqual([]);
 });
 it('declared snapshot absence cannot silently route a market order into legacy approval',async()=>{
  const f=await prepared(),foreign=await record('order',{conversation_id:f.conversation.id,receipt_policy_snapshot_sha256:'a'.repeat(64)}),r=await receipt(f,{order_id:foreign.id});await expect(analyze(r,await observation())).rejects.toThrow('RECEIPT_POLICY_SNAPSHOT_REQUIRED');expect((await read(admin,r.id)).version).toBe(r.version);
 });
 const catalogOffers:CatalogOffer[]=[
  {"product":"Costura que Vende","tiers":[{"id":"acuerdo_97","name":"Lo Acordado","minimum_total_minor":1},{"id":"apoyo_valioso_107","name":"Apoyo Valioso","minimum_total_minor":9701,"included_extra_from_minor":10700}],"amounts":[9701]},
  {"product":"Mi Ciclo Listo — Preescolar y Primaria","tiers":[{"id":"acuerdo_97","name":"Lo Acordado","minimum_total_minor":1},{"id":"apoyo_valioso_107","name":"Apoyo Valioso","minimum_total_minor":9701,"included_extra_from_minor":10700}],"amounts":[0,0,9701]},
  {"product":"Agendas para Vender 2027","tiers":[{"id":"acuerdo","name":"Acuerdo","minimum_total_minor":1},{"id":"kit","name":"Kit Presentación de Marca","minimum_total_minor":9701},{"id":"madrina","name":"Madrina","minimum_total_minor":10701,"included_extra_from_minor":10700}],"amounts":[9701]},
  {"product":"Flores y Ramos para Vender","tiers":[{"id":"acuerdo","name":"Acuerdo","minimum_total_minor":1},{"id":"kit","name":"Kit Presentación de Marca","minimum_total_minor":9701},{"id":"apoyo","name":"Apoyo voluntario al Taller","minimum_total_minor":10701,"included_extra_from_minor":10700}],"amounts":[1,9701]},
  {"product":"Galletas para Pedidos","tiers":[{"id":"acuerdo","name":"Acuerdo","minimum_total_minor":1},{"id":"kit","name":"Presenta tu marca","minimum_total_minor":9701}],"amounts":[1,9701]},
  {"product":"Velas para Regalar y Vender","tiers":[{"id":"acuerdo","name":"Acuerdo","minimum_total_minor":1},{"id":"kit","name":"Colecciones con tu Marca","minimum_total_minor":9701}],"amounts":[1,9701]},
  {"product":"Decoración con Globos para Vender","tiers":[{"id":"acuerdo","name":"Acuerdo","minimum_total_minor":1},{"id":"kit","name":"Preséntalo con tu marca","minimum_total_minor":9701}],"amounts":[1,9701]},
  {"product":"Taller de Inventos en Casa","tiers":[{"id":"acuerdo","name":"Acuerdo","minimum_total_minor":1},{"id":"kit","name":"Kit de doce desafíos","minimum_total_minor":9701}],"amounts":[9701,9701]}
 ];
 describe('verified contributions for the eight Mexican offers',()=>{
 it.each(catalogOffers.map(offer=>[offer.product,offer] as const))('recognizes real net amounts and releases the configured materials for %s',async(_name,catalog)=>{
  const f=await fixture(catalog),release=await publish(f.draft);
  await tx(db=>policies.writeReceiptPolicy(db,'REAL',f.draft.id,{expectedRevision:0,override:{automaticApproval:true,amount:{mode:'POSITIVE'}}},owner.user,randomUUID()));
  const account=await record('channel_account',{status:'PAUSED'});
  const newOrder=async()=>{
   const id=await journey(release,account);await tx(db=>store.captureMarketJourney(db,'REAL',id,release.id));
   const conversation=await read(admin,id),order=(await worker(db=>ensureOrder(db,conversation)))!;
   return {conversation,order,release};
  };
  const approved=async(caseOrder:Awaited<ReturnType<typeof newOrder>>,amount:number,channel:'spei'|'spin_cash',reference:string=randomUUID())=>{
   const r=await receipt(caseOrder),raw={...await observation(),reference,amount_minor:amount,payment_channel:channel,
    destination:channel==='spei'?'012345678901234567':'4242424242424242',...(channel==='spin_cash'?{cash_total_minor:amount+1500,service_fee_minor:1500}:{})};
   return analyze(r,raw);
  };
  for(const channel of ['spei','spin_cash'] as const){
   for(const amount of [0,1,5000,8000,9000,9700,9701,10000,10700]){
    const item=await newOrder(),result=await approved(item,amount,channel);
    expect(result.body.status).toBe(amount>0?'APPROVED':'HUMAN_REVIEW');
    const sale=await read(admin,item.order.id);
    expect(Number(sale.body.sale_amount_minor??0)).toBe(amount);
    if(amount>0)expect(sale.body.sale_effects_applied_at).toBeTruthy();
    const deliveries=await admin.query("SELECT body->>'asset_id' asset FROM records WHERE workspace_id=$1 AND kind='fulfillment' AND body->>'order_id'=$2",[one,item.order.id]);
    const eligible=amount>0?await worker(db=>eligibleFulfillmentItems(db,sale,'receipt_approved')):[];
    expect(eligible).toHaveLength(amount>0?catalog.amounts.filter(min=>amount>=min).length:0);
    // This fixture has a paused channel. Every proposed item must be entitled and unique.
    expect(deliveries.rows.every(row=>eligible.some((f:{asset_id:string})=>f.asset_id===row.asset))).toBe(true);
    expect(new Set(deliveries.rows.map(row=>row.asset)).size).toBe(deliveries.rows.length);
   }
  }
  const split=await newOrder(),reference=randomUUID();
  expect((await approved(split,5000,'spei',reference)).body.status).toBe('APPROVED');
  expect((await approved(split,5000,'spei',reference)).body.status).toBe('HUMAN_REVIEW');
  expect((await approved(split,4800,'spin_cash')).body.status).toBe('APPROVED');
  expect((await read(admin,split.order.id)).body.sale_amount_minor).toBe(9800);
  expect(await contributions(split.order.id)).toHaveLength(2);
 },120000);
});

});
