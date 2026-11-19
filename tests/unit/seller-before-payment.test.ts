import {describe,expect,it} from 'vitest';
import {beforePaymentReply,paymentVerifiedForSeller} from '../../packages/domain/src/sales/before-payment.js';
import type {AgentProposal} from '../../packages/domain/src/sales/ai.js';
import {composeSellerContext,type SellerSnapshot} from '../../packages/domain/src/sales/seller-context.js';

function catalog(product:string):SellerSnapshot {
 const question='Está caro, es mucho';
 return {schema_version:1,product_id:product,offer:{base_amount_minor:9700,currency:'MXN'},agent:{},conflicts:[],sources:[
  {id:product+'-faq',record_id:product,revision:1,source:'Published seller',topic:'faq',title:question,content:question+'\n'+product+' incluye las guías. ¿Te explico qué recibes?'},
 ]};
}
const escalation:AgentProposal={reply:'Lo pasaré a revisión.',intent:'human_handoff',tool:'request_human',confidence:1,grounding:[]};
describe('the seller owns the conversation until its payment is verified',()=>{
 it.each(['Está muy caro','¡Carísimo!','Se sale de mi presupuesto','No me alcanza','Está caro, es mucho'])('uses only the assigned seller answer for %s',text=>{
  for(const product of ['Curso A','Curso B']){
   const context=composeSellerContext(catalog(product),{text});
   const answer=beforePaymentReply(context,escalation,{waitingFor:'commitment'});
   expect(answer).toMatchObject({reason:'APPROVED_FAQ',proposal:{reply:product+' incluye las guías. ¿Te explico qué recibes?',grounding:[product+'-faq'],tool:'none'}});
  }
 });
 it.each([
  [{sale_definition:'receipt_sales_v1',sale_status:'RECOGNIZED',sale_amount_minor:97},true],
  [{sale_definition:'receipt_sales_v1',sale_status:'RECOGNIZED',sale_amount_minor:0},false],
  [{sale_definition:'receipt_sales_v1',receipt_status:'APPROVED',sale_status:'TEST',sale_amount_minor:0},false],
  [{status:'COMMITTED',receipt_status:'HUMAN_REVIEW'},false],[{receipt_status:'APPROVED'},true],[{},false],
 ] as const)('uses authoritative payment facts %j',(order,paid)=>{
  const context=composeSellerContext(catalog('Curso'),{text:'Ya pagué',order});
  expect(paymentVerifiedForSeller(context.order)).toBe(paid);
  expect(beforePaymentReply(context,escalation,{waitingFor:'receipt_approved'})?.reason).toBe(paid?undefined:'PREPAYMENT_CLARIFICATION');
 });
 it('clarifies ambiguous, unsupported or failed proposals and preserves valid answers and opt-out',()=>{
  const context=composeSellerContext(catalog('Taller'),{text:'No está caro, ¿cómo sigo?'});
  const supported:AgentProposal={reply:'Incluye las guías.',intent:'question',tool:'none',confidence:.99,grounding:['Taller-faq']};
  for(const p of [undefined,escalation,{...supported,intent:'unknown'} as const,{...supported,reply:'Son $999 MXN.'},{...supported,reply:'Deposita en la cuenta 00000000000'},{...supported,grounding:['foreign']}]){
   expect(beforePaymentReply(context,p,{waitingFor:'receipt_approved'})?.proposal.reply).toContain('cómo hacer el pago');
  }
  expect(beforePaymentReply(context,supported,{})).toBeUndefined();
  expect(beforePaymentReply({...context,customer_text:'Está muy caro'},{...escalation,intent:'opt_out'},{})).toBeUndefined();
  const pending=composeSellerContext(catalog('Taller'),{text:'No entiendo',order:{receipt_status:'HUMAN_REVIEW'}});
  expect(beforePaymentReply(pending,escalation,{language:'en-US'})?.proposal.reply).toContain('your receipt is being reviewed');
 });
});
