import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {pool,putRecord} from '@commerce/db';
import {readChannelSession,sessionEvent} from '../../../packages/db/src/channel-sessions.js';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';

import {principal,scopedRecord,parseBody,mutate,fail,audit} from './context.js';
import {reconciliationObservation} from './channel-command-safety.js';
import type {Body} from '@commerce/contracts';
const revision=z.number().int().positive(),reason=z.string().trim().min(3).max(1000);
function access(req:FastifyRequest,write=false){const p=principal(req);assertPermission(p,write?'channels:manage':p.service?'channels:read':'sales:read');return p;}
async function change(req:FastifyRequest,operation:string,input:Body,fn:(c:any,a:any,s:Body)=>Promise<void>){
 const p=access(req,true),accountId=(req.params as Body).id;
 const result=await mutate(req,`channel.session.${operation}:${accountId}`,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['channel-command:'+accountId]);
  const a=await scopedRecord(req,'channel_account',accountId,c);
  const s=(await c.query('SELECT * FROM channel_sessions WHERE account_id=$1 AND workspace_id=$2 AND environment=$3 FOR UPDATE',[a.id,a.workspace_id,a.environment])).rows[0];
  if(!s)throw fail(404,'SESSION_NOT_FOUND');if(s.revision!==input.expected_version)throw fail(409,'VERSION_CONFLICT','La sesión cambió. Actualiza y revisa antes de guardar.');
  await fn(c,a,s);
  const saved=(await c.query('UPDATE channel_sessions SET revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',[s.id])).rows[0];
  await sessionEvent(c,saved,operation,p.user.id,p.service?'service_operator_report':'operator_declaration',input);
  await audit(c,req,'channel.session.'+operation,a.id,{revision:saved.revision,reason:input.reason});
  return{data:await readChannelSession(c,a)};
 });return{data:result.data};
}
/** V7 F8-D: the owner's recovery port for one number's session, kept for
 * platform operation: read the session revision, reconcile a lifecycle command
 * left UNKNOWN (it otherwise blocks every later link/unlink of that number),
 * acknowledge an alert, open an incident or prepare a relink. Configuring the
 * session and primary-usage declarations left with the V5 setup screens. */
export async function channelSessionRoutes(app:FastifyInstance){
 app.get('/v1/channel-accounts/:id/session',async(req,reply)=>{access(req);reply.header('Cache-Control','no-store');const a=await scopedRecord(req,'channel_account',(req.params as Body).id);return{data:await readChannelSession(pool,a)};});
 app.post('/v1/channel-accounts/:id/session/recovery',async req=>{
  const input=z.object({expected_version:revision,action:z.enum(['prepare_relink','request_storage_replacement','open_incident','reconcile_command','acknowledge_alert']),reason,command_id:z.string().uuid().optional(),alert_id:z.string().uuid().optional(),outcome:z.enum(['confirmed_applied','confirmed_not_applied','keep_unknown']).optional()}).strict().parse(parseBody(req));
  return change(req,input.action,input,async(c,a,s)=>{
   if(input.action==='acknowledge_alert'){
    if(!input.alert_id)throw fail(400,'ALERT_REQUIRED');const r=await c.query('UPDATE operational_alerts SET acknowledged_at=now(),acknowledged_by=$4 WHERE id=$1 AND workspace_id=$2 AND account_id=$3 RETURNING id',[input.alert_id,a.workspace_id,a.id,principal(req).user.id]);if(!r.rowCount)throw fail(404,'ALERT_NOT_FOUND');return;
   }
   if(input.action==='reconcile_command'){
    if(principal(req).role!=='owner'&&!principal(req).service)throw fail(403,'FORBIDDEN');if(!input.command_id||!input.outcome)throw fail(400,'RECONCILIATION_REQUIRED');
    const cmd=(await c.query("SELECT * FROM commands WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND resource_id=$4 AND kind='channel_command' AND status='FAILED' AND COALESCE(result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(result?'reconciled_at') FOR UPDATE",[input.command_id,a.workspace_id,a.environment,a.id])).rows[0];if(!cmd)throw fail(404,'FAILED_COMMAND_NOT_FOUND');
    if(input.outcome!=='keep_unknown'){if(!s.last_health_at||new Date(s.last_health_at)<=new Date(cmd.updated_at)||!s.health_expires_at||new Date(s.health_expires_at)<=new Date())throw fail(409,'FRESH_HEALTH_REQUIRED');const observation=reconciliationObservation(cmd,s,input.outcome);await c.query("UPDATE commands SET result=result||$2::jsonb,updated_at=now() WHERE id=$1",[cmd.id,JSON.stringify({reconciled_at:new Date().toISOString(),reconciled_by:principal(req).user.id,reconciliation:input.outcome,evidence:input.reason,reconciliation_observation:observation})]);await c.query('UPDATE channel_sessions SET recovery_blocker=NULL WHERE id=$1',[s.id]);}return;
   }
   await c.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'channel_account',$2,true,$3,$4) ON CONFLICT(workspace_id,scope_type,scope_id) DO UPDATE SET paused=true,reason=EXCLUDED.reason,version=manual_controls.version+1,updated_at=now()",[a.workspace_id,a.id,input.reason,principal(req).user.id]);
   await c.query('UPDATE session_ownership SET frozen=true,updated_at=now() WHERE account_id=$1 AND workspace_id=$2',[a.id,a.workspace_id]);
   if(input.action!=='open_incident'){
    const uncertain=(await readChannelSession(c,a))!.uncertain_commands;if(uncertain.length||(await c.query("SELECT 1 FROM outbox WHERE account_id=$1 AND workspace_id=$2 AND status IN('SENDING','UNKNOWN')",[a.id,a.workspace_id])).rowCount)throw fail(409,'RECONCILIATION_REQUIRED','Concilia comandos y envíos inciertos antes de preparar credenciales.');
    await c.query('UPDATE channel_sessions SET operational_pause=true,recovery_enabled=false,desired_state=\'STOPPED\',recovery_stage=$2 WHERE id=$1',[s.id,input.action==='prepare_relink'?'AWAITING_ISOLATION':'STORAGE_REPLACEMENT_REQUESTED']);
   }
   await putRecord(c,{workspaceId:a.workspace_id,environment:a.environment,kind:'incident',body:{account_id:a.id,status:'OPEN',reason:input.reason,runbook:input.action==='request_storage_replacement'?'waha-storage-recovery':'channel-relink',source:'operator',session_id:s.id}});
  });
 });
}
