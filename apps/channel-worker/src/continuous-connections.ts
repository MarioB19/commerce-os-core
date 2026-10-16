import {createHash} from 'node:crypto';
import {z} from 'zod';
import {withProfileTransaction,type ProfilePool} from '../../../packages/db/src/profile-context.js';
import {issueVerifiedQrContinuity,ContinuousStoreError} from '../../../packages/db/src/continuous-authorization.js';

const candidateSchema=z.object({account_id:z.uuid(),connection_id:z.uuid(),revision:z.number().int().positive(),
 expected_identity_fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
/** Stable operation identity. Only non-secret source identifiers are hashed. */
export function connectionContinuityOperation(workspaceId:string,environment:'REAL'|'SIMULATION',connectionId:string,fingerprint:string){
 const namespace=Buffer.from('e97dea7bc9d441e3a7f28751e0123f42','hex');
 const bytes=createHash('sha1').update(namespace).update(JSON.stringify(['v7-verified-qr-continuity',workspaceId,environment,connectionId.toLowerCase(),fingerprint])).digest().subarray(0,16);
 bytes[6]=(bytes[6]!&0x0f)|0x50;bytes[8]=(bytes[8]!&0x3f)|0x80;const hex=bytes.toString('hex');
 return`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
/** Dynamic, bounded per-profile discovery. This is persistence only; no QR
 * provider call, health invention, warming activation or outbound occurs here.
 * The worker scheduler supplies an authenticated profile, never public input.
 */
export async function reconcileContinuousConnections(pool:ProfilePool,workspaceId:string,environment:'REAL'|'SIMULATION',limit=20){
 z.enum(['REAL','SIMULATION']).parse(environment);z.number().int().min(1).max(100).parse(limit);
 const candidates=await withProfileTransaction(pool,workspaceId,async db=>{
  if((await db.query('SELECT current_user AS role')).rows[0]?.role!=='commerce_channel')throw new ContinuousStoreError('CONTINUITY_INTERNAL_ROLE_REQUIRED',403);
  return(await db.query(`SELECT s.account_id,c.id AS connection_id,s.revision,s.expected_identity_fingerprint
   FROM channel_sessions s JOIN records n ON n.id=s.account_id AND n.workspace_id=s.workspace_id AND n.environment=s.environment AND n.kind='channel_account'
   JOIN LATERAL (SELECT id,created_at FROM commands WHERE workspace_id=s.workspace_id AND environment=s.environment
    AND resource_id=s.account_id::text AND kind='channel_command' AND payload->>'type'='connect' AND status='APPLIED'
    ORDER BY created_at DESC,id DESC LIMIT 1) c ON true
   WHERE s.workspace_id=$1 AND s.environment=$2 AND s.archived_at IS NULL
    AND s.observed_state='CONNECTED' AND s.auth_state='VERIFIED' AND s.health_expires_at>clock_timestamp()
    AND s.provider_observed_at>=c.created_at AND n.body->>'deleted_at' IS NULL
    AND NOT EXISTS(SELECT 1 FROM continuous_authorizations a WHERE a.workspace_id=s.workspace_id AND a.environment=s.environment
     AND a.account_id=s.account_id AND a.qr_command_id=c.id AND a.state->'source'->>'identityFingerprint'=s.expected_identity_fingerprint)
   ORDER BY c.created_at,s.account_id LIMIT $3`,[workspaceId,environment,limit])).rows.map(row=>candidateSchema.parse(row));
 });
 const result:{observed:number;registered:number;deferred:number;failures:string[];externalEffects:0}={observed:candidates.length,registered:0,deferred:0,failures:[],externalEffects:0};
 for(const candidate of candidates){
  try{
   await withProfileTransaction(pool,workspaceId,db=>issueVerifiedQrContinuity(db,environment,{
    operationId:connectionContinuityOperation(workspaceId,environment,candidate.connection_id,candidate.expected_identity_fingerprint),
    connectionId:candidate.connection_id,accountId:candidate.account_id,expectedSessionRevision:candidate.revision,
    identityFingerprint:candidate.expected_identity_fingerprint,
   }));result.registered++;
  }catch(error){
   // Another account still progresses. Retain no actor/provider payload in the
   // scheduler outcome, and do not repeat a possibly committed transaction here.
   result.deferred++;result.failures.push(error instanceof ContinuousStoreError?error.code:'CONTINUITY_TRANSACTION_UNCONFIRMED');
  }
 }
 return result;
}
