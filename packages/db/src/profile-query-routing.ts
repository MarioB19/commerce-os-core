import {AsyncLocalStorage} from 'node:async_hooks';
import {currentWorkerProfile,withWorkerProfilePhase,rejectWorkerProfile} from './profile-worker-scope.js';
import {requestProfileScope,requestScopedConnection} from './profile-request-scope.js';
import type {ProfileExecutor,ProfileQuery} from './profile-context.js';

interface Scope {
 readonly source:ProfileExecutor;
 readonly executor:ProfileExecutor;
 active:boolean;
 rejected:boolean;
}
const storage=new AsyncLocalStorage<Scope>();
export class ProfileQueryRoutingError extends Error {
 constructor(readonly code:string){super(code);this.name='ProfileQueryRoutingError';}
}
function reject(scope:Scope,code:string):never{
 scope.rejected=true;
 throw new ProfileQueryRoutingError(code);
}
/** Undefined means no profile boundary, never an expired boundary. */
export function currentProfileExecutor(workspaceId?:string):ProfileExecutor|undefined{
 const scope=storage.getStore();
 if(!scope)return undefined;
 if(!scope.active)return reject(scope,'PROFILE_QUERY_CONTEXT_CLOSED');
 if(scope.rejected)return reject(scope,'PROFILE_QUERY_CONTEXT_REJECTED');
 if(workspaceId!==undefined&&workspaceId!==scope.executor.workspaceId)return reject(scope,'PROFILE_QUERY_CONTEXT_MISMATCH');
 return scope.executor;
}
/** Called inside an authorized transaction. This is query routing, not authority. */
export async function withProfileQueryRouting<T>(db:ProfileExecutor,work:()=>Promise<T>):Promise<T>{
 const parent=storage.getStore();
 if(parent){
  currentProfileExecutor(db.workspaceId);
  if(db!==parent.source&&db!==parent.executor)return reject(parent,'PROFILE_QUERY_EXECUTOR_MISMATCH');
  return joinProfileQueryWork(parent.executor,work);
 }
 const query:ProfileQuery=(sql,values)=>{
  // A borrowed query reference is checked at use, including after work finishes.
  try{
   if(!scope.active)return reject(scope,'PROFILE_QUERY_CONTEXT_CLOSED');
   if(storage.getStore()!==scope)return reject(scope,'PROFILE_QUERY_EXECUTION_MISMATCH');
   if(scope.rejected)return reject(scope,'PROFILE_QUERY_CONTEXT_REJECTED');
   return db.query(sql,values).catch(error=>{scope.rejected=true;throw error;});
  }catch(error){return Promise.reject(error);}
 };
 const scope:Scope={source:db,executor:Object.freeze({workspaceId:db.workspaceId,query}),active:true,rejected:false};
 return storage.run(scope,async()=>{
  try{
   const result=await work();
   if(scope.rejected)throw new ProfileQueryRoutingError('PROFILE_QUERY_CONTEXT_REJECTED');
   return result;
  }finally{scope.active=false;}
 });
}

/** A joined helper has no savepoint. Any failed callback therefore invalidates
 * the owning profile transaction, even if its caller catches the error.
 */
export async function joinProfileQueryWork<T>(db:ProfileExecutor,work:()=>Promise<T>):Promise<T>{
 const scope=storage.getStore();
 if(!scope||currentProfileExecutor(db.workspaceId)!==db)throw new ProfileQueryRoutingError('PROFILE_QUERY_CONTEXT_REQUIRED');
 try{return await work();}
 catch(error){scope.rejected=true;throw error;}
}

/** Retains the pool API outside a server-established profile transaction.
 * Inside it only promise-based, parameterized text queries are available.
 * connect/admin APIs are rejected; callers cannot acquire a second connection.
 */
