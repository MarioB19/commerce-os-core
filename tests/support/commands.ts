import {randomUUID} from 'node:crypto';
import {getRecord,type QueryExecutor} from '../../packages/db/src/index.js';
import type {Body} from '../../packages/contracts/src/index.js';

/** V7 F8-D test fixture: the durable command a retired V5 route used to insert
 * (receipt review, classification), with the same conversation context, so
 * engine tests keep exercising the automation worker without that HTTP route.
 * Production commands come from the V7 routes and MCP tools. */
export async function enqueueCommand(c:QueryExecutor,input:{workspace:string;environment:'REAL'|'SIMULATION';kind:string;resourceId:string;actorId:string;payload:Body;key?:string}){
 const resource=(await c.query('SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND id::text=$3',[input.workspace,input.environment,input.resourceId])).rows[0];
 const conversation=resource?.kind==='conversation'?resource:resource?.body.conversation_id?await getRecord(c,input.workspace,'conversation',resource.body.conversation_id):undefined;
 const payload=conversation?{physical_chat_id:conversation.body.physical_chat_id,assignment_id:conversation.body.assignment_id,assignment_revision:conversation.body.assignment_revision,
  binding_id:conversation.body.binding_id,product_id:conversation.body.product_id,journey_id:conversation.id,order_id:resource?.kind==='order'?resource.id:resource?.body.order_id,
  offer_version_id:conversation.body.offer_version_id,workflow_version_id:conversation.body.workflow_version_id,agent_version_id:conversation.body.agent_version_id,...input.payload}:input.payload;
 return (await c.query('INSERT INTO commands(id,workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
  [randomUUID(),input.workspace,input.environment,input.kind,input.resourceId,input.actorId,payload,input.key??randomUUID()])).rows[0] as Body;
}
