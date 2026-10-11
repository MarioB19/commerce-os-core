import type {Body,DomainRecord} from '../../../packages/contracts/src/index.js';
import type {QueryExecutor} from '../../../packages/db/src/index.js';
import {fail} from './context.js';
import {channelProgress} from '../../../packages/domain/src/operations/service-progress.js';

const lifecycleTypes=['connect','restart','disconnect','logout'];
const startedStates=new Set(['STARTING','RECONNECTING','QR_REQUIRED','CONNECTED']);

function failedSession(session:Body){return String(session.raw_state)==='FAILED'||session.observed_state==='AUTH_FAILURE'||session.disconnect_reason==='PROVIDER_FAILED_UNCLASSIFIED';}

export async function channelCommandProgress(c:QueryExecutor,account:DomainRecord,now=new Date()){
 const heartbeat=(await c.query("SELECT body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='service_heartbeat' AND body->>'service'='channel-worker' ORDER BY updated_at DESC LIMIT 1",[account.workspace_id,account.environment])).rows[0];
 return channelProgress(heartbeat?.body,now);
}

/** Caller holds the same account lock as the worker claim, within a transaction. */
export async function cancelPendingChannelCommand(c:QueryExecutor,account:DomainRecord,commandId:string,actor:string,reason:string,sessionRevision:number){
 const cancelled=(await c.query('SELECT command_id AS id,command_type AS type FROM public.cancel_pending_channel_command($1,$2,$3::uuid,$4::uuid,$5,$6,$7,$8)',[account.workspace_id,account.environment,account.id,commandId,actor,reason,account.version,sessionRevision])).rows[0];
 if(!cancelled)throw fail(409,'CHANNEL_COMMAND_NOT_CANCELLABLE','La orden ya empezó o cambió. Relee su resultado antes de continuar.');
 return cancelled;
}

async function restartAttempt(c:QueryExecutor,account:DomainRecord,session:Body){
 // A provider may emit FAILED more than once for the same recovery attempt.
 // Anchor the budget to the operation that began the episode, never to the
 // latest failure observation, so another FAILED cannot restore the budget.
 const connect=(await c.query("SELECT created_at FROM commands WHERE workspace_id=$1 AND environment=$2 AND resource_id=$3 AND kind='channel_command' AND payload->>'type'='connect' ORDER BY created_at DESC LIMIT 1",[account.workspace_id,account.environment,account.id])).rows[0];
 const candidates=[session.created_at,session.last_connected_at,connect?.created_at].filter(Boolean).map(value=>new Date(value).getTime()).filter(Number.isFinite);
 const anchor=new Date(Math.max(...candidates)).toISOString();
 return(await c.query("SELECT id FROM commands WHERE workspace_id=$1 AND environment=$2 AND resource_id=$3 AND kind='channel_command' AND payload->>'type'='restart' AND created_at>=$4 ORDER BY created_at DESC LIMIT 1",[account.workspace_id,account.environment,account.id,anchor])).rows[0];
}

export function reconciliationObservation(command:Body,session:Body,outcome:string){
 if(outcome==='keep_unknown')return{command_type:String(command.payload?.type??''),observed_state:String(session.observed_state??'UNKNOWN'),raw_state:String(session.raw_state??'UNKNOWN')};
 const type=String(command.payload?.type??''),observed=String(session.observed_state??'UNKNOWN'),remote=String(command.result?.remote_outcome??'UNKNOWN');
 if(!lifecycleTypes.includes(type))throw fail(409,'RECONCILIATION_COMMAND_MISMATCH','El comando ya no corresponde a una operación de ciclo de vida conciliable.');
 const definitelyNotAttempted=remote==='NOT_ATTEMPTED'||command.result?.error==='QR_OPERATION_NOT_AUTHORIZED';
 const observedApplied=['connect','restart'].includes(type)?startedStates.has(observed):observed==='STOPPED';
 const observedNotApplied=['connect','restart'].includes(type)?observed==='STOPPED':startedStates.has(observed);
 const supported=outcome==='confirmed_applied'?!definitelyNotAttempted&&observedApplied:outcome==='confirmed_not_applied'&&(definitelyNotAttempted||observedNotApplied);
 if(!supported)throw fail(409,'RECONCILIATION_OUTCOME_CONTRADICTS_OBSERVED_STATE','El resultado elegido contradice el comando o el estado observado. Conserva UNKNOWN o relee salud.',{command_type:type,outcome,observed_state:observed,raw_state:session.raw_state??null,remote_outcome:remote});
 return{command_type:type,observed_state:observed,raw_state:String(session.raw_state??'UNKNOWN'),remote_outcome:remote};
}

