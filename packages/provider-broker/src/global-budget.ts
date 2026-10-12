import type {QueryExecutor} from '../../db/src/index.js';
import {currentProfileExecutor} from '../../db/src/profile-query-routing.js';
import {currentWorkerProfile,withWorkerProfilePhase} from '../../db/src/profile-worker-scope.js';
const fail=(code:string)=>Object.assign(new Error(code),{statusCode:409,code});
export interface GlobalBudgetState {mode:'EXPLICIT'|'MIGRATED_PROVIDER_LIMITS';limit_usd:number;spent_usd:number;reserved_usd:number;external_reserved_usd:number;unknown_cost_operations:number;available_usd:number;version:number;expires_at:string|null;blocked_reason:string|null}
/** The provider ledger is authoritative: UNKNOWN and confirmed receipts without prices retain reservations. */
export async function readGlobalBudget(db:QueryExecutor,workspaceId:string):Promise<GlobalBudgetState>{
 const scoped=currentProfileExecutor(workspaceId);
 if(scoped){
  const rows=(await scoped.query('SELECT * FROM public.read_profile_global_budget($1)',[workspaceId])).rows;
  if(rows.length!==1)throw fail('GLOBAL_BUDGET_STATE_INVALID');const r=rows[0];
  const amount=(key:string)=>{if(typeof r[key]!=='string'||!/^\d+(?:\.\d+)?$/.test(r[key]))throw fail('GLOBAL_BUDGET_STATE_INVALID');const n=Number(r[key]);if(!Number.isFinite(n))throw fail('GLOBAL_BUDGET_STATE_INVALID');return n;};
  const limit=amount('limit_usd'),spent=amount('spent_usd'),reserved=amount('reserved_usd'),external=amount('external_reserved_usd'),unknown=amount('unknown_cost_operations');
  if(typeof r.configured!=='boolean'||typeof r.expired!=='boolean'||typeof r.external_expired!=='boolean'||!['NONE','KNOWN','UNKNOWN'].includes(r.external_status)||!Number.isSafeInteger(r.version)||r.version<0||!Number.isSafeInteger(unknown)||r.configured&&r.version<1||!r.configured&&(r.version!==0||r.expires_at!==null))throw fail('GLOBAL_BUDGET_STATE_INVALID');
  if(r.configured&&(!(r.expires_at instanceof Date)&&typeof r.expires_at!=='string'||!Number.isFinite(new Date(r.expires_at).getTime())))throw fail('GLOBAL_BUDGET_STATE_INVALID');
  const expiry=r.configured?new Date(r.expires_at).toISOString():null;
  const blocked=r.expired?'GLOBAL_BUDGET_EXPIRED':r.external_status==='UNKNOWN'?'GLOBAL_EXTERNAL_COST_UNKNOWN':r.external_status==='KNOWN'&&r.external_expired?'GLOBAL_EXTERNAL_SNAPSHOT_EXPIRED':spent+reserved+external>limit?'GLOBAL_BUDGET_OVERCOMMITTED':null;
  return{mode:r.configured?'EXPLICIT':'MIGRATED_PROVIDER_LIMITS',limit_usd:limit,spent_usd:spent,reserved_usd:reserved,external_reserved_usd:external,unknown_cost_operations:unknown,available_usd:Math.max(0,Math.round((limit-spent-reserved-external)*1e6)/1e6),version:r.version,expires_at:expiry,blocked_reason:blocked};
 }
 if(currentWorkerProfile(workspaceId))return withWorkerProfilePhase(c=>readGlobalBudget(c,workspaceId));
 const aggregate=(await db.query('SELECT COALESCE(sum(limit_usd),0) AS limit_usd,COALESCE(sum(spent_usd),0) AS spent_usd,COALESCE(sum(reserved_usd),0) AS reserved_usd FROM creative_budgets WHERE workspace_id=$1',[workspaceId])).rows[0];
 const configured=(await db.query('SELECT *,expires_at<=clock_timestamp() AS expired,external_expires_at<=clock_timestamp() AS external_expired FROM creative_global_budgets WHERE workspace_id=$1',[workspaceId])).rows[0];
 const unknown=Number((await db.query("SELECT (SELECT count(*) FROM creative_provider_operations WHERE workspace_id=$1 AND (status='UNKNOWN' OR status='CONFIRMED' AND confirmed_cost IS NULL))+(SELECT count(*) FROM integration_diagnostics WHERE workspace_id=$1 AND (status='UNKNOWN' OR status='PARTIAL' AND confirmed_cost_usd IS NULL)) count",[workspaceId])).rows[0].count);
 const limit=Number(configured?.limit_usd??aggregate.limit_usd),spent=Number(aggregate.spent_usd),reserved=Number(aggregate.reserved_usd),external=Number(configured?.external_reserved_usd??0);
 const blocked=configured?.expired?'GLOBAL_BUDGET_EXPIRED':configured?.external_status==='UNKNOWN'?'GLOBAL_EXTERNAL_COST_UNKNOWN':configured?.external_status==='KNOWN'&&configured.external_expired?'GLOBAL_EXTERNAL_SNAPSHOT_EXPIRED':spent+reserved+external>limit?'GLOBAL_BUDGET_OVERCOMMITTED':null;
 return{mode:configured?'EXPLICIT':'MIGRATED_PROVIDER_LIMITS',limit_usd:limit,spent_usd:spent,reserved_usd:reserved,external_reserved_usd:external,unknown_cost_operations:unknown,available_usd:Math.max(0,Math.round((limit-spent-reserved-external)*1e6)/1e6),version:configured?.version??0,expires_at:configured?new Date(configured.expires_at).toISOString():null,blocked_reason:blocked};
}
/** Call inside the same transaction immediately before the existing provider reservation UPDATE. */
export async function assertGlobalBudgetCapacity(db:QueryExecutor,workspaceId:string,estimatedCostUsd:number,options:{requireExplicit?:boolean}={}):Promise<GlobalBudgetState>{
 if(!Number.isFinite(estimatedCostUsd)||estimatedCostUsd<0)throw fail('GLOBAL_BUDGET_ESTIMATE_INVALID');
 if(currentWorkerProfile(workspaceId)&&!currentProfileExecutor(workspaceId))throw fail('GLOBAL_BUDGET_TRANSACTION_REQUIRED');
 await (currentProfileExecutor(workspaceId)??db).query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`creative-provider:${workspaceId}`]);
 const state=await readGlobalBudget(db,workspaceId);
 if(options.requireExplicit&&state.mode!=='EXPLICIT')throw fail('GLOBAL_BUDGET_EXPLICIT_REQUIRED');
 if(state.blocked_reason)throw fail(state.blocked_reason);
 if(Math.round(estimatedCostUsd*1e6)>Math.round(state.available_usd*1e6))throw fail('GLOBAL_BUDGET_EXCEEDED');
 return state;
}
