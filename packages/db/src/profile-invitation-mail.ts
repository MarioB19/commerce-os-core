import {createCipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from './profile-context.js';
import {generateInvitationLink} from './profile-invitation-acceptance.js';
import {readInvitationRecipient} from './profile-invitation.js';
import {profileIdSchema} from '../../contracts/src/profiles.js';
import {invitationMailLeaseSchema,mailEnvelopeSchema,mailPayloadSchema,mailProviderResultSchema,type InvitationMailTransport,type InvitationMailLease,type MailPayload} from '../../contracts/src/profile-invitation-mail.js';
const digest=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
function utc(value:string){return new Date(value).toISOString();}
export function invitationMailMonths(dispatchedAt:string,authorizedUntil:string){
 const start=new Date(dispatchedAt),end=new Date(Date.parse(authorizedUntil)+960000);
 if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||end.getTime()-start.getTime()!==1080000)fail('MAIL_LEASE_TIME_INVALID');
 const pacific=(at:Date)=>{const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit'}).formatToParts(at);return parts.find(p=>p.type==='year')!.value+'-'+parts.find(p=>p.type==='month')!.value;};
 return [...new Set([start.toISOString().slice(0,7),end.toISOString().slice(0,7),pacific(start),pacific(end)])].sort();
}
export function validateInvitationMailLease(input:unknown):InvitationMailLease{
 const v=invitationMailLeaseSchema.parse(input);
 if(Date.parse(v.authorizedUntil)!==Date.parse(v.dispatchedAt)+120000||Date.parse(v.linkExpiresAt)!==Date.parse(v.dispatchedAt)+86400000||JSON.stringify(v.budgetMonths)!==JSON.stringify(invitationMailMonths(v.dispatchedAt,v.authorizedUntil)))fail('MAIL_LEASE_TIME_INVALID');
 return v;
}
/** Same AES-GCM wire contract as gcp_mail_dispatch.seal; no URL or sender input. */
export function sealInvitationMail(payload:MailPayload,key:Uint8Array){
 const v=mailPayloadSchema.parse(payload);if(key.byteLength!==32)fail('MAIL_KEY_INVALID');
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
 cipher.setAAD(Buffer.from('commerce-mail-v1:'+v.budget_reservation_id));
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify(v),'utf8'),cipher.final(),cipher.getAuthTag()]);
 const body=Buffer.from(JSON.stringify(mailEnvelopeSchema.parse({schema_version:1,attempt_id:v.budget_reservation_id,nonce:nonce.toString('base64url'),ciphertext:ciphertext.toString('base64url')})));
 if(body.length>16384)fail('MAIL_BODY_BOUND');return body;
}
function payload(lease:InvitationMailLease,token:string):MailPayload{
 const recipient=readInvitationRecipient({id:lease.invitationId,workspace_id:lease.workspaceId,recipient_ciphertext:lease.recipientCiphertext,recipient_digest:lease.recipientDigest});
 return mailPayloadSchema.parse({schema_version:1,event_id:lease.jobId,workspace_id:lease.workspaceId,entity_id:lease.invitationId,entity_version:lease.invitationVersion,template:'profile-invitation-v1',recipient,recipient_hmac:lease.recipientDigest,link_token:token,dispatched_at:utc(lease.dispatchedAt),link_expires_at:utc(lease.linkExpiresAt),authorized_until:utc(lease.authorizedUntil),budget_reservation_id:lease.attemptId});
}
async function one(db:ProfileExecutor,sql:string,args:unknown[]){const rows=(await db.query(sql,args)).rows;if(rows.length!==1||!rows[0]?.value)fail('MAIL_WRITE_UNCONFIRMED');return rows[0].value;}
const finalSchema=z.object({attemptId:z.uuidv4(),state:z.enum(['ACCEPTED','REJECTED','UNCERTAIN']),deliveryProven:z.literal(false),reservationRefunded:z.literal(false)}).strict();
export type InvitationMailResult=z.infer<typeof finalSchema>;
async function finish(pool:ProfilePool,workspaceId:string,attemptId:string,state:InvitationMailResult['state']){
 const value=await withProfileTransaction(pool,workspaceId,db=>one(db,'SELECT public.finish_profile_invitation_mail($1,$2,$3) AS value',[workspaceId,attemptId,state]));
 const final=finalSchema.parse(value);if(final.attemptId!==attemptId||final.state!==state)fail('MAIL_RESULT_UNCONFIRMED');return final;
}
/** Dedicated worker pool/role, explicit persisted job. No discovery loop or
 * public handler. All key/transport ports are trusted deployment dependencies.
 * A failed/unknown COMMIT never permits a POST. The persisted job cannot replay.
 */
