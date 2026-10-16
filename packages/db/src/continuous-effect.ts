import {z} from 'zod';
import type {ProfileExecutor} from './profile-context.js';
import {continuousAuthorizationSchema,type ContinuousAuthorization} from '../../contracts/src/continuous-authorization.js';
import {ContinuousStoreError} from './continuous-authorization.js';

const id=z.uuid().transform(value=>value.toLowerCase());
type Environment='REAL'|'SIMULATION';
/** Internal read port for the final emission transaction. Holding the returned
 * state is not permission to emit later: the caller must retain this transaction
 * and also validate current recipient, quota, identity and emission ownership.
 */
export async function readContinuousEffectAuthority(db:ProfileExecutor,environment:Environment,effectId:string):Promise<
 {state:'EXPIRED';reason:'EFFECT_EXPIRED'}|{state:'AUTHORITY_READ';authorization:ContinuousAuthorization}
>{
 effectId=id.parse(effectId);z.enum(['REAL','SIMULATION']).parse(environment);
 if(!db.workspaceId)throw new ContinuousStoreError('CONTINUITY_PROFILE_CONTEXT_REQUIRED',403);
 const role=(await db.query('SELECT current_user AS role')).rows[0]?.role;
 if(role!=='commerce_channel')throw new ContinuousStoreError('CONTINUITY_EMITTER_ROLE_REQUIRED',403);
 const effect=(await db.query(`SELECT account_id,kind,continuous_authorization_id,authorization_id,
  expires_at<=clock_timestamp() AS expired FROM outbox WHERE workspace_id=$1 AND environment=$2 AND id=$3 FOR UPDATE`,
  [db.workspaceId,environment,effectId])).rows[0];
 if(!effect)throw new ContinuousStoreError('CONTINUITY_EFFECT_NOT_FOUND',404);
 if(effect.expired===true)return{state:'EXPIRED',reason:'EFFECT_EXPIRED'};
 if(effect.expired!==false||effect.authorization_id!==null||!id.safeParse(effect.continuous_authorization_id).success)
  throw new ContinuousStoreError('CONTINUITY_EFFECT_AUTHORITY_REQUIRED');
 const row=(await db.query(`SELECT state FROM continuous_authorizations WHERE workspace_id=$1 AND environment=$2 AND id=$3 FOR SHARE`,
  [db.workspaceId,environment,effect.continuous_authorization_id])).rows[0];
 const parsed=continuousAuthorizationSchema.safeParse(row?.state);
 if(!parsed.success||parsed.data.workspaceId!==db.workspaceId||parsed.data.environment!==environment
  ||parsed.data.id!==effect.continuous_authorization_id||parsed.data.accountId!==effect.account_id
  ||(parsed.data.source.kind==='VERIFIED_QR_CONNECTION')!==(effect.kind==='warmup'))
  throw new ContinuousStoreError('CONTINUITY_EFFECT_SCOPE_CHANGED');
 return{state:'AUTHORITY_READ',authorization:parsed.data};
}
