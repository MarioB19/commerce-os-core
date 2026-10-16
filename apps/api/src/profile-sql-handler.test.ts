import {describe,expect,it,vi} from 'vitest';
import Fastify from 'fastify';
import type {RouteHandlerMethod} from 'fastify';
import {authorizedProfileSqlHandler} from './profile-sql-handler.js';
import type {ProfileRequestDependencies} from './profile-request.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../../packages/domain/src/core/profile-authorization.js';
import {withProfileTransaction,type ProfileQuery} from '../../../packages/db/src/profile-context.js';
import {currentProfileExecutor} from '../../../packages/db/src/profile-query-routing.js';
import {pool,withTransaction} from '../../../packages/db/src/index.js';
import type {SessionProfile} from '../../../packages/db/src/profile-session.js';

const action={scope:'products:write' as const,mutation:true};
const headers={'x-commerce-profile-id':'one','x-commerce-profile-version':'3',origin:'https://example.test'};
const payload={environment:'REAL'};
function fixture(handler:RouteHandlerMethod,options:{method?:'GET'|'POST';beforeCommit?:()=>Promise<void>}={}){
 const authority:ProfileAuthority={profile:{id:'one',state:'ACTIVE'},membership:{userId:'user',workspaceId:'one',role:'owner',active:true,version:1},credential:{kind:'session',userId:'user',workspaceId:'one',revoked:false,expiresAt:'2099-01-01T00:00:00Z',membershipVersion:1,scopes:[]}};
 const profile:SessionProfile={profile:{id:'one',businessName:'Synthetic',state:'ACTIVE',timezone:'UTC',version:1},membership:{role:'owner',version:1},selection:{workspaceId:'one',version:3},authority};
 const calls:string[]=[],bound:{profile:string;scope:string;environment:string}[]=[],wire:string[]=[];
 let released=0,committed=false,failCommit=false,revoke=false;
 const connection={query:vi.fn(async(sql:string)=>{calls.push(sql);if(sql==='COMMIT'){await options.beforeCommit?.();if(failCommit)throw new Error('SYNTHETIC_COMMIT_FAILED');committed=true;}return{rows:[{synthetic:true}],rowCount:1,command:sql==='COMMIT'?'COMMIT':'SELECT',fields:[],oid:0};}) as ProfileQuery,release:vi.fn()};
 const dependencies:ProfileRequestDependencies={origins:['https://example.test'],nativeSession:vi.fn(async()=>({id:'session',userId:'user'})),
  session:async(_native,fence,environment,requested,work)=>{
   if(fence.workspaceId!=='one'||fence.version!==3)throw Object.assign(new Error('PROFILE_SELECTION_CHANGED'),{code:'PROFILE_SELECTION_CHANGED',statusCode:409});
   return withProfileTransaction({connect:async()=>connection},'one',async db=>{
    authorizeProfileAction(authority,{...requested,workspaceId:'one'});
    const result=await work({db,profile,environment});
    if(revoke)authority.credential.revoked=true;
    authorizeProfileAction(authority,{...requested,workspaceId:'one'});
    return result;
   });
  },personal:vi.fn(async()=>{throw Object.assign(new Error('PROFILE_PERSONAL_TOKEN_INVALID'),{code:'PROFILE_PERSONAL_TOKEN_INVALID',statusCode:401});}),
 };
 const app=Fastify();
 app.setErrorHandler((error,req,reply)=>reply.code((error as {statusCode?:number}).statusCode??500).send({code:(error as {code?:string}).code??'FAILED'}));
 app.addHook('onSend',async(req,reply,body)=>{wire.push(String(body));if(reply.statusCode===201)expect(committed).toBe(true);return body;});
 const fixedAction={...action};
 app.route({method:options.method??'POST',url:'/scoped',handler:authorizedProfileSqlHandler(fixedAction,handler,{request:dependencies,bindIdentity(_req,context,requested){expect(currentProfileExecutor()).toBe(context.db);bound.push({profile:context.db.workspaceId,scope:requested.scope,environment:context.environment});return()=>{released++;};}})});
 return{app,authority,connection,dependencies,calls,bound,wire,fixedAction,setCommitFailure:()=>{failCommit=true;},setFinalRevocation:()=>{revoke=true;},get released(){return released;},get committed(){return committed;}};
}
async function using(handler:RouteHandlerMethod,run:(f:ReturnType<typeof fixture>)=>Promise<void>,options:Parameters<typeof fixture>[1]={}){const f=fixture(handler,options);try{await run(f);}finally{await f.app.close();}}
const request={method:'POST' as const,url:'/scoped',headers,payload};

