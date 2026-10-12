import {AsyncLocalStorage} from 'node:async_hooks';
import type {QueryResultRow,QueryResult} from 'pg';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor,type ProfileQuery} from './profile-context.js';
import {currentProfileExecutor,withProfileQueryRouting} from './profile-query-routing.js';
import {currentWorkerProfile} from './profile-worker-scope.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sha=/^[a-f0-9]{64}$/;
function need(value:unknown,code:string):asserts value{if(!value)throw Error(code);}
export interface NumberLabEngineIdentity {readonly database:string;readonly installationId:string;readonly engineSha256:string}
export interface NumberLabEngineBinding {readonly runId:string;readonly snapshotSha256:string;readonly operationId:string}
export interface NumberLabEngineLease {readonly runId:string;readonly snapshotSha256:string;readonly operationId:string}
export interface NumberLabEnginePorts {
 readonly workspaceId:string;
 readonly binding:NumberLabEngineBinding;
 readonly query:ProfileQuery;
 transaction<T>(work:(db:ProfileExecutor)=>Promise<T>):Promise<T>;
 /** Protected RF19 composition only; the original control authority is never replaced. */
 transactionUnderAuthority<T>(authority:NumberLabPhaseAuthority,work:(db:ProfileExecutor)=>Promise<T>):Promise<T>;
}
/** Trusted factory port for a separate control database. It holds native control
 * locks through the engine COMMIT and supplies its final native clock check.
 * The public lease/action cannot supply or replace this port. */
export interface NumberLabPhaseAuthority {
 withAuthority<T>(binding:NumberLabEngineBinding,work:(checkClock:()=>Promise<void>)=>Promise<T>):Promise<T>;
}
interface State {readonly authority?:NumberLabPhaseAuthority;readonly pool:ProfilePool;readonly identity:NumberLabEngineIdentity;readonly binding:NumberLabEngineBinding;active:boolean;used:boolean;rejected:boolean;pending:Set<Promise<unknown>>}
const leases=new WeakMap<object,State>();
const execution=new AsyncLocalStorage<State>();
const identitySql=`SELECT current_database() AS database,current_user AS role,
 r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication,r.rolcanlogin,r.rolinherit,
 EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS memberships,
 m.installation_id::text,m.engine_sha256,m.database_name
 FROM pg_roles r CROSS JOIN commerce_number_lab_engine.installation m
 WHERE r.rolname=current_user AND m.singleton=true`;
const bindingSql=`SELECT run_id::text,operation_id::text,snapshot_sha256,engine_sha256,workspace_id,
 state,expires_at>clock_timestamp() AS live
 FROM commerce_number_lab_engine.executions WHERE run_id=$1 AND operation_id=$2 FOR SHARE`;
async function verify(db:ProfileExecutor,state:State){
 const identities=(await db.query(identitySql)).rows,row=identities[0],id=state.identity,b=state.binding;
 need(identities.length===1&&row.database===id.database&&row.database_name===id.database&&row.role==='commerce_lab_engine'
  &&row.rolcanlogin===false&&row.rolinherit===false&&row.rolsuper===false&&row.rolbypassrls===false&&row.rolcreaterole===false&&row.rolcreatedb===false&&row.rolreplication===false&&row.memberships===false
  &&row.installation_id===id.installationId&&row.engine_sha256===id.engineSha256,'LAB_ENGINE_IDENTITY_REQUIRED');
 const bindings=(await db.query(bindingSql,[b.runId,b.operationId])).rows,r=bindings[0];
 need(bindings.length===1&&r.run_id===b.runId&&r.operation_id===b.operationId&&r.snapshot_sha256===b.snapshotSha256
  &&r.engine_sha256===id.engineSha256&&r.workspace_id===db.workspaceId&&r.state==='INTENT'&&r.live===true,'LAB_ENGINE_BINDING_REQUIRED');
}
function outside(){need(!currentProfileExecutor()&&!currentWorkerProfile(),'LAB_ENGINE_OUTER_SCOPE');}
async function phase<T>(state:State,work:(db:ProfileExecutor)=>Promise<T>,additional?:NumberLabPhaseAuthority):Promise<T>{
 need(state.active&&!state.rejected,'LAB_ENGINE_LEASE_CLOSED');need(!state.used||execution.getStore()===state,'LAB_ENGINE_EXECUTION_MISMATCH');outside();
 const run=async(checkClock:()=>Promise<void>)=>withProfileTransaction(state.pool,'number-lab:'+state.binding.runId,async db=>{
  need(state.active&&!state.rejected,'LAB_ENGINE_LEASE_CLOSED');await verify(db,state);
  await db.query("SELECT pg_catalog.set_config('app.environment','SIMULATION',true)");
  const value=await withProfileQueryRouting(db,()=>work(currentProfileExecutor(db.workspaceId)!));
  need(state.active&&!state.rejected,'LAB_ENGINE_LEASE_CLOSED');await verify(db,state);await checkClock();return value;
 });
 const controlled=(last:()=>Promise<void>)=>state.authority?state.authority.withAuthority(state.binding,check=>run(async()=>{await check();await last();})):run(last);
 try{return await (additional?additional.withAuthority(state.binding,controlled):controlled(async()=>undefined));}catch(error){state.rejected=true;throw error;}
}
/** The server supplies a dedicated pool and installed identity. No HTTP input
 * can mint a lease; a missing marker/role/execution fails before canonical SQL. */
