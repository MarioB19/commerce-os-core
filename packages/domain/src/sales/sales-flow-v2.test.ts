import {describe,expect,it} from 'vitest';
import {offerSchema,workflowSchema} from '../../../contracts/src/index.js';
import {
 remarketingPolicySchema,
 salesRecipeSchema,
 salesRouteAliasSchema,
 salesRouteCandidatesSchema,
} from '../../../contracts/src/sales-flow.js';
import {classifyContextualAgreement} from './agreement.js';
import {directAgreementWorkflow} from './direct-agreement.js';
import {matchAssignedProductAliases,normalizeProductRouteText} from './product-routing.js';
import {
 createDefaultRemarketingPolicy,
 DEFAULT_REMARKETING_SLOT_IDS,
 enabledRemarketingMaximum,
 normalizeRemarketingDuration,
 normalizeRemarketingPolicy,
 replaceRemarketingDurations,
 setRemarketingSlotEnabled,
 type RemarketingStagesBySlot,
} from './remarketing.js';
import {salesAgreementRecipeV1,salesAgreementWorkflowV1} from './sales-recipe-v2.js';
import {applyOfferSalesFlowContent} from './sales-flow-content.js';
import {validateSalesFlowOfferDraft} from './sales-flow-configuration.js';
import {validateWorkflow} from './workflow.js';

const PRODUCT_COSTURA='00000000-0000-4000-8000-000000000001';
const PRODUCT_CICLO='00000000-0000-4000-8000-000000000002';
const PRODUCT_ASTRO='00000000-0000-4000-8000-000000000003';
const candidates=[
 {product_id:PRODUCT_COSTURA,aliases:['costura','curso de costura','costura creativa']},
 {product_id:PRODUCT_CICLO,aliases:['Mi Ciclo Listo','planeación docente']},
 {product_id:PRODUCT_ASTRO,aliases:['Lémur Astrólogo','astrología']},
];

