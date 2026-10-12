import {z} from 'zod';
import type {ProfileExecutor} from './profile-context.js';
import {profileIdSchema} from '../../contracts/src/profiles.js';
const uuid=z.uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
const request=z.strictObject({jobId:uuid,retentionId:uuid,leaseId:uuid});
const base=z.strictObject({schema_version:z.literal(1),batch_id:uuid,job_id:uuid,workspace_id:profileIdSchema,environment:z.literal('REAL'),journey_id:uuid,
 manifest_sha256:sha,records:z.int().min(1).max(10000),versions:z.int().min(1).max(10000),erasure_authorized:z.literal(false)});
const prepared=base.extend({status:z.literal('PREPARED')});
const applied=base.extend({status:z.enum(['MINIMIZED','NO_EFFECT'])});
async function query(db:ProfileExecutor,sql:string,args:string[]){const r=await db.query(sql,args);if(r.rows.length!==1||!Object.hasOwn(r.rows[0],'receipt'))throw Error('PRIVACY_RECORD_RECEIPT_REQUIRED');return r.rows[0].receipt;}
function checked<T extends z.infer<typeof base>>(db:ProfileExecutor,jobId:string,result:T){if(result.workspace_id!==db.workspaceId||result.batch_id!==jobId||result.job_id!==jobId||result.versions<result.records)throw Error('PRIVACY_RECORD_RECEIPT_BINDING');return result;}
/** Closed SQL preparation only. Requires native031 job +030 RR fenced executor.
 * No caller-provided source hashes, bodies, dates or authority flags are accepted. */
export async function preparePrivacyRecordMinimization(db:ProfileExecutor,input:z.input<typeof request>){
 const v=request.parse(input);return checked(db,v.jobId,prepared.parse(await query(db,'SELECT prepare_privacy_record_minimization($1,$2,$3) receipt',[v.jobId,v.retentionId,v.leaseId])));
}
/** Closed primitive, NOT the final erasure entry point. Its native admission is
 * absent until the reviewed assembler checks files/copies/aggregates in the same
 * transaction. No retries and no pool/transaction creation are hidden here. */
export async function applyPrivacyRecordMinimization(db:ProfileExecutor,input:{batchId:string;leaseId:string}){
 const v=z.strictObject({batchId:uuid,leaseId:uuid}).parse(input);return checked(db,v.batchId,applied.parse(await query(db,'SELECT apply_privacy_record_minimization($1,$2) receipt',[v.batchId,v.leaseId])));
}
