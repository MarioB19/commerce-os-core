import Fastify from 'fastify';
import {ZodError} from 'zod';
import {describe,it,expect,vi} from 'vitest';
import {groupWarmupRoutes} from './group-warmup.js';
import type {ProfileRequestDependencies} from './profile-request.js';
const store=vi.hoisted(()=>({create:vi.fn(async()=>({id:'created',version:1,status:'DRAFT'})),command:vi.fn(async()=>({id:'created',version:2,status:'ACTIVE'})),preview:vi.fn(async()=>({ready:true,previewHash:'a'.repeat(64)}))}));
vi.mock('../../../packages/db/src/group-warmup.js',()=>({createGroupWarmup:store.create,commandGroupWarmup:store.command,previewGroupWarmup:store.preview,
 groupWarmupOverview:vi.fn(),listWarmupGroups:vi.fn(),requestGroupRefresh:vi.fn(),listWarmupLibraries:vi.fn(),libraryScripts:vi.fn(),importWarmupLibrary:vi.fn(),warmupError:vi.fn()}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,config={name:'Equipo interno',groupId:id(1),senderIds:[id(2),id(3)],libraryVersion:'operacion-interna-es/v1',timezone:'America/Mexico_City'};
async function setup(){const app=Fastify();store.create.mockClear();store.command.mockClear();store.preview.mockClear();
 const personal=vi.fn(async(_token:any,environment:any,action:any,work:any)=>{expect(action.interactiveOnly).toBeUndefined();return work({db:{workspaceId:'own-profile'},environment,profile:{authority:{membership:{userId:'owner'}}}});});
 const session=vi.fn(async(_session:any,_fence:any,environment:any,action:any,work:any)=>{expect(action.interactiveOnly).toBeUndefined();return work({db:{workspaceId:'own-profile'},environment,profile:{authority:{membership:{userId:'owner'}}}});});
 const deps:ProfileRequestDependencies={origins:['https://commerce.example.test'],nativeSession:async()=>({id:'session',userId:'owner'}),session,personal};
 app.setErrorHandler((e:any,_req,reply)=>reply.code(e instanceof ZodError?400:e.statusCode??500).send({error:{code:e.code??'REJECTED'}}));await groupWarmupRoutes(app,deps);return{app,personal,session};
}
describe('V7.2 web/API parity for group start',()=>{
 it.each(['session','token'])('creates and starts with %s authority and warmup:write',async kind=>{const f=await setup();try{
  const headers=kind==='token'?{authorization:'Bearer cos_pat_'+'x'.repeat(43)}:{origin:'https://commerce.example.test','x-commerce-profile-id':'own-profile','x-commerce-profile-version':'1'};
  expect((await f.app.inject({method:'POST',url:'/v2/warmup/programs',headers,payload:{operationId:id(4),config}})).statusCode).toBe(200);
  const input={operationId:id(5),expectedVersion:1,action:'start',previewHash:'a'.repeat(64)};
  expect((await f.app.inject({method:'POST',url:`/v2/warmup/programs/${id(6)}/commands`,headers,payload:input})).json().data.status).toBe('ACTIVE');
  expect(store.create).toHaveBeenCalledOnce();expect(store.command).toHaveBeenCalledOnce();
  const calls=kind==='token'?f.personal.mock.calls.map(c=>c[2]):f.session.mock.calls.map(c=>c[3]);expect(calls).toEqual([{scope:'warmup:write',mutation:true},{scope:'warmup:write',mutation:true}]);
 }finally{await f.app.close();}});
 it.each([{workspaceId:'foreign'},{action:'force-start'},{previewHash:undefined},{expectedVersion:0},{authorizationId:id(3)}])('rejects unsafe or incomplete start input %j before authorization',async extra=>{const f=await setup();try{const r=await f.app.inject({method:'POST',url:`/v2/warmup/programs/${id(6)}/commands`,headers:{authorization:'Bearer cos_pat_'+'x'.repeat(43)},payload:{operationId:id(5),expectedVersion:1,action:'start',previewHash:'a'.repeat(64),...extra}});expect(r.statusCode).toBe(400);expect(f.personal).not.toHaveBeenCalled();expect(store.command).not.toHaveBeenCalled();}finally{await f.app.close();}});
 it('refuses token profile overrides and cross-origin session writes',async()=>{const f=await setup();try{for(const headers of [{authorization:'Bearer cos_pat_'+'x'.repeat(43),'x-commerce-profile-id':'foreign'},{origin:'https://foreign.invalid','x-commerce-profile-id':'own-profile','x-commerce-profile-version':'1'}]){expect((await f.app.inject({method:'POST',url:'/v2/warmup/programs',headers,payload:{operationId:id(4),config}})).statusCode).toBe(403);}expect(store.create).not.toHaveBeenCalled();}finally{await f.app.close();}});
});
