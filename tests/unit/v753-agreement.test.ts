import {describe,expect,it} from 'vitest';
import {acceptsAgreement,agreementClarification,decideAgreementProposal,screenAgreementReply,unverifiedAgreementClaim} from '../../packages/domain/src/sales/agreement.js';
import {contextualAgreementPhrases} from '../../packages/domain/src/sales/sales-recipe-v2.js';
import {buildSellerSnapshot} from '../../packages/domain/src/sales/seller-context.js';
import type {DomainRecord} from '../../packages/contracts/src/index.js';

/** V7.5.3 F1/F2 (docs/adr-v7-5-3-agreement-group-receipts.md): opción 2. */
const base={intent:'commitment',confidence:0.95,tool:'none',reply:'¡Perfecto! 💛',customerText:'Sí, acepto',language:'es-MX',contextual:true,agreementDelivered:true,orderCommitted:false,controlsClear:true};
describe('V7.5.3 F1: deterministic screen of a reply to the explained agreement',()=>{
 it.each(['Sí, acepto','sí acepto','Va','ok','Okay','Adelante','De acuerdo','Sí, acepto el acuerdo, gracias','Siii','👍','Sí, me comprometo a pagar después de revisarlo','Claro que sí','Dale, mándamelo','Sí lo quiero'])('«%s» is an affirmative',text=>{
  expect(screenAgreementReply(text,'es-MX')).toBe('AFFIRMATIVE');
 });
 it.each([
  ['Sí, soy maestra','OTHER'],['¿Sí?','QUESTION'],['¿Cuánto cuesta?','QUESTION'],['No','NEGATIVE'],['sí, no hay problema','NEGATIVE'],['Sí, pero mañana','CONDITIONAL'],
  ['Si me gusta te pago','CONDITIONAL'],['Ya pagué','PAYMENT_CLAIM'],['Te mando el comprobante','PAYMENT_CLAIM'],['Acepto «el acuerdo»','OTHER'],['','OTHER'],['Sí, quiero el de primaria para mi hija','OTHER'],
 ])('«%s» is %s',(text,expected)=>{expect(screenAgreementReply(text,'es-MX')).toBe(expected);});
 it('other languages are never accepted by this rule; their literal phrases keep working',()=>{
  expect(screenAgreementReply('Yes, I agree','en')).toBe('OTHER');expect(screenAgreementReply('Sim, aceito','pt-BR')).toBe('OTHER');
  expect(acceptsAgreement('yes, i agree',['yes, i agree'],false)).toBe(true);
 });
 it('A01 baseline: «Sí, acepto» is not one of the installed literal phrases (the AI path is required)',()=>{
  expect(acceptsAgreement('Sí, acepto',[...contextualAgreementPhrases],true)).toBe(false);
  expect(acceptsAgreement('ACEPTO EL ACUERDO',[...contextualAgreementPhrases],true)).toBe(true);
 });
});
describe('V7.5.3 F1: model proposal + deterministic rule',()=>{
 it('accepts only a confident commitment proposal for a delivered contextual agreement with an affirmative reply',()=>{
  expect(decideAgreementProposal(base)).toEqual({decision:'ACCEPT',reason:'AI_PROPOSAL_RULE_CONFIRMED'});
  for(const text of ['va','ok','adelante','De acuerdo'])expect(decideAgreementProposal({...base,customerText:text}).decision).toBe('ACCEPT');
 });
 it('asks for clarification and never accepts an ambiguous, conditional, off-topic or low-confidence proposal',()=>{
  expect(decideAgreementProposal({...base,customerText:'Sí, soy maestra'})).toEqual({decision:'CLARIFY',reason:'REPLY_OTHER'});
  expect(decideAgreementProposal({...base,customerText:'¿Y si no me gusta?'})).toEqual({decision:'CLARIFY',reason:'REPLY_QUESTION'});
  expect(decideAgreementProposal({...base,customerText:'Sí pero mañana'})).toEqual({decision:'CLARIFY',reason:'REPLY_CONDITIONAL'});
  expect(decideAgreementProposal({...base,customerText:'no'})).toEqual({decision:'CLARIFY',reason:'REPLY_NEGATIVE'});
  expect(decideAgreementProposal({...base,confidence:0.8})).toEqual({decision:'CLARIFY',reason:'LOW_CONFIDENCE'});
  expect(decideAgreementProposal({...base,confidence:Number.NaN})).toEqual({decision:'CLARIFY',reason:'LOW_CONFIDENCE'});
  expect(decideAgreementProposal({...base,tool:'show_offer'})).toEqual({decision:'CLARIFY',reason:'TOOL_NOT_ALLOWED'});
  // A strict literal contract is never changed by the model.
  expect(decideAgreementProposal({...base,contextual:false})).toEqual({decision:'CLARIFY',reason:'LITERAL_PHRASE_REQUIRED'});
 });
 it('cannot accept before the explained agreement reached transport, after commitment, or under controls',()=>{
  expect(decideAgreementProposal({...base,agreementDelivered:false})).toEqual({decision:'PASS',reason:'AGREEMENT_NOT_DELIVERED'});
  expect(decideAgreementProposal({...base,orderCommitted:true}).decision).toBe('PASS');
  expect(decideAgreementProposal({...base,controlsClear:false}).decision).toBe('PASS');
  expect(decideAgreementProposal({...base,intent:'human_handoff'}).decision).toBe('PASS');
 });
 it('a non-commitment reply that claims a registration or delivery is replaced by a clarification',()=>{
  expect(decideAgreementProposal({...base,intent:'question',reply:'Ya queda registrado tu acuerdo y el sistema te envía ahorita tu material completo y tu acceso al portal'})).toEqual({decision:'CLARIFY',reason:'AGREEMENT_REGISTERED_CLAIM'});
  expect(decideAgreementProposal({...base,intent:'question',reply:'Claro, son actividades por grado 💛',customerText:'¿Sirve para multigrado?'})).toEqual({decision:'PASS',reason:'NOT_AN_AGREEMENT_PROPOSAL'});
 });
});
describe('V7.5.3 F1: replies backed by persisted state',()=>{
 it.each([
  ['Ya queda registrado tu acuerdo y el sistema te envía ahorita tu material completo','AGREEMENT_REGISTERED_CLAIM'],
  ['Listo, registré tu acuerdo 💛','AGREEMENT_REGISTERED_CLAIM'],['Ya te envié tu material','DELIVERY_CLAIM'],['Te mando ahorita el paquete','DELIVERY_CLAIM'],
  ['Tu material va en camino','DELIVERY_CLAIM'],['Tu acceso ya está habilitado','ACCESS_CLAIM'],['Tu pago quedó aprobado','PAYMENT_CLAIM'],
 ])('«%s» is an unverified claim (%s)',(reply,code)=>{expect(unverifiedAgreementClaim(reply)).toBe(code);});
 it.each(['¿Te quedó alguna duda?','Son 1,080 actividades listas para imprimir 💛','Cuando aceptes el acuerdo, el sistema envía el material'])('«%s» makes no claim',reply=>{expect(unverifiedAgreementClaim(reply)).toBeUndefined();});
 it('the clarification never promises a registration or a delivery',()=>{
  for(const lang of ['es-MX','pt-BR','en-US'])expect(unverifiedAgreementClaim(agreementClarification(lang))).toBeUndefined();
  expect(agreementClarification('es-MX','acepto')).toContain('«acepto»');
 });
});
describe('V7.5.3 F4: billing delay seen by the seller',()=>{
 const offer=(body:Record<string,unknown>)=>({id:'00000000-0000-4000-8000-000000000001',kind:'offer',version:1,workspace_id:'synthetic',environment:'SIMULATION',created_at:'2026-11-13T00:00:00Z',updated_at:'2026-11-13T00:00:00Z',body:{currency:'MXN',base_amount_minor:9700,fulfillment:[],...body}} as unknown as DomainRecord);
 it('a guided sale reads no wait even if the variant stores 1800 s; the default flow keeps its delay',()=>{
  expect(buildSellerSnapshot({offer:offer({billing_delay_seconds:1800,sales_flow:{content:{presentation:{}}}})}).offer.billing_delay_seconds).toBe(0);
  expect(buildSellerSnapshot({offer:offer({billing_delay_seconds:1800})}).offer.billing_delay_seconds).toBe(1800);
  expect(buildSellerSnapshot({offer:offer({billing_delay_seconds:1800,sales_flow:{remarketing:{}}})}).offer.billing_delay_seconds).toBe(1800);
 });
});
