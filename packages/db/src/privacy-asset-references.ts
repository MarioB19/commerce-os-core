import {z} from 'zod';
import type {ProfileExecutor} from './profile-context.js';
import {profileIdSchema} from '../../contracts/src/profiles.js';
const uuid=z.uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/),count=z.string().regex(/^(0|[1-9][0-9]*)$/).max(30);
const input=z.strictObject({recordBatchId:uuid,opaquePassId:uuid,profileLeaseId:uuid,referenceLeaseId:uuid});
const asset=z.strictObject({asset_id:uuid,source_sha256:sha,history:z.array(z.strictObject({version:z.int().positive(),fullrow_sha256:sha})).min(1).max(10000),reference_sha256:sha,classification:z.enum(['OWNED','SHARED','BLOCKED']),reason_code:z.enum(['ASSET_OTHER_SCOPE','EXCLUSIVE_OWNERSHIP','ASSET_HISTORY_OR_ADAPTER_UNRESOLVED','OPAQUE_REFERENCE_UNRESOLVED','OTHER_PURPOSE_REFERENCE'])});
const receipt=z.strictObject({schema_version:z.literal(1),workspace_id:profileIdSchema,environment:z.literal('REAL'),journey_id:uuid,record_batch_id:uuid,record_manifest_sha256:sha,opaque_pass_sha256:sha,reference_epoch:count,catalog_sha256:sha,reference_set_sha256:sha,coverage:z.strictObject({relations:z.int().positive(),rows_checked:count,relevant_rows:z.int().min(0).max(10000)}),assets:z.array(asset).max(1000),erasure_authorized:z.literal(false)});
/** Private closed reader under global035 EX and profile030 RR. No caller asset
 * list, no file I/O, no transaction/retry or mutation authority. Native SQL derives
 * source33 and pass35, rereads all scopes and binds all native row hashes. */
export async function readPrivacyAssetReferences(db:ProfileExecutor,request:z.input<typeof input>){
 const q=input.parse(request),r=await db.query('SELECT read_privacy_asset_references($1,$2,$3,$4) receipt',[q.recordBatchId,q.opaquePassId,q.profileLeaseId,q.referenceLeaseId]);
 if(r.rows.length!==1||!Object.hasOwn(r.rows[0],'receipt'))throw Error('PRIVACY_ASSET_RECEIPT_REQUIRED');
 const v=receipt.parse(r.rows[0].receipt);
 if(v.workspace_id!==db.workspaceId||v.record_batch_id!==q.recordBatchId||new Set(v.assets.map(a=>a.asset_id)).size!==v.assets.length||BigInt(v.coverage.rows_checked)<BigInt(v.coverage.relevant_rows))throw Error('PRIVACY_ASSET_RECEIPT_BINDING');
 let versions=0;for(const a of v.assets){versions+=a.history.length;if(a.history.some((h,i)=>h.version!==i+1))throw Error('PRIVACY_ASSET_HISTORY_BINDING');}
 if(versions>10000||Buffer.byteLength(JSON.stringify(v))>8_388_608)throw Error('PRIVACY_ASSET_RECEIPT_BOUND');
 return v;
}
