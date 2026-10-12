import {z} from 'zod';
import type {ProfileExecutor} from './profile-context.js';
import {collectResultProjection,reconcileResultProjectionSnapshot} from './result-projection-worker.js';
import {resultSourceDigest,sealResultProjection,verifyResultProjectionRebuild} from './result-projections.js';
const uuid=z.uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
const input=z.strictObject({jobId:uuid,leaseId:uuid});
const context=z.strictObject({job_id:uuid,workspace_id:z.string().min(1),journey_id:uuid,source_version:z.int().positive(),source_sha256:sha,manifest_sha256:sha,financial_context:z.boolean(),sources:z.array(z.strictObject({kind:z.enum(['COHORT','FINANCIAL','AI']),source_id:uuid,required:z.boolean()})).max(10002)});
const preservation=z.strictObject({job_id:uuid,lease_id:uuid,manifest_sha256:sha,before_sha256:sha,financial_context:z.boolean(),sealed:z.int().min(0)});
/** Caller owns one RR transaction and030's session lease. This port has no
 * callback, COMMIT, network or record mutation. Final erasure must compare the
 * complete projection again before its own COMMIT. */
export async function preservePrivacyResults(db:ProfileExecutor,request:z.input<typeof input>){
 const q=input.parse(request);
 await db.query('SET LOCAL ROLE commerce_privacy_job_worker');
 const rows=(await db.query('SELECT privacy_result_context($1,$2) receipt',[q.jobId,q.leaseId])).rows;
 if(rows.length!==1)throw Error('PRIVACY_RESULT_CONTEXT_MISSING');
 const native=context.parse(rows[0].receipt);
 if(native.job_id!==q.jobId||native.workspace_id!==db.workspaceId)throw Error('PRIVACY_RESULT_CONTEXT_CHANGED');
 if(new Set(native.sources.map(s=>s.kind+':'+s.source_id)).size!==native.sources.length)throw Error('PRIVACY_RESULT_DUPLICATE_SOURCE');
 await db.query('SET LOCAL ROLE commerce_results');
 await collectResultProjection(db);
 const before=await verifyResultProjectionRebuild(db);
 await db.query('SET LOCAL ROLE commerce_privacy_job_worker');
 const started=(await db.query('SELECT begin_privacy_result_preservation($1,$2) receipt',[q.jobId,q.leaseId])).rows;
 const start=z.strictObject({status:z.literal('PREPARED'),job_id:uuid,manifest_sha256:sha}).parse(started.length===1?started[0].receipt:null);
 if(start.job_id!==q.jobId||start.manifest_sha256!==native.manifest_sha256)throw Error('PRIVACY_RESULT_START_CHANGED');
 await db.query('SET LOCAL ROLE commerce_results');
 let sealed=0;
 if(native.financial_context){
  const capture=(await db.query('SELECT capture_result_financial_context($1,$2) receipt',[native.journey_id,native.source_version])).rows;
  const value=z.strictObject({status:z.enum(['CAPTURED','NO_EFFECT']),source_version:z.int().positive(),source_hash:sha}).parse(capture.length===1?capture[0].receipt:null);
  if(value.source_version!==native.source_version||value.source_hash!==native.source_sha256)throw Error('PRIVACY_RESULT_CUSTODY_CHANGED');
 }else for(const source of native.sources){
  const projection=(await db.query("SELECT revision::text,fingerprint FROM result_projection_sources WHERE workspace_id=$1 AND environment='REAL' AND kind=$2 AND source_digest=$3",[db.workspaceId,source.kind,resultSourceDigest(db.workspaceId,source.kind,source.source_id)])).rows;
  if(projection.length===0&&!source.required)continue;
  if(projection.length!==1)throw Error('PRIVACY_RESULT_SOURCE_MISSING');
  const p=z.strictObject({revision:z.string().regex(/^[1-9]\d{0,18}$/),fingerprint:sha}).parse(projection[0]);
  await sealResultProjection(db,{kind:source.kind,source_id:source.source_id,...p});sealed++;
 }
 if((await verifyResultProjectionRebuild(db)).fingerprint!==before.fingerprint)throw Error('PRIVACY_RESULT_SEAL_DIFFERENCE');
 await db.query('SET LOCAL ROLE commerce_privacy_job_worker');
 const proof=(await db.query('SELECT confirm_privacy_result_seals($1,$2) receipt',[q.jobId,q.leaseId])).rows;
 const confirmed=z.strictObject({status:z.literal('PRESERVED'),job_id:uuid,manifest_sha256:sha,financial_context:z.boolean(),sealed:z.int().min(0)}).parse(proof.length===1?proof[0].receipt:null);
 if(confirmed.job_id!==q.jobId||confirmed.manifest_sha256!==native.manifest_sha256||confirmed.financial_context!==native.financial_context||confirmed.sealed!==sealed)throw Error('PRIVACY_RESULT_CONFIRMATION_CHANGED');
 return Object.freeze({job_id:q.jobId,lease_id:q.leaseId,manifest_sha256:native.manifest_sha256,before_sha256:before.fingerprint,financial_context:native.financial_context,sealed});
}
/** The expected fingerprint comes from preservePrivacyResults in the same
 * transaction, never from a public request. It is not authorization to erase. */
export async function verifyPrivacyResultsAfterErasure(db:ProfileExecutor,expected:z.input<typeof preservation>){
 const proof=preservation.parse(expected),before=proof.before_sha256;await db.query('SET LOCAL ROLE commerce_results');
 await reconcileResultProjectionSnapshot(db);const after=await verifyResultProjectionRebuild(db);
 if(after.fingerprint!==before)throw Error('PRIVACY_RESULT_ERASURE_DIFFERENCE');
 await db.query('SET LOCAL ROLE commerce_privacy_job_worker');
 const rows=(await db.query('SELECT finish_privacy_result_preservation($1,$2) receipt',[proof.job_id,proof.lease_id])).rows;
 const done=z.strictObject({status:z.literal('READY'),job_id:uuid,manifest_sha256:sha,generation:z.string().regex(/^[1-9]\d{0,18}$/)}).parse(rows.length===1?rows[0].receipt:null);
 if(done.job_id!==proof.job_id||done.manifest_sha256!==proof.manifest_sha256)throw Error('PRIVACY_RESULT_READY_CHANGED');
 return{status:'UNCHANGED' as const,sha256:after.fingerprint,grains:after.grains};
}
