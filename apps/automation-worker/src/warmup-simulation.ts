import {query,withTransaction} from '@commerce/db';
import {planWarmupPool} from './warmup.js';
/** Advance only the isolated virtual clock. Real leases and account evidence keep wall time. */
export async function processWarmupSimulations(){
 const runs=(await query("SELECT id FROM warmup_simulation_runs WHERE status='RUNNING' ORDER BY created_at")).rows;
 for(const row of runs)await withTransaction(async c=>{
  const run=(await c.query("SELECT * FROM warmup_simulation_runs WHERE id=$1 AND status='RUNNING' FOR UPDATE SKIP LOCKED",[row.id])).rows[0];if(!run)return;
  const pool=(await c.query('SELECT * FROM warmup_pools WHERE workspace_id=$1',[run.execution_workspace])).rows[0];if(!pool)return;
  const steps=Number(run.result?.virtual_steps??0);if(steps>=240){await c.query("UPDATE warmup_simulation_runs SET status='ATTENTION',version=version+1,updated_at=now(),result=result||'{\"reason\":\"SIMULATION_WINDOW_EXHAUSTED\"}'::jsonb WHERE id=$1",[run.id]);return;}
  const effects=(await c.query('SELECT o.status,t.received_envelope_id FROM outbox o JOIN warmup_turns t ON t.effect_id=o.id WHERE o.workspace_id=$1',[run.execution_workspace])).rows;
  if(effects.length&&effects.every(e=>['DELIVERED','READ'].includes(e.status)&&e.received_envelope_id)){await c.query("UPDATE warmup_simulation_runs SET status='COMPLETED',version=version+1,result=$2,updated_at=now() WHERE id=$1",[run.id,{conversation_completed:true,turns:effects.length,receipts:effects.length,acknowledged:effects.length,real_days_credited:0}]);return;}
  if(effects.some(e=>['UNKNOWN','FAILED'].includes(e.status))||run.input.fault==='peer_disconnected'){await c.query("UPDATE warmup_simulation_runs SET status='ATTENTION',virtual_now=virtual_now+interval '10 minutes',version=version+1,result=$2,updated_at=now() WHERE id=$1",[run.id,{conversation_completed:false,reason:run.input.fault==='peer_disconnected'?'PEER_DISCONNECTED':effects.some(e=>e.status==='UNKNOWN')?'UNKNOWN_REQUIRES_RECONCILIATION':'PROVIDER_REJECTED',retry_sent:false}]);return;}
  if(!effects.length){const plan=await planWarmupPool(c,pool,new Date(run.virtual_now));if(!plan.planned&&plan.reason==='QUIET_HOURS'){await c.query("UPDATE warmup_simulation_runs SET status='ATTENTION',version=version+1,updated_at=now(),result=result||'{\"reason\":\"QUIET_HOURS\"}'::jsonb WHERE id=$1",[run.id]);return;}await c.query('UPDATE warmup_conversations SET simulation_run_id=$2 WHERE workspace_id=$1 AND simulation_run_id IS NULL',[run.execution_workspace,run.id]);}
  await c.query("UPDATE warmup_simulation_runs SET virtual_now=virtual_now+interval '1 minute',version=version+1,result=result||jsonb_build_object('virtual_steps',$2::int),updated_at=now() WHERE id=$1",[run.id,steps+1]);
 });return runs.length;
}