describe('assigned product alias matching',()=>{
 it.each([
  ['Quiero información de COSTURA, por favor',PRODUCT_COSTURA,'costura'],
  ['¿Me cuentas del curso de costura?',PRODUCT_COSTURA,'curso de costura'],
  ['Necesito planeacion docente para primaria',PRODUCT_CICLO,'planeacion docente'],
  ['Me interesa LEMUR ASTROLOGO.',PRODUCT_ASTRO,'lemur astrologo'],
  ['Sí, quiero Mi-Ciclo-Listo',PRODUCT_CICLO,'mi ciclo listo'],
 ])('matches an assigned alias as a whole phrase: %s',(message,productId,alias)=>{
  const result=matchAssignedProductAliases(message,candidates);
  expect(result).toMatchObject({status:'MATCHED',reason:'EXPLICIT_ALIAS',product_id:productId});
  expect(result.evidence[0]?.aliases).toContain(alias);
 });

 it.each(['costurando','microcostura','mi ciclo listos','astrologicamente'])('does not match a partial word: %s',message=>{
  expect(matchAssignedProductAliases(message,candidates)).toMatchObject({status:'NO_MATCH',reason:'NO_EXPLICIT_ALIAS'});
 });

 it.each(['Sí','SÍ, LO QUIERO','$97 MXN','Ya pagué','Pagué 107 pesos','Adjunto el comprobante','Te envío mi comprobante'])('does not select a product from a generic acceptance, amount or payment: %s',message=>{
  expect(matchAssignedProductAliases(message,candidates)).toMatchObject({status:'NO_MATCH',reason:'GENERIC_OR_PAYMENT_SIGNAL'});
 });

 it('ignores an unsafe configured alias but still honors an explicit product beside an affirmation',()=>{
  expect(matchAssignedProductAliases('sí',[{product_id:PRODUCT_COSTURA,aliases:['sí']}])).toMatchObject({status:'NO_MATCH',reason:'GENERIC_OR_PAYMENT_SIGNAL'});
  expect(matchAssignedProductAliases('Sí, quiero costura',candidates)).toMatchObject({status:'MATCHED',product_id:PRODUCT_COSTURA});
 });

 it.each([
  ['No quiero costura',PRODUCT_COSTURA],
  ['No me interesa el curso de costura',PRODUCT_COSTURA],
  ['Mi Ciclo Listo no; prefiero otra cosa',PRODUCT_CICLO],
 ])('does not select an alias that the customer negates: %s',(message,productId)=>{
  const result=matchAssignedProductAliases(message,candidates);
  expect(result).toMatchObject({status:'NO_MATCH',reason:'NO_EXPLICIT_ALIAS'});
  expect(result.evidence.some(item=>item.product_id===productId)).toBe(false);
 });

 it('keeps a positive alias in another clause while ignoring the negated product',()=>{
  expect(matchAssignedProductAliases('No quiero costura; quiero Mi Ciclo Listo',candidates)).toMatchObject({status:'MATCHED',product_id:PRODUCT_CICLO});
  expect(matchAssignedProductAliases('Costura no, mejor Mi Ciclo Listo',candidates)).toMatchObject({status:'MATCHED',product_id:PRODUCT_CICLO});
 });

 it('returns every conflicting assigned product instead of choosing by length or catalog order',()=>{
  const result=matchAssignedProductAliases('Compara costura con Mi Ciclo Listo',candidates);
  expect(result).toMatchObject({status:'AMBIGUOUS',reason:'CONFLICTING_ALIASES',product_ids:[PRODUCT_COSTURA,PRODUCT_CICLO]});
 });

 it('deduplicates aliases of one product and normalizes accents without mutating candidates',()=>{
  const before=structuredClone(candidates);
  const result=matchAssignedProductAliases('Lémur Astrólogo y astrología',candidates);
  expect(result).toMatchObject({status:'MATCHED',product_id:PRODUCT_ASTRO});
  expect(result.evidence[0]?.aliases).toEqual(['lemur astrologo','astrologia']);
  expect(candidates).toEqual(before);
  expect(normalizeProductRouteText('  EDUCACIÓN—Inicial  ')).toBe('educacion inicial');
 });

 it('validates routing candidates and rejects generic or accent-equivalent duplicate aliases',()=>{
  expect(salesRouteCandidatesSchema.safeParse(candidates).success).toBe(true);
  expect(salesRouteAliasSchema.safeParse('sí').success).toBe(false);
  expect(salesRouteAliasSchema.safeParse('comprobante').success).toBe(false);
  expect(salesRouteAliasSchema.safeParse('$97').success).toBe(false);
  expect(salesRouteCandidatesSchema.safeParse([{product_id:PRODUCT_COSTURA,aliases:['educación','educacion']}]).success).toBe(false);
 });
});

