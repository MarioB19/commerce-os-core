import {z} from 'zod';
import {hash,decrypt,encrypt} from './index.js';
import type {ProfileExecutor} from './profile-context.js';
import {readCurrentQrContinuity} from './continuous-warmup.js';
import {canonicalIdentity} from '../../messaging/src/security.js';

const environmentSchema=z.enum(['REAL','SIMULATION']),idSchema=z.uuid().transform(v=>v.toLowerCase());
const resultSchema=z.discriminatedUnion('state',[
 z.object({state:z.enum(['ENROLLED','ALREADY_ENROLLED']),pool_id:idSchema,episode_id:idSchema,identity_id:idSchema}).strict(),
 z.object({state:z.enum(['AUTHORITY_BLOCKED','LEGACY_ADOPTION_REQUIRED','EXISTING_PROGRAM_PRESERVED','POOL_STOP_PRESERVED','EPISODE_ADOPTION_REQUIRED'])}).strict(),
]);
export class QrWarmupError extends Error {constructor(code:string){super(code);this.name='QrWarmupError';}}
function need(value:unknown,code:string):asserts value{if(!value)throw new QrWarmupError(code);}
/** Decrypt only observed native identity inside the profile transaction. No
 * provider profile update or user-supplied address can become a QR observation. */
export async function enrollCurrentQrWarmup(db:ProfileExecutor,environment:'REAL'|'SIMULATION',accountId:string){
 environmentSchema.parse(environment);accountId=idSchema.parse(accountId);
 const grant=await readCurrentQrContinuity(db,environment,accountId);
 need(grant?.source.kind==='VERIFIED_QR_CONNECTION','QR_CURRENT_CONNECTION_REQUIRED');
 const row=(await db.query(`SELECT revision,observed_identity_ciphertext,expected_identity_fingerprint
  FROM channel_sessions WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND archived_at IS NULL FOR SHARE`,[db.workspaceId,environment,accountId])).rows[0];
 need(row&&typeof row.observed_identity_ciphertext==='string'&&row.observed_identity_ciphertext.length<=2048,'QR_OBSERVED_IDENTITY_REQUIRED');
 let raw:string;try{raw=decrypt(row.observed_identity_ciphertext);}catch{throw new QrWarmupError('QR_OBSERVED_IDENTITY_INVALID');}
 need(raw.length<=256&&hash(raw)===grant.source.identityFingerprint&&row.expected_identity_fingerprint===grant.source.identityFingerprint,'QR_OBSERVED_IDENTITY_CHANGED');
 const canonical=canonicalIdentity(raw);need(/^wa:\d{6,18}$/.test(canonical),'QR_OWN_PHONE_IDENTITY_REQUIRED');
 const result=(await db.query('SELECT enroll_current_qr_warmup($1,$2,$3,$4,$5,$6,$7) AS result',
  [environment,accountId,grant.id,row.revision,row.observed_identity_ciphertext,hash(canonical),encrypt(canonical)])).rows[0]?.result;
 return resultSchema.parse(result);
}
/** Bounded scan of this profile only. Source observation precedes enrollment;
 * an unknown result is read through idempotent native rows on the next tick. */
export async function enrollQrWarmupProfile(db:ProfileExecutor,environment:'REAL'|'SIMULATION',limit=20){
 environmentSchema.parse(environment);need(Number.isInteger(limit)&&limit>=1&&limit<=100,'QR_ENROLLMENT_LIMIT');
 const rows=(await db.query(`SELECT s.account_id FROM channel_sessions s WHERE s.workspace_id=$1 AND s.environment=$2
  AND s.archived_at IS NULL AND s.observed_state='CONNECTED' AND s.auth_state='VERIFIED'
  AND s.observed_identity_ciphertext IS NOT NULL AND s.health_expires_at>clock_timestamp()
  ORDER BY s.account_id LIMIT $3`,[db.workspaceId,environment,limit])).rows;
 // Fail the transaction as a unit on a changed source, rather than commit a
 // partial enrollment whose audit or constraints were not confirmed.
 const results=[];for(const row of rows)results.push({accountId:row.account_id,...await enrollCurrentQrWarmup(db,environment,row.account_id)});
 return results;
}
