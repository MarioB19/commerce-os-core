import {randomBytes,randomUUID} from 'node:crypto';
import Fastify,{type FastifyInstance} from 'fastify';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {profileIntegrationRoutes} from '../../apps/api/src/profile-integrations.js';
import {withProfileTransaction} from '../../packages/db/src/profile-context.js';
import {bindProfileEnvironment} from '../../packages/db/src/profile-environment.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../packages/domain/src/core/profile-authorization.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {fixtureProfileRow,requireMigratedProfileSchema} from '../support/migrated-database.js';

// V7 F2 profile integrations over HTTP routes and restricted PostgreSQL roles:
// commerce_api stores only ciphertext and a hint; the single verification runs
// through the closed commerce_ai role against a fake provider (no real keys).
const suffix=randomBytes(8).toString('hex'),apiLogin='integrations_api_'+suffix,aiLogin='integrations_ai_'+suffix,origin='https://commerce.example.test';
const created:string[]=[],key=randomBytes(32);
let admin:pg.Pool,api:pg.Pool,ai:pg.Pool,app:FastifyInstance,providerCalls=0,providerStatus=200,graph:(path:string)=>{status:number;body:unknown}=()=>({status:500,body:{}});
const one='integrations-one-'+suffix,two='integrations-two-'+suffix;
const users={owner:'owner-'+suffix,operator:'operator-'+suffix,viewer:'viewer-'+suffix,other:'other-'+suffix};
type Kind='session'|'personal_token';
async function authority(db:{query:(s:string,v?:unknown[])=>Promise<{rows:any[]}>},workspace:string,user:string,kind:Kind):Promise<ProfileAuthority>{
 const m=(await db.query('SELECT role,active,version FROM memberships WHERE workspace_id=$1 AND user_id=$2',[workspace,user])).rows[0];
 const p=(await db.query('SELECT state FROM profiles WHERE id=$1',[workspace])).rows[0];
 if(!m||!p)throw Object.assign(Error('PROFILE_MEMBERSHIP_REQUIRED'),{code:'PROFILE_MEMBERSHIP_REQUIRED',statusCode:403});
 return{profile:{id:workspace,state:p.state},membership:{userId:user,workspaceId:workspace,role:m.role,active:m.active,version:m.version},
  credential:{kind,userId:user,workspaceId:workspace,revoked:false,expiresAt:new Date(Date.now()+3600000).toISOString(),scopes:kind==='session'?[]:['integrations:read','integrations:write','profile:read','profile:write'],...(kind==='session'?{membershipVersion:m.version}:{})}};
}
function run(kind:Kind){
 return async(user:string,fence:{workspaceId:string},environment:'REAL'|'SIMULATION',action:any,work:any)=>withProfileTransaction(api,fence.workspaceId,async db=>{
  const auth=await authority(db,fence.workspaceId,user,kind);
  try{authorizeProfileAction(auth,{...action,workspaceId:fence.workspaceId},new Date());}catch(error){throw Object.assign(error as Error,{statusCode:403,code:(error as {code:string}).code});}
  await bindProfileEnvironment(db,environment);
  return work({db,profile:{authority:auth},environment});
 });
}
function call(method:string,url:string,user:string,workspace:string,body?:unknown,kind:Kind='session'){
 return app.inject({method:method as 'GET',url,headers:{origin,'x-user':user,'x-kind':kind,'x-commerce-profile-id':workspace,'x-commerce-profile-version':'1',...(body?{'content-type':'application/json'}:{})},...(body?{payload:JSON.stringify(body)}:{})});
}
function openAiResponse(){return new Response(JSON.stringify({model:'synthetic-verify',status:'completed',service_tier:'default',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'OK'}]}],usage:{input_tokens:3,output_tokens:1,input_tokens_details:{cached_tokens:0}}}),{status:providerStatus,headers:{'content-type':'application/json'}});}
async function savedKey(workspace:string,user=users.owner,expectedRevision=0,secret='sk-synthetic-'+randomBytes(16).toString('hex')){
 const r=await call('PUT','/v2/integrations/ai/openai/key',user,workspace,{operationId:randomUUID(),expectedRevision,key:secret});return{r,secret,body:r.json()};
}
describe('V7 profile integrations: own AI keys, own Meta token and onboarding',()=>{
 beforeAll(async()=>{
  vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:4,connectionTimeoutMillis:5000});await requireMigratedProfileSchema(admin);
  const pools:pg.Pool[]=[];
  for(const [name,role] of [[apiLogin,'commerce_api'],[aiLogin,'commerce_ai']] as const){
   const password=randomBytes(24).toString('hex');
   await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;GRANT ${role} TO "${name}"`);
   const u=new URL(url);u.username=name;u.password=password;const pool=new pg.Pool({connectionString:u.toString(),max:4});pool.on('connect',c=>{void c.query(`SET ROLE ${role}`);});pools.push(pool);
  }
  [api,ai]=pools as [pg.Pool,pg.Pool];
  for(const id of [one,two])await fixtureProfileRow(admin,created,id,{businessName:'Synthetic '+id,numbers:0});
  for(const [user,role,workspace] of [[users.owner,'owner',one],[users.operator,'operator',one],[users.viewer,'viewer',one],[users.other,'owner',two]] as const){
   await admin.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true) ON CONFLICT DO NOTHING',[user,user+'@example.test']);
   await admin.query('INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,$3)',[user,workspace,role]);
  }
  const now=(await admin.query('SELECT clock_timestamp() now')).rows[0].now.getTime();
  const model={provider:'openai',model:'synthetic-verify',revision:'synthetic-verify-v1',transport:'responses',capabilities:['chat'],responseModels:['synthetic-verify'],inputTokenCeiling:100,outputTokenCeiling:10,
   price:{version:'synthetic-price-v1',validFrom:new Date(now-86400000).toISOString(),validUntil:new Date(now+30*86400000).toISOString(),currency:'USD',input:1000000,output:2000000,cacheRead:500000,cacheWrite:1000000,audioInput:1000000}};
  await admin.query(`INSERT INTO ai_model_prices(provider,model,model_revision,price_version,valid_from,valid_until,input_ceiling,output_ceiling,input_rate,output_rate,cache_read_rate,cache_write_rate,audio_input_rate,model_document) VALUES('openai','synthetic-verify','synthetic-verify-v1','synthetic-price-v1',$1,$2,100,10,1000000,2000000,500000,1000000,1000000,$3)`,[model.price.validFrom,model.price.validUntil,model]);
  app=Fastify({logger:false});
  app.setErrorHandler((e:any,_r,reply)=>reply.code(e.statusCode??500).send({error:{code:e.code??e.message}}));
  const deps={origins:[origin],
   nativeSession:async(req:any)=>({id:'session-'+req.headers['x-user'],userId:String(req.headers['x-user'])}),
   session:(s:any,f:any,e:any,a:any,w:any)=>run('session')(s.userId,f,e,a,w),
   personal:async()=>{throw Object.assign(Error('unused'),{statusCode:500});}};
  await app.register(async scoped=>{
   scoped.addHook('onRequest',async req=>{if(req.headers['x-kind']==='personal_token'){req.headers.authorization='Bearer cos_pat_'+'a'.repeat(43);delete req.headers['x-commerce-profile-id'];delete req.headers['x-commerce-profile-version'];}});
   await profileIntegrationRoutes(scoped,{request:{...deps,personal:(_t:string,e:any,a:any,w:any)=>run('personal_token')(users.owner,{workspaceId:one},e,a,w)},
    aiKey:()=>key,aiRuntime:()=>({pool:ai,key,fetcher:async url=>{providerCalls++;expect(String(url)).toBe('https://api.openai.com/v1/responses');return openAiResponse();}}),
    metaFetcher:async url=>{const r=graph(new URL(String(url)).pathname+new URL(String(url)).search);return new Response(JSON.stringify(r.body),{status:r.status,headers:{'content-type':'application/json'}});}});
  });
  await app.ready();
 });
 afterAll(async()=>{await app?.close();await api?.end();await ai?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${apiLogin}";DROP ROLE IF EXISTS "${aiLogin}"`);}finally{await admin.end();}}vi.unstubAllEnvs();});

 it('starts with nothing configured and hides integrations from read-only members',async()=>{
  const r=await call('GET','/v2/integrations',users.operator,one);expect(r.statusCode).toBe(200);
  const data=r.json().data;expect(data.ai.providers.map((p:any)=>p.state)).toEqual(['MISSING','MISSING','MISSING']);expect(data.meta.state).toBe('MISSING');
  // F4 installs the reviewed catalogue (0106) next to this test's synthetic model.
  expect(data.ai.models).toEqual(expect.arrayContaining([{provider:'openai',model:'synthetic-verify',capabilities:['chat']},{provider:'anthropic',model:'claude-haiku-5-5',capabilities:['chat','vision']}]));
  expect((await call('GET','/v2/integrations',users.viewer,one)).statusCode).toBe(403);
  expect((await call('GET','/v2/onboarding',users.viewer,one)).json().data).toMatchObject({next:'ai',complete:false,steps:{ai:'PENDING',meta:'PENDING',product:'PENDING',number:'PENDING'}});
 });
 it('stores a key as ciphertext with a four-character hint and needs a monthly limit before verifying',async()=>{
  const {r,secret}=await savedKey(one);expect(r.statusCode).toBe(200);const text=r.body;expect(text).not.toContain(secret);
  const data=r.json().data;expect(data.verification).toEqual({state:'UNAVAILABLE',code:'AI_BUDGET_REQUIRED'});
  const openai=data.integrations.ai.providers[0];expect(openai).toMatchObject({provider:'openai',state:'UNVERIFIED',revision:1,hint:'••••'+secret.slice(-4)});
  const stored=(await admin.query('SELECT ciphertext::text,key_hint FROM ai_credential_versions WHERE workspace_id=$1',[one])).rows;
  expect(stored).toHaveLength(1);expect(stored[0].ciphertext).not.toContain(secret);expect(stored[0].key_hint).toBe(secret.slice(-4));
  await expect(withProfileTransaction(api,one,db=>db.query('SELECT ciphertext FROM ai_credential_versions'))).rejects.toThrow(/permission denied/);
  expect(providerCalls).toBe(0);
 });
 it('verifies a new revision exactly once through the closed AI role after a limit is saved',async()=>{
  expect((await call('PUT','/v2/integrations/ai/preferences',users.operator,one,{expectedVersion:0,monthlyLimitMicrousd:5_000_000})).statusCode).toBe(403);
  const pref=await call('PUT','/v2/integrations/ai/preferences',users.owner,one,{expectedVersion:0,monthlyLimitMicrousd:5_000_000,defaultProvider:'openai',defaultModel:'synthetic-verify'});
  expect(pref.statusCode).toBe(200);expect(pref.json().data).toMatchObject({version:1,monthlyLimitMicrousd:5_000_000});
  expect((await call('PUT','/v2/integrations/ai/preferences',users.owner,one,{expectedVersion:0,monthlyLimitMicrousd:6_000_000})).statusCode).toBe(409);
  expect((await call('PUT','/v2/integrations/ai/preferences',users.owner,one,{expectedVersion:1,defaultProvider:'anthropic',defaultModel:'not-in-catalog'})).statusCode).toBe(400);
  const calls=providerCalls,{r}=await savedKey(one,users.owner,1);expect(r.statusCode).toBe(200);
  const data=r.json().data;expect(data.verification).toEqual({state:'VERIFIED'});expect(providerCalls).toBe(calls+1);
  expect(data.integrations.ai.providers[0]).toMatchObject({state:'VERIFIED',revision:2});
  expect(data.integrations.ai.budget).toMatchObject({limitMicrousd:5_000_000});expect(data.integrations.ai.budget.usedMicrousd).toBeGreaterThan(0);
  expect((await call('GET','/v2/onboarding',users.owner,one)).json().data).toMatchObject({next:'meta',steps:{ai:'DONE'}});
 });
 it('reports a rejected verification as failed and never retries it',async()=>{
  providerStatus=401;try{const calls=providerCalls,{r}=await savedKey(one,users.owner,2);expect(r.json().data.verification).toEqual({state:'FAILED',code:'HTTP_REJECTED'});expect(providerCalls).toBe(calls+1);
   expect(r.json().data.integrations.ai.providers[0]).toMatchObject({state:'FAILED',failure:'HTTP_REJECTED',revision:3});}finally{providerStatus=200;}
  const recovered=await savedKey(one,users.owner,3);expect(recovered.r.json().data.verification).toEqual({state:'VERIFIED'});
 });
 it('keeps secrets interactive-only, CAS-protected and inside their profile',async()=>{
  expect((await savedKey(one,users.owner,3)).r.statusCode).toBe(409);
  const pat=await call('PUT','/v2/integrations/ai/openai/key',users.owner,one,{operationId:randomUUID(),expectedRevision:4,key:'sk-'+randomBytes(12).toString('hex')},'personal_token');
  expect(pat.statusCode).toBe(403);expect(pat.json().error.code).toBe('PROFILE_INTERACTIVE_SESSION_REQUIRED');
  expect((await call('GET','/v2/integrations',users.owner,one,undefined,'personal_token')).statusCode).toBe(200);
  expect((await savedKey(one,users.operator,4)).r.statusCode).toBe(403);
  expect((await call('GET','/v2/integrations',users.other,one)).statusCode).toBe(403);
  const other=(await call('GET','/v2/integrations',users.other,two)).json().data;expect(other.ai.providers[0].state).toBe('MISSING');expect(other.ai.budget).toBeNull();
  const leaked=await withProfileTransaction(api,two,db=>db.query('SELECT count(*)::int n FROM ai_credentials'));expect(leaked.rows[0].n).toBe(0);
 });
 it('disables and re-enables a key without touching the secret, and onboarding follows',async()=>{
  const off=await call('POST','/v2/integrations/ai/openai/state',users.owner,one,{expectedRevision:4,enabled:false});expect(off.statusCode).toBe(200);expect(off.json().data).toEqual({provider:'openai',revision:4,enabled:false});
  expect((await call('GET','/v2/integrations',users.owner,one)).json().data.ai.providers[0].state).toBe('DISABLED');
  expect((await call('GET','/v2/onboarding',users.owner,one)).json().data.steps.ai).toBe('PENDING');
  expect((await call('POST','/v2/integrations/ai/openai/state',users.owner,one,{expectedRevision:4,enabled:true})).statusCode).toBe(200);
  expect((await call('POST','/v2/integrations/ai/openai/state',users.owner,one,{expectedRevision:9,enabled:true})).statusCode).toBe(409);
 });
 it('checks the Meta token with official reads only and records the exact revision',async()=>{
  const token='EAAG'+randomBytes(24).toString('hex'),seen:string[]=[];
  graph=path=>{seen.push(path);return path.startsWith('/v26.0/me/permissions')?{status:200,body:{data:[{permission:'ads_read',status:'granted'},{permission:'business_management',status:'granted'},{permission:'ads_management',status:'declined'}]}}:{status:200,body:{id:'synthetic'}};};
  const r=await call('PUT','/v2/integrations/meta/token',users.owner,one,{expectedRevision:0,token});expect(r.statusCode).toBe(200);expect(r.body).not.toContain(token);
  expect(r.json().data.check).toEqual({state:'VERIFIED'});expect(r.json().data.integrations.meta).toMatchObject({state:'VERIFIED',revision:1,hint:'••••'+token.slice(-4),grantedScopes:['ads_read','business_management']});
  expect(seen).toEqual(['/v26.0/me?fields=id','/v26.0/me/permissions']);
  const stored=(await admin.query('SELECT ciphertext FROM meta_profile_credential_versions WHERE workspace_id=$1',[one])).rows[0].ciphertext;expect(stored).not.toContain(token);
  graph=path=>path.startsWith('/v26.0/me/permissions')?{status:200,body:{data:[{permission:'business_management',status:'granted'}]}}:{status:200,body:{id:'synthetic'}};
  expect((await call('PUT','/v2/integrations/meta/token',users.owner,one,{expectedRevision:1,token:'EAAG'+randomBytes(24).toString('hex')})).json().data.integrations.meta).toMatchObject({state:'INVALID',reason:'META_PERMISSION_MISSING',revision:2});
  graph=()=>({status:400,body:{error:{code:190}}});
  expect((await call('PUT','/v2/integrations/meta/token',users.owner,one,{expectedRevision:2,token:'EAAG'+randomBytes(24).toString('hex')})).json().data.integrations.meta).toMatchObject({state:'INVALID',reason:'META_TOKEN_EXPIRED',revision:3});
  graph=()=>({status:503,body:{}});
  const unknown=await call('PUT','/v2/integrations/meta/token',users.owner,one,{expectedRevision:3,token:'EAAG'+randomBytes(24).toString('hex')});
  expect(unknown.json().data).toMatchObject({check:{state:'UNKNOWN',reason:'META_UPSTREAM_UNAVAILABLE'},integrations:{meta:{state:'UNVERIFIED',revision:4,checkedAt:null}}});
 });
 it('persists only the Meta skip and dismissal, owner-only, with CAS',async()=>{
  expect((await call('PATCH','/v2/onboarding',users.operator,one,{expectedVersion:0,metaSkipped:true})).statusCode).toBe(403);
  const skipped=await call('PATCH','/v2/onboarding',users.owner,one,{expectedVersion:0,metaSkipped:true});expect(skipped.statusCode).toBe(200);
  expect(skipped.json().data).toMatchObject({version:1,next:'product',steps:{ai:'DONE',meta:'SKIPPED'}});
  expect((await call('PATCH','/v2/onboarding',users.owner,one,{expectedVersion:0,dismissed:true})).statusCode).toBe(409);
  expect((await call('GET','/v2/onboarding',users.other,two)).json().data).toMatchObject({version:0,next:'ai'});
 });
});
