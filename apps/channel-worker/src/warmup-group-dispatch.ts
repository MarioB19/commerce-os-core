import {currentProfileExecutor} from '../../../packages/db/src/profile-query-routing.js';
import {validateLegacyWarmupEffectOrigins} from '../../../packages/db/src/legacy-qr-warmup.js';
import {getRecord,decrypt,hash,stableJson,readOperationalSettings,pool,withTransaction,type QueryExecutor} from '@commerce/db';
import {readEffectiveHealthBatch,currentEffectiveSignal,currentRestrictionClear,effectiveHealthBlockers} from '../../../packages/db/src/effective-health.js';
import type {Body,DomainRecord} from '@commerce/contracts';
import {profileFor,reserveWarmupRate,warmupIdentityMatches} from '../../../packages/db/src/warmup.js';
import {groupEligibility,observeGroup,correlateGroupEvents} from '../../../packages/db/src/warmup-groups.js';
import {isStandard15dPolicy,localWindow,dailyBudget} from '../../../packages/domain/src/warmup/policy.js';
import {numberNow} from '../../../packages/db/src/number-clock.js';
import {preparationGate} from '../../../packages/db/src/preparation.js';
import type {ProviderFactory} from './providers.js';
import {assertGatewayIsolation} from './providers.js';

/** Bounded reads hold only the REAL operational publication lock; final guard checks revision. */
export async function refreshEffectGroup(effectId:string,factory:ProviderFactory){
 const effect=(await pool.query("SELECT * FROM outbox WHERE id=$1 AND kind='warmup' AND payload->>'group_protocol'='v1'",[effectId])).rows[0];if(!effect)return;
 const account=await getRecord(pool,effect.workspace_id,'channel_account',effect.account_id),group=(await pool.query('SELECT * FROM warmup_groups WHERE id=$1 AND workspace_id=$2 AND environment=$3',[effect.payload.group_id,effect.workspace_id,effect.environment])).rows[0];
 if(!account||!group)return;
 const now=await numberNow(pool,effect.workspace_id,effect.environment);
 const required:string[]=[...new Set([account.id,...group.members.filter((m:Body)=>m.account_id&&now.getTime()-Date.parse(group.capabilities.observations?.[m.account_id]?.observed_at??'1970-01-01')>=30000).map((m:Body)=>m.account_id)])] as string[];
 let cursor=0;await Promise.all(Array.from({length:Math.min(4,required.length)},async()=>{while(cursor<required.length){const id=required[cursor++]!,member=await getRecord(pool,effect.workspace_id,'channel_account',id);if(!member||member.environment!==effect.environment)throw new Error('GROUP_ACCOUNT_SCOPE_INVALID');const observe=async()=>{const provider=await factory(member);if(!provider.group)throw new Error('GROUP_PROVIDER_UNSUPPORTED');return provider.group(decrypt(group.group_ciphertext));};const snapshot=member.environment==='REAL'?await withTransaction(async c=>{if((await readOperationalSettings(c,member.workspace_id,'REAL',{lock:'share'})).release_hold)throw new Error('RELEASE_HOLD_ACTIVE');return observe();}):await observe();await withTransaction(async c=>{if(member.environment==='REAL'&&(await readOperationalSettings(c,member.workspace_id,'REAL',{lock:'share'})).release_hold)throw new Error('RELEASE_HOLD_ACTIVE');return observeGroup(c,member,snapshot,now);});}}));
}
export async function gateGroupDispatch(c:QueryExecutor,effect:Body,owner:string):Promise<{allowed:boolean;reason?:string;account?:DomainRecord;contact?:DomainRecord;leaseMs?:number}>{
 const deny=(reason:string)=>({allowed:false,reason});
 const turn=(await c.query(`SELECT t.*,v.content_id,v.local_date::text AS local_date,v.pool_id,v.group_id,v.membership_version,v.member_ids,p.enabled,p.paused pool_paused,p.breaker_open,p.archived_at,p.authorization_id pool_authorization_id,p.profile_id,p.purpose FROM warmup_turns t JOIN warmup_conversations v ON v.id=t.conversation_id JOIN warmup_pools p ON p.id=v.pool_id WHERE t.id::text=$1 AND t.workspace_id=$2 AND t.environment=$3`,[effect.payload.warmup_turn_id,effect.workspace_id,effect.environment])).rows[0];
 if(!turn||turn.effect_id!==effect.id||turn.sender_id!==effect.account_id||turn.recipient_id!==effect.contact_id||turn.conversation_id!==effect.conversation_id)return deny('WARMUP_EFFECT_SCOPE_INVALID');
 if(!turn.enabled||turn.pool_paused||turn.breaker_open||turn.archived_at)return deny('WARMUP_POOL_PAUSED');
 const now=await numberNow(c,effect.workspace_id,effect.environment);
 if(new Date(effect.not_before)>now||new Date(effect.expires_at)<=now||+new Date(effect.not_before)!==+new Date(turn.not_before)||+new Date(effect.expires_at)!==+new Date(turn.expires_at))return deny('WARMUP_TURN_TIMING_CHANGED');
 const group=(await c.query('SELECT * FROM warmup_groups WHERE id=$1 AND workspace_id=$2 AND environment=$3 FOR SHARE',[turn.group_id,effect.workspace_id,effect.environment])).rows[0],ids:string[]=turn.member_ids;
 if(!group||group.version!==turn.membership_version)return deny('GROUP_MEMBERSHIP_CHANGED');
 const currentPool=(await c.query('SELECT enabled,paused,breaker_open,archived_at FROM warmup_pools WHERE id=$1 FOR SHARE',[turn.pool_id])).rows[0];
 if(!currentPool?.enabled||currentPool.paused||currentPool.breaker_open||currentPool.archived_at)return deny('WARMUP_POOL_PAUSED');
 const eligibility=groupEligibility(group,ids,now);if(eligibility)return deny(eligibility);
 if(now.getTime()-new Date(group.observed_at).getTime()>5000)return deny('GROUP_FRESH_READ_REQUIRED');
 const profile=await profileFor(c,turn.profile_id);if(!localWindow(profile,now).open)return deny('WARMUP_QUIET_HOURS');
 const content=(await c.query('SELECT * FROM warmup_content WHERE id=$1 AND workspace_id=$2 AND environment=$3',[turn.content_id,effect.workspace_id,effect.environment])).rows[0];
 if(!content||stableJson(turn.content)!==stableJson(content.body.turns[turn.position]))return deny('WARMUP_CONTENT_CHANGED');
 const expected={...turn.content,warmup_turn_id:turn.id,warmup_pool_id:turn.pool_id,content_hash:content.content_hash,group_protocol:'v1',group_id:group.id,membership_version:group.version,purpose:turn.purpose};
 if(stableJson(effect.payload)!==stableJson(expected)||hash(stableJson({account_id:effect.account_id,contact_id:effect.contact_id,payload:effect.payload}))!==effect.config_hash||effect.approval_hash!==effect.config_hash)return deny('EFFECT_CONFIG_CHANGED');
 const states=(await c.query('SELECT s.*,i.address_ciphertext,i.address_fingerprint,i.profile_verified_at FROM warmup_states s LEFT JOIN warmup_identities i ON i.id=s.identity_id WHERE s.pool_id=$1 AND s.account_id=ANY($2::uuid[]) FOR SHARE OF s',[turn.pool_id,ids])).rows;
 if(states.length!==ids.length||states.some(s=>s.paused||s.confirmed_block||!['WARMING','AWAITING_CONTENT','GRADUATED'].includes(s.status)))return deny('WARMUP_MEMBER_NOT_READY');
 const accounts:DomainRecord[]=[],healthByAccount=await readEffectiveHealthBatch(c,{workspaceId:effect.workspace_id,environment:effect.environment,accountIds:ids,now});
 for(const id of ids){
  const account=await getRecord(c,effect.workspace_id,'channel_account',id);if(!account||account.environment!==effect.environment||account.body.deleted_at||account.body.status!=='WORKING'||!warmupIdentityMatches(account,states.find(s=>s.account_id===id)))return deny('WARMUP_IDENTITY_NOT_VERIFIED');
  if(effect.environment==='REAL'&&(account.body.provider!=='waha'||!account.body.identity_verified||account.body.identity_conflict))return deny('WARMUP_IDENTITY_NOT_VERIFIED');
  if(effect.environment==='SIMULATION'&&account.body.provider!=='simulator')return deny('SIMULATION_EXTERNAL_PROVIDER_DENIED');
  if(turn.purpose==='preparation'&&isStandard15dPolicy(profile.policy_version)&&!(await preparationGate(c,id,now)).ready)return deny('PREPARATION_REQUIREMENTS_PENDING');
  const health=healthByAccount.get(id)!,session=currentEffectiveSignal(health,'session'),transport=currentEffectiveSignal(health,'transport');
  if(session?.status!=='OK'||account.body.provider==='waha'&&!currentRestrictionClear(health)||effectiveHealthBlockers(health).length)return deny('WARMUP_HEALTH_NOT_READY');
  if(effect.environment==='REAL'&&(transport?.status!=='OK'||(transport.value as Body|undefined)?.identity_fingerprint!==account.body.identity_fingerprint))return deny('CONNECTED_IDENTITY_EVIDENCE_STALE');
  await assertGatewayIsolation(account,c);accounts.push(account);
 }
 if((await c.query("SELECT 1 FROM number_capacity_slots WHERE account_id=ANY($1::uuid[]) AND state IN('DRAINING','ERROR','UNKNOWN') LIMIT 1",[ids])).rowCount)return deny('CAPACITY_NOT_AVAILABLE');
 // Lock the group before examining in-flight work so independent workers cannot race.
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`group-dispatch:${group.id}`]);
 if((await c.query("SELECT 1 FROM outbox WHERE workspace_id=$1 AND environment=$2 AND id<>$3 AND (payload->>'group_id'=$4 OR account_id=ANY($5::text[])) AND status IN('SENDING','UNKNOWN') LIMIT 1",[effect.workspace_id,effect.environment,effect.id,group.id,ids])).rowCount)return deny('GROUP_RECONCILIATION_REQUIRED');
 const controls=(await c.query("SELECT 1 FROM manual_controls WHERE workspace_id=$1 AND ((scope_type='workspace' AND scope_id=$1) OR(scope_type='channel_account' AND scope_id=ANY($2::text[]))) AND (paused OR suppressed OR takeover)",[effect.workspace_id,ids])).rowCount;if(controls)return deny('WARMUP_MANUAL_CONTROL');
 const owners=(await c.query('SELECT *,extract(epoch FROM(lease_expires_at-now()))*1000 lease_ms FROM session_ownership WHERE workspace_id=$1 AND account_id=ANY($2::text[]) FOR SHARE',[effect.workspace_id,ids])).rows,senderOwner=owners.find(o=>o.account_id===effect.account_id);
 if(owners.length!==ids.length||owners.some(o=>o.frozen||o.lease_ms<2000)||senderOwner?.owner_id!==owner)return deny('OWNERSHIP_NOT_CONFIRMED');
 if(effect.predecessor_id){const predecessor=(await c.query('SELECT * FROM outbox WHERE id=$1 AND workspace_id=$2',[effect.predecessor_id,effect.workspace_id])).rows[0];if(!predecessor||!['DELIVERED','READ'].includes(predecessor.status))return deny('CAUSAL_PREDECESSOR_UNRESOLVED');if(!(await c.query("SELECT 1 FROM warmup_group_receipts WHERE effect_id=$1 AND receiver_id=$2 AND delivery_source='authenticated_receive'",[effect.predecessor_id,effect.account_id])).rowCount)return deny('WARMUP_PEER_RECEIPT_PENDING');}
 if(turn.purpose==='maintenance'&&(states.some(s=>s.status!=='GRADUATED')||(await c.query("SELECT 1 FROM outbox WHERE account_id=ANY($1::text[]) AND kind<>'warmup' AND status IN('READY','BLOCKED','SENDING','UNKNOWN') LIMIT 1",[ids])).rowCount))return deny('COMMERCIAL_PRIORITY');
 const policy=await readOperationalSettings(c,effect.workspace_id,effect.environment,{lock:'share'});if(effect.environment==='REAL'&&(policy.body.dispatch_frozen||!policy.body.allow_real_operations||!policy.body.real_sends_enabled))return deny('REAL_OPERATION_NOT_ENABLED');
 let bound=false,temporalExpiresAt:Date|null=null;
 if((await c.query("SELECT to_regclass('public.warmup_effect_origins') AS present")).rows[0]?.present){
  const db=currentProfileExecutor(effect.workspace_id);if(!db)return deny('CONTINUITY_PROFILE_CONTEXT_REQUIRED');
  const result=await validateLegacyWarmupEffectOrigins(db,{environment:effect.environment,effectId:effect.id,senderId:effect.account_id,accountIds:ids,poolId:turn.pool_id,profileId:turn.profile_id,contentId:turn.content_id,policyVersion:profile.policy_version,purpose:turn.purpose,groupId:group.id,groupVersion:group.version,configurationVersion:policy.version});
  if(result.kind==='BLOCKED')return deny(result.reason);bound=result.kind==='BOUND';if(result.kind==='BOUND')temporalExpiresAt=result.temporalExpiresAt;
 }
 if(bound){
  if(localWindow(profile,now).date!==turn.local_date)return deny('WARMUP_PLAN_DAY_CHANGED');
  for(const accountId of [...ids].sort())await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`warmup-daily:${effect.workspace_id}:${effect.environment}:${accountId}`]);
  for(const state of states){
   if(!state.profile_verified_at||!state.profile_ready_at||new Date(state.profile_ready_at)>now)return deny('WARMUP_MEMBER_NOT_READY');
   const plan=(await c.query('SELECT * FROM warmup_plans WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND profile_id=$4 AND local_date=$5',[effect.workspace_id,effect.environment,state.account_id,state.profile_id,turn.local_date])).rows[0];
   if(!plan||plan.episode_id!==state.episode_id||!Number.isInteger(plan.effective_day)||plan.effective_day<1)return deny('WARMUP_PLAN_REQUIRED');
   const budget=dailyBudget(profile,turn.purpose==='maintenance'?1:plan.effective_day,now);
   if(plan.budget.min_messages!==budget.min_messages||plan.budget.max_messages!==budget.max_messages||!Number.isSafeInteger(plan.budget.group_sends)||plan.budget.group_sends<0||plan.budget.group_sends>budget.max_messages||!Number.isSafeInteger(plan.budget.max_conversations)||plan.budget.max_conversations<1||plan.budget.max_conversations>budget.max_conversations)return deny('WARMUP_PLAN_BUDGET_CHANGED');
   const consumed=(await c.query(`SELECT count(*)::int messages,count(DISTINCT o.conversation_id)::int conversations,COALESCE(bool_or(o.conversation_id=$4),false) current_conversation
    FROM outbox o JOIN warmup_turns t ON t.effect_id=o.id JOIN warmup_conversations v ON v.id=t.conversation_id
    WHERE o.workspace_id=$1 AND o.environment=$2 AND o.kind='warmup' AND v.local_date=$5 AND o.id<>$6
     AND (o.account_id=$3::text OR o.contact_id=$3::text OR $3::uuid=ANY(t.recipient_ids)) AND o.status IN('SENDING','SENT','DELIVERED','READ','UNKNOWN')`,[effect.workspace_id,effect.environment,state.account_id,effect.conversation_id,turn.local_date,effect.id])).rows[0];
   if(!consumed||consumed.messages>=budget.max_messages||consumed.conversations+(consumed.current_conversation?0:1)>plan.budget.max_conversations)return deny('WARMUP_DAILY_LIMIT');
  }
 }else{
 const auth=(await c.query('SELECT * FROM read_locked_operation_authorization($1,$2,$3)',[effect.authorization_id,effect.workspace_id,effect.environment])).rows[0];
 if(!auth||auth.id!==turn.pool_authorization_id||auth.configuration_version!==policy.version||auth.scope.mode!=='warmup'||auth.scope.pool_id!==turn.pool_id||auth.scope.group_id!==group.id||auth.scope.membership_version!==group.version||auth.scope.purpose!==turn.purpose||auth.scope.policy_version&&auth.scope.policy_version!==profile.policy_version||!ids.every(id=>auth.scope.account_ids?.includes(id))||!auth.scope.content_ids?.includes(turn.content_id))return deny('WARMUP_AUTHORIZATION_INVALID');
 const used=(await c.query("SELECT count(*)::int total,count(*) FILTER(WHERE account_id=$3)::int sender FROM outbox WHERE authorization_id=$1 AND id<>$2 AND status IN('SENDING','SENT','DELIVERED','READ','UNKNOWN')",[auth.id,effect.id,effect.account_id])).rows[0];if(used.total>=auth.scope.max_messages||used.sender>=(auth.scope.sender_limits?.[effect.account_id]??0))return deny('AUTHORIZATION_MESSAGE_LIMIT');
 }
 if(!await reserveWarmupRate(c,effect,ids,profile.rate_per_minute,now))return deny('WARMUP_RATE_LIMIT');
 if(temporalExpiresAt){const finalTime=(await c.query('SELECT clock_timestamp() AS now')).rows[0]?.now;if(!(finalTime instanceof Date)||!Number.isFinite(finalTime.getTime())||temporalExpiresAt<=finalTime)return deny('QR_EFFECT_LEGACY_EXPIRED');}
 const account=accounts.find(a=>a.id===effect.account_id)!;
 return{allowed:true,account,contact:{...account,id:effect.contact_id,kind:'contact',body:{identity:decrypt(group.group_ciphertext)}},leaseMs:Number(senderOwner.lease_ms)};
}
export async function reconcileGroupDeliveries(){return withTransaction(c=>correlateGroupEvents(c));}
