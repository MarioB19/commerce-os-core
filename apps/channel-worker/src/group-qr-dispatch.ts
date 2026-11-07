import type {ProfileExecutor} from '../../../packages/db/src/profile-context.js';
import type {Body} from '../../../packages/contracts/src/index.js';
import {stableJson} from '../../../packages/db/src/index.js';
import {groupQrAuthorities,programConfig} from '../../../packages/db/src/group-warmup.js';
import {readContinuousEffectAuthority} from '../../../packages/db/src/continuous-effect.js';
import {groupDailyBudget,groupProfile} from '../../../packages/domain/src/warmup/group-policy.js';
import {localWindow} from '../../../packages/domain/src/warmup/policy.js';

/** Additional final gate for the new mode; all shared group/health/lease and
 * causal receipt checks still run in gateGroupDispatch's same transaction. */
export async function gateQrGroupAuthority(db:ProfileExecutor,effect:Body,turn:Body,program:Body,states:Body[],now:Date):Promise<string|undefined>{
 const config=programConfig(program);
 if(program.status!=='ACTIVE'||program.version!==effect.payload.program_revision||program.pool_id!==turn.pool_id||program.scope.membershipVersion!==turn.membership_version||config.libraryVersion!==effect.payload.library_version
  ||!config.senderIds.includes(effect.account_id)||!program.content_ids.includes(turn.content_id)||stableJson([...program.account_ids].sort())!==stableJson([...turn.member_ids].sort()))return 'GROUP_PROGRAM_CHANGED';
 const reservations=(await db.query('SELECT account_id FROM warmup_account_reservations WHERE program_id=$1 ORDER BY account_id',[program.id])).rows;
 if(stableJson(reservations.map(r=>r.account_id))!==stableJson([...program.account_ids].sort()))return 'GROUP_RESERVATION_CHANGED';
 const read=await readContinuousEffectAuthority(db,effect.environment,effect.id);if(read.state==='EXPIRED')return read.reason;
 let grants:Awaited<ReturnType<typeof groupQrAuthorities>>;
 try{grants=await groupQrAuthorities(db,effect.environment,program.account_ids);}catch(error){if(error instanceof Error&&'statusCode' in error)return error.message;throw error;}
 if(grants.get(effect.account_id)?.id!==read.authorization.id||stableJson(effect.payload.qr_origins)!==stableJson(Object.fromEntries([...grants].map(([id,g])=>[id,g.id]))))return 'CONTINUITY_QR_ORIGIN_CHANGED';
 const date=localWindow(groupProfile(config),now).date;if(date!==turn.local_date)return 'WARMUP_PLAN_DAY_CHANGED';
 if(states.some(s=>s.group_required))return 'GROUP_SELECTION_REQUIRED';
 const senders=states.filter(s=>config.senderIds.includes(s.account_id)),maintenance=senders.every(s=>s.status==='GRADUATED');
 if(maintenance&&!config.maintenance)return 'PREPARATION_COMPLETED';
 if((await db.query("SELECT 1 FROM outbox WHERE workspace_id=$1 AND environment=$2 AND kind<>'warmup' AND account_id=ANY($3::text[]) AND status IN('READY','BLOCKED','SENDING','UNKNOWN') LIMIT 1",[db.workspaceId,effect.environment,program.account_ids])).rowCount)return 'COMMERCIAL_PRIORITY';
 const plan=(await db.query('SELECT * FROM warmup_plans WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND profile_id=$4 AND local_date=$5',[db.workspaceId,effect.environment,effect.account_id,program.profile_id,date])).rows[0];
 if(!plan||plan.episode_id!==senders.find(s=>s.account_id===effect.account_id)?.episode_id||plan.budget.policy_version!=='group-outgoing/v1')return 'WARMUP_PLAN_REQUIRED';
 const budget=groupDailyBudget(config,plan.effective_day,now,maintenance);
 if(plan.budget.per_sender!==budget.per_sender||plan.budget.total!==budget.total)return 'WARMUP_PLAN_BUDGET_CHANGED';
 const counts=(await db.query(`SELECT count(*) FILTER(WHERE v.group_id=$4)::int group_total,count(*) FILTER(WHERE o.account_id=$5)::int sender_total
  FROM outbox o JOIN warmup_conversations v ON v.id::text=o.conversation_id WHERE o.workspace_id=$1 AND o.environment=$2 AND v.local_date=$3 AND o.kind='warmup'
  AND o.id<>$6 AND (o.status NOT IN('CANCELLED','FAILED') OR o.attempts>0) AND (v.group_id=$4 OR o.account_id=$5)`,[db.workspaceId,effect.environment,date,turn.group_id,effect.account_id,effect.id])).rows[0];
 if(counts.group_total>=budget.total||counts.sender_total>=budget.per_sender)return 'WARMUP_OUTGOING_DAILY_LIMIT';
}
