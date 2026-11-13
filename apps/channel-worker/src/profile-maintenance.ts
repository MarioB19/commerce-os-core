import {createDatabaseWorkerRuntime,pool,runtimeRoleLogin} from '../../../packages/db/src/index.js';
import {withWorkerProfilePhase,type WorkerProfileSelection} from '../../../packages/db/src/profile-worker-scope.js';
import {cancelExpiredUnsentEffects} from './expired-effects.js';
import {reconcileContinuousConnections} from './continuous-connections.js';
import {adoptAssignmentSendingPermits} from './sending-permits.js';

type Runtime={discover():Promise<WorkerProfileSelection[]>;run<T>(selection:WorkerProfileSelection,work:()=>Promise<T>):Promise<T>};
export type ProfileMaintenancePorts={runtime:Runtime;expire:typeof cancelExpiredUnsentEffects;connections:(workspaceId:string)=>Promise<{registered:number;deferred:number;failures:string[]}>;
 permits?:(workspaceId:string)=>Promise<{adopted:number;deferred:number;failures:string[]}>};
const code=(error:unknown)=>{const value=(error as {code?:string;message?:string})?.code??(error as {message?:string})?.message;return typeof value==='string'&&/^[A-Z0-9_]+$/.test(value)?value:'PROFILE_MAINTENANCE_FAILED';};
/** V7 F3 channel maintenance per discovered ACTIVE profile (REAL only):
 * cancel expired effects proven never sent, with record and no send; register
 * verified QR connections as permanent same-profile warm-up authority (D-17).
 * One profile's failure never stops the others; any failure is reported after
 * all profiles ran, so the loop shows it while durable facts are preserved. */
export async function runChannelProfileMaintenance(ports?:ProfileMaintenancePorts){
 if(!ports&&!runtimeRoleLogin)return{skipped:'RUNTIME_LOGIN_REQUIRED' as const,profiles:[]};
 const p=ports??{runtime:createDatabaseWorkerRuntime('commerce_channel','REAL'),expire:cancelExpiredUnsentEffects,connections:(workspaceId:string)=>reconcileContinuousConnections(pool,workspaceId,'REAL'),
  permits:(workspaceId:string)=>adoptAssignmentSendingPermits(pool,workspaceId)};
 const selections=await p.runtime.discover(),profiles:{profile:string;expired?:number;registered?:number;permits?:number;error?:string}[]=[];
 for(const selection of selections){
  if(selection.state!=='ACTIVE')continue;
  const row:{profile:string;expired?:number;registered?:number;permits?:number;error?:string}={profile:selection.workspaceId};
  try{
   row.expired=await p.runtime.run(selection,()=>withWorkerProfilePhase(db=>p.expire(db,100)));
   const connections=await p.connections(selection.workspaceId);row.registered=connections.registered;
   if(connections.failures.length)row.error=connections.failures[0];
   // V7.5.2 N01: permits of human assignments already in force (adopted once).
   if(p.permits){const permits=await p.permits(selection.workspaceId);row.permits=permits.adopted;if(permits.failures.length)row.error??=permits.failures[0];}
  }catch(error){row.error=code(error);}
  profiles.push(row);
 }
 const failed=profiles.find(row=>row.error);
 if(failed)throw Object.assign(new Error('PROFILE_MAINTENANCE_PARTIAL'),{code:'PROFILE_MAINTENANCE_PARTIAL',profiles});
 return{skipped:null,profiles};
}
