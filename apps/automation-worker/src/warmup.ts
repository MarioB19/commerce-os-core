import {recordProfileExecutor} from '../../../packages/db/src/profile-record-context.js';
import {bindLegacyWarmupEffectOrigins,legacyPoolAuthorities,type LegacyQrAuthority} from '../../../packages/db/src/legacy-qr-warmup.js';
import {readCurrentQrContinuity,continuousWarmupAuthorityBlock} from '../../../packages/db/src/continuous-warmup.js';
import {enrollQrWarmupProfile} from '../../../packages/db/src/qr-warmup.js';
import type {ProfileExecutor} from '../../../packages/db/src/profile-context.js';
import type {ContinuousAuthorization} from '../../../packages/contracts/src/continuous-authorization.js';
import {systemQrContents,QR_POLICY_ORIGIN,QR_LIBRARY_VERSION} from '../../../packages/domain/src/warmup/qr-policy.js';
import {numberNow} from '../../../packages/db/src/number-clock.js';
import {planGroupPool} from './warmup-group-planner.js';
import {correlateGroupEvents} from '../../../packages/db/src/warmup-groups.js';
import {preparationGate} from '../../../packages/db/src/preparation.js';
import {randomInt} from 'node:crypto';
import {query,withTransaction,getRecord,appendEvent,uuid,hash,stableJson,readOperationalSettings,type QueryExecutor} from '@commerce/db';
import type {Body} from '@commerce/contracts';
import {profileFor} from '../../../packages/db/src/warmup.js';
import {STANDARD_V2_POLICY,isStandard15dPolicy,localWindow,dailyBudget,breakerDecision,graduationDecision,pairAllowed,warmupPolicy,type WarmupProfile} from '../../../packages/domain/src/warmup/policy.js';

function qrContext(c:QueryExecutor,pool:Body):ProfileExecutor{
 const db=c as ProfileExecutor;
 if(db.workspaceId!==pool.workspace_id||!['REAL','SIMULATION'].includes(pool.environment))throw Error('QR_PROFILE_CONTEXT_REQUIRED');
 return db;
}
function qrIdentityMatches(identity:Body,grant:ContinuousAuthorization){
 return grant.source.kind==='VERIFIED_QR_CONNECTION'&&identity.qr_verified_at&&
  identity.qr_command_id===grant.source.connectionId&&identity.qr_identity_fingerprint===grant.source.identityFingerprint;
}
const accepted=['DELIVERED','READ'];
async function stateUpdate(c:QueryExecutor,state:Body,status:string,reason:string,now:Date){
 if(state.status===status&&state.reason===reason)return;
 await c.query('UPDATE warmup_states SET status=$2,reason=$3,version=version+1,updated_at=$4 WHERE account_id=$1',[state.account_id,status,reason,now]);
 await appendEvent(c,{workspace_id:state.workspace_id,environment:state.environment,event_type:'warmup.state_changed',aggregate_id:state.account_id,payload:{previous:state.status,status,reason},occurred_at:now.toISOString()});
 state.status=status;state.reason=reason;
}
async function poolLock(c:QueryExecutor,poolId:string){await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`warmup-pool:${poolId}`]);}

