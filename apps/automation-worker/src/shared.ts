import {currentProfileExecutor} from '../../../packages/db/src/profile-query-routing.js';
import {readCommercialContinuity} from '../../../packages/db/src/continuous-commercial.js';
import {assignmentFor,assignmentGate,channelIdentityHash} from '../../../packages/db/src/commercial-assignments.js';
import {commercialWarmupGuard} from '../../../packages/db/src/warmup.js';
import {authorizedRecipient} from '../../../packages/domain/src/sales/authorization.js';
import {appendEvent,getRecord,putRecord,uuid,hash,stableJson,type QueryExecutor} from '@commerce/db';
import type {DomainRecord,Body} from '@commerce/contracts';
import {readOperationalSettings} from '../../../packages/db/src/operational-settings.js';
import {effectiveNumberFlowControls} from '../../../packages/db/src/number-flow-controls.js';
export async function save(client:QueryExecutor,record:DomainRecord,body:Body){return putRecord(client,{id:record.id,workspaceId:record.workspace_id,environment:record.environment,kind:record.kind,version:record.version,body});}
export async function event(client:QueryExecutor,record:DomainRecord,type:string,payload:Body={},cause?:string){return appendEvent(client,{workspace_id:record.workspace_id,environment:record.environment,event_type:type,aggregate_id:record.id,correlation_id:record.body.correlation_id??record.id,causation_id:cause,actor:{type:'automation'},payload});}
export async function commercialContext(client:QueryExecutor,conversation:DomainRecord){const order=(await client.query("SELECT id FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='order' AND body->>'conversation_id'=$3 LIMIT 1",[conversation.workspace_id,conversation.environment,conversation.id])).rows[0];return{physical_chat_id:conversation.body.physical_chat_id,assignment_id:conversation.body.assignment_id,assignment_revision:conversation.body.assignment_revision,binding_id:conversation.body.binding_id,product_id:conversation.body.product_id,journey_id:conversation.id,order_id:order?.id,offer_version_id:conversation.body.offer_version_id,workflow_version_id:conversation.body.workflow_version_id,agent_version_id:conversation.body.agent_version_id};}
export function withStageAtCreation(conversation:DomainRecord,body:Body):Body{return{...body,stage_at_creation:typeof conversation.body.stage==='string'?conversation.body.stage:null};}
export async function create(client:QueryExecutor,record:DomainRecord,kind:string,body:Body){const context=record.kind==='conversation'&&['order','receipt','fulfillment','ai_run','message'].includes(kind)?await commercialContext(client,record):{},historical=record.kind==='conversation'&&kind==='message'?withStageAtCreation(record,{}):{};return putRecord(client,{workspaceId:record.workspace_id,environment:record.environment,kind,body:{...context,...body,...historical}});}
/** Caller holds the conversation lock; never lock command rows in this check. */
export async function receiptReviewPending(client:QueryExecutor,receipt:DomainRecord){return !!(await client.query("SELECT 1 FROM commands WHERE workspace_id=$1 AND environment=$2 AND kind='receipt_review' AND resource_id=$3 AND status='PENDING' LIMIT 1",[receipt.workspace_id,receipt.environment,receipt.id])).rowCount;}
export async function controls(client:QueryExecutor,conversation:DomainRecord){const rows=(await client.query(`SELECT * FROM manual_controls WHERE workspace_id=$1 AND ((scope_type='workspace' AND scope_id=$1) OR (scope_type='conversation' AND scope_id=$2) OR (scope_type='contact' AND scope_id=$3) OR (scope_type='channel_account' AND scope_id=$4) OR (scope_type='workflow' AND scope_id=$5))`,[conversation.workspace_id,conversation.id,conversation.body.contact_id,conversation.body.account_id,conversation.body.workflow_version_id??''])).rows;return effectiveNumberFlowControls(client,conversation,rows);}
export async function gated(client:QueryExecutor,conversation:DomainRecord){if(await assignmentGate(client,conversation))return true;const c=await controls(client,conversation);return c.some(x=>x.paused||x.takeover||x.suppressed);}
export type EffectProposalBlockReason='ASSIGNMENT_UNAVAILABLE'|'ASSET_NOT_DELIVERABLE'|'COMMERCIAL_WARMUP_BLOCKED'|'CONTINUITY_ASSIGNMENT_UNAVAILABLE'|'REAL_OPERATION_NOT_ENABLED'|'CONTINUITY_AUTHORITY_UNAVAILABLE';
export type EffectProposalOutcome={state:'CREATED'|'EXISTING_MATCH';effect:Body}|{state:'BLOCKED';reason:EffectProposalBlockReason};
/** Compatibility adapter for existing row consumers. Orchestrators use the
 * explicit result so absence cannot masquerade as successful progress. The legacy
 * database-row signature remains intentionally untyped for existing consumers. */
