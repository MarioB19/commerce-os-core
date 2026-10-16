import {recordProfileExecutor} from '../../../packages/db/src/profile-record-context.js';
import {bindRecordEnvironment} from '../../../packages/db/src/profile-environment.js';
import {validateLegacyWarmupEffectOrigins} from '../../../packages/db/src/legacy-qr-warmup.js';
import {readContinuousEffectAuthority} from '../../../packages/db/src/continuous-effect.js';
import {readCurrentQrContinuity,continuousWarmupAuthorityBlock} from '../../../packages/db/src/continuous-warmup.js';
import {preparationGate} from '../../../packages/db/src/preparation.js';
import {gateGroupDispatch} from './warmup-group-dispatch.js';
import {getRecord,decrypt,hash,stableJson,readOperationalSettings,type QueryExecutor} from '@commerce/db';
import {readEffectiveHealthBatch,currentEffectiveSignal,currentRestrictionClear,effectiveHealthBlockers} from '../../../packages/db/src/effective-health.js';
import type {Body,DomainRecord} from '@commerce/contracts';
import {profileFor,reserveWarmupRate,warmupIdentityMatches} from '../../../packages/db/src/warmup.js';
import {localWindow,dailyBudget} from '../../../packages/domain/src/warmup/policy.js';
import {isStandard15dPolicy} from '../../../packages/domain/src/warmup/policy.js';
import {assertGatewayIsolation} from './providers.js';

