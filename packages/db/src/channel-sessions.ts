import type {DomainRecord,Body} from '../../contracts/src/index.js';
import type {QueryExecutor} from './index.js';
import {normalizeSession,primaryMaintenance} from '../../domain/src/health/session-continuity.js';
import type {HealthSignal} from '../../messaging/src/types.js';
export async function sessionEvent(c:QueryExecutor,s:Body,kind:string,actor:string,source:string,evidence:Body={},observed=new Date()){
 await c.query('INSERT INTO channel_session_events(session_id,workspace_id,environment,account_id,kind,actor_id,source,evidence,revision,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[s.id,s.workspace_id,s.environment,s.account_id,kind,actor,source,evidence,s.revision,observed]);
}
export async function readChannelSession(c:QueryExecutor,a:DomainRecord,now=new Date()){
 const s=(await c.query('SELECT * FROM channel_sessions WHERE account_id=$1 AND workspace_id=$2 AND environment=$3',[a.id,a.workspace_id,a.environment])).rows[0];if(!s)return null;
 const responsible=s.responsible_user_id?(await c.query('SELECT u.name FROM "user" u JOIN memberships m ON m.user_id=u.id WHERE m.workspace_id=$1 AND m.active=true AND u.id=$2',[a.workspace_id,s.responsible_user_id])).rows[0]?.name??null:null;
 const owner=(await c.query('SELECT owner_id,generation,frozen,lease_expires_at FROM session_ownership WHERE account_id=$1 AND workspace_id=$2',[a.id,a.workspace_id])).rows[0]??null;
 const uncertain=(await c.query("SELECT id,status,payload->>'type' type,result->>'error' error FROM commands WHERE workspace_id=$1 AND environment=$2 AND resource_id=$3 AND kind='channel_command' AND payload->>'type' IN('connect','restart','disconnect','logout') AND ((status='PENDING') OR (status='FAILED' AND COALESCE(result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(result?'reconciled_at'))) ORDER BY created_at DESC LIMIT 20",[a.workspace_id,a.environment,a.id])).rows;
 const history=(await c.query('SELECT id,kind,source,actor_id,evidence,observed_at,recorded_at,revision FROM channel_session_events WHERE session_id=$1 ORDER BY recorded_at DESC LIMIT 50',[s.id])).rows;
 const alerts=(await c.query('SELECT id,kind,severity,status,episode,evidence,created_at,resolved_at,acknowledged_at FROM operational_alerts WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 ORDER BY created_at DESC LIMIT 30',[a.workspace_id,a.environment,a.id])).rows;
 return {...s,responsible_name:responsible,observed_state:s.health_expires_at&&new Date(s.health_expires_at)>now?s.observed_state:'UNKNOWN',stored_observed_state:s.observed_state,health_fresh:!!s.health_expires_at&&new Date(s.health_expires_at)>now,maintenance:primaryMaintenance(s.primary_last_used_at,now),ownership:owner,uncertain_commands:uncertain,history,alerts,sending_enabled:a.body.sending_enabled===true};
}
export async function observeChannelSession(c:QueryExecutor,a:DomainRecord,signals:HealthSignal[],actor='health-reader'){
 const s=(await c.query('SELECT * FROM channel_sessions WHERE account_id=$1 AND workspace_id=$2 FOR UPDATE',[a.id,a.workspace_id])).rows[0];if(!s||s.archived_at)return;
 const signal=signals.find(v=>v.dimension==='session');if(!signal)return;
 const at=new Date(signal.observedAt);if(a.environment==='REAL'&&a.body.last_lifecycle_at&&at<=new Date(a.body.last_lifecycle_at))return;if(!Number.isFinite(at.getTime())||a.environment==='REAL'&&at.getTime()>Date.now()+1000||s.provider_observed_at&&at<=new Date(s.provider_observed_at))return;
 const identity=signals.find(v=>v.dimension==='transport'&&v.status==='OK')?.value as {identity_fingerprint?:string}|undefined;
 const conflict=!!identity?.identity_fingerprint&&!!s.expected_identity_fingerprint&&identity.identity_fingerprint!==s.expected_identity_fingerprint;
 const verified=!!identity?.identity_fingerprint&&!conflict;
 const state=normalizeSession(signal.value,verified,conflict),connected=state.observed_state==='CONNECTED';
 const reason=conflict?'IDENTITY_CONFLICT':state.auth_state==='PASSKEY_REQUIRED'?'PASSKEY_REQUIRED':state.observed_state==='QR_REQUIRED'?'QR_REQUIRED':signal.value==='FAILED'?'PROVIDER_FAILED_UNCLASSIFIED':state.observed_state==='STOPPED'&&s.last_connected_at?'CONFIRMED_STOPPED_AFTER_CONNECTION':state.observed_state==='UNKNOWN'?'PROVIDER_STATE_UNKNOWN':null;
 const recoveryVerified=connected&&s.recovery_stage==='AWAITING_NEW_QR'&&!!s.expected_identity_fingerprint;
 const stable=connected?(s.stable_since??at):null;
 // Budget reset requires continuous fresh observations for 30 minutes.
 const reset=connected&&s.health_expires_at&&new Date(s.health_expires_at)>=at&&stable&&at.getTime()-new Date(stable).getTime()>=1800000;
 await c.query(`UPDATE channel_sessions SET observed_state=$2,auth_state=$3,raw_state=$4,last_health_at=$5,provider_observed_at=$5,health_expires_at=$6,last_connected_at=CASE WHEN $7 THEN $5 ELSE last_connected_at END,stable_since=$8,disconnected_at=CASE WHEN $7 THEN NULL ELSE COALESCE(disconnected_at,$5) END,disconnect_reason=$9,reason_source='provider_read',expected_identity_fingerprint=COALESCE(expected_identity_fingerprint,$10),retry_count=CASE WHEN $11 THEN 0 ELSE retry_count END,next_retry_at=CASE WHEN $7 THEN NULL ELSE next_retry_at END,recovery_stage=CASE WHEN $12 THEN 'IDENTITY_VERIFIED_REVIEW_REQUIRED' ELSE recovery_stage END,updated_at=now() WHERE id=$1`,[s.id,state.observed_state,state.auth_state,state.raw_state,at,signal.expiresAt,connected,connected&&(!s.health_expires_at||new Date(s.health_expires_at)<at)?at:stable,reason,verified?identity!.identity_fingerprint:null,!!reset,recoveryVerified]);
 if(recoveryVerified)await sessionEvent(c,s,'recovery_identity_verified',actor,'provider_read',{credential_generation:s.credential_generation,automatic_resume:false},at);
 if(s.observed_state!==state.observed_state||s.auth_state!==state.auth_state)await sessionEvent(c,s,'state_observed',actor,'provider_read',{...state,reason},at);
}
