import {z} from 'zod';
import {personalProfileScopeSchema,profileIdSchema} from './profiles.js';
export const profileTokenIdSchema=z.uuid().transform(value=>value.toLowerCase());
const environment=z.enum(['REAL','SIMULATION']);
const version=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reason=z.string().trim().min(8).max(1000);
const scopes=z.array(personalProfileScopeSchema).min(1).max(61).refine(values=>new Set(values).size===values.length).transform(values=>[...values].sort());
const environments=z.array(environment).min(1).max(2).refine(values=>new Set(values).size===values.length).transform(values=>[...values].sort());
const grant={name:z.string().trim().min(1).max(100),allowedEnvironments:environments,scopes,expiresAt:z.iso.datetime({offset:true}).transform(value=>new Date(value).toISOString())};
const common={operationId:profileTokenIdSchema,environment:environment.default('REAL'),reason};
export const profileTokenCommandSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('create'),...common,...grant}).strict(),
 z.object({action:z.literal('rotate'),...common,...grant,tokenId:profileTokenIdSchema,expectedVersion:version}).strict(),
 z.object({action:z.literal('revoke'),...common,tokenId:profileTokenIdSchema,expectedVersion:version}).strict(),
]);
export type ProfileTokenCommand=z.infer<typeof profileTokenCommandSchema>;
export const profileTokenListSchema=z.object({environment:environment.default('REAL'),limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).max(10000).default(0)}).strict();
export const profileTokenMetadataSchema=z.object({id:profileTokenIdSchema,userId:profileIdSchema,name:z.string().min(1).max(100),allowedEnvironments:environments,scopes:scopes.nullable(),expiresAt:z.iso.datetime(),revokedAt:z.iso.datetime().nullable(),version,createdAt:z.iso.datetime()}).strict();
export const profileTokenOperationSchema=z.object({id:profileTokenIdSchema,action:z.enum(['create','rotate','revoke']),tokenId:profileTokenIdSchema,tokenVersion:version,replacedTokenId:profileTokenIdSchema.nullable(),createdAt:z.iso.datetime()}).strict();
export const profileTokenMutationResultSchema=z.object({operation:profileTokenOperationSchema,token:z.string().regex(/^cos_pat_[A-Za-z0-9_-]{43}$/).nullable(),secretDelivered:z.boolean()}).strict().superRefine((v,c)=>{
 if(v.secretDelivered!==(v.token!==null)||v.operation.action==='revoke'&&v.secretDelivered)c.addIssue({code:'custom',message:'Secret delivery must match the operation.'});
});
export type ProfileTokenMetadata=z.infer<typeof profileTokenMetadataSchema>;
export type ProfileTokenOperation=z.infer<typeof profileTokenOperationSchema>;
