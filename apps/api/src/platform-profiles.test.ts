import Fastify from 'fastify';
import {afterEach,describe,expect,it,vi} from 'vitest';

const db=vi.hoisted(()=>({
 listPlatformProfiles:vi.fn(),readPlatformCapacity:vi.fn(),createPlatformProfile:vi.fn(),updatePlatformProfile:vi.fn(),invitePlatformOwner:vi.fn(),isPlatformAdmin:vi.fn(),
 listPlatformTokens:vi.fn(),issuePlatformToken:vi.fn(),revokePlatformToken:vi.fn(),resolvePlatformToken:vi.fn(),
}));
vi.mock('./auth.js',()=>({auth:{api:{getSession:vi.fn().mockResolvedValue(null)}},trustedOrigins:['https://commerce.example.test'],createAuth:vi.fn(),provisionUser:vi.fn()}));
vi.mock('../../../packages/db/src/index.js',()=>({pool:{query:vi.fn()},withTransaction:vi.fn(async(work:(c:unknown)=>unknown)=>work({query:vi.fn()}))}));
vi.mock('../../../packages/db/src/identity.js',()=>({identityAudit:vi.fn()}));
vi.mock('../../../packages/db/src/platform-profiles.js',async()=>{
 const actual=await vi.importActual<typeof import('../../../packages/db/src/platform-profiles.js')>('../../../packages/db/src/platform-profiles.js');
 return{...db,PlatformError:actual.PlatformError,isPlatformToken:actual.isPlatformToken};
});
const {platformProfileRoutes}=await import('./platform-profiles.js');
const {PlatformError}=await import('../../../packages/db/src/platform-profiles.js');
const apps:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>{await Promise.all(apps.splice(0).map(a=>a.close()));vi.clearAllMocks();});
const origin='https://commerce.example.test',current={id:'session-1',userId:'admin-1'};
const platformToken='cos_plt_'+'b'.repeat(43);
async function app(session:typeof current|null=current,token=vi.fn()){
 const api=Fastify();apps.push(api);await api.register(async p=>{await platformProfileRoutes(p,{origins:[origin],session:vi.fn().mockResolvedValue(session),token});});await api.ready();return api;
}
describe('platform profile routes',()=>{
 it('requires an interactive session and never accepts a token or a profile fence',async()=>{
  const anonymous=await app(null);expect((await anonymous.inject('/v2/platform/profiles')).statusCode).toBe(401);
  const api=await app();
  expect((await api.inject({url:'/v2/platform/profiles',headers:{authorization:'Bearer cos_pat_x'}})).json().error.code).toBe('PLATFORM_INTERACTIVE_SESSION_REQUIRED');
  expect((await api.inject({url:'/v2/platform/profiles',headers:{'x-commerce-profile-id':'p','x-commerce-profile-version':'1'}})).json().error.code).toBe('PLATFORM_OUTSIDE_PROFILE_REQUIRED');
  expect(db.listPlatformProfiles).not.toHaveBeenCalled();
 });
 it('lists aggregate profiles with capacity under no-store headers',async()=>{
  db.listPlatformProfiles.mockResolvedValue([{id:'p1'}]);db.readPlatformCapacity.mockResolvedValue({profiles:{used:1,max:3}});
  const r=await (await app()).inject('/v2/platform/profiles');expect(r.statusCode).toBe(200);expect(r.headers['cache-control']).toBe('no-store');
  expect(r.json()).toEqual({data:{profiles:[{id:'p1'}],capacity:{profiles:{used:1,max:3}}}});expect(db.listPlatformProfiles).toHaveBeenCalledWith(expect.anything(),current);
 });
 it('maps a non-admin to 403 without reaching other ports',async()=>{
  db.listPlatformProfiles.mockRejectedValue(new PlatformError('PLATFORM_ADMIN_REQUIRED',403));
  const r=await (await app()).inject('/v2/platform/profiles');expect(r.statusCode).toBe(403);expect(r.json().error.code).toBe('PLATFORM_ADMIN_REQUIRED');expect(db.readPlatformCapacity).not.toHaveBeenCalled();
 });
 it('rejects cross-origin mutations before any port',async()=>{
  const api=await app();
  for(const [method,url] of [['POST','/v2/platform/profiles'],['PATCH','/v2/platform/profiles/p1'],['POST','/v2/platform/profiles/p1/owner-invitations']] as const){
   const r=await api.inject({method,url,headers:{origin:'https://evil.example.test'},payload:{}});expect(r.statusCode).toBe(403);expect(r.json().error.code).toBe('ORIGIN_REJECTED');
  }
  expect(db.createPlatformProfile).not.toHaveBeenCalled();expect(db.updatePlatformProfile).not.toHaveBeenCalled();expect(db.invitePlatformOwner).not.toHaveBeenCalled();
 });
 it('creates, updates and invites through the closed ports with replay status codes',async()=>{
  const api=await app();
  db.createPlatformProfile.mockResolvedValueOnce({status:'CREATED',profileId:'p2',version:1,replayed:false}).mockResolvedValueOnce({status:'CREATED',profileId:'p2',version:1,replayed:true});
  expect((await api.inject({method:'POST',url:'/v2/platform/profiles',headers:{origin},payload:{a:1}})).statusCode).toBe(201);
  expect((await api.inject({method:'POST',url:'/v2/platform/profiles',headers:{origin},payload:{a:1}})).statusCode).toBe(200);
  db.updatePlatformProfile.mockResolvedValue({status:'UPDATED',profileId:'p2',version:2,replayed:false});
  expect((await api.inject({method:'PATCH',url:'/v2/platform/profiles/p2',headers:{origin},payload:{b:1}})).json().data.version).toBe(2);expect(db.updatePlatformProfile).toHaveBeenCalledWith(expect.anything(),current,'p2',{b:1});
  db.invitePlatformOwner.mockResolvedValue({status:'QUEUED',profileId:'p2',invitationId:'i',replayed:false});
  expect((await api.inject({method:'POST',url:'/v2/platform/profiles/p2/owner-invitations',headers:{origin},payload:{c:1}})).statusCode).toBe(202);
 });
 it('accepts a platform token only within its scopes and never for issuing tokens',async()=>{
  const token=vi.fn().mockResolvedValue({id:'platform-token:'+'c'.repeat(64),userId:'admin-1',scopes:['platform:capacity']}),api=await app(null,token);
  const auth={authorization:'Bearer '+platformToken};
  db.readPlatformCapacity.mockResolvedValue({profiles:{used:1,max:3}});
  expect((await api.inject({url:'/v2/platform/capacity',headers:auth})).json()).toEqual({data:{profiles:{used:1,max:3}}});
  expect(token).toHaveBeenCalledWith(platformToken);
  const denied=await api.inject({url:'/v2/platform/profiles',headers:auth});expect(denied.statusCode).toBe(403);expect(denied.json().error.code).toBe('PLATFORM_SCOPE_REQUIRED');
  const issue=await api.inject({method:'POST',url:'/v2/platform/tokens',headers:auth,payload:{name:'x',scopes:['platform:audit'],expiresAt:new Date(Date.now()+86400000).toISOString()}});
  expect(issue.statusCode).toBe(403);expect(issue.json().error.code).toBe('PLATFORM_INTERACTIVE_SESSION_REQUIRED');expect(db.issuePlatformToken).not.toHaveBeenCalled();
  expect((await api.inject({url:'/v2/platform/capacity',headers:{authorization:'Bearer cos_pat_'+'a'.repeat(43)}})).json().error.code).toBe('PLATFORM_INTERACTIVE_SESSION_REQUIRED');
 });
 it('issues tokens from an interactive session with an allowed origin',async()=>{
  db.issuePlatformToken.mockResolvedValue({token:platformToken,id:'t'});
  const api=await app();
  expect((await api.inject({method:'POST',url:'/v2/platform/tokens',headers:{origin:'https://evil.example.test'},payload:{}})).statusCode).toBe(403);
  const r=await api.inject({method:'POST',url:'/v2/platform/tokens',headers:{origin},payload:{name:'MCP'}});expect(r.statusCode).toBe(201);expect(db.issuePlatformToken).toHaveBeenCalledWith(expect.anything(),current,{name:'MCP'});
 });
 it('reports admin access for navigation only',async()=>{
  db.isPlatformAdmin.mockResolvedValue(false);expect((await (await app()).inject('/v2/platform/access')).json()).toEqual({data:{admin:false}});
 });
});
