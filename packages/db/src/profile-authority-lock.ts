import type {ProfileExecutor} from './profile-context.js';
import type {ProfileAction} from '../../domain/src/core/profile-authorization.js';

const administrativeScopes=new Set<ProfileAction['scope']>(['employees:write','tokens:write','profile:write']);
export function changesProfileAuthority(action:Omit<ProfileAction,'workspaceId'>){return administrativeScopes.has(action.scope);}
export class ProfileAuthorityBusyError extends Error {
 readonly code='PROFILE_AUTHORITY_BUSY';
 readonly statusCode=409;
 constructor(){super('PROFILE_AUTHORITY_BUSY');this.name='ProfileAuthorityBusyError';}
}
/** Same transaction, before any authority row lock. The action is a server
 * constant, never an input flag. No waiting/retry while retaining another
 * person's credential or membership locks. Hash collisions only reduce liveness.
 */
export async function lockProfileAuthorityChange(db:ProfileExecutor,action:Omit<ProfileAction,'workspaceId'>){
 if(!changesProfileAuthority(action))return;
 if(!action.mutation)throw new Error('PROFILE_ADMINISTRATIVE_ACTION_INVALID');
 const row=(await db.query("SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('commerce.profile.authority.v1:' || $1,0)) AS locked",[db.workspaceId])).rows[0];
 if(row?.locked!==true)throw new ProfileAuthorityBusyError();
}
