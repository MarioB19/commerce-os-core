import {decrypt} from './index.js';
import type {ProfileExecutor} from './profile-context.js';

/** V7 RF-11 (D-06): read-only Meta insight sync with the profile's own
 * system-user token. A job is a row of meta_insight_jobs marked
 * `source: V7_PROFILE`; it is requested by the owner ("Actualizar datos") or by
 * the hourly schedule, and processed by the automation worker inside that
 * profile's WorkerScope. Only official GET reads happen; nothing is created,
 * paused or funded in Meta. The token is decrypted in memory only for the
 * reads and is never stored in a job, a result or a log. */
export const META_PROFILE_SYNC_SOURCE='V7_PROFILE';
export const META_PROFILE_SYNC_INTERVAL_MINUTES=60;
export const META_PROFILE_SYNC_LOOKBACK_DAYS=7;
export class MetaProfileSyncError extends Error{constructor(readonly code:string){super(code);}}

/** The enabled, VERIFIED token of this profile, or null. The ciphertext must
 * name this profile and revision (scope profile.meta.token.v1). */
export async function readMetaSyncToken(db:ProfileExecutor):Promise<{revision:number;token:string}|null>{
 const row=(await db.query(`SELECT c.revision,v.ciphertext FROM meta_profile_credentials c
  JOIN meta_profile_credential_versions v ON (v.workspace_id,v.revision)=(c.workspace_id,c.revision)
  WHERE c.workspace_id=$1 AND c.enabled AND c.state='VERIFIED'`,[db.workspaceId])).rows[0];
 if(!row)return null;
 let value:{scope?:unknown;workspaceId?:unknown;revision?:unknown;token?:unknown};
 try{value=JSON.parse(decrypt(String(row.ciphertext)));}catch{throw new MetaProfileSyncError('META_CREDENTIAL_UNREADABLE');}
 if(value?.scope!=='profile.meta.token.v1'||value.workspaceId!==db.workspaceId||value.revision!==row.revision||typeof value.token!=='string'||!value.token)
  throw new MetaProfileSyncError('META_CREDENTIAL_SCOPE_MISMATCH');
 return{revision:Number(row.revision),token:value.token};
}

export type MetaSyncRequest={status:'QUEUED';jobId:string}|{status:'ALREADY_QUEUED';jobId:string|null}|{status:'NOT_DUE'}|{status:'NOT_CONNECTED'};
/** Queues one read sync for this profile. `scheduled` honours the hourly
 * interval; an owner request does not. One open job per profile (the unique
 * active-job index also covers V5 jobs of the same workspace). */
export async function requestMetaProfileSync(db:ProfileExecutor,input:{actorId:string;scheduled:boolean}):Promise<MetaSyncRequest>{
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['meta-profile-sync:'+db.workspaceId]);
 const credential=(await db.query("SELECT revision FROM meta_profile_credentials WHERE workspace_id=$1 AND enabled AND state='VERIFIED'",[db.workspaceId])).rows[0];
 if(!credential)return{status:'NOT_CONNECTED'};
 const open=(await db.query("SELECT id,request->>'source' AS source FROM meta_insight_jobs WHERE workspace_id=$1 AND environment='REAL' AND status IN('PENDING','RUNNING') LIMIT 1",[db.workspaceId])).rows[0];
 if(open)return{status:'ALREADY_QUEUED',jobId:open.source===META_PROFILE_SYNC_SOURCE?String(open.id):null};
 if(input.scheduled){
  const recent=(await db.query(`SELECT 1 FROM meta_insight_jobs WHERE workspace_id=$1 AND environment='REAL' AND request->>'source'=$2
   AND created_at>clock_timestamp()-make_interval(mins=>$3) LIMIT 1`,[db.workspaceId,META_PROFILE_SYNC_SOURCE,META_PROFILE_SYNC_INTERVAL_MINUTES])).rows[0];
  if(recent)return{status:'NOT_DUE'};
 }
 const row=(await db.query(`INSERT INTO meta_insight_jobs(workspace_id,environment,actor_id,request) VALUES($1,'REAL',$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
  [db.workspaceId,input.actorId,{source:META_PROFILE_SYNC_SOURCE,lookback_days:META_PROFILE_SYNC_LOOKBACK_DAYS,credential_revision:Number(credential.revision),scheduled:input.scheduled}])).rows[0];
 return row?{status:'QUEUED',jobId:String(row.id)}:{status:'ALREADY_QUEUED',jobId:null};
}

/** Claims the oldest due V7 job of this profile under a fresh lease. */
export async function claimMetaProfileSync(db:ProfileExecutor,lease:string){
 return (await db.query(`UPDATE meta_insight_jobs SET status='RUNNING',attempts=attempts+1,lease_until=clock_timestamp()+interval '15 minutes',lease_token=$2,updated_at=now()
  WHERE id=(SELECT id FROM meta_insight_jobs WHERE workspace_id=$1 AND environment='REAL' AND request->>'source'=$3 AND attempts<3
   AND (status='PENDING' AND next_attempt_at<=clock_timestamp() OR status='RUNNING' AND lease_until<clock_timestamp())
   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,[db.workspaceId,lease,META_PROFILE_SYNC_SOURCE])).rows[0] as Record<string,any>|undefined;
}

/** Closes a job this worker still holds; a retryable outcome waits at least
 * five minutes (or the provider's retry time). Three attempts at most. */
export async function finishMetaProfileSync(db:ProfileExecutor,job:{id:string;lease_token:string;attempts:number},result:{status:string;issues?:{retry_at?:string}[]}){
 const retry=result.status==='UNAVAILABLE'&&job.attempts<3;
 const retryAt=new Date(Math.max(Date.now()+300_000,...(result.issues??[]).map(issue=>Date.parse(issue.retry_at??'')||0))).toISOString();
 const row=(await db.query(`UPDATE meta_insight_jobs SET status=$4,result=$5,lease_until=NULL,next_attempt_at=$6::timestamptz,updated_at=now()
  WHERE id=$1 AND workspace_id=$2 AND lease_token=$3 RETURNING id`,[job.id,db.workspaceId,job.lease_token,retry?'PENDING':result.status,result,retryAt])).rows[0];
 return Boolean(row);
}

/** What the Campaigns page shows about the read: connection and the last sync. */
export async function readMetaSyncState(db:ProfileExecutor){
 const credential=(await db.query('SELECT enabled,state FROM meta_profile_credentials WHERE workspace_id=$1',[db.workspaceId])).rows[0];
 const last=(await db.query(`SELECT status,created_at,updated_at,result->'issues' AS issues FROM meta_insight_jobs
  WHERE workspace_id=$1 AND environment='REAL' AND request->>'source'=$2 ORDER BY created_at DESC LIMIT 1`,[db.workspaceId,META_PROFILE_SYNC_SOURCE])).rows[0];
 const codes=Array.isArray(last?.issues)?[...new Set((last.issues as {code?:unknown}[]).map(i=>i?.code).filter((c):c is string=>typeof c==='string'&&/^[A-Z0-9_]{1,64}$/.test(c)))].slice(0,10):[];
 return{
  credential:credential?(credential.enabled?String(credential.state):'DISABLED'):'MISSING',
  last_sync:last?{status:String(last.status),requested_at:new Date(last.created_at).toISOString(),updated_at:new Date(last.updated_at).toISOString(),issues:codes}:null,
 };
}
