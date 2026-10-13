import {randomUUID} from 'node:crypto';
import {createDatabaseWorkerRuntime,runtimeRoleLogin} from '../../../packages/db/src/index.js';
import {withWorkerProfilePhase,type WorkerProfileSelection} from '../../../packages/db/src/profile-worker-scope.js';
import type {ProfileExecutor} from '../../../packages/db/src/profile-context.js';
import {claimMetaProfileSync,finishMetaProfileSync,readMetaSyncToken,requestMetaProfileSync} from '../../../packages/db/src/meta-profile-sync.js';
import type {Body} from '@commerce/contracts';
import {persistInsightAccount,syncInsightAccounts,insightLabel,UNAVAILABLE_ACCOUNT_SQL,type InsightStore} from './meta-insights.js';

type Runtime={discover():Promise<WorkerProfileSelection[]>;run<T>(selection:WorkerProfileSelection,work:()=>Promise<T>):Promise<T>};
export type MetaProfileSyncPorts={runtime:Runtime;fetcher?:typeof fetch;now?:()=>number};
const code=(error:unknown)=>{const value=(error as {code?:string;message?:string})?.code??(error as {message?:string})?.message;return typeof value==='string'&&/^[A-Z0-9_]+$/.test(value)?value:'META_PROFILE_SYNC_FAILED';};
const phase=<T>(work:(db:ProfileExecutor)=>Promise<T>)=>withWorkerProfilePhase(work);

/** Every database step of a V7 sync runs in its own short WorkerScope phase of
 * the job's profile; the official GET reads happen between phases, with no
 * transaction open. */
function profileStore():InsightStore{
 return{
  known:()=>phase(async db=>(await db.query(`SELECT * FROM meta_insight_accounts WHERE workspace_id=$1 AND environment='REAL'`,[db.workspaceId])).rows),
  lostAccess:(_job,accountId,issue)=>phase(async db=>{await db.query(`UPDATE meta_insight_accounts SET status='UNAVAILABLE',issue=$3,last_attempt_at=now() WHERE workspace_id=$1 AND environment='REAL' AND meta_ad_account_id=$2`,[db.workspaceId,accountId,issue]);}),
  failed:(_job,account,issue)=>phase(async db=>{await db.query(UNAVAILABLE_ACCOUNT_SQL,[db.workspaceId,account.id,insightLabel(account.name),account.currency,account.timezone_name,issue]);}),
  persist:(job,account,rows,ads,complete,window)=>phase(async db=>{
   const current=(await db.query('SELECT lease_token FROM meta_insight_jobs WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[job.id,db.workspaceId])).rows[0];
   if(current?.lease_token!==job.lease_token)throw new Error('INSIGHT_LEASE_LOST');
   await persistInsightAccount(db,job,account,rows,ads,complete,window);
  }),
 };
}

/** One profile: schedule when due, then process at most one claimed job. */
export async function syncMetaProfile(fetcher:typeof fetch=fetch){
 const claim=await phase(async db=>{
  await requestMetaProfileSync(db,{actorId:'meta-profile-scheduler',scheduled:true});
  const job=await claimMetaProfileSync(db,randomUUID());
  if(!job)return null;
  let credential:{revision:number;token:string}|null=null,problem:string|null=null;
  try{credential=await readMetaSyncToken(db);}catch(error){problem=code(error);}
  return{job,credential,problem};
 });
 if(!claim)return{processed:false as const};
 const {job}=claim;let result:Body;
 if(!claim.credential)result={status:'UNAVAILABLE',succeeded:0,accounts:0,issues:[{code:claim.problem??'META_CREDENTIAL_UNAVAILABLE'}],source:'META_API',external_mutations:0};
 else if(claim.credential.revision!==Number(job.request.credential_revision))result={status:'UNAVAILABLE',succeeded:0,accounts:0,issues:[{code:'META_CREDENTIAL_CHANGED'}],source:'META_API',external_mutations:0};
 else{
  try{result=await syncInsightAccounts(job,[claim.credential.token],profileStore(),fetcher);}
  catch(error){result={status:'UNAVAILABLE',succeeded:0,accounts:0,issues:[{code:code(error)}],source:'META_API',external_mutations:0};}
 }
 // A changed credential needs no retry: the next schedule reads the new revision.
 const final=result.issues?.some((issue:Body)=>issue.code==='META_CREDENTIAL_CHANGED')?{...result,status:'CANCELLED'}:result;
 const closed=await phase(db=>finishMetaProfileSync(db,{id:job.id,lease_token:job.lease_token,attempts:job.attempts},final as {status:string;issues?:{retry_at?:string}[]}));
 return{processed:true as const,status:String(final.status),closed};
}

let lastRun=0;
/** V7 RF-11: each ACTIVE profile in its own WorkerScope (REAL). Discovery runs
 * at most every 15 seconds; a failure in one profile does not stop the others. */
export async function processMetaProfileSync(ports?:MetaProfileSyncPorts){
 if(!ports&&!runtimeRoleLogin)return{skipped:'RUNTIME_LOGIN_REQUIRED' as const,profiles:[]};
 const now=(ports?.now??Date.now)();
 if(!ports&&now-lastRun<15_000)return{skipped:'NOT_DUE' as const,profiles:[]};
 lastRun=now;
 const runtime=ports?.runtime??createDatabaseWorkerRuntime('commerce_automation','REAL');
 const profiles:{profile:string;status?:string;error?:string}[]=[];
 for(const selection of await runtime.discover()){
  if(selection.state!=='ACTIVE')continue;
  try{const result=await runtime.run(selection,()=>syncMetaProfile(ports?.fetcher));profiles.push({profile:selection.workspaceId,status:result.processed?result.status:'IDLE'});}
  catch(error){profiles.push({profile:selection.workspaceId,error:code(error)});}
 }
 const failed=profiles.find(row=>row.error);
 if(failed)throw Object.assign(new Error('META_PROFILE_SYNC_PARTIAL'),{code:'META_PROFILE_SYNC_PARTIAL',profiles});
 return{skipped:null,profiles};
}