describe('materialized SQL HTTP authority boundary',()=>{
 it('routes global and nested legacy queries to one profile and sends only after COMMIT',async()=>{
  await using(async(req,reply)=>{
   expect(currentProfileExecutor()?.workspaceId).toBe('one');
   await pool.query('UPDATE synthetic_scoped SET value=$1',[1]);
   await withTransaction(async db=>{await db.query('SELECT synthetic_scoped');});
   reply.header('x-private','ok').code(201);return{synthetic:true};
  },async f=>{
   const res=await f.app.inject(request);expect(res.statusCode).toBe(201);expect(res.json()).toEqual({synthetic:true});
   expect(f.calls.filter(x=>x==='BEGIN')).toHaveLength(1);expect(f.calls.filter(x=>x==='COMMIT')).toHaveLength(1);expect(f.calls).toContain('UPDATE synthetic_scoped SET value=$1');
   expect(f.bound).toEqual([{profile:'one',scope:'products:write',environment:'REAL'}]);expect(f.released).toBe(1);expect(f.connection.release).toHaveBeenCalledOnce();
  });
 });
 it('does not release headers or bytes while COMMIT is pending',async()=>{
  let resolve!:()=>void,entered!:()=>void;const barrier=new Promise<void>(r=>{resolve=r;}),atCommit=new Promise<void>(r=>{entered=r;});
  await using(async(req,reply)=>reply.header('x-private','hidden').code(201).send({secret:'synthetic'}),async f=>{
   const response=f.app.inject(request);await atCommit;expect(f.wire).toEqual([]);resolve();expect((await response).statusCode).toBe(201);
  },{beforeCommit:async()=>{entered();await barrier;}});
 });
 it.each(['revoked','commit failed'] as const)('discards staged data and headers if final authority is %s',async mode=>{
  await using(async(req,reply)=>{await pool.query('UPDATE synthetic_scoped');return reply.header('x-private','hidden').code(201).send({secret:'synthetic-private'});},async f=>{
   if(mode==='revoked')f.setFinalRevocation();else f.setCommitFailure();
   const res=await f.app.inject(request);expect(res.statusCode).toBe(mode==='revoked'?403:500);expect(res.body).not.toContain('synthetic-private');expect(res.headers['x-private']).toBeUndefined();expect(f.calls).toContain('ROLLBACK');expect(f.released).toBe(1);
  });
 });
 it('snapshots sent JSON and binary bytes before later handler mutation',async()=>{
  await using(async(req,reply)=>{const value={nested:{value:1}};reply.send(value);value.nested.value=2;return reply;},async f=>{expect((await f.app.inject(request)).json()).toEqual({nested:{value:1}});});
  await using(async(req,reply)=>{const value=Buffer.from([1,2,3]);reply.type('application/octet-stream').send(value);value.fill(9);return reply;},async f=>{expect((await f.app.inject(request)).rawPayload).toEqual(Buffer.from([1,2,3]));});
 });
 it.each(['raw','hijack','serializer'])('caught access to %s poisons response before COMMIT',async key=>{
  await using(async(req,reply)=>{try{Reflect.get(reply,key);}catch{/* the wrapper must remember rejection */}return{synthetic:true};},async f=>{
   const res=await f.app.inject(request);expect(res.statusCode).toBe(500);expect(res.json().code).toBe('PROFILE_RESPONSE_REJECTED');expect(f.calls).not.toContain('COMMIT');expect(f.calls).toContain('ROLLBACK');
  });
 });
 it.each([()=>1n,()=>({loop:null}),()=>new Error('private')])('rejects non-materializable payload before COMMIT even if caught',async make=>{
  await using(async(req,reply)=>{const value=make();if(typeof value==='object'&&value&&'loop'in value)(value as {loop:unknown}).loop=value;try{reply.send(value);}catch{/* swallowed business error */}return{synthetic:true};},async f=>{expect((await f.app.inject(request)).statusCode).toBe(500);expect(f.calls).not.toContain('COMMIT');});
 });
 it.each(['duplicate','ambiguous','missing'] as const)('rejects %s response protocol before COMMIT',async mode=>{
  await using(async(req,reply)=>{if(mode==='missing')return;if(mode==='duplicate'){reply.send({a:1});try{reply.send({a:2});}catch{/* deliberately swallowed to verify rejection remains sticky */}return reply;}reply.send({a:1});return{b:2};},async f=>{expect((await f.app.inject(request)).statusCode).toBe(500);expect(f.calls).not.toContain('COMMIT');});
 });
 it('validates headers before COMMIT including mutated staged arrays',async()=>{
  await using(async(req,reply)=>{try{reply.header('x-private','bad\r\ninjected: true');}catch{/* deliberately swallowed to verify rejection remains sticky */}return{ok:true};},async f=>{expect((await f.app.inject(request)).statusCode).toBe(500);expect(f.calls).not.toContain('COMMIT');});
  await using(async(req,reply)=>{reply.header('x-private',['first']);(reply.getHeader('x-private') as string[]).push('bad\nvalue');return{ok:true};},async f=>{expect((await f.app.inject(request)).statusCode).toBe(500);expect(f.calls).not.toContain('COMMIT');});
 });
 it.each(['text/plain','text/plain; note=json'])('rejects object with non-JSON %s before COMMIT',async type=>{
  await using(async(req,reply)=>reply.type(type).send({ok:true}),async f=>{const res=await f.app.inject(request);expect(res.statusCode).toBe(500);expect(res.json().code).toBe('PROFILE_RESPONSE_CONTENT_TYPE_INVALID');expect(f.calls).toContain('ROLLBACK');expect(f.calls).not.toContain('COMMIT');});
 });
 it('supports explicit empty 204 and staged header operations',async()=>{
  await using(async(req,reply)=>{reply.header('x-drop','drop');expect(reply.hasHeader('x-drop')).toBe(true);reply.removeHeader('x-drop');expect(reply.getHeader('x-drop')).toBeUndefined();return reply.status(204).send();},async f=>{const res=await f.app.inject(request);expect(res.statusCode).toBe(204);expect(res.body).toBe('');expect(res.headers['x-drop']).toBeUndefined();expect(f.committed).toBe(true);});
 });
 it('binds the server action once and ignores body scopes',async()=>{
  await using(async()=>({ok:true}),async f=>{
   f.fixedAction.scope='profile:read' as typeof action.scope;
   expect((await f.app.inject({...request,payload:{...payload,scope:'profile:read'}})).statusCode).toBe(200);expect(f.bound[0].scope).toBe('products:write');
  });
 });
 it('rejects stale selection, PAT selector, missing origin and conflicting environments before SQL',async()=>{
  await using(async()=>({ok:true}),async f=>{
   for(const change of [
    {...request,headers:{...headers,'x-commerce-profile-id':'two'}},
    {...request,headers:{...headers,authorization:'Bearer cos_pat_'+'s'.repeat(43)}},
    {...request,headers:{...headers,origin:'https://foreign.test'}},
    {...request,url:'/scoped?environment=SIMULATION'},
    {...request,payload:{}},
   ])expect((await f.app.inject(change)).statusCode).toBeGreaterThanOrEqual(400);
   expect(f.calls).toEqual([]);expect(f.bound).toEqual([]);expect(f.dependencies.personal).not.toHaveBeenCalled();
  });
 });
 it('does not upgrade a PAT request to a native session',async()=>{
  await using(async()=>({ok:true}),async f=>{const res=await f.app.inject({...request,headers:{authorization:'Bearer cos_pat_'+'s'.repeat(43)}});expect(res.statusCode).toBe(401);expect(f.dependencies.nativeSession).not.toHaveBeenCalled();expect(f.dependencies.personal).toHaveBeenCalledOnce();expect(f.calls).toEqual([]);});
 });
 it('returns handler errors after cleanup and rolls back',async()=>{
  await using(async()=>{await pool.query('UPDATE synthetic_scoped');throw new Error('private failure');},async f=>{expect((await f.app.inject(request)).json()).toEqual({code:'FAILED'});expect(f.calls).toContain('ROLLBACK');expect(f.calls).not.toContain('COMMIT');expect(f.released).toBe(1);});
 });
 it('uses the same native authority on read-only requests with REAL default',async()=>{
  await using(async()=>({profile:currentProfileExecutor()?.workspaceId}),async f=>{const res=await f.app.inject({url:'/scoped',headers});expect(res.json()).toEqual({profile:'one'});expect(f.bound[0].environment).toBe('REAL');},{method:'GET'});
 });
});
