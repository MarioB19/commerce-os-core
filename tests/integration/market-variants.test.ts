import {randomBytes,randomUUID,createHash} from 'node:crypto';
import Fastify,{type FastifyInstance,type FastifyRequest} from 'fastify';
import {fromNodeHeaders} from 'better-auth/node';
import {hashPassword} from 'better-auth/crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {ZodError} from 'zod';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {listProfileChoicesFromSession,selectProfileFromSession} from '../../packages/db/src/profile-identity-bootstrap.js';
import {requireMigratedProfileSchema,sealFixtureProfiles} from '../support/migrated-database.js';
import {createAuth} from '../../apps/api/src/auth.js';
import {marketVariantRoutes} from '../../apps/api/src/market-variants.js';
import {profileIdentityRoutes} from '../../apps/api/src/profile-identity.js';
import {type InteractiveSession} from '../../packages/db/src/profile-session.js';
import {withProfileTransaction,type ProfileExecutor} from '../../packages/db/src/profile-context.js';
import {withProfileSessionTransaction} from '../../packages/db/src/profile-session-transaction.js';
import {withPersonalProfileTransaction} from '../../packages/db/src/profile-personal-token.js';
import * as store from '../../packages/db/src/market-variants.js';
import {marketCopyReviewFields,type MarketRelease} from '../../packages/contracts/src/market-variants.js';
import {type MarketDraftFields} from '../../packages/contracts/src/market-variant-store.js';
import {marketDraftViewSchema} from '../../packages/contracts/src/market-variant-client.js';
import {personalMarketVariants,sessionMarketVariants} from '../../packages/commerce-client/src/market-variants.js';
import {createProfileMcp} from '../../apps/commerce-mcp/src/profile-server.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';

