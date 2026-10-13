import {z} from 'zod';

const stableKey=z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const recordId=z.string().uuid();

function canonicalRoutePhrase(value:string):string{
 return value.normalize('NFKC').toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}

const genericRoutePhrases=new Set([
 'si','si lo quiero','lo quiero','quiero','acepto','acepto el acuerdo','de acuerdo','ok','okay','vale','va','adelante',
 'ya pague','pague','pago','pago realizado','transferencia','deposito','comprobante','envio comprobante','adjunto comprobante',
]);

export function isReservedSalesRoutePhrase(value:string):boolean{
 const phrase=canonicalRoutePhrase(value);
 return !phrase||genericRoutePhrases.has(phrase)||/^(?:mxn\s*)?\d+(?:[.,]\d+)?(?:\s*(?:mxn|pesos?))?$/.test(phrase);
}

export const salesRouteAliasSchema=z.string().trim().min(2).max(160)
 .refine(value=>/[\p{L}]/u.test(value),'El alias debe contener letras.')
 .refine(value=>!isReservedSalesRoutePhrase(value),'Usa un nombre o frase de producto; una afirmación, pago o comprobante no identifica el producto.');

export const salesRouteCandidateSchema=z.object({
 product_id:recordId,
 aliases:z.array(salesRouteAliasSchema).min(1).max(30).superRefine((aliases,ctx)=>{
  const seen=new Set<string>();
  for(const[index,alias]of aliases.entries()){
   const canonical=canonicalRoutePhrase(alias);
   if(seen.has(canonical))ctx.addIssue({code:'custom',path:[index],message:'Alias repetido después de normalizar mayúsculas y acentos.'});
   seen.add(canonical);
  }
 }),
}).strict();

export const salesRouteCandidatesSchema=z.array(salesRouteCandidateSchema).min(1).max(100).superRefine((candidates,ctx)=>{
 const seen=new Set<string>();
 for(const[index,candidate]of candidates.entries()){
  if(seen.has(candidate.product_id))ctx.addIssue({code:'custom',path:[index,'product_id'],message:'Producto repetido en los candidatos asignados.'});
  seen.add(candidate.product_id);
 }
});

export type SalesRouteCandidate=z.infer<typeof salesRouteCandidateSchema>;

export const salesRecipeStepKinds=[
 'presentation_audio','pack_image','offer_text','agreement_audio','agreement_prompt',
 'prepayment_fulfillment','collection_audio','payment_instructions','receipt_thanks','postpayment_fulfillment',
] as const;

const recipeStepSchema=z.object({
 order:z.number().int().min(1).max(10),
 id:stableKey,
 kind:z.enum(salesRecipeStepKinds),
 output:z.enum(['audio','image','text','asset_bundle']),
 gate:z.enum(['product_selected','previous_step_confirmed','agreement_accepted','prepayment_delivered','receipt_approved']),
 waits_for:z.enum(['agreement','receipt']).optional(),
 remarketing_anchor:z.enum(['awaiting_agreement','awaiting_payment']).optional(),
}).strict();

const expectedRecipeSteps:[typeof salesRecipeStepKinds[number],z.infer<typeof recipeStepSchema>['output'],z.infer<typeof recipeStepSchema>['gate']][]=[
 ['presentation_audio','audio','product_selected'],
 ['pack_image','image','previous_step_confirmed'],
 ['offer_text','text','previous_step_confirmed'],
 ['agreement_audio','audio','previous_step_confirmed'],
 ['agreement_prompt','text','previous_step_confirmed'],
 ['prepayment_fulfillment','asset_bundle','agreement_accepted'],
 ['collection_audio','audio','prepayment_delivered'],
 ['payment_instructions','text','previous_step_confirmed'],
 ['receipt_thanks','text','receipt_approved'],
 ['postpayment_fulfillment','asset_bundle','previous_step_confirmed'],
];

