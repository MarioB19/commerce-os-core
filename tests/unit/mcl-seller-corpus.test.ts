import {mclV5Knowledge,mclV5Messages} from '../../scripts/mcl-v5-materials.js';
import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {mclOffer,mclSeller,mclWorkflow,type MclAssets} from '../../scripts/mcl-catalog.js';
import {buildSellerSnapshot,composeSellerContext,deterministicSellerReply,proposalGroundingIssue,sellerInstructions} from '../../packages/domain/src/sales/seller-context.js';
import {parseProposal} from '../../packages/domain/src/sales/ai.js';
import {acceptsAgreement} from '../../packages/domain/src/sales/agreement.js';
import type {Body,DomainRecord} from '../../packages/contracts/src/index.js';
const load=(name:string)=>JSON.parse(readFileSync(new URL('../fixtures/mcl/'+name,import.meta.url),'utf8'));
const knowledge=mclV5Knowledge(load('seller-knowledge.json')),corpus=load('vendedor-corpus.json'),messages=load('wa-mensajes.json');
const ids=Object.fromEntries(['product','pitch','agreement','collection','followup1','followup2','mockup','core','kit','calendar','bank','policy','workflow','agent'].map((key,i)=>[key,`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`]));
const record=(kind:string,id:string,body:Body)=>({id,kind,body,version:1,workspace_id:'synthetic-corpus',environment:'SIMULATION',created_at:'2026-09-13T00:00:00Z',updated_at:'2026-09-13T00:00:00Z'} as DomainRecord);
const offer=mclOffer({...ids,pdfs:Array.from({length:9},(_,index)=>`00000000-0000-4000-8000-${String(index+50).padStart(12,'0')}`)} as Parameters<typeof mclOffer>[0]),flow=mclWorkflow(ids as unknown as MclAssets,messages),agent=mclSeller(ids.product!,knowledge);
const snapshot=buildSellerSnapshot({product:record('product',ids.product!,{name:knowledge.productName,description:'480 actividades: 360 de preescolar y 120 de primaria; nueve grados, 20 por grado de primaria. Un Core y ocho bonos.'}),offer:record('offer',ids.workflow!,offer),agent:record('agent',ids.agent!,agent)});
describe('28 supplied corpus cases: deterministic context and tool contracts, not a real model evaluation',()=>{
 it('answers the three documented support questions after the agreement from approved sources',()=>{
  for(const question of ['¿Dónde están los PDF?','El portal no abre','¿Cómo pago después de revisar?']){
   const context=composeSellerContext(snapshot,{text:question,stage:'COMMITTED'});
   const response=deterministicSellerReply(context);
   expect(response.reason).toBe('APPROVED_SOURCE');
   expect(proposalGroundingIssue(response.proposal,context)).toBeUndefined();
  }
 });
 it('preserves every published FAQ and rule beyond the old single-source cutoff',()=>{
  expect(corpus.cases).toHaveLength(28);expect(snapshot.conflicts).toEqual([]);
  for(const question of knowledge.faq)expect(snapshot.sources.some(s=>s.title===question.question&&s.content.includes(question.answer))).toBe(true);
  for(const [key,text]of Object.entries(knowledge.rules))expect(snapshot.sources.some(s=>s.title===key&&s.content===text)).toBe(true);
  expect(snapshot.agent.model).toBeNull();expect(sellerInstructions(snapshot)).toContain('humano');expect(agent.knowledge).not.toMatch(/patrocin|beneficiari|madrina/i);
  expect(JSON.stringify(mclV5Messages(messages.messages))).not.toMatch(/\b107\b|madrina|patrocin|beneficiari|umbral/i);
 });
 for(const test of corpus.cases)it(test.id+' '+test.input,()=>{
  const context=composeSellerContext(snapshot,{text:test.input,stage:test.state,variables:{nivel:test.context.level,grado:test.context.grade},order:{receipt_status:test.state==='receipt_pending'?'PENDING':'NONE'},history:[{role:'customer',text:'código: PRIVATE-SYNTHETIC-SENTINEL'}]});
  expect(context.customer_text).toBe(test.input);expect(context.stage).toBe(test.state);expect(context.conflicts).toEqual([]);
  expect(context.offer).toMatchObject({base_amount_minor:9700,billing_delay_seconds:0,positive_payment_unlocks_all:true});expect(context.offer.madrina).toBeUndefined();
  expect(JSON.stringify(context)).not.toContain('PRIVATE-SYNTHETIC-SENTINEL');
  for(const tool of test.prohibitedSideEffects)expect(()=>parseProposal({reply:'Synthetic',intent:'question',confidence:1,tool,grounding:['offer_snapshot']})).toThrow('AI_OUTPUT_INVALID');
  expect(test.result).toBe('PENDIENTE_IA_REAL');
  if(['K13','K14','K15','K16'].includes(test.id)){
   const phrases=flow.nodes.find(n=>n.id==='commitment')!.config.accepted_phrases;
   const accepted=test.state==='agreement_prompt'&&acceptsAgreement(test.input,phrases,true);
   expect(accepted).toBe(test.id==='K13');
  }
  if(test.id==='K28')expect(proposalGroundingIssue({reply:'Por $96 MXN recibes todo',intent:'question',confidence:1,tool:'none',grounding:['offer_snapshot']},context)).toBe('PRICE_CONFLICT');
  if(['K07','K20'].includes(test.id))expect(proposalGroundingIssue({reply:'Tu comprobante aprobado',intent:'receipt',confidence:1,tool:'none',grounding:['offer_snapshot']},context)).toBe('UNVERIFIED_COMMERCIAL_CLAIM');
 });
});
