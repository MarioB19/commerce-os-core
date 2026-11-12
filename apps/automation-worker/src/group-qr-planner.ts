import type {Body} from '../../../packages/contracts/src/index.js';
import type {ProfileExecutor} from '../../../packages/db/src/profile-context.js';
import {uuid,hash,stableJson,readOperationalSettings} from '../../../packages/db/src/index.js';
import {groupEligibility} from '../../../packages/db/src/warmup-groups.js';
import {groupQrAuthorities,lockWarmupProfile,programConfig,readGroupProgram,cancelGroupPending} from '../../../packages/db/src/group-warmup.js';
import {groupDailyBudget,groupProfile,shuffledLibrary} from '../../../packages/domain/src/warmup/group-policy.js';
import {localWindow} from '../../../packages/domain/src/warmup/policy.js';

/** Durable reservation, inside one profile transaction. No provider/AI calls. */
export async function planQrGroupPool(db:ProfileExecutor,pool:Body,now:Date){
 const stop=(reason:string)=>({planned:0,messages:0,reason});
 await lockWarmupProfile(db,pool.environment);
 const p=await readGroupProgram(db,pool.environment,pool.program_id,true),config=programConfig(p);
 // V7.5 §5 (H06): reservations follow the pool row of this transaction, not
 // the object read before the evaluator of the same pass changed it.
 const current=(await db.query('SELECT * FROM warmup_pools WHERE id=$1 AND workspace_id=$2 AND environment=$3 FOR UPDATE',[pool.id,db.workspaceId,pool.environment])).rows[0];
 if(!current)return stop('PROGRAM_DISABLED');
 if(p.status!=='ACTIVE'||current.paused)return stop('PROGRAM_PAUSED');
 if(current.breaker_open)return stop('PROTECTION_OPEN');
 if(!current.enabled||current.archived_at)return stop('PROGRAM_DISABLED');
 const profile=groupProfile(config),window=localWindow(profile,now);if(!window.open)return stop('QUIET_HOURS');
 const policy=await readOperationalSettings(db,db.workspaceId,pool.environment,{lock:'share'});
 if(pool.environment==='REAL'&&(policy.body.dispatch_frozen||!policy.body.real_sends_enabled||!policy.body.allow_real_operations))return stop('REAL_OPERATION_NOT_ENABLED');
 const group=(await db.query('SELECT * FROM warmup_groups WHERE id=$1 AND workspace_id=$2 AND environment=$3',[p.group_id,db.workspaceId,pool.environment])).rows[0];
 if(!group||group.version!==p.scope.membershipVersion)return stop('GROUP_MEMBERSHIP_CHANGED');
 const eligibility=groupEligibility(group,p.account_ids,now,config.senderIds,{audience:true});
 // V7.4 D: the owner's «ya está preparado» choice is checked again where
 // messages are reserved; a later change never leaves that line sending.
 if((await db.query("SELECT 1 FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='channel_account' AND id=ANY($3::uuid[]) AND (body->>'warmup_mode'='DECLARED_READY' OR body?'deleted_at' OR body?'removal_requested_at') LIMIT 1",[db.workspaceId,pool.environment,p.account_ids])).rowCount)return stop('PARTICIPANT_WARMUP_NOT_REQUESTED');
 if(eligibility){if(eligibility==='GROUP_MEMBERSHIP_STALE')await db.query('SELECT request_active_warmup_group_refresh($1,$2)',[pool.environment,p.id]);return stop(eligibility);}
 const states=(await db.query('SELECT * FROM warmup_states WHERE workspace_id=$1 AND environment=$2 AND pool_id=$3 AND account_id=ANY($4::uuid[]) ORDER BY account_id FOR UPDATE',[db.workspaceId,pool.environment,pool.id,p.account_ids])).rows;
 if(states.length!==p.account_ids.length||states.some(s=>s.paused||s.confirmed_block||s.group_required||!s.identity_id))return stop('MEMBER_NOT_READY');
 let grants:Awaited<ReturnType<typeof groupQrAuthorities>>;
 try{grants=await groupQrAuthorities(db,pool.environment,p.account_ids);}catch(error){if(error instanceof Error&&'statusCode' in error)return stop(error.message);throw error;}
 const senders=states.filter(s=>config.senderIds.includes(s.account_id)),graduated=senders.every(s=>s.status==='GRADUATED');
 if(graduated&&!config.maintenance)return stop('PREPARATION_COMPLETED');
 if(!graduated&&senders.every(s=>s.effective_days>=14))return stop('PREPARATION_EVALUATION_PENDING');
 if((await db.query("SELECT 1 FROM outbox WHERE workspace_id=$1 AND environment=$2 AND account_id=ANY($3::text[]) AND kind<>'warmup' AND status IN('READY','BLOCKED','SENDING','UNKNOWN') LIMIT 1",[db.workspaceId,pool.environment,p.account_ids])).rowCount)return stop('COMMERCIAL_PRIORITY');
 if((await db.query("SELECT 1 FROM outbox WHERE workspace_id=$1 AND environment=$2 AND (account_id=ANY($3::text[]) OR payload->>'group_id'=$4) AND status IN('SENDING','UNKNOWN') LIMIT 1",[db.workspaceId,pool.environment,p.account_ids,group.id])).rowCount)return stop('GROUP_RECONCILIATION_REQUIRED');
 const currentOrigins=Object.fromEntries([...grants].map(([id,g])=>[id,g.id]));
 if((await db.query("SELECT 1 FROM outbox WHERE workspace_id=$1 AND environment=$2 AND kind='warmup' AND payload->>'warmup_pool_id'=$3 AND status IN('READY','BLOCKED') AND payload->'qr_origins' IS DISTINCT FROM $4::jsonb LIMIT 1",[db.workspaceId,pool.environment,pool.id,currentOrigins])).rowCount)await cancelGroupPending(db,pool.environment,p.account_ids,'QR_ORIGIN_CHANGED_REPLAN');
 const day=Math.min(...senders.map(s=>s.effective_days))+1,budget=groupDailyBudget(config,day,now,graduated);
 const plans=(await db.query('SELECT * FROM warmup_plans WHERE account_id=ANY($1::uuid[]) AND local_date=$2 FOR UPDATE',[config.senderIds,window.date])).rows;
 if(plans.some(plan=>plan.profile_id!==pool.profile_id||plan.budget.policy_version!=='group-outgoing/v1'))return stop('PREVIOUS_MODE_DAY_PRESERVED');
 const prior=(await db.query(`SELECT o.account_id,count(*)::int count FROM outbox o JOIN warmup_conversations v ON v.id::text=o.conversation_id
  WHERE o.workspace_id=$1 AND o.environment=$2 AND o.kind='warmup' AND v.local_date=$3 AND
   (v.group_id=$4 OR o.account_id=ANY($5::text[])) AND (o.status NOT IN('CANCELLED','FAILED') OR o.attempts>0) GROUP BY o.account_id`,[db.workspaceId,pool.environment,window.date,group.id,config.senderIds])).rows;
 const used=new Map<string,number>(config.senderIds.map(id=>[id,Number(prior.find(r=>r.account_id===id)?.count??0)]));let total=prior.reduce((n,r)=>n+Number(r.count),0);
 const candidates=(await db.query(`SELECT m.* FROM warmup_content m WHERE m.workspace_id=$1 AND m.environment=$2 AND m.id=ANY($3::uuid[])
  AND m.origin='LIBRARY' AND NOT EXISTS(SELECT 1 FROM warmup_content_usage u JOIN warmup_conversations v ON v.id=u.conversation_id
   JOIN warmup_content previous ON previous.id=v.content_id WHERE u.workspace_id=$1 AND u.environment=$2 AND u.released_at IS NULL
    AND (u.account_id=ANY($4::uuid[]) OR v.group_id=$5)
    AND (u.reserved_at>$6 OR EXISTS(SELECT 1 FROM warmup_turns t JOIN outbox o ON o.id=t.effect_id WHERE t.conversation_id=v.id AND o.status IN('READY','BLOCKED','SENDING','UNKNOWN')))
    AND (m.content_hash=u.content_hash OR m.message_hashes && previous.message_hashes))`,[db.workspaceId,pool.environment,p.content_ids,p.account_ids,group.id,new Date(now.getTime()-7*86400000)])).rows;
 const contents=shuffledLibrary(candidates,`${p.id}:${window.date}`),chosen:{content:Body;senders:string[]}[]=[];
 let end=now.getTime();for(let i=0;i<1440&&localWindow(profile,new Date(end)).open;i++)end+=60000;
 const gap=Math.max(60,Math.ceil(60/profile.rate_per_minute)+profile.jitter_seconds),capacity=Math.max(0,Math.floor((end-now.getTime()-1000)/(gap*1000)));
 const outstanding=(await db.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND environment=$2 AND payload->>'group_id'=$3 AND status IN('READY','BLOCKED')",[db.workspaceId,pool.environment,group.id])).rows[0].n;
 let added=0;
 for(const content of contents){const count=content.body.turns.length;if(count<config.senderIds.length||total+count>budget.total||added+outstanding+count>capacity)continue;
  const tentative=new Map(used),assigned:string[]=[];
  for(let turn=0;turn<count;turn++){const eligible=config.senderIds.filter(id=>(tentative.get(id)??0)<budget.per_sender&&id!==assigned.at(-1));
   eligible.sort((a,b)=>(tentative.get(a)??0)-(tentative.get(b)??0)||hash(`${p.id}:${window.date}:${a}`).localeCompare(hash(`${p.id}:${window.date}:${b}`)));
   const sender=eligible[0];if(!sender)break;assigned.push(sender);tentative.set(sender,(tentative.get(sender)??0)+1);
  }
  if(assigned.length!==count)continue;for(const [id,n] of tentative)used.set(id,n);chosen.push({content,senders:assigned});total+=count;added+=count;
 }
 if(!chosen.length)return stop(total>=budget.total?'DAILY_LIMIT_REACHED':!contents.length?'LIBRARY_EXHAUSTED':capacity<=outstanding?'WINDOW_TOO_SHORT':'DAILY_CAPACITY_RESERVED');
 for(const state of senders){await db.query(`INSERT INTO warmup_plans(workspace_id,environment,account_id,profile_id,episode_id,local_date,effective_day,budget)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(account_id,local_date) DO NOTHING`,[db.workspaceId,pool.environment,state.account_id,pool.profile_id,state.episode_id,window.date,day,
  {...budget,min_messages:budget.min_outgoing,max_messages:budget.per_sender,min_conversations:1,max_conversations:budget.total,group_sends:budget.total}]);}
 const next=(await db.query("SELECT max(not_before) AS at FROM outbox WHERE workspace_id=$1 AND environment=$2 AND payload->>'group_id'=$3 AND status IN('READY','BLOCKED','SENDING')",[db.workspaceId,pool.environment,group.id])).rows[0].at;
 let cursor=Math.max(now.getTime(),next?new Date(next).getTime():0),planned=0,plannedMessages=0;
 const origin=Object.fromEntries([...grants].map(([id,g])=>[id,g.id]));
 for(const {content,senders:assigned} of chosen){
  if(cursor+assigned.length*gap*1000>=end)break;
  const conversation=uuid();await db.query(`INSERT INTO warmup_conversations(id,workspace_id,environment,initiator_id,peer_id,content_id,local_date,pool_id,group_id,membership_version,member_ids)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[conversation,db.workspaceId,pool.environment,assigned[0],assigned[1],content.id,window.date,pool.id,group.id,group.version,p.account_ids]);
  let predecessor:string|null=null;
  for(const [position,body] of (content.body.turns as Body[]).entries()){
   const sender=assigned[position]!,recipients:string[]=p.account_ids.filter((id:string)=>id!==sender),turn=uuid(),effect=uuid();cursor+=gap*1000;
   const notBefore=new Date(cursor),expires=new Date(end);
   await db.query(`INSERT INTO warmup_turns(id,workspace_id,environment,conversation_id,sender_id,recipient_id,recipient_ids,position,content,not_before,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[turn,db.workspaceId,pool.environment,conversation,sender,recipients[0],recipients,position,body,notBefore,expires]);
   const payload={...body,warmup_turn_id:turn,warmup_pool_id:pool.id,content_hash:content.content_hash,group_protocol:'v1',group_id:group.id,membership_version:group.version,purpose:pool.purpose,
    program_revision:p.version,library_version:config.libraryVersion,qr_origins:origin};
   const digest=hash(stableJson({account_id:sender,contact_id:recipients[0],payload}));
   await db.query(`INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,logical_key,kind,payload,predecessor_id,config_hash,approval_hash,continuous_authorization_id,not_before,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'warmup',$8,$9,$10,$10,$11,$12,$13)`,[effect,db.workspaceId,pool.environment,sender,conversation,recipients[0],`warmup:${turn}`,payload,predecessor,digest,grants.get(sender)!.id,notBefore,expires]);
   await db.query('UPDATE warmup_turns SET effect_id=$2 WHERE id=$1',[turn,effect]);predecessor=effect;
  }
  for(const member of p.account_ids)await db.query('INSERT INTO warmup_content_usage(workspace_id,environment,account_id,content_hash,conversation_id,reserved_at) VALUES($1,$2,$3,$4,$5,$6)',[db.workspaceId,pool.environment,member,content.content_hash,conversation,now]);planned++;plannedMessages+=assigned.length;
 }
 await db.query(`UPDATE warmup_plans plan SET planned_messages=(SELECT count(*) FROM outbox o JOIN warmup_conversations v ON v.id::text=o.conversation_id WHERE v.pool_id=$1 AND v.local_date=$2 AND o.account_id=plan.account_id::text AND o.status<>'CANCELLED'),
  planned_conversations=(SELECT count(DISTINCT v.id) FROM warmup_conversations v JOIN outbox o ON o.conversation_id=v.id::text WHERE v.pool_id=$1 AND v.local_date=$2 AND o.account_id=plan.account_id::text AND o.status<>'CANCELLED')
  WHERE plan.account_id=ANY($3::uuid[]) AND plan.local_date=$2`,[pool.id,window.date,config.senderIds]);
 await db.query("UPDATE warmup_states SET status=CASE WHEN status='GRADUATED' THEN status ELSE 'WARMING' END,reason=$2,warmup_started_at=COALESCE(warmup_started_at,$3) WHERE pool_id=$1 AND account_id=ANY($4::uuid[])",[pool.id,graduated?'GROUP_MAINTENANCE':'GROUP_PLANNED',now,config.senderIds]);
 return{planned,messages:plannedMessages,reason:undefined};
}
