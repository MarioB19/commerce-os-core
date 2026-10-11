import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {retirementFixture} from './platform-retirement-fixture.js';
import {hash,pool,putRecord,withTransaction} from '../../packages/db/src/index.js';
import {advanceWorkflow} from '../../apps/automation-worker/src/workflows.js';
import {createDefaultRemarketingPolicy} from '../../packages/domain/src/sales/remarketing.js';
import {salesAgreementRecipeV1,salesAgreementWorkflowV1} from '../../packages/domain/src/sales/sales-recipe-v2.js';
import {validateSalesFlowOfferDraft} from '../../packages/domain/src/sales/sales-flow-configuration.js';
import {toolDefinitions,toolRequest} from '../../apps/commerce-mcp/src/server.js';
import type {Body,DomainRecord} from '../../packages/contracts/src/index.js';

let fixture:Awaited<ReturnType<typeof retirementFixture>>,product:DomainRecord,workflow:DomainRecord,agent:DomainRecord,bank:DomainRecord,policy:DomainRecord,assets:DomainRecord[],salesFlow:Body,fulfillment:Body[];
const data=(response:any,status=200)=>{expect(response.statusCode,response.body).toBe(status);return response.json().data;};
const create=(kind:string,body:Body)=>putRecord(pool,{workspaceId:fixture.workspace,environment:'SIMULATION',kind,body});

beforeAll(async()=>{
 fixture=await retirementFixture();product=await create('product',{name:'Guided synthetic product',status:'PUBLISHED'});assets=[];
 for(let index=0;index<11;index++)assets.push(await create('asset',{name:`Guided material ${index+1}`,kind:'file',mime_type:index===1?'image/png':index>8?'application/pdf':'audio/mpeg',status:'READY'}));
 bank=await create('bank_profile',{name:'Guided payment profile',currency:'MXN'});policy=await create('receipt_policy',{name:'Guided receipt policy',min_amount_minor:1});agent=await create('agent',{name:'Guided seller',product_id:product.id,status:'PUBLISHED',provider:'deterministic',model:'deterministic-v1'});
 const definition=salesAgreementWorkflowV1({presentation_audio_id:assets[0]!.id,pack_image_id:assets[1]!.id,agreement_audio_id:assets[2]!.id,collection_audio_id:assets[3]!.id},{offer:'Old workflow offer',agreement:'Old workflow agreement',payment:'Old workflow payment',thanks:'Old workflow thanks'});
 workflow=await create('workflow',{...definition,product_id:product.id,status:'PUBLISHED'});
 const stage=(asset_id:string,text:string)=>({medium:'audio' as const,asset_id,text});
 const remarketing=createDefaultRemarketingPolicy([
  {awaiting_agreement:stage(assets[4]!.id,'Agreement reminder one'),awaiting_payment:stage(assets[5]!.id,'Payment reminder one')},
  {awaiting_agreement:stage(assets[4]!.id,'Agreement reminder two'),awaiting_payment:stage(assets[5]!.id,'Payment reminder two')},
  {awaiting_agreement:stage(assets[4]!.id,'Agreement reminder three'),awaiting_payment:stage(assets[5]!.id,'Payment reminder three')},
 ]);
 salesFlow={entry_aliases:['Guided synthetic product'],recipe:salesAgreementRecipeV1(),remarketing,content:{presentation:{audio_asset_id:assets[0]!.id,pack_image_asset_id:assets[1]!.id,offer_text:'Offer governed by the offer snapshot'},agreement:{audio_asset_id:assets[2]!.id,prompt:'Agreement governed by the offer snapshot'},collection:{audio_asset_id:assets[3]!.id,payment_instructions:'Payment governed by the offer snapshot'},closure:{receipt_thanks:'Closing governed by the offer snapshot'}}};
 fulfillment=[{asset_id:assets[9]!.id,release_on:'commitment_accepted'},{asset_id:assets[10]!.id,release_on:'receipt_approved'}];
});
afterAll(async()=>{await fixture.app.close();await pool.end();});

it('validates, autosave-compatible patches and reads the guided offer without publishing or exposing storage details',async()=>{
 const offer=await create('offer',{name:'Guided draft',product_id:product.id,status:'DRAFT',currency:'MXN',base_amount_minor:9700,fulfillment:[]});
 const changes={name:'Guided configured draft',currency:'MXN',base_amount_minor:9700,payment_profile_version_id:bank.id,receipt_policy_version_id:policy.id,workflow_version_id:workflow.id,agent_version_id:agent.id,fulfillment,positive_payment_unlocks_all:true,billing_delay_seconds:0,sales_flow:salesFlow};
 const checked=data(await fixture.call('POST',`/v1/offers/${offer.id}/sales-flow/validate`,{expected_version:offer.version,changes}));expect(checked.validation).toMatchObject({valid:true,ready:true,maximum:1,issues:[]});
 const saved=data(await fixture.call('PATCH',`/v1/offers/${offer.id}/sales-flow`,{expected_version:offer.version,changes}));expect(saved.offer).toMatchObject({version:1,status:'DRAFT',name:'Guided configured draft',source_version_id:offer.id,sales_flow:{content:{presentation:{offer_text:'Offer governed by the offer snapshot'}}}});expect(saved.offer.id).not.toBe(offer.id);expect(saved.validation.ready).toBe(true);
 const read=data(await fixture.call('GET',`/v1/offers/${saved.offer.id}/sales-flow`));expect(read.offer.sales_flow.content.closure.receipt_thanks).toBe('Closing governed by the offer snapshot');expect(JSON.stringify(read)).not.toMatch(/ciphertext|storage_key/);
 expect((await pool.query('SELECT count(*)::int count FROM outbox WHERE workspace_id=$1',[fixture.workspace])).rows[0].count).toBe(0);
});

