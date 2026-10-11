import {it,expect,afterAll,vi} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool} from '../../packages/db/src/index.js';
import {CommerceApi} from '../../packages/commerce-client/src/index.js';
import {createCommerceMcp} from '../../apps/commerce-mcp/src/server.js';
import {processCommands} from '../../apps/automation-worker/src/commands.js';
import type {Body} from '../../packages/contracts/src/index.js';
afterAll(async()=>pool.end());
it('launches two approved packages through a dedicated service API and real MCP SDK without Intelligence or UI operations',async()=>{
 const workspace='launch-api-mcp-'+randomUUID(),app=await createApp(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');await provisionUser({name:'Synthetic launch owner',email,password,workspace_id:workspace,role:'owner'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.199',headers:{origin},payload:{email,password}});expect(login.statusCode).toBe(200);const cookie=login.cookies.map(c=>c.name+'='+c.value).join('; ');
 const owner=async(route:string,payload:Body)=>{const r=await app.inject({method:'POST',url:route,payload:{...payload,environment:'SIMULATION'},headers:{origin,cookie,'idempotency-key':randomUUID()}});expect(r.statusCode,r.body).toBe(201);return r.json().data;};
 const scopes=['products:read','products:write','products:publish','offers:read','offers:write','offers:publish','workflows:read','workflows:draft','workflows:publish','assets:read','assets:write','assignments:read','assignments:write','channels:read','simulations:run','sales:read','reports:read'];
 const credential=await owner('/v1/service-tokens',{name:'Dedicated synthetic launch',scopes,allowed_environments:['SIMULATION'],expires_at:new Date(Date.now()+3600000).toISOString()});
 const profileCredential=await owner('/v1/service-tokens',{name:'Only seller profile read',scopes:['integrations:read'],allowed_environments:['SIMULATION'],resource_ids:['openai:default'],expires_at:new Date(Date.now()+3600000).toISOString()});const profileList=await app.inject({method:'GET',url:'/v1/integration-profiles?environment=SIMULATION',headers:{authorization:'Bearer '+profileCredential.token}});expect(profileList.statusCode,profileList.body).toBe(200);expect(profileList.json().data.map((p:Body)=>p.key)).toEqual(['openai:default']);
 const bank=await owner('/v1/bank-profiles',{name:'Approved synthetic payment destination',bank:'Fixture',holder:'Fixture',account_number:'0000',currency:'MXN'}),policy=await owner('/v1/receipt-policies',{name:'Human review only',auto_approve:false});
 const accounts=[];for(const name of ['Approved virtual number 1','Approved virtual number 2'])accounts.push(await owner('/v1/channel-accounts',{name,provider:'simulator'}));
 const routes:string[]=[];vi.stubGlobal('fetch',async(input:string|URL,init:RequestInit)=>{const url=new URL(String(input));if(url.origin!=='https://commerce-fixture.invalid')throw new Error('EXTERNAL_NETWORK_FORBIDDEN');routes.push(url.pathname);const response=await app.inject({method:init.method as any,url:url.pathname+url.search,payload:typeof init.body==='string'?JSON.parse(init.body):undefined,headers:init.headers as Record<string,string>});return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});});
 const api=new CommerceApi('https://commerce-fixture.invalid',credential.token),server=createCommerceMcp(api),client=new Client({name:'launch-proof',version:'5'}),[ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 const call=async(name:string,args:Body)=>{const response=await client.callTool({name,arguments:{environment:'SIMULATION',...args}});expect(response.isError,JSON.stringify(response.content)).not.toBe(true);return (response.structuredContent as Body).data;};
 const post=async(route:string,body:Body,key=randomUUID())=>(await api.request<Body>(route,{method:'POST',body:{...body,environment:'SIMULATION'},idempotencyKey:key})).data;
 try{
  const packages:Body[]=[];
  for(const [label,amount]of [['A',9700],['B',23000]] as const){
   const productKey=randomUUID(),productBody={name:'Approved synthetic product '+label,description:'Team selected package; no research required'};
   const product=await call('catalog_create',{resource:'products',body:productBody,idempotency_key:productKey});expect((await call('catalog_create',{resource:'products',body:productBody,idempotency_key:productKey})).id).toBe(product.id);
   const material=await call('catalog_create',{resource:'assets',body:{name:'Approved final material '+label,kind:'link',url:'https://example.invalid/material-'+label},idempotency_key:randomUUID()});
   const sellerDraft=await call('catalog_create',{resource:'agents',body:{name:'Approved seller '+label,product_id:product.id,provider:'deterministic',model:'deterministic-v1',knowledge:'Approved contents '+label,instructions:'Respect the published offer and human receipt approval.'},idempotency_key:randomUUID()});
   const seller=await call('catalog_transition',{resource:'agents',resource_id:sellerDraft.id,action:'publish',body:{},expected_version:sellerDraft.version,idempotency_key:randomUUID()});
   const offerDraft=await call('catalog_create',{resource:'offers',idempotency_key:randomUUID(),body:{product_id:product.id,name:'Approved offer '+label,currency:'MXN',base_amount_minor:amount,payment_profile_version_id:bank.id,receipt_policy_version_id:policy.id,agent_version_id:seller.id,fulfillment:[{asset_id:material.id,release_on:'receipt_approved'}]}});
   const flowDraft=await call('catalog_create',{resource:'workflows',body:{name:'Approved flow '+label,product_id:product.id,offer_version_id:offerDraft.id,agent_version_id:seller.id,entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]},idempotency_key:randomUUID()});
   expect((await post(`/v1/workflows/${flowDraft.id}/validate`,{})).valid).toBe(true);
   const flow=await call('catalog_transition',{resource:'workflows',resource_id:flowDraft.id,action:'publish',body:{},expected_version:flowDraft.version,idempotency_key:randomUUID()});
   const offerRevision=await post(`/v1/offers/${offerDraft.id}/versions`,{expected_version:offerDraft.version,changes:{workflow_version_id:flow.id}}),offer=await call('catalog_transition',{resource:'offers',resource_id:offerRevision.id,action:'publish',body:{},expected_version:offerRevision.version,idempotency_key:randomUUID()});
   const configured=await call('catalog_update',{resource:'products',resource_id:product.id,body:{workflow_template_version_id:flow.id,agent_version_id:seller.id,asset_ids:[material.id]},expected_version:product.version,idempotency_key:randomUUID()});
   await call('catalog_transition',{resource:'products',resource_id:product.id,action:'publish',body:{},expected_version:configured.version,idempotency_key:randomUUID()});
   const evaluation=await call('workflow_evaluate',{workflow_id:flow.id,body:{expected_version:flow.version},idempotency_key:randomUUID()});expect(evaluation.external_effects).toBe(false);expect(evaluation.provider_evaluation.paid_calls).toBe(0);
   const config=await call('product_configuration',{product_id:product.id});expect(config.configuration_published).toBe(true);expect(config.connections.assigned_accounts).toBe(0);
   packages.push({product,material,seller,flow,offer});
  }
  const mapping=accounts.flatMap(account=>packages.map((p,i)=>({account_id:account.id,product_id:p.product.id,offer_version_id:p.offer.id,workflow_version_id:p.flow.id,agent_version_id:p.seller.id,expected_version:0,entry_rules:[{kind:'keyword',value:i?'quiero b':'quiero a'}],reason:'Approved synthetic mapping from the launch manifest'}))),mappingKey=randomUUID();
  const applied=await call('assignments_apply',{assignments:mapping,idempotency_key:mappingKey});expect(applied).toMatchObject({status:'COMPLETE',succeeded:4,failed:0,external_effects:false});expect(await call('assignments_apply',{assignments:mapping,idempotency_key:mappingKey})).toEqual(applied);
  const inventory=await call('channel_inventory',{});expect(inventory).toHaveLength(2);expect(inventory.every((a:Body)=>a.assignments.length===2)).toBe(true);
  for(const p of packages){expect((await call('assignments_list',{product_id:p.product.id}))).toHaveLength(2);expect((await call('product_configuration',{product_id:p.product.id})).connections.assigned_accounts).toBe(2);const sim=await call('simulation_run',{body:{account_id:accounts[0]!.id,offer_version_id:p.offer.id,workflow_version_id:p.flow.id,contact_name:'Explicit virtual rehearsal'},idempotency_key:randomUUID()});expect(sim.command_id).toBeTruthy();}
  await processCommands(10);
  const orders=await call('catalog_list',{resource:'orders'});expect(orders).toHaveLength(2);expect(new Set(orders.map((o:Body)=>o.product_id)).size).toBe(2);expect(orders.every((o:Body)=>o.commercial_classification==='TEST')).toBe(true);
  for(const p of packages){const result=await call('results_summary',{product_id:p.product.id});expect(result.counts.sales).toBe(0);expect(result.counts.orders).toBe(0);const costs=await call('costs_summary',{product_id:p.product.id});expect(costs.external_calls).toBe(0);expect(costs.coverage.status).toBe('NO_RECORDED_OPERATIONS');}
  const forbidden=await app.inject({method:'POST',url:`/v1/channel-accounts/${accounts[0]!.id}/activate`,headers:{authorization:'Bearer '+credential.token,'idempotency-key':randomUUID()},payload:{environment:'SIMULATION',expected_version:accounts[0]!.version,configuration_version:0,reason:'Scope negative test'}});expect(forbidden.statusCode).toBe(403);
  expect(routes.some(route=>route.includes('/intelligence')||route.includes('/studio'))).toBe(false);expect((await pool.query('SELECT 1 FROM operation_authorizations WHERE workspace_id=$1',[workspace])).rowCount).toBe(0);expect((await pool.query('SELECT 1 FROM outbox WHERE workspace_id=$1',[workspace])).rowCount).toBe(0);
  expect((await app.inject({method:'GET',url:'/v1/assignments?environment=REAL',headers:{authorization:'Bearer '+credential.token}})).statusCode).toBe(403);
 }finally{await client.close();await server.close();vi.unstubAllGlobals();await app.close();}
});