/** Own-pool traffic uses the same durable dispatcher, but never invents a sales contact. */
export async function gateWarmupDispatch(c:QueryExecutor,effect:Body,owner:string):Promise<{allowed:boolean;reason?:string;account?:DomainRecord;contact?:DomainRecord;leaseMs?:number}>{
 await bindRecordEnvironment(c,effect.workspace_id,effect.environment);
 if(effect.payload.group_protocol==='v1')return gateGroupDispatch(c,effect,owner);
 const deny=(reason:string)=>({allowed:false,reason});
 const turn=(await c.query(`SELECT t.*,v.content_id,v.local_date::text AS local_date,v.initiator_id,v.peer_id,p.id pool_id,p.profile_id,p.enabled,p.paused pool_paused,p.breaker_open,p.purpose,to_jsonb(p)->>'continuity_mode' AS continuity_mode,p.authorization_id pool_authorization_id FROM warmup_turns t JOIN warmup_conversations v ON v.id=t.conversation_id JOIN warmup_states s ON s.account_id=t.sender_id JOIN warmup_pools p ON p.id=s.pool_id WHERE t.id::text=$1 AND t.workspace_id=$2 AND t.environment=$3 FOR SHARE OF p`,[effect.payload.warmup_turn_id,effect.workspace_id,effect.environment])).rows[0];
 if(!turn||turn.effect_id!==effect.id||turn.sender_id!==effect.account_id||turn.recipient_id!==effect.contact_id||turn.conversation_id!==effect.conversation_id)return deny('WARMUP_EFFECT_SCOPE_INVALID');
 if(new Date(effect.not_before).getTime()!==new Date(turn.not_before).getTime()||new Date(effect.expires_at).getTime()!==new Date(turn.expires_at).getTime())return deny('WARMUP_TURN_TIMING_CHANGED');
 if(!turn.enabled||turn.pool_paused||turn.breaker_open)return deny('WARMUP_POOL_PAUSED');
 const continuous=turn.continuity_mode==='QR_CONTINUOUS';
 if(continuous&&!effect.continuous_authorization_id)return deny('WARMUP_AUTHORITY_MODE_MISMATCH');
 const virtual=(await c.query("SELECT r.virtual_now,r.status,r.input FROM warmup_simulation_runs r JOIN warmup_conversations v ON v.simulation_run_id=r.id WHERE v.id=$1 AND v.environment='SIMULATION'",[turn.conversation_id])).rows[0];
 if(virtual&&virtual.status!=='RUNNING')return deny('SIMULATION_RUN_NOT_RUNNING');
 const now=virtual?.virtual_now??(await c.query('SELECT now() now')).rows[0].now as Date;
 if(new Date(effect.expires_at)<=now)return deny('EFFECT_EXPIRED');
 if(new Date(effect.not_before)>now)return deny('WARMUP_TURN_NOT_DUE');
 const profile=await profileFor(c,turn.profile_id);if(!localWindow(profile,now).open)return deny('WARMUP_QUIET_HOURS');
 const content=(await c.query('SELECT body,content_hash FROM warmup_content WHERE id=$1 AND workspace_id=$2 AND environment=$3',[turn.content_id,effect.workspace_id,effect.environment])).rows[0];
 if(!content||content.content_hash!==effect.payload.content_hash||stableJson(turn.content)!==stableJson(content.body.turns[turn.position]))return deny('WARMUP_CONTENT_CHANGED');
 const expectedPayload={...turn.content,warmup_turn_id:turn.id,warmup_pool_id:turn.pool_id,content_hash:content.content_hash};
 if(stableJson(effect.payload)!==stableJson(expectedPayload)||hash(stableJson({account_id:effect.account_id,contact_id:effect.contact_id,payload:effect.payload}))!==effect.config_hash)return deny('EFFECT_CONFIG_CHANGED');
 const ids=[turn.sender_id,turn.recipient_id];
 const states=(await c.query(`SELECT s.*,i.address_ciphertext,i.address_fingerprint,i.profile_verified_at,to_jsonb(i)->>'qr_verified_at' AS qr_verified_at,to_jsonb(i)->>'qr_command_id' AS qr_command_id,to_jsonb(i)->>'qr_identity_fingerprint' AS qr_identity_fingerprint FROM warmup_states s LEFT JOIN warmup_identities i ON i.id=s.identity_id AND i.account_id=s.account_id WHERE s.account_id=ANY($1::uuid[]) AND s.pool_id=$2 AND s.workspace_id=$3 AND s.environment=$4 FOR SHARE OF s`,[ids,turn.pool_id,effect.workspace_id,effect.environment])).rows;
 if(states.length!==2||states.some(s=>s.paused||!s.profile_ready_at||new Date(s.profile_ready_at)>now||!['WARMING','AWAITING_CONTENT','GRADUATED'].includes(s.status)||(!continuous&&!s.profile_verified_at)||!s.address_ciphertext))return deny('WARMUP_MEMBER_NOT_READY');
 const account=await getRecord(c,effect.workspace_id,'channel_account',turn.sender_id),peer=await getRecord(c,effect.workspace_id,'channel_account',turn.recipient_id);
 if(!account||!peer||[account,peer].some(a=>a.environment!==effect.environment||a.body.deleted_at||a.body.status!=='WORKING'))return deny('WARMUP_SESSION_NOT_WORKING');
 if(effect.environment==='SIMULATION'&&[account,peer].some(a=>a.body.provider!=='simulator'))return deny('SIMULATION_EXTERNAL_PROVIDER_DENIED');
 if(effect.environment==='REAL'&&[account,peer].some(a=>a.body.provider!=='waha'||a.body.identity_verified!==true||a.body.identity_conflict))return deny('WARMUP_IDENTITY_NOT_VERIFIED');
 if([account,peer].some(member=>!warmupIdentityMatches(member,states.find(state=>state.account_id===member.id)!)))return deny('WARMUP_REGISTERED_IDENTITY_CHANGED');
 if(isStandard15dPolicy(profile.policy_version)&&turn.purpose!=='maintenance')for(const id of ids)if(!(await preparationGate(c,id,now)).ready)return deny('PREPARATION_REQUIREMENTS_PENDING');
 if(turn.purpose==='maintenance'&&(states.some(s=>s.status!=='GRADUATED')||(await c.query("SELECT 1 FROM outbox WHERE account_id=ANY($1::text[]) AND kind<>'warmup' AND status IN('READY','BLOCKED','SENDING','UNKNOWN')",[ids])).rowCount))return deny('COMMERCIAL_PRIORITY');
 if((await c.query("SELECT 1 FROM outbox WHERE account_id=ANY($1::text[]) AND id<>$2 AND status IN('SENDING','UNKNOWN')",[ids,effect.id])).rowCount)return deny('WARMUP_RECONCILIATION_REQUIRED');
 const controls=(await c.query(`SELECT * FROM manual_controls WHERE workspace_id=$1 AND ((scope_type='workspace' AND scope_id=$1) OR (scope_type='channel_account' AND scope_id=ANY($2::text[]))) FOR SHARE`,[effect.workspace_id,ids])).rows;
 if(controls.some(x=>x.paused||x.suppressed||x.takeover))return deny('WARMUP_MANUAL_CONTROL');
 const ownership=(await c.query('SELECT *,extract(epoch FROM(lease_expires_at-now()))*1000 lease_ms FROM session_ownership WHERE workspace_id=$1 AND account_id=ANY($2::text[]) FOR SHARE',[effect.workspace_id,ids])).rows;
 const senderOwner=ownership.find(o=>o.account_id===account.id);
 if(ownership.length!==2||ownership.some(o=>o.frozen||Number(o.lease_ms)<2000)||senderOwner?.owner_id!==owner)return deny('OWNERSHIP_NOT_CONFIRMED');
 // The numbers lifecycle simulator emits health on its virtual clock. The
 // isolated conversation fixture emits provider health on wall time.
 const healthNow=effect.environment==='SIMULATION'&&virtual?.input?.scenario!=='numbers-lifecycle'?new Date():now;
 const healthByAccount=await readEffectiveHealthBatch(c,{workspaceId:effect.workspace_id,environment:effect.environment,accountIds:ids,now:healthNow});
 for(const member of [account,peer]){
  const health=healthByAccount.get(member.id)!,session=currentEffectiveSignal(health,'session'),transport=currentEffectiveSignal(health,'transport');
  if(session?.status!=='OK'||member.body.provider==='waha'&&!currentRestrictionClear(health)||effectiveHealthBlockers(health).length)return deny('WARMUP_HEALTH_NOT_READY');
  if(effect.environment==='REAL'){
   if(transport?.status!=='OK'||(transport.value as Body|undefined)?.identity_fingerprint!==member.body.identity_fingerprint)return deny('CONNECTED_IDENTITY_EVIDENCE_STALE');
   try{await assertGatewayIsolation(member,c);}catch{return deny('CHANNEL_GATEWAY_ISOLATION_NOT_CONFIRMED');}
  }
 }
 if(effect.predecessor_id){const predecessor=(await c.query('SELECT status FROM outbox WHERE id=$1 AND workspace_id=$2 AND conversation_id=$3',[effect.predecessor_id,effect.workspace_id,effect.conversation_id])).rows[0];if(!predecessor||!['DELIVERED','READ'].includes(predecessor.status))return deny('CAUSAL_PREDECESSOR_UNRESOLVED');const received=(await c.query('SELECT received_envelope_id FROM warmup_turns WHERE effect_id=$1',[effect.predecessor_id])).rows[0];if(!received?.received_envelope_id)return deny('WARMUP_PEER_RECEIPT_PENDING');}
 const policy=await readOperationalSettings(c,effect.workspace_id,effect.environment,{lock:'share'});
 if(effect.environment==='REAL'&&(policy.body.dispatch_frozen||!policy.body.real_sends_enabled||!policy.body.allow_real_operations))return deny('REAL_OPERATION_NOT_ENABLED');
 let legacyBound=false,legacyDeadline:Date|null=null;
 if(continuous){
  const db=await recordProfileExecutor(c,effect.workspace_id,effect.environment);
  const read=await readContinuousEffectAuthority(db,effect.environment,effect.id);if(read.state==='EXPIRED')return deny(read.reason);
  const own=await readCurrentQrContinuity(db,effect.environment,account.id),other=await readCurrentQrContinuity(db,effect.environment,peer.id);
  if(!own||own.id!==read.authorization.id)return deny('CONTINUITY_QR_ORIGIN_CHANGED');
  const reason=continuousWarmupAuthorityBlock(own,other,{workspaceId:effect.workspace_id,environment:effect.environment,senderId:account.id,peerId:peer.id});
  if(reason)return deny(reason);
  for(const authority of [own,other!]){
   const identity=states.find(state=>state.account_id===authority.accountId)!;
   if(authority.source.kind!=='VERIFIED_QR_CONNECTION'||!identity.qr_verified_at||new Date(identity.qr_verified_at)>now
    ||identity.qr_command_id!==authority.source.connectionId||identity.qr_identity_fingerprint!==authority.source.identityFingerprint)
    return deny('CONTINUITY_QR_IDENTITY_REQUIRED');
  }
  if(effect.authorization_id||effect.approval_hash!==effect.config_hash)return deny('WARMUP_AUTHORIZATION_INVALID');
 }else{
  let bound=false;
  if((await c.query("SELECT to_regclass('public.warmup_effect_origins') AS present")).rows[0]?.present){
   const db=await recordProfileExecutor(c,effect.workspace_id,effect.environment);
   const authority=await validateLegacyWarmupEffectOrigins(db,{environment:effect.environment,effectId:effect.id,senderId:account.id,
    accountIds:ids,poolId:turn.pool_id,profileId:turn.profile_id,contentId:turn.content_id,policyVersion:profile.policy_version,
    purpose:turn.purpose,groupId:null,groupVersion:null,configurationVersion:policy.version});
   if(authority.kind==='BLOCKED')return deny(authority.reason);bound=authority.kind==='BOUND';if(authority.kind==='BOUND')legacyDeadline=authority.temporalExpiresAt;
  }
  if(bound){if(effect.approval_hash!==effect.config_hash)return deny('WARMUP_AUTHORIZATION_INVALID');legacyBound=true;}
  else{
   if(effect.continuous_authorization_id)return deny('QR_EFFECT_ORIGINS_REQUIRED');

 const auth=(await c.query('SELECT * FROM read_locked_operation_authorization($1,$2,$3)',[effect.authorization_id,effect.workspace_id,effect.environment])).rows[0];
 if(!auth||auth.id!==turn.pool_authorization_id||auth.configuration_version!==policy.version)return deny('WARMUP_AUTHORIZATION_INVALID');
 const scope=auth.scope??{};
 if(scope.mode!=='warmup'||scope.pool_id!==turn.pool_id||scope.policy_version&&scope.policy_version!==profile.policy_version||!ids.every(id=>scope.account_ids?.includes(id))||!scope.content_ids?.includes(turn.content_id)||effect.approval_hash!==effect.config_hash)return deny('WARMUP_AUTHORIZATION_INVALID');
 const used=Number((await c.query("SELECT count(*) FROM outbox WHERE authorization_id=$1 AND id<>$2 AND status IN('SENDING','SENT','DELIVERED','READ','UNKNOWN')",[auth.id,effect.id])).rows[0].count);
 if(!Number.isSafeInteger(scope.max_messages)||used>=scope.max_messages)return deny('AUTHORIZATION_MESSAGE_LIMIT');
  }
 }
 if(continuous||legacyBound){
  // A permanent grant has no lifetime message counter. Enforce the existing
  // daily curve at claim AND final emission, serialized for both own endpoints.
  for(const id of [...ids].sort())await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`warmup-daily:${effect.workspace_id}:${effect.environment}:${id}`]);
  for(const state of states){
   if(localWindow(profile,now).date!==turn.local_date)return deny('WARMUP_PLAN_DAY_CHANGED');
   const plan=(await c.query('SELECT * FROM warmup_plans WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND profile_id=$4 AND local_date=$5',[effect.workspace_id,effect.environment,state.account_id,state.profile_id,turn.local_date])).rows[0];
   if(!plan||plan.episode_id!==state.episode_id||!Number.isInteger(plan.effective_day)||plan.effective_day<1)return deny('WARMUP_PLAN_REQUIRED');
   const budget=dailyBudget(profile,turn.purpose==='maintenance'?1:plan.effective_day,now);
   if(stableJson(plan.budget)!==stableJson(budget))return deny('WARMUP_PLAN_BUDGET_CHANGED');
   const consumed=(await c.query(`SELECT count(*)::int AS messages,count(DISTINCT o.conversation_id)::int AS conversations,
    COALESCE(bool_or(o.conversation_id=$4),false) AS current_conversation
    FROM outbox o JOIN warmup_turns t ON t.effect_id=o.id JOIN warmup_conversations v ON v.id=t.conversation_id
    WHERE o.workspace_id=$1 AND o.environment=$2 AND o.kind='warmup' AND v.local_date=$5
     AND (o.account_id=$3::text OR o.contact_id=$3::text OR $3::uuid=ANY(t.recipient_ids))
     AND o.id<>$6 AND o.status IN('SENDING','SENT','DELIVERED','READ','UNKNOWN')`,
   [effect.workspace_id,effect.environment,state.account_id,effect.conversation_id,localWindow(profile,now).date,effect.id])).rows[0];
   if(!consumed||Number(consumed.messages)>=budget.max_messages
    ||Number(consumed.conversations)+(consumed.current_conversation?0:1)>budget.max_conversations)return deny('WARMUP_DAILY_LIMIT');
  }
 }
 if(!await reserveWarmupRate(c,effect,ids,profile.rate_per_minute,now))return deny('WARMUP_RATE_LIMIT');
 if(legacyDeadline){
  const finalTime=(await c.query('SELECT clock_timestamp() AS now')).rows[0]?.now;
  if(!(finalTime instanceof Date)||!Number.isFinite(finalTime.getTime())||finalTime>=legacyDeadline)return deny('QR_EFFECT_LEGACY_EXPIRED');
 }
 const recipient=states.find(s=>s.account_id===peer.id)!;
 return{allowed:true,account,contact:{...peer,kind:'contact',body:{identity:decrypt(recipient.address_ciphertext)}},leaseMs:Number(senderOwner.lease_ms)};
}
