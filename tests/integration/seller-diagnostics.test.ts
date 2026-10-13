import {afterAll, beforeAll, expect, it} from 'vitest';
import {randomBytes, randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool, putRecord} from '../../packages/db/src/index.js';
import type {Body} from '../../packages/contracts/src/index.js';

const workspace='seller-diagnostics-'+randomUUID();
const origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:FastifyInstance,cookie:string;
const record=(kind:string,body:Body)=>putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind,body});
const get=(url:string)=>app.inject({method:'GET',url:url+(url.includes('?')?'&':'?')+'environment=SIMULATION',headers:{origin,cookie}});
beforeAll(async()=>{
  app=await createApp();const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
  await provisionUser({name:'Synthetic diagnostics owner',email,password,workspace_id:workspace,role:'owner'});
  const response=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.211',headers:{origin},payload:{email,password}});
  expect(response.statusCode,response.body).toBe(200);cookie=response.cookies.map(c=>c.name+'='+c.value).join('; ');
});
afterAll(async()=>{await app.close();await pool.end();});
async function fixture(){
  const product=await record('product',{name:'Synthetic product',description:'Grounded product contents'});
  const agent=await record('agent',{name:'Synthetic workspace seller',product_id:product.id,provider:'workspace',model:null,max_cost_minor:0});
  const flow=await record('workflow',{name:'Reusable flow',status:'PUBLISHED',product_id:product.id,agent_version_id:agent.id,entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]});
  const offer=await record('offer',{name:'Published offer',status:'PUBLISHED',product_id:product.id,workflow_version_id:flow.id,agent_version_id:agent.id,base_amount_minor:9700,currency:'MXN',positive_payment_unlocks_all:true});
  return{product,agent,flow,offer};
}
it('resolves the unique published offer referencing a reusable workflow without false product conflicts',async()=>{
  const f=await fixture();await record('offer',{...f.offer.body,status:'DRAFT'});
  const response=await get(`/v1/workflows/${f.flow.id}/seller`);expect(response.statusCode,response.body).toBe(200);
  expect(response.json().data).toMatchObject({agent_version_id:f.agent.id,offer_selection:{state:'SELECTED',source:'UNIQUE_PUBLISHED_OFFER',offer_version_id:f.offer.id},snapshot:{product_id:f.product.id,offer_version_id:f.offer.id,conflicts:[],offer:{base_amount_minor:9700,positive_payment_unlocks_all:true}}});
  expect(response.json().data.snapshot.sources.map((s:Body)=>s.id)).toContain('offer_snapshot');
});
it('requires explicit selection for several offers and rejects unrelated or cross-environment context',async()=>{
  const f=await fixture(),second=await record('offer',{...f.offer.body,name:'Second price',base_amount_minor:19700});
  const ambiguous=await get(`/v1/workflows/${f.flow.id}/seller`);expect(ambiguous.statusCode).toBe(200);
  expect(ambiguous.json().data).toMatchObject({offer_selection:{state:'REQUIRED',reason:'AMBIGUOUS_OFFERS'},snapshot:null});
  expect(ambiguous.json().data.offer_selection.candidates.map((o:Body)=>o.id).sort()).toEqual([f.offer.id,second.id].sort());
  const selected=await get(`/v1/workflows/${f.flow.id}/seller?offer_version_id=${second.id}`);expect(selected.statusCode,selected.body).toBe(200);expect(selected.json().data.snapshot.offer.base_amount_minor).toBe(19700);
  const foreign=await fixture();const invalid=await get(`/v1/workflows/${f.flow.id}/seller?offer_version_id=${foreign.offer.id}`);expect(invalid.statusCode).toBe(409);expect(invalid.json().error.code).toBe('OFFER_WORKFLOW_MISMATCH');
  const realProduct=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'product',body:{name:'Separate environment'}});
  const real=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'offer',body:{name:'Separate environment offer',product_id:realProduct.id,status:'PUBLISHED'}});
  expect((await get(`/v1/workflows/${f.flow.id}/seller?offer_version_id=${real.id}`)).statusCode).toBe(404);
});
it('reports missing offer context without an invented empty commercial snapshot',async()=>{
  const flow=await record('workflow',{name:'Unconfigured flow',entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]});
  const response=await get(`/v1/workflows/${flow.id}/seller`);expect(response.statusCode).toBe(200);
  expect(response.json().data).toMatchObject({offer_selection:{state:'REQUIRED',reason:'NO_PUBLISHED_OFFER',candidates:[]},snapshot:null});
});
it('retains an explicit workflow offer instead of silently selecting a newer reverse reference',async()=>{
  const f=await fixture();const pinned=await record('workflow',{...f.flow.body,offer_version_id:f.offer.id});
  await record('offer',{...f.offer.body,workflow_version_id:pinned.id,base_amount_minor:29700});
  const response=await get(`/v1/workflows/${pinned.id}/seller`);expect(response.statusCode).toBe(200);expect(response.json().data.offer_selection).toMatchObject({source:'WORKFLOW',offer_version_id:f.offer.id});
});
