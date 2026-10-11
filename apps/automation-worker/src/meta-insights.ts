import {pool,withTransaction,uuid,type QueryExecutor} from '@commerce/db';
import {listIntegrationSettings} from '../../../packages/db/src/integration-settings.js';
import {MetaReader,MetaReadError,META_GRAPH_VERSION} from '../../api/src/meta-client.js';
import {decimalMinor} from '../../../packages/domain/src/sales/money.js';
import type {Body} from '@commerce/contracts';
export const INSIGHT_DEFINITION='meta_daily_v1';
export const CONVERSATION_ACTION='onsite_conversion.messaging_conversation_started_7d';
const dateString=(value:unknown)=>{const s=String(value);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||new Date(s+'T12:00:00Z').toISOString().slice(0,10)!==s)throw new Error('INVALID_INSIGHT_DATE');return s;};
const opaque=(v:unknown)=>{if(!/^\d+$/.test(String(v)))throw new Error('INVALID_META_ID');return String(v);};
const count=(v:unknown)=>v===undefined?null:/^\d+$/.test(String(v))&&Number.isSafeInteger(Number(v))?Number(v):null;
const label=(v:unknown)=>String(v??'Sin nombre').replace(/EAA[A-Za-z0-9]{20,}/g,'[redactado]').slice(0,240);
export function parseInsight(row:Body,account:Body,level:'ad'|'campaign',from:string,to:string){
 const day=dateString(row.date_start);if(day<from||day>to||row.date_stop!==day)throw new Error('INSIGHT_WINDOW_MISMATCH');
 if('act_'+opaque(row.account_id)!==account.id||row.account_currency!==account.currency)throw new Error('INSIGHT_ACCOUNT_MISMATCH');
 const action=Array.isArray(row.actions)?row.actions.find((a:Body)=>a.action_type===CONVERSATION_ACTION):undefined;
 const conversations=action&&/^\d+(?:\.\d+)?$/.test(String(action.value))?Number(action.value):null;
 return{day,level,entity_id:opaque(level==='ad'?row.ad_id:row.campaign_id),campaign_id:opaque(row.campaign_id),ad_set_id:level==='ad'?opaque(row.adset_id):null,name:label(level==='ad'?row.ad_name:row.campaign_name),campaign_name:label(row.campaign_name),currency:account.currency,timezone:account.timezone_name,spend_minor:decimalMinor(row.spend,account.currency),impressions:count(row.impressions),clicks:count(row.clicks),conversations,action_type:action?CONVERSATION_ACTION:null};
}
export async function persistInsightAccount(c:QueryExecutor,job:Body,account:Body,rows:Body[],metadata:Body[],metadataComplete=true){
 const {from,to}=job.request;
 await c.query(`INSERT INTO meta_insight_accounts(workspace_id,environment,meta_ad_account_id,name,currency,timezone,status,last_success_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(workspace_id,environment,meta_ad_account_id) DO UPDATE SET name=EXCLUDED.name,currency=EXCLUDED.currency,timezone=EXCLUDED.timezone,status=EXCLUDED.status,last_success_at=now(),last_attempt_at=now(),issue=NULL`,[job.workspace_id,job.environment,account.id,label(account.name),account.currency,account.timezone_name,metadataComplete?'SYNCED':'PARTIAL']);
 await c.query('DELETE FROM meta_insight_days WHERE workspace_id=$1 AND environment=$2 AND meta_ad_account_id=$3 AND day BETWEEN $4 AND $5',[job.workspace_id,job.environment,account.id,from,to]);
 for(const r of rows)await c.query(`INSERT INTO meta_insight_days(workspace_id,environment,meta_ad_account_id,day,level,entity_id,campaign_id,ad_set_id,name,campaign_name,currency,timezone,spend_minor,impressions,clicks,conversations,action_type,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,[job.workspace_id,job.environment,account.id,r.day,r.level,r.entity_id,r.campaign_id,r.ad_set_id,r.name,r.campaign_name,r.currency,r.timezone,r.spend_minor,r.impressions,r.clicks,r.conversations,r.action_type,job.id]);
 await c.query(`INSERT INTO meta_insight_coverage(workspace_id,environment,meta_ad_account_id,day,job_id) SELECT $1,$2,$3,d::date,$4 FROM generate_series($5::date,$6::date,interval '1 day') d ON CONFLICT(workspace_id,environment,meta_ad_account_id,day) DO UPDATE SET synced_at=now(),job_id=EXCLUDED.job_id`,[job.workspace_id,job.environment,account.id,job.id,from,to]);
 for(const r of metadata)await c.query(`INSERT INTO meta_ad_metadata(workspace_id,environment,meta_ad_account_id,ad_id,campaign_id,ad_set_id,ad_name,campaign_name,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id,environment,meta_ad_account_id,ad_id) DO UPDATE SET campaign_id=EXCLUDED.campaign_id,ad_set_id=EXCLUDED.ad_set_id,ad_name=EXCLUDED.ad_name,campaign_name=EXCLUDED.campaign_name,observed_at=now(),source=EXCLUDED.source`,[job.workspace_id,job.environment,account.id,opaque(r.id),opaque(r.campaign_id),r.adset_id?opaque(r.adset_id):null,label(r.name),label(r.campaign?.name??rows.find(x=>x.campaign_id===r.campaign_id)?.campaign_name),job.environment==='SIMULATION'?'SIMULATION_FIXTURE':'META_API']);
}
export async function executeInsightJob(job:Body,fetcher:typeof fetch=fetch){
 if(job.environment!=='REAL')throw new Error('META_REAL_ENVIRONMENT_REQUIRED');
 const profiles=await listIntegrationSettings(pool,job.workspace_id,'REAL',{type:'meta',secrets:true});
 const accounts=new Map<string,{account:Body;reader:MetaReader}>(),issues:Body[]=[];
 for(const profile of profiles.filter(p=>p.enabled&&p.secrets.access_token)){
  const reader=new MetaReader(profile.secrets.access_token!,fetcher);
  try{const result=await reader.list('me/adaccounts','id,name,currency,timezone_name');if(!result.complete)issues.push({scope:'account_discovery',...(result.issue??{code:'PARTIAL'})});
   for(const account of result.data){if(!/^act_\d+$/.test(account.id)||!account.currency||!account.timezone_name)continue;if(job.request.meta_ad_account_id&&job.request.meta_ad_account_id!==account.id)continue;if(!accounts.has(account.id))accounts.set(account.id,{account,reader});}
  }catch(error){issues.push({scope:'account_discovery',...(error instanceof MetaReadError?error.issue:{code:'META_UNAVAILABLE'})});}
 }
 // Known accounts must remain in source coverage even when discovery loses permission.
 const known=(await pool.query(`SELECT * FROM meta_insight_accounts WHERE workspace_id=$1 AND environment='REAL' AND ($2::text IS NULL OR meta_ad_account_id=$2)`,[job.workspace_id,job.request.meta_ad_account_id??null])).rows;
 for(const a of known)if(!accounts.has(a.meta_ad_account_id)){issues.push({meta_ad_account_id:a.meta_ad_account_id,code:'ACCOUNT_NOT_ACCESSIBLE'});await pool.query(`UPDATE meta_insight_accounts SET status='UNAVAILABLE',issue=$3,last_attempt_at=now() WHERE workspace_id=$1 AND environment='REAL' AND meta_ad_account_id=$2`,[job.workspace_id,a.meta_ad_account_id,{code:'ACCOUNT_NOT_ACCESSIBLE'}]);}
 let succeeded=0;
 for(const {account,reader} of accounts.values()){
  try{
   const rows:Body[]=[];
   for(const level of ['ad','campaign'] as const){const fields='account_id,account_currency,date_start,date_stop,campaign_id,campaign_name,spend,impressions,clicks,actions'+(level==='ad'?',ad_id,ad_name,adset_id':'');const result=await reader.list(`${account.id}/insights`,fields,{level,time_increment:'1',time_range:JSON.stringify({since:job.request.from,until:job.request.to}),action_report_time:'conversion',use_unified_attribution_setting:'true'});if(!result.complete)throw new MetaReadError(result.issue!);rows.push(...result.data.map(r=>parseInsight(r,account,level,job.request.from,job.request.to)));}
   let ads:Body[]=[],complete=true;try{const result=await reader.list(`${account.id}/ads`,'id,name,campaign_id,adset_id,campaign{name}');ads=result.data;complete=result.complete;if(result.issue)issues.push({meta_ad_account_id:account.id,...result.issue});}catch(error){complete=false;if(error instanceof MetaReadError)issues.push({meta_ad_account_id:account.id,...error.issue});}
   // Insights themselves also prove IDs, even when metadata discovery is partial.
   for(const r of rows.filter(r=>r.level==='ad'))if(!ads.some(a=>a.id===r.entity_id))ads.push({id:r.entity_id,name:r.name,campaign_id:r.campaign_id,adset_id:r.ad_set_id,campaign:{name:r.campaign_name}});
   await withTransaction(async c=>{const current=(await c.query('SELECT lease_token FROM meta_insight_jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];if(current?.lease_token!==job.lease_token)throw new Error('INSIGHT_LEASE_LOST');await persistInsightAccount(c,job,account,rows,ads,complete);});succeeded++;
   if(!complete)issues.push({meta_ad_account_id:account.id,code:'METADATA_PARTIAL'});
  }catch(error){const issue=error instanceof MetaReadError?error.issue:{code:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'META_UNAVAILABLE'};issues.push({meta_ad_account_id:account.id,...issue});await pool.query(`INSERT INTO meta_insight_accounts(workspace_id,environment,meta_ad_account_id,name,currency,timezone,status,issue) VALUES($1,'REAL',$2,$3,$4,$5,'UNAVAILABLE',$6) ON CONFLICT(workspace_id,environment,meta_ad_account_id) DO UPDATE SET status='UNAVAILABLE',issue=EXCLUDED.issue,last_attempt_at=now()`,[job.workspace_id,account.id,label(account.name),account.currency,account.timezone_name,issue]);}
 }
 return{status:succeeded?(issues.length?'PARTIAL':'SYNCED'):'UNAVAILABLE',succeeded,accounts:accounts.size,issues,source:'META_API',graph_api_version:META_GRAPH_VERSION,definition:INSIGHT_DEFINITION,external_mutations:0};
}
export async function processInsightJobs(){
 const job=await withTransaction(async c=>(await c.query(`UPDATE meta_insight_jobs SET status='RUNNING',attempts=attempts+1,lease_until=now()+interval '15 minutes',lease_token=$1,updated_at=now() WHERE id=(SELECT id FROM meta_insight_jobs WHERE (status='PENDING' AND next_attempt_at<=now() OR status='RUNNING' AND lease_until<now()) AND attempts<3 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,[uuid()])).rows[0]);
 if(!job)return;
 let result:Body;try{result=await executeInsightJob(job);}catch{result={status:'UNAVAILABLE',issues:[{code:'INSIGHT_DEPENDENCY_UNAVAILABLE'}],external_mutations:0};}
 const retry=result.status==='UNAVAILABLE'&&job.attempts<3;
 const retryAt=new Date(Math.max(Date.now()+300_000,...(result.issues??[]).map((issue:Body)=>Date.parse(issue.retry_at??'')||0))).toISOString();
 await pool.query(`UPDATE meta_insight_jobs SET status=$3,result=$4,lease_until=NULL,next_attempt_at=$5::timestamptz,updated_at=now() WHERE id=$1 AND lease_token=$2`,[job.id,job.lease_token,retry?'PENDING':result.status,result,retryAt]);
}
export async function scheduleRecentInsights(){
 await pool.query(`UPDATE meta_insight_jobs SET status='UNAVAILABLE',result=jsonb_build_object('status','UNAVAILABLE','issues',jsonb_build_array(jsonb_build_object('code','RETRY_EXHAUSTED'))),updated_at=now() WHERE status='RUNNING' AND lease_until<now() AND attempts>=3`);
 await pool.query(`INSERT INTO meta_insight_jobs(workspace_id,environment,actor_id,request)
 SELECT j.workspace_id,'REAL','insights-scheduler',j.request||jsonb_build_object('from',to_char((now() AT TIME ZONE 'America/Mexico_City')::date-COALESCE((j.request->>'lookback_days')::int,7),'YYYY-MM-DD'),'to',to_char((now() AT TIME ZONE 'America/Mexico_City')::date,'YYYY-MM-DD'),'scheduled',true)
 FROM (SELECT DISTINCT ON(workspace_id) workspace_id,request,created_at,next_attempt_at FROM meta_insight_jobs WHERE environment='REAL' AND COALESCE(request->>'preserve_schedule','false')<>'true' ORDER BY workspace_id,created_at DESC) j
 WHERE j.next_attempt_at<=now() AND j.request->>'recurring'='true' AND j.created_at<now()-make_interval(mins=>COALESCE((j.request->>'interval_minutes')::int,60)) AND NOT EXISTS(SELECT 1 FROM meta_insight_jobs a WHERE a.workspace_id=j.workspace_id AND a.status IN ('PENDING','RUNNING')) ON CONFLICT DO NOTHING`);
}
