import Fastify from 'fastify';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {profileRuntimeRoutes,type ProfileRuntimeDependencies} from './profile-runtime.js';
import {createApp} from './app.js';
vi.mock('./auth.js',()=>({auth:{api:{getSession:vi.fn().mockResolvedValue(null)}},trustedOrigins:['https://commerce.example.test'],createAuth:vi.fn(),provisionUser:vi.fn()}));
const apps:ReturnType<typeof Fastify>[]=[];
const reject=()=>Promise.reject(Object.assign(Error('NATIVE_SCOPE_REJECTED'),{code:'NATIVE_SCOPE_REJECTED',statusCode:403}));
function dependencies():ProfileRuntimeDependencies{return{request:{origins:['https://commerce.example.test'],nativeSession:vi.fn().mockResolvedValue({id:'native-session',userId:'native-user'}),session:vi.fn(reject),personal:vi.fn(reject)},identity:{origins:['https://commerce.example.test'],session:vi.fn().mockResolvedValue(null),list:vi.fn(reject),select:vi.fn(reject)}};}
async function app(deps=dependencies()){
 const api=Fastify();apps.push(api);api.setErrorHandler((e:any,_req,reply)=>reply.code(e.statusCode??400).send({error:{code:e.code??'VALIDATION_ERROR'}}));
 api.get('/outside',async()=>({ok:true}));await api.register(profileRuntimeRoutes,deps);await api.ready();return{api,deps};
}
afterEach(async()=>{await Promise.all(apps.splice(0).map(a=>a.close()));});
const readFamilies=[['/v2/profile','profile:read'],['/v2/employees','employees:read'],['/v2/invitations','employees:read'],['/v2/tokens','tokens:read'],['/v2/products','products:read'],['/v2/market/releases/10000000-0000-4000-8000-000000000001?environment=REAL','variants:read'],['/v2/continuity/commercial','assignments:read'],['/v2/payments?from=2026-01-01&to=2026-01-02&currency=MXN','payments:read'],['/v2/payments/policies/profile?environment=REAL','receipt-rules:read'],['/v2/results?from=2026-01-01&to=2026-01-02&currency=MXN','results:read'],['/v2/goals','goals:read']] as const;
describe('fixed V2 profile runtime composition',()=>{
 it('registers all read families and keeps exact native scopes before any database work',async()=>{
  const {api,deps}=await app();for(const[url,scope]of readFamilies){vi.mocked(deps.request!.session).mockClear();const result=await api.inject({url,headers:{'x-commerce-profile-id':'profile-a','x-commerce-profile-version':'2'}});expect(result.statusCode,url).toBe(403);expect(result.json().error.code,url).toBe('NATIVE_SCOPE_REJECTED');expect(deps.request!.session).toHaveBeenCalledWith({id:'native-session',userId:'native-user'},{workspaceId:'profile-a',version:2},'REAL',{scope,mutation:false},expect.any(Function));}
 });
 // V7 F2: authentication precedes the fence (implicit single-profile selection
 // needs the native session); a missing fence still stops before profile SQL.
 it('fails reads with no selection before any profile transaction or legacy identity',async()=>{
  const{api,deps}=await app();for(const[url]of readFamilies){const result=await api.inject(url);expect(result.statusCode,url).toBe(409);expect(result.json().error.code).toBe('PROFILE_REQUEST_FENCE_REQUIRED');}expect(deps.request!.session).not.toHaveBeenCalled();
 });
 it('encapsulates privacy hooks while preserving the bootstrap cookie-only response',async()=>{
  const{api}=await app();const outside=await api.inject('/outside');expect(outside.headers['cache-control']).toBeUndefined();const bootstrap=await api.inject('/v2/me/profiles');expect(bootstrap.statusCode).toBe(401);expect(bootstrap.headers['cache-control']).toBe('no-store');expect(bootstrap.headers.vary).toBe('Cookie');expect(bootstrap.headers['x-content-type-options']).toBe('nosniff');
 });
 it('registers writes and invitation entrypoints without allowing an unvalidated body to reach SQL',async()=>{
  const{api,deps}=await app();for(const[method,url]of [['PATCH','/v2/profile'],['PATCH','/v2/employees/synthetic-user'],['POST','/v2/invitations'],['POST','/v2/tokens/operations'],['POST','/v2/invitation-registration'],['POST','/v2/invitation-acceptance'],['POST','/v2/invitation-acceptance/status']] as const){const result=await api.inject({method,url,payload:{}});expect([400,403],url).toContain(result.statusCode);}expect(deps.request!.session).not.toHaveBeenCalled();
 });
 it('does not permit a personal token to smuggle a profile selection',async()=>{
  const{api,deps}=await app();const result=await api.inject({url:'/v2/profile',headers:{authorization:'Bearer cos_pat_'+'a'.repeat(43),'x-commerce-profile-id':'other','x-commerce-profile-version':'1'}});expect(result.statusCode).toBe(403);expect(result.json().error.code).toBe('PROFILE_TOKEN_CANNOT_SELECT');expect(deps.request!.personal).not.toHaveBeenCalled();
 });
 it('is actually mounted by createApp and advertises the two profile CAS headers through CORS',async()=>{
  const api=await createApp();apps.push(api);const read=await api.inject('/v2/profile');expect(read.statusCode).toBe(401);expect(read.json().error.code).toBe('PROFILE_SESSION_EXPIRED');const boot=await api.inject('/v2/me/profiles');expect(boot.statusCode).toBe(401);expect(boot.json().error.code).toBe('PROFILE_SESSION_EXPIRED');
  const preflight=await api.inject({method:'OPTIONS',url:'/v2/profile',headers:{origin:'https://commerce.example.test','access-control-request-method':'GET','access-control-request-headers':'x-commerce-profile-id,x-commerce-profile-version'}});expect(preflight.statusCode).toBe(204);expect(String(preflight.headers['access-control-allow-headers']).toLowerCase()).toContain('x-commerce-profile-id');expect(String(preflight.headers['access-control-allow-headers']).toLowerCase()).toContain('x-commerce-profile-version');
 });
});
