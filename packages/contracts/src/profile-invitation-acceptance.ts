import {z} from 'zod';
import {profileIdSchema} from './profiles.js';
export const invitationLinkTokenSchema=z.string().regex(/^cos_inv_[A-Za-z0-9_-]{43}$/);
export const invitationAcceptSchema=z.object({token:invitationLinkTokenSchema}).strict();
export const invitationAcceptResultSchema=z.object({workspaceId:profileIdSchema,invitationId:z.uuid(),accepted:z.literal(true),created:z.boolean()}).strict();
export type InvitationAcceptResult=z.infer<typeof invitationAcceptResultSchema>;
export const invitationAcceptanceStateSchema=z.object({workspaceId:profileIdSchema,invitationId:z.uuid(),state:z.enum(['PENDING','ACCEPTED'])}).strict();
export type InvitationAcceptanceState=z.infer<typeof invitationAcceptanceStateSchema>;
