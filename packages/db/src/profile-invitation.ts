import {z} from 'zod';
import {appendEvent,encrypt,decrypt,uuid} from './index.js';
import {identityDigest} from './identity.js';
import type {ProfileExecutor} from './profile-context.js';
import {invitationCreateSchema,invitationEmailSchema,invitationResultSchema} from '../../contracts/src/profile-invitations.js';
import {createInvitation,invitationPublicState} from '../../domain/src/core/profile-invitation.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../domain/src/core/profile-authorization.js';

function fail(code:string,statusCode=409):never{throw Object.assign(new Error(code),{code,statusCode});}
function authorized(db:ProfileExecutor,authority:ProfileAuthority,mutation:boolean){authorizeProfileAction(authority,{workspaceId:db.workspaceId,scope:mutation?'employees:write':'employees:read',mutation});}
const custodySchema=z.object({scope:z.literal('profile.invitation.recipient.v1'),workspaceId:z.string(),invitationId:z.uuid(),email:invitationEmailSchema}).strict();
export function invitationRecipientDigest(workspaceId:string,email:string){return identityDigest('profile-invitation-recipient',JSON.stringify([workspaceId,invitationEmailSchema.parse(email)]));}
function present(row:any){
 const expiresAt=row.expires_at instanceof Date?row.expires_at.toISOString():row.expires_at??null;
 if(expiresAt!==null&&(!(row.native_now instanceof Date)||!Number.isFinite(row.native_now.getTime())))fail('INVITATION_DATABASE_CLOCK_REQUIRED',503);
 const status=row.status==='PENDING'&&expiresAt!==null&&row.native_now.getTime()>=Date.parse(expiresAt)?'EXPIRED':row.status;
 return invitationResultSchema.parse({id:row.id,role:row.role,version:row.version,status,delivery:row.delivery,expiresAt});
}
export function readInvitationRecipient(row:{id:string;workspace_id:string;recipient_ciphertext:string;recipient_digest:string}){
 const value=custodySchema.parse(JSON.parse(decrypt(row.recipient_ciphertext)));
 if(value.workspaceId!==row.workspace_id||value.invitationId!==row.id||invitationRecipientDigest(row.workspace_id,value.email)!==row.recipient_digest)fail('INVITATION_RECIPIENT_CUSTODY_INVALID',503);
 return value.email;
}
/** Runs inside withProfileRequest's administrative transaction. Its final
 * native authority/expiry check and COMMIT precede every returned response.
 * Nothing in this module dispatches or starts a link lifetime.
 */
