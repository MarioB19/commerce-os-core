import {z} from 'zod';
import {profileIdSchema} from './profiles.js';
const uuid=z.uuidv4();
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const mailRecipientSchema=z.string().max(254).regex(/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/).refine(v=>{const local=v.split('@')[0]!;return !local.startsWith('.')&&!local.endsWith('.')&&!local.includes('..');});
export const mailPayloadSchema=z.object({schema_version:z.literal(1),event_id:uuid,workspace_id:profileIdSchema,entity_id:uuid,entity_version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),template:z.literal('profile-invitation-v1'),recipient:mailRecipientSchema,recipient_hmac:digest,link_token:z.string().regex(/^cos_inv_[A-Za-z0-9_-]{43}$/),dispatched_at:z.iso.datetime(),link_expires_at:z.iso.datetime(),authorized_until:z.iso.datetime(),budget_reservation_id:uuid}).strict().superRefine((v,ctx)=>{
 const start=Date.parse(v.dispatched_at),end=Date.parse(v.authorized_until);
 if(end<=start||end>start+120000||Date.parse(v.link_expires_at)!==start+86400000)ctx.addIssue({code:'custom',message:'MAIL_LEASE_TIME_INVALID'});
});
export const mailEnvelopeSchema=z.object({schema_version:z.literal(1),attempt_id:uuid,nonce:z.string().regex(/^[A-Za-z0-9_-]{16}$/),ciphertext:z.string().regex(/^[A-Za-z0-9_-]+$/).max(32000)}).strict();
export const mailProviderResultSchema=z.object({attempt_id:uuid,state:z.enum(['ACCEPTED','REJECTED','UNKNOWN']),delivery_proven:z.literal(false)}).strict();
export const invitationMailLeaseSchema=z.object({attemptId:uuid,workspaceId:profileIdSchema,jobId:uuid,invitationId:uuid,invitationVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),recipientCiphertext:z.string().min(1).max(4096),recipientDigest:digest,dispatchedAt:z.iso.datetime({offset:true}),authorizedUntil:z.iso.datetime({offset:true}),linkExpiresAt:z.iso.datetime({offset:true}),reservedMicroUsd:z.literal(15467),budgetMonths:z.array(z.string().regex(/^\d{4}-\d{2}$/)).min(1).max(2)}).strict();
export type MailPayload=z.infer<typeof mailPayloadSchema>;
export type InvitationMailLease=z.infer<typeof invitationMailLeaseSchema>;
export interface InvitationMailTransport {
 /** Fixed, trusted transport: one bounded POST; invoke beforeSend immediately
  * after credentials/local work and before its wire call. Never retry. */
 send(envelope:Uint8Array,beforeSend:()=>void):Promise<unknown>;
}
