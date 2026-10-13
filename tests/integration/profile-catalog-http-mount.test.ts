/** Canonical V1 catalog handlers and actual createApp over the composed schema.
 * Authentication cookie resolution is a synthetic fixture adapter; native
 * selection, memberships, PAT scopes, RLS and final authority all use PostgreSQL. */
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import type {FastifyInstance} from 'fastify';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {requireMigratedProfileSchema} from '../support/migrated-database.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {selectProfileFromSession} from '../../packages/db/src/profile-identity-bootstrap.js';
import {withProfileSessionTransaction} from '../../packages/db/src/profile-session-transaction.js';
import {withPersonalProfileTransaction} from '../../packages/db/src/profile-personal-token.js';
import {bindProfileEnvironment} from '../../packages/db/src/profile-environment.js';
import type {ProfilePool} from '../../packages/db/src/profile-context.js';
import type {QueryExecutor} from '../../packages/db/src/index.js';
import type {ProfileRequestDependencies} from '../../apps/api/src/profile-request.js';
import * as profileRequest from '../../apps/api/src/profile-request.js';
import {createApp} from '../../apps/api/src/app.js';
import {marketRecordVersionHash} from '../../packages/db/src/market-variants.js';
import {marketCopyReviewFields} from '../../packages/contracts/src/market-variants.js';
vi.mock('../../apps/api/src/auth.js',()=>({auth:{api:{getSession:vi.fn().mockResolvedValue(null)}},trustedOrigins:['https://fixture.example.test'],createAuth:vi.fn(),provisionUser:vi.fn()}));
const nativeRequest=profileRequest.withProfileRequest;
const originalPrivateKey=process.env.PRIVATE_DATA_KEY;
const suffix=randomBytes(6).toString('hex'),login='catalog_http_'+suffix,user='user_'+suffix,outsider='other_'+suffix;
const one='catalog_one_'+suffix,two='catalog_two_'+suffix,foreign='catalog_foreign_'+suffix;
let admin:pg.Pool,runtime:pg.Pool,loginOid:number,app:FastifyInstance,delayedToken:string|undefined;
let onCatalogRead:((c:pg.PoolClient)=>Promise<void>)|undefined;
const sessions=new Map<string,{id:string;userId:string}>();
async function session(){const id='session_'+randomBytes(8).toString('hex');await admin.query('INSERT INTO session(id,"userId",token,"expiresAt") VALUES($1,$2,$1,clock_timestamp()+interval \'1 hour\')',[id,user]);const s={id,userId:user};sessions.set(id,s);return s;}
async function selected(workspace=one){const s=await session(),c=await runtime.connect();try{await c.query('BEGIN');const fence=await selectProfileFromSession(c,s,workspace,0);await c.query('COMMIT');return{s,fence,headers:{cookie:'fixture_session='+s.id,'x-commerce-profile-id':workspace,'x-commerce-profile-version':String(fence.version)}};}finally{await c.query('ROLLBACK');c.release();}}
async function pat(scopes=['materials:read'],life='1 hour'){
 const id=randomUUID(),secret='cos_pat_'+randomBytes(32).toString('base64url');await admin.query(`INSERT INTO personal_access_tokens(id,workspace_id,user_id,name,token_hash,allowed_environments,profile_scopes,expires_at) VALUES($1,$2,$3,'Synthetic',$4,'["SIMULATION"]',$5,clock_timestamp()+$6::interval)`,[id,one,user,createHash('sha256').update(secret).digest('hex'),JSON.stringify(scopes),life]);return{id,secret};
}
const delayedPool:ProfilePool&QueryExecutor={query:(sql,values)=>runtime.query(sql,values),async connect(){const c=await runtime.connect();return{async query(sql,values){const result=await c.query(sql,values);if(onCatalogRead&&sql.includes('FROM records')&&sql.includes('kind')){const hook=onCatalogRead;onCatalogRead=undefined;await hook(c);}if(delayedToken&&(sql.includes('FROM records')&&sql.includes('kind')||sql.startsWith('INSERT INTO records'))){const token=delayedToken;delayedToken=undefined;await c.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.03) FROM personal_access_tokens WHERE id=$1',[token]);}return result;},release:e=>c.release(e)};}};
const dependencies:ProfileRequestDependencies={origins:['https://fixture.example.test'],nativeSession:async req=>sessions.get(String(req.headers.cookie??'').replace('fixture_session=',''))??null,
 session:(s,fence,environment,action,work)=>withProfileSessionTransaction(delayedPool,s,fence,action,async(db,profile)=>{await bindProfileEnvironment(db,environment);return work({db,profile,environment});}),
 personal:(token,environment,action,work)=>withPersonalProfileTransaction(delayedPool,token,environment,action,async(db,profile)=>{await bindProfileEnvironment(db,environment);return work({db,profile,environment});}),
};
async function assets(workspace:string,environment:string){return(await admin.query("SELECT id FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='asset'",[workspace,environment])).rows.map(r=>r.id as string);}
async function get(url:string,headers:Record<string,string>){return app.inject({url,headers});}
describe('mounted V1 SQL catalog against restricted native authority',()=>{
 beforeAll(async()=>{
  process.env.PRIVATE_DATA_KEY='42'.repeat(32);
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');admin=new pg.Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:5000});
  // V7 F2: the canonical chain, its components and the isolation model are
  // installed by the migrations (0069-0100); no transition source is applied here.
  await requireMigratedProfileSchema(admin);
  await admin.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$1||\'@example.test\'),($2,$2,$2||\'@example.test\')',[user,outsider]);
  for(const p of [one,two,foreign]){await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic profile','UTC',0,2,100)",[p]);for(const e of ['REAL','SIMULATION'])await admin.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,$2,'asset','{\"name\":\"Synthetic\"}')",[p,e]);}
  await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'operator'),($1,$3,'operator'),($4,$5,'owner')",[user,one,two,outsider,foreign]);
  for(const p of [one,two,foreign]){const c=await admin.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true)",[p]);await c.query('SELECT adopt_profile_quota_inventory($1,profile_quota_inventory($1))',[p]);await c.query('COMMIT');}finally{await c.query('ROLLBACK');c.release();}}
  const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT commerce_api TO "${login}"`);loginOid=(await admin.query('SELECT oid FROM pg_roles WHERE rolname=$1',[login])).rows[0].oid;
  url.username=login;url.password=secret;runtime=new pg.Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:5000});
  app=await createApp();await app.ready();
  vi.spyOn(profileRequest,'withProfileRequest').mockImplementation((req,environment,action,work)=>nativeRequest(req,environment,action,work,dependencies));
 },60000);
 afterAll(async()=>{if(originalPrivateKey===undefined)delete process.env.PRIVATE_DATA_KEY;else process.env.PRIVATE_DATA_KEY=originalPrivateKey;await app?.close();vi.restoreAllMocks();await runtime?.end();if(admin){try{if(loginOid){expect((await admin.query('SELECT oid FROM pg_roles WHERE rolname=$1',[login])).rows[0]?.oid).toBe(loginOid);await admin.query(`DROP ROLE "${login}"`);}}finally{await admin.end();}}});
 it('uses a real restricted login and chosen profile instead of the first membership',async()=>{expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});const s=await selected(two),r=await get('/v1/assets?environment=REAL',s.headers);expect(r.statusCode,r.body).toBe(200);expect(r.json().data.map((x:any)=>x.id)).toEqual(await assets(two,'REAL'));});
 it('isolates REAL and SIMULATION in list and detail with the unchanged canonical handler',async()=>{const s=await selected();for(const e of['REAL','SIMULATION']){const ids=await assets(one,e),r=await get('/v1/assets?environment='+e,s.headers);expect(r.statusCode,r.body).toBe(200);expect(r.json().data.map((x:any)=>x.id)).toEqual(ids);expect((await get('/v1/assets/'+ids[0]+'?environment='+e,s.headers)).json().data.id).toBe(ids[0]);}});
 it('returns not found for another profile or environment despite a valid resource UUID',async()=>{const s=await selected();for(const id of[...(await assets(two,'REAL')),...(await assets(foreign,'REAL')),...(await assets(one,'SIMULATION'))])expect((await get('/v1/assets/'+id+'?environment=REAL',s.headers)).statusCode).toBe(404);});
 it('runs all six list consumers and preserves query filters on the real schema',async()=>{const s=await selected();for(const path of['categories','products','offers','assets','workflows','agents'])expect((await get('/v1/'+path+'?environment=REAL',s.headers)).statusCode,path).toBe(200);const r=await get('/v1/assets?q=absent&limit=1&offset=0&environment=REAL',s.headers);expect(r.json()).toEqual({data:[],meta:{total:0}});});
 it('keeps a PAT at its actual membership and permits only materials/read in its own environment',async()=>{const a=await pat(),h={authorization:'Bearer '+a.secret};const r=await get('/v1/assets?environment=SIMULATION',h);expect(r.statusCode,r.body).toBe(200);expect(r.json().data.map((x:any)=>x.id)).toEqual(await assets(one,'SIMULATION'));expect((await get('/v1/products?environment=SIMULATION',h)).statusCode).toBe(403);const denied=await get('/v1/assets?environment=REAL',h);expect(denied.statusCode).toBe(401);expect(denied.json().error.code).toBe('PROFILE_TOKEN_ENVIRONMENT_DENIED');});
 it('refuses missing or stale selection without authenticating through legacy identity',async()=>{const s=await selected();expect((await get('/v1/assets',{cookie:s.headers.cookie})).statusCode).toBe(409);const c=await runtime.connect();try{await c.query('BEGIN');await selectProfileFromSession(c,s.s,two,1);await c.query('COMMIT');}finally{await c.query('ROLLBACK');c.release();}const r=await get('/v1/assets',s.headers);expect(r.statusCode).toBeGreaterThanOrEqual(400);expect(r.body).not.toContain('Synthetic');});
 it('honors next-request membership revocation for PAT and session without fallback',async()=>{const a=await pat(),s=await selected();await admin.query('UPDATE memberships SET active=false WHERE workspace_id=$1 AND user_id=$2',[one,user]);try{for(const h of[s.headers,{authorization:'Bearer '+a.secret}]){const r=await get('/v1/assets?environment=SIMULATION',h);expect(r.statusCode).toBeGreaterThanOrEqual(400);expect(r.body).not.toContain('Synthetic');}}finally{await admin.query('UPDATE memberships SET active=true WHERE workspace_id=$1 AND user_id=$2',[one,user]);}});
 it.each(['selection','revocation'] as const)('keeps native %s blocked by the session parent until the real handler commits',async operation=>{
  const s=await selected();let release!:()=>void,entered!:(pid:number)=>void;
  const pause=new Promise<void>(r=>{release=r;}),ready=new Promise<number>(r=>{entered=r;});
  onCatalogRead=async c=>{entered((await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);await pause;};
  const reading=get('/v1/assets?environment=REAL',s.headers),readerPid=await ready,writer=await runtime.connect();
  let switching:Promise<unknown>|undefined;
  try{
   await writer.query('BEGIN');const writerPid=(await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   switching=operation==='selection'?selectProfileFromSession(writer,s.s,two,1):writer.query('DELETE FROM session WHERE id=$1 AND "userId"=$2',[s.s.id,s.s.userId]);void switching.catch(()=>undefined);
   let blocked:number[]=[];for(let attempt=0;attempt<50;attempt++){blocked=(await admin.query('SELECT pg_blocking_pids($1) pids',[writerPid])).rows[0].pids;if(blocked.includes(readerPid))break;await new Promise(r=>setTimeout(r,5));}
   expect(blocked).toContain(readerPid);release();const response=await reading;expect(response.statusCode,response.body).toBe(200);expect(response.json().data.map((x:any)=>x.id)).toEqual(await assets(one,'REAL'));
   await switching;await writer.query('COMMIT');expect((await get('/v1/assets',s.headers)).statusCode).toBe(operation==='selection'?409:401);
  }finally{release();onCatalogRead=undefined;await reading;await switching?.catch(()=>undefined);await writer.query('ROLLBACK');writer.release();}
 });
 it('does not release selected rows if the native PAT expires after the query',async()=>{const a=await pat(undefined,'1 second');delayedToken=a.id;const r=await get('/v1/assets?environment=SIMULATION',{authorization:'Bearer '+a.secret});expect(r.statusCode).toBeGreaterThanOrEqual(400);expect(r.body).not.toContain('Synthetic');expect(delayedToken).toBeUndefined();});
 function write(method:'POST'|'PATCH',url:string,headers:Record<string,string>,body:Record<string,unknown>,key=randomUUID()){
  return app.inject({method,url,headers:{...headers,origin:'https://fixture.example.test','idempotency-key':key},payload:{environment:'SIMULATION',...body}});
 }
 const flow={name:'Synthetic flow',nodes:[{id:'entry',type:'entry',next:'end'},{id:'end',type:'end'}],entry_node_id:'entry'};
 it('creates and edits all five materialized resource kinds with canonical SQL and audit',async()=>{
  const s=await selected();
  for(const[path,body]of[['categories',{name:'Synthetic category'}],['products',{name:'Synthetic product'}],['assets',{name:'Synthetic material'}],['workflows',flow],['agents',{name:'Synthetic seller'}]]as const){
   const created=await write('POST','/v1/'+path,s.headers,body);expect(created.statusCode,created.body).toBe(201);const row=created.json().data;
   const edited=await write('PATCH',`/v1/${path}/${row.id}`,s.headers,{expected_version:row.version,name:'Edited '+path});expect(edited.statusCode,edited.body).toBe(200);
   const native=(await admin.query('SELECT workspace_id,environment,body FROM records WHERE id=$1',[edited.json().data.id])).rows[0];expect(native).toMatchObject({workspace_id:one,environment:'SIMULATION',body:{name:'Edited '+path}});
   expect((await admin.query('SELECT count(*)::int n FROM domain_events WHERE aggregate_id=$1',[row.id])).rows[0].n).toBeGreaterThan(0);
  }
  const intent=await write('POST','/v1/assets/upload-intents',s.headers,{name:'Synthetic intent'});expect(intent.statusCode,intent.body).toBe(201);expect(intent.json().data.status).toBe('UPLOAD_PENDING');
 });
 it('requires both PAT scopes for an initial offer and rolls back a denied compound operation',async()=>{
  const body={name:'Compound product',initial_offer:{currency:'MXN',base_amount_minor:100}},limited=await pat(['products:write']);
  const before=(await admin.query('SELECT count(*)::int n FROM records')).rows[0].n;
  const denied=await write('POST','/v1/products',{authorization:'Bearer '+limited.secret},body);expect(denied.statusCode,denied.body).toBe(403);expect(denied.json().error.code).toBe('PROFILE_ACTION_FORBIDDEN');expect((await admin.query('SELECT count(*)::int n FROM records')).rows[0].n).toBe(before);
  const full=await pat(['products:write','offers:write']),r=await write('POST','/v1/products',{authorization:'Bearer '+full.secret},body);expect(r.statusCode,r.body).toBe(201);expect(r.json().data.initial_offer.product_id).toBe(r.json().data.id);
 });
 it('preserves idempotency and expected_version without a nested commit',async()=>{
  const s=await selected(),key=randomUUID(),body={name:'Idempotent product'};
  const a=await write('POST','/v1/products',s.headers,body,key),b=await write('POST','/v1/products',s.headers,body,key);expect(a.statusCode,a.body).toBe(201);expect(b.statusCode,b.body).toBe(201);expect(b.json()).toEqual(a.json());
  expect((await write('POST','/v1/products',s.headers,{name:'Different'},key)).statusCode).toBe(409);
  const id=a.json().data.id,v=a.json().data.version,patch={expected_version:v,name:'Revision two'};expect((await write('PATCH','/v1/products/'+id,s.headers,patch)).statusCode).toBe(200);expect((await write('PATCH','/v1/products/'+id,s.headers,patch)).statusCode).toBe(409);
  const versions=await get('/v1/products/'+id+'/versions?environment=SIMULATION',s.headers);expect(versions.statusCode,versions.body).toBe(200);expect(versions.json().data.map((v:any)=>v.version)).toEqual([2,1]);
 });
 it('uses canonical version, draft validation and publication readiness handlers',async()=>{
  const s=await selected(),product=await write('POST','/v1/products',s.headers,{name:'Versioned'}),id=product.json().data.id;
  const v=await write('POST',`/v1/products/${id}/versions`,s.headers,{expected_version:1,changes:{name:'Versioned two'}});expect(v.statusCode,v.body).toBe(201);
  const duplicated=await write('POST',`/v1/products/${id}/duplicate`,s.headers,{name:'Separate history'});expect(duplicated.statusCode,duplicated.body).toBe(200);expect(duplicated.json().data.id).not.toBe(id);
  const offer=await write('POST',`/v1/products/${id}/offers`,s.headers,{currency:'MXN',base_amount_minor:100});expect(offer.statusCode,offer.body).toBe(201);const oid=offer.json().data.id;
  const next=await write('POST',`/v1/offers/${oid}/versions`,s.headers,{expected_version:1,changes:{base_amount_minor:200}});expect(next.statusCode,next.body).toBe(201);
  expect((await get(`/v1/offers/${oid}/versions?environment=SIMULATION`,s.headers)).json().data).toHaveLength(2);
  const denied=await write('POST',`/v1/offers/${oid}/publish`,s.headers,{expected_version:1});expect(denied.statusCode,denied.body).toBe(409);expect(denied.json().error.code).toBe('OFFER_NOT_READY');
  const validate=await write('POST','/v1/workflows/validate',s.headers,flow);expect(validate.statusCode,validate.body).toBe(200);
  const applied=await write('POST','/v1/workflows/apply',s.headers,flow);expect(applied.statusCode,applied.body).toBe(201);
  const copied=await write('POST',`/v1/workflows/${applied.json().data.id}/duplicate`,s.headers,{});expect(copied.statusCode,copied.body).toBe(200);
 });
 it('rejects cross-profile and cross-environment mutation references',async()=>{
  const s=await selected(),other=await selected(two),r=await write('POST','/v1/products',other.headers,{name:'Foreign'}),id=r.json().data.id;
  expect(r.statusCode,r.body).toBe(201);expect((await write('PATCH',`/v1/products/${id}`,s.headers,{expected_version:1,name:'Intrusion'})).statusCode).toBe(404);
  expect((await write('PATCH',`/v1/products/${id}`,other.headers,{environment:'REAL',expected_version:1,name:'Cross environment'})).statusCode).toBe(404);
  expect((await admin.query('SELECT version,body FROM records WHERE id=$1',[id])).rows[0]).toMatchObject({version:1,body:{name:'Foreign'}});
 });
 it('denies read-only tokens and suspended profiles before inserting records',async()=>{
  const a=await pat(['products:read']),s=await selected();expect((await write('POST','/v1/products',{authorization:'Bearer '+a.secret},{name:'Denied'})).statusCode).toBe(403);
  async function state(value:'ACTIVE'|'SUSPENDED'){const c=await admin.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[one]);await c.query('UPDATE profiles SET state=$2,version=version+1 WHERE id=$1',[one,value]);await c.query('COMMIT');}finally{await c.query('ROLLBACK');c.release();}}
  await state('SUSPENDED');try{expect((await write('POST','/v1/products',s.headers,{name:'Denied suspended'})).statusCode).toBe(403);}finally{await state('ACTIVE');}
 });
 it('atomically enforces adopted REAL product quota through the HTTP handler',async()=>{
  const s=await selected();for(let i=0;i<2;i++){const r=await write('POST','/v1/products',s.headers,{environment:'REAL',name:'Quota '+i});expect(r.statusCode,r.body).toBe(201);}
  const third=await write('POST','/v1/products',s.headers,{environment:'REAL',name:'Overflow'});expect(third.statusCode).toBeGreaterThanOrEqual(400);
  expect((await admin.query("SELECT count(*)::int n FROM profile_quota_entries WHERE workspace_id=$1 AND kind='product'",[one])).rows[0].n).toBe(2);
  expect((await admin.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND environment='REAL' AND kind='product'",[one])).rows[0].n).toBe(2);
 });
 it('rolls back data, audit and idempotency when a PAT expires after INSERT',async()=>{
  const a=await pat(['products:write'],'1 second'),key=randomUUID(),before=(await admin.query('SELECT count(*)::int n FROM records')).rows[0].n,auditBefore=(await admin.query('SELECT count(*)::int n FROM domain_events')).rows[0].n;delayedToken=a.id;
  const r=await write('POST','/v1/products',{authorization:'Bearer '+a.secret},{name:'Expired write'},key);expect(r.statusCode).toBeGreaterThanOrEqual(400);expect(r.body).not.toContain('Expired write');expect(delayedToken).toBeUndefined();
  expect((await admin.query('SELECT count(*)::int n FROM records')).rows[0].n).toBe(before);expect((await admin.query('SELECT count(*)::int n FROM domain_events')).rows[0].n).toBe(auditBefore);expect((await admin.query('SELECT key FROM idempotency WHERE key=$1',[key])).rows).toEqual([]);
 });

 let nativeMarket:Awaited<ReturnType<typeof seedMarket>>|undefined;
 async function seedMarket(){
  async function record(kind:string,body:object){const id=randomUUID();await admin.query(`INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,'SIMULATION',$3,$4)`,[id,one,kind,body]);const row=(await admin.query('SELECT * FROM record_versions WHERE record_id=$1 AND version=1',[id])).rows[0];return{id,revision:1,sha256:marketRecordVersionHash(row)};}
  const product=await record('product',{name:'Native market product',status:'DRAFT'}),flow=await record('workflow',{name:'Native flow',status:'PUBLISHED',product_id:product.id}),seller=await record('agent',{name:'Native seller',product_id:product.id}),collection=await record('bank_profile',{name:'Native collection',currency:'MXN',private_sentinel:'NEVER_EXPOSE_THIS_VALUE'}),material=await record('asset',{name:'Native material',status:'READY'});
  const offer=await record('offer',{name:'Native offer',product_id:product.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:10000,workflow_version_id:flow.id,agent_version_id:seller.id,payment_profile_version_id:collection.id,fulfillment:[{asset_id:material.id}]});
  return{product,refs:{offer,flow,seller,collection,material}};
 }
 async function market(){return nativeMarket??=await seedMarket();}
 it('projects native immutable option hashes without adopting a family or returning source bodies',async()=>{
  const m=await market(),s=await selected(),r=await get(`/v2/market/products/${m.product.id}/options?environment=SIMULATION`,s.headers);expect(r.statusCode,r.body).toBe(200);
  const value=r.json().data;expect(value.product).toEqual({id:m.product.id,version:1,name:'Native market product',adopted:false});expect(value.scope).toEqual({workspace_id:one,environment:'SIMULATION'});
  expect(value.options).toHaveLength(5);for(const option of value.options)expect(option.ref).toEqual(m.refs[option.kind as keyof typeof m.refs]);
  expect(r.body).not.toContain('NEVER_EXPOSE_THIS_VALUE');expect(r.body).not.toContain('body');expect((await admin.query('SELECT id FROM market_families WHERE id=$1',[m.product.id])).rows).toEqual([]);
 });
 it('hides product options across native profiles and environments despite a valid UUID',async()=>{
  const m=await market(),s=await selected(two),own=await selected();
  for(const[url,h]of[[`/v2/market/products/${m.product.id}/options?environment=SIMULATION`,s.headers],[`/v2/market/products/${m.product.id}/options?environment=REAL`,own.headers]]as const){const r=await get(url,h);expect(r.statusCode,r.body).toBe(404);expect(r.body).not.toContain('Native market');}
 });
 it('requires variants/read for projected options and keeps PAT environment fixed',async()=>{
  const m=await market(),allowed=await pat(['variants:read']),denied=await pat(['materials:read']),url=`/v2/market/products/${m.product.id}/options?environment=SIMULATION`;
  expect((await get(url,{authorization:'Bearer '+allowed.secret})).statusCode).toBe(200);expect((await get(url,{authorization:'Bearer '+denied.secret})).statusCode).toBe(403);
  expect((await get(url.replace('SIMULATION','REAL'),{authorization:'Bearer '+allowed.secret})).statusCode).toBe(401);
 });
 it('publishes a variant from projected references through explicit native operations without creating effects',async()=>{
  const m=await market(),s=await selected(),r=await get(`/v2/market/products/${m.product.id}/options?environment=SIMULATION`,s.headers);expect(r.statusCode,r.body).toBe(200);
  const refs=Object.fromEntries(r.json().data.options.map((v:any)=>[v.kind,v.ref]));
  const before=(await admin.query("SELECT (SELECT count(*) FROM outbox) effects,(SELECT count(*) FROM records WHERE kind='binding') bindings")).rows[0];
  async function post(path:string,body:object,key=randomUUID()){return app.inject({method:'POST',url:path+'?environment=SIMULATION',headers:{...s.headers,origin:'https://fixture.example.test','idempotency-key':key},payload:body});}
  const family=await post('/v2/market/families',{product_id:m.product.id,expected_product_version:1});expect(family.statusCode,family.body).toBe(200);
  const fields={locale:{market:'México',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'},amount_minor:10000,configuration:{offer:refs.offer,flow:refs.flow,seller:refs.seller,collection:refs.collection,remarketing:refs.offer,materials:[refs.material]}};
  const createKey=randomUUID(),created=await post('/v2/market/variants',{family_id:m.product.id,fields},createKey);expect(created.statusCode,created.body).toBe(200);const draft=created.json().data;
  expect((await get(`/v2/market/operations/${createKey}?environment=SIMULATION`,s.headers)).json()).toEqual(created.json());
  const published=await post(`/v2/market/variants/${draft.id}/releases`,{expected_version:draft.version,draft_sha256:draft.draft_sha256,reviewed_fields:marketCopyReviewFields});expect(published.statusCode,published.body).toBe(200);expect(published.json().data.effects_authorized).toBe(false);
  expect(published.json().data.release.configuration).toEqual(fields.configuration);expect((await admin.query("SELECT (SELECT count(*) FROM outbox) effects,(SELECT count(*) FROM records WHERE kind='binding') bindings")).rows[0]).toEqual(before);
  expect((await get(`/v2/market/products/${m.product.id}/options?environment=SIMULATION`,s.headers)).json().data.product.adopted).toBe(true);
 });
 it('withholds projected option data when the PAT expires during the native product read',async()=>{
  const m=await market(),a=await pat(['variants:read'],'1 second');delayedToken=a.id;
  const r=await get(`/v2/market/products/${m.product.id}/options?environment=SIMULATION`,{authorization:'Bearer '+a.secret});expect(r.statusCode,r.body).toBeGreaterThanOrEqual(400);expect(r.body).not.toContain('Native market');expect(delayedToken).toBeUndefined();
 });

 async function salesRecords(environment='SIMULATION',workspace=one){
  const c=await admin.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment',$2,true)",[workspace,environment]);
   async function record(kind:string,body:object){const id=randomUUID();await c.query('INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,$3,$4,$5)',[id,workspace,environment,kind,body]);return id;}
   const contact=await record('contact',{name:'Synthetic sales contact'}),conversation=await record('conversation',{contact_id:contact,status:'ACTIVE',stage:'NEW'}),order=await record('order',{conversation_id:conversation,contact_id:contact,status:'COMMITTED',currency:'MXN',amount_minor:100}),receipt=await record('receipt',{conversation_id:conversation,order_id:order,status:'HUMAN_REVIEW'});
   await record('message',{conversation_id:conversation,direction:'inbound',text:'Synthetic sales context'});await c.query('COMMIT');return{contact,conversation,order,receipt};
  }finally{await c.query('ROLLBACK');c.release();}
 }
 it('reads selected sales context and requires the additional scopes of nested domains',async()=>{
  const r=await salesRecords(),s=await selected(),detail=await get(`/v1/conversations/${r.conversation}?environment=SIMULATION`,s.headers);expect(detail.statusCode,detail.body).toBe(200);expect(detail.json().data.messages[0].text).toBe('Synthetic sales context');expect(detail.json().data.order.id).toBe(r.order);
  const a=await pat(['conversations:read']),h={authorization:'Bearer '+a.secret};expect((await get('/v1/conversations?environment=SIMULATION',h)).statusCode).toBe(200);expect((await get(`/v1/conversations/${r.conversation}?environment=SIMULATION`,h)).statusCode).toBe(403);
  for(const path of['contacts','leads','orders','receipts','fulfillments','touchpoints'])expect((await get('/v1/'+path+'?environment=SIMULATION',s.headers)).statusCode,path).toBe(200);
 });
 it('allows the native viewer sales reads but rejects every reviewed decision before mutation',async()=>{
  const r=await salesRecords();await admin.query("UPDATE memberships SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[one,user]);try{const s=await selected();for(const[path,id]of[['orders',r.order],['receipts',r.receipt]])expect((await get(`/v1/${path}/${id}?environment=SIMULATION`,s.headers)).statusCode).toBe(200);
   const before=(await admin.query('SELECT count(*) n FROM commands')).rows[0].n;
   for(const[url,body]of[[`/v1/conversations/${r.conversation}/commands`,{type:'commitment'}],[`/v1/receipts/${r.receipt}/review`,{decision:'HUMAN_REVIEW',reason:'Synthetic review',expected_version:1}]])expect((await write('POST',url as string,s.headers,body as Record<string,unknown>)).statusCode).toBe(403);
   expect((await admin.query('SELECT count(*) n FROM commands')).rows[0].n).toBe(before);
  }finally{await admin.query("UPDATE memberships SET role='operator' WHERE workspace_id=$1 AND user_id=$2",[one,user]);}
 });
 it('records one durable command and reconciles the native actor UUID without re-execution',async()=>{
  const r=await salesRecords(),s=await selected(),key=randomUUID(),body={type:'set_stage',stage:'ACTIVE',reason:'Synthetic stage'},url=`/v1/conversations/${r.conversation}/commands`;
  const accepted=await write('POST',url,s.headers,body,key);expect(accepted.statusCode,accepted.body).toBe(202);const replay=await write('POST',url,s.headers,body,key);expect(replay.json()).toEqual(accepted.json());
  const read=await get(`/v1/sales-operations/${key}?environment=SIMULATION&operation=conversation.command&resource_id=${r.conversation}`,s.headers);expect(read.statusCode,read.body).toBe(200);expect(read.json().data.command).toEqual(accepted.json().data);expect(read.json().data.command.status).toBe('PENDING');
  expect((await admin.query('SELECT count(*)::int n FROM commands WHERE workspace_id=$1 AND actor_id=$2 AND idempotency_key=$3',[one,user,key])).rows[0].n).toBe(1);
  expect((await write('POST',url,s.headers,{...body,stage:'NEW'},key)).statusCode).toBe(409);
  expect((await get(`/v1/commands/${accepted.json().data.id}?environment=SIMULATION`,s.headers)).json().data.id).toBe(accepted.json().data.id);
 });
 it('isolates operation reconciliation by token actor, scope, resource, profile and environment',async()=>{
  const r=await salesRecords(),a=await pat(['conversations:write','conversations:read','operations:read']),b=await pat(['conversations:write','conversations:read','operations:read']),key=randomUUID(),h={authorization:'Bearer '+a.secret};
  const accepted=await write('POST',`/v1/conversations/${r.conversation}/commands`,h,{type:'commitment'},key);expect(accepted.statusCode,accepted.body).toBe(202);
  const url=`/v1/sales-operations/${key}?environment=SIMULATION&operation=conversation.command&resource_id=${r.conversation}`;
  expect((await get(url,h)).statusCode).toBe(200);const missing=await get(url,{authorization:'Bearer '+b.secret});expect(missing.statusCode,missing.body).toBe(404);expect(missing.json().error.code).toBe('SALES_OPERATION_NOT_FOUND');
  for(const altered of[url.replace(r.conversation,randomUUID()),url.replace(key,randomUUID())])expect((await get(altered,h)).json().error.code).toBe('SALES_OPERATION_NOT_FOUND');
  expect((await get(url.replace('SIMULATION','REAL'),h)).statusCode).toBe(401);const s=await selected(two);expect((await get(url,s.headers)).json().error.code).toBe('SALES_OPERATION_NOT_FOUND');
  const denied=await pat(['operations:read']);expect((await get(url,{authorization:'Bearer '+denied.secret})).statusCode).toBe(403);
 });
 it('keeps profile message intent free of temporal authority and performs no send or outbox creation',async()=>{
  const r=await salesRecords('REAL'),s=await selected(),before=(await admin.query('SELECT count(*) n FROM outbox')).rows[0].n;
  const accepted=await write('POST',`/v1/conversations/${r.conversation}/commands`,s.headers,{environment:'REAL',type:'send_message',kind:'text',text:'Synthetic manual intent'});expect(accepted.statusCode,accepted.body).toBe(202);expect(accepted.json().data.payload.authorization_id).toBeUndefined();
  const rejected=await write('POST',`/v1/conversations/${r.conversation}/commands`,s.headers,{environment:'REAL',type:'send_message',text:'Synthetic',authorization_id:randomUUID()});expect(rejected.statusCode,rejected.body).toBe(400);expect(rejected.json().error.code).toBe('PROFILE_TEMPORAL_AUTHORIZATION_FORBIDDEN');
  expect((await admin.query('SELECT count(*) n FROM outbox')).rows[0].n).toBe(before);
 });
 it('writes selected controls atomically with a durable command and actor reconciliation',async()=>{
  const r=await salesRecords(),s=await selected(),key=randomUUID(),accepted=await write('POST',`/v1/conversations/${r.conversation}/controls`,s.headers,{paused:true,reason:'Synthetic pause'},key);expect(accepted.statusCode,accepted.body).toBe(202);
  expect((await admin.query('SELECT workspace_id,environment,paused FROM manual_controls WHERE scope_id=$1',[r.conversation])).rows[0]).toEqual({workspace_id:one,environment:'SIMULATION',paused:true});
  const read=await get(`/v1/sales-operations/${key}?environment=SIMULATION&operation=conversation.controls&resource_id=${r.conversation}`,s.headers);expect(read.statusCode,read.body).toBe(200);expect(read.json().data.command.id).toBe(accepted.json().data.command_id);
 });
 it('reconciles outbox cancel from its durable 202 even though the legacy HTTP response is 200',async()=>{
  const r=await salesRecords(),s=await selected(),key=randomUUID(),c=await admin.connect();let effect:string;
  try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','SIMULATION',true)",[one]);effect=(await c.query("INSERT INTO outbox(workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,config_hash) VALUES($1,'SIMULATION','synthetic-account',$2,$3,$4,'{}','synthetic-config') RETURNING id",[one,r.conversation,r.contact,randomUUID()])).rows[0].id;await c.query('COMMIT');}finally{await c.query('ROLLBACK');c.release();}
  const accepted=await write('POST',`/v1/outbox/${effect!}/cancel`,s.headers,{reason:'Synthetic cancel'},key);expect(accepted.statusCode,accepted.body).toBe(200);
  expect((await admin.query('SELECT status_code FROM idempotency WHERE key=$1',[key])).rows[0].status_code).toBe(202);
  const read=await get(`/v1/sales-operations/${key}?environment=SIMULATION&operation=outbox.cancel&resource_id=${effect!}`,s.headers);expect(read.statusCode,read.body).toBe(200);expect(read.json().data.command.id).toBe(accepted.json().data.id);expect(read.json().data.command.payload.effect_id).toBe(effect!);
 });
 it('accepts a review once at the displayed version and refuses another pending decision',async()=>{
  const r=await salesRecords(),a=await pat(['receipts:review','receipts:read','operations:read']),h={authorization:'Bearer '+a.secret},key=randomUUID(),url=`/v1/receipts/${r.receipt}/review`,body={decision:'HUMAN_REVIEW',reason:'Synthetic decision',expected_version:1};
  const first=await write('POST',url,h,body,key);expect(first.statusCode,first.body).toBe(202);expect((await write('POST',url,h,body,key)).json()).toEqual(first.json());expect((await write('POST',url,h,body)).json().error.code).toBe('RECEIPT_REVIEW_PENDING');
  expect((await get(`/v1/sales-operations/${key}?environment=SIMULATION&operation=receipt.review&resource_id=${r.receipt}`,h)).json().data.command.id).toBe(first.json().data.id);
  const second=await salesRecords();expect((await write('POST',`/v1/receipts/${second.receipt}/review`,h,{...body,expected_version:2})).json().error.code).toBe('VERSION_CONFLICT');
 });
 it('rejects cross-profile decisions and unauthorized financial classifications',async()=>{
  const r=await salesRecords(),s=await selected(two),before=(await admin.query('SELECT count(*) n FROM commands')).rows[0].n;
  expect((await write('POST',`/v1/conversations/${r.conversation}/commands`,s.headers,{type:'commitment'})).statusCode).toBe(404);
  const denied=await pat(['receipts:review']);expect((await write('POST',`/v1/receipts/${r.receipt}/classification`,{authorization:'Bearer '+denied.secret},{classification:'FALSE',reason:'Synthetic classification',expected_version:1})).statusCode).toBe(403);
  expect((await admin.query('SELECT count(*) n FROM commands')).rows[0].n).toBe(before);
  const owner=await selected(),accepted=await write('POST',`/v1/orders/${r.order}/classification`,owner.headers,{classification:'TEST',reason:'Synthetic classification',expected_version:1});expect(accepted.statusCode,accepted.body).toBe(202);
 });
 it('rejects unknown reconciliation shapes and does not release data after final credential expiry',async()=>{
  const r=await salesRecords(),a=await pat(['conversations:read','orders:read','offers:read'],'1 second');delayedToken=a.id;
  const hidden=await get(`/v1/conversations/${r.conversation}?environment=SIMULATION`,{authorization:'Bearer '+a.secret});expect(hidden.statusCode,hidden.body).toBeGreaterThanOrEqual(400);expect(hidden.body).not.toContain('Synthetic sales context');
  const s=await selected();for(const query of['operation=arbitrary&resource_id='+r.conversation,'operation=conversation.command&resource_id='+r.conversation+'&actor_id='+user])expect((await get('/v1/sales-operations/'+randomUUID()+'?environment=SIMULATION&'+query,s.headers)).statusCode).toBe(400);
 });
 it('leaves no profile or environment on all pooled connections',async()=>{const cs=await Promise.all(Array.from({length:5},()=>runtime.connect()));try{for(const c of cs){expect((await c.query("SELECT NULLIF(current_setting('app.workspace_id',true),'') w,NULLIF(current_setting('app.environment',true),'') e")).rows[0]).toEqual({w:null,e:null});expect((await c.query('SELECT id FROM records')).rows).toEqual([]);}}finally{cs.forEach(c=>c.release());}});
});
