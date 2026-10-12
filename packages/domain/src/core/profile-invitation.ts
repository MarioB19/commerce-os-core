import {z} from 'zod';
import {profileIdSchema,profileRoleSchema,profileStateSchema,type ProfileState} from '../../../contracts/src/profiles.js';

const version=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const instant=z.iso.datetime({offset:true});
export const invitationSchema=z.object({
 id:z.uuid(),workspaceId:profileIdSchema,role:profileRoleSchema,version,
 recipientDigest:digest,status:z.enum(['PENDING','ACCEPTED','CANCELLED']),
 delivery:z.enum(['QUEUED','SENDING','ACCEPTED','REJECTED','UNCERTAIN']),
 attemptId:z.uuid().nullable(),linkDigest:digest.nullable(),
 createdAt:instant,dispatchedAt:instant.nullable(),expiresAt:instant.nullable(),
 acceptedUserId:profileIdSchema.nullable(),
}).strict();
export type ProfileInvitation=z.infer<typeof invitationSchema>;
export const invitationLinkLifetimeSeconds=24*60*60;
export class ProfileInvitationError extends Error{
 constructor(readonly code:string){super(code);this.name='ProfileInvitationError';}
}
function need(v:unknown,code:string):asserts v{if(!v)throw new ProfileInvitationError(code);}
function at(now:Date){need(now instanceof Date&&Number.isFinite(now.getTime()),'INVITATION_CLOCK_INVALID');return now.getTime();}
function checked(value:ProfileInvitation,now:Date){
 const row=invitationSchema.parse(value),moment=at(now),created=Date.parse(row.createdAt);
 need(created<=moment,'INVITATION_FUTURE_STATE');
 if(row.delivery==='QUEUED')need(row.attemptId===null&&row.linkDigest===null&&row.dispatchedAt===null&&row.expiresAt===null,'INVITATION_DELIVERY_STATE_INVALID');
 else{
  need(row.attemptId!==null&&row.linkDigest!==null&&row.dispatchedAt!==null&&row.expiresAt!==null,'INVITATION_DELIVERY_STATE_INVALID');
  const dispatched=Date.parse(row.dispatchedAt),expires=Date.parse(row.expiresAt);
  need(created<=dispatched&&dispatched<=moment&&expires-dispatched===invitationLinkLifetimeSeconds*1000,'INVITATION_DELIVERY_CLOCK_INVALID');
 }
 need((row.status==='ACCEPTED')===(row.acceptedUserId!==null),'INVITATION_ACCEPTANCE_STATE_INVALID');
 return row;
}
function active(state:ProfileState){need(profileStateSchema.parse(state)==='ACTIVE','INVITATION_PROFILE_SUSPENDED');}
function expected(row:ProfileInvitation,n:number){need(version.safeParse(n).success&&row.version===n,'INVITATION_VERSION_CONFLICT');}
function pending(row:ProfileInvitation){need(row.status==='PENDING','INVITATION_NOT_PENDING');}
function next(row:ProfileInvitation){need(row.version<Number.MAX_SAFE_INTEGER,'INVITATION_VERSION_EXHAUSTED');return row.version+1;}

/** Pure transitions. The caller must persist the complete result with its audit
 * and outbox in one versioned transaction. No transition performs an effect or
 * authorizes a caller; authentication, membership and the clock are rechecked by
 * the database adapter before COMMIT and again before dispatch.
 */
