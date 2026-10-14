import {createHash} from 'node:crypto';
import {variantDocumentSchema,type VariantDocument,type VariantLocale,type VariantState} from '../../../contracts/src/variants.js';
import {marketCopyReviewFields} from '../../../contracts/src/market-variants.js';
import type {Body} from '../../../contracts/src/index.js';
import {validateWorkflow,type FlowDefinition} from '../sales/workflow.js';
import {salesAgreementRecipeV1,salesAgreementWorkflowV1} from '../sales/sales-recipe-v2.js';

/** V7 F4 pure rules for the variant document. No I/O, no secrets in outputs. */
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
export function variantDocumentHash(document:VariantDocument){return createHash('sha256').update(canonical(variantDocumentSchema.parse(document))).digest('hex');}

/** ISO 4217 minor units from a fixed table, so server and browser agree
 * whatever their ICU data says (MXN stays two decimals as before). */
const zeroDecimals=new Set(['BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','UYI','VND','VUV','XAF','XOF','XPF']);
const threeDecimals=new Set(['BHD','IQD','JOD','KWD','LYD','OMR','TND']);
export function minorDigits(currency:string){return zeroDecimals.has(currency)?0:threeDecimals.has(currency)?3:2;}
export function plainPrice(minor:number,currency:string){const digits=minorDigits(currency);return (minor/10**digits).toFixed(digits);}
export function displayPrice(minor:number,currency:string,language='es-MX'){
 const digits=minorDigits(currency);
 try{return new Intl.NumberFormat(language,{style:'currency',currency,minimumFractionDigits:digits,maximumFractionDigits:digits}).format(minor/10**digits);}
 catch{return `${plainPrice(minor,currency)} ${currency}`;}
}

type Copy={seller:string;instructions:string;offer:string;agreement:string;payment:string;thanks:string;styleLanguage:string;phrases:string[]};
const copies:Record<'es'|'pt'|'en',Copy>={
 es:{seller:'Asesor',styleLanguage:'Responde siempre en español.',
  instructions:'Atiende con claridad y amabilidad. Responde solo con información de la oferta y del conocimiento publicado. Si no sabes algo, pide ayuda a una persona.',
  offer:'¡Hola! Te comparto {{product_name}}. El precio es {{price}} {{currency}}.',
  agreement:'¿Te gustaría continuar? Responde «Sí, acepto» para seguir.',
  payment:'Para completar tu compra, usa estos datos de pago:\n\n{{bank_instructions}}\n\nEnvía aquí tu comprobante cuando lo realices.',
  thanks:'¡Gracias! Recibimos tu pago y te enviamos lo que incluye tu compra.',
  phrases:['sí','sí acepto','sí, acepto','acepto','acepto el acuerdo','de acuerdo','estoy de acuerdo','ok','va','adelante']},
 pt:{seller:'Consultor',styleLanguage:'Responda sempre em português.',
  instructions:'Atenda com clareza e gentileza. Responda apenas com informações da oferta e do conhecimento publicado. Se não souber algo, peça ajuda a uma pessoa.',
  offer:'Olá! Apresento {{product_name}}. O preço é {{price}} {{currency}}.',
  agreement:'Quer continuar? Responda «Sim, aceito» para seguir.',
  payment:'Para concluir sua compra, use estes dados de pagamento:\n\n{{bank_instructions}}\n\nEnvie aqui o comprovante quando pagar.',
  thanks:'Obrigado! Recebemos seu pagamento e enviamos o que está incluído na sua compra.',
  phrases:['sim','sim aceito','sim, aceito','aceito','de acordo','estou de acordo','ok','pode ser','vamos']},
 en:{seller:'Advisor',styleLanguage:'Always answer in English.',
  instructions:'Be clear and friendly. Answer only with information from the offer and the published knowledge. If you do not know something, ask a person for help.',
  offer:'Hi! Here is {{product_name}}. The price is {{price}} {{currency}}.',
  agreement:'Would you like to continue? Reply “Yes, I agree” to go ahead.',
  payment:'To complete your purchase, use these payment details:\n\n{{bank_instructions}}\n\nSend your receipt here once you pay.',
  thanks:'Thank you! We received your payment and are sending what your purchase includes.',
  phrases:['yes','yes i agree','yes, i agree','i agree','agreed','ok','okay','sure','go ahead']},
};
export function languageFamily(language:string):'es'|'pt'|'en'{const base=language.toLowerCase().split('-')[0];return base==='pt'?'pt':base==='en'?'en':'es';}
export function languageName(language:string){
 try{return new Intl.DisplayNames([language],{type:'language'}).of(language)??language;}catch{return language;}
}
export function agreementPhrases(language:string){return [...copies[languageFamily(language)].phrases];}
export function sellerLanguageInstruction(language:string){
 const family=languageFamily(language);return `${copies[family].styleLanguage} (${languageName(language)}, ${language})`;
}