/** Reconciles recorded dependencies only; never starts a session, resets a breaker, or sends HTTP. */
export async function reconcileWarmupPool(c:QueryExecutor,pool:Body,now=new Date()){
 if(pool.continuity_mode==='QR_CONTINUOUS')qrContext(c,pool);
 const members=(await c.query('SELECT * FROM warmup_states WHERE pool_id=$1 ORDER BY account_id FOR UPDATE',[pool.id])).rows;
 for(const state of members){
  if(state.paused||['PAUSED','QUARANTINED','GRADUATED'].includes(state.status))continue;
  const account=await getRecord(c,pool.workspace_id,'channel_account',state.account_id);
  if(!account||account.body.deleted_at){await stateUpdate(c,state,'QUARANTINED','ACCOUNT_UNAVAILABLE',now);continue;}
  if(account.body.provider==='cloud'){
   await c.query("UPDATE warmup_states SET status='GRADUATED',reason='OFFICIAL_CLOUD_NOT_APPLICABLE',graduated_at=$2,version=version+1,updated_at=$2 WHERE account_id=$1",[state.account_id,now]);continue;
  }
  if(!pool.enabled||pool.paused||pool.breaker_open)continue;
  if(account.body.status!=='WORKING'){
   await c.query('UPDATE warmup_states SET stable_since=NULL WHERE account_id=$1',[state.account_id]);
   await stateUpdate(c,state,'AWAITING_CONNECTION','WORKING_SESSION_REQUIRED',now);continue;
  }
  const observedAt=account.body.session_provider_at??account.body.health_checked_at;
  if(!observedAt||!Number.isFinite(Date.parse(observedAt))||Date.parse(observedAt)>now.getTime()){
   await stateUpdate(c,state,'AWAITING_CONNECTION','FIRST_CONNECTION_EVIDENCE_REQUIRED',now);continue;
  }
  await c.query('UPDATE warmup_states SET enrolled_at=COALESCE(enrolled_at,$2),version=version+1,updated_at=$3 WHERE account_id=$1',[state.account_id,observedAt,now]);
  const identity=(await c.query('SELECT i.* FROM warmup_identities i WHERE account_id=$1 AND workspace_id=$2 AND environment=$3',[state.account_id,pool.workspace_id,pool.environment])).rows[0];
  if(!identity){await stateUpdate(c,state,'AWAITING_IDENTITY','VERIFIED_OWN_ADDRESS_REQUIRED',now);continue;}
  if(state.identity_id!==identity.id)await c.query('UPDATE warmup_states SET identity_id=$2 WHERE account_id=$1',[state.account_id,identity.id]);
  let verifiedAt=identity.profile_verified_at;
  if(pool.continuity_mode==='QR_CONTINUOUS'){
   const grant=await readCurrentQrContinuity(qrContext(c,pool),pool.environment,state.account_id);
   if(!grant||grant.revokedAt||grant.humanPaused||grant.protections.length||!qrIdentityMatches(identity,grant)){
    await stateUpdate(c,state,'AWAITING_IDENTITY','CURRENT_QR_AUTHORITY_REQUIRED',now);continue;
   }
   verifiedAt=identity.qr_verified_at;
  }
  if(!verifiedAt){await stateUpdate(c,state,'AWAITING_PROFILE','PROFILE_VERIFICATION_REQUIRED',now);continue;}
  const profile=await profileFor(c,state.profile_id);
  const policy=warmupPolicy(profile),gate=isStandard15dPolicy(profile.policy_version)?await preparationGate(c,state.account_id,now):{ready:true};
  if(!gate.ready){await stateUpdate(c,state,'PROFILE_WAIT',policy.requires_manual?'MANUAL_PREPARATION_REQUIRED':'PREPARATION_EPISODE_REQUIRED',now);continue;}
  const readyAt=policy.profile_wait?new Date(new Date(verifiedAt).getTime()+profile.profile_wait_hours*3600000):new Date(verifiedAt);
  await c.query('UPDATE warmup_states SET profile_ready_at=$2 WHERE account_id=$1',[state.account_id,readyAt]);
  if(now<readyAt){await stateUpdate(c,state,'PROFILE_WAIT','PROFILE_WAIT_WINDOW',now);continue;}
  if(!['WARMING','AWAITING_CONTENT'].includes(state.status))await stateUpdate(c,state,'AWAITING_PEER','READY_FOR_OWN_PEER',now);
 }
 if(!pool.enabled||pool.paused||pool.breaker_open)return{members:members.length,ready:0};
 const ready=(await c.query("SELECT * FROM warmup_states WHERE pool_id=$1 AND paused=false AND status IN('WARMING','AWAITING_PEER','AWAITING_CONTENT','GRADUATED') AND identity_id IS NOT NULL AND profile_ready_at<=$2 ORDER BY account_id",[pool.id,now])).rows;
 for(const state of ready){
  if(state.status==='GRADUATED')continue;
  if(ready.length<2){await stateUpdate(c,state,'AWAITING_PEER','OWN_PEER_REQUIRED',now);continue;}
  await c.query('UPDATE warmup_states SET warmup_started_at=COALESCE(warmup_started_at,$2) WHERE account_id=$1',[state.account_id,now]);
  if(state.status!=='AWAITING_CONTENT')await stateUpdate(c,state,'WARMING','DEPENDENCIES_READY',now);
 }
 return{members:members.length,ready:ready.length};
}

