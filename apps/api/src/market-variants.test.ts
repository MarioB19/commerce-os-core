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
describe('market HTTP authority and closed mutation boundaries',()=>{
 it.each(['workspace_id=two','environment=OTHER','environment=REAL&environment=SIMULATION',''])('rejects invalid/absent environment query %s before authority or SQL',async query=>{
  const f=fixture(),app=await appFor(f);try{expect((await app.inject({url:'/v2/market/variants/'+id+'?'+query,headers:h})).statusCode).toBe(400);expect(f.session).not.toHaveBeenCalled();expect(f.query).not.toHaveBeenCalled();}finally{await app.close();}
 });
 it.each([{family_id:id,fields,workspace_id:'two'},{family_id:id,fields:{...fields,configuration:{...fields.configuration,verified:true}}},{family_id:id,fields:{...fields,amount_minor:1.5}}])('rejects extra authority/unsafe body before SQL',async payload=>{
  const f=fixture(),app=await appFor(f);try{expect((await app.inject({method:'POST',url:'/v2/market/variants?environment=REAL',headers:h,payload})).statusCode).toBe(400);expect(f.query).not.toHaveBeenCalled();}finally{await app.close();}
 });
 it('uses authenticated actor and fixed scope; SQL operation receipt shares the selected transaction',async()=>{
  const f=fixture(),app=await appFor(f);try{const r=await app.inject({method:'POST',url:'/v2/market/variants?environment=REAL',headers:h,payload:{family_id:id,fields}});expect(r.statusCode).toBe(200);expect(f.session).toHaveBeenCalledTimes(1);expect(f.session.mock.calls[0]?.[3]).toEqual({scope:'variants:write',mutation:true});expect(f.query.mock.calls.some(([sql,args])=>sql.includes('INSERT INTO market_operations')&&args?.[0]==='one'&&args[2]==='actor'&&args[3]===id)).toBe(true);expect(r.headers['cache-control']).toBe('no-store');}finally{await app.close();}
 });
 it('does not return a proposed result when post-write authority or COMMIT fails',async()=>{
  const f=fixture();f.session.mockImplementation(async(...args:any[])=>{await args[4]({db:f.db,profile:f.profile,environment:'REAL'});throw Object.assign(new Error('EXPIRED'),{statusCode:401});});const app=await appFor(f);try{const r=await app.inject({method:'POST',url:'/v2/market/variants?environment=REAL',headers:h,payload:{family_id:id,fields}});expect(r.statusCode).toBe(401);expect(r.body).not.toContain('draft_sha256');}finally{await app.close();}
 });
 it('requires explicit operation key and same-origin cookie authority, never legacy fallback',async()=>{
  const f=fixture(),app=await appFor(f);try{for(const [headers,status]of [[{...h,'idempotency-key':''},400],[{...h,origin:'https://other.invalid'},403],[{...h,'x-commerce-profile-version':'0'},409],[{...h,authorization:'Bearer cos_pat_'+'a'.repeat(43)},403]]as const)expect((await app.inject({method:'POST',url:'/v2/market/variants?environment=REAL',headers,payload:{family_id:id,fields}})).statusCode).toBe(status);expect(f.query).not.toHaveBeenCalled();}finally{await app.close();}
 });
 it('binds every review field once and keeps UUID operation identity canonical',()=>{
  const input={expected_version:1,draft_sha256:'a'.repeat(64),reviewed_fields:[...marketCopyReviewFields]};expect(marketPublishSchema.parse(input)).toEqual(input);
  expect(()=>marketPublishSchema.parse({...input,reviewed_fields:Array(6).fill('language')})).toThrow();expect(()=>marketPublishSchema.parse({...input,draft_sha256:'A'.repeat(64)})).toThrow();expect(marketOperationHeaderSchema.parse(id.toUpperCase())).toBe(id);
 });
});
