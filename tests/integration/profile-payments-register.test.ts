/** Real loopback HTTP/Better Auth/PostgreSQL; all business data and keys are synthetic.
 * Test-owned policies exercise native RLS without claiming the future 020 transition. */
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import Fastify,{type FastifyInstance,type FastifyRequest} from 'fastify';
import {fromNodeHeaders} from 'better-auth/node';
import {hashPassword} from 'better-auth/crypto';
import {ZodError} from 'zod';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {listProfileChoicesFromSession,selectProfileFromSession} from '../../packages/db/src/profile-identity-bootstrap.js';
import {createAuth} from '../../apps/api/src/auth.js';
import {paymentsRegisterRoutes} from '../../apps/api/src/payments-register.js';
import {profileIdentityRoutes} from '../../apps/api/src/profile-identity.js';
import {withProfileTransaction} from '../../packages/db/src/profile-context.js';
import {withProfileSessionTransaction} from '../../packages/db/src/profile-session-transaction.js';
import {withPersonalProfileTransaction} from '../../packages/db/src/profile-personal-token.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {listPayments,exportPayments,paymentOptions} from '../../packages/db/src/payments-register.js';
import {readResultFacts} from '../../packages/db/src/results.js';
import {sessionPayments,personalPayments} from '../../packages/commerce-client/src/payments.js';
import {createPaymentsMcp} from '../../apps/commerce-mcp/src/payments.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {paymentPageQuerySchema} from '../../packages/contracts/src/payments-register.js';
const suffix=randomBytes(8).toString('hex'),login='f5_payments_'+suffix,custodyLogin='f5_custody_'+suffix;
const one='payments_one_'+suffix,two='payments_two_'+suffix,origin='http://localhost:5173';
const day='2026-10-10',at='2026-10-10T17:00:00.000Z',query=paymentPageQuerySchema.parse({from:day,to:day});
const password='synthetic-catalog-password123';
let admin:pg.Pool|undefined,runtime:pg.Pool|undefined,custodyPool:pg.Pool|undefined,app:FastifyInstance|undefined,address:string,passwordHash:string;
async function transaction<T>(work:(client:pg.PoolClient)=>Promise<T>){const c=await runtime!.connect();try{await c.query('BEGIN');const result=await work(c);expect((await c.query('COMMIT')).command).toBe('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function nativeSession(req:FastifyRequest){return transaction(async c=>{const native=await createAuth(c).api.getSession({headers:fromNodeHeaders(req.headers),query:{disableRefresh:true}});return native&&native.session.userId===native.user.id?{id:native.session.id,userId:native.user.id}:null;});}
async function request(path:string,headers:Record<string,string>={},body?:object){return fetch(address+path,{method:body?'POST':'GET',redirect:'error',headers:{origin,...headers,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
function fence(cookie:string,profile=one,version=1){return{cookie,'x-commerce-profile-id':profile,'x-commerce-profile-version':String(version)};}
async function account(role='owner'){
 const user=randomUUID(),email=user+'@example.invalid';
 await admin!.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,\'Synthetic Catalog\',$2,true)',[user,email]);
 await admin!.query('INSERT INTO account(id,"accountId","providerId","userId",password,issuer) VALUES($1,$2,\'credential\',$2,$3,\'local:credential\')',[randomUUID(),user,passwordHash]);
 await admin!.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,$4),($1,$3,$4)",[user,one,two,role]);
 const r=await request('/api/auth/sign-in/email',{}, {email,password});expect(r.status).toBe(200);
 const cookie=r.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');expect(cookie).toContain('better-auth.session_token=');
 return{user,cookie};
}
async function select(cookie:string,workspaceId=one,expectedVersion=0){const r=await request('/v2/me/profile-selection',{cookie},{workspaceId,expectedVersion});expect(r.status).toBe(200);return(await r.json()).data;}
async function token(user:string,scopes=['payments:read']){const secret='cos_pat_'+randomBytes(32).toString('base64url'),id=randomUUID();await admin!.query(`INSERT INTO personal_access_tokens(id,workspace_id,user_id,name,token_hash,allowed_environments,profile_scopes,expires_at)
 VALUES($1,$2,$3,'Synthetic catalog',$4,'["REAL"]',$5,clock_timestamp()+interval '1 hour')`,[id,one,user,createHash('sha256').update(secret).digest('hex'),JSON.stringify(scopes)]);return{id,secret};}

async function rec(w:string,kind:string,body:Record<string,unknown>,environment='REAL'){
 const id=randomUUID();await admin!.query('INSERT INTO records(id,workspace_id,environment,kind,body,created_at) VALUES($1,$2,$3,$4,$5,$6)',[id,w,environment,kind,body,at]);return id;
}
async function payment(w=one,{status='APPROVED',amount='10000',currency='MXN',classification='',environment='REAL',contribution=true,duplicate=false,method='bank_transfer_receipt',effective=at}:Record<string,any>={}){
 const family=await rec(w,'product',{name:'Synthetic family'},environment),contact=await rec(w,'contact',{identity:'+5215555551234',secret_ciphertext:'private-needle'},environment),accountId=await rec(w,'channel_account',{masked_number:'•••• 6789',gateway_ref:'private-gateway'},environment);
 const conversation=await rec(w,'conversation',{product_id:family,contact_id:contact,account_id:accountId,started_at:at,...(classification==='TEST'?{commercial_classification:'TEST'}:{})},environment);
 const order=await rec(w,'order',{conversation_id:conversation,product_id:family,currency,offer_snapshot:{payment_method:method},attribution:{classification:'observed',ad_id:'100',meta_ad_account_id:'act_1'}},environment);
 const asset=await rec(w,'asset',{status:'READY',storage_path:'/private/no-read',signed_url:'https://example.invalid/private'},environment);
 const receipt=await rec(w,'receipt',{order_id:order,conversation_id:conversation,asset_id:asset,status,extraction:{amount_minor:amount,currency},...(classification==='FALSE'?{commercial_classification:'FALSE'}:{}),...(duplicate?{duplicate_of:randomUUID()}:{}),text:'private-needle'},environment);
 let contributionId:string|null=null;if(contribution){contributionId=randomUUID();await admin!.query('INSERT INTO payment_contributions(id,workspace_id,environment,order_id,receipt_id,payment_key,amount_minor,currency,currency_source,evidence_sha256,effective_at,provenance) VALUES($1,$2,$3,$4,$5,$1::uuid::text,$6,$7,$8,$9,$10,$11)',[contributionId,w,environment,order,receipt,amount,currency,'SYNTHETIC_FIXTURE',randomBytes(32).toString('hex'),effective,{}]);}
 return{w,family,contact,accountId,conversation,order,receipt,asset,contributionId,environment};
}
async function read(w=one,extra:Record<string,unknown>={}){return withProfileTransaction(runtime!,w,db=>listPayments(db,{...query,...extra}));}
async function only(j:Awaited<ReturnType<typeof payment>>,extra:Record<string,unknown>={}){return read(j.w,{familyId:j.family,...extra});}
type Payment=Awaited<ReturnType<typeof payment>>;
async function captured(j:Payment){
 return withProfileTransaction({async connect(){const c=await custodyPool!.connect();return{query:(sql,values)=>c.query(sql==='BEGIN'?'BEGIN ISOLATION LEVEL REPEATABLE READ':sql,values),release:c.release.bind(c)};}},j.w,async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");return db.query('SELECT capture_result_financial_context($1,1)',[j.conversation]);});
}
async function snapshot(j:Payment){
 const variant=randomUUID(),release=randomUUID(),body={id:release,variant_id:variant,family_id:j.family,revision:1,scope:{workspace_id:j.w,environment:'REAL'},locale:{market:'Retained market',currency:'MXN',timezone:'UTC'}};
 await admin!.query("INSERT INTO market_families(id,workspace_id,environment) VALUES($1,$2,'REAL')",[j.family,j.w]);await admin!.query("INSERT INTO market_variants(id,workspace_id,environment,family_id,draft) VALUES($1,$2,'REAL',$3,'{}')",[variant,j.w,j.family]);await admin!.query("INSERT INTO market_releases(id,workspace_id,environment,variant_id,revision,body,sha256) VALUES($1,$2,'REAL',$3,1,$4,$5)",[release,j.w,variant,body,'a'.repeat(64)]);
 await admin!.query("INSERT INTO market_journey_snapshots(journey_id,workspace_id,environment,release_id,body) VALUES($1,$2,'REAL',$3,$4)",[j.conversation,j.w,release,{journey_id:j.conversation,release:body,chat:{workspace_id:j.w,environment:'REAL'}}]);return variant;
}
async function stub(j:Payment){await admin!.query("UPDATE records SET body=body||'{\"privacy_erased\":true}',version=version+1 WHERE id=$1",[j.conversation]);}
describe('profile payments and canonical F7 reconciliation',()=>{
 beforeAll(async()=>{
  vi.stubEnv('BETTER_AUTH_SECRET','synthetic-catalog-'+randomBytes(32).toString('hex'));passwordHash=await hashPassword(password);
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:3,connectionTimeoutMillis:5000});
  if((await admin.query("SELECT to_regclass('public.profiles') AS present")).rows[0].present)throw Error('TRANSITION_SCHEMA_ALREADY_PRESENT');
  const c=await admin.connect();try{await c.query('BEGIN');for(const name of ['001_profile_identity.sql','002_profile_personal_tokens.sql','003_profile_settings.sql','008_market_variants.sql','017_results_and_goals.sql','019_ai_admission.sql','022_result_projections.sql','components/022_result_source_reader.sql','024_result_financial_context.sql'])await c.query(await readFile(new URL('../../packages/db/profile-transition/'+name,import.meta.url),'utf8'));await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT commerce_api TO "${login}"`);
  // Test-owned policies on the REAL migrated tables, never installed by app startup.
  for(const table of ['records','record_versions','personal_access_tokens','payment_contributions','meta_ad_metadata','outbox','domain_events']){
   expect((await admin.query('SELECT count(*)::int n FROM pg_policies WHERE schemaname=\'public\' AND tablename=$1',[table])).rows[0].n).toBe(0);
   await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;CREATE POLICY catalog_fixture ON ${table} USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')) WITH CHECK(workspace_id=NULLIF(current_setting('app.workspace_id',true),''))`);
  }
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic One','UTC',1,10,10),($2,'Synthetic Two','UTC',1,10,10)",[one,two]);
  url.username=login;url.password=secret;runtime=new pg.Pool({connectionString:url.toString(),options:'-c role=commerce_api',max:2,connectionTimeoutMillis:5000});
  const custodySecret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${custodyLogin}" LOGIN PASSWORD '${custodySecret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;GRANT commerce_results TO "${custodyLogin}"`);const custodyUrl=new URL(url);custodyUrl.username=custodyLogin;custodyUrl.password=custodySecret;custodyPool=new pg.Pool({connectionString:custodyUrl.toString(),options:'-c role=commerce_results',max:2});
  app=Fastify({logger:false,disableRequestLogging:true});app.setErrorHandler((e:any,_r,reply)=>reply.code(e instanceof ZodError?400:e.statusCode??500).send({error:{code:e.code??'INTERNAL_ERROR'}}));
  await profileIdentityRoutes(app,{origins:[origin],session:nativeSession,list:s=>listProfileChoicesFromSession(runtime!,s),select:(s,w,v)=>transaction(c=>selectProfileFromSession(c,s,w,v))});
  await paymentsRegisterRoutes(app,{origins:[origin],nativeSession,
   session:(s,f,environment,action,work)=>withProfileSessionTransaction(runtime!,s,f,action,(db,profile)=>work({db,profile,environment})),
   personal:(t,environment,action,work)=>withPersonalProfileTransaction(runtime!,t,environment,action,(db,profile)=>work({db,profile,environment})),
  });
  app.post('/api/auth/*',{bodyLimit:4096},async(req,reply)=>{if(req.headers.origin!==origin)return reply.code(403).send({error:'ORIGIN'});const result=await transaction(c=>createAuth(c).handler(new Request('http://localhost:3001'+req.url,{method:'POST',headers:fromNodeHeaders(req.headers),body:JSON.stringify(req.body)})));reply.code(result.status);if(result.ok)reply.header('set-cookie',result.headers.getSetCookie());return{signedIn:result.ok};});
  address=await app.listen({host:'127.0.0.1',port:0});
 });
 afterAll(async()=>{await app?.close();await runtime?.end();await custodyPool?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}","${custodyLogin}"`);}finally{await admin.end();}}vi.unstubAllEnvs();});
 it('uses restricted native identity, invoker views and empty pooled context',async()=>{
  expect((await runtime!.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
  expect((await runtime!.query('SELECT id FROM records')).rows).toEqual([]);expect((await runtime!.query('SELECT contribution_id FROM result_payment_facts')).rows).toEqual([]);
  expect((await admin!.query("SELECT reloptions FROM pg_class WHERE oid='result_ai_cost_facts'::regclass")).rows[0].reloptions).toContain('security_invoker=true');
  await expect(withProfileTransaction(runtime!,one,db=>listPayments({...db,workspaceId:two},query))).rejects.toThrow('PAYMENTS_PROFILE_CONTEXT_REQUIRED');
 });
 it('reads a native authenticated HTTP page and never searches or returns private fields',async()=>{
  const j=await payment(),{cookie}=await account();await select(cookie);const r=await request('/v2/payments?from='+day+'&to='+day+'&familyId='+j.family,fence(cookie));expect(r.status).toBe(200);
  const value=await r.json();expect(value.data.rows).toHaveLength(1);expect(value.data.rows[0]).toMatchObject({receiptId:j.receipt,accountMasked:'••••6789',contactMasked:'••••1234',assetId:j.asset,method:'BANK_TRANSFER'});
  expect(JSON.stringify(value)).not.toMatch(/private-needle|private-gateway|private\/no-read|signed_url|5215555551234/);expect((await only(j,{q:'private-needle'})).total).toBe(0);expect(r.headers.get('cache-control')).toBe('no-store');
 });
 it('projects all five labels, duplicates and unknown amounts without inventing revenue',async()=>{
  for(const [options,status]of [[{status:'PENDING',contribution:false},'REVIEW'],[{status:'REJECTED'},'REJECTED'],[{classification:'TEST'},'TEST'],[{classification:'FALSE'},'FALSE'],[{},'APPROVED'],[{duplicate:true},'REVIEW']]as const){const j=await payment(one,options),r=await only(j);expect(r.rows[0]?.status).toBe(status);expect(r.rows[0]?.recognizedRevenueMinor).toBe(status==='APPROVED'?'10000':'0');}
  const j=await payment(one,{contribution:false,status:'PENDING'});await admin!.query(`UPDATE records SET body=jsonb_set(body,'{extraction}','{"amount_minor":"NaN","currency":"not_currency"}'),version=version+1 WHERE id=$1`,[j.receipt]);expect((await only(j)).rows[0]).toMatchObject({amountMinor:null,currency:null,recognizedRevenueMinor:'0'});
 });
 it('separates profiles and REAL from SIMULATION with native RLS and fixed PAT',async()=>{
  const j=await payment(),foreign=await payment(two),sim=await payment(one,{environment:'SIMULATION'});const {cookie,user}=await account();await select(cookie,two);const t=await token(user);
  const r=await request('/v2/payments?from='+day+'&to='+day+'&familyId='+j.family,{authorization:'Bearer '+t.secret,cookie});expect((await r.json()).data.rows[0].receiptId).toBe(j.receipt);
  expect((await only(foreign)).rows[0]?.receiptId).toBe(foreign.receipt);expect((await read(one,{familyId:foreign.family})).total).toBe(0);expect((await read(one,{familyId:sim.family})).total).toBe(0);
  expect((await request('/v2/payments?from='+day+'&to='+day+'&environment=SIMULATION',{authorization:'Bearer '+t.secret})).status).toBe(401);
  await admin!.query('UPDATE personal_access_tokens SET revoked_at=clock_timestamp() WHERE id=$1',[t.id]);expect((await request('/v2/payments?from='+day+'&to='+day,{authorization:'Bearer '+t.secret})).status).toBe(401);
 });
 it('keeps exact large integer totals per currency and reconciles recognized revenue with F7',async()=>{
  const j=await payment(one,{amount:'9007199254740991'});await payment(one,{amount:'9007199254740991'});await payment(one,{amount:'150',currency:'USD'});
  const r=await read(),facts=await withProfileTransaction(runtime!,one,db=>readResultFacts(db,{from:day,to:day,currency:'MXN'}));expect(r.totals.find(x=>x.currency==='MXN')?.approvedRevenueMinor).toBe(facts.reduce((n,x)=>n+BigInt(x.revenue_minor),0n).toString());
  expect(BigInt(r.totals.find(x=>x.currency==='MXN')!.approvedRevenueMinor)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));expect((await only(j)).totals).toEqual([{currency:'MXN',approvedRevenueMinor:'9007199254740991',approvedPayments:1}]);expect(r.totals.find(x=>x.currency==='USD')?.approvedRevenueMinor).toBe('150');
 });
 it('reflects FALSE correction without destroying the five-year financial contribution',async()=>{
  const j=await payment();expect((await only(j)).rows[0]?.recognizedRevenueMinor).toBe('10000');await admin!.query(`UPDATE records SET body=body||'{"commercial_classification":"FALSE"}',version=version+1 WHERE id=$1`,[j.receipt]);expect((await only(j)).rows[0]).toMatchObject({status:'FALSE',recognizedRevenueMinor:'0'});expect((await admin!.query('SELECT id FROM payment_contributions WHERE id=$1',[j.contributionId])).rowCount).toBe(1);
 });
 it('classifies receipt TEST on a REAL order without recognizing its contribution',async()=>{
  const j=await payment();await admin!.query(`UPDATE records SET body=body||'{"commercial_classification":"TEST"}',version=version+1 WHERE id=$1`,[j.receipt]);
  expect((await only(j)).rows[0]).toMatchObject({status:'TEST',recognizedRevenueMinor:'0'});expect((await only(j)).totals).toEqual([{currency:'MXN',approvedRevenueMinor:'0',approvedPayments:0}]);
  expect((await admin!.query('SELECT id FROM payment_contributions WHERE id=$1',[j.contributionId])).rowCount).toBe(1);
  expect((await admin!.query("SELECT body->>'commercial_classification' classification FROM records WHERE id=$1",[j.order])).rows[0].classification).not.toBe('TEST');
 });
 it('requires an exact metadata mapping and does not guess campaign or ad',async()=>{
  const j=await payment();expect((await only(j)).rows[0]?.campaignId).toBeNull();await admin!.query("INSERT INTO meta_ad_metadata(workspace_id,environment,meta_ad_account_id,ad_id,campaign_id,ad_name,campaign_name,source) VALUES($1,'REAL','act_1','100','10','Synthetic ad','Synthetic campaign','SYNTHETIC_FIXTURE') ON CONFLICT DO NOTHING",[one]);expect((await only(j)).rows[0]).toMatchObject({campaignId:'10',adId:'100'});
  await admin!.query(`UPDATE records SET body=jsonb_set(body,'{attribution}','{"classification":"inferred","ad_id":"100"}'),version=version+1 WHERE id=$1`,[j.order]);expect((await only(j)).rows[0]).toMatchObject({campaignId:null,adId:null});
 });
 it('filters by civil timezone including DST and does not use update time',async()=>{
  await withProfileTransaction(runtime!,two,db=>db.query("UPDATE profiles SET timezone='America/Los_Angeles' WHERE id=$1",[two]));const j=await payment(two,{effective:'2026-11-01T06:59:59.999Z'});
  expect((await only(j,{from:'2026-10-31',to:'2026-10-31'})).total).toBe(1);expect((await only(j,{from:'2026-11-01',to:'2026-11-01'})).total).toBe(0);await admin!.query('UPDATE records SET version=version+1,updated_at=clock_timestamp() WHERE id=$1',[j.receipt]);expect((await only(j,{from:'2026-10-31',to:'2026-10-31'})).total).toBe(1);
 });
 it('paginates deterministically while totals cover the entire filtered selection',async()=>{
  const all=await read(one,{sort:'amount',direction:'asc'}),a=await read(one,{sort:'amount',direction:'asc',limit:2}),b=await read(one,{sort:'amount',direction:'asc',limit:2,offset:2});expect([...a.rows,...b.rows]).toEqual(all.rows.slice(0,4));expect(a.total).toBe(all.total);expect(a.totals).toEqual(all.totals);
 });
 it('exports both complete formats only to authorized owners and writes private-safe audit metadata',async()=>{
  const j=await payment(),{cookie,user}=await account();await select(cookie);for(const format of ['csv','xlsx']){const r=await request('/v2/payments/export?from='+day+'&to='+day+'&familyId='+j.family+'&format='+format,fence(cookie));expect(r.status).toBe(200);const bytes=Buffer.from(await r.arrayBuffer());expect(bytes.subarray(0,format==='csv'?3:2)).toEqual(format==='csv'?Buffer.from([239,187,191]):Buffer.from('PK'));expect(r.headers.get('content-disposition')).toBe('attachment; filename="payments.'+format+'"');}
  const events=(await admin!.query("SELECT actor,payload FROM domain_events WHERE event_type='payments.export_prepared' AND actor->>'id'=$1",[user])).rows;expect(events).toHaveLength(2);expect(events[0].payload).toMatchObject({rows:1});expect(events[0].payload.sha256).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(events)).not.toContain('5215555551234');
  const viewer=await account('viewer');await select(viewer.cookie);expect((await request('/v2/payments/export?from='+day+'&to='+day+'&format=csv',fence(viewer.cookie))).status).toBe(403);
 });
 it('rejects stale selection and revoked authority before returning export bytes',async()=>{
  const {cookie,user}=await account();await select(cookie);await select(cookie,two,1);expect((await request('/v2/payments/export?from='+day+'&to='+day+'&format=xlsx',fence(cookie))).status).toBe(409);
  await admin!.query('UPDATE memberships SET active=false WHERE workspace_id=$1 AND user_id=$2',[two,user]);expect((await request('/v2/payments?from='+day+'&to='+day,fence(cookie,two,2))).status).toBe(403);
 });
 it('rejects malformed or injected filters before selecting other profiles',async()=>{
  const {cookie}=await account();await select(cookie);for(const query of ['workspaceId=foreign','sort=receipt_id%3BDROP','status=PAID','from=2026-02-30&to=2026-03-01','limit=101','offset=-1'])expect((await request('/v2/payments?from='+day+'&to='+day+'&'+query,fence(cookie))).status).toBe(400);
 });
 it('preserves unknown method and unrecognized approval without making up a payment contribution',async()=>{
  const j=await payment(one,{method:'other',contribution:false});expect((await only(j)).rows[0]).toMatchObject({method:'UNKNOWN',status:'APPROVED',recognizedRevenueMinor:'0',contributionId:null});
 });
 it('uses the immutable variant release snapshot and filters the same association',async()=>{
  const j=await payment(),variant=randomUUID(),release=randomUUID();const body={id:release,variant_id:variant,family_id:j.family,revision:1,scope:{workspace_id:one,environment:'REAL'},locale:{market:'MX',currency:'MXN'}};
  await admin!.query("INSERT INTO market_families(id,workspace_id,environment) VALUES($1,$2,'REAL')",[j.family,one]);await admin!.query("INSERT INTO market_variants(id,workspace_id,environment,family_id,draft) VALUES($1,$2,'REAL',$3,'{}')",[variant,one,j.family]);await admin!.query("INSERT INTO market_releases(id,workspace_id,environment,variant_id,revision,body,sha256) VALUES($1,$2,'REAL',$3,1,$4,$5)",[release,one,variant,body,'a'.repeat(64)]);
  await admin!.query("INSERT INTO market_journey_snapshots(journey_id,workspace_id,environment,release_id,body) VALUES($1,$2,'REAL',$3,$4)",[j.conversation,one,release,{journey_id:j.conversation,release:body,chat:{workspace_id:one,environment:'REAL'}}]);expect((await only(j,{variantId:variant})).rows[0]).toMatchObject({variantId:variant,market:'MX'});expect((await only(j,{variantId:randomUUID()})).total).toBe(0);
 });
 it('runs the shared cookie client over native HTTP for list and byte-verified export',async()=>{
  const j=await payment(),{cookie}=await account();await select(cookie);
  const wire:typeof fetch=(url,init)=>fetch(address+url,{...init,headers:{...init?.headers,cookie,origin}}),client=sessionPayments({workspaceId:one,version:1},wire);
  const r=await client({operation:'list',query:{from:day,to:day,familyId:j.family}});expect(r.operation).toBe('list');if(r.operation==='list')expect(r.data.rows[0]?.receiptId).toBe(j.receipt);
  const file=await client({operation:'export',query:{from:day,to:day,familyId:j.family,format:'xlsx'}});expect(file.operation).toBe('export');if(file.operation==='export')expect(file.sha256).toBe(createHash('sha256').update(file.bytes).digest('hex'));
 });
 it('uses one actual PAT through the MCP SDK and cannot export without export scope',async()=>{
  const j=await payment(),{user}=await account(),t=await token(user),server=createPaymentsMcp(personalPayments(address,t.secret)),client=new Client({name:'native-payments',version:'1'}),[ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
  try{const r=await client.callTool({name:'payments_list',arguments:{query:{from:day,to:day,familyId:j.family}}});expect(r.isError).not.toBe(true);expect((r.structuredContent as any).data.rows[0]?.receiptId).toBe(j.receipt);
   expect((await client.callTool({name:'payments_export',arguments:{query:{from:day,to:day,format:'csv'}}})).isError).toBe(true);
  }finally{await client.close();await server.close();}
 });
 it('reads scoped filter options through native HTTP with bounded cursor pages',async()=>{
  const {cookie}=await account();await select(cookie);const response=await request('/v2/payments/options?from='+day+'&to='+day+'&kind=family&limit=2',fence(cookie));expect(response.status).toBe(200);const first=await response.json();expect(first.data).toHaveLength(2);expect(first.next).toBe(first.data[1].id);
  const next=await(await request('/v2/payments/options?from='+day+'&to='+day+'&kind=family&limit=2&after='+first.next,fence(cookie))).json();expect(next.data.every((r:any)=>r.id>first.next)).toBe(true);
  const foreign=await payment(two);expect((await withProfileTransaction(runtime!,one,db=>paymentOptions(db,{from:day,to:day,kind:'family',familyId:foreign.family,limit:25}))).data).toEqual([]);
 });
 it('filters market and ad using the same source as options and recognized totals',async()=>{
  const snapshot=(await admin!.query('SELECT body FROM market_journey_snapshots WHERE workspace_id=$1 LIMIT 1',[one])).rows[0].body;
  const r=await read(one,{market:'MX',variantId:snapshot.release.variant_id,adId:'100'});expect(r.rows).toHaveLength(1);expect(r.rows[0]?.market).toBe('MX');
  const options=await withProfileTransaction(runtime!,one,db=>paymentOptions(db,{from:day,to:day,kind:'market',variantId:snapshot.release.variant_id}));expect(options.data).toEqual([{id:'MX',label:'MX'}]);
 });
 it('returns an empty complete export instead of inventing rows or totals',async()=>{
  const r=await withProfileTransaction(runtime!,one,db=>exportPayments(db,{from:'2020-01-01',to:'2020-01-01'}));expect(r.rows).toEqual([]);expect(r.total).toBe(0);expect(r.totals).toEqual([]);
 });
 it('uses retained024 dimensions only after erasure and never revives masks or asset access',async()=>{
  const j=await payment(),variant=await snapshot(j);await captured(j);
  await admin!.query("UPDATE records SET body=body||jsonb_build_object('product_id',$2::text,'attribution',jsonb_build_object('classification','inferred','ad_id','999')),version=version+1 WHERE id=$1",[j.order,await rec(one,'product',{name:'New live family'})]);await stub(j);
  const result=await only(j,{variantId:variant,market:'Retained market',accountId:j.accountId,campaignId:'10',adId:'100'});
  expect(result.rows).toHaveLength(1);expect(result.rows[0]).toMatchObject({familyId:j.family,familyName:'Synthetic family',variantId:variant,market:'Retained market',accountId:j.accountId,campaignId:'10',adId:'100',accountMasked:null,contactMasked:null,assetId:null,recognizedRevenueMinor:'10000'});
  expect((await admin!.query('SELECT id FROM records WHERE id=ANY($1::uuid[])',[ [j.contact,j.accountId,j.asset] ])).rowCount).toBe(3);
 });
 it('a captured context does not override newer live attribution or account identity',async()=>{
  const j=await payment();await captured(j);const other=await rec(one,'channel_account',{masked_number:'•••• 4444'});
  await admin!.query("INSERT INTO meta_ad_metadata(workspace_id,environment,meta_ad_account_id,ad_id,ad_name,campaign_id,campaign_name,source) VALUES($1,'REAL','act_live','200','Synthetic ad','20','Synthetic campaign','SYNTHETIC_FIXTURE')",[one]);
  await admin!.query("UPDATE records SET body=jsonb_set(body,'{account_id}',to_jsonb($2::text)),version=version+1 WHERE id=$1",[j.conversation,other]);await admin!.query("UPDATE records SET body=jsonb_set(body,'{attribution}','{\"classification\":\"observed\",\"ad_id\":\"200\",\"meta_ad_account_id\":\"act_live\"}'),version=version+1 WHERE id=$1",[j.order]);
  expect((await only(j)).rows[0]).toMatchObject({accountId:other,accountMasked:'••••4444',campaignId:'20',adId:'200',assetId:j.asset});
 });
 it('uses the same retained selection for options and authenticated CSV/XLSX exports',async()=>{
  const j=await payment(),variant=await snapshot(j);await captured(j);await stub(j);const {cookie}=await account();await select(cookie);
  const filter='from='+day+'&to='+day+'&familyId='+j.family+'&variantId='+variant;
  const choices=await request('/v2/payments/options?'+filter+'&kind=market',fence(cookie));expect(choices.status).toBe(200);expect((await choices.json()).data).toEqual([{id:'Retained market',label:'Retained market'}]);
  for(const format of ['csv','xlsx']){const response=await request('/v2/payments/export?'+filter+'&format='+format,fence(cookie));expect(response.status).toBe(200);const bytes=Buffer.from(await response.arrayBuffer()),text=bytes.toString('utf8');expect(text).toContain('Retained market');expect(text).toContain(variant);expect(text).not.toContain('••••');expect(text).not.toContain('/v1/receipts/');expect(response.headers.get('x-commerce-export-sha256')).toBe(createHash('sha256').update(bytes).digest('hex'));}
 });
 it('does not reconstruct erased dimensions from old snapshots or order payload without024',async()=>{
  const j=await payment();await snapshot(j);await stub(j);const r=await read(one,{q:j.receipt});expect(r.rows).toHaveLength(1);expect(r.rows[0]).toMatchObject({familyId:null,familyName:null,variantId:null,market:null,accountId:null,accountMasked:null,contactMasked:null,campaignId:null,adId:null,assetId:null,recognizedRevenueMinor:'0'});
 });
 it('keeps financial corrections visible under retained dimensions without deleting contributions',async()=>{
  const j=await payment(),variant=await snapshot(j);await captured(j);await stub(j);
  for(const label of ['FALSE','TEST']){await admin!.query("UPDATE records SET body=body||jsonb_build_object('commercial_classification',$2::text),version=version+1 WHERE id=$1",[j.receipt,label]);expect((await only(j,{variantId:variant})).rows[0]).toMatchObject({status:label,recognizedRevenueMinor:'0',familyId:j.family,variantId:variant});}
  expect((await admin!.query('SELECT id FROM payment_contributions WHERE id=$1',[j.contributionId])).rowCount).toBe(1);
 });
 it('retained financial context obeys profile/environment and cannot switch an established scope',async()=>{
  const j=await payment(two);await captured(j);await stub(j);expect((await read(one,{q:j.receipt})).rows).toEqual([]);expect((await read(two,{environment:'SIMULATION',q:j.receipt})).rows).toEqual([]);
  await expect(withProfileTransaction(runtime!,two,async db=>{await db.query("SELECT set_config('app.environment','SIMULATION',true)");return listPayments(db,query);})).rejects.toThrow('PROFILE_ENVIRONMENT_CONTEXT_MISMATCH');
 });

});