export async function evaluateWarmupPool(c:QueryExecutor,pool:Body,now=new Date()){
 await correlateGroupEvents(c,pool.group_id??undefined);
 const states=(await c.query('SELECT * FROM warmup_states WHERE pool_id=$1 ORDER BY account_id FOR UPDATE',[pool.id])).rows;
 for(const state of states){
  if(!state.enrolled_at)continue;
  const account=await getRecord(c,pool.workspace_id,'channel_account',state.account_id);if(!account)continue;
  const observedAt=account.body.health_checked_at;
  const fresh=!!observedAt&&Date.parse(observedAt)<=now.getTime()&&now.getTime()-Date.parse(observedAt)<90000;
  const healthy=fresh&&account.body.status==='WORKING'&&account.body.health_status==='OK';
  if(fresh)await c.query("INSERT INTO warmup_observations(workspace_id,environment,account_id,kind,evidence_ref,observed_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",[pool.workspace_id,pool.environment,state.account_id,healthy?'HEALTHY':'FAILED',`health:${state.account_id}:${observedAt}`,observedAt]);
  const observationGap=state.last_observed_at?now.getTime()-new Date(state.last_observed_at).getTime():null;
  const stableSince=healthy?(observationGap!==null&&observationGap>=0&&observationGap<3600000?state.stable_since??observedAt:observedAt):null;
  const observation=(await c.query('UPDATE warmup_states SET stable_since=$2,last_observed_at=COALESCE($3,last_observed_at) WHERE account_id=$1 RETURNING stable_since,last_observed_at',[state.account_id,stableSince,fresh?observedAt:null])).rows[0];
  // Graduation must use the same observation just persisted, including a stability reset after downtime.
  Object.assign(state,observation);
  if(state.paused||!pool.enabled||pool.paused||pool.breaker_open||['QUARANTINED','PAUSED','GRADUATED'].includes(state.status))continue;
  const profile=await profileFor(c,state.profile_id),today=localWindow(profile,now).date;
  const episode=state.episode_id?(await c.query('SELECT started_at FROM warmup_episodes WHERE id=$1',[state.episode_id])).rows[0]:null;
  const evidenceStart=episode?.started_at??state.enrolled_at;
  const prior=(await c.query("SELECT *,local_date::text AS local_day FROM warmup_plans WHERE account_id=$1 AND local_date<$2 AND status IN('PLANNED','PARTIAL') AND profile_id=$3 AND local_date>=$4::date AND ($5::boolean=false OR episode_id=$6) ORDER BY local_date FOR UPDATE",[state.account_id,today,state.profile_id,localWindow(profile,new Date(evidenceStart)).date,profile.policy_version===STANDARD_V2_POLICY,state.episode_id])).rows;
  for(const plan of prior){
   const actual=(await c.query(`SELECT COALESCE(sum(messages),0)::int messages,count(*)::int conversations FROM (SELECT t.conversation_id,count(*)::int messages FROM warmup_turns t JOIN warmup_conversations v ON v.id=t.conversation_id LEFT JOIN outbox o ON o.id=t.effect_id WHERE (t.sender_id=$1 OR t.recipient_id=$1 OR $1=ANY(t.recipient_ids)) AND v.local_date=$2 AND v.pool_id=$4 GROUP BY t.conversation_id HAVING bool_and(COALESCE(o.status=ANY($3::text[]),false)) AND bool_or(t.sender_id=$1)) confirmed`,[state.account_id,plan.local_day,accepted,pool.id])).rows[0];
   const complete=healthy&&plan.budget.min_messages>0&&actual.messages>=plan.budget.min_messages&&actual.conversations>=plan.budget.min_conversations;
   await c.query('UPDATE warmup_plans SET status=$2 WHERE id=$1',[plan.id,complete?'COMPLETED':'MISSED']);
   if(complete){
    const credited=profile.policy_version===STANDARD_V2_POLICY?Number((await c.query("INSERT INTO warmup_day_credits(workspace_id,environment,episode_id,account_id,source_plan_id,local_date,policy_version,source,evidence,credited_at) VALUES($1,$2,$3,$4,$5,$6,$7,'automatic_pipeline',$8,$9) ON CONFLICT DO NOTHING RETURNING id",[pool.workspace_id,pool.environment,state.episode_id,state.account_id,plan.id,plan.local_day,profile.policy_version,{messages:actual.messages,conversations:actual.conversations,pool_id:pool.id},now])).rowCount)>0:true;
    if(credited){await c.query('UPDATE warmup_states SET effective_days=effective_days+1,last_completed_date=$2,version=version+1,updated_at=$3 WHERE account_id=$1',[state.account_id,plan.local_day,now]);state.effective_days++;}
   }
  }
  const stats=profile.policy_version===STANDARD_V2_POLICY?(await c.query(`SELECT count(*)::int samples,count(*) FILTER(WHERE o.status IN('DELIVERED','READ'))::int delivered FROM outbox o JOIN warmup_conversations v ON v.id::text=o.conversation_id WHERE o.kind='warmup' AND o.account_id=$1 AND o.attempts>0 AND o.claimed_at<$2 AND o.claimed_at>=$3 AND v.pool_id=$4`,[state.account_id,new Date(now.getTime()-profile.ack_maturity_minutes*60000),evidenceStart,pool.id])).rows[0]:(await c.query(`SELECT count(*)::int samples,count(*) FILTER(WHERE o.status IN('DELIVERED','READ'))::int delivered FROM outbox o WHERE o.kind='warmup' AND o.account_id=$1 AND o.attempts>0 AND o.claimed_at<$2 AND o.claimed_at>=$3`,[state.account_id,new Date(now.getTime()-profile.ack_maturity_minutes*60000),evidenceStart])).rows[0];
  const blocked=state.confirmed_block||(await c.query("SELECT 1 FROM warmup_observations WHERE account_id=$1 AND kind='CONFIRMED_BLOCK' LIMIT 1",[state.account_id])).rowCount!>0;
  const gate=await preparationGate(c,state.account_id,now),decision=graduationDecision({profile,effective_days:state.effective_days,extensions:state.extensions,stable_since:state.stable_since?new Date(state.stable_since).toISOString():null,last_observed_at:state.last_observed_at?new Date(state.last_observed_at).toISOString():null,mature_samples:stats.samples,delivered:stats.delivered,confirmed_block:blocked,now,nominal_day:gate.nominal_day,manual_ready:gate.ready});
  if(decision.status==='EXTEND'){await c.query('UPDATE warmup_states SET extensions=extensions+1 WHERE account_id=$1',[state.account_id]);await stateUpdate(c,state,'WARMING',decision.reason,now);}
  else if(['GRADUATED','QUARANTINED'].includes(decision.status)){await stateUpdate(c,state,decision.status,decision.reason,now);if(decision.status==='GRADUATED'){await c.query('UPDATE warmup_states SET graduated_at=$2 WHERE account_id=$1',[state.account_id,now]);await c.query('UPDATE warmup_episodes SET completed_at=COALESCE(completed_at,$2) WHERE id=$1',[state.episode_id,now]);}}
 }
 if(pool.program_id&&pool.purpose==='preparation'&&states.length>=2&&states.every(s=>s.status==='GRADUATED')){await c.query("UPDATE warmup_programs SET status='COMPLETED',version=version+1,updated_at=now() WHERE id=$1 AND status='ACTIVE'",[pool.program_id]);await c.query('UPDATE warmup_pools SET enabled=false,version=version+1 WHERE id=$1',[pool.id]);await c.query('DELETE FROM warmup_account_reservations WHERE program_id=$1',[pool.program_id]);pool.enabled=false;}
 const failures=(await c.query("SELECT account_id,observed_at FROM warmup_observations WHERE workspace_id=$1 AND environment=$2 AND kind IN('FAILED','CONFIRMED_BLOCK') AND observed_at>$3",[pool.workspace_id,pool.environment,new Date(now.getTime()-86400000)])).rows.map(r=>({...r,observed_at:new Date(r.observed_at).toISOString()}));
 const breaker=breakerDecision(states.map(s=>s.account_id),failures,now);
 if(breaker.open&&!pool.breaker_open){await c.query("UPDATE warmup_pools SET breaker_open=true,breaker_reason='DISTINCT_ACCOUNT_FAILURE_THRESHOLD',version=version+1,updated_at=$2 WHERE id=$1",[pool.id,now]);await appendEvent(c,{workspace_id:pool.workspace_id,environment:pool.environment,event_type:'warmup.breaker_opened',aggregate_id:pool.id,payload:breaker,occurred_at:now.toISOString()});}
 return{evaluated:states.length,breaker};
}

