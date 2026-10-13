import {recordProfileExecutor} from '../../../packages/db/src/profile-record-context.js';
import {withNumberLabEngine,type NumberLabEngineLease} from '../../../packages/db/src/number-lab-engine-runtime.js';
import {captureNewReceiptPolicy} from './receipt-policy.js';
import {acceptsAgreement} from '../../../packages/domain/src/sales/agreement.js';
import {collectionInstructions,plainPrice} from '../../../packages/domain/src/catalog/variant-document.js';
import {nextRemarketingTime,insideRemarketingWindow} from '../../../packages/domain/src/sales/remarketing.js';
import {launchTestOrderFields,activeLaunchTest,approvedBenefitTotal,lockLaunchTestOrderCreation,reconcileNumberFlowTestClassification,assertNumberFlowTestOrder,approvedNumberFlowTestPayment} from '../../../packages/db/src/launch-test-scope.js';
import {classifyEducation,collectionStopReason} from '../../../packages/domain/src/sales/education.js';
import {armConfirmedWait,armFollowups,collectionEligibility,remarketingEligibility} from './workflow-timing.js';
import {canonicalSalesVariable,canonicalSalesVariables} from '../../../packages/domain/src/sales/variables.js';
import {normalizeRemarketingPolicy} from '../../../packages/domain/src/sales/remarketing.js';
import {applyOfferSalesFlowContent} from '../../../packages/domain/src/sales/sales-flow-content.js';
import {firstObservedAttribution} from '../../../packages/db/src/receipt-sales.js';
import {cancelPendingRemarketingForContact,closeRemarketingCycle,getRecord,hash,query,reserveRemarketingAttempt,setRemarketingAttemptStatus,verifiedTemplateCapabilityEvidence,withTransaction,uuid,decrypt,type QueryExecutor} from '@commerce/db';
import {remarketingTransportTemplateSchema,type DomainRecord,type Body} from '@commerce/contracts';
import {defaultSalesWorkflow,newFlowState,waitingCommitmentNode,evaluateCondition,renderMessage,validateWorkflow,type FlowDefinition,type FlowState} from '../../../packages/domain/src/sales/workflow.js';
import {save,event,create,commercialContext,proposeEffect,proposeEffectOutcome,gated,nowFor,cancelCollectionPending,cancelPending} from './shared.js';
import {interruptPendingRecipeEffects} from './recipe-interruptions.js';
const transportConfirmedStatuses=new Set(['SENT','DELIVERED','READ']);
const deliveryConfirmedStatuses=new Set(['DELIVERED','READ']);
export async function ensureOrder(client:QueryExecutor,conversation:DomainRecord):Promise<DomainRecord|undefined>{
 const existing=(await client.query(`SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='order' AND body->>'conversation_id'=$3 LIMIT 1`,[conversation.workspace_id,conversation.environment,conversation.id])).rows[0];if(existing){await assertNumberFlowTestOrder(client,conversation,existing);return existing;}
 await lockLaunchTestOrderCreation(client,conversation.workspace_id,conversation.body.account_id);
 // Another worker may have created the order while this transaction waited.
 const concurrent=(await client.query(`SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='order' AND body->>'conversation_id'=$3 LIMIT 1`,[conversation.workspace_id,conversation.environment,conversation.id])).rows[0];if(concurrent){await assertNumberFlowTestOrder(client,conversation,concurrent);return concurrent;}
 const offer=await getRecord(client,conversation.workspace_id,'offer',conversation.body.offer_version_id??'');if(!offer)return undefined;
 const testFields=await launchTestOrderFields(client,conversation);
 let order=await create(client,conversation,'order',{...testFields,physical_chat_id:conversation.body.physical_chat_id,assignment_id:conversation.body.assignment_id,assignment_revision:conversation.body.assignment_revision,binding_id:conversation.body.binding_id,conversation_id:conversation.id,contact_id:conversation.body.contact_id,account_id:conversation.body.account_id,acquisition_account_id:conversation.body.account_id,closing_account_id:conversation.body.account_id,product_id:offer.body.product_id,offer_version_id:offer.id,workflow_version_id:conversation.body.workflow_version_id,agent_version_id:conversation.body.agent_version_id,payment_profile_version_id:offer.body.payment_profile_version_id,receipt_policy_version_id:offer.body.receipt_policy_version_id,offer_snapshot:offer.body,workflow_snapshot:conversation.body.workflow_snapshot??null,workflow_runtime_version:conversation.body.workflow_runtime_version??null,amount_minor:testFields.launch_test_role==='beneficiary'?0:offer.body.base_amount_minor,currency:offer.body.currency,status:testFields.launch_test_role==='beneficiary'?'SPONSORSHIP_AWAITING_ASSIGNMENT':'OFFERED',receipt_status:'NONE',reconciliation_status:'UNRECONCILED',fulfillment_status:'PENDING',origin:conversation.body.origin});const receiptPolicy=await captureNewReceiptPolicy(client,conversation,order);order=await save(client,order,{...order.body,...(receiptPolicy?{receipt_policy_snapshot_sha256:receiptPolicy.sha256}:{}),attribution:await firstObservedAttribution(client,order)});await event(client,conversation,'order.created',{order_id:order.id,offer_version_id:offer.id});return order;
}
async function eligibleFulfillmentItems(client:QueryExecutor,order:DomainRecord,releaseOn:'commitment_accepted'|'receipt_approved'|'reconciled'){
 const benefitTotal=await approvedBenefitTotal(client,order);
 const positiveUnlock=order.body.offer_snapshot.positive_payment_unlocks_all===true&&(order.body.sale_status==='RECOGNIZED'&&Number(order.body.sale_amount_minor)>0||await approvedNumberFlowTestPayment(client,order));
 const amount=Number(order.body.commercial_classification==='TEST'?benefitTotal:order.body.sale_definition==='receipt_sales_v1'?order.body.sale_amount_minor:releaseOn==='reconciled'?order.body.reconciled_amount_minor:order.body.observed_amount_minor??order.body.amount_minor);
 return(order.body.offer_snapshot.fulfillment??[]).filter((item:Body)=>(item.release_on===releaseOn||releaseOn==='receipt_approved'&&item.release_on==='reconciled')&&(positiveUnlock||!item.min_amount_minor||amount>=item.min_amount_minor));
}
export async function deliver(client:QueryExecutor,conversation:DomainRecord,releaseOn:string,cause:string){const order=await ensureOrder(client,conversation);if(!order)return;
 if(releaseOn==='commitment_accepted'&&!order.body.committed_at&&order.body.status!=='COMMITTED'&&order.body.sale_status!=='RECOGNIZED')return;
 if(['receipt_approved','reconciled'].includes(releaseOn)&&order.body.receipt_status!=='APPROVED'&&order.body.sale_definition!=='receipt_sales_v1'&&!(releaseOn==='reconciled'&&order.body.reconciliation_status==='RECONCILED'))return;
 if(order.body.commercial_classification==='TEST'&&!await activeLaunchTest(client,order))return;
 const eligible=await eligibleFulfillmentItems(client,order,releaseOn as 'commitment_accepted'|'receipt_approved'|'reconciled');
 for(const item of eligible){const exists=(await client.query(`SELECT * FROM records WHERE workspace_id=$1 AND kind='fulfillment' AND body->>'order_id'=$2 AND body->>'asset_id'=$3 AND (body->>'release_on'=$4 OR ($4 IN ('receipt_approved','reconciled') AND body->>'release_on' IN ('receipt_approved','reconciled')))`,[conversation.workspace_id,order.id,item.asset_id,releaseOn])).rows[0];if(exists?.body.effect_id)continue;
 const asset=await getRecord(client,conversation.workspace_id,'asset',item.asset_id);if(!asset)throw new Error('DELIVERY_ASSET_NOT_FOUND');const fulfillment=exists??await create(client,conversation,'fulfillment',{order_id:order.id,conversation_id:conversation.id,asset_id:asset.id,release_on:releaseOn,status:'PROPOSED',...(['access','link'].includes(asset.body.kind)?{access_verification_status:'UNVERIFIED'}:{}),adapter:asset.body.adapter??asset.body.kind,attempts:0});
 const payload:Body={kind:asset.body.kind==='file'?(String(asset.body.mime_type).startsWith('image/')?'image':String(asset.body.mime_type).startsWith('audio/')?'audio':'document'):'text',asset_id:asset.id,fulfillment_id:fulfillment.id,text:asset.body.kind==='link'?String(asset.body.url):asset.body.kind==='access'?undefined:String(asset.body.name)};
 let grant:Body|undefined; if(asset.body.kind==='access'&&['webhook','link'].includes(asset.body.adapter)){const proposed=await proposeEffectOutcome(client,conversation,{kind:'grant',asset_id:asset.id,grant_id:fulfillment.id},`fulfillment-grant:${fulfillment.id}`);if(proposed.state==='BLOCKED')return proposed;grant=proposed.effect;}if(grant){payload.grant_effect_id=grant.id;delete payload.asset_id;}const proposed=await proposeEffectOutcome(client,conversation,payload,`fulfillment:${fulfillment.id}`,{predecessorId:grant?.id});if(proposed.state==='BLOCKED')return proposed;const effect=proposed.effect;await save(client,fulfillment,{...fulfillment.body,effect_id:effect.id,...(grant?{grant_effect_id:grant.id}:{})});await event(client,conversation,'fulfillment.proposed',{fulfillment_id:fulfillment.id,asset_id:asset.id,release_on:releaseOn},cause);
 }
}
/**
 * Complete the guided sale only from durable transport facts. Provider
 * acceptance is enough for the thank-you message; every promised fulfillment
 * must additionally have a device-delivery acknowledgement. UNKNOWN/SENDING
 * remain attached to the original effect and deliberately block completion.
 */