const suffix=randomBytes(8).toString('hex'),login='f4_variants_'+suffix;
const one='market_one_'+suffix,two='market_two_'+suffix,origin='http://localhost:5173';
const password='synthetic-market-password123',locale={market:'México',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'};
let admin:pg.Pool,runtime:pg.Pool,app:FastifyInstance,address:string,passwordHash:string,owner:{user:string;cookie:string;session:InteractiveSession};
const tables=['market_families','market_variants','market_releases','market_journey_snapshots','market_variant_events','market_operations'];
async function transaction<T>(work:(c:pg.PoolClient)=>Promise<T>){const c=await runtime.connect();try{await c.query('BEGIN');const result=await work(c);expect((await c.query('COMMIT')).command).toBe('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function nativeSession(req:FastifyRequest){return transaction(async c=>{const v=await createAuth(c).api.getSession({headers:fromNodeHeaders(req.headers),query:{disableRefresh:true}});return v&&v.session.userId===v.user.id?{id:v.session.id,userId:v.user.id}:null;});}
function tx<T>(work:(db:ProfileExecutor)=>Promise<T>,account=owner){return withProfileSessionTransaction(runtime,account.session,{workspaceId:one,version:1},{scope:'variants:write',mutation:true},work);}
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

describe('F4 persisted variants with native profile authority and restricted PostgreSQL',()=>{
 beforeAll(async()=>{
  vi.stubEnv('BETTER_AUTH_SECRET','synthetic-market-'+randomBytes(32).toString('hex'));passwordHash=await hashPassword(password);
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:4,connectionTimeoutMillis:5000});
  await requireMigratedProfileSchema(admin);
  const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT commerce_api TO "${login}"`);
  // Existing commercial tables receive fixture-owned policies only. New market
  // tables use exactly the production-proposed 008 FORCE RLS and grants.
  for(const table of ['records','record_versions','personal_access_tokens'])await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;CREATE POLICY market_fixture ON ${table} USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),''))`);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic Market','UTC',10,100,100),($2,'Synthetic Foreign','UTC',1,100,100)",[one,two]);await sealFixtureProfiles(admin,one,two);
  url.username=login;url.password=secret;runtime=new pg.Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:5000});
  app=Fastify({logger:false,disableRequestLogging:true});app.setErrorHandler((e:any,_r,reply)=>reply.code(e instanceof ZodError?400:e.statusCode??500).send({error:{code:e.code??'INTERNAL_ERROR'}}));
  await profileIdentityRoutes(app,{origins:[origin],session:nativeSession,list:s=>listProfileChoicesFromSession(runtime,s),select:(s,w,v)=>transaction(c=>selectProfileFromSession(c,s,w,v))});
  await marketVariantRoutes(app,{origins:[origin],nativeSession,session:(s,f,environment,action,work)=>withProfileSessionTransaction(runtime,s,f,action,(db,profile)=>work({db,profile,environment})),personal:(t,environment,action,work)=>withPersonalProfileTransaction(runtime,t,environment,action,(db,profile)=>work({db,profile,environment}))});
  app.post('/api/auth/*',{bodyLimit:4096},async(req,reply)=>{if(req.headers.origin!==origin)return reply.code(403).send({error:'ORIGIN'});const result=await transaction(c=>createAuth(c).handler(new Request('http://localhost:3001'+req.url,{method:'POST',headers:fromNodeHeaders(req.headers),body:JSON.stringify(req.body)})));reply.code(result.status);if(result.ok)reply.header('set-cookie',result.headers.getSetCookie());return{signedIn:result.ok};});
  address=await app.listen({host:'127.0.0.1',port:0});owner=await account();
 });
 afterAll(async()=>{await app?.close();await runtime?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}vi.unstubAllEnvs();});
 it('enforces proposed RLS/grants without superuser or bypass and no pooled context leak',async()=>{
  expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
  for(const table of tables){expect((await runtime.query('SELECT * FROM '+table)).rows).toEqual([]);expect((await admin.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',[table])).rows[0]).toEqual({relrowsecurity:true,relforcerowsecurity:true});for(const role of ['commerce_ingress','commerce_channel','commerce_automation'])expect((await admin.query("SELECT has_table_privilege($1,$2,'INSERT') allowed",[role,table])).rows[0].allowed).toBe(role==='commerce_automation'&&table==='market_journey_snapshots');}
  // F4 (0105): only the automation worker pins a new conversation's release; it never writes catalog rows.
  expect((await admin.query("SELECT has_column_privilege('commerce_automation','market_variants','collection_ciphertext','SELECT') allowed")).rows[0].allowed).toBe(false);
  await expect(withProfileTransaction(runtime,one,db=>db.query("INSERT INTO market_operations(workspace_id,environment,actor_id,operation_id,request_hash,result) VALUES($1,'REAL','synthetic',$2,$3,'{}')",[two,randomUUID(),'a'.repeat(64)]))).rejects.toMatchObject({code:'42501'});
 });
 it('adopts actual product identity and refuses foreign/environment/type or changed product',async()=>{
  const f=await fixture();expect(f.draft.family_id).toBe(f.product.id);
  for(const [ref,env]of [[await record('product',{},two),'REAL'],[f.product,'SIMULATION'],[await record('asset',{}),'REAL']]as const)await expect(tx(db=>store.adoptMarketFamily(db,env,{product_id:ref.id,expected_product_version:1}))).rejects.toMatchObject({statusCode:404});
  await expect(tx(db=>store.adoptMarketFamily(db,'REAL',{product_id:f.product.id,expected_product_version:2}))).rejects.toMatchObject({code:'MARKET_PRODUCT_CHANGED'});
 });
 it('publishes immutable versions and retains an old journey snapshot through later publication',async()=>{
  const f=await fixture(),first=await publish(f.draft),jid=await journey(first.release);
  const snap=await tx(db=>store.captureMarketJourney(db,'REAL',jid,first.release.id));expect(snap.release.amount_minor).toBe(10000);
  const draft=await tx(db=>store.replaceMarketDraft(db,'REAL',f.draft.id,{expected_version:2,fields:{...f.fields,locale:{...locale,market:'México Norte'}}},owner.user));
  const second=await publish(draft);expect(second.release.revision).toBe(2);expect(second.release.id).not.toBe(first.release.id);
  expect(await tx(db=>store.readMarketJourney(db,'REAL',jid))).toEqual(snap);expect(await tx(db=>store.readMarketRelease(db,'REAL',first.release.id))).toEqual(first.release);
  await expect(tx(db=>store.captureMarketJourney(db,'REAL',jid,second.release.id))).rejects.toMatchObject({code:'MARKET_JOURNEY_SNAPSHOT_CONFLICT'});
  for(const table of ['market_releases','market_journey_snapshots'])await expect(tx(db=>db.query(`UPDATE ${table} SET body=body||'{"changed":true}'`))).rejects.toMatchObject({code:'42501'});
  await expect(admin.query('DELETE FROM market_releases WHERE id=$1',[first.release.id])).rejects.toThrow('IMMUTABLE_EVIDENCE');
 });
 it('authenticates six configuration references and refuses incoherent price or missing review',async()=>{
  const f=await fixture();
  for(const fields of [
   {...f.fields,amount_minor:9999},
   {...f.fields,configuration:{...f.fields.configuration,flow:{...f.fields.configuration.flow,sha256:'f'.repeat(64)}}},
   {...f.fields,configuration:{...f.fields.configuration,materials:[]}},
   {...f.fields,configuration:{...f.fields.configuration,remarketing:f.fields.configuration.flow}},
   {...f.fields,configuration:{...f.fields.configuration,collection:await record('bank_profile',{currency:'USD'})}},
  ]){
   const d=await tx(db=>store.createMarketDraft(db,'REAL',{family_id:f.product.id,fields},owner.user));await expect(publish(d)).rejects.toThrow();
   expect((await admin.query('SELECT count(*)::int n FROM market_releases WHERE variant_id=$1',[d.id])).rows[0].n).toBe(0);
  }
  await expect(tx(db=>store.publishMarketRelease(db,'REAL',f.draft.id,{expected_version:1,draft_sha256:f.draft.draft_sha256,reviewed_fields:[]},owner.user))).rejects.toBeInstanceOf(ZodError);
 });
 it('CAS serializes concurrent edits and commits exactly one revision/audit',async()=>{
  const f=await fixture();const results=await Promise.allSettled([1,2].map(n=>tx(db=>store.replaceMarketDraft(db,'REAL',f.draft.id,{expected_version:1,fields:{...f.fields,locale:{...locale,market:'Market '+n}}},owner.user))));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect((await tx(db=>store.readMarketVariant(db,'REAL',f.draft.id))).version).toBe(2);
  expect((await admin.query('SELECT count(*)::int n FROM market_variant_events WHERE variant_id=$1',[f.draft.id])).rows[0].n).toBe(2);
 });
 it('copies only a draft and retains immutable source provenance without changing original',async()=>{
  const f=await fixture(),published=await publish(f.draft);
  const copied=await tx(db=>store.copyMarketDraft(db,'REAL',{source_release_id:published.release.id,locale:{...locale,market:'Colombia',currency:'COP',language:'es-CO',timezone:'America/Bogota'}},owner.user));
  expect(copied.id).not.toBe(f.draft.id);expect(copied.source_release_id).toBe(published.release.id);expect(copied.current_release_id).toBeNull();expect(copied.pending_review).toEqual(marketCopyReviewFields);expect(copied.publication_authorized).toBe(false);
  expect((await tx(db=>store.readMarketVariant(db,'REAL',copied.id))).source_release_id).toBe(published.release.id);await expect(publish(copied)).rejects.toMatchObject({code:'MARKET_PRICE_CHANGED'});
 });
 it('commits operation receipt with creation and rejects content change; uncertain reply uses GET only',async()=>{
  const f=await fixture(),key=randomUUID(),body={family_id:f.product.id,fields:f.fields},h={...headers(),'idempotency-key':key};
  const first=await request('/v2/market/variants?environment=REAL',body,h);expect(first.status).toBe(200);const value=(await first.json()).data;
  const read=await request('/v2/market/operations/'+key+'?environment=REAL',undefined,headers());expect((await read.json()).data).toEqual(value);
  const repeat=await request('/v2/market/variants?environment=REAL',body,h);expect((await repeat.json()).data).toEqual(value);
  expect((await request('/v2/market/variants?environment=REAL',{...body,fields:{...body.fields,amount_minor:1}},h)).status).toBe(409);
  expect((await admin.query('SELECT count(*)::int n FROM market_variants WHERE id=$1',[value.id])).rows[0].n).toBe(1);
  expect(JSON.stringify(value)).not.toContain('private_sentinel');
 });
 it('lists bounded family pages with real SQL and no foreign/environment fallback',async()=>{
  const f=await fixture();await tx(db=>store.createMarketDraft(db,'REAL',{family_id:f.product.id,fields:f.fields},owner.user));
  const first=await request('/v2/market/variants?environment=REAL&family_id='+f.product.id+'&limit=1',undefined,headers());expect(first.status).toBe(200);const page=await first.json();expect(page.data).toHaveLength(1);expect(page.meta.has_more).toBe(true);
  const second=await(await request('/v2/market/variants?environment=REAL&family_id='+f.product.id+'&limit=1&after='+page.meta.next,undefined,headers())).json();expect(second.data).toHaveLength(1);expect(second.data[0].id).not.toBe(page.data[0].id);expect(second.meta.has_more).toBe(false);
  expect((await request('/v2/market/variants?environment=SIMULATION&family_id='+f.product.id,undefined,headers())).status).toBe(404);
  expect((await request('/v2/market/variants?environment=REAL&family_id='+f.product.id+'&limit=101',undefined,headers())).status).toBe(400);
 });
 it('uses native PAT profile/scope/environment and rechecks revocation instead of cookie fallback',async()=>{
  const f=await fixture(),secret='cos_pat_'+randomBytes(32).toString('base64url'),id=randomUUID();
  await admin.query(`INSERT INTO personal_access_tokens(id,workspace_id,user_id,name,token_hash,allowed_environments,profile_scopes,expires_at)
   VALUES($1,$2,$3,'Synthetic variants',$4,'["REAL"]','["variants:read"]',clock_timestamp()+interval '1 hour')`,[id,one,owner.user,createHash('sha256').update(secret).digest('hex')]);
  const h={authorization:'Bearer '+secret,cookie:owner.cookie,'idempotency-key':randomUUID()};
  expect((await request('/v2/market/variants/'+f.draft.id.toUpperCase()+'?environment=REAL',undefined,h)).status).toBe(200);
  expect((await request('/v2/market/variants?environment=REAL',{family_id:f.product.id,fields:f.fields},h)).status).toBe(403);
  expect((await request('/v2/market/variants/'+f.draft.id+'?environment=SIMULATION',undefined,h)).status).toBe(401);
  await admin.query('UPDATE personal_access_tokens SET revoked_at=clock_timestamp() WHERE id=$1',[id]);
  expect((await request('/v2/market/variants/'+f.draft.id+'?environment=REAL',undefined,h)).status).toBe(401);
 });
 it('runs the shared client over TCP, reconciles a lost committed reply and preserves copy/publication contracts',async()=>{
  const f=await fixture(),secret='cos_pat_'+randomBytes(32).toString('base64url'),tokenId=randomUUID();
  await admin.query(`INSERT INTO personal_access_tokens(id,workspace_id,user_id,name,token_hash,allowed_environments,profile_scopes,expires_at)
   VALUES($1,$2,$3,'Synthetic shared market client',$4,'["REAL"]','["variants:read","variants:write"]',clock_timestamp()+interval '1 hour')`,[tokenId,one,owner.user,createHash('sha256').update(secret).digest('hex')]);
  let loseReply=true,posts=0;
  const transport:typeof fetch=async(input,init)=>{
   if(init?.method==='POST')posts++;
   const response=await fetch(input,init);
   if(loseReply&&init?.method==='POST'){loseReply=false;expect(response.status).toBe(200);await response.arrayBuffer();throw Error('synthetic reply lost after native COMMIT');}
   return response;
  };
  const client=personalMarketVariants(address,secret,transport),operation_id=randomUUID(),command={operation:'create',environment:'REAL',operation_id,body:{family_id:f.product.id,fields:f.fields}};
  await expect(client(command)).rejects.toMatchObject({code:'MARKET_WRITE_UNCONFIRMED'});expect(posts).toBe(1);
  const recovered=marketDraftViewSchema.parse((await client({operation:'reconcile',environment:'REAL',id:operation_id})).data);expect(posts).toBe(1);
  expect((await admin.query('SELECT count(*)::int n FROM market_operations WHERE operation_id=$1',[operation_id])).rows[0].n).toBe(1);
  const replaced=marketDraftViewSchema.parse((await client({operation:'replace',environment:'REAL',id:recovered.id,operation_id:randomUUID(),body:{expected_version:1,fields:{...f.fields,locale:{...locale,market:'México cliente'}}}})).data);
  const published=(await client({operation:'publish',environment:'REAL',id:replaced.id,operation_id:randomUUID(),body:{expected_version:2,draft_sha256:replaced.draft_sha256,reviewed_fields:[...marketCopyReviewFields]}})).data;
  if(!('release'in published))throw Error('Expected canonical published result');
  expect((await client({operation:'release',environment:'REAL',id:published.release.id})).data).toEqual(published.release);
  const copied=(await client({operation:'copy',environment:'REAL',operation_id:randomUUID(),body:{source_release_id:published.release.id,locale:{...locale,market:'Colombia',currency:'COP'}}})).data;
  if(!('publication_authorized'in copied))throw Error('Expected canonical copied draft');
  expect(copied.publication_authorized).toBe(false);expect(copied.pending_review).toEqual(marketCopyReviewFields);
  const list=await client({operation:'list',environment:'REAL',family_id:f.product.id,limit:1});expect(list.data).toHaveLength(1);
  const browser=sessionMarketVariants({workspaceId:one,version:1},async(input,init)=>fetch(address+String(input),{...init,headers:{...init?.headers,cookie:owner.cookie,origin}}));
  expect((await browser({operation:'get',environment:'REAL',id:recovered.id})).data).toMatchObject({id:recovered.id,version:3,current_release_id:published.release.id});
  // V7 F8: the composed profile MCP reads the same published version with the same token.
  const server=createProfileMcp(address,secret),sdk=new Client({name:'synthetic-market-postgres-client',version:'1'}),[ct,st]=InMemoryTransport.createLinkedPair();
  await server.connect(st);await sdk.connect(ct);
  try{
   const count=posts,result=await sdk.callTool({name:'variants_manage',arguments:{action:'version',releaseId:published.release.id}});
   expect(result.isError).not.toBe(true);expect(result.structuredContent).toEqual(published.release);expect(posts).toBe(count);
  }finally{await sdk.close();await server.close();}
  await admin.query('UPDATE personal_access_tokens SET revoked_at=clock_timestamp() WHERE id=$1',[tokenId]);
  await expect(client({operation:'get',environment:'REAL',id:recovered.id})).rejects.toMatchObject({code:'MARKET_READ_UNCONFIRMED',status:401});
 });
 it('operation contention fails immediately and never runs the second callback',async()=>{
  const key=randomUUID();let release!:()=>void,entered!:()=>void;const blocked=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r);let ran=false;
  const first=tx(db=>store.marketOperation(db,'REAL',owner.user,key,{fixed:true},async()=>{entered();await blocked;return{ok:true};}));await ready;
  try{await expect(tx(db=>store.marketOperation(db,'REAL',owner.user,key,{fixed:true},async()=>{ran=true;return{ok:true};}))).rejects.toMatchObject({code:'MARKET_OPERATION_BUSY'});expect(ran).toBe(false);}finally{release();await first;}
 });
 it('rolls back draft, event and operation when native session expires during actual SQL work',async()=>{
  const f=await fixture(),short=await account(),key=randomUUID();
  await admin.query('UPDATE session SET "expiresAt"=clock_timestamp()+interval \'300 milliseconds\' WHERE id=$1',[short.session.id]);
  let id='';await expect(tx(db=>store.marketOperation(db,'REAL',short.user,key,{operation:'expire'},async()=>{const d=await store.createMarketDraft(db,'REAL',{family_id:f.product.id,fields:f.fields},short.user);id=d.id;await db.query('SELECT pg_sleep(0.45)');return d;}),short)).rejects.toMatchObject({code:'PROFILE_SESSION_EXPIRED'});
  expect((await admin.query('SELECT count(*)::int n FROM market_variants WHERE id=$1',[id])).rows[0].n).toBe(0);
  expect((await admin.query('SELECT count(*)::int n FROM market_operations WHERE operation_id=$1',[key])).rows[0].n).toBe(0);
  expect((await admin.query('SELECT count(*)::int n FROM market_variant_events WHERE variant_id=$1',[id])).rows[0].n).toBe(0);
 });
 it('rejects foreign details, extra authority fields, missing idempotency and revoked native authority',async()=>{
  const f=await fixture(),viewer=await account('viewer');
  expect((await request('/v2/market/variants/'+f.draft.id+'?environment=SIMULATION',undefined,headers())).status).toBe(404);
  expect((await request('/v2/market/variants?environment=REAL',{family_id:f.product.id,fields:f.fields,workspace_id:two},headers())).status).toBe(400);
  const h=headers();delete(h as Partial<typeof h>)['idempotency-key'];expect((await request('/v2/market/variants?environment=REAL',{family_id:f.product.id,fields:f.fields},h)).status).toBe(400);
  expect((await request('/v2/market/variants?environment=REAL',{family_id:f.product.id,fields:f.fields},headers(viewer))).status).toBe(403);
  expect((await request('/v2/market/variants?environment=REAL',{family_id:f.product.id,fields:f.fields},{...headers(),origin:'https://untrusted.invalid'})).status).toBe(403);
 });
 it('rolls back canonical retention of extra published materials while preserving unreferenced retention',async()=>{
  async function retention(id:string){
   const policy=(await admin.query("INSERT INTO retention_policies(workspace_id,environment,approved_by,expires_at,ttl,reason) VALUES($1,'REAL',$2,now()+interval '1 day',$3,'Synthetic local retention') RETURNING id",[one,owner.user,{envelopes_days:7,messages_days:90,assets_days:30,ai_days:30,idempotency_days:90}])).rows[0].id;
   const row=(await admin.query("SELECT version,encode(digest(body::text,'sha256'),'hex') AS digest FROM records WHERE id=$1",[id])).rows[0];
   const at=new Date().toISOString(),manifest={policy_id:policy,workspace_id:one,environment:'REAL',planned_at:at,candidates:[{kind:'asset',id,version:row.version,snapshot_hash:row.digest}]};
   return(await admin.query("INSERT INTO retention_plans(policy_id,plan_digest,manifest,created_at) VALUES($1,encode(digest(retention_canonical_json($2::jsonb),'sha256'),'hex'),$2,$3) RETURNING id,plan_digest",[policy,manifest,at])).rows[0];
  }
  const f=await fixture(),extra=await record('asset',{status:'READY',storage_key:'synthetic-key'},one,'REAL',true);
  const draft=await tx(db=>store.replaceMarketDraft(db,'REAL',f.draft.id,{expected_version:1,fields:{...f.fields,configuration:{...f.fields.configuration,materials:[...f.fields.configuration.materials,extra]}}},owner.user));
  await publish(draft);const plan=await retention(extra.id);
  await expect(admin.query('SELECT apply_retention_plan($1,$2,true)',[plan.id,plan.plan_digest])).rejects.toThrow('MARKET_MATERIAL_REFERENCED');
  expect((await admin.query('SELECT body FROM records WHERE id=$1',[extra.id])).rows[0].body.status).toBe('READY');
  expect((await admin.query('SELECT body FROM record_versions WHERE record_id=$1',[extra.id])).rows[0].body.storage_key).toBe('synthetic-key');
  expect((await admin.query('SELECT status FROM retention_plans WHERE id=$1',[plan.id])).rows[0].status).toBe('PLANNED');
  const orphan=await record('asset',{status:'READY',storage_key:'synthetic-orphan'},one,'REAL',true),allowed=await retention(orphan.id);
  await admin.query('SELECT apply_retention_plan($1,$2,true)',[allowed.id,allowed.plan_digest]);
  expect((await admin.query('SELECT body FROM records WHERE id=$1',[orphan.id])).rows[0].body.status).toBe('RETAINED');
 });
 it('enforces SQL FK and snapshot body identity even if a caller bypasses the repository',async()=>{
  const f=await fixture(),p=await publish(f.draft),j=await journey(p.release),snap=await tx(db=>store.captureMarketJourney(db,'REAL',j,p.release.id));
  await expect(tx(db=>db.query("INSERT INTO market_families(workspace_id,environment,id) VALUES($1,'SIMULATION',$2)",[one,f.product.id]))).rejects.toMatchObject({code:'23503'});
  const other=await fixture();await expect(tx(db=>db.query('INSERT INTO market_variants(workspace_id,environment,id,family_id,draft,source_release_id) VALUES($1,$2,$3,$4,$5,$6)',[one,'REAL',randomUUID(),other.product.id,other.fields,p.release.id]))).rejects.toThrow('MARKET_COPY_FAMILY_CHANGED');
  const j2=await journey(p.release),changed={...snap,journey_id:j2,release:{...p.release,amount_minor:0}};
  await expect(tx(db=>db.query('INSERT INTO market_journey_snapshots(workspace_id,environment,journey_id,release_id,body) VALUES($1,$2,$3,$4,$5)',[one,'REAL',j2,p.release.id,changed]))).rejects.toThrow('MARKET_SNAPSHOT_RELEASE_CHANGED');
 });
});
