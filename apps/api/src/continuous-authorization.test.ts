import Fastify from 'fastify';
import {ZodError} from 'zod';
import {describe,it,expect,vi} from 'vitest';
import {continuousAuthorizationRoutes} from './continuous-authorization.js';
import type {ProfileRequestDependencies} from './profile-request.js';
import type {ProfileAuthority} from '../../../packages/domain/src/core/profile-authorization.js';
import type {ContinuousAuthorization} from '../../../packages/contracts/src/continuous-authorization.js';
import type {ProfileQuery} from '../../../packages/db/src/profile-context.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const root='/v2/continuity/commercial',headers={'x-commerce-profile-id':'one','x-commerce-profile-version':'1',origin:'https://example.invalid'};
function fixture(){
 let current:ContinuousAuthorization={id:id(1),workspaceId:'one',environment:'REAL',accountId:id(2),source:{kind:'COMMERCIAL_ASSIGNMENT',assignmentId:id(3),assignmentRevision:1,bindingId:id(4)},
  createdBy:'owner',createdAt:'2026-01-01T00:00:00Z',version:1,humanPaused:false,revokedAt:null,protections:[]};
 const authority:ProfileAuthority={profile:{id:'one',state:'ACTIVE'},membership:{userId:'owner',workspaceId:'one',role:'owner',active:true,version:1},
  credential:{kind:'session',userId:'owner',workspaceId:'one',revoked:false,expiresAt:'2099-01-01T00:00:00Z',scopes:[],membershipVersion:1}};
 const query=vi.fn(async(sql:string,values?:unknown[])=>{
  let rows:object[]=[];
  if(sql.includes('pg_try_advisory'))rows=[{acquired:true}];
  else if(sql.startsWith('SELECT continuous_human_pause'))rows=[{paused:current.humanPaused}];
  else if(sql.includes('SELECT clock_timestamp'))rows=[{now:new Date()}];
  else if(sql.startsWith('SELECT state'))rows=[{state:current}];
  else if(sql.startsWith('UPDATE continuous_authorizations')){current=values![4] as ContinuousAuthorization;rows=[{state:current}];}
  else if(sql.startsWith('INSERT INTO continuous_authorization_events'))rows=[{version:values![3]}];
  else if(sql.startsWith('INSERT INTO continuous_authorization_operations'))rows=[{operation_id:values![3]}];
  return {command:'SELECT',rowCount:rows.length,rows,fields:[],oid:0};
 });
 const db={workspaceId:'one',query:query as ProfileQuery};
 const session=vi.fn(async(_s:any,_f:any,environment:any,_a:any,work:any)=>work({db,environment,profile:{authority}}));
 const deps:ProfileRequestDependencies={origins:[headers.origin],nativeSession:async()=>({id:'session',userId:'owner'}),session,
  personal:vi.fn(async()=>{throw Object.assign(new Error('UNAUTHORIZED'),{statusCode:401});})};
 return {query,db,session,deps,authority,state:()=>current};
}
async function setup(f:ReturnType<typeof fixture>){const app=Fastify();app.setErrorHandler((e:any,_r,reply)=>reply.code(e instanceof ZodError?400:e.statusCode??500).send({error:e.code??'REJECTED'}));await continuousAuthorizationRoutes(app,f.deps);return app;}