describe('versioned ten-step sales recipe',()=>{
 const assets={
  presentation_audio_id:'presentation-audio',
  pack_image_id:'pack-image',
  agreement_audio_id:'agreement-audio',
  collection_audio_id:'collection-audio',
 };
 const copy={
  offer:'Oferta vigente con precio, contenido y bonos.',
  agreement:'¿Podemos llegar a este acuerdo? Responde SÍ, LO QUIERO.',
  payment:'{{bank_instructions}} Envíame tu comprobante.',
  thanks:'¡Comprobante aprobado! Gracias por cumplir tu palabra.',
 };

 it('publishes an immutable-by-copy recipe with the exact ten ordered steps',()=>{
  const recipe=salesAgreementRecipeV1();
  expect(salesRecipeSchema.safeParse(recipe).success).toBe(true);
  expect(recipe).toMatchObject({schema_version:1,recipe_id:'sales-agreement-10-step',recipe_revision:1,acceptance_classifier:'contextual_agreement'});
  expect(recipe.steps.map(step=>step.kind)).toEqual([
   'presentation_audio','pack_image','offer_text','agreement_audio','agreement_prompt',
   'prepayment_fulfillment','collection_audio','payment_instructions','receipt_thanks','postpayment_fulfillment',
  ]);
  recipe.steps[0]!.id='changed';
  expect(salesAgreementRecipeV1().steps[0]!.id).toBe('presentation_audio');
 });

 it('builds a valid workflow with five uninterrupted initial messages and no artificial wait',()=>{
  const flow=salesAgreementWorkflowV1(assets,copy);
  expect(validateWorkflow(flow)).toEqual({valid:true,errors:[]});
  expect(flow).toMatchObject({recipe_id:'sales-agreement-10-step',recipe_revision:1,entry_node_id:'presentation_audio'});
  expect(flow.nodes.filter(node=>node.config.recipe_step).map(node=>[node.config.recipe_step,node.id,node.type])).toEqual([
   [1,'presentation_audio','message'],[2,'pack_image','message'],[3,'offer_text','message'],[4,'agreement_audio','message'],[5,'agreement_prompt','message'],
   [6,'prepayment_fulfillment','fulfillment'],[7,'collection_audio','message'],[8,'payment_instructions','bank_instructions'],[9,'receipt_thanks','message'],[10,'postpayment_fulfillment','fulfillment'],
  ]);
  expect(flow.nodes.slice(0,5).every(node=>node.type==='message')).toBe(true);
  expect(flow.nodes.some(node=>node.type==='wait'||node.type==='reply')).toBe(false);
  expect(flow.nodes.find(node=>node.id==='commitment')?.config.classifier).toBe('contextual_agreement');
  expect(flow.nodes.find(node=>node.id==='agreement_prompt')?.config.remarketing_anchor).toBe('awaiting_agreement');
  expect(flow.nodes.find(node=>node.id==='payment_instructions')?.config.remarketing_anchor).toBe('awaiting_payment');
  expect(flow.nodes.find(node=>node.id==='prepayment_fulfillment')?.next).toBe('collection_audio');
  expect(flow.nodes.find(node=>node.id==='payment_instructions')?.next).toBe('receipt');
 });

 it('rejects reordered or incomplete recipe snapshots without affecting the legacy direct agreement',()=>{
  const reordered=salesAgreementRecipeV1();
  [reordered.steps[0],reordered.steps[1]]=[reordered.steps[1]!,reordered.steps[0]!];
  expect(salesRecipeSchema.safeParse(reordered).success).toBe(false);
  expect(validateWorkflow(directAgreementWorkflow()).valid).toBe(true);
 });
});

describe('deterministic contextual agreement',()=>{
 it.each(['Sí','sí, lo quiero','LO QUIERO','Acepto el acuerdo','de acuerdo','OK','sí, envíamelo'])('accepts an unambiguous reply only in agreement context: %s',text=>{
  expect(classifyContextualAgreement(text,true)).toBe('ACCEPTED');
  expect(classifyContextualAgreement(text,false)).toBe('NOT_APPLICABLE');
 });
 it.each([
  ['No, gracias','DECLINED'],
  ['¿Sí funciona?','QUESTION'],
  ['Sí, pero primero dime qué incluye','CONDITIONAL'],
  ['Si funciona acepto','CONDITIONAL'],
  ['Ya pagué','PAYMENT_CLAIM'],
  ['Adjunto comprobante','PAYMENT_CLAIM'],
  ['Me dijo “acepto”','UNRESOLVED'],
  ['Tal vez','CONDITIONAL'],
 ])('does not turn a non-acceptance into consent: %s',(text,decision)=>expect(classifyContextualAgreement(text,true)).toBe(decision));
});

const mediaIds=[
 '10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',
 '10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000004',
 '10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000006',
];
const stages:RemarketingStagesBySlot=[
 {awaiting_agreement:{medium:'audio',asset_id:mediaIds[0]!,text:'Recordatorio de acuerdo 1'},awaiting_payment:{medium:'audio',asset_id:mediaIds[1]!,text:'Recordatorio de pago 1'}},
 {awaiting_agreement:{medium:'video',asset_id:mediaIds[2]!,text:'Recordatorio de acuerdo 2'},awaiting_payment:{medium:'audio',asset_id:mediaIds[3]!,text:'Recordatorio de pago 2'}},
 {awaiting_agreement:{medium:'audio',asset_id:mediaIds[4]!,text:'Recordatorio de acuerdo 3'},awaiting_payment:{medium:'video',asset_id:mediaIds[5]!,text:'Recordatorio de pago 3'}},
];

