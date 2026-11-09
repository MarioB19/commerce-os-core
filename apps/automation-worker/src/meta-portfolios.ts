import {randomUUID} from 'node:crypto';
import {withWorkerProfilePhase} from '../../../packages/db/src/profile-worker-scope.js';
import type {ProfileExecutor} from '../../../packages/db/src/profile-context.js';
import {checkMetaToken} from '../../../packages/db/src/profile-integrations.js';
import {hasMetaConnections,readMetaConnectionToken,recordConnectionCheck,metaOperation,enqueueMetaDiscovery,selectedMetaAccounts,queueMetaWindows,metaDate,shiftMetaDay,updateMetaOperations,metaNeed,META_SOURCE} from '../../../packages/db/src/meta-portfolios.js';
import {MetaReader,MetaReadError} from '../../api/src/meta-client.js';
import {insightLabel,parseInsight,persistInsightAccount} from './meta-insights.js';
import type {Body} from '@commerce/contracts';
const phase=<T>(work:(db:ProfileExecutor)=>Promise<T>)=>withWorkerProfilePhase(work);
const issueCode=(error:unknown)=>{const code=(error as {code?:string;message?:string})?.code??(error as Error)?.message;return typeof code==='string'&&/^[A-Z0-9_]+$/.test(code)?code:'META_UPSTREAM_UNAVAILABLE';};