it('requires offers:read for the new sales-flow reads instead of the legacy products:read fallback',async()=>{
 const offer=await create('offer',{name:'Scoped guided draft',product_id:product.id,status:'DRAFT',currency:'MXN',base_amount_minor:9700,fulfillment:[]});
 const token=randomBytes(32).toString('hex');
 await pool.query("INSERT INTO service_tokens(workspace_id,actor_id,name,token_hash,scopes,expires_at,allowed_environments) VALUES($1,'sales-flow-products-reader','Products reader',$2,$3,now()+interval '1 hour',$4)",[fixture.workspace,hash(token),JSON.stringify(['products:read']),JSON.stringify(['SIMULATION'])]);
 const call=(method:'GET'|'POST',path:string,payload?:Body)=>fixture.app.inject({method,url:path+'?environment=SIMULATION',headers:{authorization:'Bearer '+token},...(payload?{payload:{...payload,environment:'SIMULATION'}}:{})});
 for(const response of [await call('GET',`/v1/offers/${offer.id}/sales-flow`),await call('POST',`/v1/offers/${offer.id}/sales-flow/validate`,{changes:{}})]){
  expect(response.statusCode,response.body).toBe(403);expect(response.json().error.code).toBe('FORBIDDEN');
 }
});

it('requires frequency acknowledgement through Web validation, API and MCP and audits newly activated positions',async()=>{
 const source=await create('offer',{name:'Acknowledgement draft',product_id:product.id,status:'DRAFT',currency:'MXN',base_amount_minor:9700,payment_profile_version_id:bank.id,receipt_policy_version_id:policy.id,workflow_version_id:workflow.id,agent_version_id:agent.id,fulfillment,positive_payment_unlocks_all:true,billing_delay_seconds:0,sales_flow:salesFlow});
 const invalid=structuredClone(salesFlow);invalid.remarketing.slots[1]!.enabled=true;delete invalid.remarketing.slots[1]!.warning_acknowledged;
 const webValidation=validateSalesFlowOfferDraft({...source.body,sales_flow:invalid});expect(webValidation.valid).toBe(false);expect(webValidation.issues.some(issue=>issue.path.join('.').endsWith('slots.1.warning_acknowledged'))).toBe(true);
 const rejected=await fixture.call('POST',`/v1/offers/${source.id}/sales-flow/validate`,{expected_version:source.version,changes:{sales_flow:invalid}});expect(rejected.statusCode,rejected.body).toBe(400);expect(rejected.json().error.details.some((issue:Body)=>String(issue.path).endsWith('slots.1.warning_acknowledged'))).toBe(true);
 expect((toolDefinitions.sales_flow_validate.schema.changes as any).safeParse({sales_flow:invalid}).success).toBe(false);

 const acknowledged=structuredClone(salesFlow);for(const slot of acknowledged.remarketing.slots.filter((item:Body)=>item.position>1)){slot.enabled=true;slot.warning_acknowledged=true;}
 const saved=data(await fixture.call('PATCH',`/v1/offers/${source.id}/sales-flow`,{expected_version:source.version,changes:{sales_flow:acknowledged}}));
 expect(saved.offer.sales_flow.remarketing.slots.slice(1).map((slot:Body)=>slot.warning_acknowledged)).toEqual([true,true]);
 const event=(await pool.query("SELECT payload FROM domain_events WHERE workspace_id=$1 AND event_type='offer.sales_flow_draft_saved' AND aggregate_id=$2",[fixture.workspace,saved.offer.id])).rows[0];
 expect(event.payload.newly_activated_remarketing_slots).toEqual([{position:2,warning_acknowledged:true},{position:3,warning_acknowledged:true}]);
});

