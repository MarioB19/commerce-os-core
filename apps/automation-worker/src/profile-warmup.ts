import {createDatabaseWorkerRuntime,runtimeRoleLogin} from '../../../packages/db/src/index.js';
import {withWorkerProfilePhase,type WorkerProfileSelection} from '../../../packages/db/src/profile-worker-scope.js';
import type {ProfileExecutor} from '../../../packages/db/src/profile-context.js';
import {processQrWarmupProfile} from './warmup.js';

type Runtime={discover():Promise<WorkerProfileSelection[]>;run<T>(selection:WorkerProfileSelection,work:()=>Promise<T>):Promise<T>};
export type ProfileWarmupPorts={runtime:Runtime;process:(db:ProfileExecutor)=>Promise<{enrolled:unknown;results:unknown[];externalEffects:0}>};
const code=(error:unknown)=>{const value=(error as {code?:string;message?:string})?.code??(error as {message?:string})?.message;return typeof value==='string'&&/^[A-Z0-9_]+$/.test(value)?value:'PROFILE_WARMUP_FAILED';};
/** V7 F3 / D-17: QR-continuous warm-up of each discovered ACTIVE profile in its
 * own WorkerScope transaction (REAL). It plans only between numbers of that same
 * profile; it makes no provider call. LEGACY pools stay on processWarmup. */
export async function processProfileQrWarmup(ports?:ProfileWarmupPorts){
 if(!ports&&!runtimeRoleLogin)return{skipped:'RUNTIME_LOGIN_REQUIRED' as const,profiles:[]};
 const p=ports??{runtime:createDatabaseWorkerRuntime('commerce_automation','REAL'),process:(db:ProfileExecutor)=>processQrWarmupProfile(db,'REAL')};
 const profiles:{profile:string;planned?:number;error?:string}[]=[];
 for(const selection of await p.runtime.discover()){
  if(selection.state!=='ACTIVE')continue;
  try{const result=await p.runtime.run(selection,()=>withWorkerProfilePhase(db=>p.process(db)));profiles.push({profile:selection.workspaceId,planned:result.results.length});}
  catch(error){profiles.push({profile:selection.workspaceId,error:code(error)});}
 }
 const failed=profiles.find(row=>row.error);
 if(failed)throw Object.assign(new Error('PROFILE_WARMUP_PARTIAL'),{code:'PROFILE_WARMUP_PARTIAL',profiles});
 return{skipped:null,profiles};
}