/** A complete starter for RF-17.e: flow base and initial seller, editable. */
export function baseVariantDocument(input:{productName:string;name:string;locale:VariantLocale}):VariantDocument{
 const c=copies[languageFamily(input.locale.language)];
 return variantDocumentSchema.parse({schema_version:1,name:input.name,locale:input.locale,
  sale:{base:'conversation',aliases:[],existing_workflow_id:null,guided:null,
   conversation:{offer_message:c.offer,agreement_message:c.agreement,deliver_before_payment:false,payment_message:c.payment,thanks_message:c.thanks},
   seller:{name:c.seller,instructions:c.instructions,knowledge:'',limits:''}},
  ai:{primary:null,fallback:null},
  offer:{name:input.productName,price_minor:0,tiers:[],fulfillment:[],billing_delay_seconds:1800,positive_payment_unlocks_all:false,legacy:{}},
  collection:{spei:null,links:[],instructions:'',legacy_profile_id:null},
  remarketing:null,pending_review:[]});
}

/** RF-05.b: independent copy for another market. Nothing local is invented:
 * price is a suggestion to review, collection starts empty, no number/campaign
 * relation exists, and every copied text is flagged until reviewed. */
export function duplicateVariantDocument(source:VariantDocument,input:{name:string;locale:VariantLocale}):VariantDocument{
 const copy=structuredClone(variantDocumentSchema.parse(source));
 return variantDocumentSchema.parse({...copy,name:input.name,locale:input.locale,
  collection:{spei:null,links:[],instructions:copy.collection.instructions,legacy_profile_id:null},
  offer:{...copy.offer,legacy:{...copy.offer.legacy,receipt_policy_version_id:undefined}},
  pending_review:[...marketCopyReviewFields]});
}

export interface CollectionPresence {spei:boolean;links:number}
/** Missing items in operator language keys (variantMissingLabels). */
export function variantMissing(document:VariantDocument,collection:CollectionPresence){
 const d=variantDocumentSchema.parse(document),missing:string[]=[];
 if(d.sale.base==='conversation'&&!d.sale.conversation)missing.push('sale_messages');
 if(d.sale.base==='guided'&&!d.sale.guided)missing.push('sale_messages');
 if(!d.sale.seller.name.trim())missing.push('seller');
 if(d.offer.price_minor<=0)missing.push('offer_price');
 if(!d.offer.fulfillment.length)missing.push('materials');
 if(!collection.spei&&collection.links===0&&!d.collection.legacy_profile_id)missing.push('collection');
 for(const field of d.pending_review)missing.push('review_'+field);
 return missing;
}
export function variantState(input:{archived:boolean;published:boolean;missing:readonly string[];selling:boolean}):VariantState{
 if(input.archived)return'ARCHIVED';
 if(input.published&&input.selling)return'SELLING';
 const blocking=input.missing.filter(item=>item!=='publish');
 if(blocking.length===1&&blocking[0]==='collection')return'MISSING_COLLECTION';
 if(blocking.length||!input.published)return'NEEDS_SETUP';
 return'READY_TO_ASSIGN';
}

/** «Venta por conversación»: Oferta → Acuerdo → (Entrega) → Cobro → Comprobante
 * → Agradecimiento → Entrega. The seller answers questions in between. */
