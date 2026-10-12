import {z} from 'zod';
import type {Pool} from 'pg';
import {withPrivacyWriterFence} from './privacy-writer-fence.js';
import {profileIdSchema} from '../../contracts/src/profiles.js';
/** Trusted installer only, after inventory prepare and before its access seal. */
export const PRIVACY_JOB_INVENTORY_BINDING_SQL='GRANT EXECUTE ON FUNCTION public.privacy_reference_inventory(uuid,integer) TO commerce_privacy_job_owner;';
const input=z.strictObject({workspaceId:profileIdSchema,jobId:z.uuid(),journeyId:z.uuid(),sourceVersion:z.int().min(1).max(2147483647),backupId:z.uuid()});
const receipt=z.strictObject({status:z.enum(['INVENTORIED','NO_EFFECT']),job_id:z.uuid(),manifest_sha256:z.string().regex(/^[a-f0-9]{64}$/),erasure_authorized:z.literal(false)});
/** Private job worker. This is a read-only preparation of source content:
 * no purge or filesystem authority is returned by this port. */
export async function preparePrivacyJob(pool:Pick<Pool,'connect'>,request:z.input<typeof input>){
 const data=input.parse(request);
 return withPrivacyWriterFence(pool,data.workspaceId,async(db,lease)=>{
  await db.query('SET LOCAL ROLE commerce_privacy_job_worker');
  const result=await db.query('SELECT prepare_privacy_job($1,$2,$3,$4,$5) receipt',[data.jobId,data.journeyId,data.sourceVersion,data.backupId,lease]);
  if(result.rows.length!==1)throw Error('PRIVACY_JOB_RECEIPT_MISSING');
  const parsed=receipt.parse(result.rows[0]?.receipt);
  if(parsed.job_id!==data.jobId)throw Error('PRIVACY_JOB_RECEIPT_IDENTITY');
  return parsed;
 });
}
