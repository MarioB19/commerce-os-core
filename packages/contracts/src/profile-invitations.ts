import {z} from 'zod';
import {profileRoleSchema} from './profiles.js';
import {mailRecipientSchema} from './profile-invitation-mail.js';
export const invitationEmailSchema=z.string().trim().toLowerCase().pipe(z.email().max(254)).pipe(mailRecipientSchema);
export const invitationCreateSchema=z.object({operationId:z.uuid(),email:invitationEmailSchema,role:profileRoleSchema}).strict();
export const invitationCancelSchema=z.object({expectedVersion:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict();
export const invitationListQuerySchema=z.object({afterId:z.uuid().optional()}).strict();
export const invitationResultSchema=z.object({id:z.uuid(),role:profileRoleSchema,version:z.number().int().positive(),status:z.enum(['PENDING','ACCEPTED','CANCELLED','EXPIRED']),delivery:z.enum(['QUEUED','SENDING','ACCEPTED','REJECTED','UNCERTAIN']),expiresAt:z.iso.datetime({offset:true}).nullable()}).strict();
export type InvitationResult=z.infer<typeof invitationResultSchema>;
export const invitationListedSchema=invitationResultSchema.extend({email:invitationEmailSchema}).strict();
export const invitationPageSchema=z.object({data:z.array(invitationListedSchema).max(100),nextAfterId:z.uuid().nullable()}).strict().superRefine((value,ctx)=>{
 if(new Set(value.data.map(row=>row.id)).size!==value.data.length||value.data.some((row,i)=>i>0&&row.id<=value.data[i-1].id)||
  (value.nextAfterId!==null&&(value.data.length!==100||value.nextAfterId!==value.data[99]?.id)))ctx.addIssue({code:'custom',message:'INVITATION_PAGE_INVALID'});
});
export type InvitationPage=z.infer<typeof invitationPageSchema>;
export type InvitationListed=z.infer<typeof invitationListedSchema>;