function windowEnd(profile:WarmupProfile,now:Date){let time=now.getTime();for(let i=0;i<1440&&localWindow(profile,new Date(time)).open;i++)time+=60000;return new Date(time);}
export async function planWarmupPool(c:QueryExecutor,pool:Body,now=new Date()){
 if(pool.topology==='group')return planGroupPool(c,pool,now);
 if(!pool.enabled||pool.paused||pool.breaker_open)return{planned:0,reason:'POOL_DISABLED_OR_PAUSED'};
 const profile=await profileFor(c,pool.profile_id),window=localWindow(profile,now);
 if(!window.open)return{planned:0,reason:'QUIET_HOURS'};
 const policy=await readOperationalSettings(c,pool.workspace_id,pool.environment,{lock:'share'});
 if(pool.environment==='REAL'&&(policy.body.dispatch_frozen||!policy.body.real_sends_enabled||!policy.body.allow_real_operations))return{planned:0,reason:'REAL_OPERATION_NOT_ENABLED'};
 const qr=pool.continuity_mode==='QR_CONTINUOUS',grants=new Map<string,ContinuousAuthorization>();
 if(qr){qrContext(c,pool);if(profile.policy_version!==STANDARD_V2_POLICY||pool.purpose!=='preparation'||pool.program_id||pool.group_id||pool.authorization_id)return{planned:0,reason:'QR_POOL_POLICY_CHANGED'};}
 const auth=qr?undefined:(await c.query('SELECT * FROM read_locked_operation_authorization($1,$2,$3)',[pool.authorization_id,pool.workspace_id,pool.environment])).rows[0];
 const legacyValid=!qr&&auth&&auth.scope?.mode==='warmup'&&auth.scope.pool_id===pool.id&&(!auth.scope.policy_version||auth.scope.policy_version===profile.policy_version)&&auth.configuration_version===policy.version;
 const states=(await c.query("SELECT s.*,to_jsonb(i)->>'qr_verified_at' AS qr_verified_at,to_jsonb(i)->>'qr_command_id' AS qr_command_id,to_jsonb(i)->>'qr_identity_fingerprint' AS qr_identity_fingerprint FROM warmup_states s JOIN records a ON a.id=s.account_id AND a.workspace_id=s.workspace_id AND a.environment=s.environment JOIN warmup_identities i ON i.id=s.identity_id AND i.account_id=s.account_id AND i.workspace_id=s.workspace_id AND i.environment=s.environment WHERE s.pool_id=$1 AND s.paused=false AND s.status IN('WARMING','AWAITING_CONTENT','GRADUATED') AND s.profile_ready_at<=$2 AND (($3::boolean AND to_jsonb(i)->>'qr_verified_at' IS NOT NULL) OR (NOT $3::boolean AND i.profile_verified_at IS NOT NULL)) AND a.body->>'status'='WORKING' ORDER BY s.account_id FOR UPDATE OF s",[pool.id,now,qr])).rows;
 const adopted=new Map<string,LegacyQrAuthority>();
 if(!qr)for(const [key,value]of await legacyPoolAuthorities(c,pool.workspace_id,pool.environment,states.map(x=>x.account_id)))adopted.set(key,value);
 if(!qr&&!legacyValid&&![...adopted.values()].some(x=>x.kind==='ADOPTED'))return{planned:0,reason:'AUTHORIZATION_REQUIRED'};
 const requirements=warmupPolicy(profile),eligible=[];
 for(const state of states){
  if(qr){
   const grant=await readCurrentQrContinuity(qrContext(c,pool),pool.environment,state.account_id);
   if(!grant||grant.revokedAt||grant.humanPaused||grant.protections.length||!qrIdentityMatches(state,grant))continue;
   grants.set(state.account_id,grant);
  }else{
   const origin=adopted.get(state.account_id);
   if(origin?.kind==='BLOCKED')continue;
   if(origin?.kind==='ADOPTED')grants.set(state.account_id,origin.grant);
   else if(!legacyValid||!auth.scope.account_ids?.includes(state.account_id))continue;
  }
  if(pool.purpose!=='maintenance'&&isStandard15dPolicy(profile.policy_version)&&(!(await preparationGate(c,state.account_id,now)).ready||state.effective_days>=requirements.automatic_days))continue;
  eligible.push(state);
 }
 if(pool.purpose==='maintenance'&&(eligible.some(s=>s.status!=='GRADUATED')||(await c.query("SELECT 1 FROM outbox WHERE account_id=ANY($1::text[]) AND kind<>'warmup' AND status IN('READY','BLOCKED','SENDING','UNKNOWN') LIMIT 1",[eligible.map(s=>s.account_id)])).rowCount))return{planned:0,reason:'COMMERCIAL_PRIORITY_OR_PREPARATION_REQUIRED'};
 if(eligible.length<2)return{planned:0,reason:'OWN_PEER_REQUIRED'};
 const plans:Body[]=[];
 for(const state of eligible){const budget=dailyBudget(profile,pool.purpose==='maintenance'?1:state.effective_days+1,now);await c.query('INSERT INTO warmup_plans(workspace_id,environment,account_id,profile_id,episode_id,local_date,effective_day,budget) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(account_id,local_date) DO NOTHING',[pool.workspace_id,pool.environment,state.account_id,state.profile_id,state.episode_id,window.date,state.effective_days+1,budget]);const plan=(await c.query('SELECT * FROM warmup_plans WHERE account_id=$1 AND local_date=$2 AND profile_id=$3 FOR UPDATE',[state.account_id,window.date,state.profile_id])).rows[0];if(!plan)continue;plans.push({...plan,state});}
 const contents=qr?(await c.query('SELECT * FROM warmup_content WHERE workspace_id=$1 AND environment=$2 AND origin=$3 AND policy_version=$4 AND content_hash=ANY($5::text[]) ORDER BY created_at,id',[pool.workspace_id,pool.environment,QR_POLICY_ORIGIN,QR_LIBRARY_VERSION,systemQrContents.map(c=>c.content_hash)])).rows:
  (await c.query('SELECT * FROM warmup_content WHERE workspace_id=$1 AND environment=$2 AND id=ANY($3::uuid[]) ORDER BY created_at,id',[pool.workspace_id,pool.environment,[...new Set([...(legacyValid?auth.scope.content_ids??[]:[]),...[...adopted.values()].flatMap(x=>x.kind==='ADOPTED'?x.contentIds:[])])]])).rows;
 if(qr&&contents.some(row=>!systemQrContents.some(content=>row.content_hash===content.content_hash&&stableJson(row.body)===stableJson(content.body))))throw Error('QR_SYSTEM_CONTENT_CHANGED');
 if(!contents.length){for(const p of plans)if(p.state.status!=='GRADUATED')await stateUpdate(c,p.state,'AWAITING_CONTENT','APPROVED_CONTENT_REQUIRED',now);return{planned:0,accounts:eligible.length,reason:'APPROVED_CONTENT_REQUIRED'};}
 const accountIds=eligible.map(s=>s.account_id),pairKey=(a:string,b:string)=>[a,b].sort().join(':');
 const history=(await c.query('SELECT initiator_id,peer_id,count(*)::int n FROM warmup_conversations WHERE workspace_id=$1 AND environment=$2 AND initiator_id=ANY($3::uuid[]) AND peer_id=ANY($3::uuid[]) GROUP BY initiator_id,peer_id',[pool.workspace_id,pool.environment,accountIds])).rows;
 const pairCounts=new Map<string,number>(),totals=new Map<string,number>();
 for(const h of history){const key=pairKey(h.initiator_id,h.peer_id);pairCounts.set(key,(pairCounts.get(key)??0)+h.n);for(const id of [h.initiator_id,h.peer_id])totals.set(id,(totals.get(id)??0)+h.n);}
 const usedContent=new Set((await c.query(`SELECT u.account_id,u.content_hash FROM warmup_content_usage u JOIN warmup_conversations v ON v.id=u.conversation_id WHERE u.account_id=ANY($1::uuid[]) AND u.released_at IS NULL AND ($2='legacy-30d/v1' OR v.local_date=$3 OR u.reserved_at>$4 OR EXISTS(SELECT 1 FROM warmup_turns t JOIN outbox o ON o.id=t.effect_id WHERE t.conversation_id=v.id AND o.status IN('SENDING','UNKNOWN','READY','BLOCKED')))`,[accountIds,profile.policy_version,window.date,new Date(now.getTime()-86400000)])).rows.map(r=>`${r.account_id}:${r.content_hash}`));
 const lastScheduled=new Map<string,number>();
 for(const row of (await c.query('SELECT sender_id,recipient_id,max(not_before) at FROM warmup_turns WHERE sender_id=ANY($1::uuid[]) OR recipient_id=ANY($1::uuid[]) GROUP BY sender_id,recipient_id',[accountIds])).rows)for(const id of [row.sender_id,row.recipient_id])lastScheduled.set(id,Math.max(lastScheduled.get(id)??0,new Date(row.at).getTime()));
 let planned=0;const expiresAt=windowEnd(profile,now);
 for(let iteration=0;iteration<2000;iteration++){
  const needs=plans.filter(p=>(pool.purpose==='maintenance'||p.state.status!=='GRADUATED')&&(p.planned_messages<p.budget.min_messages||p.planned_conversations<p.budget.min_conversations)&&p.planned_conversations<p.budget.max_conversations).sort((a,b)=>a.planned_messages-b.planned_messages);
  let selected:{a:Body;b:Body;content:Body;start:Date;gap:number}|undefined;
  for(const a of needs){
   const peers=plans.filter(b=>b.account_id!==a.account_id&&b.planned_conversations<b.budget.max_conversations).sort((x,y)=>x.planned_messages-y.planned_messages);
   for(const b of peers){
    if(qr&&continuousWarmupAuthorityBlock(grants.get(a.account_id)!,grants.get(b.account_id),{workspaceId:pool.workspace_id,environment:pool.environment,senderId:a.account_id,peerId:b.account_id}))continue;
    const paired=pairCounts.get(pairKey(a.account_id,b.account_id))??0;
    if(![a,b].every(p=>pairAllowed({pool_size:eligible.length,allow_small_pool_concentration:pool.allow_small_pool_concentration,pair_conversations:paired,total_conversations:totals.get(p.account_id)??0,planned_total:p.budget.max_conversations})))continue;
    for(const content of contents){
     if(!qr&&[a,b].some(plan=>{const origin=adopted.get(plan.account_id);return origin?.kind==='ADOPTED'?!origin.contentIds.includes(content.id):!legacyValid||!auth.scope.content_ids?.includes(content.id);}))continue;
     const n=content.body.turns.length;if(a.planned_messages+n>a.budget.max_messages||b.planned_messages+n>b.budget.max_messages)continue;
     if([a,b].some(p=>usedContent.has(`${p.account_id}:${content.content_hash}`)))continue;
     const latest=Math.max(lastScheduled.get(a.account_id)??0,lastScheduled.get(b.account_id)??0);
     const gap=Math.max(60,Math.ceil(60/profile.rate_per_minute))+(profile.jitter_seconds?randomInt(0,profile.jitter_seconds+1):0),start=new Date(Math.max(now.getTime()+gap*1000,latest+gap*1000));
     if(start.getTime()+(n-1)*gap*1000>=expiresAt.getTime())continue;
     selected={a,b,content,start,gap};break;
    }
    if(selected)break;
   }
   if(selected)break;
  }
  if(!selected)break;
  const {a,b,content,start,gap}=selected,conversationId=uuid();
  // A laboratory pool names its run; other SIMULATION pools follow the number clock.
  const simulation=(await c.query("SELECT id FROM warmup_simulation_runs WHERE execution_workspace=$1 AND (id::text=$2 OR ($2::text IS NULL AND (execution_workspace<>workspace_id OR input->>'scenario'='numbers-lifecycle'))) ORDER BY created_at LIMIT 1",[pool.workspace_id,auth?.scope?.simulation_run_id??null])).rows[0];
  await c.query('INSERT INTO warmup_conversations(id,workspace_id,environment,initiator_id,peer_id,content_id,local_date,pool_id,simulation_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[conversationId,pool.workspace_id,pool.environment,a.account_id,b.account_id,content.id,window.date,pool.id,simulation?.id??null]);
  let predecessor:string|null=null;
  for(const [position,turnContent] of (content.body.turns as Body[]).entries()){
   const sender=position%2===0?a:b,recipient=position%2===0?b:a,turnId=uuid(),effectId=uuid(),notBefore=new Date(start.getTime()+position*gap*1000);
   await c.query('INSERT INTO warmup_turns(id,workspace_id,environment,conversation_id,sender_id,recipient_id,position,content,not_before,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[turnId,pool.workspace_id,pool.environment,conversationId,sender.account_id,recipient.account_id,position,turnContent,notBefore,expiresAt]);
   const payload={...turnContent,warmup_turn_id:turnId,warmup_pool_id:pool.id,content_hash:content.content_hash},configHash=hash(stableJson({account_id:sender.account_id,contact_id:recipient.account_id,payload}));
   if(qr||grants.has(sender.account_id))await c.query("INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,logical_key,kind,payload,predecessor_id,config_hash,approval_hash,authorization_id,continuous_authorization_id,not_before,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'warmup',$8,$9,$10,$10,$11,$12,$13,$14)",[effectId,pool.workspace_id,pool.environment,sender.account_id,conversationId,recipient.account_id,`warmup:${turnId}`,payload,predecessor,configHash,null,grants.get(sender.account_id)!.id,notBefore,expiresAt]);
   else await c.query("INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,logical_key,kind,payload,predecessor_id,config_hash,approval_hash,authorization_id,not_before,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'warmup',$8,$9,$10,$10,$11,$12,$13)",[effectId,pool.workspace_id,pool.environment,sender.account_id,conversationId,recipient.account_id,`warmup:${turnId}`,payload,predecessor,configHash,auth.id,notBefore,expiresAt]);
   await bindLegacyWarmupEffectOrigins(c,{workspaceId:pool.workspace_id,environment:pool.environment,effectId,accountIds:[a.account_id,b.account_id]},adopted,auth?.id??null);
   await c.query('UPDATE warmup_turns SET effect_id=$2 WHERE id=$1',[turnId,effectId]);predecessor=effectId;
  }
  for(const plan of [a,b]){plan.planned_messages+=content.body.turns.length;plan.planned_conversations++;await c.query('UPDATE warmup_plans SET planned_messages=$2,planned_conversations=$3 WHERE id=$1',[plan.id,plan.planned_messages,plan.planned_conversations]);await c.query('INSERT INTO warmup_content_usage(workspace_id,environment,account_id,content_hash,conversation_id,reserved_at) VALUES($1,$2,$3,$4,$5,$6)',[pool.workspace_id,pool.environment,plan.account_id,content.content_hash,conversationId,now]);if(plan.state.status==='AWAITING_CONTENT')await stateUpdate(c,plan.state,'WARMING','APPROVED_CONTENT_PLANNED',now);}
  pairCounts.set(pairKey(a.account_id,b.account_id),(pairCounts.get(pairKey(a.account_id,b.account_id))??0)+1);
  for(const p of [a,b]){totals.set(p.account_id,(totals.get(p.account_id)??0)+1);usedContent.add(`${p.account_id}:${content.content_hash}`);lastScheduled.set(p.account_id,start.getTime()+(content.body.turns.length-1)*gap*1000);}
  planned++;
 }
 for(const p of plans)if(p.state.status!=='GRADUATED'&&p.planned_messages<p.budget.min_messages)await stateUpdate(c,p.state,'AWAITING_CONTENT','BUDGET_REQUIRES_FEASIBLE_APPROVED_CONTENT',now);
 return{planned,accounts:eligible.length};
}

/** Durable leases make restarts and multiple coordinators idempotent. Work itself performs no HTTP. */
async function runWindow(pool:Body,kind:'daily'|'health'|'reconcile',window:string,now:Date,work:(c:QueryExecutor,p:Body)=>Promise<unknown>){
 const claimed=await withTransaction(async c=>(await c.query(`INSERT INTO warmup_schedule_runs(pool_id,kind,window_key,lease_until,started_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(pool_id,kind,window_key) DO UPDATE SET status='RUNNING',lease_until=EXCLUDED.lease_until,started_at=EXCLUDED.started_at,finished_at=NULL WHERE warmup_schedule_runs.status<>'COMPLETED' AND warmup_schedule_runs.lease_until<$5 RETURNING pool_id`,[pool.id,kind,window,new Date(now.getTime()+300000),now])).rowCount!>0);
 if(!claimed)return;
 try{const result=await withTransaction(async c=>{if(pool.program_id)await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`program:${pool.program_id}`]);await poolLock(c,pool.id);const current=(await c.query('SELECT * FROM warmup_pools WHERE id=$1 FOR UPDATE',[pool.id])).rows[0];/* V7 F2: one pool window is one profile's work */return work(await recordProfileExecutor(c,pool.workspace_id,pool.environment),current);});await query("UPDATE warmup_schedule_runs SET status='COMPLETED',finished_at=$4,result=$5 WHERE pool_id=$1 AND kind=$2 AND window_key=$3",[pool.id,kind,window,now,result??{}]);}
 catch(error){await query("UPDATE warmup_schedule_runs SET status='FAILED',finished_at=$4,result=$5 WHERE pool_id=$1 AND kind=$2 AND window_key=$3",[pool.id,kind,window,now,{error:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'WARMUP_COORDINATOR_FAILED'}]);throw error;}
}
export async function processWarmup(at=new Date()){
 const pools=(await query("SELECT p.* FROM warmup_pools p WHERE COALESCE(to_jsonb(p)->>'continuity_mode','LEGACY')='LEGACY' AND NOT EXISTS(SELECT 1 FROM warmup_simulation_runs r WHERE r.execution_workspace=p.workspace_id AND r.execution_workspace<>r.workspace_id AND r.input->>'scenario' IS DISTINCT FROM 'numbers-lifecycle') AND NOT EXISTS(SELECT 1 FROM operation_authorizations a WHERE a.id=p.authorization_id AND a.scope ? 'simulation_run_id') ORDER BY p.created_at")).rows;
 for(const pool of pools){
  try{const now=pool.environment==='SIMULATION'?await numberNow({query} as QueryExecutor,pool.workspace_id,pool.environment):at;const profile=await profileFor({query} as QueryExecutor,pool.profile_id);
  await runWindow(pool,'health',String(Math.floor(now.getTime()/900000)),now,(c,p)=>evaluateWarmupPool(c,p,now));
  await runWindow(pool,'reconcile',String(Math.floor(now.getTime()/3600000)),now,async(c,p)=>{const result=await reconcileWarmupPool(c,p,now);return{...result,plan:await planWarmupPool(c,p,now)};});
  await runWindow(pool,'daily',localWindow(profile,now).date,now,(c,p)=>planWarmupPool(c,p,now));
  }catch{/* Durable failure is recorded per pool; independent programs continue. */}
 }
 return pools.length;
}

