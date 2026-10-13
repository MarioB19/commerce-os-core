import {randomUUID} from 'node:crypto';
import {putRecord,withTransaction} from '../../packages/db/src/index.js';

/** V7 F8: the product simulator API (/v1/simulations) was retired; SIMULATION
 * lives only in the number laboratory and in engine tests. Engine tests start
 * and advance a scripted simulation with the same record and command the
 * retired route wrote, so the workflow engine is still exercised end to end. */
export async function startEngineSimulation(workspace:string,actor:string,input:{account_id:string;offer_version_id:string;contact_name?:string;workflow_version_id?:string}){
 return withTransaction(async c=>{
  const body={...input,contact_name:input.contact_name??'Contacto simulado'};
  const simulation=await putRecord(c,{workspaceId:workspace,environment:'SIMULATION',kind:'simulation',body:{...body,status:'PENDING',virtual_now:new Date().toISOString()}});
  const command=(await c.query("INSERT INTO commands(id,workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key) VALUES($1,$2,'SIMULATION','simulation_start',$3,$4,$5,$6) RETURNING id",[randomUUID(),workspace,simulation.id,actor,body,randomUUID()])).rows[0];
  return{id:simulation.id,command_id:command.id as string};
 });
}
export async function advanceEngineSimulation(workspace:string,actor:string,simulationId:string,payload:{seconds:number;message?:string;event?:string}){
 const row=(await withTransaction(c=>c.query("INSERT INTO commands(id,workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key) VALUES($1,$2,'SIMULATION','simulation_advance',$3,$4,$5,$6) RETURNING id",[randomUUID(),workspace,simulationId,actor,payload,randomUUID()]))).rows[0];
 return{id:row.id as string};
}
