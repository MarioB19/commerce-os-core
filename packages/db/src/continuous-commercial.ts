import {z} from 'zod';
import type {ProfileExecutor} from './profile-context.js';
import {ContinuousStoreError} from './continuous-authorization.js';
import {continuousAuthorizationSchema,type ContinuousAuthorization} from '../../contracts/src/continuous-authorization.js';
import type {DomainRecord} from '../../contracts/src/index.js';

type Environment='REAL'|'SIMULATION';
export interface CommercialContinuityOrigin{assignmentId:string;assignmentRevision:number;bindingId:string;accountId:string;productId:string}
const originSchema=z.object({assignmentId:z.uuid(),assignmentRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
 bindingId:z.uuid(),accountId:z.uuid(),productId:z.uuid()}).strict();
/** Locks the live profile without giving workers a global profiles table read. */
export async function lockedContinuousWorkerProfile(db:ProfileExecutor){
 if(!db.workspaceId)throw new ContinuousStoreError('CONTINUITY_PROFILE_CONTEXT_REQUIRED',403);
 const scope=(await db.query("SELECT current_user AS role,current_setting('app.workspace_id',true) AS workspace")).rows[0];
 if(!['commerce_automation','commerce_channel'].includes(scope?.role)||scope?.workspace!==db.workspaceId)
  throw new ContinuousStoreError('CONTINUITY_WORKER_CONTEXT_REQUIRED',403);
 const profile=(await db.query('SELECT * FROM read_locked_continuous_worker_profile()')).rows[0];
 if(profile?.id!==db.workspaceId||profile.state!=='ACTIVE')throw new ContinuousStoreError('CONTINUITY_PROFILE_SUSPENDED',403);
 if(!Number.isInteger(profile.version)||profile.version<1||typeof profile.timezone!=='string')throw new ContinuousStoreError('CONTINUITY_PROFILE_FACT_INVALID');
 try{new Intl.DateTimeFormat('en',{timeZone:profile.timezone});}catch{throw new ContinuousStoreError('CONTINUITY_PROFILE_FACT_INVALID');}
 return profile as {id:string;state:'ACTIVE';version:number;timezone:string};
}
/** Proposal read only. The final emission gate re-reads the effect's immutable
 * reference; a newly created grant never replaces authority on an older effect.
 */
export async function readCommercialContinuity(db:ProfileExecutor,environment:Environment,input:CommercialContinuityOrigin){
 const origin=originSchema.parse(input);z.enum(['REAL','SIMULATION']).parse(environment);
 await lockedContinuousWorkerProfile(db);
 const assignment=(await db.query(`SELECT a.id,a.revision,a.binding_id,a.account_id,a.product_id FROM commercial_assignments a
  JOIN records b ON b.id=a.binding_id AND b.workspace_id=a.workspace_id AND b.environment=a.environment AND b.kind='binding'
  WHERE a.workspace_id=$1 AND a.environment=$2 AND a.id=$3 AND a.state='ACTIVE'
   AND (b.body->>'valid_from')::timestamptz<=clock_timestamp()
   AND (b.body->>'valid_to' IS NULL OR (b.body->>'valid_to')::timestamptz>clock_timestamp()) FOR SHARE OF a,b`,
 [db.workspaceId,environment,origin.assignmentId])).rows[0];
 if(!assignment||assignment.revision!==origin.assignmentRevision||assignment.binding_id!==origin.bindingId
  ||assignment.account_id!==origin.accountId||assignment.product_id!==origin.productId)return undefined;
 const row=(await db.query(`SELECT state FROM continuous_authorizations WHERE workspace_id=$1 AND environment=$2
  AND account_id=$3 AND assignment_id=$4 AND state->'source'->>'assignmentRevision'=$5::text AND binding_id=$6 FOR SHARE`,
 [db.workspaceId,environment,origin.accountId,origin.assignmentId,origin.assignmentRevision,origin.bindingId])).rows[0];
 if(!row)return undefined;
 const state=continuousAuthorizationSchema.parse(row.state);
 const blocked=commercialContinuityAuthorityBlock(state,db.workspaceId,environment,origin);
 // Pauses/protections preserve intent. Only the emission gate consumes their
 // readiness; a revoked or mismatched origin cannot approve a new proposal.
 return blocked&&blocked!=='CONTINUITY_HUMAN_PAUSED'&&blocked!=='CONTINUITY_PROTECTED'?undefined:state;
}
/** Does not assert transport, quota, consent or lease readiness. */
export function commercialContinuityAuthorityBlock(state:ContinuousAuthorization,workspace:string,environment:Environment,origin:CommercialContinuityOrigin):string|undefined{
 const s=continuousAuthorizationSchema.parse(state);
 if(s.workspaceId!==workspace||s.environment!==environment||s.accountId!==origin.accountId||s.source.kind!=='COMMERCIAL_ASSIGNMENT'
  ||s.source.assignmentId!==origin.assignmentId||s.source.assignmentRevision!==origin.assignmentRevision||s.source.bindingId!==origin.bindingId)
  return 'CONTINUITY_ASSIGNMENT_CHANGED';
 if(s.revokedAt)return 'CONTINUITY_REVOKED';
 if(s.humanPaused)return 'CONTINUITY_HUMAN_PAUSED';
 if(s.protections.length)return 'CONTINUITY_PROTECTED';
 return undefined;
}
/** Inbound timestamps must be persisted and credible. Existing inbound history
 * is not invalidated merely because V7 installed a new permanent grant.
 */
export function continuousInboundRecipient(conversation:DomainRecord,contact:DomainRecord,now:Date,allowConsentedTemplate=false):boolean{
 if(conversation.kind!=='conversation'||contact.kind!=='contact'||conversation.workspace_id!==contact.workspace_id
  ||conversation.environment!==contact.environment||conversation.body.contact_id!==contact.id||contact.body.status==='SUPPRESSED'
  ||contact.body.consent?.revoked_at!=null)return false;
 const at=now.getTime(),created=Date.parse(String(conversation.created_at)),started=Date.parse(String(conversation.body.started_at??'')),last=Date.parse(String(conversation.body.last_inbound_at??''));
 if(![at,created,started,last].every(Number.isFinite)||created>at||started>at||last<started||last>at)return false;
 if(at-last<86400000)return true;
 const consent=contact.body.consent,observed=Date.parse(String(consent?.observed_at??''));
 return allowConsentedTemplate&&!!consent?.evidence&&!!consent?.source&&['messages','marketing'].includes(consent?.purpose)
  &&Number.isFinite(observed)&&observed<=at&&consent.revoked_at==null;
}