export async function resumeClosingSaleAfterDelivery(client:QueryExecutor,original:DomainRecord,cause:string){
 const conversation=await getRecord(client,original.workspace_id,'conversation',original.id)??original;
 const state:FlowState|undefined=conversation.body.flow_state;
 if(state?.status!=='WAITING'||state.waiting_for!=='closing_delivery_confirmed')return conversation;
 const order=(await client.query(`SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='order' AND body->>'conversation_id'=$3 LIMIT 1`,[conversation.workspace_id,conversation.environment,conversation.id])).rows[0] as DomainRecord|undefined;
 if(!order||!(order.body.sale_status==='RECOGNIZED'&&Number(order.body.sale_amount_minor)>0)&&!await approvedNumberFlowTestPayment(client,order))return conversation;
 const thanks=(await client.query(`SELECT id,status,provider_message_id FROM outbox WHERE workspace_id=$1 AND environment=$2 AND conversation_id=$3 AND payload->>'workflow_recipe_step'='9' ORDER BY dispatch_sequence DESC LIMIT 1`,[conversation.workspace_id,conversation.environment,conversation.id])).rows[0];
 if(!thanks||!transportConfirmedStatuses.has(String(thanks.status))||!thanks.provider_message_id)return conversation;
 const required=[
  ...await eligibleFulfillmentItems(client,order,'commitment_accepted'),
  ...await eligibleFulfillmentItems(client,order,'receipt_approved'),
 ];
 const rows=(await client.query(
  `SELECT f.id::text,f.body,o.status effect_status,o.provider_message_id,g.status grant_status,g.provider_message_id grant_provider_message_id,g.result grant_result
   FROM records f
   LEFT JOIN outbox o ON o.id::text=f.body->>'effect_id' AND o.workspace_id=f.workspace_id AND o.environment=f.environment
   LEFT JOIN outbox g ON g.id::text=f.body->>'grant_effect_id' AND g.workspace_id=f.workspace_id AND g.environment=f.environment
   WHERE f.workspace_id=$1 AND f.environment=$2 AND f.kind='fulfillment' AND f.body->>'order_id'=$3`,
  [conversation.workspace_id,conversation.environment,order.id],
 )).rows;
 const used=new Set<string>();
 const confirmed:string[]=[];
 for(const item of required){
  const closing=item.release_on!=='commitment_accepted';
  const row=rows.find(candidate=>!used.has(String(candidate.id))&&candidate.body.asset_id===item.asset_id&&(closing?['receipt_approved','reconciled'].includes(String(candidate.body.release_on)):candidate.body.release_on==='commitment_accepted'));
  if(!row||!deliveryConfirmedStatuses.has(String(row.body.status))||row.body.status!==row.effect_status||!row.provider_message_id)return conversation;
  if(row.body.grant_effect_id&&(!transportConfirmedStatuses.has(String(row.grant_status))||!row.grant_provider_message_id||!row.grant_result?.access_ciphertext))return conversation;
  used.add(String(row.id));confirmed.push(String(row.id));
 }
 await event(client,conversation,'workflow.closing_delivery_confirmed',{thanks_effect_id:thanks.id,fulfillment_ids:confirmed},cause);
 return advanceWorkflow(client,conversation,'closing_delivery_confirmed');
}
/** Step 7 may promise that the complete prepayment bundle has arrived only
 * after the channel has confirmed delivery of every step 6 asset. */
