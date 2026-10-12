import {z} from 'zod';
import {marketLocaleSchema,marketConfigurationSchema,marketCopyReviewFields} from './market-variants.js';
const id=z.string().uuid().transform(value=>value.toLowerCase()),version=z.number().int().positive().max(2147483646);
export const marketEnvironmentSchema=z.enum(['REAL','SIMULATION']);
export const marketIdSchema=z.object({id}).strict();
export const marketQuerySchema=z.object({environment:marketEnvironmentSchema}).strict();
export const marketVariantListSchema=z.object({environment:marketEnvironmentSchema,family_id:id,
 limit:z.coerce.number().int().min(1).max(100).default(25),after:id.optional()}).strict();
export const marketOperationHeaderSchema=z.string().uuid().transform(value=>value.toLowerCase());
export const marketDraftFieldsSchema=z.object({locale:marketLocaleSchema,
 amount_minor:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),configuration:marketConfigurationSchema}).strict();
export const marketDraftCreateSchema=z.object({family_id:id,fields:marketDraftFieldsSchema}).strict();
export const marketDraftReplaceSchema=z.object({expected_version:version,fields:marketDraftFieldsSchema}).strict();
export const marketPublishSchema=z.object({expected_version:version,draft_sha256:z.string().regex(/^[a-f0-9]{64}$/),
 reviewed_fields:z.array(z.enum(marketCopyReviewFields)).length(marketCopyReviewFields.length)
 .refine(values=>new Set(values).size===marketCopyReviewFields.length)}).strict();
export const marketFamilyCreateSchema=z.object({product_id:id,expected_product_version:version}).strict();
export const marketCopySchema=z.object({source_release_id:id,locale:marketLocaleSchema}).strict();
export type MarketDraftFields=z.infer<typeof marketDraftFieldsSchema>;
export type MarketEnvironment=z.infer<typeof marketEnvironmentSchema>;
