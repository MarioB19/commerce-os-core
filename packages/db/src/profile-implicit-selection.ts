import type {ProfilePool} from './profile-context.js';
import type {QueryExecutor} from './index.js';
import {ProfileSessionError,type InteractiveSession,type ProfileFence} from './profile-session.js';
import {listProfileChoicesFromSession,selectProfileFromSession} from './profile-identity-bootstrap.js';

/** Fence for an interactive request that did not send profile headers.
 * Exactly one active membership is unambiguous: its existing selection is
 * reused, otherwise it is selected through the closed CAS port and the
 * automatic selection is audited in the same transaction. With two or more
 * memberships the client must send the fence it observed (409 otherwise);
 * the server never chooses "the first" profile. */
export async function resolveImplicitSessionFence(pool:ProfilePool&QueryExecutor,session:InteractiveSession,correlation:string):Promise<ProfileFence>{
 try{return await implicitFence(pool,session,correlation);}
 catch(error){
  // A concurrent request of the same session may have made the automatic
  // selection first; its committed CAS result is re-read once, never forced.
  if(error instanceof ProfileSessionError&&error.code==='PROFILE_SELECTION_CHANGED')return implicitFence(pool,session,correlation,false);
  throw error;
 }
}
async function implicitFence(pool:ProfilePool&QueryExecutor,session:InteractiveSession,correlation:string,select=true):Promise<ProfileFence>{
 const choices=await listProfileChoicesFromSession(pool,session);
 if(choices.length===0)throw new ProfileSessionError('PROFILE_MEMBERSHIP_REQUIRED',403);
 if(choices.length>1)throw new ProfileSessionError('PROFILE_REQUEST_FENCE_REQUIRED',409);
 const only=choices[0]!;
 if(only.selected&&only.selection_version!==null)return{workspaceId:only.id,version:only.selection_version};
 if(!select)throw new ProfileSessionError('PROFILE_SELECTION_CHANGED');
 const c=await pool.connect();let begun=false,discard:Error|undefined;
 try{
  await c.query('BEGIN');begun=true;
  const fence=await selectProfileFromSession(c,session,only.id,only.selection_version??0);
  await c.query('INSERT INTO identity_audit(event_type,outcome,correlation_id,user_id,actor_id) VALUES($1,$2,$3,$4,$4)',
   ['profile.selection.automatic','SUCCEEDED',correlation,session.userId]);
  const committed=await c.query('COMMIT');begun=false;
  if(committed.command!=='COMMIT')throw new ProfileSessionError('PROFILE_SELECTION_CHANGED');
  return fence;
 }catch(error){
  if(begun){try{await c.query('ROLLBACK');}catch{discard=new Error('PROFILE_SELECTION_ROLLBACK_FAILED');}}
  throw error;
 }finally{c.release(discard);}
}