export function conversationSaleWorkflow(input:{name:string;language:string;sale:NonNullable<VariantDocument['sale']['conversation']>}):FlowDefinition{
 const s=input.sale,contextual=languageFamily(input.language)==='es';
 const payment=s.payment_message.includes('{{bank_instructions}}')?s.payment_message:`${s.payment_message}\n\n{{bank_instructions}}`;
 const nodes:FlowDefinition['nodes']=[
  {id:'offer',type:'message',config:{text:s.offer_message},next:'agreement'},
  {id:'agreement',type:'message',config:{text:s.agreement_message,remarketing_anchor:'awaiting_agreement'},next:'commitment'},
  {id:'commitment',type:'commitment',config:{...(contextual?{classifier:'contextual_agreement'}:{}),accepted_phrases:agreementPhrases(input.language)},next:s.deliver_before_payment?'core':'bank'},
  ...(s.deliver_before_payment?[{id:'core',type:'fulfillment' as const,config:{release_on:'commitment_accepted'},next:'bank'}]:[]),
  {id:'bank',type:'bank_instructions',config:{text:payment,remarketing_anchor:'awaiting_payment'},next:'receipt'},
  {id:'receipt',type:'receipt',config:{},next:'paid'},
  {id:'paid',type:'message',config:{text:s.thanks_message},next:'post_payment'},
  {id:'post_payment',type:'fulfillment',config:{release_on:'receipt_approved'},next:'end'},
  {id:'end',type:'end',config:{}},
 ];
 const flow:FlowDefinition={name:input.name,entry_node_id:'offer',max_steps:40,nodes};
 const checked=validateWorkflow(flow);if(!checked.valid)throw new Error('VARIANT_FLOW_INVALID');
 return flow;
}

/** Guided 10-step recipe (existing): topology is fixed, copy/media overlay comes
 * from the offer's sales_flow.content at runtime. */
export function guidedSaleWorkflow(input:{name:string;content:NonNullable<VariantDocument['sale']['guided']>}):FlowDefinition{
 const c=input.content,name=input.name;
 const flow=salesAgreementWorkflowV1({presentation_audio_id:c.presentation.audio_asset_id,pack_image_id:c.presentation.pack_image_asset_id,agreement_audio_id:c.agreement.audio_asset_id,collection_audio_id:c.collection.audio_asset_id},
  {offer:c.presentation.offer_text,agreement:c.agreement.prompt,payment:c.collection.payment_instructions,thanks:c.closure.receipt_thanks});
 return{...flow,name};
}

/** Customer-facing payment instructions. SPEI and/or links, in that order. */
export interface CollectionSecret {spei?:{holder:string;clabe:string};links?:{id:string;url:string}[]}
/** The destination a receipt is checked against: the SPEI CLABE and holder of
 * a V7 collection, or the account of a legacy bank profile. A link-only
 * collection has no bank destination (the policy then decides by its rules). */
export function collectionDestination(bank:Body,secret:Body|null):{account_number?:string;holder?:string}{
 if(!secret)return{};
 if(!bank.methods){const legacy=secret as {account_number?:unknown;holder?:unknown};return{...(typeof legacy.account_number==='string'?{account_number:legacy.account_number}:{}),...(typeof legacy.holder==='string'?{holder:legacy.holder}:{})};}
 const spei=secret.spei as {clabe?:unknown;holder?:unknown}|undefined;
 return spei&&typeof spei.clabe==='string'&&typeof spei.holder==='string'?{account_number:spei.clabe,holder:spei.holder}:{};
}
export function collectionInstructions(input:{bank:Body;secret:Body|null;price:string|null;currency:string|null}){
 const b=input.bank,s=input.secret;
 if(!s)return null;
 const amount=input.price!==null?`\n${input.price} ${input.currency??''}`:'';
 // Legacy bank profiles keep their exact historical text.
 if(!b.methods)return `${b.bank} · ${s.holder}\n${s.account_number}\n${s.instructions??''}${amount}`;
 const lines:string[]=[];
 if(s.spei&&typeof s.spei.clabe==='string')lines.push(`${b.spei_bank??b.bank} · ${s.spei.holder}`,`CLABE ${s.spei.clabe}`);
 const labels=new Map<string,string>((Array.isArray(b.methods?.links)?b.methods.links:[]).map((link:Body)=>[String(link.id),String(link.label)]));
 const online={es:'Pago en línea',pt:'Pagamento on-line',en:'Online payment'}[languageFamily(String(b.language??'es'))];
 for(const link of Array.isArray(s.links)?s.links:[])if(typeof link.url==='string')lines.push(`${labels.get(String(link.id))??online}: ${link.url}`);
 if(typeof s.instructions==='string'&&s.instructions.trim())lines.push(s.instructions.trim());
 lines.push(...expectedTextLines(b));
 return lines.join('\n')+amount;
}
/** RF-09.d: what the buyer must write; the receipt rules compare against it. */
function expectedTextLines(b:Body){
 const words=String(b.language??'es').startsWith('pt')?['Referência','Descrição']:String(b.language??'es').startsWith('en')?['Reference','Concept']:['Referencia','Concepto'];
 const lines:string[]=[];
 if(typeof b.expected_reference==='string'&&b.expected_reference.trim())lines.push(`${words[0]}: ${b.expected_reference.trim()}`);
 if(typeof b.expected_concept==='string'&&b.expected_concept.trim())lines.push(`${words[1]}: ${b.expected_concept.trim()}`);
 return lines;
}

