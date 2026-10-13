import {recordProfileExecutor} from '../../../packages/db/src/profile-record-context.js';
import {bindRecordEnvironment} from '../../../packages/db/src/profile-environment.js';
import {withNumberLabEngine,type NumberLabEngineLease} from '../../../packages/db/src/number-lab-engine-runtime.js';
import type {ProfileQuery} from '../../../packages/db/src/profile-context.js';
import {bindNumberLabDispatch,type NumberLabDispatch} from './catalog-simulator.js';
import {readContinuousEffectAuthority} from '../../../packages/db/src/continuous-effect.js';
import {lockedContinuousWorkerProfile,commercialContinuityAuthorityBlock,continuousInboundRecipient} from '../../../packages/db/src/continuous-commercial.js';
import {reserveDispatchCapacity} from './dispatch-capacity.js';
import {refreshEffectGroup,reconcileGroupDeliveries} from './warmup-group-dispatch.js';
import {assignmentFor,assignmentGate,chatLock,channelIdentityHash} from '../../../packages/db/src/commercial-assignments.js';
import {launchEffectBlockReason} from '../../../packages/db/src/launch-test-scope.js';
import {gateWarmupDispatch} from './warmup.js';
import {commercialWarmupGuard} from '../../../packages/db/src/warmup.js';
import {authorizedRecipient} from '../../../packages/domain/src/sales/authorization.js';
import {effectiveNumberFlowControls} from '../../../packages/db/src/number-flow-controls.js';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {withTransaction,query,getRecord,appendEvent,uuid,hash,stableJson,decrypt,encrypt,readOperationalSettings,setRemarketingAttemptStatus,verifiedTemplateCapabilityEvidence,type QueryExecutor} from '@commerce/db';
import {readEffectiveHealth,currentEffectiveSignal,currentProviderHealthReady} from '../../../packages/db/src/effective-health.js';
import {remarketingTransportTemplateSchema,type DomainRecord,type Body} from '@commerce/contracts';
import type {OutboundMessage,SendResult} from '@commerce/messaging';
import {StaticAccessFulfillmentProvider,parseStaticAccessReference} from '@commerce/fulfillment';
import {providerFor,fulfillmentProviderFor,assertGatewayIsolation,type ProviderFactory} from './providers.js';
export const ownerId=`${process.env.CHANNEL_OWNER_ID??'channel'}-${uuid()}`;
const terminalAccepted=new Set(['SENT','DELIVERED','READ']);
async function effectiveNow(client:QueryExecutor,conversation:DomainRecord|undefined,effect?:Body):Promise<Date>{
 if(effect?.kind==='warmup'&&effect.environment==='SIMULATION'){const run=(await client.query('SELECT r.virtual_now FROM warmup_simulation_runs r JOIN warmup_conversations v ON v.simulation_run_id=r.id WHERE v.id::text=$1 AND v.workspace_id=$2',[effect.conversation_id,effect.workspace_id])).rows[0];if(run)return new Date(run.virtual_now);}
 // Warm-up effects intentionally do not create sales conversations. Only a
 // persisted simulation conversation can opt into the laboratory clock.
 if(conversation?.environment==='SIMULATION'&&conversation.body.simulation_id){const simulation=await getRecord(client,conversation.workspace_id,'simulation',conversation.body.simulation_id);if(simulation?.body.virtual_now)return new Date(simulation.body.virtual_now);}
 return (await client.query('SELECT now() AS now')).rows[0].now as Date;
}
const cancelledGateReasons=new Set(['EFFECT_EXPIRED','CONTACT_SUPPRESSED','CONTROL_VERSION_CHANGED','COLLECTION_STOPPED','RECEIPT_RECEIVED','FOLLOWUP_INELIGIBLE','FOLLOWUP_WINDOW_CLOSED','TEMPLATE_MEDIA_UNSUPPORTED','TEMPLATE_TRANSPORT_UNSUPPORTED','TEMPLATE_PROVIDER_EVIDENCE_REQUIRED','HUMAN_TAKEOVER','BUYER_EXCLUDED','AGREEMENT_ACCEPTED','REMARKETING_INELIGIBLE','REMARKETING_CYCLE_CLOSED','REMARKETING_ATTEMPT_INACTIVE','CAUSAL_PREDECESSOR_FAILED']);
export async function gateDispatch(client:QueryExecutor,effect:Body,owner:string):Promise<{allowed:boolean;reason?:string;account?:DomainRecord;contact?:DomainRecord;leaseMs?:number}>{
 // Inside a profile scope, environment-bound tables (session ownership, custody)
 // are visible only with the effect's own environment bound to the transaction.
 await bindRecordEnvironment(client,effect.workspace_id,effect.environment);
 if(effect.kind==='warmup')return gateWarmupDispatch(client,effect,owner);
 const account=await getRecord(client,effect.workspace_id,'channel_account',effect.account_id),contact=await getRecord(client,effect.workspace_id,'contact',effect.contact_id),conversation=await getRecord(client,effect.workspace_id,'conversation',effect.conversation_id);
 const deny=(reason:string)=>({allowed:false,reason});if(!account||!contact||!conversation||account.environment!==effect.environment||contact.environment!==effect.environment||conversation.environment!==effect.environment)return deny('RESOURCE_SCOPE_INVALID');
 if(account.body.deleted_at)return deny('CHANNEL_ACCOUNT_DELETED');
 if(!effect.payload||typeof effect.payload!=='object'||Array.isArray(effect.payload))return deny('EFFECT_PAYLOAD_INVALID');
 let effectAsset:DomainRecord|undefined;
 if(effect.payload.asset_id){effectAsset=await getRecord(client,effect.workspace_id,'asset',effect.payload.asset_id);if(!effectAsset||effectAsset.environment!==effect.environment)return deny('ASSET_SCOPE_INVALID');if(effectAsset.body.delivery_eligible===false||effectAsset.body.usage==='MARKETING_REFERENCE'||effectAsset.body.storage_provider==='r2')return deny('ASSET_NOT_DELIVERY_ELIGIBLE');if(effectAsset.body.product_id&&effectAsset.body.product_id!==conversation.body.product_id)return deny('ASSET_PRODUCT_MISMATCH');}
 const assignmentBlock=await assignmentGate(client,conversation);if(assignmentBlock)return deny(assignmentBlock);
 if(conversation.body.assignment_id&&(effect.payload.assignment_id!==conversation.body.assignment_id||effect.payload.assignment_revision!==conversation.body.assignment_revision||effect.payload.product_id!==conversation.body.product_id||effect.payload.binding_id!==conversation.body.binding_id||effect.payload.journey_id!==conversation.id))return deny('EFFECT_ASSIGNMENT_CONTEXT_INVALID');
 if(effect.predecessor_id){let predecessorId=effect.predecessor_id;let depth=0;while(predecessorId){if(++depth>100)return deny('CAUSAL_CHAIN_LIMIT');const predecessor=(await client.query('SELECT status,predecessor_id,attempts,result FROM outbox WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND conversation_id=$4',[predecessorId,effect.workspace_id,effect.environment,effect.conversation_id])).rows[0];if(!predecessor)return deny('CAUSAL_PREDECESSOR_UNRESOLVED');if(terminalAccepted.has(predecessor.status))break;if(predecessor.status==='CANCELLED'&&predecessor.attempts===0&&predecessor.result?.superseded_before_send===true){predecessorId=predecessor.predecessor_id;continue;}if(['FAILED','CANCELLED'].includes(predecessor.status))return deny('CAUSAL_PREDECESSOR_FAILED');return deny('CAUSAL_PREDECESSOR_UNRESOLVED');}}
 const flight=(await client.query("SELECT 1 FROM outbox WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND contact_id=$4 AND id<>$5 AND status IN('SENDING','UNKNOWN') LIMIT 1",[effect.workspace_id,effect.environment,effect.account_id,effect.contact_id,effect.id])).rowCount;if(flight)return deny('SHARED_CHAT_UNRESOLVED_EFFECT');
 const chat=(await client.query('SELECT active_journey_id FROM physical_chats WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND contact_id=$4',[effect.workspace_id,effect.environment,effect.account_id,effect.contact_id])).rows[0];if(chat?.active_journey_id&&chat.active_journey_id!==conversation.id&&effect.payload.actor_kind!=='human'&&!effect.payload.fulfillment_id&&effect.payload.kind!=='grant')return deny('SHARED_CHAT_OTHER_PRODUCT_TURN');
 const launchBlock=await launchEffectBlockReason(client,conversation,effect.payload);if(launchBlock)return deny(launchBlock);
 const warmupBlock=await commercialWarmupGuard(client,account);if(warmupBlock)return deny(warmupBlock);
 if(effect.environment==='SIMULATION'&&account.body.provider!=='simulator')return deny('SIMULATION_EXTERNAL_PROVIDER_DENIED');
 const policy=await readOperationalSettings(client,effect.workspace_id,effect.environment,{lock:'share'});
 if(effect.environment==='REAL'&&(policy.body.dispatch_frozen||!policy.body.real_sends_enabled||!policy.body.allow_real_operations))return deny('REAL_OPERATION_NOT_ENABLED');
 if(effect.environment==='REAL'&&account.body.sending_enabled!==true)return deny('ACCOUNT_SENDING_NOT_ENABLED');
 const now=await effectiveNow(client,conversation);if(new Date(effect.expires_at)<=now)return deny('EFFECT_EXPIRED');
 const parsedTemplate=effect.payload.kind==='template'?remarketingTransportTemplateSchema.safeParse(effect.payload.template):undefined;
 const templateTransportCompatible=parsedTemplate?.success&&(effect.environment==='SIMULATION'&&account.body.provider==='simulator'||effect.environment==='REAL'&&account.body.provider==='cloud');
 const templateMediaEligible=parsedTemplate?.success&&effect.payload.template_header_kind==='video'&&effect.payload.remarketing_template_medium==='video'&&effectAsset?.body.kind==='file'&&effectAsset.body.mime_type==='video/mp4'&&effectAsset.body.status==='READY';
 const evidenceId=typeof effect.payload.template_provider_evidence_id==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(effect.payload.template_provider_evidence_id)?effect.payload.template_provider_evidence_id:undefined;
 const bodyTextSha256=typeof effect.payload.template_body_text_sha256==='string'&&/^[a-f0-9]{64}$/.test(effect.payload.template_body_text_sha256)&&hash(String(effect.payload.text??''))===effect.payload.template_body_text_sha256?effect.payload.template_body_text_sha256:undefined;
 const templateEvidence=parsedTemplate?.success&&templateTransportCompatible&&templateMediaEligible&&effect.environment==='REAL'&&evidenceId&&bodyTextSha256
  ?await verifiedTemplateCapabilityEvidence(client,{workspaceId:effect.workspace_id,environment:'REAL',accountId:account.id,name:parsedTemplate.data.name,language:parsedTemplate.data.language,headerKind:'video',bodyTextSha256,evidenceId})
  :undefined;
 const eligibleTemplate=parsedTemplate?.success&&templateTransportCompatible&&templateMediaEligible&&(effect.environment==='SIMULATION'||!!templateEvidence);
 const controls=await effectiveNumberFlowControls(client,conversation,(await client.query(`SELECT * FROM manual_controls WHERE workspace_id=$1 AND ((scope_type='workspace' AND scope_id=$1) OR (scope_type='conversation' AND scope_id=$2) OR (scope_type='contact' AND scope_id=$3) OR (scope_type='channel_account' AND scope_id=$4) OR (scope_type='workflow' AND scope_id=$5)) FOR SHARE`,[effect.workspace_id,effect.conversation_id,effect.contact_id,effect.account_id,effect.payload.workflow_version_id??''])).rows);
 if(controls.some(x=>x.suppressed))return deny('CONTACT_SUPPRESSED');if(controls.some(x=>x.paused))return deny('OPERATION_PAUSED');if(effect.payload.actor_kind!=='human'&&controls.some(x=>x.takeover))return deny('HUMAN_TAKEOVER');
 const controlVersion=controls.filter(x=>x.scope_type==='conversation').reduce((m,x)=>Math.max(m,x.version),0);if(controlVersion!==effect.control_version&&effect.payload.actor_kind!=='human')return deny('CONTROL_VERSION_CHANGED');
 if(contact.body.status==='SUPPRESSED')return deny('CONTACT_SUPPRESSED');
 if(['collection','followup','remarketing'].includes(effect.payload.purpose)){
  if(conversation.body.collection_stop_reason)return deny('COLLECTION_STOPPED');
  const order=(await client.query(`SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='order' AND body->>'conversation_id'=$3 LIMIT 1`,[effect.workspace_id,effect.environment,conversation.id])).rows[0];
  const receiptExists=(await client.query(`SELECT 1 FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='receipt' AND body->>'conversation_id'=$3 LIMIT 1`,[effect.workspace_id,effect.environment,conversation.id])).rowCount;
  if(receiptExists||order?.body.receipt_status&&order.body.receipt_status!=='NONE'||Number(order?.body.sale_amount_minor)>0||order?.body.reconciliation_status==='RECONCILED')return deny('RECEIPT_RECEIVED');
  if(effect.payload.purpose==='followup'&&effect.payload.followup_plan_key){
   const plan=conversation.body.followup_plan;
   if(!order?.body.committed_at||conversation.body.followup_stop_reason||conversation.body.ai_status==='HUMAN_REVIEW'||conversation.body.flow_state?.status==='HUMAN_REVIEW'||plan?.status!=='SCHEDULED'||plan.key!==effect.payload.followup_plan_key||![1,2].includes(effect.payload.followup_touch))return deny('FOLLOWUP_INELIGIBLE');
   const last=new Date(conversation.body.last_inbound_at??0).getTime();if(!Number.isFinite(last)||last>now.getTime()||now.getTime()-last>=24*3600_000)return deny('FOLLOWUP_WINDOW_CLOSED');
   const core=(await client.query(`SELECT o.status,o.provider_message_id FROM records f LEFT JOIN outbox o ON o.id::text=f.body->>'effect_id' AND o.workspace_id=f.workspace_id WHERE f.workspace_id=$1 AND f.environment=$2 AND f.kind='fulfillment' AND f.body->>'conversation_id'=$3 AND f.body->>'release_on'='commitment_accepted'`,[effect.workspace_id,effect.environment,conversation.id])).rows;
   if(!core.length||core.some(e=>!terminalAccepted.has(e.status)||!e.provider_message_id))return deny('FOLLOWUP_INELIGIBLE');
  }
  if(effect.payload.purpose==='remarketing'){
   if((await client.query('SELECT 1 FROM commercial_buyer_exclusions WHERE workspace_id=$1 AND environment=$2 AND contact_id=$3',[effect.workspace_id,effect.environment,effect.contact_id])).rowCount)return deny('BUYER_EXCLUDED');
   const attempt=(await client.query(
    `SELECT a.*,c.status AS cycle_status,c.source_conversation_id,c.contact_id AS cycle_contact_id
     FROM commercial_remarketing_attempts a JOIN commercial_remarketing_cycles c ON c.id=a.cycle_id
     WHERE a.id=$1 AND a.cycle_id=$2 AND a.workspace_id=$3 AND a.environment=$4 FOR SHARE`,
    [effect.payload.remarketing_attempt_id,effect.payload.remarketing_cycle_id,effect.workspace_id,effect.environment],
   )).rows[0];
   if(!attempt||attempt.conversation_id!==conversation.id||attempt.cycle_contact_id!==effect.contact_id||attempt.slot_id!==effect.payload.remarketing_slot_id||attempt.stage!==effect.payload.remarketing_stage)return deny('REMARKETING_INELIGIBLE');
   if(attempt.cycle_status!=='OPEN')return deny('REMARKETING_CYCLE_CLOSED');
   if(attempt.status==='UNKNOWN')return deny('REMARKETING_ATTEMPT_UNRESOLVED');
   if(!['PROPOSED','SENT','DELIVERED'].includes(attempt.status))return deny('REMARKETING_ATTEMPT_INACTIVE');
   const plan=conversation.body.followup_plan;
   if(conversation.body.followup_stop_reason||plan?.status!=='SCHEDULED'||plan.key!==effect.payload.followup_plan_key)return deny('REMARKETING_INELIGIBLE');
   const last=new Date(conversation.body.last_inbound_at??0).getTime();if(!Number.isFinite(last)||last>now.getTime()||now.getTime()-last>=24*3600_000){if(!parsedTemplate?.success)return deny('FOLLOWUP_WINDOW_CLOSED');if(!templateTransportCompatible)return deny('TEMPLATE_TRANSPORT_UNSUPPORTED');if(!templateMediaEligible)return deny('TEMPLATE_MEDIA_UNSUPPORTED');if(effect.environment==='REAL'&&!templateEvidence)return deny('TEMPLATE_PROVIDER_EVIDENCE_REQUIRED');if(!eligibleTemplate)return deny('FOLLOWUP_WINDOW_CLOSED');}
   if(effect.payload.remarketing_stage==='AGREEMENT'){
    if(order?.body.committed_at||order?.body.status==='COMMITTED')return deny('AGREEMENT_ACCEPTED');
   }else if(effect.payload.remarketing_stage==='COLLECTION'){
    if(!order?.body.committed_at)return deny('REMARKETING_INELIGIBLE');
    const core=(await client.query(`SELECT o.status,o.provider_message_id FROM records f LEFT JOIN outbox o ON o.id::text=f.body->>'effect_id' AND o.workspace_id=f.workspace_id WHERE f.workspace_id=$1 AND f.environment=$2 AND f.kind='fulfillment' AND f.body->>'conversation_id'=$3 AND f.body->>'release_on'='commitment_accepted'`,[effect.workspace_id,effect.environment,conversation.id])).rows;
    if(!core.length||core.some(e=>!terminalAccepted.has(e.status)||!e.provider_message_id))return deny('REMARKETING_INELIGIBLE');
   }else return deny('REMARKETING_INELIGIBLE');
  }
 }

 if(effect.payload.after_previous_confirmed_seconds!==undefined){
  const delay=Number(effect.payload.after_previous_confirmed_seconds);if(!Number.isFinite(delay)||delay<0||delay>30||!effect.predecessor_id)return deny('CAUSAL_DELAY_INVALID');
  const previous=(await client.query('SELECT status,result,updated_at FROM outbox WHERE id=$1 AND workspace_id=$2 AND conversation_id=$3',[effect.predecessor_id,effect.workspace_id,effect.conversation_id])).rows[0];
  if(!previous||!terminalAccepted.has(previous.status))return deny('CAUSAL_PREDECESSOR_UNRESOLVED');
  if(now.getTime()<new Date(previous.result?.accepted_at??previous.updated_at).getTime()+delay*1000)return deny('CAUSAL_DELAY_PENDING');
 }
 const flowTest=effect.environment==='SIMULATION'&&account.body.provider==='simulator'&&account.body.flow_test_transport==='ISOLATED_SIMULATOR'&&conversation.body.simulation_id
  ?await getRecord(client,effect.workspace_id,'simulation',conversation.body.simulation_id):undefined;
 const isolatedFlowTest=flowTest?.environment==='SIMULATION'&&flowTest.body.mode==='NUMBER_FLOW_TEST_V1'&&flowTest.body.account_id===account.id;
 const ownership=isolatedFlowTest?undefined:(await client.query('SELECT *,extract(epoch FROM (lease_expires_at-now()))*1000 AS lease_ms FROM session_ownership WHERE account_id=$1 AND workspace_id=$2 FOR SHARE',[account.id,account.workspace_id])).rows[0];
 if(!isolatedFlowTest&&(!ownership||ownership.owner_id!==owner||ownership.frozen||Number(ownership.lease_ms)<2000))return deny('OWNERSHIP_NOT_CONFIRMED');
 if(account.body.status!=='WORKING')return deny('SESSION_NOT_WORKING');
 if(effect.environment==='REAL'&&account.body.provider==='waha'){
  if(account.body.identity_verified!==true||account.body.identity_conflict===true)return deny('CONNECTED_IDENTITY_NOT_CONFIRMED');
  try{await assertGatewayIsolation(account,client);}catch{return deny('CHANNEL_GATEWAY_ISOLATION_NOT_CONFIRMED');}
 }
 // Business scheduling follows the laboratory clock, but simulator liveness is
 // observed in wall time. Advancing a simulation must not age out a health read
 // that was just produced by the isolated provider.
 const healthNow=effect.environment==='SIMULATION'&&account.body.provider==='simulator'?new Date():now;
 const health=isolatedFlowTest?undefined:await readEffectiveHealth(client,{workspaceId:effect.workspace_id,environment:effect.environment,accountId:account.id,now:healthNow});
 const sessionSignal=health?currentEffectiveSignal(health,'session'):undefined,transportSignal=health?currentEffectiveSignal(health,'transport'):undefined;
 const transportIdentity=transportSignal?.value&&typeof transportSignal.value==='object'&&!Array.isArray(transportSignal.value)?(transportSignal.value as Body).identity_fingerprint:undefined;
 if(!isolatedFlowTest&&account.body.provider==='cloud'&&transportSignal?.status!=='OK')return deny('TRANSPORT_HEALTH_STALE');
 if(!isolatedFlowTest&&effect.environment==='REAL'&&account.body.provider==='waha'&&(transportSignal?.status!=='OK'||transportIdentity!==account.body.identity_fingerprint))return deny('CONNECTED_IDENTITY_EVIDENCE_STALE');
 if(!isolatedFlowTest&&account.body.provider!=='cloud'&&sessionSignal?.status!=='OK')return deny('SESSION_HEALTH_STALE');
 if(health&&!currentProviderHealthReady(health,String(account.body.provider)))return deny('CHANNEL_HEALTH_BLOCKED');
 const expectedHash=hash(stableJson({account_id:effect.account_id,contact_id:effect.contact_id,payload:effect.payload}));if(expectedHash!==effect.config_hash)return deny('EFFECT_CONFIG_CHANGED');
 if(effect.environment==='SIMULATION'){if(effect.approval_hash!==effect.config_hash)return deny('SIMULATION_APPROVAL_INVALIDATED');}
 else {
  const offer=await getRecord(client,effect.workspace_id,'offer',effect.payload.offer_version_id??'');if(!offer||offer.body.status!=='PUBLISHED')return deny('PUBLISHED_OFFER_REQUIRED');if(effect.payload.workflow_version_id){const workflow=await getRecord(client,effect.workspace_id,'workflow',effect.payload.workflow_version_id);if(!workflow||workflow.body.status!=='PUBLISHED')return deny('PUBLISHED_WORKFLOW_REQUIRED');}
  if(effect.continuous_authorization_id){
   const db=await recordProfileExecutor(client,effect.workspace_id,effect.environment);
   await lockedContinuousWorkerProfile(db);
   const read=await readContinuousEffectAuthority(db,'REAL',effect.id);if(read.state==='EXPIRED')return deny(read.reason);
   const reason=commercialContinuityAuthorityBlock(read.authorization,effect.workspace_id,'REAL',{
    assignmentId:conversation.body.assignment_id,assignmentRevision:conversation.body.assignment_revision,bindingId:conversation.body.binding_id,
    accountId:account.id,productId:conversation.body.product_id});
   if(reason)return deny(reason);
   if(effect.authorization_id||effect.approval_hash!==effect.config_hash)return deny('CONTINUITY_EFFECT_APPROVAL_INVALID');
   if(effect.payload.campaign_id)return deny('CAMPAIGN_AUTHORIZATION_REQUIRED');
   if(!continuousInboundRecipient(conversation,contact,now,!!eligibleTemplate))return deny('CONTINUITY_INBOUND_CONSENT_REQUIRED');
  }else{
  const auth=(await client.query(`SELECT * FROM read_locked_operation_authorization($1,$2,'REAL')`,[effect.authorization_id,effect.workspace_id])).rows[0];if(!auth)return deny('AUTHORIZATION_MISSING_OR_EXPIRED');
  if(auth.configuration_version!==policy.version)return deny('CONFIGURATION_CHANGED');
  const scope=auth.scope??{};if(conversation.body.assignment_id){const assignment=await assignmentFor(client,effect.workspace_id,effect.environment,conversation.body.assignment_id);if(!assignment||scope.mode!=='product_assignment'||scope.channel_identity_hash!==channelIdentityHash(account)||assignment.authorization_id!==auth.id||scope.assignment_id!==assignment.id||scope.assignment_revision!==assignment.revision||scope.binding_id!==assignment.binding_id||scope.product_id!==conversation.body.product_id||(scope.agent_version_id??null)!==(conversation.body.agent_version_id??null))return deny('PRODUCT_ASSIGNMENT_NOT_AUTHORIZED');}if(scope.mode==='channel_setup'&&(scope.assignment_revision!==account.body.assignment_revision||account.body.active_authorization_id!==auth.id||(scope.agent_version_id??null)!==(conversation.body.agent_version_id??null)))return deny('CHANNEL_ASSIGNMENT_CHANGED');if(!Array.isArray(scope.account_ids)||!scope.account_ids.includes(account.id))return deny('ACCOUNT_NOT_AUTHORIZED');if(!Array.isArray(scope.offer_version_ids)||!scope.offer_version_ids.includes(effect.payload.offer_version_id))return deny('OFFER_VERSION_NOT_AUTHORIZED');if(effect.payload.workflow_version_id&&(!Array.isArray(scope.workflow_version_ids)||!scope.workflow_version_ids.includes(effect.payload.workflow_version_id)))return deny('WORKFLOW_VERSION_NOT_AUTHORIZED');
  if(effect.payload.actor_kind!=='human'&&!scope.allow_automation)return deny('AUTOMATION_NOT_AUTHORIZED');
  if(!authorizedRecipient(auth,effect.contact_id,conversation,now.getTime()))return deny('RECIPIENT_NOT_AUTHORIZED');
  if(auth.config_hash!==(effect.payload.approval_config_hash??effect.config_hash)||effect.approval_hash!==effect.config_hash)return deny('APPROVAL_INVALIDATED');
  const count=Number((await client.query(`SELECT count(*) FROM outbox WHERE authorization_id=$1 AND id<>$2 AND status IN('SENDING','SENT','DELIVERED','READ','UNKNOWN')`,[auth.id,effect.id])).rows[0].count);if(!Number.isSafeInteger(scope.max_messages)||count>=scope.max_messages)return deny('AUTHORIZATION_MESSAGE_LIMIT');
  if(effect.payload.campaign_id&&scope.campaign_id!==effect.payload.campaign_id)return deny('CAMPAIGN_AUTHORIZATION_REQUIRED');
  }
 }
 if(effect.payload.campaign_id){const campaign=await getRecord(client,effect.workspace_id,'message_campaign',effect.payload.campaign_id);if(!campaign||!['EXECUTING','SCHEDULED'].includes(campaign.body.status))return deny('CAMPAIGN_CANCELLED_OR_PAUSED');if(campaign.body.message!==effect.payload.text||campaign.body.approved_snapshot?.message!==campaign.body.message)return deny('CAMPAIGN_CONFIG_CHANGED');if(!contact.body.consent?.evidence||!['marketing','messages'].includes(contact.body.consent?.purpose)||!contact.body.consent?.source||!contact.body.consent?.observed_at)return deny('CAMPAIGN_CONSENT_REQUIRED');}
 const inboundAt=new Date(conversation.body.last_inbound_at??0).getTime();const inWindow=now.getTime()-inboundAt<24*3600_000;
 const windowTemplateEligible=effect.payload.purpose==='remarketing'?eligibleTemplate:effect.payload.kind==='template'&&effect.payload.template?.approved===true;
 if(account.body.provider==='cloud'&&!inWindow&&!windowTemplateEligible)return deny('BUSINESS_WINDOW_CLOSED');
 if(effect.environment==='REAL'&&!inWindow&&!contact.body.consent?.evidence)return deny('CONSENT_EVIDENCE_REQUIRED');
 if(!isolatedFlowTest){const recent=(await client.query(`SELECT count(*) FROM outbox WHERE workspace_id=$1 AND contact_id=$2 AND id<>$3 AND status IN('SENDING','SENT','DELIVERED','READ','UNKNOWN') AND claimed_at>$4::timestamptz-interval '1 minute'`,[effect.workspace_id,effect.contact_id,effect.id,now.toISOString()])).rows[0];if(Number(recent.count)>=policy.body.contact_messages_per_minute)return deny('CONTACT_FREQUENCY_LIMIT');}
 return{allowed:true,account,contact,leaseMs:isolatedFlowTest?60_000:Number(ownership.lease_ms)};
}
async function outbound(effect:Body,contact:DomainRecord,client:QueryExecutor):Promise<OutboundMessage>{
 const message:OutboundMessage={effectId:effect.id,recipient:contact.body.identity,kind:effect.payload.kind??'text',text:effect.payload.text,template:effect.payload.template};
 if(effect.payload.grant_effect_id){const grant=(await client.query('SELECT result,status FROM outbox WHERE id=$1 AND workspace_id=$2',[effect.payload.grant_effect_id,effect.workspace_id])).rows[0];if(!grant||!terminalAccepted.has(grant.status)||!grant.result?.access_ciphertext)throw new Error('GRANT_NOT_CONFIRMED');const access=JSON.parse(decrypt(grant.result.access_ciphertext));message.kind='text';message.text=[access.instructions,access.url,access.code].filter(Boolean).join('\n');}
 if(effect.payload.asset_id){const asset=await getRecord(client,effect.workspace_id,'asset',effect.payload.asset_id);if(!asset)throw new Error('ASSET_NOT_FOUND');
 if(asset.body.kind==='link'){message.kind='text';message.text=asset.body.url;}
 else if(asset.body.kind==='access'){const secret=JSON.parse(decrypt(asset.body.delivery_ciphertext));if(secret.adapter==='webhook')throw new Error('ACCESS_WEBHOOK_REQUIRES_DELIVERY_ADAPTER');message.kind='text';const access=secret.adapter==='link'?parseStaticAccessReference(secret.delivery_reference):undefined;message.text=access?[access.instructions,access.url,access.code].filter(Boolean).join('\n'):secret.delivery_reference;}
 else{const root=process.env.PRIVATE_STORAGE_DIR??process.env.ASSET_STORAGE_DIR;if(!root||!/^[a-f0-9-]{36}(?:-[a-f0-9]{64})?$/.test(asset.body.storage_key))throw new Error('PRIVATE_STORAGE_NOT_CONFIGURED');const encrypted=await readFile(join(root,'assets',`${asset.body.storage_key}.enc`),'utf8');message.media={bytes:Buffer.from(decrypt(encrypted),'base64'),mimeType:asset.body.mime_type,filename:asset.body.name};}
 }return message;
}
async function scheduleGateRecheck(client:QueryExecutor,effectId:string,reason:string){await client.query(`INSERT INTO outbox_gate_schedule(effect_id,next_check_at,last_reason,updated_at)
 SELECT o.id,now()+CASE WHEN o.environment='SIMULATION' THEN interval '0 seconds' ELSE interval '1 second' END,$2,now()
 FROM outbox o WHERE o.id=$1
 ON CONFLICT(effect_id) DO UPDATE SET next_check_at=EXCLUDED.next_check_at,last_reason=EXCLUDED.last_reason,updated_at=now()`,[effectId,reason]);}