export function createInvitation(input:{id:string;workspaceId:string;role:ProfileInvitation['role'];recipientDigest:string},state:ProfileState,now:Date):ProfileInvitation{
 active(state);at(now);
 return checked({...input,version:1,status:'PENDING',delivery:'QUEUED',attemptId:null,linkDigest:null,createdAt:now.toISOString(),dispatchedAt:null,expiresAt:null,acceptedUserId:null},now);
}
export function beginInvitationDelivery(value:ProfileInvitation,input:{expectedVersion:number;attemptId:string;linkDigest:string},state:ProfileState,now:Date):ProfileInvitation{
 const row=checked(value,now);active(state);expected(row,input.expectedVersion);pending(row);
 need(row.delivery==='QUEUED','INVITATION_DISPATCH_ALREADY_ATTEMPTED');
 need(z.uuid().safeParse(input.attemptId).success&&digest.safeParse(input.linkDigest).success,'INVITATION_DISPATCH_INPUT_INVALID');
 return checked({...row,delivery:'SENDING',attemptId:input.attemptId,linkDigest:input.linkDigest,dispatchedAt:now.toISOString(),expiresAt:new Date(at(now)+invitationLinkLifetimeSeconds*1000).toISOString()},now);
}
export function finishInvitationDelivery(value:ProfileInvitation,input:{expectedVersion:number;attemptId:string;outcome:'ACCEPTED'|'REJECTED'|'UNCERTAIN'},now:Date):ProfileInvitation{
 const row=checked(value,now);expected(row,input.expectedVersion);
 need(z.enum(['ACCEPTED','REJECTED','UNCERTAIN']).safeParse(input.outcome).success&&row.attemptId===input.attemptId,'INVITATION_DELIVERY_RESULT_INVALID');
 // A native readback of the same terminal is idempotent. Contradictory late
 // results cannot silently replace UNKNOWN or a confirmed result.
 if(row.delivery===input.outcome)return row;
 need(row.delivery==='SENDING','INVITATION_DELIVERY_RESULT_CONFLICT');
 return checked({...row,delivery:input.outcome},now);
}
export function replaceInvitationDelivery(value:ProfileInvitation,expectedVersion:number,state:ProfileState,now:Date):ProfileInvitation{
 const row=checked(value,now);active(state);expected(row,expectedVersion);pending(row);
 need(!['QUEUED','SENDING'].includes(row.delivery),'INVITATION_DELIVERY_IN_PROGRESS');
 need(at(now)-Date.parse(row.dispatchedAt!)>=60_000,'INVITATION_RESEND_TOO_SOON');
 return checked({...row,version:next(row),delivery:'QUEUED',attemptId:null,linkDigest:null,dispatchedAt:null,expiresAt:null},now);
}
export function cancelInvitation(value:ProfileInvitation,expectedVersion:number,now:Date):ProfileInvitation{
 const row=checked(value,now);expected(row,expectedVersion);pending(row);
 // Invalidates a potentially delivered link. The outstanding delivery result
 // can still be recorded, but it cannot make this invitation usable again.
 return checked({...row,version:next(row),status:'CANCELLED'},now);
}
export function acceptInvitation(value:ProfileInvitation,input:{expectedVersion:number;linkDigest:string;recipientDigest:string;verifiedUserId:string;verifiedEmail:boolean;existingMembership:boolean},state:ProfileState,now:Date):ProfileInvitation{
 const row=checked(value,now);active(state);expected(row,input.expectedVersion);pending(row);
 need(input.verifiedEmail===true&&profileIdSchema.safeParse(input.verifiedUserId).success,'INVITATION_VERIFIED_IDENTITY_REQUIRED');
 need(input.existingMembership===false,'INVITATION_MEMBERSHIP_ALREADY_EXISTS');
 need(digest.safeParse(input.recipientDigest).success&&input.recipientDigest===row.recipientDigest,'INVITATION_RECIPIENT_MISMATCH');
 need(digest.safeParse(input.linkDigest).success&&row.linkDigest===input.linkDigest&&row.expiresAt!==null&&at(now)<Date.parse(row.expiresAt),'INVITATION_LINK_INVALID_OR_EXPIRED');
 need(['SENDING','ACCEPTED','UNCERTAIN'].includes(row.delivery),'INVITATION_LINK_NOT_DISPATCHED');
 return checked({...row,status:'ACCEPTED',version:next(row),acceptedUserId:input.verifiedUserId},now);
}

/** Minimal owner-facing state. Email is retrieved separately from encrypted
 * custody; digests, attempt identity and recipient user identity stay internal.
 */
export function invitationPublicState(value:ProfileInvitation,now:Date){
 const row=checked(value,now);
 const status=row.status==='PENDING'&&row.expiresAt!==null&&at(now)>=Date.parse(row.expiresAt)?'EXPIRED':row.status;
 return {id:row.id,role:row.role,version:row.version,status,delivery:row.delivery,expiresAt:row.expiresAt};
}
