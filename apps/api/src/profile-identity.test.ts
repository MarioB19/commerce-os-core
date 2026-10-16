import Fastify from 'fastify';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {profileIdentityRoutes,type ProfileIdentityDependencies} from './profile-identity.js';
import {ProfileSessionError} from '../../../packages/db/src/profile-session.js';
vi.mock('./auth.js',()=>({auth:{api:{getSession:vi.fn()}},trustedOrigins:['https://commerce.example.test']}));
const created:ReturnType<typeof Fastify>[]=[];
const current={id:'private-session',userId:'private-user'};
let deps:ProfileIdentityDependencies;
const row=(id='own-a',extra:Record<string,unknown>={})=>({id,business_name:'Mi negocio',state:'ACTIVE',timezone:'America/Mexico_City',role:'owner',membership_version:1,selected:false,selection_version:null,...extra} as unknown as Awaited<ReturnType<ProfileIdentityDependencies['list']>>[number]);
async function app(){const value=Fastify();created.push(value);value.setErrorHandler((error:any,_req,reply)=>reply.code(error.statusCode??500).send({error:{code:error.code??'INTERNAL_ERROR'}}));await profileIdentityRoutes(value,deps);return value;}
beforeEach(()=>{deps={origins:['https://commerce.example.test'],session:vi.fn().mockResolvedValue(current),list:vi.fn().mockResolvedValue([row()]),select:vi.fn().mockResolvedValue({workspaceId:'own-a',version:1})};});
afterEach(async()=>{await Promise.all(created.splice(0).map(value=>value.close()));});
describe('interactive profile identity HTTP contract',()=>{
 it('lists only server-resolved identity metadata and no native session fields',async()=>{
  const api=await app(),response=await api.inject({method:'GET',url:'/v2/me/profiles',headers:{cookie:'opaque-cookie'}});
  expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('no-store');expect(response.headers.vary).toBe('Cookie');
  expect(deps.list).toHaveBeenCalledExactlyOnceWith(current);expect(response.json()).toEqual({data:{profiles:[{id:'own-a',businessName:'Mi negocio',state:'ACTIVE',timezone:'America/Mexico_City',role:'owner',membershipVersion:1,selected:false}],selection:{workspaceId:null,version:0}}});
  expect(response.body).not.toContain('private-session');expect(response.body).not.toContain('private-user');
 });
 it('rejects any bearer including a token accompanying a valid browser cookie',async()=>{
  const api=await app();for(const authorization of ['Bearer cos_pat_synthetic','Bearer service-synthetic','Basic synthetic','']){
   const response=await api.inject({method:'GET',url:'/v2/me/profiles',headers:{authorization,cookie:'valid-synthetic'}});expect(response.statusCode).toBe(403);
  }expect(deps.session).not.toHaveBeenCalled();expect(deps.list).not.toHaveBeenCalled();
 });
 it('does not accept user/workspace IDs from query parameters',async()=>{
  const api=await app(),response=await api.inject({method:'GET',url:'/v2/me/profiles?userId=other&workspace_id=other'});
  expect(response.statusCode).toBe(400);expect(deps.session).not.toHaveBeenCalled();
 });
 it('requires a live server session before listing or changing selection',async()=>{
  vi.mocked(deps.session).mockResolvedValue(null);const api=await app();
  for(const method of ['GET','POST']as const){const response=await api.inject({method,url:method==='GET'?'/v2/me/profiles':'/v2/me/profile-selection',headers:{origin:'https://commerce.example.test'},...(method==='POST'?{payload:{workspaceId:'own-a',expectedVersion:0}}:{})});expect(response.statusCode).toBe(401);}
  expect(deps.list).not.toHaveBeenCalled();expect(deps.select).not.toHaveBeenCalled();
 });
 it('requires exact trusted Origin for selection before resolving a session',async()=>{
  const api=await app();for(const origin of [undefined,'https://evil.example.test','null']){
   const response=await api.inject({method:'POST',url:'/v2/me/profile-selection',headers:origin?{origin}:{},payload:{workspaceId:'own-a',expectedVersion:0}});expect(response.statusCode).toBe(403);
  }expect(deps.session).not.toHaveBeenCalled();expect(deps.select).not.toHaveBeenCalled();
 });
 it('allows only the closed CAS request and returns its confirmed selection',async()=>{
  const api=await app();for(const payload of [{workspaceId:'own-a',expectedVersion:0,userId:'other'},{workspaceId:'own-a',expectedVersion:0,environment:'REAL'},{workspaceId:'own-a',expectedVersion:-1},{workspaceId:'own-a',expectedVersion:1.5},{workspaceId:'own-a'}]){
   expect((await api.inject({method:'POST',url:'/v2/me/profile-selection',headers:{origin:'https://commerce.example.test'},payload})).statusCode).toBe(400);
  }expect(deps.select).not.toHaveBeenCalled();
  const response=await api.inject({method:'POST',url:'/v2/me/profile-selection',headers:{origin:'https://commerce.example.test'},payload:{workspaceId:'own-a',expectedVersion:0}});expect(response.statusCode).toBe(200);expect(response.json()).toEqual({data:{workspaceId:'own-a',version:1}});expect(deps.select).toHaveBeenCalledWith(current,'own-a',0,expect.any(String));
 });
 it('returns stale CAS and current authorization failures without retrying',async()=>{
  const api=await app();for(const [code,status]of [['PROFILE_SELECTION_CHANGED',409],['PROFILE_MEMBERSHIP_REQUIRED',403],['PROFILE_SESSION_EXPIRED',401]]as const){
   vi.mocked(deps.select).mockRejectedValueOnce(new ProfileSessionError(code,status));const response=await api.inject({method:'POST',url:'/v2/me/profile-selection',headers:{origin:'https://commerce.example.test'},payload:{workspaceId:'own-a',expectedVersion:4}});expect(response.statusCode).toBe(status);expect(response.json().error.code).toBe(code);
  }expect(deps.select).toHaveBeenCalledTimes(3);
 });
 it('keeps current CAS version when revoked/degraded selection needs confirmation',async()=>{
  vi.mocked(deps.list).mockResolvedValue([row('own-b',{selected:false,selection_version:9,membership_version:2,role:'viewer'})]);const response=await(await app()).inject('/v2/me/profiles');expect(response.statusCode).toBe(200);expect(response.json().data.selection).toEqual({workspaceId:null,version:9});
 });
 it('does not invent a profile for an account with no active memberships',async()=>{
  vi.mocked(deps.list).mockResolvedValue([]);const response=await(await app()).inject('/v2/me/profiles');expect(response.json()).toEqual({data:{profiles:[],selection:{workspaceId:null,version:0}}});
 });
 it('rejects unadopted roles, inconsistent versions or multiple selected rows',async()=>{
  const api=await app();for(const rows of [[row('a',{role:'seller'})],[row('a',{selection_version:1}),row('b',{selection_version:2})],[row('a',{selected:true}),row('b',{selected:true})]]){
   vi.mocked(deps.list).mockResolvedValueOnce(rows);const response=await api.inject('/v2/me/profiles');expect(response.statusCode).toBe(503);expect(response.json().data).toBeUndefined();
  }
 });
});

