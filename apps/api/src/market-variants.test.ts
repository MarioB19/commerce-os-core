import Fastify from 'fastify';
import {describe,expect,it,vi} from 'vitest';
import {ZodError} from 'zod';
import {marketVariantRoutes} from './market-variants.js';
import type {ProfileRequestDependencies} from './profile-request.js';
import type {ProfileQuery} from '../../../packages/db/src/profile-context.js';
import {marketPublishSchema,marketOperationHeaderSchema} from '../../../packages/contracts/src/market-variant-store.js';
import {marketCopyReviewFields} from '../../../packages/contracts/src/market-variants.js';
const id='7dc5bf9c-e921-45b0-9b03-d4a01c1978f7',ref={id,revision:1,sha256:'a'.repeat(64)};
const fields={locale:{market:'México',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'},amount_minor:100,configuration:{offer:ref,flow:ref,seller:ref,collection:ref,remarketing:ref,materials:[]}};
const h={origin:'https://example.invalid','x-commerce-profile-id':'one','x-commerce-profile-version':'1','idempotency-key':id};
function fixture(){
 const row={id,family_id:id,version:1,draft:fields,current_release_id:null,source_release_id:null,release_revision:0};
 const query=vi.fn(async(sql:string,_values?:unknown[])=>({command:'SELECT',rowCount:1,fields:[],oid:0,rows:sql.includes('pg_try_advisory')?[{acquired:true}]:sql.includes('request_hash,result')?[]:[row]}));
 const db={workspaceId:'one',query:query as ProfileQuery},profile={authority:{membership:{userId:'actor'}}};
 const session=vi.fn(async(_s:any,_f:any,environment:any,_action:any,work:any)=>work({db,profile,environment}));
 const deps:ProfileRequestDependencies={origins:['https://example.invalid'],nativeSession:async()=>({id:'session',userId:'actor'}),session,personal:vi.fn(async()=>{throw Object.assign(new Error('DENIED'),{statusCode:401});})};
 return{db,query,profile,session,deps};
}
async function appFor(f:ReturnType<typeof fixture>){const app=Fastify();app.setErrorHandler((e:any,_r,reply)=>reply.code(e instanceof ZodError?400:e.statusCode??500).send({error:e.code??'REJECTED'}));await marketVariantRoutes(app,f.deps);return app;}
describe('published release read (variants_manage.version)',()=>{
 it.each(['workspace_id=two','environment=OTHER','environment=REAL&environment=SIMULATION',''])('rejects invalid/absent environment query %s before authority or SQL',async query=>{
  const f=fixture(),app=await appFor(f);try{expect((await app.inject({url:'/v2/market/releases/'+id+'?'+query,headers:h})).statusCode).toBe(400);expect(f.session).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();}finally{await app.close();}
 });
 it('reads under the fixed variants:read scope of the selected profile',async()=>{
  const f=fixture(),app=await appFor(f);try{await app.inject({url:'/v2/market/releases/'+id+'?environment=REAL',headers:h});expect(f.session).toHaveBeenCalledTimes(1);expect(f.session.mock.calls[0]![3]).toEqual({scope:'variants:read',mutation:false});}finally{await app.close();}
 });
 it.each(['/v2/market/variants','/v2/market/families','/v2/market/variants/copy','/v2/market/variants/'+id+'/draft','/v2/market/variants/'+id+'/releases','/v2/market/operations/'+id,'/v2/market/products/'+id+'/options'])('no longer serves the F4 draft route %s',async url=>{
  const f=fixture(),app=await appFor(f);try{for(const method of ['GET','POST','PUT'] as const)expect((await app.inject({method,url:url+'?environment=REAL',headers:h,...(method==='GET'?{}:{payload:{}})})).statusCode).toBe(404);expect(f.session).not.toHaveBeenCalled();}finally{await app.close();}
 });
 it('keeps UUID operation identity canonical in the shared schemas',()=>{
  const input={expected_version:1,draft_sha256:'a'.repeat(64),reviewed_fields:[...marketCopyReviewFields]};expect(marketPublishSchema.parse(input)).toEqual(input);
  expect(marketOperationHeaderSchema.parse(id.toUpperCase())).toBe(id);
 });
});