describe('continuous authorization HTTP boundary',()=>{
 it('reads with explicit profile authority and defaults REAL, with bounded private output',async()=>{
  const f=fixture(),app=await setup(f);try{const r=await app.inject({url:root,headers});expect(r.statusCode).toBe(200);expect(r.json()).toEqual({data:[f.state()],nextAfterId:null});
   expect(r.headers['cache-control']).toBe('no-store');expect(f.session.mock.calls[0][3]).toEqual({scope:'assignments:read',mutation:false});
   expect(f.query.mock.calls[0][1]).toEqual(['one','REAL','COMMERCIAL_ASSIGNMENT',null,null,51]);
  }finally{await app.close();}
 });
 it.each(['workspaceId=two','limit=101','limit=0','afterId=bad','environment=unknown','environment=REAL&environment=SIMULATION'])('rejects %s before identity or SQL',async suffix=>{
  const f=fixture(),app=await setup(f);try{expect((await app.inject({url:root+'?'+suffix,headers})).statusCode).toBe(400);expect(f.query).not.toHaveBeenCalled();expect(f.session).not.toHaveBeenCalled();}finally{await app.close();}
 });
 it('persists pause and event through the shared authority transaction',async()=>{
  const f=fixture(),app=await setup(f);try{const r=await app.inject({method:'POST',url:root+'/'+id(1)+'/commands',headers,payload:{operationId:id(9),expectedVersion:1,action:'pause'}});
   expect(r.statusCode).toBe(200);expect(r.json().data).toMatchObject({version:2,humanPaused:true,protections:[]});
   expect(f.session.mock.calls[0][3]).toEqual({scope:'assignments:write',mutation:true});expect(f.query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO continuous_authorization_events'))).toHaveLength(1);
  }finally{await app.close();}
 });
 it.each([{protections:[]},{workspaceId:'two'},{createdBy:'another'},{action:'clear-protection'},{expectedVersion:0},{operationId:id(9),expiresAt:'2099-01-01T00:00:00Z'}])('rejects injected human command %j',async extra=>{
  const f=fixture(),app=await setup(f);try{expect((await app.inject({method:'POST',url:root+'/'+id(1)+'/commands',headers,payload:{operationId:id(9),expectedVersion:1,action:'pause',...extra}})).statusCode).toBe(400);expect(f.query).not.toHaveBeenCalled();}finally{await app.close();}
 });
 it('does not let viewer mutate or use a read PAT as mutation authority',async()=>{
  const f=fixture(),app=await setup(f);f.authority.membership.role='viewer';try{
   expect((await app.inject({method:'POST',url:root+'/'+id(1)+'/commands',headers,payload:{operationId:id(9),expectedVersion:1,action:'pause'}})).statusCode).toBe(403);expect(f.query).not.toHaveBeenCalled();
  }finally{await app.close();}
 });
 it('requires native session origin and refuses bearer profile overrides before SQL',async()=>{
  const f=fixture(),app=await setup(f);try{
   expect((await app.inject({method:'POST',url:root+'/'+id(1)+'/commands',headers:{...headers,origin:'https://foreign.invalid'},payload:{operationId:id(9),expectedVersion:1,action:'pause'}})).statusCode).toBe(403);
   expect((await app.inject({url:root,headers:{...headers,authorization:'Bearer cos_pat_'+'x'.repeat(43)}})).statusCode).toBe(403);expect(f.query).not.toHaveBeenCalled();
  }finally{await app.close();}
 });
 it('exposes no public QR origin or protection endpoint',async()=>{
  const f=fixture(),app=await setup(f);try{for(const url of ['/v2/continuity/warmup',root+'/'+id(1)+'/protection'])expect((await app.inject({method:'POST',url,headers,payload:{}})).statusCode).toBe(404);expect(f.query).not.toHaveBeenCalled();}finally{await app.close();}
 });
 it('withholds the prepared state if final transaction authority or commit fails',async()=>{
  const f=fixture();f.session.mockImplementationOnce(async(...args:any[])=>{await args[4]({db:f.db,environment:'REAL',profile:{authority:f.authority}});throw Object.assign(new Error('EXPIRED'),{statusCode:401});});
  const app=await setup(f);try{const r=await app.inject({url:root,headers});expect(r.statusCode).toBe(401);expect(r.body).not.toContain('COMMERCIAL_ASSIGNMENT');}finally{await app.close();}
 });
 it('does not expose an authorization through the other purpose scope',async()=>{
  const f=fixture(),app=await setup(f);try{expect((await app.inject({url:'/v2/continuity/warmup/'+id(1),headers})).statusCode).toBe(404);}finally{await app.close();}
 });
});