/** Release only this still-owned claim when execution has not reached the provider.
 * UNKNOWN and changed claims retain their fencing and admission reservations. */
async function releaseUnsentClaim(client:QueryExecutor,effectId:string,claimId:string,owner:string,reason:string){
 const effect=(await client.query("SELECT * FROM outbox WHERE id=$1 AND claim_id=$2 AND status='SENDING' FOR UPDATE",[effectId,claimId])).rows[0];
 if(!effect)return;
 const attempts=Math.max(0,Number(effect.attempts)-1),cancelled=cancelledGateReasons.has(reason),status=cancelled?'CANCELLED':'BLOCKED';
 const result={reason,external_attempt:false,...(cancelled&&['collection','followup','remarketing'].includes(effect.payload.purpose)?{superseded_before_send:attempts===0}:{})};
 await client.query('UPDATE outbox SET status=$2,result=$3,attempts=$4,claim_id=NULL,claimed_at=NULL,updated_at=now() WHERE id=$1',[effect.id,status,result,attempts]);
 await client.query("UPDATE effect_attempts SET status='NOT_SENT',result=$3,finished_at=now() WHERE effect_id=$1 AND claim_id=$2",[effect.id,claimId,{reason,external_attempt:false}]);
 await client.query('UPDATE number_dispatch_slots SET released_at=now() WHERE effect_id=$1 AND owner_id=$2 AND released_at IS NULL',[effect.id,owner]);
 if(cancelled){
  await client.query('DELETE FROM outbox_gate_schedule WHERE effect_id=$1',[effect.id]);
  if(effect.payload.remarketing_attempt_id)await setRemarketingAttemptStatus(client,{attemptId:effect.payload.remarketing_attempt_id,workspaceId:effect.workspace_id,environment:effect.environment},'CANCELLED',{reason});
 }else await scheduleGateRecheck(client,effect.id,reason);
 await appendEvent(client,{workspace_id:effect.workspace_id,environment:effect.environment,event_type:'effect.not_sent',aggregate_id:effect.conversation_id,causation_id:effect.id,actor:{type:'channel',id:owner},payload:{effect_id:effect.id,claim_id:claimId,status,reason,external_attempt:false}});
}
type DispatchStore={query:ProfileQuery;transaction<T>(work:(db:QueryExecutor)=>Promise<T>):Promise<T>};
async function dispatchOutboxImpl(store:DispatchStore,limit:number,factory:ProviderFactory,owner:string,lab?:ReturnType<typeof bindNumberLabDispatch>){const reader:QueryExecutor={query:store.query};const candidates=(await store.query(`WITH clocks AS MATERIALIZED (SELECT o.id,o.account_id,o.conversation_id,o.workspace_id,o.environment,o.dispatch_sequence,o.created_at AS first_seen_at,o.not_before,g.next_check_at,g.updated_at AS gate_checked_at,CASE WHEN o.environment='SIMULATION' THEN COALESCE(wr.virtual_now,(s.body->>'virtual_now')::timestamptz,now()) ELSE now() END AS effective_now FROM outbox o LEFT JOIN outbox_gate_schedule g ON g.effect_id=o.id LEFT JOIN records c ON c.id::text=o.conversation_id AND c.workspace_id=o.workspace_id LEFT JOIN records s ON s.id::text=c.body->>'simulation_id' AND s.workspace_id=c.workspace_id LEFT JOIN warmup_conversations wv ON wv.id::text=o.conversation_id AND o.kind='warmup' LEFT JOIN warmup_simulation_runs wr ON wr.id=wv.simulation_run_id WHERE o.status IN ('READY','BLOCKED') ${lab?"AND o.account_id=$2 AND o.conversation_id=$3 AND o.workspace_id=$4 AND o.environment='SIMULATION' AND o.kind<>'warmup'":''}),fair AS MATERIALIZED (SELECT clocks.*,COALESCE(gate_checked_at,first_seen_at) AS considered_at,row_number() OVER(PARTITION BY account_id ORDER BY COALESCE(gate_checked_at,first_seen_at),dispatch_sequence) AS account_rank FROM clocks WHERE not_before<=effective_now AND (next_check_at IS NULL OR next_check_at<=now())) SELECT id,account_id,conversation_id,workspace_id,environment FROM fair ORDER BY account_rank,considered_at,dispatch_sequence LIMIT $1`,lab?[limit,lab.scope.accountId,lab.scope.conversationId,lab.scope.workspaceId]:[limit])).rows;let sent=0;
 const grouped=new Map<string,typeof candidates>();for(const item of candidates){const group=grouped.get(item.account_id)??[];group.push(item);grouped.set(item.account_id,group);}const dispatchGroup=async(items:typeof candidates)=>{for(const item of items){try{if(!lab)await refreshEffectGroup(item.id,factory);}catch(error){if(error instanceof Error&&error.message==='RELEASE_HOLD_ACTIVE')continue;
 // Failed observations consume no send attempt. Retry timing lives outside the
 // immutable business effect so other accounts can progress without churn.
 await store.transaction(async client=>{await client.query("UPDATE outbox SET status='BLOCKED',result=$2,updated_at=now() WHERE id=$1 AND status IN('READY','BLOCKED') AND (status IS DISTINCT FROM 'BLOCKED' OR result IS DISTINCT FROM $2::jsonb)",[item.id,{reason:'GROUP_OBSERVATION_FAILED'}]);await scheduleGateRecheck(client,item.id,'GROUP_OBSERVATION_FAILED');});continue;
 }const claim=await store.transaction(async client=>{const candidate=(await client.query('SELECT kind,contact_id,payload FROM outbox WHERE id=$1',[item.id])).rows[0];if(candidate?.kind!=='warmup'){const acquired=(await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[chatLock(item.workspace_id,item.account_id,candidate?.contact_id)])).rows[0];if(!acquired?.acquired){await scheduleGateRecheck(client,item.id,'CHAT_LOCK_BUSY');return;}if(candidate?.payload?.assignment_id)await assignmentFor(client,item.workspace_id,item.environment,candidate.payload.assignment_id,'share');}await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[item.conversation_id]);const effect=(await client.query(`SELECT * FROM outbox WHERE id=$1 AND status IN('READY','BLOCKED') FOR UPDATE SKIP LOCKED`,[item.id])).rows[0];if(!effect)return;
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`quota:contact:${effect.workspace_id}:${effect.contact_id}`]);if(effect.authorization_id)await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`quota:authorization:${effect.authorization_id}`]);
 const gate=await gateDispatch(client,effect,owner);if(!gate.allowed){const reason=gate.reason??'DISPATCH_GATE_DENIED',cancelled=cancelledGateReasons.has(reason),nextStatus=cancelled?'CANCELLED':'BLOCKED',nextResult={reason:gate.reason,...(cancelled&&['collection','followup','remarketing'].includes(effect.payload.purpose)?{superseded_before_send:effect.attempts===0}:{})};await client.query(`UPDATE outbox SET status=$2,result=$3,updated_at=now() WHERE id=$1 AND (status IS DISTINCT FROM $2 OR result IS DISTINCT FROM $3::jsonb)`,[effect.id,nextStatus,nextResult]);if(cancelled)await client.query('DELETE FROM outbox_gate_schedule WHERE effect_id=$1',[effect.id]);else await scheduleGateRecheck(client,effect.id,reason);if(cancelled&&effect.payload.remarketing_attempt_id)await setRemarketingAttemptStatus(client,{attemptId:effect.payload.remarketing_attempt_id,workspaceId:effect.workspace_id,environment:effect.environment},'CANCELLED',{reason:gate.reason??'DISPATCH_GATE_CANCELLED'});return;}
 if(!await reserveDispatchCapacity(client,effect,owner)){await scheduleGateRecheck(client,effect.id,'DISPATCH_CAPACITY_BUSY');return;}
 const claimId=uuid(),claimedAt=await effectiveNow(client,(await getRecord(client,effect.workspace_id,'conversation',effect.conversation_id))!,effect);await client.query('DELETE FROM outbox_gate_schedule WHERE effect_id=$1',[effect.id]);await client.query(`UPDATE outbox SET status='SENDING',claim_id=$2,claimed_at=$3,attempts=attempts+1,updated_at=now() WHERE id=$1`,[effect.id,claimId,claimedAt.toISOString()]);await client.query(`INSERT INTO effect_attempts(id,effect_id,claim_id,status) VALUES($1,$2,$3,'SENDING')`,[uuid(),effect.id,claimId]);return{effect,claimId,account:gate.account!,contact:gate.contact!,deadline:performance.now()+gate.leaseMs!-1500};});if(!claim)continue;
 let outcome:SendResult & {accessCiphertext?:string},externalAttempt=false;
 try{
 let send:()=>Promise<SendResult & {accessCiphertext?:string}>;
 if(lab){if(claim.effect.payload.kind==='grant')send=await lab.prepareGrant(claim.effect,claim.contact,claim.account);else{const message=await lab.prepare(claim.effect,claim.contact),provider=lab.factory(claim.account);send=()=>provider.send(message);}}
 else if(claim.effect.payload.kind==='grant'){
  const asset=await getRecord(reader,claim.effect.workspace_id,'asset',claim.effect.payload.asset_id);if(!asset?.body.delivery_ciphertext)throw new Error('ACCESS_ASSET_REQUIRED');
  const secret=JSON.parse(decrypt(asset.body.delivery_ciphertext));
  const provider=claim.effect.environment==='REAL'&&secret.adapter==='link'?new StaticAccessFulfillmentProvider():await fulfillmentProviderFor(claim.effect.workspace_id,claim.effect.environment);
  send=async()=>{const grant=await provider.grant({grantId:claim.effect.payload.grant_id,subjectId:claim.effect.contact_id,assetReference:secret.delivery_reference,environment:claim.effect.environment,offerVersionId:claim.effect.payload.offer_version_id});return grant.status==='GRANTED'?{status:'ACCEPTED',providerMessageId:grant.providerGrantId,accessCiphertext:encrypt(grant.access??{})}:{status:grant.status==='UNKNOWN'?'UNKNOWN':'REJECTED',reason:grant.reason};};
 }else{const message=await outbound(claim.effect,claim.contact,reader),provider=await factory(claim.account);send=()=>provider.send(message);}
 // Prepare files and provider configuration before the final gate. There is no
 // asynchronous preparation between this check and the external operation.
 const allowed=await store.transaction(async c=>{
  const e=(await c.query('SELECT * FROM outbox WHERE id=$1 AND claim_id=$2 FOR UPDATE',[claim.effect.id,claim.claimId])).rows[0];
  if(!e||e.status!=='SENDING')return false;
  const gate=await gateDispatch(c,e,owner);
  const reason=!gate.allowed?gate.reason??'DISPATCH_GATE_DENIED':performance.now()>=claim.deadline?'LOCAL_OWNERSHIP_DEADLINE':undefined;
  if(reason){await releaseUnsentClaim(c,e.id,claim.claimId,owner,reason);return false;}
  return true;
 });
 if(!allowed)continue;
 // COMMIT itself can outlast the local ownership deadline. Check again after
 // it completes and before invoking any external operation.
 if(performance.now()>=claim.deadline){await store.transaction(c=>releaseUnsentClaim(c,claim.effect.id,claim.claimId,owner,'LOCAL_OWNERSHIP_DEADLINE'));continue;}
 externalAttempt=true;outcome=await send();
 }catch(error){
  const reason=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:externalAttempt?'DISPATCH_EXCEPTION_UNCERTAIN':'DISPATCH_PREPARATION_FAILED';
  if(!externalAttempt){await store.transaction(c=>releaseUnsentClaim(c,claim.effect.id,claim.claimId,owner,reason));continue;}
  outcome={status:'UNKNOWN',reason};
 }
 await store.transaction(async client=>{const current=(await client.query('SELECT * FROM outbox WHERE id=$1 AND claim_id=$2 FOR UPDATE',[claim.effect.id,claim.claimId])).rows[0];if(!current)return;
 const status=outcome.status==='ACCEPTED'?'SENT':outcome.status==='REJECTED'?'FAILED':'UNKNOWN';if(current.status!=='SENDING'){await client.query('UPDATE effect_attempts SET result=$2,finished_at=now() WHERE effect_id=$1 AND claim_id=$3',[current.id,{late_result:{...outcome,accessCiphertext:outcome.accessCiphertext??null}},claim.claimId]);await appendEvent(client,{workspace_id:current.workspace_id,environment:current.environment,event_type:'effect.late_result_observed',aggregate_id:current.conversation_id,causation_id:current.id,payload:{effect_id:current.id,claim_id:claim.claimId,status,provider_message_id:outcome.providerMessageId??null}});return;}await client.query('UPDATE outbox SET status=$2,provider_message_id=$3,result=$4,updated_at=now() WHERE id=$1',[current.id,status,outcome.providerMessageId??null,{reason:outcome.reason??null,provider:claim.effect.payload.kind==='grant'?'fulfillment':claim.account.body.provider,...(outcome.status==='ACCEPTED'?{accepted_at:(await effectiveNow(client,(await getRecord(client,current.workspace_id,'conversation',current.conversation_id))!,current)).toISOString()}:{}),...(outcome.accessCiphertext?{access_ciphertext:outcome.accessCiphertext}:{})}]);await client.query('UPDATE effect_attempts SET status=$2,result=$3,finished_at=now() WHERE effect_id=$1 AND claim_id=$4',[current.id,status,{reason:outcome.reason??null,provider_message_id:outcome.providerMessageId??null},claim.claimId]);
 if(current.payload.remarketing_attempt_id)await setRemarketingAttemptStatus(client,{attemptId:current.payload.remarketing_attempt_id,workspaceId:current.workspace_id,environment:current.environment},outcome.status==='ACCEPTED'?'SENT':outcome.status==='UNKNOWN'?'UNKNOWN':'CANCELLED',{effect_id:current.id,provider_message_id:outcome.providerMessageId??null,reason:outcome.reason??null});
 await appendEvent(client,{workspace_id:current.workspace_id,environment:current.environment,event_type:`effect.${status.toLowerCase()}`,aggregate_id:current.conversation_id,causation_id:current.id,actor:{type:'channel',id:owner},payload:{effect_id:current.id,status,reason:outcome.reason??null}});
 if(current.kind==='warmup')await client.query('UPDATE warmup_content_usage SET consumed_at=COALESCE(consumed_at,now()) WHERE conversation_id=$1',[current.conversation_id]);
 if(outcome.status==='ACCEPTED')sent++;
 });
 }};
 const workspaces=new Map<string,typeof candidates[]>();for(const group of grouped.values()){const first=group[0]!;const key=first.workspace_id+':'+first.environment;const groups=workspaces.get(key)??[];groups.push(group);workspaces.set(key,groups);}
 await Promise.all([...workspaces.values()].map(async groups=>{const first=groups[0]![0]!;const policy=await readOperationalSettings(reader,first.workspace_id,first.environment);let cursor=0;await Promise.all(Array.from({length:Math.min(policy.body.channel_account_concurrency,groups.length)},async()=>{while(cursor<groups.length){const group=groups[cursor++];if(group)await dispatchGroup(group);}}));}));if(!lab)await reconcileGroupDeliveries();return sent;
}
/** Existing entry point retains the original commercial store and providers. */
export async function dispatchOutbox(limit=20,factory:ProviderFactory=providerFor,owner=ownerId){return dispatchOutboxImpl({query,transaction:work=>withTransaction(work)},limit,factory,owner);}
/** Protected laboratory handle and lease; no public provider override. */
export async function dispatchNumberLabOutbox(lease:NumberLabEngineLease,handle:NumberLabDispatch,limit=20){
 if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('LAB_ENGINE_BATCH_LIMIT');
 return withNumberLabEngine(lease,async ports=>{const bound=bindNumberLabDispatch(handle,ports);
  return dispatchOutboxImpl({query:ports.query,transaction:work=>ports.transaction(work)},limit,account=>bound.factory(account),'number-lab:'+ports.binding.runId,bound);
 });
}
export async function recoverSending(ageSeconds=60){return withTransaction(async client=>{const rows=(await client.query(`UPDATE outbox o SET status='UNKNOWN',result=jsonb_build_object('reason','ABANDONED_SENDING_REQUIRES_RECONCILIATION'),updated_at=now() WHERE o.status='SENDING' AND o.claimed_at<(CASE WHEN o.environment='SIMULATION' THEN COALESCE((SELECT r.virtual_now FROM warmup_simulation_runs r JOIN warmup_conversations v ON v.simulation_run_id=r.id WHERE o.kind='warmup' AND v.id::text=o.conversation_id AND v.workspace_id=o.workspace_id),(SELECT (s.body->>'virtual_now')::timestamptz FROM records c JOIN records s ON s.id::text=c.body->>'simulation_id' AND s.workspace_id=c.workspace_id WHERE c.id::text=o.conversation_id AND c.workspace_id=o.workspace_id),now()) ELSE now() END)-($1*interval '1 second') RETURNING o.id,o.workspace_id,o.environment,o.payload`,[ageSeconds])).rows;for(const row of rows)if(row.payload?.remarketing_attempt_id)await setRemarketingAttemptStatus(client,{attemptId:row.payload.remarketing_attempt_id,workspaceId:row.workspace_id,environment:row.environment},'UNKNOWN',{effect_id:row.id,recovery:'ABANDONED_SENDING_REQUIRES_RECONCILIATION'});return rows;});}
