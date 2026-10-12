import {describe,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import {profileEmployeeRoutes} from './profile-employees.js';
import type {ProfileRequestDependencies} from './profile-request.js';
import type {ProfileQuery} from '../../../packages/db/src/profile-context.js';
import type {SessionProfile} from '../../../packages/db/src/profile-session.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../../packages/domain/src/core/profile-authorization.js';
const headers={origin:'https://example.test','x-commerce-profile-id':'one','x-commerce-profile-version':'3'};
const input={expectedVersion:2,role:'viewer',active:false};
function fixture(){
 const authority:ProfileAuthority={profile:{id:'one',state:'ACTIVE'},membership:{userId:'actor',workspaceId:'one',role:'owner',active:true,version:1},credential:{kind:'session',userId:'actor',workspaceId:'one',revoked:false,expiresAt:'2099-01-01T00:00:00Z',membershipVersion:1,scopes:[]}};
 const profile:SessionProfile={profile:{id:'one',businessName:'Synthetic',state:'ACTIVE',timezone:'UTC',version:2},membership:{role:'owner',version:1},selection:{workspaceId:'one',version:3},authority};
 let row:{user_id:string;role:string;active:boolean;version:number}|undefined={user_id:'employee',role:'operator',active:true,version:2},others=1,wrong=false,expired=false;
 const query=vi.fn(async(sql:string,values?:unknown[])=>{
  if(sql.startsWith('SELECT 1'))return{rows:[],rowCount:others,command:'SELECT',fields:[],oid:0};
  if(sql.startsWith('UPDATE')&&row)row={user_id:'employee',role:values![2] as string,active:values![3] as boolean,version:wrong?2:row.version+1};
  return{rows:(sql.startsWith('SELECT')||sql.startsWith('UPDATE'))&&row?[{...row}]:[],rowCount:row?1:0,command:'SELECT',fields:[],oid:0};
 });
 const deps:ProfileRequestDependencies={origins:['https://example.test'],nativeSession:vi.fn(async()=>({id:'native',userId:'actor'})),async session(_native,fence,environment,action,work){
  if(fence.workspaceId!=='one'||fence.version!==3)throw Object.assign(new Error('PROFILE_SELECTION_CHANGED'),{statusCode:409});
  authorizeProfileAction(authority,{...action,workspaceId:'one'});const result=await work({db:{workspaceId:'one',query:query as ProfileQuery},profile,environment});if(expired)throw Object.assign(new Error('PROFILE_SESSION_EXPIRED'),{statusCode:401});return result;
 },personal:vi.fn(async()=>{throw Object.assign(new Error('PROFILE_PERSONAL_TOKEN_INVALID'),{statusCode:401});})};
 return{deps,query,authority,row:(v:typeof row)=>{row=v;},others:(v:number)=>{others=v;},wrong:()=>{wrong=true;},expire:()=>{expired=true;}};
}
async function withApp(work:(app:ReturnType<typeof Fastify>,f:ReturnType<typeof fixture>)=>Promise<void>){const f=fixture(),app=Fastify();try{await profileEmployeeRoutes(app,f.deps);await work(app,f);}finally{await app.close();}}
const request=(app:ReturnType<typeof Fastify>,payload:unknown=input,url='/v2/employees/employee')=>app.inject({method:'PATCH',url,headers,payload:payload as Record<string,unknown>});
describe('prepared employee administration',()=>{
 it('binds target, CAS and audit to authorized profile without modifying identity',()=>withApp(async(app,f)=>{
  const r=await request(app);expect(r.statusCode).toBe(200);expect(r.json().data).toEqual({user_id:'employee',role:'viewer',active:false,version:3,changed:true});expect(r.headers['cache-control']).toBe('no-store');
  expect(f.query.mock.calls.find(([q])=>q.startsWith('UPDATE'))![1]).toEqual(['one','employee','viewer',false,2]);
  const event=f.query.mock.calls.find(([q])=>q.startsWith('INSERT INTO domain_events'))![1]!;expect(event.slice(1,5)).toEqual(['one','REAL','profile.employee.access.changed','employee']);expect(event[7]).toEqual({type:'human',id:'actor'});expect(event[8]).toEqual({before:{role:'operator',active:true,version:2},after:{role:'viewer',active:false,version:3}});
 }));
 it('keeps no-op version and event count',()=>withApp(async(app,f)=>{f.row({user_id:'employee',role:'viewer',active:false,version:2});const r=await request(app);expect(r.json().data.changed).toBe(false);expect(f.query).toHaveBeenCalledOnce();}));
 it('rejects changing own authority before target SQL',()=>withApp(async(app,f)=>{expect((await request(app,input,'/v2/employees/actor')).statusCode).toBe(409);expect(f.query).not.toHaveBeenCalled();}));
 it('rejects absent, unadopted, stale and last-owner rows before updates',()=>withApp(async(app,f)=>{
  for(const [row,status]of [[undefined,404],[{user_id:'employee',role:'seller',active:true,version:2},503],[{user_id:'employee',role:'operator',active:true,version:3},409],[{user_id:'employee',role:'owner',active:true,version:2},409]]as const){f.row(row?{...row}:undefined);f.others(0);expect((await request(app)).statusCode).toBe(status);expect(f.query.mock.calls.some(([q])=>q.startsWith('UPDATE'))).toBe(false);}
 }));
 it('allows another owner to demote an owner and confirms database version',()=>withApp(async(app,f)=>{f.row({user_id:'employee',role:'owner',active:true,version:2});expect((await request(app)).statusCode).toBe(200);expect(f.query.mock.calls.some(([q])=>q.startsWith('SELECT 1'))).toBe(true);}));
 it.each([{...input,userId:'actor'},{...input,workspace_id:'two'},{...input,role:'seller'},{...input,active:0},{...input,expectedVersion:0},{...input,email:'new@example.test'}])('rejects invalid/extra input before authentication %#',payload=>withApp(async(app,f)=>{expect((await request(app,payload)).statusCode).toBe(400);expect(f.deps.nativeSession).not.toHaveBeenCalled();}));
 it('rejects environment overrides and wrong origin',()=>withApp(async(app,f)=>{expect((await request(app,input,'/v2/employees/employee?environment=SIMULATION')).statusCode).toBe(400);expect((await app.inject({method:'PATCH',url:'/v2/employees/employee',headers:{...headers,origin:'https://other.test'},payload:input})).statusCode).toBe(403);expect(f.query).not.toHaveBeenCalled();}));
 it.each(['operator','viewer']as const)('rejects %s before reading employees',role=>withApp(async(app,f)=>{f.authority.membership.role=role;expect((await request(app)).statusCode).toBe(403);expect(f.query).not.toHaveBeenCalled();}));
 it('refuses unconfirmed write and withholds response after final expiry',()=>withApp(async(app,f)=>{f.wrong();expect((await request(app)).statusCode).toBe(409);expect(f.query.mock.calls.some(([q])=>q.startsWith('INSERT'))).toBe(false);f.row({user_id:'employee',role:'viewer',active:false,version:2});f.expire();expect((await request(app)).statusCode).toBe(401);}));
 it('does not fall back from PAT to cookie authority',()=>withApp(async(app,f)=>{const token='cos_pat_'+'s'.repeat(43);expect((await app.inject({method:'PATCH',url:'/v2/employees/employee',headers:{authorization:'Bearer '+token},payload:input})).statusCode).toBe(401);expect(f.deps.personal).toHaveBeenCalledWith(token,'REAL',{scope:'employees:write',mutation:true},expect.any(Function));expect(f.deps.nativeSession).not.toHaveBeenCalled();}));
});