export function createNumberLabEngineRuntime(pool:ProfilePool,input:NumberLabEngineIdentity,authority?:NumberLabPhaseAuthority){
 need(input&&Object.keys(input).sort().join(',')==='database,engineSha256,installationId'&&/^[a-z][a-z0-9_]{0,62}$/.test(input.database)&&uuid.test(input.installationId)&&sha.test(input.engineSha256),'LAB_ENGINE_CONFIGURATION');
 const identity=Object.freeze({...input});
 return Object.freeze({async lease(input:NumberLabEngineBinding):Promise<NumberLabEngineLease>{
  outside();need(input&&Object.keys(input).sort().join(',')==='operationId,runId,snapshotSha256'&&uuid.test(input.runId)&&uuid.test(input.operationId)&&sha.test(input.snapshotSha256),'LAB_ENGINE_BINDING');
  const binding=Object.freeze({...input}),state:State={pool,identity,binding,authority,active:true,used:false,rejected:false,pending:new Set()};
  await phase(state,async()=>undefined);state.active=false;
  const lease=Object.freeze({...binding});leases.set(lease,state);return lease;
 }});
}
/** A lease is live only for this awaited run. SQL phases never span provider IO. */
export async function withNumberLabEngine<T>(lease:NumberLabEngineLease,work:(ports:NumberLabEnginePorts)=>Promise<T>):Promise<T>{
 outside();const state=lease&&leases.get(lease);need(state&&!state.used&&!state.active&&!state.rejected,'LAB_ENGINE_LEASE_REQUIRED');state.used=true;state.active=true;
 const transaction=<V>(fn:(db:ProfileExecutor)=>Promise<V>,authority?:NumberLabPhaseAuthority)=>{
  if(!state.active||state.rejected)return Promise.reject(Error('LAB_ENGINE_LEASE_CLOSED'));
  // Concurrent phases on one operation could reorder canonical transitions.
  if(state.pending.size){state.rejected=true;return Promise.reject(Error('LAB_ENGINE_CONCURRENT_PHASE'));}
  const promise=phase(state,fn,authority);state.pending.add(promise);void promise.then(()=>state.pending.delete(promise),()=>state.pending.delete(promise));return promise;
 };
 const query:ProfileQuery=<Row extends QueryResultRow=any>(sql:string,values?:unknown[]):Promise<QueryResult<Row>>=>transaction(db=>db.query<Row>(sql,values));
 const ports=Object.freeze({workspaceId:'number-lab:'+state.binding.runId,binding:state.binding,query,transaction,transactionUnderAuthority:<V>(authority:NumberLabPhaseAuthority,fn:(db:ProfileExecutor)=>Promise<V>)=>transaction(fn,authority)});
 return execution.run(state,async()=>{try{const result=await work(ports);if(state.pending.size){state.active=false;await Promise.allSettled(state.pending);throw Error('LAB_ENGINE_UNAWAITED_PHASE');}need(!state.rejected,'LAB_ENGINE_REJECTED');return result;}
 finally{state.active=false;if(state.pending.size)await Promise.allSettled(state.pending);}});
}
