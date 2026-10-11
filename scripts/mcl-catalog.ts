import {mclV5Knowledge,mclV5Messages} from './mcl-v5-materials.js';
import {schemas,type Body} from '../packages/contracts/src/index.js';
import {validateOffer} from '../packages/domain/src/catalog/validation.js';
import {createDefaultRemarketingPolicy} from '../packages/domain/src/sales/remarketing.js';
import {salesAgreementRecipeV1,salesAgreementWorkflowV1} from '../packages/domain/src/sales/sales-recipe-v2.js';
import {validateWorkflow} from '../packages/domain/src/sales/workflow.js';

export type MclAssets={pitch:string;agreement:string;collection:string;followup1:string;followup2:string;mockup:string;calendar:string;core:string;kit:string};
export type EditorialMessages={messages:{id:string;text:string}[]};
export type SellerConfig={model:string;max_cost_minor:number;input_cost_per_million_minor:number;output_cost_per_million_minor:number};

export const mclSalesCopy={
 agreement:"Escenario sintético: confirmar el acuerdo de prueba con SÍ, LO QUIERO.",
 payment:"Escenario sintético: las instrucciones se resuelven desde el perfil protegido. {{bank_instructions}}",
 thanks:"Respuesta de prueba: consultar el recurso sintético solicitado; pedir revisión humana si falta evidencia. No confirma entregas ni pagos.",
} as const;

export function mclWorkflow(assets:MclAssets,messages:EditorialMessages){
 const message=(id:string)=>{const text=messages.messages.find(m=>m.id===id)?.text;if(!text)throw new Error('EDITORIAL_MESSAGE_MISSING_'+id);return text;};
 const flow=salesAgreementWorkflowV1({presentation_audio_id:assets.pitch,pack_image_id:assets.mockup,agreement_audio_id:assets.agreement,collection_audio_id:assets.collection},{
  offer:message('WA07_OFERTA'),
  ...mclSalesCopy,
 });
 const commitment=flow.nodes.find(node=>node.id==='commitment');
 if(commitment)commitment.config.accepted_phrases=[...commitment.config.accepted_phrases,'sí, quiero mi ciclo listo'];
 // Access codes and bank details are rendered by protected adapters, never
 // inserted into the public workflow or the seller knowledge.
 for(const node of flow.nodes){const text=JSON.stringify(node.config);if(/\{\{(?!bank_instructions\}\})[^}]+\}\}/.test(text))throw new Error('UNRESOLVED_PUBLIC_WORKFLOW_VARIABLE_'+node.id);}
 const validation=validateWorkflow(flow);if(!validation.valid)throw new Error('MCL_WORKFLOW_INVALID');return {...flow,message_library:mclV5Messages(messages.messages).map(({id,text})=>({id,text:text.replace(/\{\{(?:CLABE_ARCUS|TITULAR|TARJETA_SPIN|DATOS_BANCARIOS|BANK_INSTRUCTIONS|DATOS_DE_PAGO)\}\}/g,'[dato bancario protegido]').replace(/\{\{CODIGO_(CORE|KIT)\}\}/g,'[acceso protegido]')}))};
}
export function mclOffer(ids:{pitch:string;agreement:string;collection:string;mockup:string;core:string;calendar:string;kit:string;bank:string;policy:string;workflow:string;agent:string;followup1:string;followup2:string;pdfs:string[]},messages?:EditorialMessages){
 if(ids.pdfs.length!==9||new Set(ids.pdfs).size!==9)throw new Error('MCL_NINE_DIRECT_PDFS_REQUIRED');
 const stage=(asset_id:string,text:string)=>({medium:'audio' as const,asset_id,text});
 const remarketing=createDefaultRemarketingPolicy([
  {awaiting_agreement:stage(ids.followup1,"Escenario sintético: confirmar el acuerdo de prueba con SÍ, LO QUIERO."),awaiting_payment:stage(ids.followup2,"Escenario sintético: las instrucciones se resuelven desde el perfil protegido. {{bank_instructions}}")},
  {awaiting_agreement:stage(ids.followup1,"Escenario sintético: confirmar el acuerdo de prueba con SÍ, LO QUIERO."),awaiting_payment:stage(ids.followup2,"Escenario sintético: las instrucciones se resuelven desde el perfil protegido. {{bank_instructions}}")},
  {awaiting_agreement:stage(ids.followup1,"Respuesta de prueba: consultar el recurso sintético solicitado; pedir revisión humana si falta evidencia. No confirma entregas ni pagos."),awaiting_payment:stage(ids.followup2,"Escenario sintético: las instrucciones se resuelven desde el perfil protegido. {{bank_instructions}}")},
 ]);
 const offerText=messages?.messages.find(message=>message.id==='WA07_OFERTA')?.text??"Respuesta de prueba: consultar el recurso sintético solicitado; pedir revisión humana si falta evidencia. No confirma entregas ni pagos.";
 const offer=schemas.offer!.parse({name:'Mi Ciclo Listo · Acuerdo · 480 actividades y regalos Premium',currency:'MXN',base_amount_minor:9700,payment_profile_version_id:ids.bank,receipt_policy_version_id:ids.policy,workflow_version_id:ids.workflow,agent_version_id:ids.agent,billing_delay_seconds:0,positive_payment_unlocks_all:true,fulfillment:[{asset_id:ids.core,release_on:'commitment_accepted'},...ids.pdfs.map(asset_id=>({asset_id,release_on:'commitment_accepted'})),{asset_id:ids.calendar,release_on:'receipt_approved'},{asset_id:ids.kit,release_on:'receipt_approved'}],sales_flow:{entry_aliases:['Mi Ciclo Listo','Ciclo Listo','material de preescolar y primaria','actividades para nueve grados'],recipe:salesAgreementRecipeV1(),remarketing,content:{presentation:{audio_asset_id:ids.pitch,pack_image_asset_id:ids.mockup,offer_text:offerText},agreement:{audio_asset_id:ids.agreement,prompt:mclSalesCopy.agreement},collection:{audio_asset_id:ids.collection,payment_instructions:mclSalesCopy.payment},closure:{receipt_thanks:mclSalesCopy.thanks}}}});
 validateOffer(offer);return offer;
}
export function mclSeller(productId:string,knowledge:Body,config?:SellerConfig){
 knowledge=mclV5Knowledge(knowledge);
 if(!config)return schemas.agent!.parse({name:'Asistente sintético',product_id:productId,provider:'workspace',model:null,max_cost_minor:0,max_tokens:500,timeout_ms:15000,knowledge:JSON.stringify({...knowledge,systemPrompt:undefined}),instructions:knowledge.systemPrompt,style:{language:'Español de México',tone:'Amable, claro, respetuoso y breve',length:'brief',goal:'Ayudar desde la oferta publicada y respetar las tres esperas del Método del Acuerdo',handoff:"Respuesta de prueba: consultar el recurso sintético solicitado; pedir revisión humana si falta evidencia. No confirma entregas ni pagos."}});
 if(!config.model||!Number.isInteger(config.max_cost_minor)||config.max_cost_minor<=0||!Number.isFinite(config.input_cost_per_million_minor)||config.input_cost_per_million_minor<=0||!Number.isFinite(config.output_cost_per_million_minor)||config.output_cost_per_million_minor<=0)throw new Error('EXPLICIT_SELLER_MODEL_AND_BUDGET_REQUIRED');
 return schemas.agent!.parse({name:'Asistente sintético',product_id:productId,provider:'openai',...config,max_tokens:500,timeout_ms:15000,knowledge:JSON.stringify({...knowledge,systemPrompt:undefined}),instructions:knowledge.systemPrompt});
}