it('exposes matching OpenAPI operations and creates an editable offer version through the MCP contract',async()=>{
 const published=await create('offer',{name:'Published guided source',product_id:product.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:9700,payment_profile_version_id:bank.id,receipt_policy_version_id:policy.id,workflow_version_id:workflow.id,agent_version_id:agent.id,fulfillment,positive_payment_unlocks_all:true,billing_delay_seconds:0,sales_flow:salesFlow});
 const mapped=toolRequest('offer_version_create',{offer_id:published.id,expected_version:published.version,changes:{name:'Editable MCP successor'},idempotency_key:'offer-version-integration',environment:'SIMULATION'});
 const createdResponse=await fixture.app.inject({method:mapped.method!,url:mapped.route,headers:{cookie:fixture.cookie,origin:fixture.origin,'idempotency-key':mapped.key!},payload:mapped.body});
 const created=data(createdResponse,201);expect(created).toMatchObject({name:'Editable MCP successor',status:'DRAFT',source_version_id:published.id});
 const spec=(await fixture.app.inject({method:'GET',url:'/v1/openapi.json'})).json();
 const expected:[string,string,string[],string,boolean][]=[
  ['/v1/offers/{id}/sales-flow','get',['offers:read'],'sales_flow_get',false],
  ['/v1/offers/{id}/sales-flow/validate','post',['offers:read'],'sales_flow_validate',false],
  ['/v1/offers/{id}/sales-flow','patch',['offers:write'],'sales_flow_save_draft',true],
  ['/v1/offers/{id}/versions','post',['offers:write'],'offer_version_create',true],
  ['/v1/remarketing-cycles','get',['offers:read','sales:read'],'remarketing_cycles_list',false],
  ['/v1/remarketing-cycles/{id}/reprogram/preview','post',['offers:write','sales:read'],'remarketing_reprogram_preview',false],
  ['/v1/remarketing-cycles/{id}/reprogram','post',['offers:write','assignments:authorize'],'remarketing_reprogram_apply',true],
 ];
 for(const[path,method,scopes,tool,idempotency]of expected){const operation=spec.paths[path][method];expect(operation['x-required-service-scopes']).toEqual(scopes);expect(operation['x-mcp-tool']).toBe(tool);expect(operation.parameters.some((parameter:Body)=>parameter.name==='Idempotency-Key')).toBe(idempotency);}
 expect(JSON.stringify(spec.paths['/v1/offers/{id}/sales-flow'].patch.requestBody)).toContain('warning_acknowledged');
});

it('blocks publication until shared readiness passes and accepts the matching recipe when complete',async()=>{
 const missingContent=await create('offer',{name:'Missing guided content',product_id:product.id,status:'DRAFT',currency:'MXN',base_amount_minor:9700,payment_profile_version_id:bank.id,receipt_policy_version_id:policy.id,workflow_version_id:workflow.id,agent_version_id:agent.id,fulfillment,positive_payment_unlocks_all:true,billing_delay_seconds:0,sales_flow:{entry_aliases:salesFlow.entry_aliases,recipe:salesFlow.recipe,remarketing:salesFlow.remarketing}});
 const contentBlocked=await fixture.call('POST',`/v1/offers/${missingContent.id}/publish`,{expected_version:missingContent.version});expect(contentBlocked.statusCode,contentBlocked.body).toBe(409);expect(contentBlocked.json().error.code).toBe('OFFER_NOT_READY');expect(JSON.stringify(contentBlocked.json())).toContain('presentación, acuerdo, cobro y cierre');
 const incomplete=await create('offer',{name:'Missing seller',product_id:product.id,status:'DRAFT',currency:'MXN',base_amount_minor:9700,payment_profile_version_id:bank.id,receipt_policy_version_id:policy.id,workflow_version_id:workflow.id,fulfillment,positive_payment_unlocks_all:true,billing_delay_seconds:0,sales_flow:salesFlow});
 const blocked=await fixture.call('POST',`/v1/offers/${incomplete.id}/publish`,{expected_version:incomplete.version});expect(blocked.statusCode,blocked.body).toBe(409);expect(blocked.json().error.code).toBe('OFFER_NOT_READY');expect(JSON.stringify(blocked.json())).toContain('vendedor');
 const complete=await create('offer',{...incomplete.body,name:'Complete guided offer',agent_version_id:agent.id});
 const published=data(await fixture.call('POST',`/v1/offers/${complete.id}/publish`,{expected_version:complete.version}));expect(published).toMatchObject({status:'PUBLISHED',sales_flow:{content:{collection:{payment_instructions:'Payment governed by the offer snapshot'}}}});
 const account=await create('channel_account',{name:'Guided simulator',provider:'simulator',status:'WORKING'}),contact=await create('contact',{name:'Guided buyer',identity:'synthetic-guided-buyer'}),conversation=await create('conversation',{account_id:account.id,contact_id:contact.id,product_id:product.id,offer_version_id:published.id,workflow_version_id:workflow.id,agent_version_id:agent.id,status:'OPEN'});
 await withTransaction(client=>advanceWorkflow(client,conversation));
 const effects=(await pool.query('SELECT payload FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY dispatch_sequence',[fixture.workspace,conversation.id])).rows.map(row=>row.payload);
 expect(effects.slice(0,5).map(effect=>[effect.kind,effect.asset_id??effect.text])).toEqual([
  ['audio',assets[0]!.id],['image',assets[1]!.id],['text','Offer governed by the offer snapshot'],['audio',assets[2]!.id],['text','Agreement governed by the offer snapshot'],
 ]);
});
