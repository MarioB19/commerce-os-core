import {describe,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import {profileSettingsRoutes} from './profile-settings.js';
import type {ProfileRequestDependencies} from './profile-request.js';
import type {ProfileQuery} from '../../../packages/db/src/profile-context.js';
import type {SessionProfile} from '../../../packages/db/src/profile-session.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../../packages/domain/src/core/profile-authorization.js';

const headers={origin:'https://example.test','x-commerce-profile-id':'one','x-commerce-profile-version':'3'};
const input={expectedVersion:2,businessName:'Updated synthetic',timezone:'America/Mexico_City'};
function fixture(){
 const authority:ProfileAuthority={profile:{id:'one',state:'ACTIVE'},membership:{userId:'user',workspaceId:'one',role:'owner',active:true,version:1},credential:{kind:'session',userId:'user',workspaceId:'one',revoked:false,expiresAt:'2099-01-01T00:00:00Z',membershipVersion:1,scopes:[]}};
 const profile:SessionProfile={profile:{id:'one',businessName:'Synthetic',state:'ACTIVE',timezone:'UTC',version:2},membership:{role:'owner',version:1},selection:{workspaceId:'one',version:3},authority};
 let row={id:'one',business_name:'Synthetic',timezone:'UTC',version:2},wrongResult=false,expired=false;
 const query=vi.fn(async(sql:string,values?:unknown[])=>{
  if(sql.startsWith('UPDATE'))row={id:'one',business_name:values![1] as string,timezone:values![2] as string,version:wrongResult?2:row.version+1};
  return{rows:sql.startsWith('SELECT')||sql.startsWith('UPDATE')?[{...row}]:[],rowCount:1,command:'SELECT',fields:[],oid:0};
 });
 const deps:ProfileRequestDependencies={origins:['https://example.test'],nativeSession:vi.fn(async()=>({id:'native',userId:'user'})),
  async session(_native,fence,environment,action,work){
   if(fence.workspaceId!=='one'||fence.version!==3)throw Object.assign(new Error('PROFILE_SELECTION_CHANGED'),{statusCode:409});
   authorizeProfileAction(authority,{...action,workspaceId:'one'});
   const result=await work({db:{workspaceId:'one',query:query as ProfileQuery},profile,environment});
   if(expired)throw Object.assign(new Error('PROFILE_SESSION_EXPIRED'),{statusCode:401});return result;
  },personal:vi.fn(async()=>{throw Object.assign(new Error('PROFILE_PERSONAL_TOKEN_INVALID'),{statusCode:401});})};
 return{deps,query,authority,setRow:(v:typeof row)=>{row=v;},wrong:()=>{wrongResult=true;},expire:()=>{expired=true;}};
}
async function appFor(f:ReturnType<typeof fixture>){const app=Fastify();await profileSettingsRoutes(app,f.deps);return app;}
describe('own profile settings prepared HTTP contract',()=>{
 it('binds SQL and audit to the selected profile, permits only business fields and returns after commit',async()=>{
  const f=fixture(),app=await appFor(f);try{
   const result=await app.inject({method:'PATCH',url:'/v2/profile',headers,payload:input});
   expect(result.statusCode).toBe(200);expect(result.json().data).toEqual({id:'one',business_name:input.businessName,timezone:input.timezone,version:3,changed:true});expect(result.headers['cache-control']).toBe('no-store');
   const update=f.query.mock.calls.find(([sql])=>sql.startsWith('UPDATE'))!;expect(update[1]).toEqual(['one',input.businessName,input.timezone,2]);
   const audit=f.query.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO domain_events'))![1]!;
   expect(audit.slice(1,5)).toEqual(['one','REAL','profile.settings.changed','one']);
   expect(audit[7]).toEqual({type:'human',id:'user'});expect(audit[8]).toEqual({previous_version:2,version:3,fields:['business_name','timezone']});
   expect(JSON.stringify(audit)).not.toContain(input.businessName);
  }finally{await app.close();}
 });
 it('does not emit an event or advance the version for a no-op',async()=>{
  const f=fixture();f.setRow({id:'one',business_name:input.businessName,timezone:input.timezone,version:2});const app=await appFor(f);try{
   const r=await app.inject({method:'PATCH',url:'/v2/profile',headers,payload:input});expect(r.statusCode).toBe(200);expect(r.json().data.changed).toBe(false);expect(f.query).toHaveBeenCalledOnce();
  }finally{await app.close();}
 });
 it('preserves the current version on stale requests and refuses unconfirmed database writes',async()=>{
  const f=fixture(),app=await appFor(f);try{
   expect((await app.inject({method:'PATCH',url:'/v2/profile',headers,payload:{...input,expectedVersion:1}})).statusCode).toBe(409);expect(f.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
   f.wrong();expect((await app.inject({method:'PATCH',url:'/v2/profile',headers,payload:input})).statusCode).toBe(409);expect(f.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
  }finally{await app.close();}
 });
 it.each([{...input,workspaceId:'two'},{...input,state:'SUSPENDED'},{...input,numberLimit:20},{...input,timezone:'UTC;SET'},{...input,timezone:'Mars/Olympus'},{...input,businessName:'  '},{...input,expectedVersion:0}])('rejects unknown or invalid inputs before identity or SQL %#',async payload=>{
  const f=fixture(),app=await appFor(f);try{expect((await app.inject({method:'PATCH',url:'/v2/profile',headers,payload})).statusCode).toBe(400);expect(f.deps.nativeSession).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();}finally{await app.close();}
 });
 it('rejects environment overrides and requires an exact Origin for cookie requests',async()=>{
  const f=fixture(),app=await appFor(f);try{
   expect((await app.inject({method:'PATCH',url:'/v2/profile?environment=SIMULATION',headers,payload:input})).statusCode).toBe(400);
   expect((await app.inject({method:'PATCH',url:'/v2/profile',headers:{...headers,origin:'https://evil.test'},payload:input})).statusCode).toBe(403);expect(f.query).not.toHaveBeenCalled();
  }finally{await app.close();}
 });
 it.each(['operator','viewer'] as const)('rejects %s before reading business settings',async role=>{
  const f=fixture();f.authority.membership.role=role;const app=await appFor(f);try{expect((await app.inject({method:'PATCH',url:'/v2/profile',headers,payload:input})).statusCode).toBe(403);expect(f.query).not.toHaveBeenCalled();}finally{await app.close();}
 });
 it('withholds the result if final authority expires and refuses suspended profiles',async()=>{
  const f=fixture();f.expire();const app=await appFor(f);try{
   const r=await app.inject({method:'PATCH',url:'/v2/profile',headers,payload:input});expect(r.statusCode).toBe(401);expect(r.body).not.toContain(input.businessName);
   f.query.mockClear();f.authority.profile.state='SUSPENDED';expect((await app.inject({method:'PATCH',url:'/v2/profile',headers,payload:input})).statusCode).toBe(403);expect(f.query).not.toHaveBeenCalled();
  }finally{await app.close();}
 });
 it('passes a PAT only to its own REAL scoped transaction, never a cookie fallback',async()=>{
  const f=fixture(),app=await appFor(f),token='cos_pat_'+'s'.repeat(43);try{
   expect((await app.inject({method:'PATCH',url:'/v2/profile',headers:{authorization:'Bearer '+token,cookie:'ignored'},payload:input})).statusCode).toBe(401);
   expect(f.deps.personal).toHaveBeenCalledWith(token,'REAL',{scope:'profile:write',mutation:true},expect.any(Function));expect(f.deps.nativeSession).not.toHaveBeenCalled();
  }finally{await app.close();}
 });
});
