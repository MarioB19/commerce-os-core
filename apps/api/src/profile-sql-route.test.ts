import Fastify from 'fastify';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {registerProfileSqlRoute,isProfileSqlRequest} from './profile-sql-route.js';
import {principal} from './context.js';
import {createApp} from './app.js';
import {pool} from '../../../packages/db/src/index.js';
import {withProfileTransaction,type ProfileQuery} from '../../../packages/db/src/profile-context.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../../packages/domain/src/core/profile-authorization.js';
import type {ProfileRequestDependencies,ProfileRequestContext} from './profile-request.js';
import * as profileRequest from './profile-request.js';
vi.mock('./auth.js',()=>({auth:{api:{getSession:vi.fn().mockResolvedValue(null)}},trustedOrigins:['https://example.test'],createAuth:vi.fn(),provisionUser:vi.fn()}));
const apps:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(a=>a.close()));vi.restoreAllMocks();});
const headers={'x-commerce-profile-id':'selected','x-commerce-profile-version':'7'};
function fixture(){
 const calls:string[]=[],legacy=vi.fn(),connection={query:vi.fn(async(sql:string)=>{calls.push(sql);return{rows:[],rowCount:0,command:sql==='COMMIT'?'COMMIT':'SELECT',fields:[],oid:0};})as ProfileQuery,release:vi.fn()};
 const authority:ProfileAuthority={profile:{id:'selected',state:'ACTIVE'},membership:{workspaceId:'selected',userId:'native-user',role:'viewer',active:true,version:2},credential:{kind:'session',workspaceId:'selected',userId:'native-user',expiresAt:'2099-01-01T00:00:00Z',membershipVersion:2,revoked:false,scopes:[]}};
 let revoked=false,failCommit=false;
 const execute:ProfileRequestDependencies['session']=async(_session,fence,environment,action,work)=>{
  if(fence.workspaceId!=='selected'||fence.version!==7)throw Object.assign(Error('STALE'),{statusCode:409});
  return withProfileTransaction({connect:async()=>connection},'selected',async db=>{
   authorizeProfileAction(authority,{...action,workspaceId:'selected'});
   const base={profile:{id:'selected',businessName:'Synthetic',state:'ACTIVE' as const,timezone:'UTC',version:1},membership:{role:authority.membership.role,version:2},authority};
   const profile=authority.credential.kind==='session'?{...base,selection:{workspaceId:'selected',version:7}}:{...base,tokenId:'10000000-0000-4000-8000-000000000001',environment};
   const result=await work({db,profile,environment} as ProfileRequestContext);
   if(revoked)authority.credential.revoked=true;
   authorizeProfileAction(authority,{...action,workspaceId:'selected'});
   if(failCommit)throw Error('SYNTHETIC_FINAL_FAILURE');
   return result;
  });
 };
 const request:ProfileRequestDependencies={origins:['https://example.test'],nativeSession:vi.fn(async()=>({id:'native-session',userId:'native-user'})),session:vi.fn(execute) as ProfileRequestDependencies['session'],personal:vi.fn(async(_token,environment,action,work)=>{authority.credential={...authority.credential,kind:'personal_token',scopes:['products:read']};return execute({id:'unused',userId:'native-user'},{workspaceId:'selected',version:7},environment,action,work);}) as ProfileRequestDependencies['personal']};
 const app=Fastify();apps.push(app);app.setErrorHandler((e:any,_req,reply)=>reply.code(e.statusCode??500).send({code:e.code??e.message}));
 app.addHook('onRequest',async req=>{if(!isProfileSqlRequest(req))legacy();});
 const action={scope:'products:read' as const,mutation:false};
 registerProfileSqlRoute(app,{method:'GET',url:'/v1/reviewed/:id',action,permissions:['catalog:read'],handler:async req=>{await pool.query('SELECT synthetic_scoped');const p=principal(req);return{workspace:p.workspace_id,role:p.role,credential:p.authentication_method,permissions:p.permissions};}},request);
 return{app,calls,legacy,request,authority,action,connection,revoke:()=>{revoked=true;},fail:()=>{failCommit=true;}};
}
describe('server-owned SQL route registration',()=>{
 it('replaces old authentication only for its exact handler and commits native selection before response',async()=>{const f=fixture(),r=await f.app.inject({url:'/v1/reviewed/id',headers});expect(r.statusCode).toBe(200);expect(r.json()).toEqual({workspace:'selected',role:'viewer',credential:'session',permissions:['products:read','catalog:read']});expect(f.legacy).not.toHaveBeenCalled();expect(f.calls).toContain('SELECT synthetic_scoped');expect(f.calls.filter(x=>x==='COMMIT')).toHaveLength(1);});
 it('preserves a PAT actual viewer role and exact scope without native-session fallback',async()=>{const f=fixture(),r=await f.app.inject({url:'/v1/reviewed/id',headers:{authorization:'Bearer cos_pat_'+'p'.repeat(43)}});expect(r.statusCode).toBe(200);expect(r.json().role).toBe('viewer');expect(r.json().credential).toBe('personal_access_token');expect(f.request.nativeSession).not.toHaveBeenCalled();expect(f.request.personal).toHaveBeenCalledOnce();});
 it('rejects missing or stale selector before handler SQL',async()=>{const f=fixture();expect((await f.app.inject('/v1/reviewed/id')).statusCode).toBe(409);expect((await f.app.inject({url:'/v1/reviewed/id',headers:{...headers,'x-commerce-profile-version':'8'}})).statusCode).toBe(409);expect(f.calls).toEqual([]);expect(f.legacy).not.toHaveBeenCalled();});
 it('cannot mark another app or an unregistered route with HTTP headers or payload fields',async()=>{const f=fixture();f.app.post('/v1/unreviewed',async()=>({legacy:true}));const r=await f.app.inject({method:'POST',url:'/v1/unreviewed',headers:{'registered-profile-sql-route':'true',...headers},payload:{config:{profile:true},scope:'products:read'}});expect(r.statusCode).toBe(200);expect(f.legacy).toHaveBeenCalledOnce();const other=Fastify();apps.push(other);other.get('/v1/reviewed/:id',async req=>({registered:isProfileSqlRequest(req)}));expect((await other.inject('/v1/reviewed/id')).json()).toEqual({registered:false});});
 it('uses the same authority for Fastify HEAD and refuses mismatched token selection',async()=>{const f=fixture();expect((await f.app.inject({method:'HEAD',url:'/v1/reviewed/id',headers})).statusCode).toBe(200);expect(f.legacy).not.toHaveBeenCalled();const prior=f.calls.length;expect((await f.app.inject({url:'/v1/reviewed/id',headers:{...headers,authorization:'Bearer cos_pat_'+'p'.repeat(43)}})).statusCode).toBe(403);expect(f.calls).toHaveLength(prior);});
 it.each(['revocation','failure'])('discards handler result on final %s',async mode=>{const f=fixture();if(mode==='revocation')f.revoke();else f.fail();const r=await f.app.inject({url:'/v1/reviewed/id',headers});expect(r.statusCode).toBeGreaterThanOrEqual(400);expect(r.body).not.toContain('native-user');expect(r.body).not.toContain('"workspace"');expect(f.calls).toContain('ROLLBACK');expect(f.calls).not.toContain('COMMIT');});
 it('freezes its action at registration and rejects URL wildcards',async()=>{const f=fixture();f.action.scope='offers:read' as typeof f.action.scope;expect((await f.app.inject({url:'/v1/reviewed/id',headers})).json().permissions).toEqual(['products:read','catalog:read']);expect(()=>registerProfileSqlRoute(f.app,{method:'GET',url:'/v1/*',action:f.action,permissions:[],handler:async()=>({})})).toThrow('PROFILE_SQL_ROUTE_INVALID');});
 it('mounts all twelve reviewed V1 reads in createApp with fixed actions and no legacy auth',async()=>{const spy=vi.spyOn(profileRequest,'withProfileRequest'),app=await createApp();apps.push(app);for(const[path,scope]of[['categories','products:read'],['products','products:read'],['offers','offers:read'],['assets','materials:read'],['workflows','flows:read'],['agents','sellers:read']]as const){for(const tail of['','/10000000-0000-4000-8000-000000000001']){spy.mockClear();const r=await app.inject('/v1/'+path+tail);expect(r.statusCode,path+tail).toBe(409);expect(r.json().error.code).toBe('PROFILE_REQUEST_FENCE_REQUIRED');expect(spy).toHaveBeenCalledWith(expect.anything(),'REAL',{scope,mutation:false},expect.any(Function),undefined);}}});
});

