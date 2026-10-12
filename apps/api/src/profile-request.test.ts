import {describe,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import type {FastifyRequest} from 'fastify';
import {profileReadEnvironment,withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';
import {profileOverviewRoutes} from './profile-overview.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../../packages/domain/src/core/profile-authorization.js';
import type {ProfileQuery} from '../../../packages/db/src/profile-context.js';
import type {SessionProfile} from '../../../packages/db/src/profile-session.js';

function fixture(){
 const authority:ProfileAuthority={profile:{id:'one',state:'ACTIVE'},membership:{userId:'user',workspaceId:'one',role:'owner',active:true,version:1},credential:{kind:'session',userId:'user',workspaceId:'one',revoked:false,expiresAt:'2099-01-01T00:00:00Z',membershipVersion:1,scopes:[]}};
 const profile:SessionProfile={profile:{id:'one',businessName:'Synthetic',state:'ACTIVE',timezone:'UTC',version:1},membership:{role:'owner',version:1},selection:{workspaceId:'one',version:3},authority};
 const query=vi.fn(async(sql:string)=>({rows:sql.includes('FROM profiles')?[{id:'one',business_name:'Synthetic',state:'ACTIVE',timezone:'UTC',number_limit:2,product_limit:10,daily_conversation_limit:300,version:1}]:[{user_id:'user',name:'Owner',email:'synthetic@example.test',role:'owner',active:true,version:1}],rowCount:1,command:'SELECT',fields:[],oid:0}));
 const nativeSession=vi.fn(async()=>({id:'native-session',userId:'user'}));let expiredAtCommit=false;
 const deps:ProfileRequestDependencies={origins:['https://example.test'],nativeSession,
  async session(native,fence,environment,action,work){
   if(native.id!=='native-session'||native.userId!=='user'||fence.workspaceId!=='one'||fence.version!==3)throw Object.assign(new Error('PROFILE_SELECTION_CHANGED'),{code:'PROFILE_SELECTION_CHANGED',statusCode:409});
   authorizeProfileAction(authority,{...action,workspaceId:'one'});
   const result=await work({db:{workspaceId:'one',query:query as ProfileQuery},profile,environment});
   if(expiredAtCommit)throw Object.assign(new Error('PROFILE_SESSION_EXPIRED'),{code:'PROFILE_SESSION_EXPIRED',statusCode:401});return result;
  },
  personal:vi.fn(async()=>{throw Object.assign(new Error('PROFILE_PERSONAL_TOKEN_INVALID'),{code:'PROFILE_PERSONAL_TOKEN_INVALID',statusCode:401});}),
 };
 return{deps,query,authority,expireAtCommit:()=>{expiredAtCommit=true;}};
}
const request=(headers:Record<string,string>={},method='GET')=>({headers,method,query:{}} as FastifyRequest);
const headers={'x-commerce-profile-id':'one','x-commerce-profile-version':'3'};
describe('explicit profile HTTP authority',()=>{
 it('uses native identity and a versioned fence, with a constant server action',async()=>{
  const f=fixture();expect(await withProfileRequest(request(headers),'REAL',{scope:'profile:read',mutation:false},async c=>c.db.workspaceId,f.deps)).toBe('one');expect(f.deps.nativeSession).toHaveBeenCalledOnce();
 });
 it.each(['0','-1','3.0','03','3e0','3,4','9007199254740992'])('rejects noncanonical fence version %s before native authentication',async version=>{
  const f=fixture();await expect(withProfileRequest(request({...headers,'x-commerce-profile-version':version}),'REAL',{scope:'profile:read',mutation:false},vi.fn(),f.deps)).rejects.toMatchObject({code:'PROFILE_REQUEST_FENCE_REQUIRED'});expect(f.deps.nativeSession).not.toHaveBeenCalled();
 });
 it('rejects a stale or foreign fence without calling business SQL',async()=>{
  const f=fixture(),work=vi.fn();for(const altered of [{...headers,'x-commerce-profile-id':'two'},{...headers,'x-commerce-profile-version':'2'}])await expect(withProfileRequest(request(altered),'REAL',{scope:'profile:read',mutation:false},work,f.deps)).rejects.toMatchObject({code:'PROFILE_SELECTION_CHANGED'});expect(work).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();
 });
 it('requires exact Origin for session mutations before identity reads',async()=>{
  const f=fixture();await expect(withProfileRequest(request(headers,'POST'),'REAL',{scope:'products:write',mutation:true},vi.fn(),f.deps)).rejects.toMatchObject({code:'ORIGIN_REJECTED'});expect(f.deps.nativeSession).not.toHaveBeenCalled();
  expect(await withProfileRequest(request({...headers,origin:'https://example.test'},'POST'),'REAL',{scope:'products:write',mutation:true},async()=>true,f.deps)).toBe(true);
 });
 it.each(['','Basic abc','Bearer cos_st_unknown','Bearer cos_pat_short'])('never downgrades invalid Authorization to a cookie session',async authorization=>{
  const f=fixture();await expect(withProfileRequest(request({authorization}),'REAL',{scope:'profile:read',mutation:false},vi.fn(),f.deps)).rejects.toMatchObject({code:'PROFILE_PERSONAL_TOKEN_REQUIRED'});expect(f.deps.nativeSession).not.toHaveBeenCalled();expect(f.deps.personal).not.toHaveBeenCalled();
 });
 it('forbids PAT selector headers, even if they match its intended profile',async()=>{
  const f=fixture();await expect(withProfileRequest(request({...headers,authorization:'Bearer cos_pat_'+'s'.repeat(43)}),'REAL',{scope:'profile:read',mutation:false},vi.fn(),f.deps)).rejects.toMatchObject({code:'PROFILE_TOKEN_CANNOT_SELECT'});expect(f.deps.personal).not.toHaveBeenCalled();
 });
 it('passes only the PAT and explicit environment to the token transaction, never the cookie',async()=>{
  const f=fixture(),token='cos_pat_'+'s'.repeat(43),work=vi.fn(),action={scope:'profile:read' as const,mutation:false};await expect(withProfileRequest(request({authorization:'Bearer '+token,cookie:'untrusted'}),'SIMULATION',action,work,f.deps)).rejects.toMatchObject({code:'PROFILE_PERSONAL_TOKEN_INVALID'});expect(f.deps.personal).toHaveBeenCalledWith(token,'SIMULATION',action,work);expect(f.deps.nativeSession).not.toHaveBeenCalled();
 });
 it('has a closed read query and rejects workspace overrides',()=>{
  expect(profileReadEnvironment(request())).toBe('REAL');expect(()=>profileReadEnvironment({...request(),query:{workspace_id:'two'}} as FastifyRequest)).toThrow('PROFILE_QUERY_INVALID');
 });
 it('returns profile/employee responses only after the authorized transaction resolves',async()=>{
  const f=fixture(),app=Fastify();try{
   await profileOverviewRoutes(app,f.deps);
   const overview=await app.inject({url:'/v2/profile',headers});expect(overview.statusCode).toBe(200);expect(overview.json().data.id).toBe('one');expect(overview.headers['cache-control']).toBe('no-store');
   const employees=await app.inject({url:'/v2/employees',headers});expect(employees.statusCode).toBe(200);expect(employees.json().data).toHaveLength(1);
   for(const call of f.query.mock.calls)expect(call).toEqual([expect.stringMatching(/WHERE (id|m.workspace_id)=\$1/),['one']]);
   f.expireAtCommit();const expired=await app.inject({url:'/v2/profile',headers});expect(expired.statusCode).toBe(401);expect(expired.body).not.toContain('Synthetic');
  }finally{await app.close();}
 });
 it('forbids employee listing for an operator before reading identities',async()=>{
  const f=fixture();f.authority.membership.role='operator';const app=Fastify();try{await profileOverviewRoutes(app,f.deps);expect((await app.inject({url:'/v2/employees',headers})).statusCode).toBe(403);expect(f.query).not.toHaveBeenCalled();}finally{await app.close();}
 });
});
