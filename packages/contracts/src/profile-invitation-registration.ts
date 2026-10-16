import {z} from 'zod';
import {invitationLinkTokenSchema} from './profile-invitation-acceptance.js';
export const invitationRegistrationSchema=z.object({token:invitationLinkTokenSchema,email:z.email().max(320).transform(value=>value.trim().toLowerCase()),name:z.string().trim().min(1).max(120).refine(value=>!value.includes('\0')),password:z.string().min(12).max(128)}).strict();
export type InvitationRegistrationInput=z.infer<typeof invitationRegistrationSchema>;
export const invitationRegistrationResultSchema=z.object({registered:z.literal(true),loginRequired:z.literal(true)}).strict();
export type InvitationRegistrationResult=z.infer<typeof invitationRegistrationResultSchema>;
