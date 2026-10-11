import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {putRecord} from '@commerce/db';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import {lockCatalogRecord} from './catalog-versions.js';
import {principal,parseBody,mutate,fail,audit,scopedRecord} from './context.js';

export async function channelDeletionRoutes(app:FastifyInstance) {
 app.delete<{Params:{id:string}}>('/v1/channel-accounts/:id',async req=>{
  assertPermission(principal(req),'channels:manage');
  const input=z.object({expected_version:z.number().int().positive(),confirmation:z.literal('DELETE_CHANNEL_ACCOUNT'),reason:z.string().trim().min(3).max(2000)}).strict().parse(parseBody(req));
  const result=await mutate(req,'channel.delete:'+req.params.id,async c=>{
   // The command producer and worker use this lock before claiming lifecycle work.
   await scopedRecord(req,'channel_account',req.params.id,c);
   const lock=(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired',['channel-command:'+req.params.id])).rows[0];
   if(!lock.acquired)throw fail(409,'CHANNEL_COMMAND_PENDING','La sesión está ocupada. Espera el resultado de su operación antes de eliminarla.');
   const account=await lockCatalogRecord(req,'channel_account',req.params.id,c);
   if(account.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT','El número cambió. Actualiza su estado antes de eliminarlo.');
   if(!['NEW','DISCONNECTED','STOPPED'].includes(account.body.status))throw fail(409,'DISCONNECT_BEFORE_DELETE','Desconecta o desvincula este número y espera la confirmación antes de eliminarlo.');
   if((await c.query("SELECT 1 FROM commands WHERE workspace_id=$1 AND environment=$2 AND resource_id=$3 AND kind='channel_command' AND status='PENDING' LIMIT 1",[account.workspace_id,account.environment,account.id])).rowCount)throw fail(409,'CHANNEL_COMMAND_PENDING','Hay una acción en proceso. Espera su resultado antes de eliminar el número.');
   const ownership=(await c.query('SELECT frozen FROM session_ownership WHERE workspace_id=$1 AND account_id=$2',[account.workspace_id,account.id])).rows[0];
   if(account.body.provider==='waha'&&ownership&&!account.body.unlinked_at)throw fail(409,'UNLINK_BEFORE_DELETE','Pulsa Desvincular WhatsApp y espera su confirmación para eliminar este número.');
   if(ownership&&!ownership.frozen)throw fail(409,'DISCONNECT_BEFORE_DELETE','Desconecta este número antes de eliminarlo.');
   // Dispatch locks controls before ownership; use the same order to avoid deadlocks.
   await c.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'channel_account',$2,true,$3,$4) ON CONFLICT(workspace_id,scope_type,scope_id) DO UPDATE SET paused=true,version=manual_controls.version+1,reason=EXCLUDED.reason,actor_id=EXCLUDED.actor_id",[account.workspace_id,account.id,input.reason,principal(req).user.id]);
   if((await c.query("SELECT 1 FROM outbox WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND status IN ('SENDING','UNKNOWN') LIMIT 1",[account.workspace_id,account.environment,account.id])).rowCount)throw fail(409,'CHANNEL_EFFECTS_UNRESOLVED','Hay envíos en curso o con resultado incierto. Revisa su resultado antes de eliminar el número.');
   await c.query('UPDATE session_ownership SET frozen=true,updated_at=now() WHERE workspace_id=$1 AND account_id=$2',[account.workspace_id,account.id]);
   await c.query("UPDATE operation_authorizations SET revoked_at=COALESCE(revoked_at,now()) WHERE workspace_id=$1 AND environment=$2 AND scope->'account_ids' ? $3",[account.workspace_id,account.environment,account.id]);
   const deletedAt=new Date().toISOString();
   await putRecord(c,{id:account.id,workspaceId:account.workspace_id,environment:account.environment,kind:'channel_account',version:account.version,body:{...account.body,deleted_at:deletedAt,deleted_by:principal(req).user.id,sending_enabled:false,active_authorization_id:null,identity_verified:false}});
   await audit(c,req,'channel.deleted',account.id,{reason:input.reason,history_preserved:true},account.environment);
   return{data:{id:account.id,deleted:true,history_preserved:true}};
  });
  return{data:result.data};
 });
}
