import {bindLegacyWarmupEffectOrigins,legacyPoolAuthorities,type LegacyQrAuthority} from '../../../packages/db/src/legacy-qr-warmup.js';
import type {Body} from '@commerce/contracts';
import {uuid,hash,stableJson,readOperationalSettings,type QueryExecutor} from '@commerce/db';
import {profileFor} from '../../../packages/db/src/warmup.js';
import {preparationGate} from '../../../packages/db/src/preparation.js';
import {groupEligibility} from '../../../packages/db/src/warmup-groups.js';
import {isStandard15dPolicy,localWindow,warmupPolicy,dailyBudget} from '../../../packages/domain/src/warmup/policy.js';
import {groupDayFeasibility} from '../../../packages/domain/src/warmup/preparation.js';

export async function planGroupPool(c:QueryExecutor,pool:Body,now:Date){
 const stop=(reason:string)=>({planned:0,reason});
 if(!pool.enabled||pool.paused||pool.breaker_open||pool.archived_at)return stop('PROGRAM_PAUSED');
 const profile=await profileFor(c,pool.profile_id),window=localWindow(profile,now);if(!window.open)return stop('QUIET_HOURS');
 const group=(await c.query('SELECT * FROM warmup_groups WHERE id=$1',[pool.group_id])).rows[0];
 const states=(await c.query('SELECT s.*,a.body FROM warmup_states s JOIN records a ON a.id=s.account_id WHERE s.pool_id=$1 ORDER BY s.account_id FOR UPDATE OF s',[pool.id])).rows;
 const ids:string[]=states.map(s=>s.account_id),reason=group?groupEligibility(group,ids,now):'GROUP_REQUIRED';if(reason)return stop(reason);
 const policy=await readOperationalSettings(c,pool.workspace_id,pool.environment,{lock:'share'});
 if(pool.environment==='REAL'&&(policy.body.dispatch_frozen||!policy.body.real_sends_enabled||!policy.body.allow_real_operations))return stop('REAL_OPERATION_NOT_ENABLED');
 const auth=(await c.query('SELECT * FROM read_locked_operation_authorization($1,$2,$3)',[pool.authorization_id,pool.workspace_id,pool.environment])).rows[0];
 const legacyValid=auth&&auth.scope.mode==='warmup'&&auth.scope.pool_id===pool.id&&auth.configuration_version===policy.version&&auth.scope.group_id===group.id&&auth.scope.membership_version===group.version&&auth.scope.purpose===pool.purpose&&(!auth.scope.policy_version||auth.scope.policy_version===profile.policy_version);
 const origins=new Map<string,LegacyQrAuthority>();for(const [key,value]of await legacyPoolAuthorities(c,pool.workspace_id,pool.environment,ids))origins.set(key,value);
 if(ids.some(id=>origins.get(id)?.kind==='BLOCKED'||origins.get(id)?.kind!=='ADOPTED'&&(!legacyValid||!auth.scope.account_ids?.includes(id))))return stop('AUTHORIZATION_CHANGED');
 const legacyMembers=ids.filter(id=>origins.get(id)?.kind!=='ADOPTED');
 const contentIds=ids.map(id=>{const source=origins.get(id);return source?.kind==='ADOPTED'?source.contentIds:auth.scope.content_ids as string[];}).reduce((allowed,next)=>allowed.filter(id=>next.includes(id)));
 if(states.some(s=>s.body.status!=='WORKING'||s.paused||s.confirmed_block||!s.identity_id))return stop('MEMBER_NOT_READY');
 if(pool.purpose==='maintenance'){
  if(states.some(s=>s.status!=='GRADUATED'))return stop('PREPARATION_REQUIRED');
  if((await c.query("SELECT 1 FROM outbox WHERE account_id=ANY($1::text[]) AND kind<>'warmup' AND status IN('READY','BLOCKED','SENDING','UNKNOWN') LIMIT 1",[ids])).rowCount)return stop('COMMERCIAL_PRIORITY');
 }else if(isStandard15dPolicy(profile.policy_version))for(const s of states)if(!(await preparationGate(c,s.account_id,now)).ready)return stop('PREPARATION_REQUIREMENTS_PENDING');
 const requirements=warmupPolicy(profile);
 if(pool.purpose==='preparation'&&states.every(s=>s.effective_days>=requirements.automatic_days))return stop('PREPARATION_EVALUATION_PENDING');
 // A partial day never moves to a larger quota; the slowest participant determines this group day.
 const day=pool.purpose==='maintenance'?1:Math.min(...states.map(s=>s.effective_days))+1;
 if((await c.query('SELECT 1 FROM warmup_plans WHERE account_id=ANY($1::uuid[]) AND local_date=$2',[ids,window.date])).rowCount)return stop('DAY_ALREADY_PLANNED');
 const contents=(await c.query(`SELECT * FROM warmup_content m WHERE m.workspace_id=$1 AND m.environment=$2 AND m.id=ANY($3::uuid[]) AND NOT EXISTS(SELECT 1 FROM warmup_content_usage u JOIN warmup_conversations v ON v.id=u.conversation_id WHERE u.account_id=ANY($4::uuid[]) AND u.content_hash=m.content_hash AND u.released_at IS NULL AND (v.local_date=$5 OR u.reserved_at>$6 OR EXISTS(SELECT 1 FROM warmup_turns t JOIN outbox o ON o.id=t.effect_id WHERE t.conversation_id=v.id AND o.status IN('READY','BLOCKED','SENDING','UNKNOWN')))) ORDER BY m.created_at,m.id`,[pool.workspace_id,pool.environment,contentIds,ids,window.date,new Date(now.getTime()-86400000)])).rows;
 const budget=groupDayFeasibility(profile,day,now,ids.length,contents.map(m=>m.body.turns.length));if(!budget.feasible)return stop(budget.reason!);
 const chosen:Body[]=[];let messages=0;for(const content of contents){if(messages>=budget.min_participations)break;if(content.body.turns.length<ids.length||messages+content.body.turns.length>budget.max_participations)continue;chosen.push(content);messages+=content.body.turns.length;}
 if([...origins.values()].some(origin=>origin.kind==='ADOPTED')&&chosen.length>dailyBudget(profile,day,now).max_conversations)return stop('GROUP_DAILY_CONVERSATION_LIMIT');
 const used=legacyMembers.length?Number((await c.query("SELECT count(*) FROM outbox WHERE authorization_id=$1 AND status NOT IN('CANCELLED','FAILED')",[auth.id])).rows[0].count):0;
 if(legacyMembers.length&&used+messages>auth.scope.max_messages)return stop('AUTHORIZATION_MESSAGE_LIMIT');
 let end=now.getTime();for(let i=0;i<1440&&localWindow(profile,new Date(end)).open;i++)end+=60000;
 const expiresAt=new Date(Math.min(end,legacyMembers.length?new Date(auth.expires_at).getTime():end)),gap=Math.max(60,Math.ceil(60/profile.rate_per_minute)+profile.jitter_seconds);
 if(now.getTime()+messages*gap*1000>=expiresAt.getTime())return stop('WINDOW_TOO_SHORT');
 for(const id of ids){const state=states.find(s=>s.account_id===id)!;await c.query('INSERT INTO warmup_plans(workspace_id,environment,account_id,profile_id,episode_id,local_date,effective_day,budget,planned_messages,planned_conversations) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[pool.workspace_id,pool.environment,id,pool.profile_id,state.episode_id,window.date,day,{min_messages:budget.min_participations,max_messages:budget.max_participations,min_conversations:chosen.length,max_conversations:chosen.length,group_sends:messages},messages,chosen.length]);}
 let positionAll=0,predecessor:string|null=null;
 for(const content of chosen){
  const run=(await c.query("SELECT id FROM warmup_simulation_runs WHERE execution_workspace=$1 AND input->>'scenario'='numbers-lifecycle'",[pool.workspace_id])).rows[0];const conversationId=uuid();await c.query('INSERT INTO warmup_conversations(id,workspace_id,environment,initiator_id,peer_id,content_id,local_date,pool_id,group_id,membership_version,member_ids,simulation_run_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[conversationId,pool.workspace_id,pool.environment,ids[0],ids[1],content.id,window.date,pool.id,group.id,group.version,ids,run?.id??null]);
  for(const [position,turnContent]of(content.body.turns as Body[]).entries()){
   const sender=ids[position%ids.length]!,recipients=ids.filter(id=>id!==sender),turnId=uuid(),effectId=uuid(),notBefore=new Date(now.getTime()+(++positionAll)*gap*1000);
   await c.query('INSERT INTO warmup_turns(id,workspace_id,environment,conversation_id,sender_id,recipient_id,recipient_ids,position,content,not_before,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[turnId,pool.workspace_id,pool.environment,conversationId,sender,recipients[0],recipients,position,turnContent,notBefore,expiresAt]);
   const payload={...turnContent,warmup_turn_id:turnId,warmup_pool_id:pool.id,content_hash:content.content_hash,group_protocol:'v1',group_id:group.id,membership_version:group.version,purpose:pool.purpose},configHash=hash(stableJson({account_id:sender,contact_id:recipients[0],payload}));
   const authority=origins.get(sender);
   if(authority?.kind==='ADOPTED')await c.query("INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,logical_key,kind,payload,predecessor_id,config_hash,approval_hash,continuous_authorization_id,not_before,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'warmup',$8,$9,$10,$10,$11,$12,$13)",[effectId,pool.workspace_id,pool.environment,sender,conversationId,recipients[0],`warmup:${turnId}`,payload,position===0?null:predecessor,configHash,authority.grant.id,notBefore,expiresAt]);
   else await c.query("INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,logical_key,kind,payload,predecessor_id,config_hash,approval_hash,authorization_id,not_before,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'warmup',$8,$9,$10,$10,$11,$12,$13)",[effectId,pool.workspace_id,pool.environment,sender,conversationId,recipients[0],`warmup:${turnId}`,payload,position===0?null:predecessor,configHash,auth.id,notBefore,expiresAt]);
   await bindLegacyWarmupEffectOrigins(c,{workspaceId:pool.workspace_id,environment:pool.environment,effectId,accountIds:ids},origins,auth?.id??null);
   await c.query('UPDATE warmup_turns SET effect_id=$2 WHERE id=$1',[turnId,effectId]);predecessor=effectId;
  }
  for(const id of ids)await c.query('INSERT INTO warmup_content_usage(workspace_id,environment,account_id,content_hash,conversation_id,reserved_at) VALUES($1,$2,$3,$4,$5,$6)',[pool.workspace_id,pool.environment,id,content.content_hash,conversationId,now]);
 }
 await c.query("UPDATE warmup_states SET status=CASE WHEN status='GRADUATED' THEN status ELSE 'WARMING' END,reason='GROUP_PLANNED',warmup_started_at=COALESCE(warmup_started_at,$2) WHERE pool_id=$1",[pool.id,now]);
 return{planned:chosen.length,messages,participants:ids.length,reason:undefined};
}