export const salesRecipeSchema=z.object({
 schema_version:z.literal(1),
 recipe_id:z.literal('sales-agreement-10-step'),
 recipe_revision:z.number().int().positive(),
 acceptance_classifier:z.literal('contextual_agreement'),
 steps:z.array(recipeStepSchema).length(10),
}).strict().superRefine((recipe,ctx)=>{
 const ids=new Set<string>();
 for(const[index,step]of recipe.steps.entries()){
  const expected=expectedRecipeSteps[index];
  if(step.order!==index+1)ctx.addIssue({code:'custom',path:['steps',index,'order'],message:`El paso debe conservar la posición ${index+1}.`});
  if(expected&&(step.kind!==expected[0]||step.output!==expected[1]||step.gate!==expected[2]))ctx.addIssue({code:'custom',path:['steps',index],message:`El paso ${index+1} no corresponde a la receta versionada.`});
  if(ids.has(step.id))ctx.addIssue({code:'custom',path:['steps',index,'id'],message:'ID de paso repetido.'});
  ids.add(step.id);
 }
 if(recipe.steps[4]?.waits_for!=='agreement')ctx.addIssue({code:'custom',path:['steps',4,'waits_for'],message:'El quinto paso debe esperar la aceptación contextual.'});
 if(recipe.steps[4]?.remarketing_anchor!=='awaiting_agreement')ctx.addIssue({code:'custom',path:['steps',4,'remarketing_anchor'],message:'El mensaje de acuerdo debe anclar awaiting_agreement.'});
 if(recipe.steps[7]?.waits_for!=='receipt')ctx.addIssue({code:'custom',path:['steps',7,'waits_for'],message:'Las instrucciones de pago deben esperar el comprobante.'});
 if(recipe.steps[7]?.remarketing_anchor!=='awaiting_payment')ctx.addIssue({code:'custom',path:['steps',7,'remarketing_anchor'],message:'Las instrucciones de pago deben anclar awaiting_payment.'});
});

export type SalesRecipe=z.infer<typeof salesRecipeSchema>;

export const remarketingDurationUnitSchema=z.enum(['minutes','hours','days']);
export const remarketingDurationSchema=z.object({
 quantity:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
 unit:remarketingDurationUnitSchema,
}).strict().superRefine((duration,ctx)=>{
 const multiplier={minutes:60,hours:3600,days:86400}[duration.unit];
 if(!Number.isSafeInteger(duration.quantity*multiplier))ctx.addIssue({code:'custom',path:['quantity'],message:'La demora excede el rango representable en segundos.'});
});

export const remarketingTransportTemplateSchema=z.object({
 name:z.string().trim().min(1).max(512).regex(/^[a-z0-9_]+$/),
 language:z.string().trim().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/),
 header_kind:z.literal('video').default('video'),
 approved:z.literal(true),
}).strict();

export const remarketingStageContentSchema=z.object({
 // V7 F5 (RF-10.b): a reminder may be text only; audio/video still need their asset.
 medium:z.enum(['audio','video','text']),
 asset_id:recordId.optional(),
 text:z.string().trim().max(12000).default(''),
 template:remarketingTransportTemplateSchema.optional(),
}).strict();

export const remarketingSlotSchema=z.object({
 id:stableKey,
 position:z.union([z.literal(1),z.literal(2),z.literal(3)]),
 enabled:z.boolean(),
 warning_acknowledged:z.boolean().optional(),
 delay:remarketingDurationSchema,
 stages:z.object({
  awaiting_agreement:remarketingStageContentSchema,
  awaiting_payment:remarketingStageContentSchema,
 }).strict(),
}).strict();

function durationSeconds(duration:z.infer<typeof remarketingDurationSchema>):number{
 return duration.quantity*{minutes:60,hours:3600,days:86400}[duration.unit];
}

/** V7 F5 (RF-10.d): local hours in which reminders may be sent, in the
 * variant's time zone (filled from the variant at publication). */
