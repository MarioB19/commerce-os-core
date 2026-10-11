import {describe,it,expect} from 'vitest';
import {mclOffer,mclSalesCopy,mclSeller,mclWorkflow,type MclAssets} from '../../scripts/mcl-catalog.js';
import {validateOffer} from '../../packages/domain/src/catalog/validation.js';
import {offerSalesFlowAssetIds,workflowAssetIds} from '../../packages/domain/src/sales/workflow-assets.js';
import {applyMclRelease,compileMclPublicationPlan,mclImportIdempotencyKey,mclPublicationAuthorizationSchema,type MclIdempotencyBinding,type MclImportState} from '../../scripts/import-mi-ciclo-listo.js';
const ids=Object.fromEntries(['pitch','agreement','collection','followup1','followup2','mockup','core','kit','calendar','bank','policy','workflow','agent',...Array.from({length:9},(_,index)=>`pdf${index+1}`)].map((key,i)=>[key,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
const pdfs=Array.from({length:9},(_,index)=>ids[`pdf${index+1}`]!);
const corePdfs=pdfs.map((_,index)=>({sourcePath:`fixture-${index+1}.pdf`,sha256:String((index+1)%10).repeat(64),bytes:100+index}));
describe('Mi Ciclo Listo catalog compiler',()=>{
	 it('keeps import retry keys within the API limit and invalidates every changed approval dimension',()=>{
  const binding:MclIdempotencyBinding={release_sha256:'a'.repeat(64),private_configuration_sha256:'b'.repeat(64),source_sha:'c'.repeat(40),compiler_sha256:'d'.repeat(64),compiled_plan_sha256:'e'.repeat(64),audio_review_sha256:'f'.repeat(64),approval_sha256:'1'.repeat(64)},action='asset:pitch';
  const key=mclImportIdempotencyKey(binding,'REAL',action);
  expect(key).toBe(mclImportIdempotencyKey(binding,'REAL',action));
  const variants=[key,...(Object.keys(binding) as (keyof MclIdempotencyBinding)[]).map((field,index)=>mclImportIdempotencyKey({...binding,[field]:String((index+2)%10).repeat(field==='source_sha'?40:64)},'REAL',action)),mclImportIdempotencyKey(binding,'SIMULATION',action),mclImportIdempotencyKey(binding,'REAL','publish-workflow')];
  expect(new Set(variants).size).toBe(variants.length);
  for(const value of variants){expect(value.length).toBeGreaterThanOrEqual(8);expect(value.length).toBeLessThanOrEqual(160);expect(value).not.toContain(binding.private_configuration_sha256);}
 });
	 it('rejects an approval that does not seal source, compiler, plan and audio review',()=>{
	  const approval={release_sha256:'a'.repeat(64),private_configuration_sha256:'b'.repeat(64),source_sha:'c'.repeat(40),compiler_sha256:'d'.repeat(64),compiled_plan_sha256:'e'.repeat(64),audio_review_sha256:'f'.repeat(64),approved_origin:'https://commerce.example.invalid',approved_by:'Synthetic owner',approved_at:'2026-09-20T12:00:00.000Z',environment:'REAL',catalog_publication_approved:true,review_kind:'HUMAN',reviewed_by:'Synthetic reviewer',portal_verification:'VERIFIED',privacy_verification:'VERIFIED'};
	  expect(mclPublicationAuthorizationSchema.safeParse(approval).success).toBe(true);
	  for(const field of ['source_sha','compiler_sha256','compiled_plan_sha256','audio_review_sha256'] as const){const incomplete:Record<string,unknown>={...approval};delete incomplete[field];expect(mclPublicationAuthorizationSchema.safeParse(incomplete).success).toBe(false);}
	 });
	 it('seals every compiled publication body and changes the plan hash with approved copy',()=>{
	  const messages={messages:Array.from({length:34},(_,index)=>({id:index===0?'WA07_OFERTA':`FIXTURE_${index}`,text:index===0?'Oferta aprobada':'Contenido sintético '+index}))};
	  const media={assets:['pitch','agreement','collection','followup1','followup2','mockup'].map((key,index)=>({key,mime:key==='mockup'?'image/png':'audio/mpeg',sha256:String(index+1).repeat(64),bytes:100+index}))};
	  const release={product:{displayName:'Mi Ciclo Listo',productVersion:'sealed-v1',corePdfs,calendarPdf:{sha256:'9'.repeat(64),bytes:999}},messages,knowledge:{systemPrompt:'Responder desde la oferta aprobada.',faq:[]},media};
	  const first=compileMclPublicationPlan(release),second=compileMclPublicationPlan(structuredClone(release));
	  expect(first.summary).toEqual(second.summary);expect(first.summary.operation_count).toBe(56);expect(first.summary).toMatchObject({account_assignment:false,sending_enabled:false,real_messages:0});
	  expect(first.plan.asset_uploads.filter((asset:{mime_type:string})=>asset.mime_type==='application/pdf')).toHaveLength(10);
	  expect(first.plan.asset_uploads.find((asset:{key:string})=>asset.key==='pdf1')?.name).toMatch(/\.pdf$/);
	  const changed=structuredClone(release);changed.messages.messages[0]!.text='Oferta modificada después de la aprobación';
	  const changedPlan=compileMclPublicationPlan(changed);expect(changedPlan.summary.sha256).not.toBe(first.summary.sha256);expect(changedPlan.summary.component_sha256.workflow).not.toBe(first.summary.component_sha256.workflow);expect(changedPlan.summary.component_sha256.offer).not.toBe(first.summary.component_sha256.offer);
	 });
	 it('rejects a stale replay binding before the first API call',async()=>{
	  const release={product:{displayName:'Mi Ciclo Listo',productVersion:'sealed-v1',corePdfs,calendarPdf:{sha256:'9'.repeat(64),bytes:999}},messages:{messages:Array.from({length:34},(_,index)=>({id:index===0?'WA07_OFERTA':`FIXTURE_${index}`,text:'Contenido sintético '+index}))},knowledge:{systemPrompt:'Responder desde la oferta aprobada.',faq:[]},media:{assets:['pitch','agreement','collection','followup1','followup2','mockup'].map((key,index)=>({key,mime:key==='mockup'?'image/png':'audio/mpeg',sha256:String(index+1).repeat(64),bytes:100+index}))},review:{}} as any;
	  const compiled=compileMclPublicationPlan(release);release.review={release_sha256:'a'.repeat(64),source_sha:'b'.repeat(40),compiler:{sha256:'c'.repeat(64)},compiled_plan:compiled.summary,hashes:{audio_review:'d'.repeat(64)}};
	  const state:MclImportState={release_sha256:release.review.release_sha256,configuration_sha256:'e'.repeat(64),source_sha:release.review.source_sha,compiler_sha256:release.review.compiler.sha256,compiled_plan_sha256:'0'.repeat(64),audio_review_sha256:release.review.hashes.audio_review,approval_sha256:'f'.repeat(64),environment:'REAL',product_id:ids.product,initial_product_version:1,steps:{},status:'PREPARED'};
	  let calls=0;await expect(applyMclRelease(release,state,async()=>{calls++;return{};},async()=>{}, {core:ids.core,kit:ids.kit,bank:ids.bank,policy:ids.policy})).rejects.toThrow('RELEASE_STATE_BINDING_MISMATCH');expect(calls).toBe(0);
	 });
 it('pins the positive-payment commercial contract without tiers or an artificial collection delay',()=>{
 const offer=mclOffer({...ids,pdfs} as Parameters<typeof mclOffer>[0]);expect(offer).toMatchObject({base_amount_minor:9700,billing_delay_seconds:0,agent_version_id:ids.agent,positive_payment_unlocks_all:true});expect(offer.madrina).toBeUndefined();expect(offer.fulfillment).toEqual([{asset_id:ids.core,release_on:'commitment_accepted'},...pdfs.map(asset_id=>({asset_id,release_on:'commitment_accepted'})),{asset_id:ids.calendar,release_on:'receipt_approved'},{asset_id:ids.kit,release_on:'receipt_approved'}]);
  expect(mclSalesCopy.agreement).toContain('SÍ, LO QUIERO');expect(mclSalesCopy.agreement).not.toContain('exactamente');
  expect(offer.sales_flow.entry_aliases).toContain('Mi Ciclo Listo');expect(offer.sales_flow.remarketing.slots.map((slot:{enabled:boolean})=>slot.enabled)).toEqual([true,false,false]);expect(()=>validateOffer(offer)).not.toThrow();
 });
 it('requires nine distinct direct PDF assets in every new offer',()=>{
  expect(()=>mclOffer({...ids,pdfs:[]} as unknown as Parameters<typeof mclOffer>[0])).toThrow('MCL_NINE_DIRECT_PDFS_REQUIRED');
  expect(()=>mclOffer({...ids,pdfs:[...pdfs.slice(0,8),pdfs[0]!]} as unknown as Parameters<typeof mclOffer>[0])).toThrow('MCL_NINE_DIRECT_PDFS_REQUIRED');
 });
 it('compiles the ten-step recipe and keeps protected banking plus all six media refs',()=>{
  const messages={messages:['WA00_ENTRADA','WA06_MOCKUP','WA07_OFERTA','WA08_ACUERDO','WA11_COBRO','WA24_SEGUIMIENTO_1','WA25_SEGUIMIENTO_2'].map(id=>({id,text:id.includes('COBRO')||id.includes('SEGUIMIENTO')?'copy {{DATOS_BANCARIOS}}':'copy '+id}))};
  const offer=mclOffer({...ids,pdfs} as Parameters<typeof mclOffer>[0],messages),flow=mclWorkflow(ids as unknown as MclAssets,messages);expect(workflowAssetIds(flow)).toHaveLength(4);expect(offerSalesFlowAssetIds(offer)).toHaveLength(6);expect(new Set([...workflowAssetIds(flow),...offerSalesFlowAssetIds(offer)]).size).toBe(6);expect(offer.sales_flow.content!.presentation.offer_text).toBe('copy WA07_OFERTA');expect(offer.sales_flow.content!.collection.payment_instructions).toContain('{{bank_instructions}}');expect(flow.nodes.find(n=>n.id==='payment_instructions')!.config.text).toContain('{{bank_instructions}}');expect(flow.nodes.some(n=>n.type==='wait')).toBe(false);expect(flow.recipe_id).toBe('sales-agreement-10-step');
 });
 it('publishes a prepared seller without a provider and validates an optional explicit model separately',()=>{
  const config={model:'model-configured-for-test',max_cost_minor:20,input_cost_per_million_minor:1,output_cost_per_million_minor:2},knowledge={systemPrompt:'Consulta la oferta canónica.',faq:[]};
  expect(mclSeller(ids.agent!,knowledge,config)).toMatchObject({provider:'openai',model:config.model,product_id:ids.agent,max_cost_minor:20});
  expect(mclSeller(ids.agent!,knowledge)).toMatchObject({provider:'workspace',model:null,max_cost_minor:0,instructions:knowledge.systemPrompt});
  expect(()=>mclSeller(ids.agent!,knowledge,{...config,max_cost_minor:0})).toThrow('EXPLICIT_SELLER');expect(()=>mclSeller(ids.agent!,knowledge,{...config,model:''})).toThrow('EXPLICIT_SELLER');
 });
});
