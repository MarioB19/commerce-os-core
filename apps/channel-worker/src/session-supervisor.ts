import {randomUUID} from 'node:crypto';
import {pool,withTransaction,readOperationalSettings,type QueryExecutor} from '@commerce/db';
import {readEffectiveHealth,currentEffectiveSignal,currentRestrictionClear,effectiveHealthBlockers} from '../../../packages/db/src/effective-health.js';
import {retryDelay,primaryMaintenance} from '../../../packages/domain/src/health/session-continuity.js';
import {sessionEvent} from '../../../packages/db/src/channel-sessions.js';
import {onboardingEnabled} from '../../../packages/messaging/src/onboarding.js';
import type {Body,DomainRecord} from '@commerce/contracts';
export async function sessionRecoveryBlocker(c:QueryExecutor,a:DomainRecord,s:Body,commandId?:string){
 if(!s.recovery_enabled||s.desired_state!=='RUNNING'||s.operational_pause)return 'RECOVERY_DISABLED_OR_PAUSED';
 if(!s.primary_device_id||!s.responsible_user_id||s.inventory?.primary_availability!=='AVAILABLE'||['UNKNOWN','OVERDUE'].includes(primaryMaintenance(s.primary_last_used_at).status))return 'PRIMARY_MAINTENANCE_REQUIRED';
 const policy=await readOperationalSettings(c,a.workspace_id,a.environment,{lock:'share'});
 if(a.environment==='REAL'&&(!onboardingEnabled(policy.body)||policy.body.dispatch_frozen))return 'POLICY_PAUSED';
 const ownership=(await c.query('SELECT frozen,lease_expires_at FROM session_ownership WHERE workspace_id=$1 AND account_id=$2',[a.workspace_id,a.id])).rows[0];
 if(!ownership||new Date(ownership.lease_expires_at)<=new Date())return 'OWNERSHIP_UNAVAILABLE';
 if(ownership.frozen)return 'OWNERSHIP_FROZEN';
 if((await c.query("SELECT 1 FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='incident' AND body->>'account_id'=$3 AND body->>'reason'='CHANNEL_HEALTH_BLOCKED' AND body->>'status'='OPEN' LIMIT 1",[a.workspace_id,a.environment,a.id])).rowCount)return 'CHANNEL_HEALTH_INCIDENT_OPEN';
 const health=await readEffectiveHealth(c,{workspaceId:a.workspace_id,environment:a.environment,accountId:a.id}),session=currentEffectiveSignal(health,'session');
 if(session?.status!=='BLOCKED'||session.value!=='STOPPED')return 'HEALTH_NOT_RECOVERABLE';
 if(a.body.provider==='waha'&&!currentRestrictionClear(health))return 'RESTRICTION_CLEAR_READ_REQUIRED';
 if(effectiveHealthBlockers(health,['restriction','quality','infrastructure']).length)return 'CHANNEL_HEALTH_BLOCKED';
 if((await c.query("SELECT 1 FROM manual_controls WHERE workspace_id=$1 AND ((scope_type='channel_account' AND scope_id=$2) OR scope_type='workspace') AND (paused OR suppressed OR takeover)",[a.workspace_id,a.id])).rowCount)return 'MANUAL_PAUSE';
 if((await c.query("SELECT 1 FROM outbox WHERE workspace_id=$1 AND account_id=$2 AND status IN('SENDING','UNKNOWN')",[a.workspace_id,a.id])).rowCount)return 'EFFECT_RECONCILIATION_REQUIRED';
 if((await c.query("SELECT 1 FROM commands WHERE workspace_id=$1 AND resource_id=$2 AND id::text<>COALESCE($3,'') AND kind='channel_command' AND payload->>'type' IN('connect','restart','disconnect','logout') AND (status='PENDING' OR (status='FAILED' AND COALESCE(result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(result?'reconciled_at')))",[a.workspace_id,a.id,commandId??null])).rowCount)return 'COMMAND_RECONCILIATION_REQUIRED';
 if(s.auth_state==='IDENTITY_CONFLICT'||s.auth_state==='REVOKED'||s.auth_state==='PASSKEY_REQUIRED'||s.auth_state==='QR_REQUIRED')return s.auth_state;
 if(!s.health_expires_at||new Date(s.health_expires_at)<=new Date())return 'HEALTH_STALE';
 if(s.observed_state!=='STOPPED'||s.disconnect_reason!=='CONFIRMED_STOPPED_AFTER_CONNECTION'||!s.expected_identity_fingerprint)return 'TRANSIENT_FAILURE_NOT_CONFIRMED';
 return null;
}
/** Durable budget, no independent provider mutation; same command processor and ownership fencing. */
export async function superviseSessions(limit=20){
 const rows=(await pool.query("SELECT r.* FROM records r JOIN channel_sessions s ON s.account_id=r.id WHERE s.archived_at IS NULL AND s.recovery_enabled AND s.desired_state='RUNNING' ORDER BY s.updated_at,r.id LIMIT $1",[limit])).rows;
 for(const a of rows)await withTransaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['channel-command:'+a.id]);
  const s=(await c.query('SELECT * FROM channel_sessions WHERE account_id=$1 FOR UPDATE',[a.id])).rows[0];
  const blocker=await sessionRecoveryBlocker(c,a,s);
  if(blocker){await c.query('UPDATE channel_sessions SET recovery_blocker=$2,updated_at=now() WHERE id=$1',[s.id,blocker]);return;}
  if(s.retry_count>=5){await c.query("UPDATE channel_sessions SET recovery_blocker='RECOVERY_EXHAUSTED',updated_at=now() WHERE id=$1",[s.id]);return;}
  if(!s.next_retry_at){await c.query('UPDATE channel_sessions SET next_retry_at=now()+($2*interval \'1 millisecond\'),retry_window_started_at=COALESCE(retry_window_started_at,now()),updated_at=now() WHERE id=$1',[s.id,retryDelay(s.retry_count)]);return;}
  if(new Date(s.next_retry_at)>new Date())return;
  const id=randomUUID();await c.query("INSERT INTO commands(id,workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key) VALUES($1,$2,$3,'channel_command',$4,'session-supervisor',$5,$6)",[id,a.workspace_id,a.environment,a.id,{type:'connect',automatic_recovery:true,session_revision:s.revision,reason:'Confirmed stopped after verified connection'},'recovery:'+s.id+':'+id]);
  await c.query('UPDATE channel_sessions SET retry_count=retry_count+1,last_attempt_id=$2,next_retry_at=NULL,recovery_blocker=NULL,updated_at=now() WHERE id=$1',[s.id,id]);
  await sessionEvent(c,s,'recovery_queued','session-supervisor','deterministic_policy',{command_id:id,attempt:s.retry_count+1});
 });return rows.length;
}
