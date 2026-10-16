import {appendEvent} from '../../../packages/db/src/index.js';
import {setRemarketingAttemptStatus} from '../../../packages/db/src/commercial-remarketing.js';
import type {ProfileExecutor} from '../../../packages/db/src/profile-context.js';

/** Terminal maintenance of effects proven never sent. Run inside one profile
 * transaction; neither account readiness nor a send authorization is required.
 * Uncertain attempts and SIMULATION's virtual clock are deliberately excluded. */
export async function cancelExpiredUnsentEffects(db:ProfileExecutor,limit=100):Promise<number>{
 if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error('EXPIRY_LIMIT_INVALID');
 const authority=(await db.query("SELECT current_user AS role,current_setting('app.workspace_id',true) AS workspace")).rows[0];
 if(authority?.role!=='commerce_channel'||authority.workspace!==db.workspaceId)throw Error('EXPIRY_PROFILE_CONTEXT_REQUIRED');
 const profile=(await db.query('SELECT id FROM read_locked_continuous_worker_profile()')).rows[0];
 if(profile?.id!==db.workspaceId)throw Error('EXPIRY_PROFILE_REQUIRED');
 const effects=(await db.query(`SELECT o.* FROM outbox o
  WHERE o.workspace_id=$1 AND o.environment='REAL' AND o.status IN('READY','BLOCKED')
   AND o.expires_at<=clock_timestamp() AND o.attempts=0 AND o.claim_id IS NULL
   AND o.provider_message_id IS NULL AND NOT EXISTS(
    SELECT 1 FROM effect_attempts a WHERE a.effect_id=o.id AND a.status<>'NOT_SENT')
  ORDER BY o.expires_at,o.id FOR UPDATE OF o SKIP LOCKED LIMIT $2`,[db.workspaceId,limit])).rows;
 for(const effect of effects){
  await db.query(`UPDATE outbox SET status='CANCELLED',
   result=result||jsonb_build_object('prior_status',status,'prior_reason',result->'reason',
    'reason','EFFECT_EXPIRED','expired_at',expires_at,'cancelled_at',clock_timestamp(),
    'external_attempt',false,'superseded_before_send',true),updated_at=clock_timestamp()
   WHERE id=$1 AND workspace_id=$2 AND environment='REAL'`,[effect.id,db.workspaceId]);
  await db.query('DELETE FROM outbox_gate_schedule WHERE effect_id=$1',[effect.id]);
  if(effect.payload.remarketing_attempt_id)await setRemarketingAttemptStatus(db,{
   attemptId:effect.payload.remarketing_attempt_id,workspaceId:db.workspaceId,environment:'REAL',
  },'CANCELLED',{reason:'EFFECT_EXPIRED',external_attempt:false});
  await appendEvent(db,{workspace_id:db.workspaceId,environment:'REAL',event_type:'effect.cancelled',
   aggregate_id:effect.conversation_id,causation_id:effect.id,actor:{type:'channel',id:'expiry-maintenance'},
   payload:{effect_id:effect.id,prior_status:effect.status,reason:'EFFECT_EXPIRED',
    expires_at:effect.expires_at,external_attempt:false,superseded_before_send:true}});
 }
 return effects.length;
}
