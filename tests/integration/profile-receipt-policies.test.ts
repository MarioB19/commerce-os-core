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

const suffix=randomBytes(8).toString('hex'),login='f5_policy_'+suffix;
const one='policy_one_'+suffix,two='policy_two_'+suffix,origin='http://localhost:5173';
const password='synthetic-market-password123',locale={market:'México',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'};
let admin:pg.Pool,runtime:pg.Pool,app:FastifyInstance,address:string,passwordHash:string,owner:{user:string;cookie:string;session:InteractiveSession};
const tables=['receipt_policy_heads','receipt_policy_versions','receipt_policy_operations','receipt_order_policy_snapshots'];
async function transaction<T>(work:(c:pg.PoolClient)=>Promise<T>){const c=await runtime.connect();try{await c.query('BEGIN');const result=await work(c);expect((await c.query('COMMIT')).command).toBe('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function nativeSession(req:FastifyRequest){return transaction(async c=>{const v=await createAuth(c).api.getSession({headers:fromNodeHeaders(req.headers),query:{disableRefresh:true}});return v&&v.session.userId===v.user.id?{id:v.session.id,userId:v.user.id}:null;});}
function tx<T>(work:(db:ProfileExecutor)=>Promise<T>,account=owner){return withProfileSessionTransaction(runtime,account.session,{workspaceId:one,version:1},{scope:'receipt-rules:write',mutation:true},async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");return work(db);});}
function worker<T>(work:(db:ProfileExecutor)=>Promise<T>){return withProfileTransaction(runtime,one,async db=>{await db.query("SET LOCAL ROLE commerce_automation");await db.query("SELECT set_config('app.environment','REAL',true)");return work(db);});}
async function request(path:string,body?:object,headers:Record<string,string>={},method=body?'POST':'GET'){
 return fetch(address+path,{method,redirect:'error',headers:{origin,...headers,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
}
function headers(account=owner){return{cookie:account.cookie,'x-commerce-profile-id':one,'x-commerce-profile-version':'1','idempotency-key':randomUUID()};}
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
 const flow=await record('workflow',{status:'PUBLISHED',product_id:product.id}),seller=await record('agent',{product_id:product.id});
 const collection=await record('bank_profile',{currency:'MXN',private_sentinel:'not returned'}),material=await record('asset',{status:'READY'});
 const offer=await record('offer',{product_id:product.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:10000,
 workflow_version_id:flow.id,agent_version_id:seller.id,payment_profile_version_id:collection.id,fulfillment:[{asset_id:material.id}]});
 const fields:MarketDraftFields={locale:{...locale},amount_minor:10000,configuration:{offer,flow,seller,collection,remarketing:offer,materials:[material]}};
 await tx(db=>store.adoptMarketFamily(db,'REAL',{product_id:product.id,expected_product_version:1}));
 const draft=await tx(db=>store.createMarketDraft(db,'REAL',{family_id:product.id,fields},owner.user));return{product,fields,draft};
}
async function publish(draft:{id:string;version:number;draft_sha256:string}){return tx(db=>store.publishMarketRelease(db,'REAL',draft.id,{expected_version:draft.version,draft_sha256:draft.draft_sha256,reviewed_fields:[...marketCopyReviewFields]},owner.user));}
async function journey(release:MarketRelease){
 const account=await record('channel_account',{status:'PAUSED'}),contact=await record('contact',{name:'Synthetic'}),c=release.configuration;
 const binding=await record('binding',{account_id:account.id,offer_version_id:c.offer.id,workflow_version_id:c.flow.id,agent_version_id:c.seller.id});
 return(await record('conversation',{product_id:release.family_id,account_id:account.id,contact_id:contact.id,binding_id:binding.id,offer_version_id:c.offer.id,workflow_version_id:c.flow.id,agent_version_id:c.seller.id})).id;
}

import {receiptPolicyRoutes} from '../../apps/api/src/receipt-policies.js';
import * as policies from '../../packages/db/src/receipt-policies.js';
import {defaultReceiptPolicy,receiptPolicyHash} from '../../packages/domain/src/sales/receipt-policy.js';

// V7 F2: cases admit their own REAL numbers; earlier cases' reservations are
// retired (test-only) so the installation stays within 20 connected numbers.
beforeEach(async()=>{if(admin)await releaseFixtureNumbers(admin);});
describe('F5 receipt policy native PostgreSQL and authority',()=>{
 beforeAll(async()=>{
  vi.stubEnv('BETTER_AUTH_SECRET','synthetic-market-'+randomBytes(32).toString('hex'));passwordHash=await hashPassword(password);
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:4,connectionTimeoutMillis:5000});
  await requireMigratedProfileSchema(admin);
  const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT commerce_api,commerce_automation TO "${login}"`);
  // Existing commercial tables receive fixture-owned policies only. New market
  // tables use exactly the production-proposed 008 FORCE RLS and grants.
  for(const table of ['records','record_versions','personal_access_tokens'])await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;CREATE POLICY market_fixture ON ${table} USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),''))`);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic Market','UTC',10,100,100),($2,'Synthetic Foreign','UTC',10,100,100)",[one,two]);await sealFixtureProfiles(admin,one,two);
  url.username=login;url.password=secret;runtime=new pg.Pool({connectionString:url.toString(),options:'-c role=commerce_api',max:5,connectionTimeoutMillis:5000});
  app=Fastify({logger:false,disableRequestLogging:true});app.setErrorHandler((e:any,_r,reply)=>reply.code(e instanceof ZodError?400:e.statusCode??500).send({error:{code:e.code??'INTERNAL_ERROR'}}));
  await profileIdentityRoutes(app,{origins:[origin],session:nativeSession,list:s=>listProfileChoicesFromSession(runtime,s),select:(s,w,v)=>transaction(c=>selectProfileFromSession(c,s,w,v))});
  await receiptPolicyRoutes(app,{origins:[origin],nativeSession,session:(s,f,environment,action,work)=>withProfileSessionTransaction(runtime,s,f,action,(db,profile)=>db.query("SELECT set_config('app.environment',$1,true)",[environment]).then(()=>work({db,profile,environment}))),personal:(t,environment,action,work)=>withPersonalProfileTransaction(runtime,t,environment,action,(db,profile)=>db.query("SELECT set_config('app.environment',$1,true)",[environment]).then(()=>work({db,profile,environment})))});
  app.post('/api/auth/*',{bodyLimit:4096},async(req,reply)=>{if(req.headers.origin!==origin)return reply.code(403).send({error:'ORIGIN'});const result=await transaction(c=>createAuth(c).handler(new Request('http://localhost:3001'+req.url,{method:'POST',headers:fromNodeHeaders(req.headers),body:JSON.stringify(req.body)})));reply.code(result.status);if(result.ok)reply.header('set-cookie',result.headers.getSetCookie());return{signedIn:result.ok};});
  address=await app.listen({host:'127.0.0.1',port:0});owner=await account();await tx(db=>policies.writeReceiptPolicy(db,'REAL',null,{expectedRevision:0,policy:defaultReceiptPolicy()},owner.user,randomUUID()));
 });
 afterAll(async()=>{await app?.close();await runtime?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}vi.unstubAllEnvs();});
 it('forces workspace and environment RLS with no pooled context or worker config-write grants',async()=>{
  for(const t of tables){expect((await runtime.query('SELECT * FROM '+t)).rows).toEqual([]);expect((await admin.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',[t])).rows[0]).toEqual({relrowsecurity:true,relforcerowsecurity:true});}
  for(const t of ['receipt_policy_heads','receipt_policy_versions','receipt_policy_operations'])for(const role of ['commerce_automation','commerce_channel','commerce_ingress'])expect((await admin.query("SELECT has_table_privilege($1,$2,'INSERT') allowed",[role,t])).rows[0].allowed).toBe(false);
  await expect(withProfileTransaction(runtime,one,db=>policies.readReceiptPolicy(db,'REAL',null))).rejects.toThrow('RECEIPT_POLICY_CONTEXT');
  await expect(tx(db=>policies.readReceiptPolicy({...db,workspaceId:two},'REAL',null))).rejects.toThrow('RECEIPT_POLICY_CONTEXT');
 });
 it('SQL validates closed complete and partial shapes rather than trusting TypeScript',async()=>{
  const valid=defaultReceiptPolicy();expect((await admin.query('SELECT valid_receipt_policy($1,false) full,valid_receipt_policy($2,true) partial',[valid,{}])).rows[0]).toEqual({full:true,partial:true});
  for(const bad of [null,{}, {...valid,automaticApproval:null},{...valid,unexpected:true},{...valid,amount:{mode:'TOLERANCE',toleranceMinor:0.5}},{...valid,minimumConfidenceBps:10001},{...valid,destination:{mode:'SUFFIX',digits:3}},{...valid,date:{...valid.date,maximumAgeDays:null}},{...valid,reference:{required:true,match:'REGEX'}}])expect((await admin.query('SELECT valid_receipt_policy($1,false) ok',[bad])).rows[0].ok).toBe(false);
  expect((await admin.query('SELECT valid_receipt_policy($1,true) ok',[{amount:null}])).rows[0].ok).toBe(false);
 });
 it('hashes native canonical JSON identically for all policy forms',async()=>{
  for(const body of [defaultReceiptPolicy(),{}, {amount:{mode:'TOLERANCE',toleranceMinor:Number.MAX_SAFE_INTEGER}},{destination:{mode:'SUFFIX',digits:8},automaticApproval:true}])expect((await admin.query("SELECT encode(sha256(convert_to(receipt_policy_canonical($1),'UTF8')),'hex') h",[body])).rows[0].h).toBe(receiptPolicyHash(body));
 });
 it('reads the profile baseline through a real Better Auth cookie and protected TCP route',async()=>{
  const r=await request('/v2/payments/policies/profile',undefined,headers());expect(r.status).toBe(200);expect((await r.json()).data.body).toEqual(defaultReceiptPolicy());expect(r.headers.get('cache-control')).toBe('no-store');
 });
 it('persists an exact variant override and resolves current profile inheritance',async()=>{
  const f=await fixture(),override={amount:{mode:'MINIMUM' as const},automaticApproval:true};const r=await request('/v2/payments/policies/variants/'+f.draft.id,{expectedRevision:0,override},headers(),'PUT');expect(r.status).toBe(200);
  const value=await(await request('/v2/payments/policies/variants/'+f.draft.id,undefined,headers())).json();expect(value.data.body).toEqual(override);expect(value.effective.policy).toEqual({...defaultReceiptPolicy(),...override});expect(value.effective.variant).toEqual((await r.json()).data.ref);
 });
 it('allows an empty override as explicit return to inheritance without deleting history',async()=>{
  const f=await fixture(),first=await tx(db=>policies.writeReceiptPolicy(db,'REAL',f.draft.id,{expectedRevision:0,override:{automaticApproval:true}},owner.user,randomUUID()));
  const second=await tx(db=>policies.writeReceiptPolicy(db,'REAL',f.draft.id,{expectedRevision:1,override:{}},owner.user,randomUUID()));expect(second.ref.revision).toBe(2);expect((await tx(db=>policies.effectiveReceiptPolicy(db,'REAL',f.draft.id))).policy.automaticApproval).toBe(false);
  expect((await admin.query('SELECT body FROM receipt_policy_versions WHERE id=$1',[first.ref.id])).rows[0].body).toEqual({automaticApproval:true});
 });
 it('commits an operation receipt with the write and uses exact replay or GET after uncertainty',async()=>{
  const f=await fixture(),op=randomUUID(),body={expectedRevision:0,override:{automaticApproval:true}},h={...headers(),'idempotency-key':op};const path='/v2/payments/policies/variants/'+f.draft.id;
  const first=await request(path,body,h,'PUT');expect(first.status).toBe(200);const value=(await first.json()).data;
  expect((await(await request('/v2/payments/policies/operations/'+op,undefined,headers())).json()).data).toEqual(value);
  expect((await(await request(path,body,h,'PUT')).json()).data).toEqual(value);
  expect((await request(path,{...body,override:{}},h,'PUT')).status).toBe(409);
  expect((await admin.query('SELECT count(*)::int n FROM receipt_policy_versions WHERE id=$1',[value.ref.id])).rows[0].n).toBe(1);
 });
 it('concurrent expected revisions commit exactly one version without a lost update',async()=>{
  const f=await fixture(),results=await Promise.allSettled([true,false].map(automaticApproval=>tx(db=>policies.writeReceiptPolicy(db,'REAL',f.draft.id,{expectedRevision:0,override:{automaticApproval}},owner.user,randomUUID()))));
  expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(results.filter(x=>x.status==='rejected')).toHaveLength(1);expect((await tx(db=>policies.readReceiptPolicy(db,'REAL',f.draft.id)))?.ref.revision).toBe(1);
 });
 it('denies foreign variants, wrong environment and immutable version updates',async()=>{
  const f=await fixture();await tx(db=>policies.writeReceiptPolicy(db,'REAL',f.draft.id,{expectedRevision:0,override:{}},owner.user,randomUUID()));
  await expect(tx(db=>policies.writeReceiptPolicy(db,'REAL',randomUUID(),{expectedRevision:0,override:{}},owner.user,randomUUID()))).rejects.toThrow('RECEIPT_POLICY_VARIANT_NOT_FOUND');
  await expect(tx(db=>policies.readReceiptPolicy(db,'SIMULATION',null))).rejects.toThrow('RECEIPT_POLICY_CONTEXT');
  await expect(tx(db=>db.query("UPDATE receipt_policy_versions SET body='{}'"))).rejects.toMatchObject({code:'42501'});
  const current=await tx(db=>policies.readReceiptPolicy(db,'REAL',null));await expect(admin.query("UPDATE receipt_policy_versions SET body='{}' WHERE id=$1",[current!.ref.id])).rejects.toThrow('IMMUTABLE_EVIDENCE');
 });
 it('never returns a write when authority has changed, or to a viewer or an untrusted origin',async()=>{
  const f=await fixture(),viewer=await account('viewer'),body={expectedRevision:0,override:{}};
  expect((await request('/v2/payments/policies/variants/'+f.draft.id,body,headers(viewer),'PUT')).status).toBe(403);
  expect((await request('/v2/payments/policies/variants/'+f.draft.id,body,{...headers(),origin:'https://other.invalid'},'PUT')).status).toBe(403);
  const fresh=await account();await admin.query('UPDATE memberships SET active=false WHERE workspace_id=$1 AND user_id=$2',[one,fresh.user]);expect((await request('/v2/payments/policies/variants/'+f.draft.id,body,headers(fresh),'PUT')).status).toBe(403);
  expect(await tx(db=>policies.readReceiptPolicy(db,'REAL',f.draft.id))).toBeNull();
 });
 it('rejects extra request authority and partial nested rules before any write',async()=>{
  const f=await fixture();for(const body of [{expectedRevision:0,override:{},workspaceId:two},{expectedRevision:0,override:{date:{required:true}}},{expectedRevision:0,override:{automaticApproval:null}}])expect((await request('/v2/payments/policies/variants/'+f.draft.id,body,headers(),'PUT')).status).toBe(400);
  expect(await tx(db=>policies.readReceiptPolicy(db,'REAL',f.draft.id))).toBeNull();
 });
 it('captures authenticated order and journey identity and keeps old policy after later edits',async()=>{
  const f=await fixture(),release=await publish(f.draft),jid=await journey(release.release);await tx(db=>store.captureMarketJourney(db,'REAL',jid,release.release.id));const order={id:randomUUID()};
  const first=await worker(async db=>{await db.query("INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,'REAL','order',$3)",[order.id,one,{conversation_id:jid}]);return policies.captureOrderReceiptPolicy(db,'REAL',order.id);});const profile=await tx(db=>policies.readReceiptPolicy(db,'REAL',null));
  await tx(db=>policies.writeReceiptPolicy(db,'REAL',null,{expectedRevision:profile!.ref.revision,policy:{...defaultReceiptPolicy(),minimumConfidenceBps:9999}},owner.user,randomUUID()));
  expect(await tx(db=>policies.captureOrderReceiptPolicy(db,'REAL',order.id))).toEqual(first);expect((await tx(db=>policies.effectiveReceiptPolicy(db,'REAL',f.draft.id))).policy.minimumConfidenceBps).toBe(9999);
  await expect(admin.query("UPDATE receipt_order_policy_snapshots SET body=body||'{\"changed\":true}' WHERE order_id=$1",[order.id])).rejects.toThrow('IMMUTABLE_EVIDENCE');
  const now=await tx(db=>policies.readReceiptPolicy(db,'REAL',null));await tx(db=>policies.writeReceiptPolicy(db,'REAL',null,{expectedRevision:now!.ref.revision,policy:defaultReceiptPolicy()},owner.user,randomUUID()));
 });
 it('refuses old or unrelated orders instead of pretending a policy was historically captured',async()=>{
  const orphanConversation=await record('conversation',{}),order=await record('order',{conversation_id:orphanConversation.id});await expect(tx(db=>policies.captureOrderReceiptPolicy(db,'REAL',order.id))).rejects.toThrow('RECEIPT_POLICY_ORDER_SCOPE');
  const f=await fixture(),release=await publish(f.draft),jid=await journey(release.release);await tx(db=>store.captureMarketJourney(db,'REAL',jid,release.release.id));const old=await record('order',{conversation_id:jid});await expect(tx(db=>policies.captureOrderReceiptPolicy(db,'REAL',old.id))).rejects.toThrow('RECEIPT_POLICY_ORDER_SCOPE');await admin.query('UPDATE records SET version=version+1 WHERE id=$1',[old.id]);await expect(tx(db=>policies.captureOrderReceiptPolicy(db,'REAL',old.id))).rejects.toThrow('RECEIPT_POLICY_ORDER_SCOPE');
 });
 it('native trigger rejects a rehashed snapshot with a forged variant or effective rule',async()=>{
  const f=await fixture(),release=await publish(f.draft),jid=await journey(release.release);await tx(db=>store.captureMarketJourney(db,'REAL',jid,release.release.id));const order=await record('order',{conversation_id:jid}),resolved=await tx(db=>policies.effectiveReceiptPolicy(db,'REAL',f.draft.id));
  const {sha256:_,...body}=resolved;void _;const changed={...body,policy:{...body.policy,automaticApproval:true}},digest=receiptPolicyHash(changed);
  await expect(tx(db=>db.query('INSERT INTO receipt_order_policy_snapshots(workspace_id,environment,order_id,variant_id,profile_version_id,body,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[one,'REAL',order.id,f.draft.id,resolved.profile.id,{...changed,sha256:digest},digest]))).rejects.toThrow('RECEIPT_POLICY_SNAPSHOT_CHANGED');
  expect(await tx(db=>policies.readOrderReceiptPolicy(db,'REAL',order.id))).toBeNull();
 });
 it('rolls back configuration and operation together on a later business error',async()=>{
  const f=await fixture(),op=randomUUID();await expect(tx(async db=>{await policies.writeReceiptPolicy(db,'REAL',f.draft.id,{expectedRevision:0,override:{}},owner.user,op);throw Error('SYNTHETIC_LATE_ERROR');})).rejects.toThrow('SYNTHETIC_LATE_ERROR');
  expect(await tx(db=>policies.readReceiptPolicy(db,'REAL',f.draft.id))).toBeNull();await expect(tx(db=>policies.readReceiptPolicyOperation(db,'REAL',owner.user,op))).rejects.toThrow('RECEIPT_POLICY_OPERATION_NOT_FOUND');
 });
});
