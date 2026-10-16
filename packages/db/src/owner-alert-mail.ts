import {createCipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from './profile-context.js';
import {profileIdSchema} from '../../contracts/src/profiles.js';
import {mailEnvelopeSchema,mailProviderResultSchema,ownerAlertMailLeaseSchema,ownerAlertMailPayloadSchema,type InvitationMailTransport,type OwnerAlertMailPayload} from '../../contracts/src/profile-invitation-mail.js';

/** V7 RF-07.e: the owner's e-mail for a number incident and its recovery. The
 * same reserve → claim → one POST → finish sequence, envelope and transport as
 * invitations (profile-invitation-mail.ts). Nothing names a customer or phone. */
const digest=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
export function sealOwnerAlertMail(payload:OwnerAlertMailPayload,key:Uint8Array){
 const v=ownerAlertMailPayloadSchema.parse(payload);if(key.byteLength!==32)fail('MAIL_KEY_INVALID');
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
 cipher.setAAD(Buffer.from('commerce-mail-v1:'+v.budget_reservation_id));
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify(v),'utf8'),cipher.final(),cipher.getAuthTag()]);
 const body=Buffer.from(JSON.stringify(mailEnvelopeSchema.parse({schema_version:1,attempt_id:v.budget_reservation_id,nonce:nonce.toString('base64url'),ciphertext:ciphertext.toString('base64url')})));
 if(body.length>16384)fail('MAIL_BODY_BOUND');return body;
}
async function one(db:ProfileExecutor,sql:string,args:unknown[]){const rows=(await db.query(sql,args)).rows;if(rows.length!==1||!rows[0]?.value)fail('MAIL_WRITE_UNCONFIRMED');return rows[0].value;}
const finalSchema=z.object({attemptId:z.uuidv4(),state:z.enum(['ACCEPTED','REJECTED','UNCERTAIN']),deliveryProven:z.literal(false),reservationRefunded:z.literal(false)}).strict();
export type OwnerAlertMailResult=z.infer<typeof finalSchema>|{state:'SKIPPED';reason:string};
export async function dispatchOwnerAlertMail(pool:ProfilePool,input:{workspaceId:string;jobId:string},ports:{key:Uint8Array;transport:InvitationMailTransport;now?:()=>Date}):Promise<OwnerAlertMailResult>{
 const workspaceId=profileIdSchema.parse(input.workspaceId),jobId=z.uuid().parse(input.jobId),attemptId=randomUUID(),clock=ports.now??(()=>new Date());
 if(ports.key.byteLength!==32)fail('MAIL_KEY_INVALID');
 const reserved=await withProfileTransaction(pool,workspaceId,db=>one(db,'SELECT public.reserve_owner_alert_mail($1,$2,$3) AS value',[workspaceId,jobId,attemptId]));
 if(reserved&&typeof reserved==='object'&&'skipped' in reserved)return{state:'SKIPPED',reason:String((reserved as {skipped:unknown}).skipped)};
 const lease=ownerAlertMailLeaseSchema.parse(reserved);
 if(lease.workspaceId!==workspaceId||lease.jobId!==jobId||lease.attemptId!==attemptId||Date.parse(lease.authorizedUntil)!==Date.parse(lease.dispatchedAt)+120000)fail('MAIL_RESERVATION_CHANGED');
 const body=sealOwnerAlertMail({schema_version:1,event_id:jobId,workspace_id:workspaceId,entity_id:lease.alertId,entity_version:lease.event==='OPENED'?1:2,template:'owner-alert-v1',
  recipient:lease.recipient,recipient_hmac:lease.recipientDigest,alert_kind:lease.alertKind,alert_event:lease.event,dispatched_at:new Date(lease.dispatchedAt).toISOString(),authorized_until:new Date(lease.authorizedUntil).toISOString(),budget_reservation_id:attemptId},ports.key);
 const bodySha=digest(body);let state:'ACCEPTED'|'REJECTED'|'UNCERTAIN'='UNCERTAIN';
 try{
  const claim=await withProfileTransaction(pool,workspaceId,db=>one(db,'SELECT public.claim_owner_alert_mail($1,$2,$3) AS value',[workspaceId,attemptId,bodySha]));
  const v=z.object({attemptId:z.uuidv4(),state:z.literal('SENDING'),bodySha256:z.string(),authorizedUntil:z.string()}).strict().parse(claim);
  if(v.attemptId!==attemptId||v.bodySha256!==bodySha)fail('MAIL_SEND_CLAIM_CHANGED');
  let sent=false;
  const fence=()=>{const now=clock().getTime();if(sent||!Number.isFinite(now)||now<Date.parse(lease.dispatchedAt)||now>=Date.parse(lease.authorizedUntil)||digest(body)!==bodySha)fail('MAIL_SEND_FENCE');sent=true;};
  const native=mailProviderResultSchema.parse(await ports.transport.send(body,fence));
  if(!sent||native.attempt_id!==attemptId)fail('MAIL_PROVIDER_RESULT_CHANGED');
  state=native.state==='UNKNOWN'?'UNCERTAIN':native.state;
 }catch{/* No recipient/provider details escape. No retry or new lease. */}
 finally{body.fill(0);}
 try{const value=await withProfileTransaction(pool,workspaceId,db=>one(db,'SELECT public.finish_owner_alert_mail($1,$2,$3) AS value',[workspaceId,attemptId,state]));
  const final=finalSchema.parse(value);if(final.attemptId!==attemptId||final.state!==state)fail('MAIL_RESULT_UNCONFIRMED');return final;}
 catch{return{attemptId,state:'UNCERTAIN',deliveryProven:false,reservationRefunded:false};}
}
