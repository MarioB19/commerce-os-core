import Fastify from 'fastify';
import {describe,expect,it,vi} from 'vitest';
import {ZodError} from 'zod';
import {profileCatalogRoutes} from './profile-catalog.js';
import {type ProfileRequestDependencies} from './profile-request.js';
import {profileCatalogResources} from '../../../packages/contracts/src/profile-catalog.js';
import {listProfileCatalog,listProfileCatalogVersions} from '../../../packages/db/src/profile-catalog.js';
import type {ProfileQuery} from '../../../packages/db/src/profile-context.js';

const id='7dc5bf9c-e921-45b0-9b03-d4a01c1978f7';
function fixture(){
 const query=vi.fn(async(_sql:string,_values?:unknown[])=>({command:'SELECT',rowCount:1,fields:[],oid:0,rows:[{id,workspace_id:'one',environment:'REAL',kind:'product',version:1,body:{name:'Synthetic',secret_ciphertext:'never exposed'},created_at:new Date(0),updated_at:new Date(0)}]}));
 const db={workspaceId:'one',query:query as ProfileQuery};
 const session=vi.fn(async(_session:any,_fence:any,environment:any,_action:any,work:any)=>work({db,environment}));
 const deps:ProfileRequestDependencies={origins:['https://example.invalid'],nativeSession:async()=>({id:'session',userId:'user'}),session,personal:vi.fn(async()=>{throw Object.assign(new Error('DENIED'),{statusCode:401});})};
 return{query,db,session,deps};
}
const headers={'x-commerce-profile-id':'one','x-commerce-profile-version':'1'};
async function appFor(f:ReturnType<typeof fixture>){const app=Fastify();app.setErrorHandler((e:any,_r,reply)=>reply.code(e instanceof ZodError?400:e.statusCode??500).send({error:e.code??'REJECTED'}));await profileCatalogRoutes(app,f.deps);return app;}
describe('profile catalog HTTP and transaction-only repository',()=>{
 it.each(Object.entries(profileCatalogResources))('maps %s to its fixed scope',async(path,entry)=>{
  const f=fixture(),app=await appFor(f);try{const r=await app.inject({url:'/v2/catalog/'+path,headers});expect(r.statusCode).toBe(200);expect(f.session.mock.calls[0]?.[3]).toEqual({scope:entry.scope,mutation:false});expect(f.query.mock.calls[0]).toEqual([expect.stringContaining('workspace_id=$1 AND environment=$2 AND kind=$3'),['one','REAL',entry.kind,false,null,null,51,0]]);expect(r.body).not.toContain('never exposed');expect(r.body).not.toContain('secret_ciphertext');}finally{await app.close();}
 });
 it.each(['workspace_id=two','limit=101','offset=-1','q=','before=2','status=x&unknown=x','environment=REAL&environment=SIMULATION'])('rejects closed list input %s before SQL',async suffix=>{
  const f=fixture(),app=await appFor(f);try{expect((await app.inject({url:'/v2/catalog/products?'+suffix,headers})).statusCode).toBe(400);expect(f.query).not.toHaveBeenCalled();expect(f.session).not.toHaveBeenCalled();}finally{await app.close();}
 });
 it('bounds SQL before materialization and treats search text as a value, not SQL or secret JSON',async()=>{
  const f=fixture();await listProfileCatalog(f.db,'product',{environment:'SIMULATION',limit:2,offset:1,q:"%' OR true --",include_archived:'true',status:'DRAFT'});
  expect(f.query.mock.calls[0]).toEqual([expect.stringContaining('LIMIT $7 OFFSET $8'),['one','SIMULATION','product',true,'DRAFT',"%' OR true --",3,1]]);
  expect(f.query.mock.calls[0]?.[0]).not.toContain('body::text');
 });
 it('returns an existence error before reading history of a missing parent',async()=>{
  const f=fixture();f.query.mockResolvedValueOnce({command:'SELECT',rowCount:0,fields:[],oid:0,rows:[]});await expect(listProfileCatalogVersions(f.db,'product',id,{environment:'REAL',limit:5})).rejects.toMatchObject({statusCode:404});expect(f.query).toHaveBeenCalledTimes(1);
 });
 it('validates detail and historical version scopes and integer bounds',async()=>{
  const f=fixture(),app=await appFor(f);try{
   expect((await app.inject({url:'/v2/catalog/products/'+id+'/versions?environment=SIMULATION&before=3&limit=5',headers})).statusCode).toBe(200);
   expect(f.query.mock.calls[1]).toEqual([expect.stringContaining('r.environment=v.environment AND r.kind=v.kind'),['one','SIMULATION','product',id,3,6]]);
   for(const url of ['/v2/catalog/products/not-an-id','/v2/catalog/products/'+id+'?workspace_id=two','/v2/catalog/products/'+id+'/versions?before=2147483648'])expect((await app.inject({url,headers})).statusCode).toBe(400);
  }finally{await app.close();}
 });
 it('does not release response data when final authority/commit fails',async()=>{
  const f=fixture();f.session.mockImplementationOnce(async(...args:any[])=>{await args[4]({db:f.db,environment:'REAL'});throw Object.assign(new Error('EXPIRED'),{statusCode:401});});const app=await appFor(f);try{const r=await app.inject({url:'/v2/catalog/products',headers});expect(r.statusCode).toBe(401);expect(r.body).not.toContain('Synthetic');}finally{await app.close();}
 });
 it('has no alias for platform resources or profile override on a bearer',async()=>{
  const f=fixture(),app=await appFor(f);try{
   expect((await app.inject({url:'/v2/catalog/service-tokens',headers})).statusCode).toBe(404);
   expect((await app.inject({url:'/v2/catalog/products',headers:{...headers,authorization:'Bearer cos_pat_'+'s'.repeat(43)}})).statusCode).toBe(403);expect(f.query).not.toHaveBeenCalled();
  }finally{await app.close();}
 });
});