/** RF-05.c/RF-08.c/RF-19.b: what the laboratory (or a missing private
 * destination outside REAL) shows instead of payment details: the methods the
 * variant offers, in its language, with placeholders. Never an account number,
 * a holder or a payment link. */
export function simulatedCollectionInstructions(bank:Body|null|undefined,fallbackLanguage?:unknown){
 const language=typeof bank?.language==='string'&&bank.language?bank.language:typeof fallbackLanguage==='string'&&fallbackLanguage?fallbackLanguage:'es';
 // The Spanish head keeps the historical simulator text that existing flows and tests read.
 const t={es:{head:'SIMULACIÓN: instrucciones bancarias de prueba; no efectuar transferencias.',spei:'transferencia SPEI a una CLABE de prueba',link:'enlace de pago de prueba'},
  pt:{head:'SIMULAÇÃO: instruções bancárias de teste; não faça transferências.',spei:'transferência SPEI para uma CLABE de teste',link:'link de pagamento de teste'},
  en:{head:'SIMULATION: test bank instructions; do not make transfers.',spei:'SPEI transfer to a test CLABE',link:'test payment link'}}[languageFamily(language)];
 const lines=[t.head],methods=bank?.methods;
 if(methods&&typeof methods==='object'){
  if(methods.spei===true)lines.push(`${String(bank?.spei_bank??bank?.bank??'SPEI')}: ${t.spei}`);
  for(const link of Array.isArray(methods.links)?methods.links:[])if(link&&typeof link.label==='string')lines.push(`${link.label}: ${t.link}`);
 }
 if(bank)lines.push(...expectedTextLines(bank));
 return lines.join('\n');
}

/** RF-05.c: what the customer reads when a person takes over a question
 * after the agreement, in the language of the variant. */
export function reviewAcknowledgement(language:unknown){
 return{es:'Recibí tu mensaje. Necesito revisar ese punto y te responderé por aquí.',pt:'Recebi sua mensagem. Preciso verificar esse ponto e vou responder por aqui.',
  en:'I got your message. I need to check that point and will reply here.'}[languageFamily(typeof language==='string'&&language?language:'es')];
}

/** The ten-step recipe constant used when the guided base is chosen. */
export function guidedRecipeDefinition(){return salesAgreementRecipeV1();}

/** Three disabled reminders (Remarketing V7 §G): nothing is enabled implicitly. */
export function disabledRemarketingPolicy(){
 const stage={medium:'audio' as const,text:''};
 return{schema_version:1 as const,policy_id:'remarketing-3-slot' as const,policy_revision:1,slots:[
  {id:'slot-1',position:1 as const,enabled:false,delay:{quantity:2,unit:'hours' as const},stages:{awaiting_agreement:{...stage},awaiting_payment:{...stage}}},
  {id:'slot-2',position:2 as const,enabled:false,delay:{quantity:8,unit:'hours' as const},stages:{awaiting_agreement:{...stage},awaiting_payment:{...stage}}},
  {id:'slot-3',position:3 as const,enabled:false,delay:{quantity:24,unit:'hours' as const},stages:{awaiting_agreement:{...stage},awaiting_payment:{...stage}}},
 ]};
}
/** Every material a published variant pins: delivery, guided media, reminders. */
export function variantMaterialIds(document:VariantDocument){
 const d=variantDocumentSchema.parse(document),ids=new Set<string>();
 for(const item of d.offer.fulfillment)ids.add(item.asset_id);
 if(d.offer.legacy.madrina?.core_asset_id)ids.add(d.offer.legacy.madrina.core_asset_id);
 const g=d.sale.guided;if(g)for(const id of [g.presentation.audio_asset_id,g.presentation.pack_image_asset_id,g.agreement.audio_asset_id,g.collection.audio_asset_id])ids.add(id);
 for(const slot of d.remarketing?.slots??[])for(const stage of [slot.stages.awaiting_agreement,slot.stages.awaiting_payment])if(stage.asset_id)ids.add(stage.asset_id);
 return [...ids].sort();
}