export function profileRoutedPool<T extends {query:unknown;connect:unknown}>(pool:T):T{
 const query=(...args:unknown[])=>{
  const scope=storage.getStore();
  if(!scope){
   try{
    if(currentWorkerProfile()){
     if(args.length<1||args.length>2||typeof args[0]!=='string'||(args[1]!==undefined&&!Array.isArray(args[1])))return rejectWorkerProfile('WORKER_QUERY_SHAPE_REQUIRED');
     return withWorkerProfilePhase(db=>db.query(args[0] as string,args[1] as unknown[]|undefined));
    }
   }catch(error){return Promise.reject(error);}
   let request;
   try{request=requestProfileScope();}catch(error){return Promise.reject(error);}
   if(request){
    // Historical handlers keep their statement-by-statement semantics; each
    // statement runs on a connection bound to the authenticated profile. The
    // pool's own query() runs unchanged (callbacks, error release, observers)
    // over a view whose connect() hands out that bound connection.
    const scoped=Object.create(pool as object) as {connect:(callback:(error:unknown,client?:unknown,release?:unknown)=>void)=>void};
    scoped.connect=callback=>{requestScopedConnection(()=>(pool.connect as ()=>Promise<any>).apply(pool,[]),request).then(client=>callback(undefined,client,client.release),error=>callback(error));};
    return (pool.query as (...args:unknown[])=>unknown).apply(scoped,args);
   }
   return (pool.query as (...args:unknown[])=>unknown).apply(pool,args);
  }
  try{
   const db=currentProfileExecutor()!;
   if(args.length<1||args.length>2||typeof args[0]!=='string'||(args[1]!==undefined&&!Array.isArray(args[1])))return reject(scope,'PROFILE_QUERY_SHAPE_REQUIRED');
   return db.query(args[0],args[1] as unknown[]|undefined);
  }catch(error){return Promise.reject(error);}
 };
 const connect=(...args:unknown[])=>{
  const scope=storage.getStore();
  if(scope){
   try{currentProfileExecutor();return reject(scope,'PROFILE_RAW_CONNECTION_FORBIDDEN');}
   catch(error){return Promise.reject(error);}
  }
  try{if(currentWorkerProfile())return rejectWorkerProfile('WORKER_RAW_CONNECTION_FORBIDDEN');}
  catch(error){return Promise.reject(error);}
  let request;
  try{request=requestProfileScope();}catch(error){return Promise.reject(error);}
  if(request){
   const callback=typeof args[0]==='function'?args[0] as (error:unknown,client?:any,release?:unknown)=>void:undefined;
   const scoped=requestScopedConnection(()=>(pool.connect as ()=>Promise<any>).apply(pool,[]),request);
   if(callback){scoped.then(client=>callback(null,client,client.release),error=>callback(error));return undefined;}
   return scoped;
  }
  return (pool.connect as (...args:unknown[])=>unknown).apply(pool,args);
 };
 return new Proxy(pool,{
  get(target,key){
   if(key==='query')return query;
   if(key==='connect')return connect;
   const scope=storage.getStore();
   if(scope)return reject(scope,'PROFILE_POOL_ACCESS_FORBIDDEN');
   if(currentWorkerProfile())return rejectWorkerProfile('WORKER_POOL_ACCESS_FORBIDDEN');
   const value=Reflect.get(target,key,target);
   return typeof value==='function'?value.bind(target):value;
  },
  set(target,key,value){
   const scope=storage.getStore();
   if(scope)return reject(scope,'PROFILE_POOL_ACCESS_FORBIDDEN');
   if(currentWorkerProfile())return rejectWorkerProfile('WORKER_POOL_ACCESS_FORBIDDEN');
   return Reflect.set(target,key,value,target);
  },
 });
}

/** Legacy transaction callbacks keep their pg type outside this boundary. This
 * façade offers only query inside it; raw-client methods fail and poison work.
 */
export function profileQueryClient(db:ProfileExecutor):ProfileExecutor{
 const scope=storage.getStore();
 if(!scope||currentProfileExecutor()!==db)throw new ProfileQueryRoutingError('PROFILE_QUERY_CONTEXT_REQUIRED');
 return new Proxy(db,{
  get(target,key){
   currentProfileExecutor(db.workspaceId);
   if(key==='query'||key==='workspaceId')return Reflect.get(target,key,target);
   return reject(scope,'PROFILE_RAW_CLIENT_ACCESS_FORBIDDEN');
  },
 });
}
