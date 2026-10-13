import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from '../../../packages/db/src/index.js';
import type {Body} from '../../../packages/contracts/src/index.js';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import {principal,envOf,resourcePermitted,fail,sanitize} from './context.js';

/** Follows a command to its outbox effects (kept from the retired assistant
 * module in V7 F8): an operator or agent reads whether a reply was accepted,
 * delivered or failed. Read only; it never repeats or changes an effect. */
export async function commandEffectRoutes(app:FastifyInstance){
 app.get('/v1/commands/:id/effects',async req=>{
  const p=principal(req);if(p.service)assertPermission(p,'commands:read');else if(!['owner','operator','reconciler'].includes(p.role))throw fail(403,'FORBIDDEN');
  const id=z.string().uuid().parse((req.params as Body).id),environment=envOf(req);
  const command=(await pool.query('SELECT * FROM commands WHERE workspace_id=$1 AND environment=$2 AND id=$3',[p.workspace_id,environment,id])).rows[0];
  if(!command||!resourcePermitted(p,command.resource_id))throw fail(404,'NOT_FOUND');
  const effects=(await pool.query("SELECT * FROM outbox WHERE workspace_id=$1 AND environment=$2 AND (id::text=$3 OR logical_key=$4 OR logical_key LIKE $5) ORDER BY created_at",[p.workspace_id,environment,command.result?.effect_id??'',`command:${id}`,`command:${id}:%`])).rows;
  return{data:sanitize(effects),meta:{command_status:command.status,delivery_evidence:effects.length?'OUTBOX_STATUS':'NO_DIRECT_EFFECT_RECORDED',portal_access:'NOT_OBSERVED'}};
 });
}
