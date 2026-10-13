import {createHash,randomBytes,randomUUID} from 'node:crypto';
import Fastify,{type FastifyInstance} from 'fastify';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {profileRuntimeRoutes} from '../../apps/api/src/profile-runtime.js';
import {withPersonalProfileTransaction} from '../../packages/db/src/profile-personal-token.js';
import {bindProfileEnvironment} from '../../packages/db/src/profile-environment.js';
import {profileRoleScopes,type ProfileRole} from '../../packages/contracts/src/profiles.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {fixtureProfileRow,requireMigratedProfileSchema} from '../support/migrated-database.js';

// V7 ISO (RF-01.9, RF-15.c): two profiles, three roles, real personal tokens
// through the composed V2 runtime with the restricted API role. Token A never
// reads or writes any object of B, by listing, ID or operation UUID.
const suffix=randomBytes(6).toString('hex'),apiLogin='iso_api_'+suffix,origin='https://commerce.example.test',created:string[]=[];
const A='iso-a-'+suffix,B='iso-b-'+suffix;
type Actor={user:string;workspace:string;role:ProfileRole;token:string;tokenId:string};
const actors:Record<string,Actor>={};
const ids={productA:randomUUID(),productB:randomUUID(),goalA:randomUUID(),goalB:randomUUID(),familyB:randomUUID(),variantB:randomUUID(),opB:randomUUID()};
let admin:pg.Pool,api:pg.Pool,app:FastifyInstance;
async function actor(name:string,workspace:string,role:ProfileRole){
 const user=name+'-'+suffix,token='cos_pat_'+randomBytes(32).toString('base64url'),tokenId=randomUUID();
 await admin.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true)',[user,user+'@example.test']);
 await admin.query('INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,$3)',[user,workspace,role]);
 const scopes=profileRoleScopes[role].filter(s=>s!=='profiles:switch');
 await admin.query(`INSERT INTO personal_access_tokens(id,workspace_id,user_id,name,token_hash,allowed_environments,expires_at,profile_scopes) VALUES($1,$2,$3,'ISO',$4,'["REAL"]',clock_timestamp()+interval '1 day',$5)`,
  [tokenId,workspace,user,createHash('sha256').update(token).digest('hex'),JSON.stringify(scopes)]);
 actors[name]={user,workspace,role,token,tokenId};
}
const call=(who:string,method:string,url:string,body?:unknown,headers:Record<string,string>={})=>app.inject({method:method as 'GET',url,headers:{authorization:'Bearer '+actors[who]!.token,...headers,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{payload:JSON.stringify(body)})});
async function seed(workspace:string,product:string,goal:string){
 const c=await admin.connect();
 try{
  await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");
  await c.query(`INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($2,$1,'REAL','product',jsonb_build_object('name','Producto '||$1))`,[workspace,product]);
  await c.query(`INSERT INTO result_goals(id,workspace_id,from_day,to_day,currency,metric,target,created_by,updated_by) VALUES($2,$1,current_date,current_date+30,'MXN','SALES',10,'seed','seed')`,[workspace,goal]);
  await c.query(`INSERT INTO domain_events(workspace_id,environment,event_type,aggregate_id,correlation_id,actor,payload) VALUES($1,'REAL','profile.settings.changed',$1,'c','{"type":"human","id":"seed"}',jsonb_build_object('after',jsonb_build_object('role','owner')))`,[workspace]);
  await c.query(`INSERT INTO ai_profile_preferences(workspace_id,environment,version,monthly_limit_microusd,updated_by) VALUES($1,'REAL',1,5000000,'seed')`,[workspace]);
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
describe('V7 ISO: two profiles, three roles, real personal tokens',()=>{
 beforeAll(async()=>{
  vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:4});await requireMigratedProfileSchema(admin);
  const password=randomBytes(24).toString('hex');await admin.query(`CREATE ROLE "${apiLogin}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;GRANT commerce_api TO "${apiLogin}"`);
  const u=new URL(url);u.username=apiLogin;u.password=password;api=new pg.Pool({connectionString:u.toString(),max:6});
  // As the production runtime login does (assumeRuntimeRole): current_user is commerce_api.
  api.on('connect',client=>{void client.query('SET ROLE commerce_api');});
  for(const id of [A,B])await fixtureProfileRow(admin,created,id,{numbers:1});
  await actor('ownerA',A,'owner');await actor('operatorA',A,'operator');await actor('viewerA',A,'viewer');await actor('ownerB',B,'owner');
  await seed(A,ids.productA,ids.goalA);await seed(B,ids.productB,ids.goalB);
  await admin.query("INSERT INTO result_goal_operations(workspace_id,actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,repeat('b',64),'{\"status\":\"CREATED\"}')",[B,actors.ownerB!.user,ids.opB]);
  app=Fastify({logger:false});app.setErrorHandler((e:any,_r,reply)=>reply.code(e.statusCode??(e.name==='ZodError'?400:500)).send({error:{code:e.code??e.message}}));
  const request={origins:[origin],nativeSession:async()=>null,
   session:async()=>{throw Object.assign(Error('PROFILE_SESSION_EXPIRED'),{statusCode:401,code:'PROFILE_SESSION_EXPIRED'});},
   personal:(token:string,environment:any,action:any,work:any)=>withPersonalProfileTransaction(api,token,environment,action,async(db,profile)=>{await bindProfileEnvironment(db,environment);return work({db,profile,environment});})};
  await app.register(async scoped=>{await profileRuntimeRoutes(scoped,{request,platform:{origins:[origin],session:async()=>null,token:async()=>{throw Object.assign(Error('PLATFORM_TOKEN_INVALID'),{statusCode:401});}}});});
  await app.ready();
 },60000);
 afterAll(async()=>{await app?.close();await api?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${apiLogin}"`);}finally{await admin.end();}}vi.unstubAllEnvs();});

 it('lists only the token profile in every V2 read family',async()=>{
  const forbidden=[B,ids.productB,ids.goalB,actors.ownerB!.user];
  for(const url of ['/v2/profile','/v2/employees','/v2/invitations','/v2/tokens','/v2/integrations','/v2/onboarding','/v2/home','/v2/usage','/v2/audit','/v2/catalog/products','/v2/goals']){
   const r=await call('ownerA','GET',url);expect(r.statusCode,url).toBe(200);
   for(const value of forbidden)expect(r.body,url).not.toContain(value);
  }
  expect((await call('ownerA','GET','/v2/profile')).json().data.id).toBe(A);
  expect((await call('ownerA','GET','/v2/catalog/products')).body).toContain(ids.productA);
  expect((await call('ownerA','GET','/v2/audit')).json().data.entries.length).toBeGreaterThan(0);
 });
 it('never resolves an object of the other profile by its ID or operation UUID',async()=>{
  expect((await call('ownerA','GET','/v2/catalog/products/'+ids.productB)).statusCode).toBe(404);
  expect((await call('ownerA','GET','/v2/goals/'+ids.goalB)).statusCode).toBeGreaterThanOrEqual(400);
  expect((await call('ownerA','GET','/v2/operations/'+ids.opB)).json().data.state).toBe('NOT_FOUND');
  expect((await call('ownerA','PATCH','/v2/employees/'+actors.ownerB!.user,{expectedVersion:1,role:'viewer',active:true})).statusCode).toBe(404);
  expect((await call('ownerA','POST','/v2/integrations/ai/openai/state',{expectedRevision:1,enabled:false})).statusCode).toBe(409);
  expect((await admin.query('SELECT role FROM memberships WHERE user_id=$1',[actors.ownerB!.user])).rows[0].role).toBe('owner');
 });
 it('applies the role matrix to the same token family',async()=>{
  const ownerOnly:[string,string,unknown][]=[['PATCH','/v2/profile',{expectedVersion:1,businessName:'X',timezone:'UTC'}],['PUT','/v2/integrations/ai/preferences',{expectedVersion:1,monthlyLimitMicrousd:6000000}],['PATCH','/v2/onboarding',{expectedVersion:0,metaSkipped:true}],['GET','/v2/employees',undefined],['GET','/v2/tokens',undefined],['GET','/v2/audit/export',undefined]];
  for(const [method,url,body] of ownerOnly){
   for(const who of ['operatorA','viewerA']){const r=await call(who,method,url,body);expect(r.statusCode,`${who} ${method} ${url}`).toBe(403);}
  }
  expect((await call('operatorA','GET','/v2/integrations')).statusCode).toBe(200);
  expect((await call('viewerA','GET','/v2/integrations')).statusCode).toBe(403);
  for(const who of ['ownerA','operatorA','viewerA'])expect((await call(who,'GET','/v2/home')).statusCode,who).toBe(200);
 });
 it('cannot select another profile with a token and stops at revocation or downgrade',async()=>{
  expect((await call('ownerA','GET','/v2/home',undefined,{'x-commerce-profile-id':B,'x-commerce-profile-version':'1'})).statusCode).toBe(403);
  await admin.query("UPDATE memberships SET role='viewer' WHERE user_id=$1 AND workspace_id=$2",[actors.operatorA!.user,A]);
  try{expect((await call('operatorA','GET','/v2/integrations')).statusCode).toBe(403);expect((await call('operatorA','GET','/v2/home')).statusCode).toBe(200);}
  finally{await admin.query("UPDATE memberships SET role='operator' WHERE user_id=$1 AND workspace_id=$2",[actors.operatorA!.user,A]);}
  await admin.query('UPDATE personal_access_tokens SET revoked_at=clock_timestamp(),version=version+1 WHERE id=$1',[actors.viewerA!.tokenId]);
  expect((await call('viewerA','GET','/v2/home')).statusCode).toBe(401);
 });
 it('keeps the restricted API role inside one profile even with raw SQL',async()=>{
  const c=await api.connect();
  try{
   await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[A]);
   for(const table of ['records','memberships','ai_profile_preferences','domain_events','result_goals','personal_access_tokens'])
    expect((await c.query(`SELECT count(*)::int n FROM ${table} WHERE workspace_id=$1`,[B])).rows[0].n,table).toBe(0);
   await expect(c.query("INSERT INTO ai_profile_preferences(workspace_id,environment,version,updated_by) VALUES($1,'REAL',1,'x')",[B])).rejects.toThrow();
  }finally{await c.query('ROLLBACK');c.release();}
 });
});
