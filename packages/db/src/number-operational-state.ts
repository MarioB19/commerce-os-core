import type {Body,DomainRecord} from '../../contracts/src/index.js';
import type {QueryExecutor} from './index.js';

export type OperationalStatus='READY'|'REQUIRES_ATTENTION'|'BLOCKED'|'IN_PROGRESS'|'UNKNOWN'|'UNAVAILABLE'|'NO_DATA'|'HISTORICAL';

/**
 * Canonical, side-effect-free connection projection shared by API surfaces.
 * Account.body.status remains provider history; a current channel_sessions
 * observation is the only source that can prove a live connection.
 */
export async function readNumberOperationalState(c:QueryExecutor,account:DomainRecord,now=new Date()){
 const session=(await c.query('SELECT * FROM channel_sessions WHERE account_id=$1 AND workspace_id=$2 AND environment=$3 AND archived_at IS NULL',[account.id,account.workspace_id,account.environment])).rows[0] as Body|undefined;
 const pendingCommands=(await c.query("SELECT id,status,payload->>'type' type,result='{}'::jsonb AS cancellable,created_at,updated_at FROM commands WHERE workspace_id=$1 AND environment=$2 AND resource_id=$3 AND kind='channel_command' AND payload->>'type' IN('connect','restart','disconnect','logout','check_health') AND status='PENDING' ORDER BY created_at DESC LIMIT 20",[account.workspace_id,account.environment,account.id])).rows;
 const uncertainCommands=(await c.query("SELECT id,status,payload->>'type' type,result->>'error' error,created_at,updated_at FROM commands WHERE workspace_id=$1 AND environment=$2 AND resource_id=$3 AND kind='channel_command' AND payload->>'type' IN('connect','restart','disconnect','logout') AND status='FAILED' AND COALESCE(result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(result?'reconciled_at') ORDER BY created_at DESC LIMIT 20",[account.workspace_id,account.environment,account.id])).rows;
 const fresh=!!session?.health_expires_at&&new Date(session.health_expires_at)>now&&(!session.last_health_at||new Date(session.last_health_at)<=now);
 const stored=String(session?.observed_state??'UNKNOWN');
 const state=fresh?stored:'UNKNOWN';
 const connection=state==='CONNECTED'?'CONNECTED':state==='QR_REQUIRED'?'QR_REQUIRED':state==='STARTING'||state==='RECONNECTING'?'CONNECTING':state==='STOPPED'?'DISCONNECTED':state==='AUTH_FAILURE'?'AUTH_FAILURE':'UNKNOWN';
 const status:OperationalStatus=uncertainCommands.length?'UNKNOWN':pendingCommands.length?'IN_PROGRESS':connection==='CONNECTED'?'READY':connection==='CONNECTING'?'IN_PROGRESS':connection==='AUTH_FAILURE'?'BLOCKED':connection==='UNKNOWN'?'REQUIRES_ATTENTION':'REQUIRES_ATTENTION';
 const cause=uncertainCommands.length?'REMOTE_OUTCOME_UNKNOWN':pendingCommands.length?'LIFECYCLE_COMMAND_PENDING':!session?'SESSION_NOT_CREATED':!fresh?'SESSION_EVIDENCE_STALE':session.disconnect_reason??(connection==='QR_REQUIRED'?'QR_REQUIRED':connection==='DISCONNECTED'?'SESSION_STOPPED':connection);
 return{status,connection,cause,observed_at:session?.last_health_at??session?.provider_observed_at??null,expires_at:session?.health_expires_at??null,source:'channel_sessions',fresh,session:session??null,session_version:session?.revision??null,pending_commands:pendingCommands,uncertain_commands:uncertainCommands};
}
