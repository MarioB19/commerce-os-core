import type {Pool} from 'pg';
import {z} from 'zod';
import {profileIdSchema} from '../../contracts/src/profiles.js';
import {withPrivacyReferenceFence} from './privacy-reference-fence.js';
import {privateFileCandidatesSchema,type PrivateFileCandidatePort,type PrivateFileCaptureRequest} from './privacy-file-capture.js';
const requestSchema=z.strictObject({jobId:z.uuid(),workspaceId:profileIdSchema});
/** Native host bridge for036 capture. Fresh035+030 fences and short RR SQL on
 * every load; there is no filesystem I/O in that transaction. The reader derives
 * its opaque-pass identity from038's stored batch. Its production EXECUTE grant
 * is deliberately absent until the complete private assembler is adopted. */
export function createNativePrivateFileCandidatePort(pool:Pick<Pool,'connect'>):PrivateFileCandidatePort{
 return Object.freeze({async load(raw:PrivateFileCaptureRequest){
  const request=requestSchema.parse(raw);
  return withPrivacyReferenceFence(pool,request.workspaceId,async(c,leases)=>{
   await c.query('SET LOCAL ROLE commerce_privacy_job_worker');
   const rows=(await c.query('SELECT read_privacy_asset_candidates($1,$2,$3) receipt',[request.jobId,leases.profile,leases.references])).rows;
   if(rows.length!==1)throw Error('PRIVACY_NATIVE_CANDIDATE_REQUIRED');
   const value=privateFileCandidatesSchema.parse(rows[0].receipt);
   if(value.job_id!==request.jobId||value.workspace_id!==request.workspaceId)throw Error('PRIVACY_NATIVE_CANDIDATE_BINDING');
   return value;
  });
 }});
}
