import {z} from 'zod';
import type {ProfileExecutor} from './profile-context.js';
import {continuousAuthorizationSchema,type ContinuousAuthorization} from '../../contracts/src/continuous-authorization.js';
import {lockedContinuousWorkerProfile} from './continuous-commercial.js';

type Environment='REAL'|'SIMULATION';
/** Selects the current QR origin, including its revocation. Never skips a
 * revoked latest connection to revive an earlier grant for the same account.
 * Channel health and provider identity are separate final-emission gates.
 */
export async function readCurrentQrContinuity(db:ProfileExecutor,environment:Environment,accountId:string){
 accountId=z.uuid().parse(accountId);z.enum(['REAL','SIMULATION']).parse(environment);
 await lockedContinuousWorkerProfile(db);
 const rows=(await db.query(`SELECT a.state FROM channel_sessions s
  JOIN LATERAL (SELECT c.id FROM commands c WHERE c.workspace_id=s.workspace_id AND c.environment=s.environment
   AND c.resource_id=s.account_id::text AND c.kind='channel_command' AND c.payload->>'type'='connect' AND c.status='APPLIED'
   ORDER BY c.created_at DESC,c.id DESC LIMIT 1) latest ON true
  JOIN continuous_authorizations a ON a.workspace_id=s.workspace_id AND a.environment=s.environment AND a.account_id=s.account_id
   AND a.qr_command_id=latest.id AND a.state->'source'->>'identityFingerprint'=s.expected_identity_fingerprint
  WHERE s.workspace_id=$1 AND s.environment=$2 AND s.account_id=$3 AND s.archived_at IS NULL FOR SHARE OF s,a`,
 [db.workspaceId,environment,accountId])).rows;
 if(rows.length!==1)return undefined;
 const state=continuousAuthorizationSchema.parse(rows[0].state);
 if(state.workspaceId!==db.workspaceId||state.environment!==environment||state.accountId!==accountId||state.source.kind!=='VERIFIED_QR_CONNECTION')return undefined;
 return state;
}
/** Permanent permission alone cannot make a peer healthy or ready to send. */
export function continuousWarmupAuthorityBlock(sender:ContinuousAuthorization,peer:ContinuousAuthorization|undefined,
 scope:{workspaceId:string;environment:Environment;senderId:string;peerId:string}):string|undefined{
 const s=continuousAuthorizationSchema.parse(sender),p=peer?continuousAuthorizationSchema.parse(peer):undefined;
 if(s.workspaceId!==scope.workspaceId||s.environment!==scope.environment||s.accountId!==scope.senderId||s.source.kind!=='VERIFIED_QR_CONNECTION')return 'CONTINUITY_WARMUP_SCOPE_CHANGED';
 if(s.revokedAt)return 'CONTINUITY_REVOKED';if(s.humanPaused)return 'CONTINUITY_HUMAN_PAUSED';if(s.protections.length)return 'CONTINUITY_PROTECTED';
 if(!p||p.workspaceId!==s.workspaceId||p.environment!==s.environment||p.accountId!==scope.peerId||p.accountId===s.accountId||p.source.kind!=='VERIFIED_QR_CONNECTION'
  ||p.revokedAt||p.humanPaused||p.protections.length)return 'CONTINUITY_OWN_PEER_REQUIRED';
 return undefined;
}