export async function dispatchProfileInvitationMail(pool:ProfilePool,input:{workspaceId:string;jobId:string},ports:{key:Uint8Array;transport:InvitationMailTransport;now?:()=>Date}):Promise<InvitationMailResult>{
 const workspaceId=profileIdSchema.parse(input.workspaceId),jobId=z.uuidv4().parse(input.jobId),attemptId=randomUUID(),link=generateInvitationLink(),clock=ports.now??(()=>new Date());
 if(ports.key.byteLength!==32)fail('MAIL_KEY_INVALID');
 const prepared=await withProfileTransaction(pool,workspaceId,async db=>{
  const lease=validateInvitationMailLease(await one(db,'SELECT public.reserve_profile_invitation_mail($1,$2,$3,$4) AS value',[workspaceId,jobId,attemptId,link.digest]));
  if(lease.workspaceId!==workspaceId||lease.jobId!==jobId||lease.attemptId!==attemptId)fail('MAIL_RESERVATION_CHANGED');
  return{lease,body:sealInvitationMail(payload(lease,link.token),ports.key)};
 });
 const {lease,body}=prepared,bodySha=digest(body);let state:InvitationMailResult['state']='UNCERTAIN';
 try{
  const claim=await withProfileTransaction(pool,workspaceId,db=>one(db,'SELECT public.claim_profile_invitation_mail($1,$2,$3) AS value',[workspaceId,attemptId,bodySha]));
  const v=z.object({attemptId:z.uuidv4(),state:z.literal('SENDING'),bodySha256:z.string(),authorizedUntil:z.string()}).strict().parse(claim);
  if(v.attemptId!==attemptId||v.bodySha256!==bodySha||Date.parse(v.authorizedUntil)!==Date.parse(lease.authorizedUntil))fail('MAIL_SEND_CLAIM_CHANGED');
  let sent=false;
  const fence=()=>{const now=clock().getTime();if(sent||!Number.isFinite(now)||now<Date.parse(lease.dispatchedAt)||now>=Date.parse(lease.authorizedUntil)||digest(body)!==bodySha)fail('MAIL_SEND_FENCE');sent=true;};
  // The trusted transport must call this after token acquisition, at the wire.
  const native=mailProviderResultSchema.parse(await ports.transport.send(body,fence));
  if(!sent||native.attempt_id!==attemptId)fail('MAIL_PROVIDER_RESULT_CHANGED');
  state=native.state==='UNKNOWN'?'UNCERTAIN':native.state;
 }catch{/* No token/recipient/provider details escape. No retry or new lease. */}
 finally{body.fill(0);}
 try{return await finish(pool,workspaceId,attemptId,state);}
 catch{return{attemptId,state:'UNCERTAIN',deliveryProven:false,reservationRefunded:false};}
}
export async function readProfileInvitationMail(pool:ProfilePool,workspace:string,job:string){
 const workspaceId=profileIdSchema.parse(workspace),jobId=z.uuidv4().parse(job);
 return withProfileTransaction(pool,workspaceId,async db=>{
  const rows=(await db.query('SELECT public.read_profile_invitation_mail($1,$2) AS value',[workspaceId,jobId])).rows;
  if(rows.length!==1)fail('MAIL_READ_UNCONFIRMED');
  const value=rows[0]?.value;if(value===null)return null;
  return z.object({attemptId:z.uuidv4(),state:z.enum(['RESERVED','SENDING','ACCEPTED','REJECTED','UNCERTAIN']),authorizedUntil:z.iso.datetime({offset:true}),reservedMicroUsd:z.literal(15467),budgetMonths:z.array(z.string().regex(/^\d{4}-\d{2}$/)).min(1).max(2),deliveryProven:z.literal(false),reservationRefunded:z.literal(false)}).strict().parse(value);
 });
}
