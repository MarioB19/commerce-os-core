import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from '@commerce/db';
import type {Body} from '@commerce/contracts';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import {principal,envOf,parseBody,mutate,scopedRecord,audit,fail,sanitize} from './context.js';
import {loadSellerSnapshot} from '../../../packages/db/src/seller-context.js';
import {resolveSellerAssignment} from '../../../packages/domain/src/sales/seller-context.js';
import {salesAiConfiguration} from '../../../packages/db/src/sales-ai-configuration.js';
import {activeAt,listAssignments} from '../../../packages/db/src/commercial-assignments.js';
import {lockLaunchTestOrderCreation} from '../../../packages/db/src/launch-test-scope.js';

const id=z.string().uuid(),reason=z.string().trim().min(5).max(500);
function operator(req:Parameters<typeof principal>[0],scope='simulations:run'){const p=principal(req);assertPermission(p,p.service?scope:'sales:operate');if(!p.service&&!['owner','operator'].includes(p.role))throw fail(403,'FORBIDDEN');return p;}

export async function mclLaunchRoutes(app:FastifyInstance){
 app.get('/v1/channel-accounts/:id/effective-seller',async req=>{
  const p=operator(req,'workflows:read'),account=await scopedRecord(req,'channel_account',id.parse((req.params as Body).id));
  const query=req.query as Body;
  const assignments=(await listAssignments(pool,p.workspace_id,envOf(req),{account_id:account.id,product_id:query.product_id?id.parse(query.product_id):undefined})).filter(a=>activeAt(a,new Date().toISOString()));
  const selected=query.assignment_id?assignments.find(a=>a.id===id.parse(query.assignment_id)):assignments.length===1?assignments[0]:undefined;
  if(query.assignment_id&&!selected)throw fail(404,'ASSIGNMENT_NOT_FOUND');
  if(!selected&&!query.binding_id&&assignments.length>1)throw fail(409,'PRODUCT_SELECTION_REQUIRED');
  const bindingId=selected?.binding_id??query.binding_id;
  const binding=bindingId?await scopedRecord(req,'binding',id.parse(bindingId)):undefined;
  if(binding&&(binding.body.account_id!==account.id||Date.parse(binding.body.valid_from)>Date.now()||binding.body.valid_to&&Date.parse(binding.body.valid_to)<=Date.now()))throw fail(409,'BINDING_NOT_CURRENT_FOR_ACCOUNT');
  const offerId=binding?.body.offer_version_id??account.body.offer_version_id;
  const offer=offerId?await scopedRecord(req,'offer',offerId):undefined;
  const product=offer?.body.product_id?await scopedRecord(req,'product',offer.body.product_id):undefined;
  const flowId=binding?.body.workflow_version_id??offer?.body.workflow_version_id??account.body.workflow_version_id??product?.body.workflow_template_version_id;
  const flow=flowId?await scopedRecord(req,'workflow',flowId):undefined;
  const assignment=resolveSellerAssignment({binding:binding?.body,offer:offer?.body,account:account.body,product:product?.body,workflow:flow?.body});
  const agent=assignment.agent_version_id?await scopedRecord(req,'agent',assignment.agent_version_id):undefined;
  const snapshot=await loadSellerSnapshot(pool,p.workspace_id,envOf(req),offerId,assignment.agent_version_id);
  const profile=agent?await salesAiConfiguration(pool,p.workspace_id,envOf(req),agent.body):undefined;
  const recent=(await pool.query("SELECT id,body->>'agent_version_id' agent_version_id,body->>'agent_assignment_origin' agent_assignment_origin,body->>'ai_status' ai_status FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='conversation' AND body->>'account_id'=$3 ORDER BY created_at DESC LIMIT 10",[p.workspace_id,envOf(req),account.id])).rows;
  const bindings=(await pool.query("SELECT id,body->>'offer_version_id' offer_version_id FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='binding' AND body->>'account_id'=$3 AND (body->>'valid_from')::timestamptz<=now() AND (NOT body ? 'valid_to' OR (body->>'valid_to')::timestamptz>now())",[p.workspace_id,envOf(req),account.id])).rows;
  return{data:{account_id:account.id,assignment,offer_version_id:offer?.id,workflow_version_id:flow?.id,product_id:product?.id,agent_revision:agent?.version,snapshot,provider_profile:{configured:profile?.configured??false,enabled:profile?.configured??false,state:profile?.state??'SELLER_PENDING',version:profile?.connection_revision??null,model:profile?.agent?.model??null,max_cost_minor:profile?.agent?.max_cost_minor??null},scope:binding?'EXPLICIT_BINDING':'ACCOUNT_DEFAULT_SELECT_BINDING_FOR_ATTRIBUTED_ENTRY',current_bindings:bindings,recent_conversations:recent,real_provider_evaluated:false}};
 });
 app.get('/v1/launch-tests',async req=>{const p=operator(req),q=z.object({product_id:id.optional()}).parse(req.query);return{data:(await pool.query("SELECT s.* FROM mcl_test_scopes s JOIN records o ON o.id=s.offer_version_id WHERE s.workspace_id=$1 AND s.environment=$2 AND ($3::text IS NULL OR o.body->>'product_id'=$3) AND ($4::uuid[] IS NULL OR s.account_id=ANY($4)) ORDER BY s.created_at DESC LIMIT 100",[p.workspace_id,envOf(req),q.product_id??null,p.resource_ids??null])).rows};});
 app.post('/v1/launch-tests',async(req,reply)=>{
  const p=operator(req);if(!p.service&&p.role!=='owner')throw fail(403,'OWNER_REQUIRED');
  const input=z.object({account_id:id,offer_version_id:id,assignment_id:id.optional(),product_id:id.optional(),participants:z.array(z.object({contact_id:id,role:z.literal('buyer'),own_phone_confirmed:z.literal(true)}).strict()).min(1).max(5),purpose:reason,expires_at:z.string().datetime({offset:true})}).strict().parse(parseBody(req));
  const expires=Date.parse(input.expires_at);if(expires<=Date.now()||expires>Date.now()+7*86400000)throw fail(400,'INVALID_EXPIRY');
  if(new Set(input.participants.map(x=>x.contact_id)).size!==input.participants.length||!input.participants.some(x=>x.role==='buyer'))throw fail(400,'DISTINCT_TEST_ROLES_REQUIRED');
  const result=await mutate(req,'launch-test.create',async c=>{
   await lockLaunchTestOrderCreation(c,p.workspace_id,input.account_id);
   const account=await scopedRecord(req,'channel_account',input.account_id,c),offer=await scopedRecord(req,'offer',input.offer_version_id,c);
   const assignments=(await listAssignments(c,p.workspace_id,envOf(req),{account_id:account.id})).filter(a=>activeAt(a,new Date().toISOString()));
   const matched=assignments.filter(a=>a.body.offer_version_id===offer.id&&(!input.assignment_id||a.id===input.assignment_id)&&(!input.product_id||a.product_id===input.product_id));
   if(offer.body.status!=='PUBLISHED'||input.product_id&&offer.body.product_id!==input.product_id||assignments.length&&(matched.length!==1)||!assignments.length&&(input.assignment_id||account.body.offer_version_id!==offer.id))throw fail(409,'TEST_ASSIGNMENT_REQUIRED');
   for(const participant of input.participants){
    await scopedRecord(req,'contact',participant.contact_id,c);
    if((await c.query(`SELECT 1 FROM mcl_test_scopes WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND offer_version_id=$4 AND revoked_at IS NULL AND expires_at>now() AND participants @> $5::jsonb`,[p.workspace_id,envOf(req),account.id,offer.id,JSON.stringify([{contact_id:participant.contact_id}])])).rowCount)throw fail(409,'PARTICIPANT_HAS_ACTIVE_TEST_SCOPE');
    if((await c.query(`SELECT 1 FROM records conv WHERE conv.workspace_id=$1 AND conv.environment=$2 AND conv.kind='conversation' AND conv.body->>'contact_id'=$3 AND conv.body->>'account_id'=$4 AND conv.body->>'status'='OPEN' AND conv.body->>'offer_version_id'=$5`,[p.workspace_id,envOf(req),participant.contact_id,account.id,offer.id])).rowCount)throw fail(409,'TEST_REQUIRES_NEW_CONVERSATION','El ensayo debe declararse antes de crear su conversación. Cierra el recorrido anterior y usa una nueva conversación de prueba.');
   }
   const row=(await c.query('INSERT INTO mcl_test_scopes(workspace_id,environment,account_id,offer_version_id,participants,purpose,actor_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[p.workspace_id,envOf(req),account.id,offer.id,JSON.stringify(input.participants),input.purpose,p.user.id,input.expires_at])).rows[0];
   await audit(c,req,'mcl.test_scope_created',row.id,{account_id:account.id,offer_version_id:offer.id,participants:input.participants,expires_at:input.expires_at,external_effects:0});
   return{data:{...row,authorizes_sends:false,analytics_excluded_from_creation:true},status:201};
  });reply.code(result.status??201);return{data:result.data};
 });
 app.post('/v1/launch-tests/:id/revoke',async req=>{
  const p=operator(req);if(!p.service&&p.role!=='owner')throw fail(403,'OWNER_REQUIRED');const input=z.object({reason}).strict().parse(parseBody(req));
  const result=await mutate(req,'launch-test.revoke:'+(req.params as Body).id,async c=>{const row=(await c.query('UPDATE mcl_test_scopes SET revoked_at=COALESCE(revoked_at,now()) WHERE workspace_id=$1 AND environment=$2 AND id=$3 RETURNING *',[p.workspace_id,envOf(req),id.parse((req.params as Body).id)])).rows[0];if(!row)throw fail(404,'NOT_FOUND');await audit(c,req,'mcl.test_scope_revoked',row.id,{reason:input.reason});return{data:row};});return{data:result.data};
 });
 app.get('/v1/sponsorships',async req=>{
  const p=operator(req);const rows=(await pool.query(`SELECT s.*,d.status delivery_status,d.provider_message_id delivery_provider_id,n.status notice_status,n.provider_message_id notice_provider_id FROM mcl_sponsorships s LEFT JOIN outbox d ON d.id=s.delivery_effect_id LEFT JOIN outbox n ON n.id=s.notice_effect_id WHERE s.workspace_id=$1 AND s.environment=$2 ORDER BY s.created_at DESC LIMIT 200`,[p.workspace_id,envOf(req)])).rows;
  return{data:rows.map(r=>sanitize({...r,legacy_exception:true,actions_enabled:false,receipt_verified:!!r.confirmed_at,complete:!!r.confirmed_at&&['SENT','DELIVERED','READ'].includes(r.notice_status)}))};
 });
 app.post('/v1/sponsorships/:id/commands',async req=>{operator(req);throw fail(410,'SPONSORSHIP_RETIRED','Los compromisos anteriores se conservan en archivo. Madrina es un tier sin entregas a terceros.');});
}