describe('catalog SQL writer registration',()=>{
 it('mounts fixed resource actions for metadata, versions and validations',async()=>{
  const app=await createApp();apps.push(app);const spy=vi.spyOn(profileRequest,'withProfileRequest');
  const id='10000000-0000-4000-8000-000000000001';
  const routes:Array<['GET'|'POST'|'PATCH',string,string,boolean]>=[];
  for(const[path,scope]of[['categories','products'],['products','products'],['assets','materials'],['workflows','flows'],['agents','sellers']])for(const method of['POST','PATCH'] as const)routes.push([method,'/v1/'+path+(method==='PATCH'?'/'+id:''),scope+':write',true]);
  routes.push(['POST',`/v1/products/${id}/offers`,'offers:write',true],['POST',`/v1/offers/${id}/publish`,'offers:write',true],['GET',`/v1/products/${id}/versions`,'products:read',false],['POST',`/v1/products/${id}/duplicate`,'products:write',true],['POST','/v1/assets/upload-intents','materials:write',true],['POST','/v1/workflows/validate','flows:write',true],['POST','/v1/workflows/apply','flows:write',true]);
  for(const action of['versions','transition'])routes.push(['POST',`/v1/products/${id}/${action}`,'products:write',true]);
  for(const[path,scope]of[['offers','offers'],['workflows','flows']])for(const method of['GET','POST']as const)routes.push([method,`/v1/${path}/${id}/versions`,scope+(method==='GET'?':read':':write'),method!=='GET']);
  routes.push(['POST',`/v1/workflows/${id}/validate`,'flows:read',false]);
  for(const action of['publish','duplicate','rollback'])routes.push(['POST',`/v1/workflows/${id}/${action}`,'flows:write',true]);
  routes.push(['GET',`/v1/offers/${id}/sales-flow`,'offers:read',false],['POST',`/v1/offers/${id}/sales-flow/validate`,'offers:read',false],['PATCH',`/v1/offers/${id}/sales-flow`,'offers:write',true]);
  expect(routes).toHaveLength(30);
  for(const[method,url,scope,mutation]of routes){spy.mockClear();const r=await app.inject({method,url,headers:{origin:'https://example.test'},...(method==='GET'?{}:{payload:{environment:'REAL'}})});expect(r.statusCode,method+' '+url+' '+r.body).toBe(409);expect(r.json().error.code).toBe('PROFILE_REQUEST_FENCE_REQUIRED');expect(spy).toHaveBeenCalledWith(expect.anything(),'REAL',{scope,mutation},expect.any(Function),undefined);}
 });
});


