import {afterAll, beforeAll, expect, it} from 'vitest';
import {randomBytes, randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool, putRecord, withTransaction} from '../../packages/db/src/index.js';
import {saveIntegrationSetting} from '../../packages/db/src/integration-settings.js';
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
it('uses the runtime sales configuration resolver for workspace inheritance and exposes no secrets or inference',async()=>{
  const f=await fixture(),account=await record('channel_account',{name:'Synthetic account',provider:'simulator',offer_version_id:f.offer.id});
  const missing=await get(`/v1/channel-accounts/${account.id}/effective-seller`);expect(missing.statusCode).toBe(200);expect(missing.json().data.provider_profile).toMatchObject({configured:false,state:'PROVIDER_PENDING'});
  const secret='synthetic-diagnostic-api-key';
  await withTransaction(c=>saveIntegrationSetting(c,workspace,'SIMULATION','openai:default',{expected_version:0,label:'Synthetic sales profile',enabled:true,config:{model:'gpt-4.1-mini',max_cost_minor:12,base_url:'https://api.openai.com/v1',input_cost_per_million_minor:40,output_cost_per_million_minor:160},secrets:{api_key:secret},clear_secrets:[],reason:'Synthetic diagnostic regression'},'test'));
  const inherited=await get(`/v1/channel-accounts/${account.id}/effective-seller`);expect(inherited.statusCode,inherited.body).toBe(200);
  expect(inherited.json().data).toMatchObject({provider_profile:{configured:true,enabled:true,state:'CONFIGURED_UNEVALUATED',version:1,model:'gpt-4.1-mini',max_cost_minor:12},real_provider_evaluated:false,snapshot:{conflicts:[]}});
  expect(inherited.body).not.toContain(secret);
  const explicit=await record('agent',{...f.agent.body,provider:'openai',model:'explicit-model',max_cost_minor:0});
  const explicitOffer=await record('offer',{...f.offer.body,agent_version_id:explicit.id});
  const explicitAccount=await record('channel_account',{name:'Explicit account',provider:'simulator',offer_version_id:explicitOffer.id});
  const blocked=await get(`/v1/channel-accounts/${explicitAccount.id}/effective-seller`);expect(blocked.json().data.provider_profile).toMatchObject({configured:false,state:'BUDGET_PENDING'});
  expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind='ai_run'",[workspace])).rows[0].n).toBe(0);
  expect((await pool.query('SELECT count(*)::int n FROM operation_authorizations WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
});
