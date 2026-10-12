import {AsyncLocalStorage} from 'node:async_hooks';
import {profileIdSchema} from '../../contracts/src/profiles.js';

/** Profile context for one authenticated HTTP request whose handler predates
 * the single-transaction SQL routes. The server creates it only after it has
 * resolved the request's authority; nothing in the request selects it.
 *
 * Every connection taken from the routed pool while the scope is active
 * carries `app.workspace_id` (and `app.environment` once the route has parsed
 * its environment) at session level, and is reset before it returns to the
 * pool. Row-level security therefore binds each historical query, including
 * independent statements around external calls, to exactly this profile. */
type Environment='REAL'|'SIMULATION';
interface Scope {readonly workspaceId:string;environment:Environment|undefined;active:boolean}
const storage=new AsyncLocalStorage<Scope>();
export class RequestProfileScopeError extends Error {
 readonly statusCode=500;
 constructor(readonly code:string){super(code);this.name='RequestProfileScopeError';}
}
function need(value:unknown,code:string):asserts value{if(!value)throw new RequestProfileScopeError(code);}

/** Run `next` (the remaining request lifecycle) inside the profile scope. */
export function runInRequestProfileScope<T>(workspaceId:string,next:()=>T):T{
 need(profileIdSchema.safeParse(workspaceId).success,'REQUEST_PROFILE_SCOPE_INVALID');
 need(!storage.getStore(),'REQUEST_PROFILE_SCOPE_NESTED');
 return storage.run({workspaceId,environment:undefined,active:true},next);
}
export function requestProfileScope():Readonly<{workspaceId:string;environment:Environment|undefined}>|undefined{
 const scope=storage.getStore();
 if(!scope)return undefined;
 need(scope.active,'REQUEST_PROFILE_SCOPE_CLOSED');
 return{workspaceId:scope.workspaceId,environment:scope.environment};
}
/** The route's parsed environment; it can be bound once and never switched. */
export function bindRequestProfileEnvironment(environment:Environment){
 const scope=storage.getStore();
 if(!scope)return;
 need(scope.active,'REQUEST_PROFILE_SCOPE_CLOSED');
 need(environment==='REAL'||environment==='SIMULATION','REQUEST_PROFILE_ENVIRONMENT_INVALID');
 need(scope.environment===undefined||scope.environment===environment,'REQUEST_PROFILE_ENVIRONMENT_CHANGED');
 scope.environment=environment;
}
/** Late callbacks of a finished request cannot reuse its profile context. */
export function closeRequestProfileScope(){const scope=storage.getStore();if(scope)scope.active=false;}

interface Client {query:(...args:any[])=>any;release:(error?:Error|boolean)=>void}
const install="SELECT pg_catalog.set_config('app.workspace_id',$1,false),pg_catalog.set_config('app.environment',$2,false)";
const reset="SELECT pg_catalog.set_config('app.workspace_id','',false),pg_catalog.set_config('app.environment','',false)";
/** A pooled connection bound to the active request scope until release. */
export async function requestScopedConnection<C extends Client>(connect:()=>Promise<C>,scope:{workspaceId:string;environment:Environment|undefined}):Promise<C>{
 const client=await connect();
 try{await client.query(install,[scope.workspaceId,scope.environment??'']);}
 catch(error){client.release(error instanceof Error?error:true);throw error;}
 const release=client.release.bind(client);let released=false;
 client.release=((error?:Error|boolean)=>{
  if(released)return;released=true;
  // A connection whose reset is not confirmed is discarded, never reused.
  if(error){release(error);return;}
  Promise.resolve(client.query(reset)).then(()=>release(),failure=>release(failure instanceof Error?failure:true));
 }) as C['release'];
 return client;
}