describe('sales SQL route registration',()=>{
 it('binds all reviewed reads, decisions and operation reconciliation to fixed native profile actions',async()=>{
  const app=await createApp();apps.push(app);const spy=vi.spyOn(profileRequest,'withProfileRequest'),id='10000000-0000-4000-8000-000000000001';
  const routes:Array<['GET'|'POST',string,string,boolean]>=[];
  for(const[path,scope]of[['conversations','conversations'],['contacts','conversations'],['leads','conversations'],['touchpoints','conversations'],['orders','orders'],['fulfillments','orders'],['receipts','receipts']])for(const suffix of['','/'+id])routes.push(['GET','/v1/'+path+suffix,scope+':read',false]);
  for(const path of['commands','controls'])routes.push(['POST',`/v1/conversations/${id}/${path}`,'conversations:write',true]);
  routes.push(['POST',`/v1/receipts/${id}/review`,'receipts:review',true]);
  for(const path of['orders','receipts'])routes.push(['POST',`/v1/${path}/${id}/classification`,'payments:write',true]);
  routes.push(['POST',`/v1/orders/${id}/attribution`,'payments:write',true]);
  for(const path of['edit','cancel'])routes.push(['POST',`/v1/outbox/${id}/${path}`,'conversations:write',true]);
  for(const path of['commands','outbox'])for(const suffix of['','/'+id])routes.push(['GET','/v1/'+path+suffix,'operations:read',false]);
  for(const path of['events','timers',`sales-operations/${id}`])routes.push(['GET','/v1/'+path,'operations:read',false]);
  expect(routes).toHaveLength(29);
  for(const[method,url,scope,mutation]of routes){spy.mockClear();const r=await app.inject({method,url,headers:{origin:'https://example.test'},...(method==='GET'?{}:{payload:{environment:'REAL'}})});expect(r.statusCode,method+' '+url+' '+r.body).toBe(409);expect(r.json().error.code).toBe('PROFILE_REQUEST_FENCE_REQUIRED');expect(spy).toHaveBeenCalledWith(expect.anything(),'REAL',{scope,mutation},expect.any(Function),undefined);}
 });
});
