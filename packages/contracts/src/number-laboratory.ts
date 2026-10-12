import {z} from 'zod';
import {marketRouteCandidateSchema,marketVersionRefSchema} from './market-variants.js';
const id=z.string().uuid();
const revision=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const instant=z.string().datetime({offset:false}).refine(value=>Number.isFinite(Date.parse(value)));
const profile=z.string().min(1).max(256).refine(value=>!value.includes('\0'));
export const labScenarios=['happy','duplicate_receipt','opt_out','missing_collection','ai_failure','followup'] as const;
export const labSourceSchema=z.object({kind:z.enum(['category','product','offer','workflow','agent','bank_profile','asset','receipt_policy','binding','acquisition_campaign','ad_set','ad']),ref:marketVersionRefSchema}).strict();
/** Internal projection from the authorized snapshot reader, never HTTP authority. */
export const numberLabSnapshotSchema=z.object({schema_version:z.literal(1),workspace_id:profile,
 source_environment:z.literal('REAL'),account:marketVersionRefSchema,captured_at:instant,
 engine_sha256:sha,configuration_sha256:sha,ai_configuration_version:revision,
 candidates:z.array(marketRouteCandidateSchema).min(1).max(20),sources:z.array(labSourceSchema).min(1).max(300),
 tiers:z.array(z.object({variant_id:id,tier_ids:z.array(z.string().regex(/^[a-z0-9_-]{1,60}$/)).min(1).max(20)}).strict()).min(1).max(20)
}).strict();
export const numberLabStartSchema=z.object({operation_id:id,account_id:id,snapshot_sha256:sha,
 estimate_sha256:sha,mode:z.enum(['CHAT','AUTOMATIC'])}).strict();
export const numberLabActionSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('message'),text:z.string().trim().min(1).max(8000)}).strict(),
 z.object({type:z.literal('select_variant'),variant_id:id,origin:z.enum(['EXPLICIT','ADVERTISEMENT'])}).strict(),
 z.object({type:z.literal('advance'),hours:z.union([z.literal(2),z.literal(8),z.literal(24)])}).strict(),
 z.object({type:z.literal('receipt'),attachment_id:id}).strict(),
 z.object({type:z.literal('review_receipt'),receipt_id:id,decision:z.enum(['APPROVED','REJECTED']),reason:z.string().trim().min(1).max(500)}).strict(),
 z.object({type:z.literal('continue')}).strict(),
]);
export const numberLabOperationSchema=z.object({operation_id:id,expected_version:revision,action:numberLabActionSchema}).strict();
export const labCiphertextSchema=z.object({version:z.literal(1),iv:z.string().regex(/^[A-Za-z0-9+/]{16}$/),
 tag:z.string().regex(/^[A-Za-z0-9+/]{22}==$/),ciphertext:z.string().min(4).max(11184812).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict();
export type NumberLabSnapshot=z.infer<typeof numberLabSnapshotSchema>;
export type NumberLabOperation=z.infer<typeof numberLabOperationSchema>;
export type NumberLabAction=z.infer<typeof numberLabActionSchema>;
