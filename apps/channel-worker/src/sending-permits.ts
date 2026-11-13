import {withProfileTransaction,type ProfilePool} from '../../../packages/db/src/profile-context.js';
import {adoptionCandidates,establishSendingPermit} from '../../../packages/db/src/sending-permit.js';

/** V7.5.2 N01: human assignments that were already in force when the permit
 * transition was introduced get their operational permit once, here, with the
 * same rules as the human act (live commercial authorization of an ACTIVE
 * assignment; nothing else is lifted). One transaction per number; a failure
 * defers that number to the next pass and is reported by code. Persistence
 * only: no message, command, QR or provider call. */
export async function adoptAssignmentSendingPermits(pool:ProfilePool,workspaceId:string,limit=20){
 const candidates=await withProfileTransaction(pool,workspaceId,async db=>{
  if((await db.query('SELECT current_user AS role')).rows[0]?.role!=='commerce_channel')throw Object.assign(Error('SENDING_PERMIT_INTERNAL_ROLE_REQUIRED'),{code:'SENDING_PERMIT_INTERNAL_ROLE_REQUIRED'});
  return adoptionCandidates(db,workspaceId,limit);
 });
 const result={observed:candidates.length,adopted:0,deferred:0,failures:[] as string[],externalEffects:0 as const};
 for(const accountId of candidates){
  try{
   const outcome=await withProfileTransaction(pool,workspaceId,db=>establishSendingPermit(db,'REAL',workspaceId,accountId,{source:'ASSIGNMENT_ADOPTION',actorId:null}));
   if(outcome.state==='ESTABLISHED')result.adopted++;
  }catch(error){
   const code=(error as {code?:string;message?:string})?.code??(error as Error)?.message;
   result.deferred++;result.failures.push(typeof code==='string'&&/^[A-Z0-9_]+$/.test(code)?code:'SENDING_PERMIT_TRANSACTION_UNCONFIRMED');
  }
 }
 return result;
}
