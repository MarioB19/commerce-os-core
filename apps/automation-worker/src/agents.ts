import {withNumberLabEngine,type NumberLabEngineLease} from '../../../packages/db/src/number-lab-engine-runtime.js';
import type {ProfileQuery} from '../../../packages/db/src/profile-context.js';
import {bindNumberLabSeller,type NumberLabSeller} from './number-lab-seller.js';
import type {QueryExecutor} from '@commerce/db';
import type {LaboratorySellerResult} from '../../../packages/ai-providers/src/laboratory-seller.js';
import {salesAiConfiguration} from '../../../packages/db/src/sales-ai-configuration.js';
import {launchTestOrderFields} from '../../../packages/db/src/launch-test-scope.js';
import {composeSellerContext,deterministicSellerReply,proposalGroundingIssue,sellerInstructions} from '../../../packages/domain/src/sales/seller-context.js';
import {loadSellerSnapshot} from '../../../packages/db/src/seller-context.js';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import pg from 'pg';
import {ProfileSellerAi} from '../../../packages/ai-providers/src/variant-ai.js';
import {aiCredentialKey} from '../../../packages/ai-providers/src/profile-integrations.js';
import {AiError} from '../../../packages/ai-providers/src/contracts.js';
import {query,withTransaction,getRecord,decrypt,pool,readOperationalSettings,stableJson} from '@commerce/db';
import {readIntegrationSettings,validateIntegrationConfig} from '../../../packages/db/src/integration-settings.js';
import type {Body,DomainRecord} from '@commerce/contracts';
import {DeterministicSalesAi,OpenAiSalesProvider,parseProposal,type SalesAiProvider,type AgentConfig} from '../../../packages/domain/src/sales/ai.js';
import {event,save,create,gated,controls,proposeEffect,proposeEffectOutcome,cancelPending,receiptReviewPending} from './shared.js';
import {advanceWorkflow} from './workflows.js';
import {applyReceiptAnalysis} from './commands.js';
const deterministic=new DeterministicSalesAi();
// V7 F4: production seller over the profile's own key (dedicated commerce_ai login).
let sellerRuntime:ProfileSellerAi|null|undefined;
export function profileSeller(){
 if(sellerRuntime!==undefined)return sellerRuntime;
 const url=process.env.AI_DATABASE_URL;if(!url){sellerRuntime=null;return null;}
 const aiPool=new pg.Pool({connectionString:url,max:4,connectionTimeoutMillis:5000,idleTimeoutMillis:30000});
 aiPool.on('connect',client=>{client.query('SET ROLE commerce_ai').catch(()=>{process.stderr.write('ai_runtime_role_not_assumed\n');});});
 sellerRuntime=new ProfileSellerAi({aiPool,custodyKey:aiCredentialKey()});return sellerRuntime;
}
export function setProfileSellerForTests(runtime:ProfileSellerAi|null){sellerRuntime=runtime;}
const protectedHistoryPurposes=new Set(['collection','followup','remarketing']);
function sellerHistoryText(message:Body){
 const body=message.body??{};
 const protectedContent=protectedHistoryPurposes.has(String(message.purpose??''))
  ||protectedHistoryPurposes.has(String(body.purpose??''))
  ||Boolean(message.payment_profile_version_id??body.payment_profile_version_id)
  ||Boolean(message.effect_asset_id??body.asset_id);
 return protectedContent?'[contenido protegido]':body.text??'';
}
function agentBinding(conv:DomainRecord){return{account_id:conv.body.account_id,contact_id:conv.body.contact_id,assignment_id:conv.body.assignment_id,assignment_revision:conv.body.assignment_revision,binding_id:conv.body.binding_id,product_id:conv.body.product_id,offer_version_id:conv.body.offer_version_id,workflow_version_id:conv.body.workflow_version_id,agent_version_id:conv.body.agent_version_id};}
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
type AgentStore={query:ProfileQuery;transaction<T>(work:(db:QueryExecutor)=>Promise<T>):Promise<T>};
const agentStore:AgentStore={query,transaction:work=>withTransaction(work)};
type BoundSeller=ReturnType<typeof bindNumberLabSeller>;
async function processAgentsImpl(store:AgentStore,limit:number,override?:SalesAiProvider,lab?:BoundSeller){
 const candidates=(await store.query(`SELECT * FROM records WHERE kind='conversation' AND body->>'ai_pending'='true' AND body->>'last_customer_text' IS NOT NULL ${lab?'AND id=$2':''} ORDER BY updated_at LIMIT $1`,lab?[limit,lab.conversationId]:[limit])).rows as DomainRecord[];
 for(const candidate of candidates){
  const snapshot=await store.transaction(async c=>{const operationalRevision=(await readOperationalSettings(c,candidate.workspace_id,candidate.environment,{lock:'share'})).version;await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[candidate.id]);let conv=await getRecord(c,candidate.workspace_id,'conversation',candidate.id);if(!conv||!conv.body.ai_pending)return undefined;if(conv.body.sponsorship_id||conv.body.launch_test_role==='beneficiary'||(await launchTestOrderFields(c,conv)).launch_test_role==='beneficiary'||conv.body.ai_status==='HUMAN_REVIEW'||conv.body.flow_state?.status==='HUMAN_REVIEW'||conv.body.flow_response_sequence===conv.body.sequence){await save(c,conv,{...conv.body,ai_pending:false});return undefined;}
   const pending=conv.body.active_ai_run_id?await getRecord(c,conv.workspace_id,'ai_run',conv.body.active_ai_run_id):undefined;
   if(await gated(c,conv)){await save(c,conv,{...conv.body,ai_pending:pending?.body.status==='AWAITING_EFFECT'});return undefined;}
   const agent=conv.body.agent_version_id?await getRecord(c,conv.workspace_id,'agent',conv.body.agent_version_id):undefined;if(conv.environment==='REAL'&&!agent){await save(c,conv,{...conv.body,ai_pending:false,ai_status:'CONFIGURATION_REQUIRED'});return undefined;}
   if(lab)lab.validate(conv,agent);
   const inherited=!lab&&agent?.body.provider==='workspace'?await salesAiConfiguration(c,conv.workspace_id,conv.environment,agent.body):undefined;
   if(inherited&&(!inherited.configured||conv.environment!=='REAL')){await save(c,conv,{...conv.body,ai_pending:false,ai_status:'CONFIGURATION_REQUIRED',ai_dependency:inherited.configured?'REAL_MODEL_EVALUATION_DEFERRED':inherited.state});return undefined;}
   const offer=await getRecord(c,conv.workspace_id,'offer',conv.body.offer_version_id??'');if(!offer){await save(c,conv,{...conv.body,ai_pending:false,ai_status:'OFFER_REQUIRED'});return undefined;}
   const sellerSnapshot=conv.body.seller_snapshot??await loadSellerSnapshot(c,conv.workspace_id,conv.environment,offer.id,agent?.id,new Date(conv.created_at).toISOString());
   const messages=(await c.query("SELECT m.body,o.payload->>'purpose' purpose,o.payload->>'payment_profile_version_id' payment_profile_version_id,o.payload->>'asset_id' effect_asset_id FROM records m LEFT JOIN outbox o ON o.id::text=m.body->>'effect_id' AND o.workspace_id=m.workspace_id WHERE m.workspace_id=$1 AND m.environment=$2 AND m.kind='message' AND m.body->>'conversation_id'=$3 AND m.id::text<>$4 AND (m.body->>'direction'='INBOUND' OR m.body->>'status' IN('SENT','DELIVERED','READ')) ORDER BY m.created_at DESC LIMIT 12",[conv.workspace_id,conv.environment,conv.id,conv.body.last_message_id??''])).rows.reverse();
   const order=(await c.query("SELECT body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='order' AND body->>'conversation_id'=$3 LIMIT 1",[conv.workspace_id,conv.environment,conv.id])).rows[0]?.body;
   const context=composeSellerContext(sellerSnapshot,{text:conv.body.last_customer_text,stage:conv.body.stage,order,variables:conv.body.flow_state?.variables,history:messages.map(m=>({role:m.body.direction==='INBOUND'?'customer':'seller',text:sellerHistoryText(m)}))});
   if(pending?.body.status==='AWAITING_EFFECT'){
    const exact=pending.body.conversation_id===conv.id&&pending.body.configuration_revision===operationalRevision
     &&pending.body.snapshot_sequence===conv.body.sequence&&pending.body.snapshot_stage===conv.body.stage
     &&stableJson(pending.body.snapshot_binding)===stableJson(agentBinding(conv))
     &&stableJson(pending.body.snapshot_flow_state)===stableJson(conv.body.flow_state??null)
     &&pending.body.agent_version_id===agent?.id&&pending.body.offer_version_id===offer.id
     &&stableJson(pending.body.context_snapshot)===stableJson(context);
    if(!exact){await save(c,pending,{...pending.body,status:'DISCARDED',reason:'CONTEXT_OR_CONFIGURATION_CHANGED',completed_at:new Date().toISOString()});await save(c,conv,reviewBody(conv));await event(c,conv,'ai.proposal_discarded',{ai_run_id:pending.id,reason:'CONTEXT_OR_CONFIGURATION_CHANGED'});return undefined;}
    return{conv,agent,offer,run:pending,operationalRevision,context,sellerSnapshot,cachedProposal:parseProposal(pending.body.proposal)};
   }
   const run=await create(c,conv,'ai_run',{conversation_id:conv.id,agent_version_id:agent?.id,offer_version_id:offer.id,status:'RUNNING',context_snapshot:context,source_revisions:sellerSnapshot.sources.map((x:any)=>({id:x.id,revision:x.revision})),configuration_revision:operationalRevision,snapshot_sequence:conv.body.sequence,snapshot_stage:conv.body.stage,snapshot_binding:agentBinding(conv),snapshot_flow_state:conv.body.flow_state??null,control_snapshot:await controls(c,conv),provider:inherited?.agent?.provider??agent?.body.provider??'deterministic',model:inherited?.agent?.model??(agent?.body.provider==='workspace'?null:agent?.body.model??'deterministic-v1'),started_at:new Date().toISOString()});conv=await save(c,conv,{...conv.body,seller_snapshot:sellerSnapshot,ai_pending:false,active_ai_run_id:run.id});return{conv,agent,offer,run,operationalRevision,context,sellerSnapshot,cachedProposal:undefined};
  });if(!snapshot)continue;
  let output:{proposal:ReturnType<typeof parseProposal>;usage?:unknown}|undefined;let nativeAi:LaboratorySellerResult|undefined;let failure:string|undefined;
  if(!snapshot.cachedProposal)try{
   if(lab){
    nativeAi=await lab.invoke(snapshot.conv,snapshot.agent,snapshot.run.id,sellerInstructions(snapshot.sellerSnapshot),snapshot.context as unknown as Record<string,unknown>,async()=>{
     await store.transaction(async c=>{const revision=(await readOperationalSettings(c,candidate.workspace_id,candidate.environment,{lock:'share'})).version;
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[candidate.id]);
      const current=await getRecord(c,candidate.workspace_id,'conversation',candidate.id),run=await getRecord(c,candidate.workspace_id,'ai_run',snapshot.run.id);
      if(!current||!run||run.body.status!=='RUNNING'||revision!==snapshot.operationalRevision||stableJson(agentBinding(current))!==stableJson(agentBinding(snapshot.conv))
       ||current.body.sequence!==snapshot.conv.body.sequence||current.body.active_ai_run_id!==run.id||current.body.stage!==snapshot.conv.body.stage
       ||stableJson(current.body.flow_state)!==stableJson(snapshot.conv.body.flow_state)||await gated(c,current))throw Error('LAB_SELLER_CONTEXT_CHANGED');
      lab.validate(current,snapshot.agent);
     });
    });
    if(nativeAi.invocation.state==='SUCCEEDED')output={proposal:nativeAi.invocation.value};else failure=nativeAi.invocation.code;
   }else if(snapshot.agent?.body.provider==='profile'&&!override){
    // V7 F4: the variant's own model, admitted and accounted per call.
    if(snapshot.conv.environment!=='REAL')throw new Error('SIMULATION_EXTERNAL_AI_DENIED');
    const variantId=snapshot.conv.body.variant_id;if(typeof variantId!=='string')throw new Error('AI_VARIANT_REQUIRED');
    const seller=profileSeller();if(!seller)throw new Error('AI_RUNTIME_NOT_CONFIGURED');
    if((await readOperationalSettings(pool,snapshot.conv.workspace_id,snapshot.conv.environment)).version!==snapshot.operationalRevision)throw new Error('CONFIGURATION_CHANGED');
    try{const r=await seller.propose({workspaceId:snapshot.conv.workspace_id,variantId,conversationId:snapshot.conv.id,attemptId:snapshot.run.id,instructions:sellerInstructions(snapshot.sellerSnapshot),context:snapshot.context as unknown as Record<string,unknown>});
     output={proposal:r.proposal,usage:{...r.usage,provider:r.provider,model:r.model,cost_microusd:r.cost_microusd,attempt_id:r.attempt_id}};}
    catch(error){throw new Error(error instanceof AiError?'AI_'+error.code:'AI_REQUEST_FAILED');}
   }else{const configured=await configuredAi(snapshot.agent,snapshot.conv.workspace_id,snapshot.conv.environment,override);if((await readOperationalSettings(pool,snapshot.conv.workspace_id,snapshot.conv.environment)).version!==snapshot.operationalRevision)throw new Error('CONFIGURATION_CHANGED');output=await configured.provider.propose({...configured.agent,knowledge:'',instructions:sellerInstructions(snapshot.sellerSnapshot)},snapshot.context);}
  }catch(error){failure=error instanceof Error&&/^[A-Z_0-9]+$/.test(error.message)?error.message:'AI_REQUEST_FAILED';}
  const nativeFields=nativeAi?{provider:nativeAi.provider,model:nativeAi.model,lab_ai:{attempt_id:nativeAi.attemptId,execution_environment:nativeAi.executionEnvironment,operation_class:nativeAi.operationClass,
   state:nativeAi.invocation.state,...('code'in nativeAi.invocation?{code:nativeAi.invocation.code}:{}),outcome:nativeAi.invocation.outcome??null}}:{};
  const reconcile=async(c:QueryExecutor,cacheAdmitted=true)=>{const configurationChanged=(await readOperationalSettings(c,candidate.workspace_id,candidate.environment,{lock:'share'})).version!==snapshot.operationalRevision;await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[candidate.id]);const current=await getRecord(c,candidate.workspace_id,'conversation',candidate.id);const run=await getRecord(c,candidate.workspace_id,'ai_run',snapshot.run.id);if(!current||!run)return;
   const stale=configurationChanged||stableJson(agentBinding(current))!==stableJson(agentBinding(snapshot.conv))||current.body.sequence!==snapshot.conv.body.sequence||current.body.active_ai_run_id!==run.id||current.body.stage!==snapshot.conv.body.stage||JSON.stringify(current.body.flow_state)!==JSON.stringify(snapshot.conv.body.flow_state);if(stale){await save(c,run,{...run.body,...nativeFields,status:'DISCARDED',reason:configurationChanged?'CONFIGURATION_CHANGED':'CONTEXT_OR_CONTROLS_CHANGED',completed_at:new Date().toISOString()});await event(c,current,'ai.proposal_discarded',{ai_run_id:run.id,reason:configurationChanged?'CONFIGURATION_CHANGED':'CONTEXT_OR_CONTROLS_CHANGED'});if(snapshot.cachedProposal)await save(c,current,reviewBody(current));return;}
   if(lab&&!cacheAdmitted){await save(c,run,{...run.body,...nativeFields,proposal:snapshot.cachedProposal??output!.proposal,usage:snapshot.cachedProposal?run.body.usage:output?.usage,status:'AWAITING_EFFECT',effect_proposal_block:'AI_AUTHORITY_UNAVAILABLE'});await save(c,current,{...current.body,ai_pending:true,ai_status:'AWAITING_EFFECT',active_ai_run_id:run.id});return;}
   const controlsBlocked=await gated(c,current);
   const support=deterministicSellerReply(snapshot.context);
   const supportQuestion=/pdf|portal|abr[ei]|pago|comprobante/i.test(String(snapshot.context.customer_text).normalize('NFD').replace(/[\u0300-\u036f]/g,''));
   const safeSupport=['COMMITTED','AWAITING_RECEIPT'].includes(String(snapshot.context.stage))&&(support.reason==='POST_AGREEMENT_CHECK_IN'||support.reason==='APPROVED_SOURCE'&&supportQuestion)&&!proposalGroundingIssue(support.proposal,snapshot.context)?support.proposal:undefined;
   if((failure||!output)&&!safeSupport&&!snapshot.cachedProposal){await save(c,run,{...run.body,...nativeFields,status:'FAILED',reason:failure??'AI_NO_OUTPUT'});if(!controlsBlocked)await acknowledgeReview(c,current,run.id);await save(c,current,reviewBody(current));await event(c,current,'ai.failed',{ai_run_id:run.id,reason:failure});return;}
   const p=snapshot.cachedProposal??safeSupport??output!.proposal;const groundingIssue=proposalGroundingIssue(p,snapshot.context);const resultBody={...run.body,...nativeFields,proposal:p,usage:snapshot.cachedProposal?run.body.usage:output?.usage,...(safeSupport?{fallback_reason:support.reason}:{})};
   if(controlsBlocked&&p.intent!=='opt_out'){await save(c,run,{...resultBody,status:'AWAITING_EFFECT',effect_proposal_block:'CONTROLS_BLOCKED'});await save(c,current,{...current.body,ai_pending:true,ai_status:'AWAITING_EFFECT',active_ai_run_id:run.id});return;}
	   let acceptedEffect:Body|undefined;
	   if(p.intent==='opt_out'){await c.query(`INSERT INTO manual_controls(workspace_id,scope_type,scope_id,suppressed,reason,actor_id) VALUES($1,'contact',$2,true,'AI_CLASSIFIED_OPT_OUT','automation') ON CONFLICT(workspace_id,scope_type,scope_id) DO UPDATE SET suppressed=true,version=manual_controls.version+1,updated_at=now()`,[current.workspace_id,current.body.contact_id]);await cancelPending(c,current,'OPT_OUT',true);}
	   else if(p.confidence<0.8||p.tool==='request_human'||p.intent==='unknown'||!!groundingIssue){await save(c,run,{...resultBody,status:'COMPLETED',completed_at:new Date().toISOString()});await acknowledgeReview(c,current,run.id);await save(c,current,reviewBody(current));await event(c,current,'ai.handoff_requested',{ai_run_id:run.id,reason:groundingIssue??'HUMAN_REQUEST'});return;}
	   else{const proposed=await proposeEffectOutcome(c,current,{kind:'text',purpose:'seller_reply',text:p.reply,ai_run_id:run.id,agent_version_id:snapshot.agent?.id},`ai:${run.id}`);
     if(proposed.state==='BLOCKED'){
      await save(c,run,{...resultBody,status:'AWAITING_EFFECT',effect_proposal_block:proposed.reason});
      await save(c,current,{...current.body,ai_pending:true,ai_status:'AWAITING_EFFECT',active_ai_run_id:run.id});return;
     }
     acceptedEffect=proposed.effect;await event(c,current,'ai.proposal_accepted',{ai_run_id:run.id,intent:p.intent,effect_id:acceptedEffect.id});}
    await save(c,run,{...resultBody,status:'COMPLETED',effect_proposal_block:null,completed_at:new Date().toISOString()});
	   const body:Body={...current.body,ai_pending:false,ai_status:'COMPLETED',active_ai_run_id:null};
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
  };
  if(lab&&(snapshot.cachedProposal||nativeAi?.invocation.state==='SUCCEEDED'))await lab.proposalTransaction(snapshot.conv,snapshot.agent,snapshot.run,nativeAi,sellerInstructions(snapshot.sellerSnapshot),snapshot.context as unknown as Record<string,unknown>,reconcile);else await store.transaction(reconcile);
 }
 return candidates.length;
}
// Existing workers retain their original provider and SQL dependencies.
export async function processAgents(limit=5,override?:SalesAiProvider){return processAgentsImpl(agentStore,limit,override);}
/** Both arguments are protected opaque host handles, never public action data. */
export async function processNumberLabAgents(lease:NumberLabEngineLease,seller:NumberLabSeller,limit=5){
 if(!Number.isInteger(limit)||limit<1||limit>5)throw Error('LAB_ENGINE_BATCH_LIMIT');
 return withNumberLabEngine(lease,async ports=>{
  const bound=bindNumberLabSeller(seller,ports),processed=await processAgentsImpl({query:ports.query,transaction:work=>ports.transaction(work)},limit,undefined,bound);
  const current=await ports.transaction(async db=>{const conversation=await getRecord(db,ports.workspaceId,'conversation',bound.conversationId);
   const row=(await db.query("SELECT id,body FROM records WHERE workspace_id=$1 AND kind='ai_run' AND body->>'conversation_id'=$2 ORDER BY created_at DESC,id DESC LIMIT 1",[ports.workspaceId,bound.conversationId])).rows[0];
   const status=row?.body.status??null,providerState=row?.body.lab_ai?.state??null;
   if(status!==null&&!['RUNNING','AWAITING_EFFECT','COMPLETED','FAILED','DISCARDED'].includes(status)||providerState!==null&&!['SUCCEEDED','REJECTED','UNCERTAIN'].includes(providerState))throw Error('LAB_SELLER_RESULT_INVALID');
   return{run_id:row?.id??null,status:status as 'RUNNING'|'AWAITING_EFFECT'|'COMPLETED'|'FAILED'|'DISCARDED'|null,provider_state:providerState as 'SUCCEEDED'|'REJECTED'|'UNCERTAIN'|null,human_review:conversation?.body.ai_status==='HUMAN_REVIEW',dependency:row?.body.effect_proposal_block??null};
  });return{processed,...current};
 });
}
export async function processReceiptAnalyses(limit=3,override?:SalesAiProvider){
 const rows=(await query(`SELECT * FROM records WHERE kind='receipt' AND body->>'analysis_status'='PENDING' AND body->>'review' IS NULL ORDER BY created_at LIMIT $1`,[limit])).rows as DomainRecord[];
 for(const receipt of rows){const snapshot=await withTransaction(async c=>{const operationalRevision=(await readOperationalSettings(c,receipt.workspace_id,receipt.environment,{lock:'share'})).version;await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[receipt.body.conversation_id]);const r=await getRecord(c,receipt.workspace_id,'receipt',receipt.id);if(!r||r.body.analysis_status!=='PENDING'||r.body.review||await receiptReviewPending(c,r))return;const order=r.body.order_id?await getRecord(c,r.workspace_id,'order',r.body.order_id):undefined;const hasPolicyTable=(await c.query("SELECT to_regclass('public.receipt_order_policy_snapshots') AS present")).rows[0]?.present;const captured=hasPolicyTable&&order&&(await c.query('SELECT 1 FROM receipt_order_policy_snapshots WHERE workspace_id=$1 AND environment=$2 AND order_id=$3',[r.workspace_id,r.environment,order.id])).rows.length>0;if(order?.body.receipt_policy_snapshot_sha256||captured){await save(c,r,{...r.body,analysis_dependency:'RECEIPT_AI_019_REQUIRED'});return;}const conv=await getRecord(c,r.workspace_id,'conversation',r.body.conversation_id);if(!conv||await gated(c,conv))return;const agent=conv.body.agent_version_id?await getRecord(c,r.workspace_id,'agent',conv.body.agent_version_id):undefined;const asset=await getRecord(c,r.workspace_id,'asset',r.body.asset_id);if(!asset)return;if(!agent||agent.body.provider==='deterministic'){await save(c,r,{...r.body,analysis_status:'HUMAN_REQUIRED',analysis_dependency:'VISION_PROVIDER_NOT_CONFIGURED'});return;}await save(c,r,{...r.body,analysis_status:'RUNNING',analysis_configuration_revision:operationalRevision,analysis_started_at:new Date().toISOString()});return{receipt:r,conv,agent,asset,operationalRevision};});if(!snapshot)continue;
  let extraction:unknown;let failure:string|undefined;try{const root=process.env.PRIVATE_STORAGE_DIR??process.env.ASSET_STORAGE_DIR;if(!root||!/^[a-f0-9-]{36}(?:-[a-f0-9]{64})?$/.test(snapshot.asset.body.storage_key))throw new Error('PRIVATE_ASSET_NOT_CONFIGURED');const bytes=Buffer.from(decrypt(await readFile(join(root,'assets',`${snapshot.asset.body.storage_key}.enc`),'utf8')),'base64');const configured=await configuredAi(snapshot.agent,snapshot.conv.workspace_id,snapshot.conv.environment,override);if((await readOperationalSettings(pool,snapshot.conv.workspace_id,snapshot.conv.environment)).version!==snapshot.operationalRevision)throw new Error('CONFIGURATION_CHANGED');extraction=await configured.provider.receipt(configured.agent,{bytes,mimeType:snapshot.asset.body.mime_type});}catch(error){failure=error instanceof Error&&/^[A-Z_0-9]+$/.test(error.message)?error.message:'RECEIPT_ANALYSIS_FAILED';}
  await withTransaction(async c=>{const configurationChanged=(await readOperationalSettings(c,receipt.workspace_id,receipt.environment,{lock:'share'})).version!==snapshot.operationalRevision;await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[receipt.body.conversation_id]);const current=await getRecord(c,receipt.workspace_id,'receipt',receipt.id);if(!current||current.body.analysis_status!=='RUNNING'||current.body.review||await receiptReviewPending(c,current))return;if(configurationChanged){await save(c,current,{...current.body,analysis_status:'DISCARDED',analysis_dependency:'CONFIGURATION_CHANGED'});return;}if(failure){await save(c,current,{...current.body,analysis_status:'HUMAN_REQUIRED',analysis_dependency:failure});return;}const conv=await getRecord(c,current.workspace_id,'conversation',current.body.conversation_id);if(!conv||await gated(c,conv)){await save(c,current,{...current.body,analysis_status:'DISCARDED',analysis_dependency:'CONTROLS_CHANGED'});return;}await applyReceiptAnalysis(c,current,extraction,receipt.id);});
 }
 return rows.length;
}
