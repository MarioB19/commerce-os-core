import {z} from 'zod';
import type {ProfileExecutor} from './profile-context.js';
import {profileIdSchema} from '../../contracts/src/profiles.js';
import {privateFileCandidatesSchema} from './privacy-file-capture.js';
const uuid=z.uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
const preparation=z.strictObject({jobId:uuid,opaquePassId:uuid,profileLeaseId:uuid,referenceLeaseId:uuid});
const application=z.strictObject({batchId:uuid,profileLeaseId:uuid,referenceLeaseId:uuid});
const applied=z.strictObject({schema_version:z.literal(1),status:z.enum(['MINIMIZED','NO_EFFECT']),batch_id:uuid,job_id:uuid,workspace_id:profileIdSchema,environment:z.literal('REAL'),journey_id:uuid,manifest_sha256:sha,file_manifest_sha256:sha,assets:z.int().min(0).max(1000),versions:z.int().min(0).max(10000),files:z.int().min(0).max(1000),erasure_authorized:z.literal(false)});
async function receipt(db:ProfileExecutor,sql:string,args:string[]){const r=await db.query(sql,args);if(r.rows.length!==1||!Object.hasOwn(r.rows[0],'receipt'))throw Error('PRIVACY_ASSET_RECEIPT_REQUIRED');return r.rows[0].receipt;}
/** Private native preparation. The caller supplies identities/leases only.
 * Files, references, current/history hashes and restored-row pins come from SQL.
 * No pool, hidden transaction, retries, filesystem effects or runtime adoption. */
export async function preparePrivacyAssetMinimization(db:ProfileExecutor,request:z.input<typeof preparation>){
 const q=preparation.parse(request);
 const native=privateFileCandidatesSchema.parse(await receipt(db,'SELECT prepare_privacy_asset_minimization($1,$2,$3,$4) receipt',[q.jobId,q.opaquePassId,q.profileLeaseId,q.referenceLeaseId]));
 if(native.workspace_id!==db.workspaceId||native.job_id!==q.jobId)throw Error('PRIVACY_ASSET_RECEIPT_BINDING');
 return native;
}
/** Admission is private to the future reviewed assembler, same backend/TX and
 * both native fences. This primitive alone cannot complete an erasure job. */
export async function applyPrivacyAssetMinimization(db:ProfileExecutor,request:z.input<typeof application>){
 const q=application.parse(request);
 const native=applied.parse(await receipt(db,'SELECT apply_privacy_asset_minimization($1,$2,$3) receipt',[q.batchId,q.profileLeaseId,q.referenceLeaseId]));
 if(native.workspace_id!==db.workspaceId||native.batch_id!==q.batchId||native.job_id!==q.batchId||native.files>native.assets||native.versions<native.assets||(native.assets===0&&native.versions!==0))throw Error('PRIVACY_ASSET_RECEIPT_BINDING');
 return native;
}
