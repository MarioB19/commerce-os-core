import {z} from 'zod';
import {profileIdSchema} from './profiles.js';
const instant=z.iso.datetime({offset:true});
const sha=z.string().regex(/^[a-f0-9]{64}$/);
export const privacyRetentionPolicySchema=z.object({
 version:z.literal('v7-d18-1'),
 commercial_days:z.literal(180),test_days:z.literal(30),log_days:z.literal(90),financial_years:z.literal(5),
}).strict();
export const privacyRetentionPolicy=privacyRetentionPolicySchema.parse({version:'v7-d18-1',commercial_days:180,test_days:30,log_days:90,financial_years:5});
/** Trusted DB observations, never a request body or permissions granted by a model. */
export const privacyErasureEvidenceSchema=z.object({
 workspace_id:profileIdSchema,environment:z.literal('REAL'),journey_id:z.uuid(),
 execution_kind:z.enum(['COMMERCIAL','TEST']),
 source_version:z.number().int().positive(),source_sha256:sha,
 observed_at:instant,closed_at:instant.nullable(),closure_verified:z.boolean(),
 profile_active:z.boolean(),owner_active:z.boolean(),owner_version:z.number().int().positive(),
 expected_owner_version:z.number().int().positive(),
 legal_hold:z.boolean(),active_obligation:z.boolean(),
 pending_effects:z.number().int().nonnegative(),pending_commands:z.number().int().nonnegative(),
 pending_timers:z.number().int().nonnegative(),unsettled_ai:z.number().int().nonnegative(),
 complete_reference_inventory:z.boolean(),unclassified_references:z.number().int().nonnegative(),
 source_last_changed_at:instant,
 projection:z.object({phase:z.enum(['PENDING','READY']),source_version:z.number().int().positive(),source_sha256:sha,verified:z.boolean(),generation:z.string().regex(/^[1-9]\d*$/)}).strict(),
 backup:z.object({workspace_id:profileIdSchema,environment:z.literal('REAL'),receipt_id:z.uuid(),snapshot_at:instant,verified_at:instant,restore_verified:z.boolean(),sha256:sha}).strict().nullable(),
}).strict();
export type PrivacyErasureEvidence=z.infer<typeof privacyErasureEvidenceSchema>;
