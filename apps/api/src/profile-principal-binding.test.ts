import {describe,it,expect,vi} from 'vitest';
import type {FastifyRequest} from 'fastify';
import type {ProfileExecutor,ProfileQuery} from '../../../packages/db/src/profile-context.js';
import {currentProfileExecutor,withProfileQueryRouting} from '../../../packages/db/src/profile-query-routing.js';
import type {Principal} from '../../../packages/domain/src/core/permissions.js';
import type {ProfileRequestContext} from './profile-request.js';
import {profilePrincipalBinder,profilePrincipalAuthority,authorizeBoundProfileAction} from './profile-principal-binding.js';

const action={scope:'products:write' as const,mutation:true},tokenId='1492260a-8f43-4335-b278-859e6449a6f4';
function fixture(kind:'session'|'personal_token'='session'){
 const db:ProfileExecutor={workspaceId:'one',query:vi.fn(async()=>({rows:[],rowCount:0,command:'SELECT',fields:[],oid:0})) as ProfileQuery};
 const authority={profile:{id:'one',state:'ACTIVE' as const},membership:{workspaceId:'one',userId:'native-user',role:'operator' as const,active:true,version:1},credential:{kind,userId:'native-user',workspaceId:'one',revoked:false,expiresAt:'2099-01-01T00:00:00Z',membershipVersion:1,scopes:['products:write' as const]}};
 const base={profile:{id:'one',businessName:'Synthetic',state:'ACTIVE' as const,timezone:'UTC',version:1},membership:{role:'operator' as const,version:1},authority};
 const context:ProfileRequestContext={db,environment:'SIMULATION',profile:kind==='session'?{...base,selection:{workspaceId:'one',version:1}}:{...base,tokenId,environment:'SIMULATION'}};
 const request={} as FastifyRequest,registry=new WeakMap<FastifyRequest,Principal>();return{db,context,request,registry,binder:profilePrincipalBinder(registry,['catalog:write'])};
}
async function inside<T>(f:ReturnType<typeof fixture>,work:(context:ProfileRequestContext)=>Promise<T>){return withProfileQueryRouting(f.db,()=>work({...f.context,db:currentProfileExecutor()!}));}
describe('native profile Principal transaction binding',()=>{
 it('checks a compound action from the same live membership without adding aliases',async()=>{
  const f=fixture();await inside(f,async context=>{const release=f.binder(f.request,context,action);await authorizeBoundProfileAction(f.request,{scope:'offers:write',mutation:true});expect(f.registry.get(f.request)!.permissions).toEqual(['products:write','catalog:write']);release();});
  await expect(authorizeBoundProfileAction(f.request,{scope:'offers:write',mutation:true})).rejects.toThrow('PROFILE_PRINCIPAL_BOUNDARY_REQUIRED');
 });
 it('poisons a PAT transaction when a secondary scope denial is caught',async()=>{
  const f=fixture('personal_token');await expect(inside(f,async context=>{f.binder(f.request,context,action);await authorizeBoundProfileAction(f.request,{scope:'offers:write',mutation:true}).catch(()=>undefined);})).rejects.toThrow('PROFILE_QUERY_CONTEXT_REJECTED');
 });
 it('accepts an explicitly scoped PAT secondary action and rejects an unbound request',async()=>{
  const f=fixture('personal_token');f.context.profile.authority.credential.scopes=['products:write','offers:write'];
  await inside(f,async context=>{const release=f.binder(f.request,context,action);await authorizeBoundProfileAction(f.request,{scope:'offers:write',mutation:true});await expect(authorizeBoundProfileAction({} as FastifyRequest,{scope:'offers:write',mutation:true})).rejects.toThrow('PROFILE_PRINCIPAL_BOUNDARY_REQUIRED');release();});
 });
 it.each(['session','personal_token'] as const)('binds exact %s authority and removes identity at release',async kind=>{
  const f=fixture(kind);let saved:Principal|undefined;
  await inside(f,async context=>{
   const release=f.binder(f.request,context,action);saved=f.registry.get(f.request)!;
   expect(saved.workspace_id).toBe('one');expect(saved.user.id).toBe('native-user');expect(saved.role).toBe('operator');expect(saved.permissions).toEqual(['products:write','catalog:write']);expect(saved.allowed_environments).toEqual(['SIMULATION']);
   expect(saved.token_id).toBe(kind==='session'?undefined:tokenId);expect(profilePrincipalAuthority(f.request,saved,context.db)).toBe(true);
   release();expect(f.registry.has(f.request)).toBe(false);expect(()=>profilePrincipalAuthority(f.request,saved!)).toThrow('PROFILE_PRINCIPAL_BOUNDARY_REQUIRED');
  });
  expect(()=>profilePrincipalAuthority(f.request,saved!)).toThrow('PROFILE_PRINCIPAL_BOUNDARY_REQUIRED');
 });
 it('rejects a copied Principal, a different request or a copied executor despite identical fields',async()=>{
  const f=fixture();await inside(f,async context=>{
   const release=f.binder(f.request,context,action),p=f.registry.get(f.request)!;
   expect(()=>profilePrincipalAuthority(f.request,{...p},context.db)).toThrow();
   expect(()=>profilePrincipalAuthority({} as FastifyRequest,p,context.db)).toThrow();
   expect(()=>profilePrincipalAuthority(f.request,p,{...context.db})).toThrow();
   release();
  });
 });
 it('rejects binding outside ALS or to an unregistered copy of the executor',async()=>{
  const f=fixture();expect(()=>f.binder(f.request,f.context,action)).toThrow();await inside(f,async context=>{expect(()=>f.binder(f.request,{...context,db:{...context.db}},action)).toThrow();});expect(f.registry.has(f.request)).toBe(false);
 });
 it('never treats Principal fields or an old native PAT as a V7 transaction receipt',async()=>{
  const f=fixture('personal_token');const fabricated={authentication_method:'personal_access_token',profile_action:action} as unknown as Principal;
  expect(profilePrincipalAuthority(f.request,fabricated)).toBe(false);
  await inside(f,async()=>{expect(()=>profilePrincipalAuthority(f.request,fabricated)).toThrow();});
 });
 it('rejects existing legacy identity instead of restoring or upgrading it',async()=>{
  const f=fixture();f.registry.set(f.request,{} as Principal);await inside(f,async context=>{expect(()=>f.binder(f.request,context,action)).toThrow();});
 });
 it('rejects a PAT environment mismatch before binding',async()=>{
  const f=fixture('personal_token');await inside(f,async context=>{expect(()=>f.binder(f.request,{...context,environment:'REAL'},action)).toThrow();});expect(f.registry.has(f.request)).toBe(false);
 });
 it('does not reinterpret a personal token as a session when its native shape is absent',async()=>{
  const f=fixture('personal_token');await inside(f,async context=>{const {tokenId:_,...altered}=context.profile as Extract<typeof context.profile,{tokenId:string}>;expect(()=>f.binder(f.request,{...context,profile:altered as typeof context.profile},action)).toThrow();});
 });
 it('keeps concurrent profile requests independent',async()=>{
  const a=fixture(),b=fixture();await Promise.all([a,b].map(f=>inside(f,async context=>{const release=f.binder(f.request,context,action);await Promise.resolve();expect(profilePrincipalAuthority(f.request,f.registry.get(f.request)!,context.db)).toBe(true);const other=f===a?b:a;if(other.registry.has(other.request))expect(()=>profilePrincipalAuthority(other.request,other.registry.get(other.request)!)).toThrow();release();})));
 });
 it('does not permit reusing the request for a second route binding after release',async()=>{
  const f=fixture();await inside(f,async context=>{f.binder(f.request,context,action)();expect(()=>f.binder(f.request,context,action)).toThrow();});
 });
});
