import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import {principal,envOf,parseBody,mutate,fail,scopedRecord,audit} from './context.js';
const idOf=(req:FastifyRequest)=>z.object({id:z.string().uuid()}).parse(req.params).id;
function permit(req:FastifyRequest,write=false){const p=principal(req);assertPermission(p,p.service?write?'warmup:manage':'warmup:read':write?'channels:manage':'sales:read');return p;}
const revision=z.number().int().min(1),reason=z.string().trim().min(8).max(500);

/** V7 F8-D: the owner's recovery port for a warm-up profile update left
 * UNKNOWN. It only asks the worker for a read-only review; it never repeats the
 * provider write. The V5 warm-up pools, content and simulator administration
 * were retired; warm-up runs automatically per number (warmup_manage). */
export async function warmupReviewRoutes(app:FastifyInstance){
 app.post('/v1/warmup/accounts/:id/profile-review',async req=>{
  const p=permit(req,true);if(p.service||p.role!=='owner')throw fail(403,'OWNER_REQUIRED');const id=idOf(req),input=z.object({expected_version:revision,reason}).strict().parse(parseBody(req));
  const result=await mutate(req,'warmup.profile.review:'+id,async c=>{
   await scopedRecord(req,'channel_account',id,c);
   const ref=(await c.query('SELECT pool_id FROM warmup_states WHERE account_id=$1 AND workspace_id=$2 AND environment=$3',[id,p.workspace_id,envOf(req)])).rows[0];if(!ref)throw fail(404,'NOT_FOUND');
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`warmup-pool:${ref.pool_id}`]);
   const state=(await c.query('SELECT version FROM warmup_states WHERE account_id=$1 FOR UPDATE',[id])).rows[0];if(state.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');
   const identity=(await c.query('SELECT id,profile_operation_status FROM warmup_identities WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 FOR UPDATE',[p.workspace_id,envOf(req),id])).rows[0];
   if(!identity||identity.profile_operation_status!=='UNKNOWN')throw fail(409,'PROFILE_NOT_UNKNOWN');
   await c.query('UPDATE warmup_identities SET profile_review_requested_at=now() WHERE id=$1',[identity.id]);
   await c.query('UPDATE warmup_states SET version=version+1,updated_at=now() WHERE account_id=$1',[id]);
   await audit(c,req,'warmup.profile_review_requested',id,{identity_id:identity.id,reason:input.reason,remote_mutations:false});
   return{data:{account_id:id,version:state.version+1,review_requested:true,profile_operation_status:'UNKNOWN',external_mutations:false}};
  });return{data:result.data};
 });
}
