import {describe,expect,it} from 'vitest';
import {baseVariantDocument,duplicateVariantDocument,variantMissing,variantState,conversationSaleWorkflow,collectionInstructions,
 plainPrice,displayPrice,minorDigits,agreementPhrases,sellerLanguageInstruction,variantDocumentHash,variantMaterialIds,disabledRemarketingPolicy} from './variant-document.js';
import {clabeValid,collectionInputSchema,variantDocumentSchema} from '../../../contracts/src/variants.js';
import {remarketingPolicySchema} from '../../../contracts/src/sales-flow.js';
import {validateWorkflow} from '../sales/workflow.js';

const MX={market:'México',country:'MX',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'};
const BR={market:'Brasil',country:'BR',currency:'BRL',language:'pt-BR',timezone:'America/Sao_Paulo'};
const asset='11111111-1111-4111-8111-111111111111';
describe('V7 variant document (RF-05/06/08)',()=>{
 it('starts from a complete base flow and seller in the market language (RF-17.e)',()=>{
  const es=baseVariantDocument({productName:'Curso',name:'México',locale:MX}),pt=baseVariantDocument({productName:'Curso',name:'Brasil',locale:BR});
  expect(es.sale.seller.name).toBe('Asesor');expect(pt.sale.seller.name).toBe('Consultor');
  expect(pt.sale.conversation!.offer_message).toContain('preço');expect(es.sale.conversation!.payment_message).toContain('{{bank_instructions}}');
  expect(variantMissing(es,{spei:false,links:0}).sort()).toEqual(['collection','materials','offer_price']);
  expect(sellerLanguageInstruction('pt-BR')).toContain('português');expect(agreementPhrases('en-US')).toContain('i agree');
 });
 it('builds a valid conversation workflow with remarketing anchors and optional delivery before payment',()=>{
  const d=baseVariantDocument({productName:'Curso',name:'México',locale:MX});
  for(const deliver of [false,true]){
   const flow=conversationSaleWorkflow({name:'Venta',language:'es-MX',sale:{...d.sale.conversation!,deliver_before_payment:deliver}});
   expect(validateWorkflow(flow).valid).toBe(true);
   expect(flow.nodes.find(n=>n.id==='commitment')!.next).toBe(deliver?'core':'bank');
   expect(flow.nodes.find(n=>n.config.remarketing_anchor==='awaiting_agreement')?.id).toBe('agreement');
   expect(flow.nodes.find(n=>n.config.remarketing_anchor==='awaiting_payment')?.type).toBe('bank_instructions');
  }
  const pt=conversationSaleWorkflow({name:'Venda',language:'pt-BR',sale:{...d.sale.conversation!,payment_message:'Pague aqui'}});
  expect(pt.nodes.find(n=>n.id==='commitment')!.config.classifier).toBeUndefined();
  expect(pt.nodes.find(n=>n.id==='bank')!.config.text).toBe('Pague aqui\n\n{{bank_instructions}}');
 });
 it('copies to another market without inventing money, collection or numbers (RF-05.b)',()=>{
  const d=variantDocumentSchema.parse({...baseVariantDocument({productName:'Curso',name:'México',locale:MX}),
   offer:{...baseVariantDocument({productName:'Curso',name:'México',locale:MX}).offer,price_minor:9700,fulfillment:[{asset_id:asset,release_on:'receipt_approved'}]},
   collection:{spei:{bank:'Banco',last4:'1234'},links:[],instructions:'Envía tu comprobante',legacy_profile_id:null}});
  const copy=duplicateVariantDocument(d,{name:'Brasil',locale:BR});
  expect(copy.locale.currency).toBe('BRL');expect(copy.offer.price_minor).toBe(9700);expect(copy.collection.spei).toBeNull();
  expect(copy.pending_review).toEqual(['language','price_currency','collection','flow_seller','remarketing','materials']);
  expect(variantMissing(copy,{spei:false,links:0})).toContain('review_price_currency');
  expect(variantDocumentHash(d)).not.toBe(variantDocumentHash(copy));expect(d.locale.currency).toBe('MXN');
 });
 it('labels states in operator language',()=>{
  expect(variantState({archived:false,published:false,missing:['collection','publish'],selling:false})).toBe('MISSING_COLLECTION');
  expect(variantState({archived:false,published:true,missing:[],selling:false})).toBe('READY_TO_ASSIGN');
  expect(variantState({archived:false,published:true,missing:['offer_price'],selling:true})).toBe('SELLING');
  expect(variantState({archived:false,published:false,missing:['publish'],selling:false})).toBe('NEEDS_SETUP');
  expect(variantState({archived:true,published:true,missing:[],selling:false})).toBe('ARCHIVED');
 });
 it('formats money with each currency minor unit and keeps MXN output unchanged',()=>{
  expect(plainPrice(9700,'MXN')).toBe('97.00');expect(minorDigits('CLP')).toBe(0);expect(plainPrice(9990,'CLP')).toBe('9990');
  expect(plainPrice(4500000,'COP')).toBe('45000.00');expect(displayPrice(4500000,'COP','es-CO')).toMatch(/45\.000/);
 });
 it('validates CLABE check digits and HTTPS payment links (RF-08.a/b)',()=>{
  expect(clabeValid('002180700000000003')).toBe(clabeValid('002180700000000003'));
  const base='01218000011835971';let good='';for(let d=0;d<10;d++)if(clabeValid(base+d))good=base+d;
  expect(good).toHaveLength(18);expect(clabeValid(good.slice(0,17)+((Number(good[17])+1)%10))).toBe(false);
  expect(collectionInputSchema.safeParse({spei:null,links:[{label:'Pago',provider:'stripe',url:'http://pay.example.com'}],instructions:''}).success).toBe(false);
  expect(collectionInputSchema.safeParse({spei:null,links:[{label:'Pago',provider:'stripe',url:'https://user:pw@pay.example.com'}],instructions:''}).success).toBe(false);
  expect(collectionInputSchema.safeParse({spei:{bank:'B',holder:'H',clabe:good.slice(0,6)+' '+good.slice(6)},links:[],instructions:''}).success).toBe(true);
 });
 it('writes SPEI and/or links and keeps the legacy bank text identical',()=>{
  const legacy=collectionInstructions({bank:{bank:'Banco'},secret:{holder:'Titular',account_number:'0001',instructions:'Gracias'},price:'97.00',currency:'MXN'});
  expect(legacy).toBe('Banco · Titular\n0001\nGracias\n97.00 MXN');
  expect(collectionInstructions({bank:{bank:'Banco'},secret:{holder:'Titular',account_number:'0001'},price:null,currency:null})).toBe('Banco · Titular\n0001\n');
  const both=collectionInstructions({bank:{bank:'Banco',spei_bank:'Banco',methods:{spei:true,links:[{id:'l1',label:'Tarjeta'}]}},secret:{spei:{holder:'Titular',clabe:'012345678901234567'},links:[{id:'l1',url:'https://pay.example.com/x'}],instructions:'Envía tu comprobante'},price:'97.00',currency:'MXN'});
  expect(both).toBe('Banco · Titular\nCLABE 012345678901234567\nTarjeta: https://pay.example.com/x\nEnvía tu comprobante\n97.00 MXN');
  const link=collectionInstructions({bank:{bank:'Pago',methods:{spei:false,links:[{id:'l1',label:'Hotmart'}]}},secret:{links:[{id:'l1',url:'https://pay.example.com/y'}]},price:null,currency:null});
  expect(link).toBe('Hotmart: https://pay.example.com/y');
 });
 it('pins every referenced material and keeps reminders disabled by default',()=>{
  expect(remarketingPolicySchema.safeParse(disabledRemarketingPolicy()).success).toBe(true);
  const d=baseVariantDocument({productName:'Curso',name:'México',locale:MX});
  expect(variantMaterialIds({...d,offer:{...d.offer,fulfillment:[{asset_id:asset,release_on:'receipt_approved'},{asset_id:asset,release_on:'commitment_accepted'}]}})).toEqual([asset]);
 });
});
