import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from '../../../packages/db/src/index.js';
import {registerSalesProfileAction} from './sales-profile-route.js';
import {authorizeBoundProfileAction} from './profile-principal-binding.js';
import {principal,envOf,idempotencyActor,fail,sanitize} from './context.js';

/** Closed names describe business commands, never an SQL table or permission
 * supplied by the caller. The actor remains the locked native session/PAT. */
const operations=Object.freeze({
 'conversation.command':{scope:'conversations:read',kind:'conversation_command'},
 'conversation.controls':{scope:'conversations:read',kind:'conversation_command'},
 'receipt.review':{scope:'receipts:read',kind:'receipt_review'},
 'order_classification':{scope:'payments:read',kind:'order_classification'},
 'receipt_classification':{scope:'payments:read',kind:'receipt_classification'},
 'order.attribution':{scope:'payments:read',kind:'order_attribution'},
 'outbox.edit':{scope:'conversations:read',kind:'conversation_command'},
 'outbox.cancel':{scope:'conversations:read',kind:'conversation_command'},
} as const);
const querySchema=z.object({environment:z.enum(['REAL','SIMULATION']).optional(),operation:z.enum(Object.keys(operations) as [keyof typeof operations,...(keyof typeof operations)[]]),resource_id:z.uuid()}).strict();
export async function salesOperationReadbackRoutes(app:FastifyInstance){
 registerSalesProfileAction(app,'GET','/v1/sales-operations/:key','operations',async req=>{
  const key=z.uuid().parse((req.params as {key:string}).key),query=querySchema.parse(req.query),definition=operations[query.operation];
  await authorizeBoundProfileAction(req,{scope:definition.scope,mutation:false});
  const p=principal(req),environment=envOf(req),operation=query.operation+':'+query.resource_id;
  const row=(await pool.query('SELECT response,status_code FROM idempotency WHERE workspace_id=$1 AND environment=$2 AND actor_id=$3 AND operation=$4 AND key=$5',[p.workspace_id,environment,idempotencyActor(p),operation,key])).rows[0];
  if(!row)throw fail(404,'SALES_OPERATION_NOT_FOUND');
  if(row.response?._retained)throw fail(410,'IDEMPOTENT_RESULT_RETAINED');
  const commandId=row.response?.command_id??row.response?.id;
  if(row.status_code!==202||!z.uuid().safeParse(commandId).success)throw fail(409,'SALES_OPERATION_READBACK_INCOMPLETE');
  const command=(await pool.query('SELECT * FROM commands WHERE workspace_id=$1 AND environment=$2 AND id=$3 AND actor_id=$4 AND idempotency_key=$5 AND kind=$6',[p.workspace_id,environment,commandId,p.user.id,key,definition.kind])).rows[0];
  if(!command)throw fail(409,'SALES_OPERATION_READBACK_INCOMPLETE');
  return{data:{key,operation:query.operation,resource_id:query.resource_id,command:sanitize(command)}};
 });
}
