import type {QueryExecutor} from './index.js';
export async function numberNow(c:QueryExecutor,workspace:string,environment:string){
 if(environment==='SIMULATION'){const run=(await c.query("SELECT virtual_now FROM warmup_simulation_runs WHERE execution_workspace=$1 AND input->>'scenario'='numbers-lifecycle' AND status IN('RUNNING','PAUSED')",[workspace])).rows[0];if(run)return new Date(run.virtual_now);}
 return new Date();
}
