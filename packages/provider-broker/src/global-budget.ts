import type {QueryExecutor} from '../../db/src/index.js';
const fail=(code:string)=>Object.assign(new Error(code),{statusCode:409,code});
export interface GlobalBudgetState {mode:'EXPLICIT'|'MIGRATED_PROVIDER_LIMITS';limit_usd:number;spent_usd:number;reserved_usd:number;external_reserved_usd:number;unknown_cost_operations:number;available_usd:number;version:number;expires_at:string|null;blocked_reason:string|null}
/** The provider ledger is authoritative: UNKNOWN and confirmed receipts without prices retain reservations. */
export async function readGlobalBudget(db:QueryExecutor,workspaceId:string):Promise<GlobalBudgetState>{
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
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`creative-provider:${workspaceId}`]);
 const state=await readGlobalBudget(db,workspaceId);
 if(options.requireExplicit&&state.mode!=='EXPLICIT')throw fail('GLOBAL_BUDGET_EXPLICIT_REQUIRED');
 if(state.blocked_reason)throw fail(state.blocked_reason);
 if(Math.round(estimatedCostUsd*1e6)>Math.round(state.available_usd*1e6))throw fail('GLOBAL_BUDGET_EXCEEDED');
 return state;
}