/** Called only inside the selected worker profile transaction. Discovery,
 * enrollment, plans and effects commit together; no provider call is made. */
export async function processQrWarmupProfile(db:ProfileExecutor,environment:'REAL'|'SIMULATION',limit=20){
 const enrolled=await enrollQrWarmupProfile(db,environment,limit);
 const pools=(await db.query("SELECT * FROM warmup_pools WHERE workspace_id=$1 AND environment=$2 AND continuity_mode='QR_CONTINUOUS' ORDER BY id FOR UPDATE",[db.workspaceId,environment])).rows;
 const results=[];
 for(const pool of pools){
  await poolLock(db,pool.id);
  const now=environment==='SIMULATION'?await numberNow(db,db.workspaceId,environment):(await db.query('SELECT clock_timestamp() AS now')).rows[0].now;
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw Error('QR_DATABASE_CLOCK_REQUIRED');
  await evaluateWarmupPool(db,pool,now);
  results.push({...await reconcileWarmupPool(db,pool,now),plan:await planWarmupPool(db,pool,now)});
 }
 return{enrolled,results,externalEffects:0 as const};
}

/** Companion to processQrWarmupProfile inside WorkerScope; mixed legacy pools
 * retain their participant origins. No profile discovery or external IO here. */
export async function processLegacyWarmupProfile(db:ProfileExecutor,environment:'REAL'|'SIMULATION'){
 const pools=(await db.query("SELECT * FROM warmup_pools WHERE workspace_id=$1 AND environment=$2 AND continuity_mode='LEGACY' ORDER BY id FOR UPDATE",[db.workspaceId,environment])).rows,results=[];
 for(const pool of pools){await poolLock(db,pool.id);const at=environment==='SIMULATION'?await numberNow(db,db.workspaceId,environment):(await db.query('SELECT clock_timestamp() AS now')).rows[0].now;await evaluateWarmupPool(db,pool,at);await reconcileWarmupPool(db,pool,at);results.push(await planWarmupPool(db,pool,at));}
 return{results,externalEffects:0 as const};
}
