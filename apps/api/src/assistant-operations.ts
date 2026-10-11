import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from '../../../packages/db/src/index.js';
import type {Body} from '../../../packages/contracts/src/index.js';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import {principal,envOf,parseBody,scopedRecord,mutate,resourcePermitted,fail,audit,sanitize} from './context.js';

export async function assistantOperationRoutes(app:FastifyInstance){
 app.post('/v1/conversations/:id/proposals',async(req,reply)=>{
  const p=principal(req);assertPermission(p,p.service?'sales:propose':'sales:operate');
  const input=z.object({expected_version:z.number().int().positive(),kind:z.enum(['text','audio','image','document','video']).default('text'),text:z.string().max(4096).default(''),asset_id:z.string().uuid().optional(),reason:z.string().trim().min(3).max(2000)}).strict().parse(parseBody(req));
  if(input.kind==='text'&&!input.text.trim()||input.kind!=='text'&&!input.asset_id)throw fail(400,'MESSAGE_REQUIRED');
  const result=await mutate(req,'conversation.proposal:'+(req.params as Body).id,async c=>{
   const conversation=await scopedRecord(req,'conversation',(req.params as Body).id,c);
   await c.query('SELECT id FROM records WHERE id=$1 FOR UPDATE',[conversation.id]);
   const current=await scopedRecord(req,'conversation',conversation.id,c);
   if(current.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');
   if(input.asset_id){const asset=await scopedRecord(req,'asset',input.asset_id,c);if(asset.body.status!=='READY')throw fail(409,'ASSET_NOT_READY');}
   const row=(await c.query('INSERT INTO sales_command_proposals(workspace_id,environment,conversation_id,actor_id,expected_version,payload) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[p.workspace_id,envOf(req),current.id,p.user.id,current.version,input])).rows[0];
   await audit(c,req,'conversation.command_proposed',current.id,{proposal_id:row.id,expected_version:current.version});
   return{data:{...sanitize(row),external_effects:false,review_href:'/sales/inbox/'+current.id},status:201};
  });reply.code(result.status??201);return{data:result.data};
 });
 app.get('/v1/conversations/:id/proposals',async req=>{
  const p=principal(req);assertPermission(p,p.service?'sales:read':'sales:operate');const conversation=await scopedRecord(req,'conversation',(req.params as Body).id);
  return{data:sanitize((await pool.query('SELECT * FROM sales_command_proposals WHERE workspace_id=$1 AND environment=$2 AND conversation_id=$3 ORDER BY created_at DESC LIMIT 100',[p.workspace_id,envOf(req),conversation.id])).rows)};
 });
 app.get('/v1/commands/:id/effects',async req=>{
  const p=principal(req);if(p.service)assertPermission(p,'commands:read');else if(!['owner','operator','reconciler'].includes(p.role))throw fail(403,'FORBIDDEN');
  const id=z.string().uuid().parse((req.params as Body).id),environment=envOf(req);
  const command=(await pool.query('SELECT * FROM commands WHERE workspace_id=$1 AND environment=$2 AND id=$3',[p.workspace_id,environment,id])).rows[0];
  if(!command||!resourcePermitted(p,command.resource_id))throw fail(404,'NOT_FOUND');
  const effects=(await pool.query("SELECT * FROM outbox WHERE workspace_id=$1 AND environment=$2 AND (id::text=$3 OR logical_key=$4 OR logical_key LIKE $5) ORDER BY created_at",[p.workspace_id,environment,command.result?.effect_id??'',`command:${id}`,`command:${id}:%`])).rows;
  return{data:sanitize(effects),meta:{command_status:command.status,delivery_evidence:effects.length?'OUTBOX_STATUS':'NO_DIRECT_EFFECT_RECORDED',portal_access:'NOT_OBSERVED'}};
 });
}
