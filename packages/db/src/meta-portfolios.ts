import {randomUUID} from 'node:crypto';
import {encrypt,decrypt} from './index.js';
import type {ProfileExecutor} from './profile-context.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../domain/src/core/profile-authorization.js';
import {IntegrationError,type MetaCheck} from './profile-integrations.js';
import {metaPortfolioLimit,type MetaInventoryView,type MetaConnectionView,type MetaOperationView,type MetaSyncInput} from '../../contracts/src/meta-portfolios.js';

export const META_SOURCE='V73_PROFILE';
const iso=(v:unknown)=>v==null?null:new Date(v as string).toISOString();
export function metaNeed(v:unknown,code:string,status=409):asserts v{if(!v)throw new IntegrationError(code,status);}
export function metaDate(timezone:string,now=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);}
export function shiftMetaDay(day:string,offset:number){return new Date(Date.parse(day+'T12:00:00Z')+offset*86400000).toISOString().slice(0,10);}
export function metaWindows(from:string,to:string){const result:{from:string;to:string}[]=[];for(let end=to;end>=from;){const start=shiftMetaDay(end,-6);result.push({from:start<from?from:start,to:end});end=shiftMetaDay(start,-1);}return result;}
async function auth(db:ProfileExecutor,a:ProfileAuthority,mutation:boolean,interactiveOnly=false){const now=(await db.query('SELECT clock_timestamp() now')).rows[0].now;authorizeProfileAction(a,{scope:mutation?'integrations:write':'integrations:read',workspaceId:db.workspaceId,mutation,interactiveOnly},new Date(now));}
export async function hasMetaConnections(db:ProfileExecutor){return Boolean((await db.query('SELECT 1 FROM meta_connections WHERE workspace_id=$1 LIMIT 1',[db.workspaceId])).rows[0]);}
export async function connectionViews(db:ProfileExecutor):Promise<MetaConnectionView[]>{
 const rows=(await db.query(`SELECT c.*,COALESCE(v.key_hint,l.key_hint) key_hint FROM meta_connections c
 LEFT JOIN meta_connection_versions v ON(v.workspace_id,v.connection_id,v.revision)=(c.workspace_id,c.id,c.revision)
 LEFT JOIN meta_profile_credential_versions l ON(l.workspace_id,l.revision)=(c.workspace_id,c.legacy_revision)
 WHERE c.workspace_id=$1 ORDER BY c.created_at,c.id`,[db.workspaceId])).rows;
 return rows.map(c=>({id:c.id,alias:c.alias,revision:c.revision,enabled:c.enabled,state:c.enabled?c.state:'DISABLED',hint:c.key_hint?'••••'+c.key_hint:null,reason:c.reason,checkedAt:iso(c.checked_at),grantedScopes:c.granted_scopes,legacy:c.legacy_revision!==null}));
}
export async function saveMetaConnection(db:ProfileExecutor,a:ProfileAuthority,input:{id:string;alias:string;expectedRevision:number;token:string}){
 await auth(db,a,true,true);metaNeed(/^[A-Za-z0-9_|.-]{20,4096}$/.test(input.token),'META_TOKEN_INVALID',400);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['meta-connection:'+db.workspaceId+':'+input.id]);
 const old=(await db.query('SELECT revision FROM meta_connections WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[db.workspaceId,input.id])).rows[0];
 metaNeed((old?.revision??0)===input.expectedRevision,'META_TOKEN_VERSION_CONFLICT');const revision=input.expectedRevision+1;
 if(old)await db.query("UPDATE meta_connections SET revision=$3,alias=$4,enabled=true,state='UNVERIFIED',reason=NULL,checked_at=NULL,granted_scopes='{}',cooldown_until=NULL,updated_by=$5,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[db.workspaceId,input.id,revision,input.alias,a.membership.userId]);
 else await db.query('INSERT INTO meta_connections(workspace_id,id,alias,updated_by) VALUES($1,$2,$3,$4)',[db.workspaceId,input.id,input.alias,a.membership.userId]);
 const ciphertext=encrypt({scope:'profile.meta.connection.v1',workspaceId:db.workspaceId,connectionId:input.id,revision,token:input.token});
 await db.query('INSERT INTO meta_connection_versions(workspace_id,connection_id,revision,ciphertext,key_hint,created_by) VALUES($1,$2,$3,$4,$5,$6)',[db.workspaceId,input.id,revision,ciphertext,input.token.slice(-4),a.membership.userId]);
 await db.query("UPDATE meta_read_tasks SET status='CANCELLED',issue='{\"code\":\"META_CREDENTIAL_CHANGED\"}',updated_at=clock_timestamp() WHERE workspace_id=$1 AND connection_id=$2 AND credential_revision<>$3 AND status IN('PENDING','RUNNING')",[db.workspaceId,input.id,revision]);
 return{id:input.id,revision};
}
export async function recordConnectionCheck(db:ProfileExecutor,id:string,revision:number,check:MetaCheck){
 if(check.state==='UNKNOWN')return;
 await db.query('UPDATE meta_connections SET state=$4,reason=$5,checked_at=clock_timestamp(),granted_scopes=$6,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND revision=$3',[db.workspaceId,id,revision,check.state,check.state==='INVALID'?check.reason:null,check.grantedScopes]);
}
/** Only the owning worker can read ciphertext. Legacy envelopes are verified and
 * re-encapsulated, never copied under a different cryptographic identity. */
export async function readMetaConnectionToken(db:ProfileExecutor,id:string,revision:number){
 const c=(await db.query('SELECT * FROM meta_connections WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[db.workspaceId,id])).rows[0];
 metaNeed(c&&c.enabled&&c.revision===revision,'META_CREDENTIAL_CHANGED');
 let version=(await db.query('SELECT ciphertext FROM meta_connection_versions WHERE workspace_id=$1 AND connection_id=$2 AND revision=$3',[db.workspaceId,id,revision])).rows[0];
 if(!version&&c.legacy_revision!==null&&revision===1){
  const legacy=(await db.query('SELECT ciphertext FROM meta_profile_credential_versions WHERE workspace_id=$1 AND revision=$2',[db.workspaceId,c.legacy_revision])).rows[0];
  let value:any;try{value=JSON.parse(decrypt(String(legacy?.ciphertext)));}catch{throw new IntegrationError('META_CREDENTIAL_UNREADABLE');}
  metaNeed(value.scope==='profile.meta.token.v1'&&value.workspaceId===db.workspaceId&&value.revision===c.legacy_revision&&typeof value.token==='string','META_CREDENTIAL_SCOPE_MISMATCH');
  const ciphertext=encrypt({scope:'profile.meta.connection.v1',workspaceId:db.workspaceId,connectionId:id,revision,token:value.token});
  await db.query('INSERT INTO meta_connection_versions(workspace_id,connection_id,revision,ciphertext,key_hint,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[db.workspaceId,id,revision,ciphertext,value.token.slice(-4),'legacy-adoption']);version={ciphertext};
 }
 let value:any;try{value=JSON.parse(decrypt(String(version?.ciphertext)));}catch{throw new IntegrationError('META_CREDENTIAL_UNREADABLE');}
 metaNeed(value.scope==='profile.meta.connection.v1'&&value.workspaceId===db.workspaceId&&value.connectionId===id&&value.revision===revision&&typeof value.token==='string','META_CREDENTIAL_SCOPE_MISMATCH');
 return value.token as string;
}
export async function setMetaConnectionEnabled(db:ProfileExecutor,a:ProfileAuthority,id:string,revision:number,enabled:boolean){
 await auth(db,a,true);const row=(await db.query('UPDATE meta_connections SET enabled=$4,updated_by=$5,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND revision=$3 RETURNING id,revision,enabled',[db.workspaceId,id,revision,enabled,a.membership.userId])).rows[0];metaNeed(row,'META_TOKEN_VERSION_CONFLICT');
 if(!enabled)await db.query("UPDATE meta_read_tasks SET status='CANCELLED',issue='{\"code\":\"META_CONNECTION_DISABLED\"}',updated_at=clock_timestamp() WHERE workspace_id=$1 AND connection_id=$2 AND status IN('PENDING','RUNNING')",[db.workspaceId,id]);
 if(enabled)await resumeCancelledMetaTasks(db,'connection_id',id,'META_CONNECTION_DISABLED');
 await updateMetaOperations(db);return row;
}
async function resumeCancelledMetaTasks(db:ProfileExecutor,column:'connection_id'|'business_id',id:string,reason:string){
 await db.query(`UPDATE meta_read_tasks t SET status='PENDING',attempts=0,next_attempt_at=clock_timestamp(),lease_until=NULL,lease_token=NULL,issue=NULL,updated_at=clock_timestamp()
 FROM meta_connections c WHERE t.workspace_id=$1 AND t.${column}=$2 AND t.status='CANCELLED' AND t.issue->>'code'=$3
 AND (c.workspace_id,c.id,c.revision)=(t.workspace_id,t.connection_id,t.credential_revision) AND c.enabled AND c.state<>'INVALID'
 AND(t.kind='DISCOVERY' OR EXISTS(SELECT 1 FROM meta_portfolios p WHERE p.workspace_id=t.workspace_id AND p.business_id=t.business_id AND p.selected))`,[db.workspaceId,id,reason]);
}
export async function selectMetaPortfolio(db:ProfileExecutor,a:ProfileAuthority,id:string,version:number,selected:boolean){
 await auth(db,a,true);await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['meta-portfolios:'+db.workspaceId]);
 const old=(await db.query('SELECT version,selected FROM meta_portfolios WHERE workspace_id=$1 AND business_id=$2 FOR UPDATE',[db.workspaceId,id])).rows[0];metaNeed(old,'META_PORTFOLIO_NOT_FOUND',404);metaNeed(old.version===version,'META_PORTFOLIO_VERSION_CONFLICT');
 if(selected&&!old.selected){const n=(await db.query('SELECT count(*)::int n FROM meta_portfolios WHERE workspace_id=$1 AND selected',[db.workspaceId])).rows[0].n;metaNeed(n<metaPortfolioLimit,'META_PORTFOLIO_LIMIT');}
 await db.query('UPDATE meta_portfolios SET selected=$3,version=version+1 WHERE workspace_id=$1 AND business_id=$2',[db.workspaceId,id,selected]);
 if(!selected)await db.query("UPDATE meta_read_tasks SET status='CANCELLED',issue='{\"code\":\"META_PORTFOLIO_DESELECTED\"}',updated_at=clock_timestamp() WHERE workspace_id=$1 AND business_id=$2 AND status IN('PENDING','RUNNING')",[db.workspaceId,id]);
 if(selected)await resumeCancelledMetaTasks(db,'business_id',id,'META_PORTFOLIO_DESELECTED');
 await updateMetaOperations(db);return{id,version:version+1,selected};
}
export async function metaOperation(db:ProfileExecutor,key:string,request:Record<string,unknown>,actor:string){
 const inserted=await db.query('INSERT INTO meta_read_operations(workspace_id,request_key,request,actor_id) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,request_key) DO NOTHING RETURNING id',[db.workspaceId,key,request,actor]);
 const row=(await db.query('SELECT *,request=$3::jsonb same_request FROM meta_read_operations WHERE workspace_id=$1 AND request_key=$2',[db.workspaceId,key,request])).rows[0];metaNeed(row.same_request,'META_OPERATION_KEY_REUSED');return{...row,created:inserted.rows.length>0};
}
export async function enqueueMetaDiscovery(db:ProfileExecutor,id:string,actor:string,key?:string){
 const c=(await db.query('SELECT revision FROM meta_connections WHERE workspace_id=$1 AND id=$2 AND enabled',[db.workspaceId,id])).rows[0];metaNeed(c,'META_CONNECTION_NOT_FOUND',404);
 const op=await metaOperation(db,key??'discovery:'+id+':'+c.revision+':'+randomUUID(),{kind:'DISCOVERY',connection_id:id,revision:c.revision},actor);
 await db.query("INSERT INTO meta_read_tasks(workspace_id,operation_id,connection_id,credential_revision,kind,priority) VALUES($1,$2,$3,$4,'DISCOVERY',0) ON CONFLICT DO NOTHING",[db.workspaceId,op.id,id,c.revision]);return op.id as string;
}
export async function selectedMetaAccounts(db:ProfileExecutor,filter:{portfolio_id?:string;meta_ad_account_id?:string}={}){
 return (await db.query(`SELECT DISTINCT ON(a.meta_ad_account_id) a.*,c.legacy_revision FROM meta_account_access a
 JOIN meta_connections c ON(c.workspace_id,c.id)=(a.workspace_id,a.connection_id)
 JOIN meta_portfolios p ON(p.workspace_id,p.business_id)=(a.workspace_id,a.business_id)
 WHERE a.workspace_id=$1 AND a.accessible AND c.enabled AND c.state='VERIFIED' AND c.revision=a.credential_revision AND p.selected
 AND ($2::text IS NULL OR a.business_id=$2) AND ($3::text IS NULL OR a.meta_ad_account_id=$3)
 ORDER BY a.meta_ad_account_id,c.created_at,c.id`,[db.workspaceId,filter.portfolio_id??null,filter.meta_ad_account_id??null])).rows;
}
export async function validateMetaSelection(db:ProfileExecutor,filter:{portfolio_id?:string;meta_ad_account_id?:string}){
 if(filter.portfolio_id)metaNeed((await db.query('SELECT 1 FROM meta_portfolios WHERE workspace_id=$1 AND business_id=$2',[db.workspaceId,filter.portfolio_id])).rows[0],'META_PORTFOLIO_NOT_FOUND',404);
 if(filter.meta_ad_account_id){
  const row=(await db.query(`SELECT 1 FROM meta_insight_accounts WHERE workspace_id=$1 AND environment='REAL' AND meta_ad_account_id=$2
   UNION SELECT 1 FROM meta_account_access WHERE workspace_id=$1 AND meta_ad_account_id=$2`,[db.workspaceId,filter.meta_ad_account_id])).rows[0];metaNeed(row,'META_ACCOUNT_NOT_FOUND',404);
  if(filter.portfolio_id)metaNeed((await db.query('SELECT 1 FROM meta_account_portfolio_history WHERE workspace_id=$1 AND meta_ad_account_id=$2 AND business_id=$3',[db.workspaceId,filter.meta_ad_account_id,filter.portfolio_id])).rows[0],'META_ACCOUNT_PORTFOLIO_MISMATCH',400);
 }
}
export async function queueMetaWindows(db:ProfileExecutor,op:any,account:any,from:string,to:string,priority=10){
 for(const window of metaWindows(from,to))await db.query(`INSERT INTO meta_read_tasks(workspace_id,operation_id,connection_id,credential_revision,meta_ad_account_id,business_id,kind,range_from,range_to,priority)
 VALUES($1,$2,$3,$4,$5,$6,'INSIGHTS',$7,$8,$9) ON CONFLICT DO NOTHING`,[db.workspaceId,op.id,account.connection_id,account.credential_revision,account.meta_ad_account_id,account.business_id,window.from,window.to,priority]);
}
export async function requestMetaRead(db:ProfileExecutor,a:ProfileAuthority,input:MetaSyncInput){
 await auth(db,a,true);
 const request={kind:'MANUAL',portfolio_id:input.portfolio_id??null,meta_ad_account_id:input.meta_ad_account_id??null,from:input.from??null,to:input.to??null};
 const op=await metaOperation(db,'manual:'+input.operationId,request,a.membership.userId);
 if(!op.created)return{id:op.id,status:op.status,read_only:true};
 await validateMetaSelection(db,input);const accounts=await selectedMetaAccounts(db,input);metaNeed(accounts.length,'META_NO_SELECTED_ACCOUNTS');
 for(const account of accounts){const to=input.to??metaDate(account.timezone,new Date(op.created_at));metaNeed(to<=metaDate(account.timezone),'META_FUTURE_RANGE',400);await queueMetaWindows(db,op,account,input.from??shiftMetaDay(to,-6),to,2);}
 return{id:op.id,status:op.status,read_only:true};
}
export async function retryMetaRead(db:ProfileExecutor,a:ProfileAuthority,id:string){
 await auth(db,a,true);const op=(await db.query('SELECT id FROM meta_read_operations WHERE workspace_id=$1 AND id=$2',[db.workspaceId,id])).rows[0];metaNeed(op,'META_OPERATION_NOT_FOUND',404);
 await db.query(`UPDATE meta_read_tasks t SET status='PENDING',attempts=0,next_attempt_at=clock_timestamp(),lease_until=NULL,lease_token=NULL,issue=NULL,updated_at=clock_timestamp()
 FROM meta_connections c WHERE t.workspace_id=$1 AND t.operation_id=$2 AND t.status IN('PARTIAL','UNAVAILABLE') AND (c.workspace_id,c.id,c.revision)=(t.workspace_id,t.connection_id,t.credential_revision) AND c.enabled AND c.state<>'INVALID'`,[db.workspaceId,id]);
 await updateMetaOperations(db);return{id};
}
export async function updateMetaOperations(db:ProfileExecutor){
 await db.query(`UPDATE meta_read_operations o SET status=x.status,updated_at=clock_timestamp() FROM (
 SELECT operation_id,CASE WHEN bool_or(status='RUNNING') THEN 'RUNNING' WHEN bool_or(status='PENDING') THEN 'PENDING'
 WHEN bool_and(status='CANCELLED') THEN 'CANCELLED' WHEN bool_and(status='SYNCED') THEN 'SYNCED'
 WHEN bool_or(status='SYNCED') THEN 'PARTIAL' ELSE 'UNAVAILABLE' END status FROM meta_read_tasks WHERE workspace_id=$1 GROUP BY operation_id
 ) x WHERE o.workspace_id=$1 AND o.id=x.operation_id AND o.status<>x.status`,[db.workspaceId]);
}
export async function metaOperations(db:ProfileExecutor,id?:string):Promise<MetaOperationView[]>{
 const rows=(await db.query(`SELECT o.id,o.status,o.created_at,o.updated_at,count(t.id)::int total,
 count(t.id) FILTER(WHERE t.status='SYNCED')::int completed,count(t.id) FILTER(WHERE t.status IN('PARTIAL','UNAVAILABLE'))::int failed,
 count(t.id) FILTER(WHERE t.status IN('PENDING','RUNNING'))::int pending,array_agg(DISTINCT t.issue->>'code') FILTER(WHERE t.issue->>'code' IS NOT NULL) issues
 FROM meta_read_operations o LEFT JOIN meta_read_tasks t ON(t.workspace_id,t.operation_id)=(o.workspace_id,o.id)
 WHERE o.workspace_id=$1 AND ($2::uuid IS NULL OR o.id=$2) GROUP BY o.workspace_id,o.id ORDER BY (o.status IN('PENDING','RUNNING','PARTIAL','UNAVAILABLE')) DESC,o.created_at DESC LIMIT 30`,[db.workspaceId,id??null])).rows;
 return rows.map(r=>({id:r.id,status:r.status,createdAt:iso(r.created_at)!,updatedAt:iso(r.updated_at)!,total:r.total,completed:r.completed,failed:r.failed,pending:r.pending,issues:r.issues??[]}));
}
export async function metaInventory(db:ProfileExecutor):Promise<MetaInventoryView>{
 const connections=await connectionViews(db),portfolios=(await db.query('SELECT * FROM meta_portfolios WHERE workspace_id=$1 ORDER BY name,business_id',[db.workspaceId])).rows;
 const access=(await db.query(`SELECT a.*,c.enabled AND c.state='VERIFIED' AND c.revision=a.credential_revision AND a.accessible available FROM meta_account_access a JOIN meta_connections c ON(c.workspace_id,c.id)=(a.workspace_id,a.connection_id) WHERE a.workspace_id=$1 ORDER BY a.observed_at DESC,a.connection_id`,[db.workspaceId])).rows;
 const stored=(await db.query("SELECT * FROM meta_insight_accounts WHERE workspace_id=$1 AND environment='REAL'",[db.workspaceId])).rows;
 const histories=(await db.query('SELECT DISTINCT ON(meta_ad_account_id) * FROM meta_account_portfolio_history WHERE workspace_id=$1 ORDER BY meta_ad_account_id,valid_from DESC',[db.workspaceId])).rows;
 const tasks=(await db.query(`SELECT meta_ad_account_id,count(*) FILTER(WHERE status IN('PENDING','RUNNING'))::int pending,count(*) FILTER(WHERE status IN('UNAVAILABLE','PARTIAL'))::int failed FROM meta_read_tasks WHERE workspace_id=$1 GROUP BY meta_ad_account_id`,[db.workspaceId])).rows;
 const coverage=(await db.query(`SELECT cv.meta_ad_account_id,count(*)::int days FROM meta_insight_coverage cv JOIN meta_insight_accounts a USING(workspace_id,environment,meta_ad_account_id)
 WHERE cv.workspace_id=$1 AND cv.environment='REAL' AND COALESCE(cv.currency,a.currency)=a.currency AND COALESCE(cv.timezone,a.timezone)=a.timezone AND cv.day BETWEEN (clock_timestamp() AT TIME ZONE a.timezone)::date-89 AND (clock_timestamp() AT TIME ZONE a.timezone)::date GROUP BY cv.meta_ad_account_id`,[db.workspaceId])).rows;
 const ids=[...new Set([...access,...stored].map(r=>String(r.meta_ad_account_id)))];
 const accounts=ids.map(id=>{const row=access.find(a=>a.meta_ad_account_id===id)??stored.find(a=>a.meta_ad_account_id===id)!;
  const business=histories.find(h=>h.meta_ad_account_id===id),p=portfolios.find(p=>p.business_id===business?.business_id),s=stored.find(a=>a.meta_ad_account_id===id),t=tasks.find(t=>t.meta_ad_account_id===id);
  return{id,name:String(row.name),portfolioId:p?.business_id??null,portfolioName:p?.name??null,currency:row.currency,timezone:row.timezone,accessible:access.some(a=>a.meta_ad_account_id===id&&a.available),included:p?.selected??false,status:s?.status??'NOT_READ',lastSuccessAt:iso(s?.last_success_at),coveredDays:coverage.find(c=>c.meta_ad_account_id===id)?.days??0,historyDays:90,pendingTasks:t?.pending??0,failedTasks:t?.failed??0,ownerBasis:business?.basis??null};});
 return{connections,portfolios:portfolios.map(p=>({id:p.business_id,name:p.name,selected:p.selected,version:p.version,observedAt:iso(p.observed_at)!,accounts:accounts.filter(a=>a.portfolioId===p.business_id).length,accessibleAccounts:accounts.filter(a=>a.portfolioId===p.business_id&&a.accessible).length})),accounts,operations:await metaOperations(db),limit:metaPortfolioLimit,
 counts:{discoveredPortfolios:portfolios.length,selectedPortfolios:portfolios.filter(p=>p.selected).length,storedAccounts:ids.length,accessibleAccounts:accounts.filter(a=>a.accessible).length,includedAccounts:accounts.filter(a=>a.included).length,syncedAccounts:accounts.filter(a=>a.included&&a.status==='SYNCED').length}};
}