export async function lifecycleSafety(c:QueryExecutor,account:DomainRecord,type:string){
 if(!lifecycleTypes.includes(type))return{restart_remaining:null,uncertain:[]};
 const session=(await c.query('SELECT * FROM channel_sessions WHERE account_id=$1 AND workspace_id=$2 AND environment=$3 AND archived_at IS NULL FOR UPDATE',[account.id,account.workspace_id,account.environment])).rows[0] as Body|undefined;
 if(!session)throw fail(409,'SESSION_NOT_FOUND');
 const pending=(await c.query("SELECT id FROM commands WHERE workspace_id=$1 AND environment=$2 AND resource_id=$3 AND kind='channel_command' AND payload->>'type' IN('connect','restart','disconnect','logout') AND status='PENDING' ORDER BY created_at DESC",[account.workspace_id,account.environment,account.id])).rows;
 if(pending.length){const progress=await channelCommandProgress(c,account);throw fail(409,'LIFECYCLE_COMMAND_PENDING',progress.ready?'Hay una orden pendiente. Relee su resultado antes de solicitar otra conexión.':'El servicio de conexión no está disponible. Revisa la orden pendiente; si aún no empezó, puedes cancelarla desde el alta.',pending.map(row=>row.id));}
 const uncertain=(await c.query("SELECT id FROM commands WHERE workspace_id=$1 AND environment=$2 AND resource_id=$3 AND kind='channel_command' AND payload->>'type' IN('connect','restart','disconnect','logout') AND status='FAILED' AND COALESCE(result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(result?'reconciled_at') ORDER BY created_at DESC",[account.workspace_id,account.environment,account.id])).rows;
 if(uncertain.length)throw fail(409,'RECONCILIATION_REQUIRED','Concilia el resultado remoto incierto antes de otro intento.',uncertain.map(row=>row.id));
 const failed=failedSession(session);
 // A connect call reaches the same remote lifecycle boundary as restart. Once
 // failure is observed, accepting connect here would bypass the one-restart
 // budget exposed by the resumable setup flow.
 if(type==='connect'&&failed)throw fail(409,'CONNECT_REQUIRES_RESTART_PATH','La sesión falló. Usa el único reinicio guiado y después espera un QR fresco.');
 if(type==='connect'&&session.observed_state==='QR_REQUIRED')throw fail(409,'CONNECT_NOT_AVAILABLE_WHILE_QR_REQUIRED','La conexión ya llegó al QR. Abre el QR fresco; no repitas conectar.');
 if(type==='connect'&&startedStates.has(String(session.observed_state)))throw fail(409,'CONNECT_NOT_AVAILABLE_IN_CURRENT_STATE','La conexión ya está iniciada. Relee salud antes de solicitar otra operación.');
 if(type!=='restart')return{restart_remaining:null,uncertain:[]};
 if(!failed)throw fail(409,'RESTART_REQUIRES_FAILED_STATE','Reiniciar sólo es válido tras un fallo observado; usa conectar o relee salud.');
 const attempted=await restartAttempt(c,account,session);
 if(attempted)throw fail(409,'SETUP_RESTART_LIMIT_REACHED','Ya se usó el único reinicio de este episodio. Espera SCAN_QR_CODE y relee un QR fresco.',{command_id:attempted.id});
 return{restart_remaining:1,uncertain:[]};
}

export async function restartAvailability(c:QueryExecutor,account:DomainRecord){
 const session=(await c.query('SELECT * FROM channel_sessions WHERE account_id=$1 AND workspace_id=$2 AND environment=$3 AND archived_at IS NULL',[account.id,account.workspace_id,account.environment])).rows[0] as Body|undefined;
 if(!session)return{restart_remaining:0,failed:false,last_restart_command_id:null};
 const failed=failedSession(session);
 if(!failed)return{restart_remaining:0,failed:false,last_restart_command_id:null};
 const attempted=await restartAttempt(c,account,session);
 return{restart_remaining:attempted?0:1,failed:true,last_restart_command_id:attempted?.id??null};
}