export async function resumePrepaymentAfterDelivery(client:QueryExecutor,original:DomainRecord,cause:string){
 const conversation=await getRecord(client,original.workspace_id,'conversation',original.id)??original;
 const state:FlowState|undefined=conversation.body.flow_state;
 if(state?.status!=='WAITING'||state.waiting_for!=='prepayment_delivery_confirmed')return conversation;
 const order=(await client.query(`SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='order' AND body->>'conversation_id'=$3 LIMIT 1`,[conversation.workspace_id,conversation.environment,conversation.id])).rows[0] as DomainRecord|undefined;
 if(!order||!order.body.committed_at&&order.body.status!=='COMMITTED')return conversation;
 const required=await eligibleFulfillmentItems(client,order,'commitment_accepted');
 if(!required.length)return conversation;
 const rows=(await client.query(`SELECT f.id::text,f.body,o.status effect_status,o.provider_message_id,g.status grant_status,g.provider_message_id grant_provider_message_id,g.result grant_result
  FROM records f
  LEFT JOIN outbox o ON o.id::text=f.body->>'effect_id' AND o.workspace_id=f.workspace_id AND o.environment=f.environment
  LEFT JOIN outbox g ON g.id::text=f.body->>'grant_effect_id' AND g.workspace_id=f.workspace_id AND g.environment=f.environment
  WHERE f.workspace_id=$1 AND f.environment=$2 AND f.kind='fulfillment' AND f.body->>'order_id'=$3 AND f.body->>'release_on'='commitment_accepted'`,[conversation.workspace_id,conversation.environment,order.id])).rows;
 const confirmed:string[]=[];
 for(const item of required){
  const row=rows.find(candidate=>candidate.body.asset_id===item.asset_id&&!confirmed.includes(String(candidate.id)));
  if(!row||!deliveryConfirmedStatuses.has(String(row.body.status))||row.body.status!==row.effect_status||!row.provider_message_id)return conversation;
  if(row.body.grant_effect_id&&(!transportConfirmedStatuses.has(String(row.grant_status))||!row.grant_provider_message_id||!row.grant_result?.access_ciphertext))return conversation;
  confirmed.push(String(row.id));
 }
 await event(client,conversation,'workflow.prepayment_delivery_confirmed',{fulfillment_ids:confirmed},cause);
 return advanceWorkflow(client,conversation,'prepayment_delivery_confirmed');
}
async function definition(client:QueryExecutor,conversation:DomainRecord):Promise<{flow:FlowDefinition;versionId:string}>{
 const offer=conversation.body.offer_version_id?await getRecord(client,conversation.workspace_id,'offer',conversation.body.offer_version_id):undefined;
 const configured=(flow:FlowDefinition)=>offer?applyOfferSalesFlowContent(flow,offer.body):flow;
 if(conversation.body.runtime_workflow_id||conversation.body.workflow_version_id){const workflow=await getRecord(client,conversation.workspace_id,'workflow',conversation.body.runtime_workflow_id??conversation.body.workflow_version_id);if(!workflow||workflow.body.status!=='PUBLISHED')throw new Error('PUBLISHED_WORKFLOW_REQUIRED');return{flow:configured(workflow.body as FlowDefinition),versionId:workflow.id};}
 if(conversation.body.workflow_snapshot)return{flow:configured(conversation.body.workflow_snapshot as FlowDefinition),versionId:conversation.body.workflow_runtime_version};
 if(!offer)throw new Error('OFFER_REQUIRED');const flow=defaultSalesWorkflow(offer.id,(offer.body.fulfillment??[]).some((x:Body)=>x.release_on==='commitment_accepted'),offer.body.billing_delay_seconds??1800);return{flow:configured(flow),versionId:`default-sales-v2:${offer.id}`};
}
function offerRemarketingPolicy(offer:Body):Body|undefined{
 const raw=offer.sales_flow?.remarketing;if(!raw)return;
 return normalizeRemarketingPolicy(raw);
}
function remarketingAnchor(def:FlowDefinition,stage:'awaiting_agreement'|'awaiting_payment',fallbackTarget:string):string|undefined{
 return def.nodes.find(node=>node.config?.remarketing_anchor===stage)?.id
  ??def.nodes.find(node=>node.next===fallbackTarget&&(stage==='awaiting_payment'?node.type==='bank_instructions':node.type==='message'))?.id;
}
async function prepareRemarketingPlan(client:QueryExecutor,conversation:DomainRecord,def:{flow:FlowDefinition;versionId:string},offer:Body,stage:'awaiting_agreement'|'awaiting_payment',fallbackTarget:string):Promise<DomainRecord>{
 const policy=offerRemarketingPolicy(offer);if(!policy)return conversation;
 const anchorNodeId=remarketingAnchor(def.flow,stage,fallbackTarget);if(!anchorNodeId)throw new Error('REMARKETING_ANCHOR_REQUIRED');
 const prior=conversation.body.followup_plan;
 if(prior?.stage===stage&&['AWAITING_COLLECTION_ACK','SCHEDULED','DISABLED'].includes(prior.status))return conversation;
 if(prior&&prior.stage!==stage)await cancelPendingRemarketingForContact(client,conversation,'REMARKETING_STAGE_CHANGED');
 conversation=await save(client,conversation,{...conversation.body,followup_plan:{key:`remarketing:${conversation.id}:${def.versionId}:${stage}:${policy.policy_revision}`,workflow_runtime_version:def.versionId,policy_snapshot:structuredClone(policy),stage,anchor_node_id:anchorNodeId,status:'AWAITING_COLLECTION_ACK'}});
 return armFollowups(client,conversation);
}
export async function advanceWorkflow(client:QueryExecutor,original:DomainRecord,trigger?:string){
 let conversation=await getRecord(client,original.workspace_id,'conversation',original.id)??original;if(conversation.body.historical_only||conversation.body.sponsorship_id||typeof conversation.body.account_id!=='string'||!conversation.body.account_id.trim()||typeof conversation.body.contact_id!=='string'||!conversation.body.contact_id.trim()||conversation.body.collection_stop_reason&&!['receipt_approved','reconciled'].includes(trigger??'')||await gated(client,conversation))return conversation;if(!conversation.body.offer_version_id)return conversation;
 conversation=await reconcileNumberFlowTestClassification(client,conversation);
 if(conversation.body.ai_status==='HUMAN_REVIEW'){
  if(trigger!=='human_approved')return conversation;
  const resume=conversation.body.ai_review_resume_state;
  const body:Body={...conversation.body,ai_status:null,ai_pending:false};delete body.ai_review_resume_state;
  if(resume){body.flow_state=structuredClone(resume);if(body.flow_state.waiting_for==='ai_accepted')body.flow_state.waiting_for='ai_customer_message';return save(client,conversation,body);}
  conversation=await save(client,conversation,body);
 }
 let def=await definition(client,conversation);if(!conversation.body.workflow_version_id&&!conversation.body.workflow_snapshot)conversation=await save(client,conversation,{...conversation.body,workflow_snapshot:structuredClone(def.flow),workflow_runtime_version:def.versionId});const validation=validateWorkflow(def.flow);if(!validation.valid)throw new Error('INVALID_PUBLISHED_WORKFLOW');
 const state:FlowState=structuredClone(conversation.body.flow_state??newFlowState(def.flow));state.variables=canonicalSalesVariables(state.variables);if(state.status==='FINISHED'||state.status==='FAILED')return conversation;
 if(state.status==='HUMAN_REVIEW'){if(trigger!=='human_approved')return conversation;state.status='RUNNING';delete state.waiting_for;delete state.waiting_node_id;}
 if(state.status==='WAITING'&&trigger==='receipt_approved'&&state.waiting_for!=='receipt_approved'){
  const paid=(await client.query(`SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='order' AND body->>'conversation_id'=$3 LIMIT 1`,[conversation.workspace_id,conversation.environment,conversation.id])).rows[0];
  const receiptNode=def.flow.nodes.find(node=>node.type==='receipt');
  if(paid&&(paid.body.sale_status==='RECOGNIZED'||await approvedNumberFlowTestPayment(client,paid))&&receiptNode?.next){state.node_id=receiptNode.next;state.status='RUNNING';delete state.waiting_for;delete state.waiting_node_id;delete state.wake_at;delete state.pending_anchor;}
 }
 if(state.status==='WAITING'&&['receipt_approved','reconciled'].includes(trigger??'')&&(state.wake_at||state.pending_anchor?.purpose==='collection')){const target=def.flow.nodes.find(n=>n.type===(trigger==='reconciled'?'reconcile':'receipt'));if(target?.next){state.node_id=target.next;state.waiting_for=trigger;delete state.wake_at;delete state.pending_anchor;}}
 if(state.status==='WAITING'){
  if(state.waiting_for&&state.waiting_for!==trigger&&!(state.waiting_for==='reconciled'&&trigger==='receipt_approved'))return conversation;
  if(state.wake_at&&(await nowFor(client,conversation))<new Date(state.wake_at))return conversation;
  state.status='RUNNING';delete state.waiting_for;delete state.waiting_node_id;delete state.wake_at;
 }
 const order=await ensureOrder(client,conversation);if(order?.body.launch_test_role==='beneficiary')return save(client,conversation,{...conversation.body,launch_test_role:'beneficiary',payment_obligation:false,ai_pending:false,flow_state:{...state,status:'FINISHED'}});const offer=order?.body.offer_snapshot??{};const product=offer.product_id?await getRecord(client,conversation.workspace_id,'product',offer.product_id):undefined;const contact=await getRecord(client,conversation.workspace_id,'contact',conversation.body.contact_id);
 const variables={product_name:product?.body.name??'Producto',offer_name:offer.name??product?.body.name??'Oferta',price:plainPrice(Number(offer.base_amount_minor??0),offer.currency??'MXN'),currency:offer.currency??'',contact_name:contact?.body.name??'Contacto'};
 for(let batch=0;batch<25&&state.status==='RUNNING';batch++){
  if(++state.steps>(def.flow.max_steps??100)){state.status='FAILED';await event(client,conversation,'workflow.limit_reached',{limit:def.flow.max_steps??100});break;}
  const node=def.flow.nodes.find(n=>n.id===state.node_id);if(!node){state.status='FAILED';break;}
  const nodeKey=`run:${conversation.id}:${def.versionId}:${state.steps}:${node.id}`;
  let next=node.next;
  const defer=(reason:string)=>{state.steps--;return save(client,conversation,{...conversation.body,flow_state:state,workflow_runtime_version:def.versionId,effect_proposal_block:{node_id:node.id,reason}});};
  switch(node.type){
   case'entry':break;
   case'condition':next=node.branches?.[evaluateCondition(node.config,{...state.variables,conversation:conversation.body,order:order?.body,customer_text:conversation.body.last_customer_text})?'true':'false'];break;
   case'message':{
    if(node.config.education_intro){const selected=classifyEducation(String(conversation.body.last_customer_text??''),state.variables);const {valid,clarification,...selection}=selected;Object.assign(state.variables,selection);if(valid){next=def.flow.nodes.find(n=>n.id===node.next)?.next;break;}if(selected.nivel){node.config={...node.config,text:clarification};}}
    const proposed=await proposeEffectOutcome(client,conversation,{kind:node.config.kind??'text',...(node.config.after_previous_confirmed_seconds!==undefined?{after_previous_confirmed_seconds:node.config.after_previous_confirmed_seconds}:{}),workflow_node_id:node.id,workflow_runtime_version:def.versionId,...(node.config.recipe_step!==undefined?{workflow_recipe_step:Number(node.config.recipe_step),workflow_recipe_id:node.config.recipe_id}:{}),...(node.config.purpose?{purpose:node.config.purpose}:{}),text:renderMessage(String(node.config.text??''),variables),...(node.config.asset_id?{asset_id:node.config.asset_id}:{})},nodeKey);if(proposed.state==='BLOCKED')return defer(proposed.reason);conversation=await save(client,conversation,{...conversation.body,ai_pending:false,flow_response_sequence:conversation.body.sequence,effect_proposal_block:null});break;
   }
   case'reply':state.status='WAITING';state.waiting_for='customer_reply';state.waiting_node_id=node.id;break;
   case'wait':{if(node.config.anchor){state.status='WAITING';state.waiting_for='effect_confirmed';state.waiting_node_id=node.id;state.pending_anchor={node_id:node.id,key:nodeKey,seconds:Number(node.config.seconds),purpose:node.config.purpose,anchor:structuredClone(node.config.anchor)};await armConfirmedWait(client,conversation,state);break;}const now=await nowFor(client,conversation);const due=new Date(now.getTime()+Number(node.config.seconds)*1000).toISOString();await client.query(`INSERT INTO timers(id,workspace_id,environment,conversation_id,kind,payload,due_at,logical_key) VALUES($1,$2,$3,$4,$8,$5,$6,$7) ON CONFLICT(workspace_id,logical_key) DO NOTHING`,[uuid(),conversation.workspace_id,conversation.environment,conversation.id,{...await commercialContext(client,conversation),node_id:node.id,workflow_version_id:conversation.body.workflow_version_id,purpose:node.config.purpose??(node.config.cancel_on_response?'followup':null)},due,nodeKey,node.config.cancel_on_response?'followup':'workflow_wait']);state.status='WAITING';state.wake_at=due;break;}
   case'stage':conversation=await save(client,conversation,{...conversation.body,stage:String(node.config.stage??'QUALIFIED')});break;
   case'approval':case'handoff':state.status='HUMAN_REVIEW';state.waiting_for='human_approved';state.waiting_node_id=node.id;await event(client,conversation,'workflow.human_review_requested',{node_id:node.id});break;
   case'commitment':if(order?.body.status!=='COMMITTED'&&!order?.body.committed_at){state.status='WAITING';state.waiting_for='commitment';state.waiting_node_id=node.id;conversation=await prepareRemarketingPlan(client,conversation,def,offer,'awaiting_agreement',node.id);}break;
   case'fulfillment':case'post_receipt':{const proposed=await deliver(client,conversation,String(node.config.release_on??'receipt_approved'),nodeKey);if(proposed?.state==='BLOCKED')return defer(proposed.reason);if(Number(node.config.recipe_step)===6&&order&&(await eligibleFulfillmentItems(client,order,'commitment_accepted')).length){state.status='WAITING';state.waiting_for='prepayment_delivery_confirmed';state.waiting_node_id=node.id;}else if(Number(node.config.recipe_step)===10){state.status='WAITING';state.waiting_for='closing_delivery_confirmed';state.waiting_node_id=node.id;}break;}
   case'bank_instructions':{
     const bankId=offer.payment_profile_version_id;const bank=bankId?await getRecord(client,conversation.workspace_id,'bank_profile',bankId):undefined;
     if(!bank&&conversation.environment==='REAL'){state.status='HUMAN_REVIEW';await event(client,conversation,'bank.configuration_required',{});next=node.id;}
     else{const sensitive=bank?.body.secret_ciphertext?JSON.parse(decrypt(bank.body.secret_ciphertext)):null;const text=(bank&&collectionInstructions({bank:bank.body,secret:sensitive,price:variables.price,currency:variables.currency}))??'SIMULACIÓN: instrucciones bancarias de prueba; no efectuar transferencias.';const proposed=await proposeEffectOutcome(client,conversation,{kind:'text',purpose:'collection',workflow_node_id:node.id,workflow_runtime_version:def.versionId,...(node.config.recipe_step!==undefined?{workflow_recipe_step:Number(node.config.recipe_step),workflow_recipe_id:node.config.recipe_id}:{}),text:node.config.text?renderMessage(String(node.config.text),{...variables,bank_instructions:text}):text,payment_profile_version_id:bank?.id},nodeKey);if(proposed.state==='BLOCKED')return defer(proposed.reason);}break;
   }
   case'receipt':if(order?.body.receipt_status!=='APPROVED'){state.status='WAITING';state.waiting_for='receipt_approved';if(offerRemarketingPolicy(offer))conversation=await prepareRemarketingPlan(client,conversation,def,offer,'awaiting_payment',node.id);else if(node.config.followups&&!conversation.body.followup_plan){conversation=await save(client,conversation,{...conversation.body,followup_plan:{...structuredClone(node.config.followups),key:`followup:${conversation.id}:${def.versionId}:${node.id}`,workflow_runtime_version:def.versionId,status:'AWAITING_COLLECTION_ACK'}});conversation=await armFollowups(client,conversation);}}break;
   case'reconcile':if(order?.body.sale_definition!=='receipt_sales_v1'&&order?.body.reconciliation_status!=='RECONCILED'){state.status='WAITING';state.waiting_for='reconciled';}break;
   case'ai':conversation=await save(client,conversation,{...conversation.body,ai_pending:conversation.body.flow_response_sequence!==conversation.body.sequence,ai_node_id:node.id});state.status='WAITING';state.waiting_for=conversation.body.flow_response_sequence===conversation.body.sequence?'ai_customer_message':'ai_accepted';break;
   case'subflow':{if(state.stack.length>=5)throw new Error('SUBFLOW_DEPTH_LIMIT');const sub=await getRecord(client,conversation.workspace_id,'workflow',node.config.workflow_version_id);if(!sub||sub.body.status!=='PUBLISHED')throw new Error('PUBLISHED_SUBFLOW_REQUIRED');state.stack.push({workflow_id:def.versionId,next_node_id:next??null});def={flow:sub.body as FlowDefinition,versionId:sub.id};conversation=await save(client,conversation,{...conversation.body,runtime_workflow_id:sub.id});next=def.flow.entry_node_id;break;}
   case'end':{const frame=state.stack.pop();if(frame){const parent=await getRecord(client,conversation.workspace_id,'workflow',frame.workflow_id);if(!parent)throw new Error('SUBFLOW_PARENT_MISSING');def={flow:parent.body as FlowDefinition,versionId:parent.id};next=frame.next_node_id??undefined;conversation=await save(client,conversation,{...conversation.body,runtime_workflow_id:parent.id});}else state.status='FINISHED';break;}
   default:throw new Error('WORKFLOW_NODE_UNSUPPORTED');
  }
  // Flow-test chat advances expose one visible unit at a time. The durable
  // node cursor is already moved below, so resuming is deterministic and does
  // not replay the effect that was just proposed.
  // In «Probar número» (V7 F6, RF-19.b/j) a pause only separates two visible
  // units: before a wait (commitment, receipt, reply) the flow runs on, so the
  // customer answers the question just shown exactly as in production.
  const visible=['message','bank_instructions','fulfillment','post_receipt'],betweenVisible=conversation.body.flow_test_pause==='BETWEEN_VISIBLE';
  if(conversation.body.flow_test_single_step===true&&state.status==='RUNNING'&&next&&visible.includes(node.type)&&(!betweenVisible||visible.includes(String(def.flow.nodes.find(n=>n.id===next)?.type)))){
   state.status='WAITING';state.waiting_for='simulation_continue';state.waiting_node_id=node.id;
  }
  await event(client,conversation,'workflow.node_executed',{node_id:node.id,node_type:node.type,step:state.steps,workflow_version_id:def.versionId,status:state.status},nodeKey);
  if(next)state.node_id=next;else if(state.status==='RUNNING')state.status='FINISHED';
 }
 if(state.status==='FINISHED'&&conversation.environment==='SIMULATION'&&conversation.body.simulation_id){const simulation=await getRecord(client,conversation.workspace_id,'simulation',conversation.body.simulation_id);if(simulation?.environment===conversation.environment)await save(client,simulation,{...simulation.body,status:'COMPLETED',completed_at:new Date().toISOString()});}
 return save(client,conversation,{...conversation.body,flow_state:state,workflow_runtime_version:def.versionId,effect_proposal_block:null});
}
/** Recover schedules from durable accepted effects, including after a worker restart. */
interface WorkflowStore {query:typeof query;transaction<T>(work:(db:QueryExecutor)=>Promise<T>):Promise<T>}
const workflowStore:WorkflowStore={query,transaction:work=>withTransaction(work)};
async function confirmedSchedules(store:WorkflowStore,limit:number){
 const rows=(await store.query(`SELECT * FROM records WHERE kind='conversation' AND (body->'flow_state' ? 'pending_anchor' OR body->'followup_plan'->>'status'='AWAITING_COLLECTION_ACK') ORDER BY updated_at LIMIT $1`,[limit])).rows;
 for(const row of rows)await store.transaction(async client=>{await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[row.id]);let conversation=await getRecord(client,row.workspace_id,'conversation',row.id);if(!conversation)return;
  await recordProfileExecutor(client,conversation.workspace_id,conversation.environment as 'REAL'|'SIMULATION');
  const state:FlowState=structuredClone(conversation.body.flow_state);if(state&&await armConfirmedWait(client,conversation,state))conversation=await save(client,conversation,{...conversation.body,flow_state:state});await armFollowups(client,conversation);
 });return rows.length;
}
async function dispatchFollowup(client:QueryExecutor,conversation:DomainRecord,timer:Body){
 const plan=conversation.body.followup_plan;
 const stage=timer.payload.stage==='AGREEMENT'?'AGREEMENT':'COLLECTION';
 const isRemarketing=!!timer.payload.cycle_id;
 const now=await nowFor(client,conversation),lastInbound=new Date(conversation.body.last_inbound_at??0).getTime();
 // RF-10.d: outside the variant's allowed hours a reminder waits for the next
 // allowed moment (all guards are re-checked then); it is never sent early.
 if(isRemarketing&&timer.payload.window&&!insideRemarketingWindow(now,timer.payload.window)){
  const next=nextRemarketingTime(now,timer.payload.window).toISOString();
  await client.query(`UPDATE timers SET due_at=$2 WHERE id=$1 AND status='PENDING'`,[timer.id,next]);
  await event(client,conversation,'remarketing.rescheduled_to_window',{slot_id:timer.payload.slot_id??timer.payload.id,stage,due_at:next},timer.id);return;
 }
 const outsideWindow=!Number.isFinite(lastInbound)||lastInbound>now.getTime()||now.getTime()-lastInbound>=24*3600_000;
 const parsedTemplate=isRemarketing&&outsideWindow?remarketingTransportTemplateSchema.safeParse(timer.payload.template):undefined;
 const templateAccount=parsedTemplate?.success?await getRecord(client,conversation.workspace_id,'channel_account',conversation.body.account_id):undefined;
 const templateContact=parsedTemplate?.success?await getRecord(client,conversation.workspace_id,'contact',conversation.body.contact_id):undefined;
 const templateAsset=parsedTemplate?.success&&timer.payload.asset_id?await getRecord(client,conversation.workspace_id,'asset',timer.payload.asset_id):undefined;
 const templateTransportCompatible=parsedTemplate?.success&&(conversation.environment==='SIMULATION'&&templateAccount?.body.provider==='simulator'||conversation.environment==='REAL'&&templateAccount?.body.provider==='cloud');
 const templateMediaEligible=parsedTemplate?.success&&timer.payload.medium==='video'&&templateAsset?.environment===conversation.environment&&templateAsset.body.kind==='file'&&templateAsset.body.mime_type==='video/mp4'&&templateAsset.body.status==='READY'&&templateAsset.body.delivery_eligible!==false&&templateAsset.body.usage!=='MARKETING_REFERENCE'&&templateAsset.body.storage_provider!=='r2';
 const templateConsentEligible=conversation.environment==='SIMULATION'||!!templateContact?.body.consent?.evidence;
 const templateBodyTextSha256=hash(String(timer.payload.text??''));
 const templateEvidence=parsedTemplate?.success&&templateTransportCompatible&&templateMediaEligible&&templateConsentEligible&&conversation.environment==='REAL'
  ?await verifiedTemplateCapabilityEvidence(client,{workspaceId:conversation.workspace_id,environment:'REAL',accountId:String(conversation.body.account_id),name:parsedTemplate.data.name,language:parsedTemplate.data.language,headerKind:'video',bodyTextSha256:templateBodyTextSha256})
  :undefined;
 const templateEvidenceEligible=conversation.environment==='SIMULATION'||!!templateEvidence;
 const template=parsedTemplate?.success&&templateTransportCompatible&&templateMediaEligible&&templateConsentEligible&&templateEvidenceEligible?parsedTemplate.data:undefined;
 const transportBlockReason=!parsedTemplate?.success?'APPROVED_TEMPLATE_REQUIRED':!templateTransportCompatible?'TEMPLATE_TRANSPORT_UNSUPPORTED':!templateMediaEligible?'TEMPLATE_MEDIA_UNSUPPORTED':!templateConsentEligible?'TEMPLATE_CONSENT_REQUIRED':'TEMPLATE_PROVIDER_EVIDENCE_REQUIRED';
 const reason=(isRemarketing?await remarketingEligibility(client,conversation,stage,!!template):await collectionEligibility(client,conversation,true))??(plan?.key!==timer.payload.plan_key||plan?.status!=='SCHEDULED'?'FOLLOWUP_PLAN_INACTIVE':undefined);
 if(reason){
  if(isRemarketing&&reason==='FOLLOWUP_WINDOW_CLOSED'){
   const block={transport_status:'BLOCKED',transport_block_reason:transportBlockReason,transport_blocked_at:now.toISOString(),quota_consumed:false,...(Number.isFinite(lastInbound)&&lastInbound<=now.getTime()?{transport_window_closed_at:new Date(lastInbound+24*3600_000).toISOString()}:{})};
   await client.query(`UPDATE timers SET status='CANCELLED',payload=payload||$2::jsonb WHERE id=$1`,[timer.id,block]);
   await event(client,conversation,'remarketing.transport_blocked',{slot_id:timer.payload.slot_id??timer.payload.id,stage,reason:block.transport_block_reason,timer_status:'CANCELLED',quota_consumed:false},timer.id);return;
  }
  await client.query(`UPDATE timers SET status='CANCELLED' WHERE id=$1`,[timer.id]);await event(client,conversation,'followup.omitted',{touch_id:timer.payload.id,reason},timer.id);return;
 }
 const index=Number(timer.payload.touch_index);if(isRemarketing?![1,2,3].includes(index):![1,2].includes(index))throw new Error('FOLLOWUP_LIMIT_INVALID');
 const offer=await getRecord(client,conversation.workspace_id,'offer',conversation.body.offer_version_id),bank=offer?.body.payment_profile_version_id?await getRecord(client,conversation.workspace_id,'bank_profile',offer.body.payment_profile_version_id):undefined;
 const needsBank=stage==='COLLECTION'||String(timer.payload.text??'').includes('{{bank_instructions}}');
 if(needsBank&&conversation.environment==='REAL'&&!bank?.body.secret_ciphertext){await client.query(`UPDATE timers SET status='CANCELLED' WHERE id=$1`,[timer.id]);await event(client,conversation,'followup.omitted',{touch_id:timer.payload.id,reason:'BANK_CONFIGURATION_REQUIRED'},timer.id);return;}
 let attempt:Body|undefined,cycleRevision:number|undefined;
 if(isRemarketing){
  const reservation=await reserveRemarketingAttempt(client,{cycleId:timer.payload.cycle_id,workspaceId:conversation.workspace_id,environment:conversation.environment,contactId:String(conversation.body.contact_id),slotId:timer.payload.slot_id??timer.payload.id,conversationId:conversation.id,timerId:timer.id,stage});
  if(!reservation.attempt||reservation.reason){await client.query(`UPDATE timers SET status='CANCELLED' WHERE id=$1`,[timer.id]);await event(client,conversation,'remarketing.omitted',{slot_id:timer.payload.slot_id??timer.payload.id,reason:reservation.reason??'REMARKETING_RESERVATION_FAILED'},timer.id);return;}
  attempt=reservation.attempt;cycleRevision=Number(reservation.cycle?.revision);
 }
 const bankSecret=bank?.body.secret_ciphertext?JSON.parse(decrypt(bank.body.secret_ciphertext)):undefined;
 const bankText=(bank&&bankSecret&&collectionInstructions({bank:bank.body,secret:bankSecret,price:null,currency:null}))??'SIMULACIÓN: instrucciones bancarias de prueba; no efectuar transferencias.';
 const payload={purpose:isRemarketing?'remarketing':'followup',followup_touch:index,remarketing_attempt_id:attempt?.id,remarketing_cycle_id:timer.payload.cycle_id,remarketing_cycle_revision:cycleRevision,remarketing_slot_id:timer.payload.slot_id,remarketing_stage:timer.payload.stage,followup_plan_key:plan.key,workflow_runtime_version:plan.workflow_runtime_version,workflow_node_id:timer.payload.id};
 const medium=isRemarketing&&timer.payload.medium==='video'?'video':isRemarketing&&timer.payload.medium==='text'?'text':'audio';
 const expiresAt=new Date(lastInbound+24*3600_000).toISOString();
 const prior=(await client.query('SELECT not_before,expires_at FROM outbox WHERE workspace_id=$1 AND logical_key=$2',[conversation.workspace_id,`${timer.logical_key}:${template?'template':medium}`])).rows[0];
 const notBefore=prior?new Date(prior.not_before).toISOString():now.toISOString();
 const textOnly=medium==='text'&&!template;
 const firstResult=template
  ?await proposeEffectOutcome(client,conversation,{...payload,kind:'template',template,asset_id:timer.payload.asset_id,text:String(timer.payload.text),template_provider_evidence_id:templateEvidence?.id,template_header_kind:'video',template_body_text_sha256:templateBodyTextSha256,remarketing_template_medium:medium},`${timer.logical_key}:template`,{notBefore})
  :textOnly
   // A text-only reminder is one message (bank details rendered as in collection).
   ?await proposeEffectOutcome(client,conversation,{...payload,kind:'text',text:renderMessage(String(timer.payload.text),{bank_instructions:bankText}),payment_profile_version_id:bank?.id},`${timer.logical_key}:text`,{notBefore,expiresAt:prior?new Date(prior.expires_at).toISOString():expiresAt})
   :await proposeEffectOutcome(client,conversation,{...payload,kind:medium,asset_id:timer.payload.asset_id},`${timer.logical_key}:${medium}`,{notBefore,expiresAt:prior?new Date(prior.expires_at).toISOString():expiresAt});
 if(firstResult.state==='BLOCKED')return;const first=firstResult.effect;
 if(!template&&!textOnly){const second=await proposeEffectOutcome(client,conversation,{...payload,kind:'text',text:renderMessage(String(timer.payload.text),{bank_instructions:bankText}),payment_profile_version_id:bank?.id},`${timer.logical_key}:text`,{predecessorId:first.id,notBefore:new Date(first.not_before).toISOString(),expiresAt:new Date(first.expires_at).toISOString()});if(second.state==='BLOCKED')return;}
 await client.query(`UPDATE timers SET status=$2 WHERE id=$1`,[timer.id,first?'FIRED':'CANCELLED']);
 if(attempt)await setRemarketingAttemptStatus(client,{attemptId:attempt.id,workspaceId:conversation.workspace_id,environment:conversation.environment},first?'PROPOSED':'CANCELLED',{effect_id:first?.id??null});
 if(first)await event(client,conversation,isRemarketing?'remarketing.proposed':'followup.proposed',{touch_id:timer.payload.id,slot_id:timer.payload.slot_id??null,touch_index:index,effect_id:first.id,media_effect_id:template||textOnly?null:first.id,template_effect_id:template?first.id:null,transport:template?'APPROVED_TEMPLATE':'CURRENT_WINDOW',anchor_at:timer.payload.anchor_at},timer.id);
}
async function timers(store:WorkflowStore,limit:number){
 await confirmedSchedules(store,limit*4);
 const due=(await store.query(`SELECT t.id FROM timers t
  LEFT JOIN records c ON c.workspace_id=t.workspace_id AND c.environment=t.environment AND c.kind='conversation' AND c.id::text=t.conversation_id
  LEFT JOIN records s ON s.workspace_id=c.workspace_id AND s.environment=c.environment AND s.kind='simulation' AND s.id::text=c.body->>'simulation_id'
  WHERE t.status='PENDING' AND (t.due_at<=now() OR (t.environment='SIMULATION' AND t.due_at<=COALESCE((s.body->>'virtual_now')::timestamptz,now())))
  ORDER BY t.due_at LIMIT $1`,[limit])).rows;
 for(const row of due)await store.transaction(async client=>{
  const candidate=(await client.query(`SELECT * FROM timers WHERE id=$1 AND status='PENDING'`,[row.id])).rows[0];if(!candidate)return;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[candidate.conversation_id]);
  const timer=(await client.query(`SELECT * FROM timers WHERE id=$1 AND status='PENDING' FOR UPDATE`,[row.id])).rows[0];if(!timer)return;
  const conversation=await getRecord(client,timer.workspace_id,'conversation',timer.conversation_id);if(!conversation||conversation.environment!==timer.environment)return;
  await recordProfileExecutor(client,conversation.workspace_id,conversation.environment as 'REAL'|'SIMULATION');
  if(new Date(timer.due_at)>await nowFor(client,conversation))return;
  if(timer.kind==='followup'&&timer.payload.plan_key){await dispatchFollowup(client,conversation,timer);return;}
  if(timer.payload.purpose==='collection'){const reason=await collectionEligibility(client,conversation);if(reason){await client.query(`UPDATE timers SET status='CANCELLED' WHERE id=$1`,[timer.id]);await event(client,conversation,'workflow.collection_wait_cancelled',{reason,node_id:timer.payload.node_id},timer.id);return;}}
  if(conversation.body.ai_status==='HUMAN_REVIEW'||conversation.body.flow_state?.status==='HUMAN_REVIEW')return;
  if(await gated(client,conversation)){await client.query(`UPDATE timers SET status='CANCELLED' WHERE id=$1`,[timer.id]);return;}
  await client.query(`UPDATE timers SET status='FIRED' WHERE id=$1`,[timer.id]);await advanceWorkflow(client,conversation,'timer');
 });return due.length;
}
async function newWorkflows(store:WorkflowStore,limit:number){const rows=(await store.query(`SELECT * FROM records WHERE kind='conversation' AND body->>'historical_only' IS DISTINCT FROM 'true' AND NULLIF(btrim(body->>'account_id'),'') IS NOT NULL AND NULLIF(btrim(body->>'contact_id'),'') IS NOT NULL AND body ? 'offer_version_id' AND (NOT body ? 'flow_state' OR body->'flow_state'->>'status'='RUNNING') ORDER BY updated_at,id LIMIT $1`,[limit])).rows;for(const r of rows)await store.transaction(async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[r.id]);await advanceWorkflow(c,r);});return rows.length;}

