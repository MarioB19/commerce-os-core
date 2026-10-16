import {AsyncLocalStorage} from 'node:async_hooks';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from './profile-context.js';
import {withProfileQueryRouting,currentProfileExecutor,joinProfileQueryWork} from './profile-query-routing.js';

type WorkerRole='commerce_automation'|'commerce_channel';
type Environment='REAL'|'SIMULATION';
interface Identity {readonly workspaceId:string;readonly state:'ACTIVE'|'SUSPENDED';readonly version:number;readonly environment:Environment}
/** The public shape is informational. Only objects issued by discover work. */
export type WorkerProfileSelection=Readonly<Identity>;
interface Scope {readonly identity:Identity;readonly phase:<T>(work:(db:ProfileExecutor)=>Promise<T>)=>Promise<T>;active:boolean;rejected:boolean;readonly pending:Set<Promise<unknown>>}
const storage=new AsyncLocalStorage<Scope>();
export class WorkerProfileError extends Error {constructor(readonly code:string){super(code);this.name='WorkerProfileError';}}
function need(value:unknown,code:string):asserts value{if(!value)throw new WorkerProfileError(code);}
function scopeNow():Scope|undefined{
 const scope=storage.getStore();if(scope){need(scope.active,'WORKER_PROFILE_CLOSED');need(!scope.rejected,'WORKER_PROFILE_REJECTED');}return scope;
}
export function currentWorkerProfile(workspaceId?:string):WorkerProfileSelection|undefined{
 const scope=scopeNow();if(!scope)return undefined;
 if(workspaceId!==undefined&&workspaceId!==scope.identity.workspaceId){scope.rejected=true;throw new WorkerProfileError('WORKER_PROFILE_MISMATCH');}
 return scope.identity;
}
export function rejectWorkerProfile(code:string):never{
 const scope=storage.getStore();if(scope)scope.rejected=true;throw new WorkerProfileError(code);
}
export async function withWorkerProfilePhase<T>(work:(db:ProfileExecutor)=>Promise<T>):Promise<T>{
 const scope=scopeNow();need(scope,'WORKER_PROFILE_REQUIRED');
 const existing=currentProfileExecutor(scope.identity.workspaceId);
 if(existing)return joinProfileQueryWork(existing,()=>work(existing));
 const operation=scope.phase(work);scope.pending.add(operation);
 void operation.then(()=>scope.pending.delete(operation),()=>scope.pending.delete(operation));
 return operation;
}

/** Created by the server with its native worker pool and fixed deployment
 * environment. Neither a request body nor a Principal is a discovery input. */
export function createProfileWorkerRuntime(pool:ProfilePool,role:WorkerRole,environment:Environment){
 need(role==='commerce_automation'||role==='commerce_channel','WORKER_ROLE_INVALID');
 need(environment==='REAL'||environment==='SIMULATION','WORKER_ENVIRONMENT_INVALID');
 const selections=new WeakMap<object,Identity>();
 const roleCheck=async(db:{query:ProfileExecutor['query']})=>{
  const rows=(await db.query('SELECT current_user AS role')).rows;
  need(rows.length===1&&rows[0]?.role===role,'WORKER_NATIVE_ROLE_REQUIRED');
 };
 return Object.freeze({
  async discover():Promise<WorkerProfileSelection[]>{
   need(!currentWorkerProfile()&&!currentProfileExecutor(),'WORKER_DISCOVERY_OUTSIDE_PROFILE_REQUIRED');
   const c=await pool.connect();let begun=false;let discard:Error|undefined;
   try{
    await c.query('BEGIN');begun=true;await roleCheck(c);
    const rows=(await c.query('SELECT * FROM discover_worker_profiles()')).rows;
    need(rows.length<=3,'WORKER_PROFILE_INVENTORY_BOUND');const seen=new Set<string>();
    const identities=rows.map(row=>{
     need(typeof row.id==='string'&&row.id.length>0&&!row.id.includes('\0')&&!seen.has(row.id),'WORKER_DISCOVERY_INVALID');
     need((row.state==='ACTIVE'||row.state==='SUSPENDED')&&Number.isSafeInteger(row.version)&&row.version>0,'WORKER_DISCOVERY_INVALID');seen.add(row.id);
     return Object.freeze({workspaceId:row.id,state:row.state,version:row.version,environment}) as Identity;
    });
    const committed=await c.query('COMMIT');need(committed.command==='COMMIT','WORKER_DISCOVERY_COMMIT_UNCONFIRMED');begun=false;
    for(const identity of identities)selections.set(identity,identity);return identities;
   }catch(error){if(begun){try{await c.query('ROLLBACK');}catch{discard=new WorkerProfileError('WORKER_DISCOVERY_ROLLBACK_FAILED');}}else discard=new WorkerProfileError('WORKER_DISCOVERY_BEGIN_FAILED');throw error;}
   finally{c.release(discard);}
  },
  async run<T>(selection:WorkerProfileSelection,work:()=>Promise<T>):Promise<T>{
   need(!currentWorkerProfile()&&!currentProfileExecutor(),'WORKER_PROFILE_NESTING_FORBIDDEN');
   const identity=selection&&selections.get(selection);need(identity&&identity===selection,'WORKER_SELECTION_REQUIRED');
   selections.delete(selection);need(identity.state==='ACTIVE','WORKER_PROFILE_INACTIVE');
   const check=async(db:ProfileExecutor)=>{
    need(storage.getStore()===scope,'WORKER_EXECUTION_MISMATCH');scopeNow();
    await roleCheck(db);
    const rows=(await db.query('SELECT id,state,version FROM read_locked_continuous_worker_profile()')).rows;
    need(rows.length===1&&rows[0]?.id===identity.workspaceId&&rows[0]?.state==='ACTIVE'&&rows[0]?.version===identity.version,'WORKER_PROFILE_AUTHORITY_CHANGED');
    currentWorkerProfile(identity.workspaceId);
   };
   const scope:Scope={identity,active:true,rejected:false,pending:new Set(),phase:async(fn)=>withProfileTransaction(pool,identity.workspaceId,async db=>{
    await check(db);await db.query("SELECT pg_catalog.set_config('app.environment',$1,true)",[environment]);
    const value=await withProfileQueryRouting(db,()=>fn(currentProfileExecutor(identity.workspaceId)!));
    await check(db);return value;
   })};
   return storage.run(scope,async()=>{
    try{
     const value=await work();
     if(scope.pending.size){scope.active=false;await Promise.allSettled(scope.pending);throw new WorkerProfileError('WORKER_PHASE_NOT_AWAITED');}
     scopeNow();return value;
    }finally{scope.active=false;if(scope.pending.size)await Promise.allSettled(scope.pending);}
   });
  },
 });
}
