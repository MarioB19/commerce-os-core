import type {SalesRecipe} from '../../../contracts/src/sales-flow.js';
import type {FlowDefinition,FlowNode} from './workflow.js';

export const SALES_AGREEMENT_RECIPE_ID='sales-agreement-10-step' as const;
export const SALES_AGREEMENT_RECIPE_REVISION=1 as const;

const recipe:SalesRecipe={
 schema_version:1,
 recipe_id:SALES_AGREEMENT_RECIPE_ID,
 recipe_revision:SALES_AGREEMENT_RECIPE_REVISION,
 acceptance_classifier:'contextual_agreement',
 steps:[
  {order:1,id:'presentation_audio',kind:'presentation_audio',output:'audio',gate:'product_selected'},
  {order:2,id:'pack_image',kind:'pack_image',output:'image',gate:'previous_step_confirmed'},
  {order:3,id:'offer_text',kind:'offer_text',output:'text',gate:'previous_step_confirmed'},
  {order:4,id:'agreement_audio',kind:'agreement_audio',output:'audio',gate:'previous_step_confirmed'},
  {order:5,id:'agreement_prompt',kind:'agreement_prompt',output:'text',gate:'previous_step_confirmed',waits_for:'agreement',remarketing_anchor:'awaiting_agreement'},
  {order:6,id:'prepayment_fulfillment',kind:'prepayment_fulfillment',output:'asset_bundle',gate:'agreement_accepted'},
  {order:7,id:'collection_audio',kind:'collection_audio',output:'audio',gate:'prepayment_delivered'},
  {order:8,id:'payment_instructions',kind:'payment_instructions',output:'text',gate:'previous_step_confirmed',waits_for:'receipt',remarketing_anchor:'awaiting_payment'},
  {order:9,id:'receipt_thanks',kind:'receipt_thanks',output:'text',gate:'receipt_approved'},
  {order:10,id:'postpayment_fulfillment',kind:'postpayment_fulfillment',output:'asset_bundle',gate:'previous_step_confirmed'},
 ],
};

export function salesAgreementRecipeV1():SalesRecipe{return structuredClone(recipe);}

export interface SalesAgreementRecipeAssets {
 presentation_audio_id:string;
 pack_image_id:string;
 agreement_audio_id:string;
 collection_audio_id:string;
}

export interface SalesAgreementRecipeCopy {
 offer:string;
 agreement:string;
 payment:string;
 thanks:string;
}

export const contextualAgreementPhrases=[
 'sí','sí lo quiero','sí, lo quiero','lo quiero','acepto','acepto el acuerdo','de acuerdo','estoy de acuerdo','ok','vale','va','adelante','sí, envíamelo','sí, mándamelo',
] as const;

function step(order:number,node:FlowNode):FlowNode{
 return{...node,config:{...node.config,recipe_step:order,recipe_id:SALES_AGREEMENT_RECIPE_ID,recipe_revision:SALES_AGREEMENT_RECIPE_REVISION}};
}

/** Generic, version-pinned recipe. Product copy and protected asset IDs are injected by the offer version. */
export function salesAgreementWorkflowV1(assets:SalesAgreementRecipeAssets,copy:SalesAgreementRecipeCopy):FlowDefinition{
 return{
  name:'Venta directa · acuerdo y entrega · 10 pasos',
  recipe_id:SALES_AGREEMENT_RECIPE_ID,
  recipe_revision:SALES_AGREEMENT_RECIPE_REVISION,
  entry_node_id:'presentation_audio',
  max_steps:40,
  nodes:[
   step(1,{id:'presentation_audio',type:'message',config:{kind:'audio',asset_id:assets.presentation_audio_id},next:'pack_image'}),
   step(2,{id:'pack_image',type:'message',config:{kind:'image',asset_id:assets.pack_image_id,after_previous_confirmed_seconds:0},next:'offer_text'}),
   step(3,{id:'offer_text',type:'message',config:{text:copy.offer,after_previous_confirmed_seconds:0},next:'agreement_audio'}),
   step(4,{id:'agreement_audio',type:'message',config:{kind:'audio',asset_id:assets.agreement_audio_id,after_previous_confirmed_seconds:0},next:'agreement_prompt'}),
   step(5,{id:'agreement_prompt',type:'message',config:{text:copy.agreement,after_previous_confirmed_seconds:0,remarketing_anchor:'awaiting_agreement'},next:'commitment'}),
   {id:'commitment',type:'commitment',config:{classifier:'contextual_agreement',accepted_phrases:[...contextualAgreementPhrases]},next:'prepayment_fulfillment'},
   step(6,{id:'prepayment_fulfillment',type:'fulfillment',config:{release_on:'commitment_accepted',asset_group:'prepayment_all'},next:'collection_audio'}),
   step(7,{id:'collection_audio',type:'message',config:{kind:'audio',asset_id:assets.collection_audio_id,purpose:'collection'},next:'payment_instructions'}),
   step(8,{id:'payment_instructions',type:'bank_instructions',config:{text:copy.payment,remarketing_anchor:'awaiting_payment'},next:'receipt'}),
   {id:'receipt',type:'receipt',config:{},next:'receipt_thanks'},
   step(9,{id:'receipt_thanks',type:'message',config:{text:copy.thanks},next:'postpayment_fulfillment'}),
   step(10,{id:'postpayment_fulfillment',type:'fulfillment',config:{release_on:'receipt_approved',asset_group:'postpayment_all'},next:'end'}),
   {id:'end',type:'end',config:{}},
  ],
 };
}
