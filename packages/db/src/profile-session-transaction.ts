import {changesProfileAuthority,lockProfileAuthorityChange} from './profile-authority-lock.js';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from './profile-context.js';
import {resolveSessionProfile,type InteractiveSession,type ProfileFence,type SessionProfile} from './profile-session.js';
import {authorizeProfileAction,type ProfileAction} from '../../domain/src/core/profile-authorization.js';

/** The server supplies the session and action; the request only supplies its
 * previously observed fence. A fence is never sufficient membership proof.
 * Keep external effects out of work: locks and expiry remain held until commit.
 */
export async function withProfileSessionTransaction<T>(
 pool:ProfilePool,session:InteractiveSession,fence:ProfileFence,
 action:Omit<ProfileAction,'workspaceId'>,
 work:(db:ProfileExecutor,profile:SessionProfile)=>Promise<T>,
):Promise<T>{
 return withProfileTransaction(pool,fence.workspaceId,async db=>{
  if(changesProfileAuthority(action)){
   // Unlocked preauthorization prevents a foreign/stale fence from probing
   // another profile's administrative activity. Locked authority below remains
   // definitive after acquiring the administrative fence.
   const before=await resolveSessionProfile(db,session,fence);
   authorizeProfileAction(before.authority,{...action,workspaceId:before.profile.id});
   await lockProfileAuthorityChange(db,action);
  }
  const profile=await resolveSessionProfile(db,session,fence,{lock:true});
  const boundAction={...action,workspaceId:profile.profile.id};
  authorizeProfileAction(profile.authority,boundAction);
  const result=await work(db,profile);
  // PostgreSQL clock_timestamp is checked again after the SQL work. This also
  // rejects a callback that modified its own authority inside this transaction.
  const final=await resolveSessionProfile(db,session,fence,{lock:true});
  authorizeProfileAction(final.authority,boundAction);
  return result;
 });
}