export async function scheduleMetaPortfolioReads(db:ProfileExecutor){
 const now=new Date((await db.query('SELECT clock_timestamp() now')).rows[0].now),hour=Math.floor(now.getTime()/3600000);
 // One-way handoff: the old loops cannot own work once named connections exist.
 await db.query("UPDATE meta_insight_jobs SET status='CANCELLED',result='{\"issues\":[{\"code\":\"META_V73_HANDOFF\"}]}',lease_until=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND status IN('PENDING','RUNNING')",[db.workspaceId]);
 const connections=(await db.query("SELECT id,revision FROM meta_connections WHERE workspace_id=$1 AND enabled AND state<>'INVALID'",[db.workspaceId])).rows;
 for(const c of connections)await enqueueMetaDiscovery(db,c.id,'meta-v73-scheduler',`discovery:${c.id}:${c.revision}:${hour}`);
 const accounts=await selectedMetaAccounts(db);
 for(const account of accounts){
  const to=metaDate(account.timezone,now),from=shiftMetaDay(to,-89);
  const coverage=(await db.query("SELECT count(*)::int n FROM meta_insight_coverage WHERE workspace_id=$1 AND environment='REAL' AND meta_ad_account_id=$2 AND day BETWEEN $3 AND $4",[db.workspaceId,account.meta_ad_account_id,from,to])).rows[0].n;
  if(coverage<90){const op=await metaOperation(db,`initial:${account.meta_ad_account_id}:${account.connection_id}:${account.credential_revision}`,{kind:'INITIAL',meta_ad_account_id:account.meta_ad_account_id},'meta-v73-scheduler');
   // Freeze the initial range at operation creation, including after restarts.
   const initialTo=metaDate(account.timezone,new Date(op.created_at));await queueMetaWindows(db,op,account,shiftMetaDay(initialTo,-89),initialTo,10);}
  const hourly=await metaOperation(db,`hourly:${account.meta_ad_account_id}:${hour}`,{kind:'HOURLY',meta_ad_account_id:account.meta_ad_account_id},'meta-v73-scheduler');
  await queueMetaWindows(db,hourly,account,shiftMetaDay(to,-6),to,3);
  const daily=await metaOperation(db,`daily:${account.meta_ad_account_id}:${to}`,{kind:'DAILY',meta_ad_account_id:account.meta_ad_account_id},'meta-v73-scheduler');
  await queueMetaWindows(db,daily,account,shiftMetaDay(to,-29),to,7);
 }
}
export async function claimMetaPortfolioTask(db:ProfileExecutor){
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['meta-v73-claim:'+db.workspaceId]);
 await db.query(`UPDATE meta_read_tasks SET status='UNAVAILABLE',issue='{"code":"META_RETRY_EXHAUSTED"}',lease_until=NULL,updated_at=clock_timestamp()
 WHERE workspace_id=$1 AND status='RUNNING' AND lease_until<clock_timestamp() AND attempts>=3`,[db.workspaceId]);
 await db.query(`UPDATE meta_read_tasks t SET status='CANCELLED',issue='{"code":"META_CREDENTIAL_CHANGED"}',lease_until=NULL,updated_at=clock_timestamp()
 FROM meta_connections c WHERE t.workspace_id=$1 AND (c.workspace_id,c.id)=(t.workspace_id,t.connection_id) AND t.status IN('PENDING','RUNNING') AND (NOT c.enabled OR c.revision<>t.credential_revision)`,[db.workspaceId]);
 const row=(await db.query(`UPDATE meta_read_tasks SET status='RUNNING',attempts=attempts+1,lease_token=$2,lease_until=clock_timestamp()+interval '2 minutes',updated_at=clock_timestamp()
 WHERE workspace_id=$1 AND id=(SELECT t.id FROM meta_read_tasks t JOIN meta_connections c ON(c.workspace_id,c.id,c.revision)=(t.workspace_id,t.connection_id,t.credential_revision)
 WHERE t.workspace_id=$1 AND c.enabled AND c.state<>'INVALID' AND (c.cooldown_until IS NULL OR c.cooldown_until<=clock_timestamp()) AND t.attempts<3
 AND (t.status='PENDING' AND t.next_attempt_at<=clock_timestamp() OR t.status='RUNNING' AND t.lease_until<clock_timestamp())
 AND (t.kind='DISCOVERY' OR EXISTS(SELECT 1 FROM meta_portfolios p WHERE p.workspace_id=t.workspace_id AND p.business_id=t.business_id AND p.selected))
 AND NOT EXISTS(SELECT 1 FROM meta_read_tasks busy WHERE busy.workspace_id=t.workspace_id AND busy.id<>t.id AND busy.status='RUNNING' AND busy.lease_until>=clock_timestamp()
 AND (busy.connection_id=t.connection_id OR busy.meta_ad_account_id=t.meta_ad_account_id))
 ORDER BY t.priority,t.updated_at,t.id FOR UPDATE OF t SKIP LOCKED LIMIT 1) RETURNING *,to_char(range_from,'YYYY-MM-DD') from_day,to_char(range_to,'YYYY-MM-DD') to_day`,[db.workspaceId,randomUUID()])).rows[0];
 await updateMetaOperations(db);return row as Body|undefined;
}
async function heldTask(db:ProfileExecutor,task:Body){
 const current=(await db.query(`SELECT t.*,c.enabled,c.revision current_revision FROM meta_read_tasks t JOIN meta_connections c ON(c.workspace_id,c.id)=(t.workspace_id,t.connection_id)
 WHERE t.workspace_id=$1 AND t.id=$2 AND t.status='RUNNING' AND t.lease_token=$3 AND t.lease_until>clock_timestamp() FOR UPDATE OF t,c`,[db.workspaceId,task.id,task.lease_token])).rows[0];
 metaNeed(current&&current.enabled&&current.current_revision===task.credential_revision,'META_LEASE_OR_CREDENTIAL_CHANGED');
 if(task.kind==='INSIGHTS')metaNeed((await db.query('SELECT 1 FROM meta_portfolios WHERE workspace_id=$1 AND business_id=$2 AND selected FOR SHARE',[db.workspaceId,task.business_id])).rows[0],'META_PORTFOLIO_DESELECTED');return current;
}
async function persistDiscovery(db:ProfileExecutor,task:Body,data:Body[],done:boolean){
 const now=new Date((await db.query('SELECT clock_timestamp() now')).rows[0].now);
 for(const a of data){
  metaNeed(/^act_\d+$/.test(a.id)&&/^[A-Z]{3}$/.test(a.currency)&&typeof a.timezone_name==='string','META_ACCOUNT_INVALID');metaDate(a.timezone_name,now);
  const business=/^\d+$/.test(a.business?.id)?a.business.id:null;
  if(business)await db.query(`INSERT INTO meta_portfolios(workspace_id,business_id,name) VALUES($1,$2,$3) ON CONFLICT(workspace_id,business_id) DO UPDATE SET name=EXCLUDED.name,observed_at=clock_timestamp()`,[db.workspaceId,business,insightLabel(a.business.name)]);
  await db.query(`INSERT INTO meta_account_access(workspace_id,connection_id,meta_ad_account_id,business_id,name,currency,timezone,credential_revision,discovery_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id,connection_id,meta_ad_account_id) DO UPDATE SET business_id=EXCLUDED.business_id,name=EXCLUDED.name,currency=EXCLUDED.currency,timezone=EXCLUDED.timezone,accessible=true,credential_revision=EXCLUDED.credential_revision,discovery_id=EXCLUDED.discovery_id,observed_at=clock_timestamp()`,[db.workspaceId,task.connection_id,a.id,business,insightLabel(a.name),a.currency,a.timezone_name,task.credential_revision,task.id]);
  await db.query(`INSERT INTO meta_insight_accounts(workspace_id,environment,meta_ad_account_id,name,currency,timezone,status) VALUES($1,'REAL',$2,$3,$4,$5,'NOT_READ')
   ON CONFLICT(workspace_id,environment,meta_ad_account_id) DO UPDATE SET name=EXCLUDED.name,currency=EXCLUDED.currency,timezone=EXCLUDED.timezone`,[db.workspaceId,a.id,insightLabel(a.name),a.currency,a.timezone_name]);
  if(business){const old=(await db.query('SELECT business_id FROM meta_account_portfolio_history WHERE workspace_id=$1 AND meta_ad_account_id=$2 ORDER BY valid_from DESC LIMIT 1',[db.workspaceId,a.id])).rows[0];
   if(!old||old.business_id!==business)await db.query(`INSERT INTO meta_account_portfolio_history(workspace_id,meta_ad_account_id,business_id,valid_from,basis) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[db.workspaceId,a.id,business,old?metaDate(a.timezone_name,now):'0001-01-01',old?'OBSERVED_CHANGE':'CURRENT_OWNER_BASELINE']);}
 }
 if(done){
  await db.query('UPDATE meta_account_access SET accessible=false WHERE workspace_id=$1 AND connection_id=$2 AND discovery_id<>$3',[db.workspaceId,task.connection_id,task.id]);
  await db.query(`UPDATE meta_insight_accounts a SET status='UNAVAILABLE',issue='{"code":"ACCOUNT_NOT_ACCESSIBLE"}' WHERE a.workspace_id=$1 AND a.environment='REAL'
   AND EXISTS(SELECT 1 FROM meta_account_access x WHERE x.workspace_id=a.workspace_id AND x.meta_ad_account_id=a.meta_ad_account_id)
   AND NOT EXISTS(SELECT 1 FROM meta_account_access x JOIN meta_connections c ON(c.workspace_id,c.id,c.revision)=(x.workspace_id,x.connection_id,x.credential_revision) WHERE x.workspace_id=a.workspace_id AND x.meta_ad_account_id=a.meta_ad_account_id AND x.accessible AND c.enabled AND c.state='VERIFIED')`,[db.workspaceId]);
  const legacy=(await db.query('SELECT auto_select_pending FROM meta_connections WHERE workspace_id=$1 AND id=$2',[db.workspaceId,task.connection_id])).rows[0];
  if(legacy.auto_select_pending){
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['meta-portfolios:'+db.workspaceId]);
   const n=(await db.query('SELECT count(*)::int n FROM meta_portfolios WHERE workspace_id=$1',[db.workspaceId])).rows[0].n;
   if(n<=5)await db.query('UPDATE meta_portfolios SET selected=true,version=version+1 WHERE workspace_id=$1 AND NOT selected',[db.workspaceId]);
   await db.query('UPDATE meta_connections SET auto_select_pending=false WHERE workspace_id=$1 AND id=$2',[db.workspaceId,task.connection_id]);
  }
 }
}
async function finishPage(db:ProfileExecutor,task:Body,page:{data:Body[];cursor:string|null}){
 const current=await heldTask(db,task);metaNeed(!page.cursor||!current.seen_cursors.includes(page.cursor),'META_PAGINATION_INCOMPLETE');
 let nextPhase=task.phase,status='PENDING';
 if(task.kind==='DISCOVERY'){
  if(task.phase==='businesses'){
   for(const b of page.data){metaNeed(/^\d+$/.test(b.id),'META_BUSINESS_INVALID');await db.query('INSERT INTO meta_portfolios(workspace_id,business_id,name) VALUES($1,$2,$3) ON CONFLICT(workspace_id,business_id) DO UPDATE SET name=EXCLUDED.name,observed_at=clock_timestamp()',[db.workspaceId,b.id,insightLabel(b.name)]);}
   if(!page.cursor)status='SYNCED';
  }else{await persistDiscovery(db,task,page.data,!page.cursor);if(!page.cursor)nextPhase='businesses';}
 }
 else{
  const account=(await db.query('SELECT name,currency,timezone FROM meta_insight_accounts WHERE workspace_id=$1 AND environment=\'REAL\' AND meta_ad_account_id=$2',[db.workspaceId,task.meta_ad_account_id])).rows[0];
  const a={id:task.meta_ad_account_id,name:account.name,currency:account.currency,timezone_name:account.timezone};
  const from=task.from_day,to=task.to_day;
  const safe=task.phase==='ads'?page.data.map(ad=>({id:String(ad.id),name:insightLabel(ad.name),campaign_id:String(ad.campaign_id),adset_id:ad.adset_id?String(ad.adset_id):null,campaign:{name:insightLabel(ad.campaign?.name)}})):page.data.map(row=>parseInsight(row,a,task.phase,from,to));
  await db.query('INSERT INTO meta_read_pages(workspace_id,task_id,phase,page_number,data) VALUES($1,$2,$3,$4,$5)',[db.workspaceId,task.id,task.phase,current.seen_cursors.length,JSON.stringify(safe)]);
  if(!page.cursor){
   if(task.phase==='ad')nextPhase='campaign';else if(task.phase==='campaign')nextPhase='ads';else{
    const pages=(await db.query('SELECT phase,data FROM meta_read_pages WHERE workspace_id=$1 AND task_id=$2 ORDER BY phase,page_number',[db.workspaceId,task.id])).rows;
    const rows=pages.filter(p=>p.phase!=='ads').flatMap(p=>p.data),ads=pages.filter(p=>p.phase==='ads').flatMap(p=>p.data);
    for(const r of rows.filter(r=>r.level==='ad'))if(!ads.some(ad=>ad.id===r.entity_id))ads.push({id:r.entity_id,name:r.name,campaign_id:r.campaign_id,adset_id:r.ad_set_id,campaign:{name:r.campaign_name}});
    await db.query(`INSERT INTO meta_insight_jobs(id,workspace_id,environment,actor_id,request,status,result) VALUES($1,$2,'REAL','meta-v73-worker',$3,'SYNCED','{"external_mutations":0}') ON CONFLICT(id) DO NOTHING`,[task.id,db.workspaceId,{source:META_SOURCE,from,to,connection_id:task.connection_id,credential_revision:task.credential_revision}]);
    await persistInsightAccount(db,{id:task.id,workspace_id:db.workspaceId,environment:'REAL'},a,rows,ads,true,{from,to});
    await db.query('DELETE FROM meta_read_pages WHERE workspace_id=$1 AND task_id=$2',[db.workspaceId,task.id]);status='SYNCED';
   }
  }
 }
 await db.query(`UPDATE meta_read_tasks SET phase=$4,cursor=$5,seen_cursors=$6,status=$7,attempts=0,lease_until=NULL,lease_token=NULL,issue=NULL,updated_at=clock_timestamp()
 WHERE workspace_id=$1 AND id=$2 AND lease_token=$3`,[db.workspaceId,task.id,task.lease_token,nextPhase,page.cursor,page.cursor?[...current.seen_cursors,page.cursor]:[],status]);
 await updateMetaOperations(db);
}
async function failTask(db:ProfileExecutor,task:Body,error:unknown){
 // An old network response must not invalidate the replacement credential or
 // its queued work. Hold the same task/connection fence as successful pages.
 const owned=(await db.query(`SELECT t.id FROM meta_read_tasks t JOIN meta_connections c ON(c.workspace_id,c.id,c.revision)=(t.workspace_id,t.connection_id,t.credential_revision)
 WHERE t.workspace_id=$1 AND t.id=$2 AND t.status='RUNNING' AND t.lease_token=$3 AND c.enabled FOR UPDATE OF t,c`,[db.workspaceId,task.id,task.lease_token])).rows[0];
 if(!owned){await updateMetaOperations(db);return;}
 const issue=error instanceof MetaReadError?error.issue:{code:issueCode(error),retryable:!['META_CREDENTIAL_CHANGED','META_LEASE_OR_CREDENTIAL_CHANGED','META_PORTFOLIO_DESELECTED','META_PAGINATION_INCOMPLETE','META_UNSAFE_PAGINATION','META_ACCOUNT_INVALID','INSIGHT_ACCOUNT_MISMATCH','INSIGHT_WINDOW_MISMATCH'].includes(issueCode(error))};
 const cancelled=['META_CREDENTIAL_CHANGED','META_LEASE_OR_CREDENTIAL_CHANGED','META_PORTFOLIO_DESELECTED'].includes(issue.code),invalid=issue.code==='META_TOKEN_EXPIRED'||task.kind==='DISCOVERY'&&['META_PERMISSION_DENIED','META_PERMISSION_MISSING','META_REQUEST_REJECTED'].includes(issue.code),retry=issue.retryable&&task.attempts<3&&!cancelled&&!invalid;
 const next=new Date(Math.max(Date.now()+300000,Date.parse(('retry_at' in issue?issue.retry_at:undefined)??'')||0)).toISOString();
 await db.query(`UPDATE meta_read_tasks SET status=$4,issue=$5,lease_until=NULL,lease_token=NULL,next_attempt_at=$6,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND status='RUNNING' AND lease_token=$3`,[db.workspaceId,task.id,task.lease_token,cancelled?'CANCELLED':retry?'PENDING':'UNAVAILABLE',issue,next]);
 if(issue.code==='META_RATE_LIMIT')await db.query('UPDATE meta_connections SET cooldown_until=$4 WHERE workspace_id=$1 AND id=$2 AND revision=$3',[db.workspaceId,task.connection_id,task.credential_revision,next]);
 if(task.kind==='INSIGHTS'&&issue.code==='META_PERMISSION_DENIED'){
  await db.query('UPDATE meta_account_access SET accessible=false WHERE workspace_id=$1 AND connection_id=$2 AND meta_ad_account_id=$3 AND credential_revision=$4',[db.workspaceId,task.connection_id,task.meta_ad_account_id,task.credential_revision]);
  await db.query("UPDATE meta_read_tasks SET status='UNAVAILABLE',issue=$5,lease_until=NULL WHERE workspace_id=$1 AND connection_id=$2 AND meta_ad_account_id=$3 AND credential_revision=$4 AND status IN('PENDING','RUNNING')",[db.workspaceId,task.connection_id,task.meta_ad_account_id,task.credential_revision,issue]);
 }
 if(task.kind==='INSIGHTS'&&!cancelled)await db.query("UPDATE meta_insight_accounts SET status='UNAVAILABLE',issue=$3,last_attempt_at=clock_timestamp() WHERE workspace_id=$1 AND environment='REAL' AND meta_ad_account_id=$2",[db.workspaceId,task.meta_ad_account_id,issue]);
 if(invalid){await recordConnectionCheck(db,task.connection_id,task.credential_revision,{state:'INVALID',reason:issue.code,grantedScopes:[]});await db.query("UPDATE meta_read_tasks SET status='UNAVAILABLE',issue=$3,lease_until=NULL WHERE workspace_id=$1 AND connection_id=$2 AND credential_revision=$4 AND status IN('PENDING','RUNNING')",[db.workspaceId,task.connection_id,{code:issue.code},task.credential_revision]);}
 await updateMetaOperations(db);
}
export async function processMetaPortfolioTask(fetcher:typeof fetch=fetch){
 const task=await phase(claimMetaPortfolioTask);if(!task)return false;
 try{
  const token=await phase(db=>readMetaConnectionToken(db,task.connection_id,task.credential_revision));
  if(task.kind==='DISCOVERY'&&task.phase==='ad'&&!task.cursor){
   const check=await checkMetaToken(token,fetcher);await phase(async db=>{await heldTask(db,task);await recordConnectionCheck(db,task.connection_id,task.credential_revision,check);});
   if(check.state!=='VERIFIED')throw new MetaReadError({code:check.reason,message:'La conexión no se pudo verificar.',action:'Revisa el token y sus permisos.',retryable:check.state==='UNKNOWN'});
  }
  const reader=new MetaReader(token,fetcher);let page;
  if(task.kind==='DISCOVERY'&&task.phase==='businesses'){
   try{page=await reader.page('me/businesses','id,name',{},task.cursor??'');}catch(error){if(error instanceof MetaReadError&&['META_PERMISSION_DENIED','META_RESOURCE_UNAVAILABLE'].includes(error.issue.code))page={data:[],cursor:null};else throw error;}
  }else if(task.kind==='DISCOVERY')page=await reader.page('me/adaccounts','id,name,currency,timezone_name,business{id,name}',{},task.cursor??'');
  else if(task.phase==='ads')page=await reader.page(`${task.meta_ad_account_id}/ads`,'id,name,campaign_id,adset_id,campaign{name}',{},task.cursor??'');
  else page=await reader.page(`${task.meta_ad_account_id}/insights`,'account_id,account_currency,date_start,date_stop,campaign_id,campaign_name,spend,impressions,clicks,actions'+(task.phase==='ad'?',ad_id,ad_name,adset_id':''),
   {level:task.phase,time_increment:'1',time_range:JSON.stringify({since:task.from_day,until:task.to_day}),action_report_time:'conversion',use_unified_attribution_setting:'true'},task.cursor??'');
  await phase(db=>finishPage(db,task,page));
 }catch(error){await phase(db=>failTask(db,task,error));}
 return true;
}
export async function syncMetaPortfolios(fetcher:typeof fetch=fetch){
 if(!await phase(hasMetaConnections))return false;
 await phase(scheduleMetaPortfolioReads);
 // Bound a tick; each task advances one page, and releases its transaction during GET.
 for(let n=0;n<4;n++)if(!await processMetaPortfolioTask(fetcher))break;
 return true;
}
