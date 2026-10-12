import {z} from 'zod';
import {marketScopeSchema,marketLocaleSchema,marketVersionRefSchema} from './market-variants.js';
const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text=z.string().max(500);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const t=Date.parse(v+'T00:00:00Z');return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===v;});
const instant=z.string().datetime({offset:true});
const reference=z.object({required:z.boolean(),match:z.enum(['PRESENT','EXACT','CONTAINS'])}).strict();
export const receiptPolicySchema=z.object({
 automaticApproval:z.boolean(),failureDisposition:z.enum(['REVIEW','REJECT']),minimumConfidenceBps:z.number().int().min(0).max(10000),
 amount:z.discriminatedUnion('mode',[
  z.object({mode:z.literal('EXACT')}).strict(),z.object({mode:z.literal('MINIMUM')}).strict(),
  z.object({mode:z.literal('TOLERANCE'),toleranceMinor:integer}).strict(),
 ]),
 destination:z.discriminatedUnion('mode',[
  z.object({mode:z.literal('DISABLED')}).strict(),z.object({mode:z.literal('EXACT')}).strict(),
  z.object({mode:z.literal('SUFFIX'),digits:z.number().int().min(4).max(18)}).strict(),
 ]),
 beneficiary:z.object({required:z.boolean()}).strict(),
 date:z.object({required:z.boolean(),maximumAgeDays:z.number().int().min(0).max(365),maximumFutureDays:z.number().int().min(0).max(1)}).strict(),
 reference,concept:reference,
}).strict();
export const receiptPolicyOverrideSchema=receiptPolicySchema.partial().strict();
export const receiptPolicyVersionSchema=z.object({scope:marketScopeSchema,ref:marketVersionRefSchema,policy:receiptPolicySchema}).strict();
export const receiptPolicyOverrideVersionSchema=z.object({scope:marketScopeSchema,variantId:z.string().uuid().toLowerCase(),ref:marketVersionRefSchema,override:receiptPolicyOverrideSchema}).strict();
export const resolvedReceiptPolicySchema=z.object({schemaVersion:z.literal(1),scope:marketScopeSchema,variantId:z.string().uuid().toLowerCase(),
 profile:marketVersionRefSchema,variant:marketVersionRefSchema.nullable(),policy:receiptPolicySchema,sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const receiptEvidenceSchema=z.object({
 isReceipt:z.boolean(),amountMinor:integer.nullable(),currency:z.string().regex(/^[A-Z]{3}$/).nullable(),
 destination:text.nullable(),beneficiary:text.nullable(),paidAt:instant.nullable(),paidOn:date.nullable(),
 reference:text.nullable(),concept:text.nullable(),status:z.enum(['COMPLETED','PENDING','FAILED','UNKNOWN']),
 confidenceBps:z.number().int().min(0).max(10000),contradictions:z.array(z.string().min(1).max(200)).max(30),
}).strict().refine(v=>!(v.paidAt&&v.paidOn),'La fecha no puede declarar dos fuentes distintas.');
export const receiptPolicyContextSchema=z.object({scope:marketScopeSchema,variantId:z.string().uuid().toLowerCase(),
 receipt:marketVersionRefSchema,evidenceSha256:z.string().regex(/^[a-f0-9]{64}$/),collection:marketVersionRefSchema.nullable(),
 amountMinor:integer,currency:marketLocaleSchema.shape.currency,timezone:marketLocaleSchema.shape.timezone,observedAt:instant,
 expectedDestination:text.nullable(),expectedBeneficiary:text.nullable(),expectedReference:text.nullable(),expectedConcept:text.nullable(),
 duplicate:z.boolean(),classification:z.enum(['COMMERCIAL','TEST','FALSE']),
}).strict().refine(v=>!(v.expectedDestination||v.expectedBeneficiary)||v.collection!==null,'El destino requiere una versión de cobro autenticada.');
export type ReceiptPolicy=z.infer<typeof receiptPolicySchema>;
export type ReceiptPolicyOverride=z.infer<typeof receiptPolicyOverrideSchema>;
export type ReceiptEvidence=z.infer<typeof receiptEvidenceSchema>;
export type ReceiptPolicyContext=z.infer<typeof receiptPolicyContextSchema>;