export const remarketingWindowSchema=z.object({
 start_hour:z.number().int().min(0).max(23),
 end_hour:z.number().int().min(1).max(24),
 timezone:z.string().min(1).max(64).regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/).optional(),
}).strict().refine(w=>w.start_hour<w.end_hour,'La hora de inicio debe ser anterior a la de fin.');
export const remarketingPolicySchema=z.object({
 schema_version:z.literal(1),
 policy_id:z.literal('remarketing-3-slot'),
 policy_revision:z.number().int().positive(),
 slots:z.array(remarketingSlotSchema).length(3),
 window:remarketingWindowSchema.optional(),
}).strict().superRefine((policy,ctx)=>{
 const ids=new Set<string>();
 let previous=0;
 for(const[index,slot]of policy.slots.entries()){
  if(slot.position!==index+1)ctx.addIssue({code:'custom',path:['slots',index,'position'],message:`La posición debe ser ${index+1}.`});
  if(ids.has(slot.id))ctx.addIssue({code:'custom',path:['slots',index,'id'],message:'Cada recordatorio necesita un ID estable y único.'});
  ids.add(slot.id);
  if(slot.enabled&&slot.position>1&&slot.warning_acknowledged!==true)ctx.addIssue({code:'custom',path:['slots',index,'warning_acknowledged'],message:'Confirma la advertencia antes de activar un segundo o tercer recordatorio.'});
  if(slot.enabled)for(const stage of ['awaiting_agreement','awaiting_payment'] as const){
   if(slot.stages[stage].medium!=='text'&&!slot.stages[stage].asset_id)ctx.addIssue({code:'custom',path:['slots',index,'stages',stage,'asset_id'],message:'El recordatorio activo necesita un audio o video.'});
   if(!slot.stages[stage].text.trim())ctx.addIssue({code:'custom',path:['slots',index,'stages',stage,'text'],message:'El recordatorio activo necesita un texto.'});
  }
  const seconds=durationSeconds(slot.delay);
  if(seconds<=previous)ctx.addIssue({code:'custom',path:['slots',index,'delay'],message:'Las tres demoras deben ser distintas y estrictamente crecientes.'});
  previous=seconds;
 }
});

export type RemarketingDuration=z.infer<typeof remarketingDurationSchema>;
export type RemarketingTransportTemplate=z.infer<typeof remarketingTransportTemplateSchema>;
export type RemarketingStageContent=z.infer<typeof remarketingStageContentSchema>;
export type RemarketingSlot=z.infer<typeof remarketingSlotSchema>;
export type RemarketingPolicy=z.infer<typeof remarketingPolicySchema>;
export type RemarketingWindow=z.infer<typeof remarketingWindowSchema>;

/**
 * Human-editable copy and media for the fixed ten-step recipe. Delivery
 * materials and the seller intentionally stay in the offer's existing
 * `fulfillment` and `agent_version_id` fields so there is only one source of
 * truth for access grants and seller snapshots.
 */
export const salesFlowContentSchema=z.object({
 presentation:z.object({
  audio_asset_id:recordId,
  pack_image_asset_id:recordId,
  offer_text:z.string().trim().min(1).max(12000),
 }).strict(),
 agreement:z.object({
  audio_asset_id:recordId,
  prompt:z.string().trim().min(1).max(12000),
 }).strict(),
 collection:z.object({
  audio_asset_id:recordId,
  payment_instructions:z.string().trim().min(1).max(12000),
 }).strict(),
 closure:z.object({
  receipt_thanks:z.string().trim().min(1).max(12000),
 }).strict(),
}).strict();
export type SalesFlowContent=z.infer<typeof salesFlowContentSchema>;

export const salesFlowConfigurationSchema=z.object({
 entry_aliases:z.array(salesRouteAliasSchema).min(1).max(30),
 recipe:salesRecipeSchema,
 remarketing:remarketingPolicySchema,
 // Optional for historical offer versions created before the guided editor.
 // New guided drafts include it and readiness validates every referenced asset.
 content:salesFlowContentSchema.optional(),
}).strict();
export type SalesFlowConfiguration=z.infer<typeof salesFlowConfigurationSchema>;