describe('three-slot editable remarketing policy',()=>{
 it('embeds the complete sales_flow snapshot in an offer and recipe metadata in a workflow',()=>{
  const recipe=salesAgreementRecipeV1();
  const remarketing=createDefaultRemarketingPolicy(stages);
  const offer=offerSchema.parse({currency:'MXN',base_amount_minor:9700,sales_flow:{entry_aliases:['Mi Ciclo Listo'],recipe,remarketing}});
  expect(offer.sales_flow).toEqual({entry_aliases:['Mi Ciclo Listo'],recipe,remarketing});
  const flow=salesAgreementWorkflowV1({presentation_audio_id:'a1',pack_image_id:'a2',agreement_audio_id:'a3',collection_audio_id:'a4'},{offer:'Oferta',agreement:'Acuerdo',payment:'Pago',thanks:'Gracias'});
  expect(workflowSchema.safeParse(flow).success).toBe(true);
 });

 it('creates stable 2h/8h/24h defaults with only the first slot active',()=>{
  const policy=createDefaultRemarketingPolicy(stages);
  expect(remarketingPolicySchema.safeParse(policy).success).toBe(true);
  expect(policy.slots.map(slot=>slot.id)).toEqual(DEFAULT_REMARKETING_SLOT_IDS);
  expect(policy.slots.map(slot=>slot.enabled)).toEqual([true,false,false]);
  expect(policy.slots.map(slot=>normalizeRemarketingDuration(slot.delay))).toEqual([7200,28800,86400]);
  expect(enabledRemarketingMaximum(policy)).toBe(1);
  expect(normalizeRemarketingPolicy(policy)).toMatchObject({maximum:1,slots:[{after_seconds:7200},{after_seconds:28800},{after_seconds:86400}]});
 });

 it('recomputes only known derived fields from legacy normalized snapshots',()=>{
  const current=normalizeRemarketingPolicy(createDefaultRemarketingPolicy(stages));
  const legacy={...current,maximum:99,slots:current.slots.map(slot=>({...slot,after_seconds:1}))};
  expect(normalizeRemarketingPolicy(legacy)).toMatchObject({maximum:1,slots:[{after_seconds:7200},{after_seconds:28800},{after_seconds:86400}]});
  expect(()=>normalizeRemarketingPolicy({...legacy,unexpected:true})).toThrow();
  expect(()=>normalizeRemarketingPolicy({...legacy,slots:legacy.slots.map((slot,index)=>index===0?{...slot,unexpected:true}:slot)})).toThrow();
 });

 it('normalizes 45 minutes, 6 hours and 36 hours exactly while preserving slot IDs',()=>{
  const original=createDefaultRemarketingPolicy(stages);
  const edited=replaceRemarketingDurations(original,[{quantity:45,unit:'minutes'},{quantity:6,unit:'hours'},{quantity:36,unit:'hours'}]);
  expect(edited.slots.map(slot=>slot.id)).toEqual(original.slots.map(slot=>slot.id));
  expect(normalizeRemarketingPolicy(edited).slots.map(slot=>slot.after_seconds)).toEqual([2700,21600,129600]);
  expect(enabledRemarketingMaximum(edited)).toBe(1);
  expect(original.slots.map(slot=>normalizeRemarketingDuration(slot.delay))).toEqual([7200,28800,86400]);
 });

 it('derives maximum 0/1/2/3 only from enabled slots, never from edited delays',()=>{
  const initial=createDefaultRemarketingPolicy(stages);
  const zero=setRemarketingSlotEnabled(initial,'remarketing_1',false);
  expect(()=>setRemarketingSlotEnabled(initial,'remarketing_2',true)).toThrow();
  const two=setRemarketingSlotEnabled(setRemarketingSlotEnabled(initial,'remarketing_2',true,true),'remarketing_1',true);
  const three=setRemarketingSlotEnabled(two,'remarketing_3',true,true);
  expect([zero,initial,two,three].map(enabledRemarketingMaximum)).toEqual([0,1,2,3]);
  expect(replaceRemarketingDurations(three,[{quantity:45,unit:'minutes'},{quantity:6,unit:'hours'},{quantity:36,unit:'hours'}]).slots.map(slot=>slot.id)).toEqual(DEFAULT_REMARKETING_SLOT_IDS);
 });

 it.each([
  [[{quantity:0,unit:'minutes'},{quantity:6,unit:'hours'},{quantity:36,unit:'hours'}],'positive'],
  [[{quantity:45,unit:'minutes'},{quantity:45,unit:'minutes'},{quantity:36,unit:'hours'}],'distinct'],
  [[{quantity:8,unit:'hours'},{quantity:2,unit:'hours'},{quantity:24,unit:'hours'}],'increasing'],
 ])('rejects invalid, duplicate or decreasing windows: %s',(durations,_case)=>{
  expect(()=>replaceRemarketingDurations(createDefaultRemarketingPolicy(stages),durations as never)).toThrow();
 });

 it('requires stage-specific audio or video plus non-empty text',()=>{
  const policy=createDefaultRemarketingPolicy(stages);
  const invalidMedium=structuredClone(policy) as any;
  invalidMedium.slots[0].stages.awaiting_agreement.medium='image';
  expect(remarketingPolicySchema.safeParse(invalidMedium).success).toBe(false);
  const missingText=structuredClone(policy) as any;
  missingText.slots[0].stages.awaiting_payment.text=' ';
  expect(remarketingPolicySchema.safeParse(missingText).success).toBe(false);
 });

 it('rejects duplicate IDs, reordered positions and unknown slot edits',()=>{
  const duplicate=structuredClone(createDefaultRemarketingPolicy(stages));
  duplicate.slots[1]!.id=duplicate.slots[0]!.id;
  expect(remarketingPolicySchema.safeParse(duplicate).success).toBe(false);
  const reordered=structuredClone(createDefaultRemarketingPolicy(stages));
  [reordered.slots[0],reordered.slots[1]]=[reordered.slots[1]!,reordered.slots[0]!];
  expect(remarketingPolicySchema.safeParse(reordered).success).toBe(false);
  expect(()=>setRemarketingSlotEnabled(createDefaultRemarketingPolicy(stages),'missing',true)).toThrow('REMARKETING_SLOT_NOT_FOUND');
 });

 it('allows disabled slots to remain incomplete but requires both stage packages when enabled',()=>{
  const policy=createDefaultRemarketingPolicy(stages),draft=structuredClone(policy);
  draft.slots[1]!.stages.awaiting_agreement={medium:'audio',text:''};
  draft.slots[1]!.stages.awaiting_payment={medium:'video',text:''};
  expect(remarketingPolicySchema.safeParse(draft).success).toBe(true);
  draft.slots[1]!.enabled=true;
  expect(remarketingPolicySchema.safeParse(draft).success).toBe(false);
 });

 it('overlays guided offer content onto the matching runtime recipe without mutating history',()=>{
  const base=salesAgreementWorkflowV1({presentation_audio_id:'old-audio',pack_image_id:'old-image',agreement_audio_id:'old-agreement',collection_audio_id:'old-collection'},{offer:'Old offer',agreement:'Old agreement',payment:'Old payment',thanks:'Old thanks'});
  const content={presentation:{audio_asset_id:mediaIds[0]!,pack_image_asset_id:mediaIds[1]!,offer_text:'Nueva oferta'},agreement:{audio_asset_id:mediaIds[2]!,prompt:'Nuevo acuerdo'},collection:{audio_asset_id:mediaIds[3]!,payment_instructions:'Nuevo cobro'},closure:{receipt_thanks:'Nuevo cierre'}};
  const offer=offerSchema.parse({currency:'MXN',base_amount_minor:9700,sales_flow:{entry_aliases:['Mi Ciclo Listo'],recipe:salesAgreementRecipeV1(),remarketing:createDefaultRemarketingPolicy(stages),content}});
  const runtime=applyOfferSalesFlowContent(base,offer);
  expect(runtime.nodes.find(node=>node.config.recipe_step===1)?.config).toMatchObject({asset_id:mediaIds[0],content_source:'offer_sales_flow_v1'});
  expect(runtime.nodes.find(node=>node.config.recipe_step===3)?.config.text).toBe('Nueva oferta');
  expect(runtime.nodes.find(node=>node.config.recipe_step===5)?.config).toMatchObject({text:'Nuevo acuerdo',remarketing_anchor:'awaiting_agreement'});
  expect(runtime.nodes.find(node=>node.config.recipe_step===8)?.config.text).toBe('Nuevo cobro\n\n{{bank_instructions}}');
  expect(runtime.nodes.find(node=>node.config.recipe_step===9)?.config.text).toBe('Nuevo cierre');
  expect(base.nodes.find(node=>node.config.recipe_step===3)?.config.text).toBe('Old offer');
  expect(()=>applyOfferSalesFlowContent({...base,recipe_revision:2},offer)).toThrow('SALES_FLOW_RECIPE_MISMATCH');
  const duplicate=structuredClone(base);duplicate.nodes.find(node=>node.id==='pack_image')!.config.recipe_step=1;
  expect(()=>applyOfferSalesFlowContent(duplicate,offer)).toThrow('SALES_FLOW_RECIPE_TOPOLOGY_MISMATCH');
  const bypass=structuredClone(base);bypass.nodes.find(node=>node.id==='agreement_prompt')!.next='prepayment_fulfillment';
  expect(()=>applyOfferSalesFlowContent(bypass,offer)).toThrow('SALES_FLOW_RECIPE_TOPOLOGY_MISMATCH');
  const futureOffer=structuredClone(offer) as any;futureOffer.sales_flow.recipe.recipe_revision=2;
  expect(()=>applyOfferSalesFlowContent({...base,recipe_revision:2},futureOffer)).toThrow('SALES_FLOW_RECIPE_MISMATCH');
 });

 it('shares complete-offer readiness across web and API while preserving historical configs',()=>{
  const content={presentation:{audio_asset_id:mediaIds[0]!,pack_image_asset_id:mediaIds[1]!,offer_text:'Oferta'},agreement:{audio_asset_id:mediaIds[2]!,prompt:'Acuerdo'},collection:{audio_asset_id:mediaIds[3]!,payment_instructions:'Cobro'},closure:{receipt_thanks:'Gracias'}};
  const flow={entry_aliases:['Mi Ciclo Listo'],recipe:salesAgreementRecipeV1(),remarketing:createDefaultRemarketingPolicy(stages),content};
  const complete={sales_flow:flow,payment_profile_version_id:mediaIds[0],receipt_policy_version_id:mediaIds[1],workflow_version_id:mediaIds[2],agent_version_id:mediaIds[3],fulfillment:[{asset_id:mediaIds[4],release_on:'commitment_accepted'},{asset_id:mediaIds[5],release_on:'receipt_approved'}]};
  expect(validateSalesFlowOfferDraft(complete)).toMatchObject({valid:true,ready:true,maximum:1,issues:[]});
  const missingSeller={...complete,agent_version_id:undefined};
  expect(validateSalesFlowOfferDraft(missingSeller)).toMatchObject({valid:true,ready:false});
  expect(validateSalesFlowOfferDraft(missingSeller).issues.some(issue=>issue.path.join('.')==='agent_version_id')).toBe(true);
  expect(validateSalesFlowOfferDraft({sales_flow:{entry_aliases:['Mi Ciclo Listo'],recipe:salesAgreementRecipeV1(),remarketing:createDefaultRemarketingPolicy(stages)}}).issues.some(issue=>issue.path.join('.')==='sales_flow.content')).toBe(true);
 });
});