export async function proposeEffect(...args:Parameters<typeof proposeEffectOutcome>):Promise<any>{
 const result=await proposeEffectOutcome(...args);return result.state==='BLOCKED'?undefined:result.effect;
}
export async function proposeEffectOutcome(client:QueryExecutor,conversation:DomainRecord,payload:Body,key:string,options:{authorizationId?:string;notBefore?:string;expiresAt?:string;predecessorId?:string;actorKind?:string;campaignId?:string}={}):Promise<EffectProposalOutcome>{
  // Callers use a transaction; this also serializes campaigns and concurrent proposals.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[conversation.id]);
  const order=(await client.query("SELECT id FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='order' AND body->>'conversation_id'=$3 LIMIT 1",[conversation.workspace_id,conversation.environment,conversation.id])).rows[0];
  const fullPayload:Body=withStageAtCreation(conversation,{...payload,purpose:payload.purpose??'commercial',physical_chat_id:conversation.body.physical_chat_id,assignment_id:conversation.body.assignment_id,assignment_revision:conversation.body.assignment_revision,binding_id:conversation.body.binding_id,product_id:conversation.body.product_id,journey_id:conversation.id,order_id:payload.order_id??order?.id,agent_version_id:conversation.body.agent_version_id,actor_kind:options.actorKind??'automation',offer_version_id:conversation.body.offer_version_id,workflow_version_id:conversation.body.workflow_version_id,...(options.campaignId?{campaign_id:options.campaignId}:{})});
  const existing=(await client.query('SELECT * FROM outbox WHERE workspace_id=$1 AND logical_key=$2 FOR SHARE',[conversation.workspace_id,key])).rows[0];
  const reuse=(row:Body):EffectProposalOutcome=>{
    const recorded={...row.payload};
    // The old temporal path adds this server-owned field. Do not derive a new
    // authorization merely to recognize the exact original proposal.
    if(!Object.hasOwn(fullPayload,'approval_config_hash'))delete recorded.approval_config_hash;
    const sameTime=(a:unknown,b:string)=>Number.isFinite(Date.parse(b))&&new Date(String(a)).getTime()===Date.parse(b);
    if(row.environment!==conversation.environment||row.account_id!==conversation.body.account_id||row.conversation_id!==conversation.id
      ||row.contact_id!==conversation.body.contact_id||stableJson(recorded)!==stableJson(fullPayload)
      ||row.config_hash!==hash(stableJson({account_id:row.account_id,contact_id:row.contact_id,payload:row.payload}))
      ||options.authorizationId!==undefined&&row.authorization_id!==options.authorizationId
      ||options.predecessorId!==undefined&&row.predecessor_id!==options.predecessorId
      ||options.notBefore!==undefined&&!sameTime(row.not_before,options.notBefore)
      ||options.expiresAt!==undefined&&!sameTime(row.expires_at,options.expiresAt))throw new Error('EFFECT_PROPOSAL_CONFLICT');
    return{state:'EXISTING_MATCH',effect:row};
  };
  if(existing)return reuse(existing);
  if(await assignmentGate(client,conversation))return{state:'BLOCKED',reason:'ASSIGNMENT_UNAVAILABLE'};
  if(payload.asset_id){const asset=await getRecord(client,conversation.workspace_id,'asset',payload.asset_id);if(asset?.body.delivery_eligible===false||asset?.body.usage==='MARKETING_REFERENCE')return{state:'BLOCKED',reason:'ASSET_NOT_DELIVERABLE'};}
  const channel=await getRecord(client,conversation.workspace_id,'channel_account',conversation.body.account_id);if(channel&&await commercialWarmupGuard(client,channel))return{state:'BLOCKED',reason:'COMMERCIAL_WARMUP_BLOCKED'};
  const control=await controls(client,conversation);const controlVersion=control.filter(x=>x.scope_type==='conversation').reduce((m,x)=>Math.max(m,x.version),0);
  const previous=options.predecessorId??(await client.query('SELECT id FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY dispatch_sequence DESC LIMIT 1',[conversation.workspace_id,conversation.id])).rows[0]?.id;
  let continuousAuthorizationId:string|undefined,initialBlock:string|undefined;
  let authorizationId=options.authorizationId,approved=conversation.environment==='SIMULATION';
  // An owner authorizes a bounded number/assignment/contact scope. Only newly
  // proposed effects inherit it; existing blocked effects retain their old approval.
  if(conversation.environment==='REAL'&&!authorizationId&&!options.campaignId){
    const db=currentProfileExecutor(conversation.workspace_id);
    if(!db)throw new Error('CONTINUITY_PROFILE_CONTEXT_REQUIRED');
    if(!conversation.body.assignment_id||!channel||channel.body.sending_enabled!==true)return{state:'BLOCKED',reason:'CONTINUITY_ASSIGNMENT_UNAVAILABLE'};
    const settings=await readOperationalSettings(db,conversation.workspace_id,'REAL',{lock:'share'});
    if(settings.body.dispatch_frozen||!settings.body.real_sends_enabled||!settings.body.allow_real_operations)return{state:'BLOCKED',reason:'REAL_OPERATION_NOT_ENABLED'};
    const authority=await readCommercialContinuity(db,'REAL',{assignmentId:conversation.body.assignment_id,assignmentRevision:conversation.body.assignment_revision,
      bindingId:conversation.body.binding_id,accountId:conversation.body.account_id,productId:conversation.body.product_id});
    if(!authority)return{state:'BLOCKED',reason:'CONTINUITY_AUTHORITY_UNAVAILABLE'};
    continuousAuthorizationId=authority.id;approved=true;initialBlock=authority.humanPaused?'CONTINUITY_HUMAN_PAUSED':authority.protections.length?'CONTINUITY_PROTECTED':undefined;
  }else if(conversation.environment==='REAL'){
    const account=await getRecord(client,conversation.workspace_id,'channel_account',conversation.body.account_id);
    const assignment=conversation.body.assignment_id?await assignmentFor(client,conversation.workspace_id,conversation.environment,conversation.body.assignment_id):undefined;
    const candidate=authorizationId??(assignment?assignment.authorization_id:account?.body.active_authorization_id);
    if(candidate&&account?.body.sending_enabled===true){
      const settings=await readOperationalSettings(client,conversation.workspace_id,'REAL',{lock:'share'});
      const auth=(await client.query('SELECT * FROM read_locked_operation_authorization($1,$2,$3)',[candidate,conversation.workspace_id,'REAL'])).rows[0];
      const scope=auth?.scope??{};
      const assignmentScope=assignment?scope.mode==='product_assignment'&&scope.channel_identity_hash===channelIdentityHash(account)&&assignment.authorization_id===candidate&&scope.assignment_id===assignment.id&&scope.assignment_revision===assignment.revision&&scope.binding_id===assignment.binding_id&&scope.product_id===conversation.body.product_id:scope.mode==='channel_setup'&&account.body.active_authorization_id===candidate&&Number(scope.assignment_revision)===Number(account.body.assignment_revision??0);
      if(assignmentScope&&auth.configuration_version===settings.version&&!settings.body.dispatch_frozen&&settings.body.real_sends_enabled&&settings.body.allow_real_operations&&scope.account_ids?.includes(account.id)&&scope.offer_version_ids?.includes(conversation.body.offer_version_id)&&scope.workflow_version_ids?.includes(conversation.body.workflow_version_id)&&authorizedRecipient(auth,conversation.body.contact_id,conversation)&&(scope.agent_version_id??null)===(conversation.body.agent_version_id??null)&&(fullPayload.actor_kind==='human'||scope.allow_automation===true)&&!options.campaignId){
        authorizationId=auth.id;fullPayload.approval_config_hash=auth.config_hash;approved=true;
      }
    }
  }
  const configHash=hash(stableJson({account_id:conversation.body.account_id,contact_id:conversation.body.contact_id,payload:fullPayload}));
  const virtualNow=conversation.environment==='SIMULATION'&&conversation.body.simulation_id?await nowFor(client,conversation):undefined;
  const row=(await client.query('INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,predecessor_id,config_hash,approval_hash,authorization_id,continuous_authorization_id,control_version,not_before,expires_at,status,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,COALESCE($15,now()),COALESCE($16,now()+interval \'24 hours\'),$17,$18) ON CONFLICT(workspace_id,logical_key) DO NOTHING RETURNING *',[uuid(),conversation.workspace_id,conversation.environment,conversation.body.account_id,conversation.id,conversation.body.contact_id,key,fullPayload,previous??null,configHash,approved?configHash:null,authorizationId??null,continuousAuthorizationId??null,controlVersion,options.notBefore??virtualNow?.toISOString()??null,options.expiresAt??(virtualNow?new Date(virtualNow.getTime()+24*3600_000).toISOString():null),initialBlock?'BLOCKED':'READY',initialBlock?{reason:initialBlock}:{}])).rows[0];
  if(row){await event(client,conversation,'effect.proposed',{effect_id:row.id,kind:payload.kind,config_hash:configHash},key);return{state:'CREATED',effect:row};}
  const raced=(await client.query('SELECT * FROM outbox WHERE workspace_id=$1 AND logical_key=$2 FOR SHARE',[conversation.workspace_id,key])).rows[0];
  if(!raced)throw new Error('EFFECT_PROPOSAL_READBACK_REQUIRED');return reuse(raced);
}
export async function cancelPending(client:QueryExecutor,conversation:DomainRecord,reason:string,allContact=false){await client.query(`UPDATE outbox SET status='CANCELLED',result=jsonb_build_object('reason',$3::text),updated_at=now() WHERE workspace_id=$1 AND ${allContact?'contact_id':'conversation_id'}=$2 AND status IN ('READY','BLOCKED')`,[conversation.workspace_id,allContact?conversation.body.contact_id:conversation.id,reason]);await client.query(`UPDATE timers SET status='CANCELLED' WHERE workspace_id=$1 AND conversation_id IN (SELECT id::text FROM records WHERE workspace_id=$1 AND kind='conversation' AND ($3::boolean=false AND id::text=$2 OR $3::boolean=true AND body->>'contact_id'=$2)) AND status='PENDING'`,[conversation.workspace_id,allContact?conversation.body.contact_id:conversation.id,allContact]);}
export async function nowFor(client:QueryExecutor,conversation:DomainRecord):Promise<Date>{if(conversation.environment==='SIMULATION'&&conversation.body.simulation_id){const s=await getRecord(client,conversation.workspace_id,'simulation',conversation.body.simulation_id);if(s?.environment===conversation.environment&&s.body.virtual_now)return new Date(s.body.virtual_now);}return new Date();}

/** Business progress supersedes only collection/follow-up intents; fulfillment survives financial review. */
export async function cancelCollectionPending(client:QueryExecutor,conversation:DomainRecord,reason:string){
 const cancelled=(await client.query(`UPDATE outbox SET status='CANCELLED',result=jsonb_build_object('reason',$3::text,'superseded_before_send',attempts=0),updated_at=now() WHERE workspace_id=$1 AND conversation_id=$2 AND status IN('READY','BLOCKED') AND (payload->>'purpose' IN('collection','followup') OR payload ? 'payment_profile_version_id') AND NOT payload ? 'fulfillment_id' AND payload->>'kind' IS DISTINCT FROM 'grant' RETURNING id`,[conversation.workspace_id,conversation.id,reason])).rows;
 await client.query(`UPDATE timers SET status='CANCELLED' WHERE workspace_id=$1 AND conversation_id=$2 AND status='PENDING' AND (kind='followup' OR payload->>'purpose'='collection')`,[conversation.workspace_id,conversation.id]);
 if(cancelled.length)await event(client,conversation,'collection.superseded',{reason,effect_ids:cancelled.map(e=>e.id),rule:'UNATTEMPTED_INTENTS_ONLY_MAY_BE_BYPASSED'});
}