export async function queueProfileInvitation(db:ProfileExecutor,authority:ProfileAuthority,raw:unknown,correlation:string){
 authorized(db,authority,true);const input=invitationCreateSchema.parse(raw),actor=authority.membership.userId;
 const requestDigest=identityDigest('profile-invitation-request',JSON.stringify([db.workspaceId,actor,input.email,input.role]));
 const previous=(await db.query('SELECT *,clock_timestamp() AS native_now FROM profile_invitations WHERE workspace_id=$1 AND operation_id=$2 FOR UPDATE',[db.workspaceId,input.operationId])).rows[0];
 if(previous){if(previous.request_digest!==requestDigest)fail('INVITATION_OPERATION_CONTENT_CHANGED');return{...present(previous),created:false};}
 const recipientDigest=invitationRecipientDigest(db.workspaceId,input.email);
 if((await db.query("SELECT 1 FROM profile_invitations WHERE workspace_id=$1 AND recipient_digest=$2 AND status='PENDING'",[db.workspaceId,recipientDigest])).rowCount)fail('INVITATION_ALREADY_PENDING');
 const time=(await db.query('SELECT clock_timestamp() AS now')).rows[0]?.now;
 if(!(time instanceof Date)||!Number.isFinite(time.getTime()))fail('INVITATION_DATABASE_CLOCK_REQUIRED',503);
 const row=createInvitation({id:uuid(),workspaceId:db.workspaceId,role:input.role,recipientDigest},authority.profile.state,time);
 const ciphertext=encrypt({scope:'profile.invitation.recipient.v1',workspaceId:db.workspaceId,invitationId:row.id,email:input.email});
 const saved=(await db.query('INSERT INTO profile_invitations(id,workspace_id,operation_id,requested_by,role,recipient_digest,recipient_ciphertext,request_digest,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[row.id,db.workspaceId,input.operationId,actor,row.role,recipientDigest,ciphertext,requestDigest,time])).rows[0];
 if(!saved||saved.id!==row.id||saved.workspace_id!==db.workspaceId||saved.request_digest!==requestDigest||saved.role!==row.role||saved.version!==1||saved.status!=='PENDING'||saved.delivery!=='QUEUED'||readInvitationRecipient(saved)!==input.email)fail('INVITATION_WRITE_UNCONFIRMED');
 const job=await db.query("INSERT INTO profile_invitation_mail_jobs(id,workspace_id,invitation_id,invitation_version,template,created_at) VALUES($1,$2,$3,1,'profile-invitation-v1',$4) RETURNING id",[uuid(),db.workspaceId,row.id,time]);
 if(job.rows.length!==1)fail('INVITATION_MAIL_QUEUE_UNCONFIRMED');
 await appendEvent(db,{workspace_id:db.workspaceId,environment:'REAL',event_type:'profile.invitation.queued',aggregate_id:row.id,correlation_id:correlation,actor:{type:authority.credential.kind==='session'?'human':'personal_api',id:actor},payload:{role:row.role,version:1}});
 return{...invitationPublicState(row,time),created:true};
}
export async function listProfileInvitations(db:ProfileExecutor,authority:ProfileAuthority,afterId?:string){
 authorized(db,authority,false);if(afterId!==undefined)z.uuid().parse(afterId);
 const rows=(await db.query('SELECT *,clock_timestamp() AS native_now FROM profile_invitations WHERE workspace_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 101',[db.workspaceId,afterId??null])).rows;
 return{data:rows.slice(0,100).map(row=>({...present(row),email:readInvitationRecipient(row)})),nextAfterId:rows.length>100?rows[99].id:null};
}
export async function findProfileInvitationOperation(db:ProfileExecutor,authority:ProfileAuthority,operationId:string){
 authorized(db,authority,false);z.uuid().parse(operationId);
 const row=(await db.query('SELECT *,clock_timestamp() AS native_now FROM profile_invitations WHERE workspace_id=$1 AND operation_id=$2',[db.workspaceId,operationId])).rows[0];
 if(!row)fail('INVITATION_OPERATION_NOT_FOUND',404);
 return{...present(row),email:readInvitationRecipient(row)};
}
export async function cancelProfileInvitation(db:ProfileExecutor,authority:ProfileAuthority,id:string,expectedVersion:number,correlation:string){
 authorized(db,authority,true);z.uuid().parse(id);z.number().int().positive().parse(expectedVersion);
 const row=(await db.query('SELECT * FROM profile_invitations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[db.workspaceId,id])).rows[0];
 if(!row)fail('INVITATION_NOT_FOUND',404);
 if(row.version!==expectedVersion||row.status!=='PENDING')fail('INVITATION_VERSION_OR_STATE_CHANGED');
 const saved=(await db.query("UPDATE profile_invitations SET status='CANCELLED',version=version+1 WHERE workspace_id=$1 AND id=$2 AND version=$3 AND status='PENDING' RETURNING *,clock_timestamp() AS native_now",[db.workspaceId,id,expectedVersion])).rows[0];
 if(!saved||saved.id!==id||saved.status!=='CANCELLED'||saved.version!==expectedVersion+1)fail('INVITATION_CANCEL_UNCONFIRMED');
 await appendEvent(db,{workspace_id:db.workspaceId,environment:'REAL',event_type:'profile.invitation.cancelled',aggregate_id:id,correlation_id:correlation,actor:{type:authority.credential.kind==='session'?'human':'personal_api',id:authority.membership.userId},payload:{version:saved.version}});
 return present(saved);
}
