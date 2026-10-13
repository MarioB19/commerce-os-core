import pg from 'pg';
import type {ProfilePool} from '../../../packages/db/src/profile-context.js';
import {projectProfileResults} from '../../../packages/db/src/result-projection-worker.js';
import {createDatabaseWorkerRuntime,runtimeRoleLogin} from '@commerce/db';

/** V7 F7 (RF-12.j): Resultados reads persisted anonymous aggregates. This loop
 * projects each profile with the reviewed `commerce_results` login (its own
 * RESULTS_DATABASE_URL), one repeatable-read snapshot per profile. Without the
 * login the loop does nothing; Resultados then shows the last projection. */
let pool:ProfilePool|null|undefined,native:pg.Pool|undefined;
export function resultsPool():ProfilePool|null{
 if(pool!==undefined)return pool;
 const url=process.env.RESULTS_DATABASE_URL;if(!url){pool=null;return null;}
 native=new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:30000});
 native.on('error',()=>{process.stderr.write('result_projection_idle_connection_failed\n');});
 pool={async connect(){const c=await native!.connect();try{await c.query('SET ROLE commerce_results');return{query:c.query.bind(c),release:c.release.bind(c)};}catch(e){c.release(true);throw e;}}};
 return pool;
}
const code=(error:unknown)=>error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'UNEXPECTED';
export async function processResultProjections(deps:{pool?:ProfilePool|null;workers?:ReturnType<typeof createDatabaseWorkerRuntime>}={}){
 const target=deps.pool!==undefined?deps.pool:resultsPool();if(!target)return 0;
 if(!deps.workers&&!runtimeRoleLogin)return 0;
 const runtime=deps.workers??createDatabaseWorkerRuntime('commerce_automation','REAL');
 let profiles;try{profiles=await runtime.discover();}catch(error){process.stderr.write(`result_projection_discovery_failed ${code(error)}\n`);return 0;}
 let projected=0;
 for(const profile of profiles){
  if(profile.state!=='ACTIVE'&&profile.state!=='SUSPENDED')continue;
  try{await projectProfileResults(target,profile.workspaceId);projected++;}
  catch(error){process.stderr.write(`result_projection_failed ${code(error)}\n`);}
 }
 return projected;
}
