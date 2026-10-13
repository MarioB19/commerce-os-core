import {recordProfileExecutor} from '../../../packages/db/src/profile-record-context.js';
import {assertCommercialClosure} from './commercial-closure.js';
import {prepareReceiptPolicyAnalysis} from './receipt-policy.js';
import {reconcileWarmupPool} from './warmup.js';
import {recognizeReceipt,refreshReceiptSale} from '../../../packages/db/src/receipt-sales.js';
import {cancelPendingRemarketingForContact,closeRemarketingCycle,withTransaction,getRecord,putRecord,listRecords,uuid,hash,stableJson,type QueryExecutor} from '@commerce/db';
import type {DomainRecord,Body} from '@commerce/contracts';
import {canonicalIdentity} from '@commerce/messaging';
import {parseReceiptExtraction,assessReceipt} from '../../../packages/domain/src/sales/receipt.js';
import {create,save,event,cancelPending,cancelCollectionPending,proposeEffect,nowFor} from './shared.js';
import {materializeMessage} from './inbound.js';
import {advanceWorkflow,ensureOrder,deliver} from './workflows.js';
export async function applyCommand(client:QueryExecutor,cmd:Body):Promise<Body>{
 if(cmd.kind==='mcl_sponsorship')throw new Error('SPONSORSHIP_RETIRED');
 const p=cmd.payload??{};const get=async(kind:string,id=cmd.resource_id)=>{const r=await getRecord(client,cmd.workspace_id,kind,id);if(!r||r.environment!==cmd.environment)throw new Error('RESOURCE_NOT_FOUND');return r;};

 if(cmd.kind==='warmup_reconcile'){
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`warmup-pool:${cmd.resource_id}`]);
  const target=(await client.query('SELECT * FROM warmup_pools WHERE id=$1 AND workspace_id=$2 AND environment=$3 FOR UPDATE',[cmd.resource_id,cmd.workspace_id,cmd.environment])).rows[0];
  if(!target)throw new Error('WARMUP_POOL_NOT_FOUND');if(p.expected_version!==target.version)throw new Error('VERSION_CONFLICT');
  const result=await reconcileWarmupPool(client,target);await client.query('UPDATE warmup_pools SET version=version+1,updated_at=now() WHERE id=$1',[target.id]);
  return{pool_id:target.id,version:target.version+1,...result,external_effects:0};
 }

 if(cmd.kind==='receipt_sales_backfill'){
  const results:Body[]=[];
  for(const candidate of p.candidates??[]){
   if(!candidate.eligible){results.push({receipt_id:candidate.receipt_id,status:'EXCEPTION'});continue;}
   await client.query('SAVEPOINT backfill_row');
   try{let r=await get('receipt',candidate.receipt_id);await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[r.body.conversation_id]);r=await get('receipt',r.id);
    if((await client.query('SELECT 1 FROM payment_contributions WHERE workspace_id=$1 AND environment=$2 AND receipt_id=$3',[cmd.workspace_id,cmd.environment,r.id])).rowCount){results.push({receipt_id:r.id,status:'ALREADY_RECOGNIZED'});continue;}
    if(r.version!==candidate.version)throw new Error('VERSION_CONFLICT');await recognizeReceipt(client,r,{actor:cmd.actor_id,cause:cmd.id,effectiveAt:candidate.effective_at,historical:true});results.push({receipt_id:r.id,status:'RECOGNIZED'});
   }catch(error){await client.query('ROLLBACK TO SAVEPOINT backfill_row');results.push({receipt_id:candidate.receipt_id,status:'EXCEPTION',reason:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'BACKFILL_FAILED'});}
  }return{results,external_effects:0};
 }
 if(cmd.kind==='simulation_start'){
  if(cmd.environment!=='SIMULATION')throw new Error('SIMULATION_ENVIRONMENT_REQUIRED');const account=await get('channel_account',p.account_id);if(account.body.provider!=='simulator')throw new Error('SIMULATOR_ACCOUNT_REQUIRED');const simulationId=cmd.resource_id&&/^[a-f0-9-]{36}$/.test(cmd.resource_id)?cmd.resource_id:uuid();let simulation=await getRecord(client,cmd.workspace_id,'simulation',simulationId);if(!simulation)simulation=await putRecord(client,{id:simulationId,workspaceId:cmd.workspace_id,environment:'SIMULATION',kind:'simulation',body:{status:'RUNNING',virtual_now:new Date().toISOString(),account_id:account.id,offer_version_id:p.offer_version_id,workflow_version_id:p.workflow_version_id,source:'explicit_local_simulation'}});
  if(!simulation.body.virtual_now)simulation=await save(client,simulation,{...simulation.body,virtual_now:new Date().toISOString()});
  const supplied=typeof p.initial_message==='string'?p.initial_message.trim():'';
  if((!supplied||supplied.length>4096)&&p.flow_test_mode==='ROUTING_SELECTION')throw new Error('SIMULATION_INITIAL_MESSAGE_REQUIRED');
  // Durable commands created by the legacy simulation API predate
  // initial_message. Preserve their deterministic greeting while the new
  // number-flow laboratory always supplies an explicit first turn.
  const initialMessage=supplied||'Hola, quiero información';
  const identity=`opaque:sim-${simulation.id}`;let conversation=await materializeMessage(client,account,{key:`simulation:${cmd.id}`,type:'message',providerAt:simulation.body.virtual_now,identity,text:initialMessage,kind:'text',payload:{simulation:true}},cmd.id,p.offer_version_id,p.workflow_version_id,p.contact_name??'Contacto simulado');if(!conversation)throw new Error('SIMULATION_CONVERSATION_CONFLICT');
  conversation=await save(client,conversation,{...conversation.body,simulation_id:simulation.id,flow_test_single_step:p.flow_test_mode==='ROUTING_SELECTION',ai_pending:false});simulation=await save(client,simulation,{...simulation.body,status:'RUNNING',conversation_id:conversation.id});await advanceWorkflow(client,conversation);return{simulation_id:simulation.id,conversation_id:conversation.id};
 }
 if(cmd.kind==='simulation_advance'){
  if(cmd.environment!=='SIMULATION')throw new Error('SIMULATION_ENVIRONMENT_REQUIRED');
  let simulation=await get('simulation');const seconds=Number(p.seconds);if(!Number.isFinite(seconds)||seconds<0||seconds>31_536_000)throw new Error('VIRTUAL_CLOCK_INVALID');
  const instant=new Date(new Date(simulation.body.virtual_now).getTime()+seconds*1000).toISOString();simulation=await save(client,simulation,{...simulation.body,virtual_now:instant});
  if(p.message){
   const conv=await get('conversation',simulation.body.conversation_id),account=await get('channel_account',simulation.body.account_id),contact=await get('contact',conv.body.contact_id);
   if(account.body.provider!=='simulator'||conv.body.account_id!==account.id||conv.body.simulation_id!==simulation.id)throw new Error('SIMULATION_SCOPE_INVALID');
   const selected=await materializeMessage(client,account,{key:`simulation:${cmd.id}`,type:'message',providerAt:instant,identity:contact.body.identity,text:p.message,kind:'text',payload:{simulation:true}},cmd.id);
   if(selected){
    let journey=await get('conversation',selected.id);
    if(journey.body.account_id!==account.id||journey.body.contact_id!==contact.id||journey.body.simulation_id&&journey.body.simulation_id!==simulation.id)throw new Error('SIMULATION_SCOPE_INVALID');
    // Routing may create another journey. Attach it before the command commits,
    // so dispatch never depends on a later UI action to repair simulation scope.
    if(journey.body.simulation_id!==simulation.id){journey=await save(client,journey,{...journey.body,simulation_id:simulation.id,flow_test_single_step:simulation.body.mode==='NUMBER_FLOW_TEST_V1',commercial_classification:'TEST',ai_pending:false});}
    if(simulation.body.conversation_id!==journey.id){simulation=await get('simulation',simulation.id);simulation=await save(client,simulation,{...simulation.body,conversation_id:journey.id,status:'RUNNING'});}
    if(!journey.body.flow_state)await advanceWorkflow(client,journey);
   }
  }else{const conv=await get('conversation',simulation.body.conversation_id);if(conv.body.flow_state?.waiting_for==='simulation_continue')await advanceWorkflow(client,conv,'simulation_continue');}
  if(p.event){if(!['commitment','human_approved'].includes(p.event))throw new Error('SIMULATION_EVENT_NOT_SUPPORTED');if(p.event==='commitment')await applyCommand(client,{...cmd,kind:'conversation_command',resource_id:simulation.body.conversation_id,payload:{type:'commitment'}});else await advanceWorkflow(client,await get('conversation',simulation.body.conversation_id),p.event);}
  return{simulation_id:simulation.id,seconds};
 }
 if(cmd.kind==='conversation_command'&&p.type==='global_controls')return{status:'APPLIED',reason:'DURABLE_WORKSPACE_CONTROLS_ALREADY_WRITTEN'};
 if(cmd.kind==='conversation_command'){
  let conversation=await get('conversation');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[conversation.id]);conversation=await get('conversation');
  // V7: effects under a permanent grant change only inside their own profile.
  await recordProfileExecutor(client,conversation.workspace_id,conversation.environment as 'REAL'|'SIMULATION');
  const type=p.type;
  if(type==='retirement_handoff'){await save(client,conversation,{...conversation.body,ai_pending:false,ai_status:'HUMAN_REVIEW',retirement_handoff:{resource_id:p.retirement_resource_id,reason:'CONFIGURATION_RETIRED',at:new Date().toISOString()},flow_state:{...(conversation.body.flow_state??{}),status:'HUMAN_REVIEW',waiting_for:'human_approved'}});await event(client,conversation,'conversation.retirement_handoff',{resource_id:p.retirement_resource_id},cmd.id);return{conversation_id:conversation.id,status:'HUMAN_REVIEW'};}
  if(type==='close_conversation'){
   const closureProof=await assertCommercialClosure(client,conversation,cmd);
   const closedAt=(await client.query('SELECT now()::text at')).rows[0].at;
   await cancelPending(client,conversation,'CONVERSATION_CLOSED');
   await save(client,conversation,{...conversation.body,status:'CLOSED',ai_pending:false,active_ai_run_id:null,closed_at:closedAt,closed_by:cmd.actor_id,closed_reason:p.reason,flow_state:{...(conversation.body.flow_state??{}),status:'FINISHED',waiting_for:null}});
   await event(client,conversation,'conversation.closed',{actor_id:cmd.actor_id,reason:p.reason,commercial_resolution:closureProof},cmd.id);return{conversation_id:conversation.id,status:'CLOSED',commercial_resolution:closureProof};
  }
  if((conversation.body.sponsorship_id||conversation.body.launch_test_role==='beneficiary')&&['commitment','receipt_received'].includes(type))throw new Error('SPONSORED_CONVERSATION_HAS_NO_PAYMENT_OBLIGATION');
  if(type==='approve_step'){const state=conversation.body.flow_state;const version=conversation.body.runtime_workflow_id??conversation.body.workflow_version_id??conversation.body.workflow_runtime_version;if(!cmd.actor_id||!p.reason)throw new Error('HUMAN_APPROVAL_EVIDENCE_REQUIRED');if(version!==p.expected_workflow_version_id||(state?.waiting_node_id??state?.node_id)!==p.expected_node_id)throw new Error('WORKFLOW_APPROVAL_INVALIDATED');if(state?.status!=='HUMAN_REVIEW')throw new Error('WORKFLOW_NOT_AWAITING_APPROVAL');await event(client,conversation,'workflow.step_approved',{workflow_version_id:version,node_id:p.expected_node_id,actor_id:cmd.actor_id,reason:p.reason},cmd.id);await advanceWorkflow(client,conversation,'human_approved');return{conversation_id:conversation.id};}
  if(type==='controls'){if(p.paused||p.takeover||p.suppressed){await cancelPending(client,conversation,'HUMAN_CONTROLS_CHANGED',!!p.suppressed);await cancelPendingRemarketingForContact(client,conversation,'HUMAN_CONTROLS_CHANGED');await closeRemarketingCycle(client,conversation,p.suppressed?'OPTED_OUT':'HUMAN_REVIEW','HUMAN_CONTROLS_CHANGED');}await event(client,conversation,'conversation.controls_applied',{control_version:p.control_version,paused:p.paused,takeover:p.takeover},cmd.id);return{conversation_id:conversation.id};}
  if(type==='edit_effect'){const effect=(await client.query('SELECT * FROM outbox WHERE id=$1 AND workspace_id=$2 AND conversation_id=$3 FOR UPDATE',[p.effect_id,cmd.workspace_id,conversation.id])).rows[0];if(!effect)throw new Error('EFFECT_NOT_FOUND');if(!['READY','BLOCKED'].includes(effect.status))throw new Error('EFFECT_ALREADY_IN_FLIGHT');if(effect.config_hash!==p.expected_config_hash)throw new Error('VERSION_CONFLICT');if(typeof p.text!=='string'||!p.text.trim()||p.text.length>4096)throw new Error('MESSAGE_INVALID');const payload={...effect.payload,text:p.text};const configHash=hash(stableJson({account_id:effect.account_id,contact_id:effect.contact_id,payload}));await client.query("UPDATE outbox SET payload=$2,config_hash=$3,approval_hash=NULL,authorization_id=NULL,status='BLOCKED',result=$4,updated_at=now() WHERE id=$1",[effect.id,payload,configHash,{reason:'APPROVAL_INVALIDATED_BY_EDIT'}]);await event(client,conversation,'effect.edited',{effect_id:effect.id,config_hash:configHash,reason:p.reason},cmd.id);return{effect_id:effect.id,config_hash:configHash};}
  if(type==='cancel_effect'){const effect=(await client.query('SELECT * FROM outbox WHERE id=$1 AND workspace_id=$2 AND conversation_id=$3 FOR UPDATE',[p.effect_id,cmd.workspace_id,conversation.id])).rows[0];if(!effect)throw new Error('EFFECT_NOT_FOUND');if(!['READY','BLOCKED'].includes(effect.status))throw new Error('EFFECT_ALREADY_IN_FLIGHT');await client.query("UPDATE outbox SET status='CANCELLED',result=$2,updated_at=now() WHERE id=$1",[effect.id,{reason:p.reason}]);return{effect_id:effect.id,status:'CANCELLED'};}
  if(type==='send_message'){if(typeof p.text!=='string'||p.text.length>4096)throw new Error('MESSAGE_INVALID');const effect=await proposeEffect(client,conversation,{kind:p.kind??'text',text:p.text,...(p.asset_id?{asset_id:p.asset_id}:{})},`command:${cmd.id}`,{actorKind:'human',authorizationId:p.authorization_id});return{effect_id:effect?.id};}
  if(type==='assign'){conversation=await save(client,conversation,{...conversation.body,assigned_to:p.assigned_to??p.user_id??null});await event(client,conversation,'conversation.assigned',{assigned_to:conversation.body.assigned_to},cmd.id);return{conversation_id:conversation.id};}
  if(type==='set_stage'){conversation=await save(client,conversation,{...conversation.body,stage:String(p.stage)});await event(client,conversation,'conversation.stage_changed',{stage:p.stage},cmd.id);return{conversation_id:conversation.id};}
  if(type==='consent'){Object.assign(p,p.consent??{});const contact=await get('contact',conversation.body.contact_id);if(!p.purpose||!p.source||!p.evidence||!p.observed_at)throw new Error('CONSENT_EVIDENCE_REQUIRED');await save(client,contact,{...contact.body,consent:{purpose:p.purpose,source:p.source,evidence:p.evidence,observed_at:p.observed_at,actor_id:cmd.actor_id}});await event(client,conversation,'contact.consent_recorded',{contact_id:contact.id,purpose:p.purpose},cmd.id);return{contact_id:contact.id};}
  if(type==='opt_out'){const contact=await get('contact',conversation.body.contact_id);await client.query(`INSERT INTO manual_controls(workspace_id,scope_type,scope_id,suppressed,reason,actor_id) VALUES($1,'contact',$2,true,'OPT_OUT',$3) ON CONFLICT(workspace_id,scope_type,scope_id) DO UPDATE SET suppressed=true,version=manual_controls.version+1,updated_at=now()`,[cmd.workspace_id,contact.id,cmd.actor_id]);await cancelPending(client,conversation,'OPT_OUT',true);await cancelPendingRemarketingForContact(client,conversation,'OPT_OUT');await closeRemarketingCycle(client,conversation,'OPTED_OUT','OPT_OUT');await save(client,contact,{...contact.body,status:'SUPPRESSED'});await event(client,conversation,'contact.opted_out',{contact_id:contact.id},cmd.id);return{contact_id:contact.id};}
  if(type==='commitment'){let order=await ensureOrder(client,conversation);if(!order)throw new Error('OFFER_REQUIRED');if(!order.body.committed_at&&(conversation.body.flow_state?.status!=='WAITING'||conversation.body.flow_state?.waiting_for!=='commitment'))throw new Error('WORKFLOW_NOT_AWAITING_COMMITMENT');if(!order.body.committed_at){order=await save(client,order,{...order.body,status:'COMMITTED',committed_at:(await nowFor(client,conversation)).toISOString(),commitment_evidence:cmd.id});await event(client,conversation,'order.committed',{order_id:order.id},cmd.id);}await cancelPendingRemarketingForContact(client,conversation,'AGREEMENT_ACCEPTED');const nextBody:Body={...conversation.body,stage:'COMMITTED'};delete nextBody.followup_plan;delete nextBody.followup_stop_reason;conversation=await save(client,conversation,nextBody);await deliver(client,conversation,'commitment_accepted',cmd.id);await advanceWorkflow(client,conversation,'commitment');return{order_id:order.id};}
  if(type==='receipt_received'){
   const order=await ensureOrder(client,conversation);if(!order)throw new Error('ORDER_REQUIRED');const asset=await get('asset',p.asset_id);if(!asset.body.storage_key)throw new Error('PROTECTED_RECEIPT_ASSET_REQUIRED');
   const duplicates=(await listRecords(client,cmd.workspace_id,'receipt',cmd.environment)).filter(r=>r.body.evidence_sha256===asset.body.sha256);
   const receipt=await create(client,conversation,'receipt',{order_id:order.id,conversation_id:conversation.id,asset_id:asset.id,evidence_sha256:asset.body.sha256,status:'HUMAN_REVIEW',analysis_status:'PENDING',source:cmd.environment==='SIMULATION'?'simulation_fixture':'private_upload',received_at:new Date().toISOString(),duplicate_of:duplicates[0]?.id??null});
   await cancelCollectionPending(client,conversation,'RECEIPT_RECEIVED');await save(client,order,{...order.body,receipt_status:'RECEIVED',status:'RECEIPT_RECEIVED',receipt_id:receipt.id});
   if(p.extraction&&cmd.environment==='SIMULATION')await applyReceiptAnalysis(client,receipt,p.extraction,cmd.id);await event(client,conversation,'receipt.received',{receipt_id:receipt.id,order_id:order.id},cmd.id);return{receipt_id:receipt.id,order_id:order.id};
  }
  throw new Error('CONVERSATION_COMMAND_UNSUPPORTED');
 }
 if(['order_classification','receipt_classification','order_attribution'].includes(cmd.kind)){
  const kind=cmd.kind==='receipt_classification'?'receipt':'order';let resource=await get(kind);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[resource.body.conversation_id??resource.id]);resource=await get(kind);await recordProfileExecutor(client,resource.workspace_id,resource.environment as 'REAL'|'SIMULATION');
  if(resource.version!==p.expected_version)throw new Error('VERSION_CONFLICT');if(!p.reason||!cmd.actor_id)throw new Error('DECISION_EVIDENCE_REQUIRED');
  const before=resource.body.commercial_classification??(kind==='order'?'COMMERCIAL':'GENUINE');
  if(cmd.kind==='order_attribution'){
   const touches=p.touchpoint_id?await get('touchpoint',p.touchpoint_id):null;if(touches&&touches.body.conversation_id!==resource.body.conversation_id)throw new Error('ATTRIBUTION_CONVERSATION_MISMATCH');
   const meta=(await client.query('SELECT * FROM meta_ad_metadata WHERE workspace_id=$1 AND environment=$2 AND meta_ad_account_id=$3 AND ad_id=$4',[cmd.workspace_id,cmd.environment,p.meta_ad_account_id,p.ad_id])).rows[0];if(!meta)throw new Error('AD_NOT_VERIFIED');
   resource=await save(client,resource,{...resource.body,attribution:{model:'manual_evidence_v1',classification:'manual',meta_ad_account_id:p.meta_ad_account_id,ad_id:p.ad_id,touchpoint_id:p.touchpoint_id??null,evidence_ref:p.evidence_ref,reason:p.reason,actor_id:cmd.actor_id,observed_at:p.observed_at}});
  }else{
   if(!(kind==='order'?['TEST','COMMERCIAL']:['FALSE','GENUINE']).includes(p.classification))throw new Error('CLASSIFICATION_INVALID');
   if(kind==='order'&&resource.body.simulation_id&&p.classification!=='TEST')throw new Error('SIMULATION_CLASSIFICATION_IMMUTABLE');
   if(kind==='receipt'&&p.classification==='GENUINE'){const asset=await get('asset',resource.body.asset_id);if(asset.body.status!=='READY'||!asset.body.storage_key)throw new Error('ORIGINAL_EVIDENCE_REQUIRED');}
   resource=await save(client,resource,{...resource.body,commercial_classification:p.classification,classification_decision:{previous:before,actor_id:cmd.actor_id,reason:p.reason,at:new Date().toISOString(),command_id:cmd.id}});
   await refreshReceiptSale(client,kind==='order'?resource:await get('order',resource.body.order_id));
  }
  await event(client,resource,cmd.kind==='order_attribution'?'sale.attribution_corrected':'sale.classification_changed',{previous:before,classification:p.classification??null,reason:p.reason,actor_id:cmd.actor_id,expected_version:p.expected_version},cmd.id);
  return{resource_id:resource.id,classification:p.classification??null};
 }
 if(cmd.kind==='receipt_review'){
  let receipt=await get('receipt');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[receipt.body.conversation_id]);receipt=await get('receipt');await recordProfileExecutor(client,receipt.workspace_id,receipt.environment as 'REAL'|'SIMULATION');if(p.expected_version!==undefined&&receipt.version!==p.expected_version)throw new Error('VERSION_CONFLICT');const conversation=await get('conversation',receipt.body.conversation_id);const decision=p.decision;if(conversation.body.sponsorship_id||conversation.body.launch_test_role==='beneficiary')throw new Error('SPONSORED_CONVERSATION_HAS_NO_PAYMENT_OBLIGATION');if(!['APPROVED','REJECTED','HUMAN_REVIEW'].includes(decision)||!p.reason)throw new Error('REVIEW_DECISION_REQUIRED');
  receipt=await save(client,receipt,{...receipt.body,status:decision,analysis_status:'HUMAN_REVIEWED',...(p.amount_minor!==undefined?{extraction:{...(receipt.body.extraction??{}),amount_minor:p.amount_minor,currency:p.currency??receipt.body.extraction?.currency??null,source:'human_observation',observed_by:cmd.actor_id}}:{}),review:{actor_id:cmd.actor_id,reason:p.reason,at:new Date().toISOString(),command_id:cmd.id}});const order=await get('order',receipt.body.order_id);await save(client,order,{...order.body,receipt_status:decision,status:decision==='APPROVED'?'RECEIPT_APPROVED':order.body.status,observed_amount_minor:receipt.body.extraction?.amount_minor??null});await event(client,conversation,'receipt.reviewed',{receipt_id:receipt.id,decision,reviewer_id:cmd.actor_id},cmd.id);if(decision==='APPROVED'){const sale=await recognizeReceipt(client,receipt,{actor:cmd.actor_id,cause:cmd.id,paymentKey:p.payment_key,replacesReceiptId:p.replaces_receipt_id});if(sale.firstRecognition)await completeReceiptSale(client,conversation,sale.order,cmd.id);else if(sale.newContribution)await deliver(client,conversation,'receipt_approved',cmd.id);}else{await refreshReceiptSale(client,await get('order',receipt.body.order_id));await event(client,receipt,'sale.receipt_review_changed',{decision,reason:p.reason,actor_id:cmd.actor_id},cmd.id);}return{receipt_id:receipt.id,decision};
 }
 if(cmd.kind==='order_reconcile'){
  let order=await get('order');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[order.body.conversation_id]);order=await get('order');await recordProfileExecutor(client,order.workspace_id,order.environment as 'REAL'|'SIMULATION');if(p.expected_version!==undefined&&order.version!==p.expected_version)throw new Error('VERSION_CONFLICT');if(order.body.reconciliation_status==='RECONCILED')throw new Error('ORDER_ALREADY_RECONCILED');if(!Number.isSafeInteger(p.amount_minor)||p.amount_minor<=0||p.currency!==order.body.currency||!p.reason)throw new Error('FINANCIAL_EVIDENCE_INVALID');const evidence=await get('asset',p.evidence_asset_id);if(!evidence.body.storage_key)throw new Error('PROTECTED_FINANCIAL_EVIDENCE_REQUIRED');const conversation=await get('conversation',order.body.conversation_id);await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[conversation.id]);await save(client,order,{...order.body,status:'RECONCILED',reconciliation_status:'RECONCILED',reconciled_amount_minor:p.amount_minor,reconciled_currency:p.currency,reconciled_at:new Date().toISOString(),reconciliation:{actor_id:cmd.actor_id,evidence_asset_id:evidence.id,reason:p.reason,command_id:cmd.id}});await cancelCollectionPending(client,conversation,'RECONCILED');await event(client,conversation,'order.reconciled',{order_id:order.id,amount_minor:p.amount_minor,currency:p.currency,evidence_asset_id:evidence.id,actor_id:cmd.actor_id},cmd.id);await deliver(client,conversation,'reconciled',cmd.id);await advanceWorkflow(client,conversation,'reconciled');return{order_id:order.id,status:'RECONCILED'};
 }
 if(cmd.kind==='import_contacts'){
  const batch=await get('import_batch');if(batch.body.status==='COMMITTED')return{import_id:batch.id};const rows=batch.body.valid_rows??batch.body.rows??[];let imported=0;
  for(const row of rows){const identity=canonicalIdentity(String(row.identity??row.external_id??''));if(!identity||identity==='opaque:')continue;await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${cmd.workspace_id}:${identity}`]);let contact=(await listRecords(client,cmd.workspace_id,'contact',cmd.environment)).find(r=>r.body.identity===identity);if(!contact){contact=await create(client,batch,'contact',{name:row.name??'Contacto importado',identity,identity_hash:hash(identity),status:'LEAD',stage:'IMPORTED',consent:row.consent??null,origin:row.origin??{classification:'unknown'},source:row.source??batch.body.source,provenance:row.provenance??null,identity_aliases:row.identity_aliases??[],import_batch_id:batch.id,external_id:row.external_id??null,tags:row.tags??[]});imported++;}
   // Imported histories remain provenance-bearing records; they never drive a live workflow.
   for(const [index,m]of(row.messages??[]).entries())await create(client,batch,'message',{contact_id:contact.id,direction:m.direction??'UNKNOWN',text:m.text??'',kind:m.kind??'text',provider_at:m.occurred_at??row.occurred_at??null,source:'import',import_batch_id:batch.id,external_id:m.external_id??`${row.external_id??identity}:${index}`,evidence_verified:false,provenance:{source:m.source??row.source??batch.body.source,prior_provenance:m.provenance??null,original:m}});
  }await save(client,batch,{...batch.body,status:'COMMITTED',imported_count:imported,committed_at:new Date().toISOString()});return{imported_count:imported};
 }
 if(cmd.kind==='campaign_schedule'){const campaign=await get('message_campaign');if(p.expected_version!==undefined&&p.expected_version!==campaign.version)throw new Error('APPROVAL_INVALIDATED');if(campaign.body.status==='CANCELLED')throw new Error('CAMPAIGN_CANCELLED');await save(client,campaign,{...campaign.body,status:'SCHEDULED',scheduled_at:p.scheduled_at??campaign.body.scheduled_at,authorization_id:p.authorization_id??campaign.body.authorization_id,approved_config_hash:p.config_hash??hash(stableJson(campaign.body)),approved_recipients:p.recipients??[],approved_snapshot:campaign.body,schedule_command_id:cmd.id});return{campaign_id:campaign.id,status:'SCHEDULED'};}
 if(cmd.kind==='campaign_cancel'){const campaign=await get('message_campaign');await save(client,campaign,{...campaign.body,status:'CANCELLED',cancelled_at:new Date().toISOString(),cancelled_reason:p.reason});await client.query(`UPDATE outbox SET status='CANCELLED',updated_at=now(),result=jsonb_build_object('reason','CAMPAIGN_CANCELLED') WHERE workspace_id=$1 AND payload->>'campaign_id'=$2 AND status IN ('READY','BLOCKED')`,[cmd.workspace_id,campaign.id]);return{campaign_id:campaign.id,status:'CANCELLED'};}
 throw new Error('COMMAND_KIND_UNSUPPORTED');
}
export async function applyReceiptAnalysis(client:QueryExecutor,receipt:DomainRecord,raw:unknown,cause:string){
 const prepared=await prepareReceiptPolicyAnalysis(client,receipt,raw,cause);
 if(prepared?.state==='EXISTING')return;
 if(prepared?.state==='PREPARED'){
  const {assessment,extraction}=prepared,decision=assessment.decision==='APPROVED'?'APPROVED':assessment.decision==='REJECTED'?'REJECTED':'HUMAN_REVIEW';
  receipt=await save(client,receipt,{...receipt.body,extraction,assessment,status:decision,analysis_status:'COMPLETED',analyzed_at:prepared.observedAt,policy_analysis:prepared.policyAnalysis,analysis_evidence_ciphertext:prepared.evidenceCiphertext});
  const order=await getRecord(client,receipt.workspace_id,'order',receipt.body.order_id);if(!order||order.environment!==receipt.environment)throw Error('ORDER_NOT_FOUND');
  await save(client,order,{...order.body,receipt_status:decision,observed_amount_minor:extraction.amount_minor,...(decision==='APPROVED'?{status:'RECEIPT_APPROVED'}:{})});
  const conversation=await getRecord(client,receipt.workspace_id,'conversation',receipt.body.conversation_id);if(!conversation||conversation.environment!==receipt.environment)throw Error('RECEIPT_POLICY_CONVERSATION_CHANGED');
  await event(client,conversation,'receipt.analyzed',{receipt_id:receipt.id,decision,reasons:assessment.reasons,policy_sha256:assessment.policySha256},cause);
  if(decision==='APPROVED'){const sale=await recognizeReceipt(client,receipt,{actor:'receipt-policy',cause});if(sale.firstRecognition)await completeReceiptSale(client,conversation,sale.order,cause);}
  return;
 }
const extraction=parseReceiptExtraction(raw);const order=await getRecord(client,receipt.workspace_id,'order',receipt.body.order_id);if(!order)throw new Error('ORDER_NOT_FOUND');const policy=order.body.receipt_policy_version_id?await getRecord(client,receipt.workspace_id,'receipt_policy',order.body.receipt_policy_version_id):undefined;const bank=order.body.payment_profile_version_id?await getRecord(client,receipt.workspace_id,'bank_profile',order.body.payment_profile_version_id):undefined;
 const duplicateReference=extraction.reference?(await client.query("SELECT id FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='receipt' AND id<>$3 AND body->'extraction'->>'reference'=$4 LIMIT 1",[receipt.workspace_id,receipt.environment,receipt.id,extraction.reference])).rows[0]:null;const assessment=assessReceipt(extraction,{amount_minor:order.body.amount_minor,currency:order.body.currency,destination_suffix:bank?.body.last4,duplicate:!!receipt.body.duplicate_of||!!duplicateReference,policy:policy?.body??{auto_approve:false}});if(order.body.launch_test_scope_id)assessment.decision='HUMAN_REVIEW';receipt=await save(client,receipt,{...receipt.body,extraction,assessment,status:assessment.decision,analysis_status:'COMPLETED',analyzed_at:new Date().toISOString()});await save(client,order,{...order.body,receipt_status:assessment.decision,observed_amount_minor:extraction.amount_minor,...(assessment.decision==='APPROVED'?{status:'RECEIPT_APPROVED'}:{})});const conversation=await getRecord(client,receipt.workspace_id,'conversation',receipt.body.conversation_id);if(conversation){await event(client,conversation,'receipt.analyzed',{receipt_id:receipt.id,decision:assessment.decision,reasons:assessment.reasons},cause);if(assessment.decision==='APPROVED'){const sale=await recognizeReceipt(client,receipt,{actor:'receipt-policy',cause});if(sale.firstRecognition)await completeReceiptSale(client,conversation,sale.order,cause);}}
}
export async function processCommands(limit=25){let count=0;for(let i=0;i<limit;i++){const done=await withTransaction(async client=>{const cmd=(await client.query(`SELECT * FROM commands WHERE status='PENDING' AND kind!='channel_command' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];if(!cmd)return false;await client.query('SAVEPOINT command_work');try{const result=await applyCommand(client,cmd);await client.query(`UPDATE commands SET status='APPLIED',result=$2,updated_at=now() WHERE id=$1`,[cmd.id,result]);}catch(error){await client.query('ROLLBACK TO SAVEPOINT command_work');const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'COMMAND_FAILED';await client.query(`UPDATE commands SET status='FAILED',result=$2,updated_at=now() WHERE id=$1`,[cmd.id,{error:code}]);}return true;});if(!done)break;count++;}return count;}

async function completeReceiptSale(client:QueryExecutor,conversation:DomainRecord,order:DomainRecord,cause:string){
 // First operational recognition only. Corrections, restoration and backfill never enter this function.
 await cancelCollectionPending(client,conversation,'RECEIPT_VALIDATED');
 await save(client,order,{...order.body,sale_effects_applied_at:new Date().toISOString()});
 await event(client,conversation,'order.payment_completed',{order_id:order.id,source:'validated_receipt'},cause);
 await deliver(client,conversation,'commitment_accepted',cause);
 await advanceWorkflow(client,conversation,'receipt_approved');
 const current=await getRecord(client,conversation.workspace_id,'conversation',conversation.id)??conversation;
 const workflow=current.body.workflow_version_id?await getRecord(client,current.workspace_id,'workflow',current.body.workflow_version_id):undefined;
 const nodes:Body[]=workflow?.body.nodes??current.body.workflow_snapshot?.nodes??[];
 const workflowOwnsPostpayment=nodes.some(node=>['fulfillment','post_receipt'].includes(String(node.type))&&['receipt_approved','reconciled'].includes(String(node.config?.release_on)));
 if(!workflowOwnsPostpayment)await deliver(client,current,'receipt_approved',cause);
}