// Existing workers retain their canonical pool/WorkerScope dependencies.
export async function processConfirmedSchedules(limit=100){return confirmedSchedules(workflowStore,limit);}
export async function processTimers(limit=25){return timers(workflowStore,limit);}
export async function processNewWorkflows(limit=25){return newWorkflows(workflowStore,limit);}
/** A private installed lease is the sole alternate runtime selector. */
export async function processNumberLabWorkflows(lease:NumberLabEngineLease,limit=25){
 if(!Number.isInteger(limit)||limit<1||limit>25)throw Error('LAB_ENGINE_BATCH_LIMIT');
 return withNumberLabEngine(lease,async ports=>{
  const store:WorkflowStore={query:ports.query,transaction:work=>ports.transaction(work)};
  const workflows=await newWorkflows(store,limit),dueTimers=await timers(store,limit);
  return{workflows,timers:dueTimers};
 });
}

export async function acceptCustomerResponse(client:QueryExecutor,conversation:DomainRecord,cause:string){
 if(conversation.body.sponsorship_id||conversation.body.launch_test_role==='beneficiary')return;
 const stop=collectionStopReason(String(conversation.body.last_customer_text??''));
 if(stop){if(['CUSTOMER_DECLINED','CONTACT_OPT_OUT'].includes(stop))await cancelPending(client,conversation,stop,stop==='CONTACT_OPT_OUT');else await cancelCollectionPending(client,conversation,stop);await cancelPendingRemarketingForContact(client,conversation,stop);await closeRemarketingCycle(client,conversation,stop==='CONTACT_OPT_OUT'?'OPTED_OUT':stop==='CUSTOMER_DECLINED'?'DECLINED':'HUMAN_REVIEW',stop);conversation=await save(client,conversation,{...conversation.body,collection_stop_reason:stop,followup_stop_reason:stop,ai_pending:stop==='PAYMENT_DATE_REQUIRES_REVIEW',...(stop==='PAYMENT_DATE_REQUIRES_REVIEW'?{ai_status:'HUMAN_REVIEW'}:{})});await event(client,conversation,'collection.customer_stopped',{reason:stop},cause);return;}
 if(conversation.body.followup_plan){await cancelPendingRemarketingForContact(client,conversation,'CUSTOMER_REPLIED');conversation=await save(client,conversation,{...conversation.body,followup_stop_reason:'CUSTOMER_REPLIED'});}
 if(conversation.body.collection_stop_reason)return;
 if(await gated(client,conversation)||conversation.body.ai_status==='HUMAN_REVIEW'||conversation.body.flow_state?.status==='HUMAN_REVIEW')return;
 if(conversation.body.flow_state?.waiting_for==='ai_customer_message'){conversation=await save(client,conversation,{...conversation.body,ai_pending:true,flow_state:{...conversation.body.flow_state,waiting_for:'ai_accepted'}});return;}
 if(conversation.body.flow_state?.waiting_for==='customer_reply'){
  const def=await definition(client,conversation),node=def.flow.nodes.find(n=>n.id===conversation.body.flow_state.waiting_node_id&&n.type==='reply');
  if(!node)return;const text=String(conversation.body.last_customer_text??'').trim();if(!text)return;
  const state=structuredClone(conversation.body.flow_state);state.variables=canonicalSalesVariables(state.variables);
  if(node.config.classifier==='education_grade'){const {valid,clarification,...selection}=classifyEducation(text,state.variables);Object.assign(state.variables,selection);if(!valid){conversation=await save(client,conversation,{...conversation.body,ai_pending:false,flow_response_sequence:conversation.body.sequence,flow_state:state});await proposeEffect(client,conversation,{kind:'text',text:clarification},`grade-clarification:${cause}`);return;}}
  else if(node.config.variable)state.variables[canonicalSalesVariable(node.config.variable)]=text;delete state.waiting_node_id;
  conversation=await save(client,conversation,{...conversation.body,ai_pending:false,flow_state:state});await event(client,conversation,'workflow.customer_reply_received',{node_id:node.id,evidence_ref:cause},cause);await advanceWorkflow(client,conversation,'customer_reply');return;
 }
 if(conversation.body.flow_state?.waiting_for!=='commitment'){await interruptPendingRecipeEffects(client,conversation,cause);return;}const def=await definition(client,conversation);const node=waitingCommitmentNode(def.flow,conversation.body.flow_state);if(!node)return;const phrases:string[]=node.config.accepted_phrases??['acepto','me comprometo','confirmo mi compromiso'];const message=String(conversation.body.last_customer_text??'').trim().toLowerCase();if(!acceptsAgreement(message,phrases,node.config.classifier==='contextual_agreement')){await interruptPendingRecipeEffects(client,conversation,cause);return;}const order=await ensureOrder(client,conversation);if(!order||order.body.committed_at)return;await save(client,order,{...order.body,status:'COMMITTED',committed_at:(await nowFor(client,conversation)).toISOString(),commitment_evidence:cause});await cancelPendingRemarketingForContact(client,conversation,'AGREEMENT_ACCEPTED');const nextBody:Body={...conversation.body,stage:'COMMITTED',ai_pending:false};delete nextBody.followup_plan;delete nextBody.followup_stop_reason;conversation=await save(client,conversation,nextBody);await event(client,conversation,'order.committed',{order_id:order.id,source:'configured_customer_phrase'},cause);await deliver(client,conversation,'commitment_accepted',cause);await advanceWorkflow(client,conversation,'commitment');}