describe('browser identity bootstrap',()=>{
 it('returns user display fields and native selection together without session data',async()=>{
  const identity={id:current.userId,name:'Cuenta sintética',email:'account@example.test'};
  vi.mocked(deps.session).mockResolvedValue({...current,user:identity});
  vi.mocked(deps.list).mockResolvedValue([row('own-a',{selected:true,selection_version:7})]);
  const response=await(await app()).inject('/v2/me');expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({data:{user:identity,profile:{profiles:[{id:'own-a',businessName:'Mi negocio',state:'ACTIVE',timezone:'America/Mexico_City',role:'owner',membershipVersion:1,selected:true}],selection:{workspaceId:'own-a',version:7}}}});
  expect(response.body).not.toContain('private-session');expect(response.body).not.toContain('token');expect(response.headers['cache-control']).toBe('no-store');
  expect(deps.list).toHaveBeenCalledWith({...current,user:identity});
 });
 it('rejects a display identity not bound to the authenticated native session',async()=>{
  vi.mocked(deps.session).mockResolvedValue({...current,user:{id:'other',name:'Otro',email:'other@example.test'}});
  expect((await(await app()).inject('/v2/me')).statusCode).toBe(503);expect(deps.list).not.toHaveBeenCalled();
 });
 it('never accepts bearer or caller IDs on browser bootstrap',async()=>{
  const a=await app();for(const request of [{url:'/v2/me',headers:{authorization:'Bearer synthetic'}},{url:'/v2/me?workspaceId=other'}])expect((await a.inject(request)).statusCode).toBeGreaterThanOrEqual(400);
  expect(deps.session).not.toHaveBeenCalled();
 });
 it('preserves no selection and suspended profile without inventing authority',async()=>{
  vi.mocked(deps.session).mockResolvedValue({...current,user:{id:current.userId,name:'Cuenta',email:'account@example.test'}});
  vi.mocked(deps.list).mockResolvedValue([row('own-a',{state:'SUSPENDED',role:'viewer'})]);
  const response=await(await app()).inject('/v2/me');expect(response.statusCode).toBe(200);expect(response.json().data.profile.selection.workspaceId).toBeNull();expect(response.json().data.profile.profiles[0].state).toBe('SUSPENDED');
 });
});
