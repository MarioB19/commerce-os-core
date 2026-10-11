import {pool,withTransaction,putRecord} from '@commerce/db';
import {primaryMaintenance} from '../../../packages/domain/src/health/session-continuity.js';
export async function collectSessionAlerts(now=new Date()){
 const sessions=(await pool.query("SELECT s.*,o.lease_expires_at FROM channel_sessions s LEFT JOIN session_ownership o ON o.account_id=s.account_id::text WHERE s.archived_at IS NULL AND s.provider='waha' ORDER BY s.last_health_at NULLS FIRST,s.id")).rows;
 for(const s of sessions)await withTransaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['session-alerts:'+s.id]);
  const maintenance=primaryMaintenance(s.primary_last_used_at,now),kinds:string[]=[];
  if(maintenance.status!=='CURRENT')kinds.push('PRIMARY_'+maintenance.status);
  if(s.auth_state==='QR_REQUIRED')kinds.push('SESSION_QR_REQUIRED');
  if(s.auth_state==='PASSKEY_REQUIRED')kinds.push('SESSION_PASSKEY_REQUIRED');
  if(s.auth_state==='REVOKED')kinds.push('SESSION_AUTH_REVOKED');
  if(s.auth_state==='IDENTITY_CONFLICT')kinds.push('SESSION_IDENTITY_CONFLICT');
  if(s.retry_count>=5&&s.observed_state!=='CONNECTED'){
   kinds.push('SESSION_RECOVERY_EXHAUSTED');
   if(!(await c.query("SELECT 1 FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='incident' AND body->>'account_id'=$3 AND body->>'reason'='SESSION_RECOVERY_EXHAUSTED' AND body->>'status'='OPEN'",[s.workspace_id,s.environment,s.account_id])).rowCount)await putRecord(c,{workspaceId:s.workspace_id,environment:s.environment,kind:'incident',body:{account_id:s.account_id,status:'OPEN',reason:'SESSION_RECOVERY_EXHAUSTED',runbook:'channel-session-continuity',source:'session_supervisor'}});
  }
  if(!s.health_expires_at||new Date(s.health_expires_at)<=now)kinds.push('SESSION_HEALTH_STALE');
  if(!s.lease_expires_at||new Date(s.lease_expires_at)<=now)kinds.push('SESSION_OWNER_UNAVAILABLE');
  if(s.backup_status!=='VERIFIED_COLD_BACKUP'||!s.backup_verified_at||now.getTime()-new Date(s.backup_verified_at).getTime()>86400000)kinds.push('WAHA_BACKUP_OVERDUE');
  await c.query("UPDATE operational_alerts SET resolved_at=$3,updated_at=now() WHERE account_id=$1 AND resolved_at IS NULL AND (kind LIKE 'PRIMARY_%' OR kind LIKE 'SESSION_%' OR kind='WAHA_BACKUP_OVERDUE') AND NOT(kind=ANY($2::text[]))",[s.account_id,kinds,now]);
  for(const kind of kinds){
   const episode=kind.startsWith('PRIMARY_')?'usage:'+s.primary_usage_revision:'observation:'+String(s.disconnected_at??s.created_at);
   const exists=(await c.query('SELECT 1 FROM operational_alerts WHERE account_id=$1 AND kind=$2 AND resolved_at IS NULL',[s.account_id,kind])).rowCount;if(exists)continue;
   // Unique transition key: subsequent polls reuse the open incident, a later recurrence gets a new episode.
   const key=`session:${s.id}:${kind}:${now.toISOString()}`;
   await c.query('INSERT INTO operational_alerts(workspace_id,environment,dedupe_key,kind,severity,summary_code,account_id,episode,evidence) VALUES($1,$2,$3,$4,$5,$4,$6,$7,$8) ON CONFLICT DO NOTHING',[s.workspace_id,s.environment,key,kind,kind.includes('CONFLICT')||kind.includes('REVOKED')||kind.includes('EXHAUSTED')?'CRITICAL':'WARNING',s.account_id,episode,{source:kind.startsWith('PRIMARY_')?s.primary_usage_source??'UNKNOWN':'session_supervisor',primary_days:maintenance.days,health_observed_at:s.last_health_at,backup_verified_at:s.backup_verified_at,recipient_receipt:'NOT_OBSERVED'}]);
  }
 });return sessions.length;
}
