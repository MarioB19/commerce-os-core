import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from '../../../packages/db/src/index.js';
import {principal,scopedRecord,parseBody,mutate,fail,audit,envOf} from './context.js';

export async function copySourceIsolationRoutes(app:FastifyInstance){
 const owner=(req:Parameters<typeof principal>[0])=>{const p=principal(req);if(p.service||p.role!=='owner')throw fail(403,'OWNER_CONFIRMATION_REQUIRED');if(envOf(req)!=='REAL')throw fail(400,'REAL_ISOLATION_ONLY');return p;};
 app.get('/v1/channel-accounts/:id/source-isolation',async(req,reply)=>{
  const p=owner(req),a=await scopedRecord(req,'channel_account',(req.params as {id:string}).id);
  const rows=(await pool.query(`SELECT id,account_version,session_revision,primary_device_id,responsible_user_id,source_project,billing_enabled,technical_observed_at,issued_at,expires_at,primary_revocation_reported_at,primary_report_source,completed_receipt_id FROM copy_source_isolation_challenges WHERE workspace_id=$1 AND account_id=$2 AND environment='REAL' AND expires_at>clock_timestamp() ORDER BY issued_at DESC LIMIT 5`,[p.workspace_id,a.id])).rows;
  reply.header('Cache-Control','no-store');return{data:{account_id:a.id,challenges:rows,authorizes_operations:false}};
 });
 app.post('/v1/channel-accounts/:id/source-isolation/confirm',async req=>{
  const p=owner(req),accountId=(req.params as {id:string}).id;
  const input=z.object({challenge_id:z.string().uuid(),expected_account_version:z.number().int().positive(),expected_session_version:z.number().int().positive(),previous_commerce_devices_revoked:z.literal(true),confirmation:z.literal('REVOKED_PREVIOUS_COMMERCE_DEVICES_AFTER_CHALLENGE'),reason:z.string().trim().min(3).max(240)}).strict().parse(parseBody(req));
  const result=await mutate(req,'channel.source_isolation.confirm:'+accountId,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['channel-command:'+accountId]);
   const a=await scopedRecord(req,'channel_account',accountId,c);if(a.version!==input.expected_account_version)throw fail(409,'VERSION_CONFLICT');
   const s=(await c.query('SELECT * FROM channel_sessions WHERE account_id=$1 AND workspace_id=$2 AND environment=$3 AND archived_at IS NULL FOR UPDATE',[a.id,a.workspace_id,a.environment])).rows[0];if(!s||s.revision!==input.expected_session_version)throw fail(409,'SESSION_VERSION_CONFLICT');
   const challenge=(await c.query(`SELECT * FROM copy_source_isolation_challenges WHERE id=$1 AND account_id=$2 AND workspace_id=$3 AND environment='REAL' AND expires_at>clock_timestamp() AND technical_observed_at>clock_timestamp()-interval '24 hours' FOR UPDATE`,[input.challenge_id,a.id,p.workspace_id])).rows[0];
   if(!challenge||challenge.completed_receipt_id||challenge.primary_revocation_reported_at)throw fail(409,'CURRENT_SOURCE_ISOLATION_CHALLENGE_REQUIRED');
   if(challenge.account_version!==a.version||Number(challenge.session_revision)!==s.revision||challenge.credential_generation!==s.credential_generation||challenge.primary_device_id!==s.primary_device_id||challenge.responsible_user_id!==s.responsible_user_id)throw fail(409,'SOURCE_ISOLATION_SCOPE_CHANGED');
   if(!(await c.query('SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND active=true',[a.workspace_id,s.responsible_user_id])).rowCount)throw fail(409,'PRIMARY_RESPONSIBLE_REQUIRED');
   const ownership=(await c.query('SELECT *,lease_expires_at>clock_timestamp() AS live FROM session_ownership WHERE account_id=$1 AND workspace_id=$2 FOR UPDATE',[a.id,a.workspace_id])).rows[0];
   if(!ownership||!ownership.frozen||ownership.live||ownership.owner_id!==challenge.previous_owner_id||ownership.generation!==challenge.generation)throw fail(409,'SOURCE_OWNERSHIP_CHANGED');
   if((await c.query(`SELECT 1 FROM commands WHERE workspace_id=$1 AND environment='REAL' AND resource_id=$2 AND kind='channel_command' AND (status='PENDING' OR (status='FAILED' AND COALESCE(result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(result?'reconciled_at'))) UNION ALL SELECT 1 FROM outbox WHERE workspace_id=$1 AND account_id=$2 AND status IN('SENDING','UNKNOWN') LIMIT 1`,[a.workspace_id,a.id])).rowCount)throw fail(409,'RECONCILIATION_REQUIRED');
   const source=p.authentication_method==='personal_access_token'?'personal_owner_report':'owner_confirmation';
   const saved=(await c.query(`UPDATE copy_source_isolation_challenges SET primary_revocation_reported_at=clock_timestamp(),primary_revocation_reported_by=$2,primary_report_source=$3 WHERE id=$1 AND primary_revocation_reported_at IS NULL AND expires_at>clock_timestamp() AND technical_observed_at>clock_timestamp()-interval '24 hours' RETURNING primary_revocation_reported_at`,[challenge.id,p.user.id,source])).rows[0];if(!saved)throw fail(409,'SOURCE_ISOLATION_REPORT_CHANGED');
   await audit(c,req,'channel.source_isolation.primary_reported',a.id,{challenge_id:challenge.id,source,previous_devices_revoked_declared:true,reason:input.reason,remote_calls:0,root_receipt_issued:false});
   return{data:{account_id:a.id,challenge_id:challenge.id,status:'PRIMARY_REVOCATION_DECLARED',source,reported_at:saved.primary_revocation_reported_at,root_verification:'PENDING',authorizes_operations:false}};
  });return{data:result.data};
 });
}
