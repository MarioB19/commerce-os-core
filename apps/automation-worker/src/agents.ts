import {salesAiConfiguration} from '../../../packages/db/src/sales-ai-configuration.js';
import {launchTestOrderFields} from '../../../packages/db/src/launch-test-scope.js';
import {composeSellerContext,deterministicSellerReply,proposalGroundingIssue,sellerInstructions} from '../../../packages/domain/src/sales/seller-context.js';
import {loadSellerSnapshot} from '../../../packages/db/src/seller-context.js';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {query,withTransaction,getRecord,decrypt,pool,readOperationalSettings} from '@commerce/db';
import {readIntegrationSettings,validateIntegrationConfig} from '../../../packages/db/src/integration-settings.js';
import type {Body,DomainRecord} from '@commerce/contracts';
import {DeterministicSalesAi,OpenAiSalesProvider,type SalesAiProvider,type AgentConfig} from '../../../packages/domain/src/sales/ai.js';
import {event,save,create,gated,controls,proposeEffect,cancelPending,receiptReviewPending} from './shared.js';
import {advanceWorkflow} from './workflows.js';
import {applyReceiptAnalysis} from './commands.js';
const deterministic=new DeterministicSalesAi();
const protectedHistoryPurposes=new Set(['collection','followup','remarketing']);
function sellerHistoryText(message:Body){
 const body=message.body??{};
 const protectedContent=protectedHistoryPurposes.has(String(message.purpose??''))
  ||protectedHistoryPurposes.has(String(body.purpose??''))
  ||Boolean(message.payment_profile_version_id??body.payment_profile_version_id)
  ||Boolean(message.effect_asset_id??body.asset_id);
 return protectedContent?'[contenido protegido]':body.text??'';
}
function reviewBody(current:DomainRecord){const body:Body={...current.body,ai_status:'HUMAN_REVIEW',ai_pending:false,active_ai_run_id:null};if(current.body.flow_state?.status==='FINISHED'){delete body.ai_review_resume_state;return body;}return{...body,ai_review_resume_state:current.body.flow_state??null,flow_state:current.body.flow_state?{...current.body.flow_state,status:'HUMAN_REVIEW',waiting_for:'human_approved',waiting_node_id:current.body.flow_state.waiting_node_id??current.body.flow_state.node_id}:undefined};}
async function acknowledgeReview(client:Parameters<typeof proposeEffect>[0],current:DomainRecord,runId:string){
 if(!['COMMITTED','AWAITING_RECEIPT'].includes(String(current.body.stage)))return;
 await proposeEffect(client,current,{kind:'text',purpose:'seller_review_ack',text:'Recibí tu mensaje. Necesito revisar ese punto y te responderé por aquí.',ai_run_id:runId},`ai-review-ack:${runId}`);
}
function configuration(record?:DomainRecord):AgentConfig{return{provider:'deterministic',model:'deterministic-v1',knowledge:'',instructions:'',max_cost_minor:20,max_tokens:500,timeout_ms:10000,...record?.body};}
async function configuredAi(record:DomainRecord|undefined,workspace:string,environment:'REAL'|'SIMULATION',override?:SalesAiProvider){
 const stored=configuration(record);
 if(override&&record?.body.provider!=='workspace')return{agent:stored,provider:override};
 if(stored.provider==='deterministic')return{agent:stored,provider:deterministic};
 if(environment!=='REAL')throw new Error('SIMULATION_EXTERNAL_AI_DENIED');
 const resolved=await salesAiConfiguration(pool,workspace,environment,record?.body??{});
 if(!resolved.configured||!resolved.agent)throw new Error('AI_'+resolved.state);
 const profile=await readIntegrationSettings(pool,workspace,environment,'openai:default');
 if(!profile?.enabled||!profile.secrets.api_key)throw new Error('AI_CREDENTIAL_REQUIRED');
 const config=validateIntegrationConfig('openai',profile.config,true);
 return{agent:resolved.agent,provider:new OpenAiSalesProvider({apiKey:profile.secrets.api_key,baseUrl:String(config.base_url)})};
}
export async function processAgents(limit=5,override?:SalesAiProvider){
 const candidates=(await query(`SELECT * FROM records WHERE kind='conversation' AND body->>'ai_pending'='true' AND body->>'last_customer_text' IS NOT NULL ORDER BY updated_at LIMIT $1`,[limit])).rows as DomainRecord[];
 for(const candidate of candidates){
  const snapshot=await withTransaction(async c=>{const operationalRevision=(await readOperationalSettings(c,candidate.workspace_id,candidate.environment,{lock:'share'})).version;await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[candidate.id]);let conv=await getRecord(c,candidate.workspace_id,'conversation',candidate.id);if(!conv||!conv.body.ai_pending)return undefined;if(conv.body.sponsorship_id||conv.body.launch_test_role==='beneficiary'||(await launchTestOrderFields(c,conv)).launch_test_role==='beneficiary'||await gated(c,conv)||conv.body.ai_status==='HUMAN_REVIEW'||conv.body.flow_state?.status==='HUMAN_REVIEW'||conv.body.flow_response_sequence===conv.body.sequence){await save(c,conv,{...conv.body,ai_pending:false});return undefined;}
   const agent=conv.body.agent_version_id?await getRecord(c,conv.workspace_id,'agent',conv.body.agent_version_id):undefined;if(conv.environment==='REAL'&&!agent){await save(c,conv,{...conv.body,ai_pending:false,ai_status:'CONFIGURATION_REQUIRED'});return undefined;}
   const inherited=agent?.body.provider==='workspace'?await salesAiConfiguration(c,conv.workspace_id,conv.environment,agent.body):undefined;
   if(inherited&&(!inherited.configured||conv.environment!=='REAL')){await save(c,conv,{...conv.body,ai_pending:false,ai_status:'CONFIGURATION_REQUIRED',ai_dependency:inherited.configured?'REAL_MODEL_EVALUATION_DEFERRED':inherited.state});return undefined;}
   const offer=await getRecord(c,conv.workspace_id,'offer',conv.body.offer_version_id??'');if(!offer){await save(c,conv,{...conv.body,ai_pending:false,ai_status:'OFFER_REQUIRED'});return undefined;}
   const sellerSnapshot=conv.body.seller_snapshot??await loadSellerSnapshot(c,conv.workspace_id,conv.environment,offer.id,agent?.id,new Date(conv.created_at).toISOString());
   const messages=(await c.query("SELECT m.body,o.payload->>'purpose' purpose,o.payload->>'payment_profile_version_id' payment_profile_version_id,o.payload->>'asset_id' effect_asset_id FROM records m LEFT JOIN outbox o ON o.id::text=m.body->>'effect_id' AND o.workspace_id=m.workspace_id WHERE m.workspace_id=$1 AND m.environment=$2 AND m.kind='message' AND m.body->>'conversation_id'=$3 AND m.id::text<>$4 AND (m.body->>'direction'='INBOUND' OR m.body->>'status' IN('SENT','DELIVERED','READ')) ORDER BY m.created_at DESC LIMIT 12",[conv.workspace_id,conv.environment,conv.id,conv.body.last_message_id??''])).rows.reverse();
   const order=(await c.query("SELECT body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='order' AND body->>'conversation_id'=$3 LIMIT 1",[conv.workspace_id,conv.environment,conv.id])).rows[0]?.body;
   const context=composeSellerContext(sellerSnapshot,{text:conv.body.last_customer_text,stage:conv.body.stage,order,variables:conv.body.flow_state?.variables,history:messages.map(m=>({role:m.body.direction==='INBOUND'?'customer':'seller',text:sellerHistoryText(m)}))});
   const run=await create(c,conv,'ai_run',{conversation_id:conv.id,agent_version_id:agent?.id,offer_version_id:offer.id,status:'RUNNING',context_snapshot:context,source_revisions:sellerSnapshot.sources.map((x:any)=>({id:x.id,revision:x.revision})),configuration_revision:operationalRevision,snapshot_sequence:conv.body.sequence,control_snapshot:await controls(c,conv),provider:inherited?.agent?.provider??agent?.body.provider??'deterministic',model:inherited?.agent?.model??(agent?.body.provider==='workspace'?null:agent?.body.model??'deterministic-v1'),started_at:new Date().toISOString()});conv=await save(c,conv,{...conv.body,seller_snapshot:sellerSnapshot,ai_pending:false,active_ai_run_id:run.id});return{conv,agent,offer,run,operationalRevision,context,sellerSnapshot};
  });if(!snapshot)continue;
  let output:Awaited<ReturnType<SalesAiProvider['propose']>>|undefined;let failure:string|undefined;
  try{const configured=await configuredAi(snapshot.agent,snapshot.conv.workspace_id,snapshot.conv.environment,override);if((await readOperationalSettings(pool,snapshot.conv.workspace_id,snapshot.conv.environment)).version!==snapshot.operationalRevision)throw new Error('CONFIGURATION_CHANGED');output=await configured.provider.propose({...configured.agent,knowledge:'',instructions:sellerInstructions(snapshot.sellerSnapshot)},snapshot.context);}catch(error){failure=error instanceof Error&&/^[A-Z_0-9]+$/.test(error.message)?error.message:'AI_REQUEST_FAILED';}
  await withTransaction(async c=>{const configurationChanged=(await readOperationalSettings(c,candidate.workspace_id,candidate.environment,{lock:'share'})).version!==snapshot.operationalRevision;await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[candidate.id]);const current=await getRecord(c,candidate.workspace_id,'conversation',candidate.id);const run=await getRecord(c,candidate.workspace_id,'ai_run',snapshot.run.id);if(!current||!run)return;
   const stale=configurationChanged||current.body.sequence!==snapshot.conv.body.sequence||current.body.active_ai_run_id!==run.id||current.body.stage!==snapshot.conv.body.stage||JSON.stringify(current.body.flow_state)!==JSON.stringify(snapshot.conv.body.flow_state)||await gated(c,current);if(stale){await save(c,run,{...run.body,status:'DISCARDED',reason:configurationChanged?'CONFIGURATION_CHANGED':'CONTEXT_OR_CONTROLS_CHANGED',completed_at:new Date().toISOString()});await event(c,current,'ai.proposal_discarded',{ai_run_id:run.id,reason:configurationChanged?'CONFIGURATION_CHANGED':'CONTEXT_OR_CONTROLS_CHANGED'});return;}
   const support=deterministicSellerReply(snapshot.context);
   const supportQuestion=/pdf|portal|abr[ei]|pago|comprobante/i.test(String(snapshot.context.customer_text).normalize('NFD').replace(/[\u0300-\u036f]/g,''));
   const safeSupport=['COMMITTED','AWAITING_RECEIPT'].includes(String(snapshot.context.stage))&&(support.reason==='POST_AGREEMENT_CHECK_IN'||support.reason==='APPROVED_SOURCE'&&supportQuestion)&&!proposalGroundingIssue(support.proposal,snapshot.context)?support.proposal:undefined;
   if((failure||!output)&&!safeSupport){await save(c,run,{...run.body,status:'FAILED',reason:failure??'AI_NO_OUTPUT'});await acknowledgeReview(c,current,run.id);await save(c,current,reviewBody(current));await event(c,current,'ai.failed',{ai_run_id:run.id,reason:failure});return;}
   const p=safeSupport??output!.proposal;const groundingIssue=proposalGroundingIssue(p,snapshot.context);await save(c,run,{...run.body,status:'COMPLETED',proposal:p,usage:output?.usage,completed_at:new Date().toISOString(),...(safeSupport?{fallback_reason:support.reason}:{})});
	   let acceptedEffect:Body|undefined;
	   if(p.intent==='opt_out'){await c.query(`INSERT INTO manual_controls(workspace_id,scope_type,scope_id,suppressed,reason,actor_id) VALUES($1,'contact',$2,true,'AI_CLASSIFIED_OPT_OUT','automation') ON CONFLICT(workspace_id,scope_type,scope_id) DO UPDATE SET suppressed=true,version=manual_controls.version+1,updated_at=now()`,[current.workspace_id,current.body.contact_id]);await cancelPending(c,current,'OPT_OUT',true);}
	   else if(p.confidence<0.8||p.tool==='request_human'||p.intent==='unknown'||!!groundingIssue){await acknowledgeReview(c,current,run.id);await save(c,current,reviewBody(current));await event(c,current,'ai.handoff_requested',{ai_run_id:run.id,reason:groundingIssue??'HUMAN_REQUEST'});return;}
	   else{acceptedEffect=await proposeEffect(c,current,{kind:'text',purpose:'seller_reply',text:p.reply,ai_run_id:run.id,agent_version_id:snapshot.agent?.id},`ai:${run.id}`);await event(c,current,'ai.proposal_accepted',{ai_run_id:run.id,intent:p.intent});}
	   const body:Body={...current.body,ai_status:'COMPLETED',active_ai_run_id:null};
	   const interruption=current.body.recipe_interruption;
	   if(acceptedEffect&&interruption?.status==='AWAITING_SELLER_REPLY'){
	    body.recipe_interruption={...interruption,status:'AWAITING_SELLER_CONFIRMATION',seller_effect_id:acceptedEffect.id};
	    await event(c,current,'workflow.recipe_reply_proposed',{token:interruption.token,seller_effect_id:acceptedEffect.id},run.id);
	   }
	   const plan=current.body.followup_plan,waiting=current.body.flow_state?.waiting_for;
	   if(acceptedEffect&&current.body.followup_stop_reason==='CUSTOMER_REPLIED'&&plan&&(plan.stage==='awaiting_agreement'&&waiting==='commitment'||plan.stage==='awaiting_payment'&&waiting==='receipt_approved')){
	    delete body.followup_stop_reason;
	    body.followup_plan={...plan,status:'AWAITING_COLLECTION_ACK',anchor_effect_id:acceptedEffect.id,resume_after_customer_reply:true,resumed_after_sequence:current.body.sequence};
	    await event(c,current,'remarketing.wait_resumed',{cycle_id:plan.cycle_id??null,stage:plan.stage,anchor_effect_id:acceptedEffect.id},run.id);
	   }
	   const updated=await save(c,current,body);if(updated.body.flow_state?.waiting_for==='ai_accepted')await advanceWorkflow(c,updated,'ai_accepted');
  });
 }
 return candidates.length;
}
export async function processReceiptAnalyses(limit=3,override?:SalesAiProvider){
 const rows=(await query(`SELECT * FROM records WHERE kind='receipt' AND body->>'analysis_status'='PENDING' AND body->>'review' IS NULL ORDER BY created_at LIMIT $1`,[limit])).rows as DomainRecord[];
 for(const receipt of rows){const snapshot=await withTransaction(async c=>{const operationalRevision=(await readOperationalSettings(c,receipt.workspace_id,receipt.environment,{lock:'share'})).version;await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[receipt.body.conversation_id]);const r=await getRecord(c,receipt.workspace_id,'receipt',receipt.id);if(!r||r.body.analysis_status!=='PENDING'||r.body.review||await receiptReviewPending(c,r))return;const conv=await getRecord(c,r.workspace_id,'conversation',r.body.conversation_id);if(!conv||await gated(c,conv))return;const agent=conv.body.agent_version_id?await getRecord(c,r.workspace_id,'agent',conv.body.agent_version_id):undefined;const asset=await getRecord(c,r.workspace_id,'asset',r.body.asset_id);if(!asset)return;if(!agent||agent.body.provider==='deterministic'){await save(c,r,{...r.body,analysis_status:'HUMAN_REQUIRED',analysis_dependency:'VISION_PROVIDER_NOT_CONFIGURED'});return;}await save(c,r,{...r.body,analysis_status:'RUNNING',analysis_configuration_revision:operationalRevision,analysis_started_at:new Date().toISOString()});return{receipt:r,conv,agent,asset,operationalRevision};});if(!snapshot)continue;
  let extraction:unknown;let failure:string|undefined;try{const root=process.env.PRIVATE_STORAGE_DIR??process.env.ASSET_STORAGE_DIR;if(!root||!/^[a-f0-9-]{36}(?:-[a-f0-9]{64})?$/.test(snapshot.asset.body.storage_key))throw new Error('PRIVATE_ASSET_NOT_CONFIGURED');const bytes=Buffer.from(decrypt(await readFile(join(root,'assets',`${snapshot.asset.body.storage_key}.enc`),'utf8')),'base64');const configured=await configuredAi(snapshot.agent,snapshot.conv.workspace_id,snapshot.conv.environment,override);if((await readOperationalSettings(pool,snapshot.conv.workspace_id,snapshot.conv.environment)).version!==snapshot.operationalRevision)throw new Error('CONFIGURATION_CHANGED');extraction=await configured.provider.receipt(configured.agent,{bytes,mimeType:snapshot.asset.body.mime_type});}catch(error){failure=error instanceof Error&&/^[A-Z_0-9]+$/.test(error.message)?error.message:'RECEIPT_ANALYSIS_FAILED';}
  await withTransaction(async c=>{const configurationChanged=(await readOperationalSettings(c,receipt.workspace_id,receipt.environment,{lock:'share'})).version!==snapshot.operationalRevision;await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[receipt.body.conversation_id]);const current=await getRecord(c,receipt.workspace_id,'receipt',receipt.id);if(!current||current.body.analysis_status!=='RUNNING'||current.body.review||await receiptReviewPending(c,current))return;if(configurationChanged){await save(c,current,{...current.body,analysis_status:'DISCARDED',analysis_dependency:'CONFIGURATION_CHANGED'});return;}if(failure){await save(c,current,{...current.body,analysis_status:'HUMAN_REQUIRED',analysis_dependency:failure});return;}const conv=await getRecord(c,current.workspace_id,'conversation',current.body.conversation_id);if(!conv||await gated(c,conv)){await save(c,current,{...current.body,analysis_status:'DISCARDED',analysis_dependency:'CONTROLS_CHANGED'});return;}await applyReceiptAnalysis(c,current,extraction,receipt.id);});
 }
 return rows.length;
}
