import {z} from 'zod';
import {profileIdSchema} from './profiles.js';

const uuid=z.uuid().transform(value=>value.toLowerCase());
const version=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp=z.string().datetime({offset:true});
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const protectionReasons=['CHANNEL_DOWN','AI_UNAVAILABLE','QUOTA_EXHAUSTED','IDENTITY_CHANGED','SEND_UNCERTAIN','PROFILE_SUSPENDED'] as const;
export const protectionReasonSchema=z.enum(protectionReasons);
export const continuousSourceSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('COMMERCIAL_ASSIGNMENT'),assignmentId:uuid,assignmentRevision:version,bindingId:uuid}).strict(),
 z.object({kind:z.literal('VERIFIED_QR_CONNECTION'),connectionId:uuid,identityFingerprint:digest}).strict(),
]);
export const continuousProtectionSchema=z.object({reason:protectionReasonSchema,incidentId:uuid,observedAt:timestamp,evidenceSha256:digest}).strict();
export const continuousAuthorizationSchema=z.object({
 id:uuid,workspaceId:profileIdSchema,environment:z.enum(['REAL','SIMULATION']),accountId:uuid,
 source:continuousSourceSchema,createdBy:profileIdSchema,createdAt:timestamp,version,
 humanPaused:z.boolean(),revokedAt:timestamp.nullable(),
 protections:z.array(continuousProtectionSchema).max(protectionReasons.length),
}).strict().superRefine((value,ctx)=>{
 if(new Set(value.protections.map(item=>item.reason)).size!==value.protections.length)
  ctx.addIssue({code:'custom',message:'Cada causa de protección aparece una sola vez.'});
 if(value.revokedAt&&Date.parse(value.revokedAt)<Date.parse(value.createdAt))
  ctx.addIssue({code:'custom',message:'La revocación no precede a la autorización.'});
});
export const continuousHumanCommandSchema=z.object({operationId:uuid,expectedVersion:version,action:z.enum(['pause','resume','revoke'])}).strict();
export const assertProtectionSchema=continuousProtectionSchema.extend({operationId:uuid,expectedVersion:version}).strict();
export const clearProtectionSchema=z.object({operationId:uuid,expectedVersion:version,reason:protectionReasonSchema,
 incidentId:uuid,observedAt:timestamp,evidenceSha256:digest,recovery:z.enum(['HEALTH_OBSERVED','EFFECT_RECONCILED'])}).strict();
export const commercialContinuityIssueSchema=z.object({operationId:uuid,assignmentId:uuid,expectedRevision:version}).strict();
export const continuityEnvironmentSchema=z.object({environment:z.enum(['REAL','SIMULATION']).default('REAL')}).strict();
export const continuityListSchema=continuityEnvironmentSchema.extend({accountId:uuid.optional(),afterId:uuid.optional(),
 limit:z.coerce.number().int().min(1).max(100).default(50)}).strict();
export const continuityHumanBodySchema=continuousHumanCommandSchema.extend({environment:z.enum(['REAL','SIMULATION']).default('REAL')}).strict();
export const continuityCommercialBodySchema=commercialContinuityIssueSchema.extend({environment:z.enum(['REAL','SIMULATION']).default('REAL')}).strict();
export type ContinuousAuthorization=z.infer<typeof continuousAuthorizationSchema>;
export type ContinuousSource=z.infer<typeof continuousSourceSchema>;
export type ContinuousProtection=z.infer<typeof continuousProtectionSchema>;
export type ContinuousHumanCommand=z.infer<typeof continuousHumanCommandSchema>;
export type AssertProtection=z.infer<typeof assertProtectionSchema>;
export type ClearProtection=z.infer<typeof clearProtectionSchema>;
export type ProtectionReason=z.infer<typeof protectionReasonSchema>;
