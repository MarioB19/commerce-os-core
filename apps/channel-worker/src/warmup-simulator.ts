import type {DomainRecord} from '@commerce/contracts';
import {pool,withTransaction,encrypt} from '@commerce/db';
import {SimulatorProvider,type OutboundMessage} from '@commerce/messaging';
export async function warmupSimulator(account:DomainRecord){
 const run=(await pool.query("SELECT * FROM warmup_simulation_runs WHERE id=$1 AND execution_workspace=$2",[account.body.simulation_run_id,account.workspace_id])).rows[0];if(!run||account.environment!=='SIMULATION')throw new Error('SIMULATION_SCOPE_INVALID');
 const fault=run.input.fault,state=fault==='rejected'?'FAILED':fault==='accepted_timeout'?'AMBIGUOUS':'WORKING';
 const provider=new SimulatorProvider(state,async(message:OutboundMessage,providerId:string)=>{
  await withTransaction(async c=>{
   const effect=(await c.query("SELECT o.*,t.recipient_id FROM outbox o JOIN warmup_turns t ON t.effect_id=o.id WHERE o.id=$1 AND o.workspace_id=$2 AND o.environment='SIMULATION'",[message.effectId,account.workspace_id])).rows[0];if(!effect)throw new Error('SIMULATION_EFFECT_SCOPE_INVALID');
   const virtual=(await c.query('SELECT virtual_now FROM warmup_simulation_runs WHERE id=$1',[run.id])).rows[0].virtual_now as Date,delay=fault==='delay'?240000:1000;
   const inbound={id:providerId+':message',type:'message',provider_message_id:providerId,identity:account.body.virtual_identity,text:message.text,kind:message.kind,provider_at:new Date(virtual.getTime()+delay).toISOString()},ack={id:providerId+':ack',type:'ack',status:'DELIVERED',provider_message_id:providerId,biz_opaque_callback_data:effect.id,provider_at:new Date(virtual.getTime()+delay+1000).toISOString()};
   const events=[{target:effect.recipient_id,event:inbound,due:delay+(fault==='out_of_order'?3000:0)},{target:account.id,event:ack,due:delay+1000}];
   if(fault==='duplicate'){events.push({...events[0]!,event:{...inbound,id:inbound.id+':duplicate'},due:delay+2000});events.push({...events[1]!,event:{...ack,id:ack.id+':duplicate'},due:delay+3000});}
   for(const e of events)await c.query('INSERT INTO warmup_simulated_events(run_id,effect_id,account_id,event_key,event,due_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[run.id,effect.id,e.target,e.event.id,e.event,new Date(virtual.getTime()+e.due)]);
  });
 });
 if(fault==='rejected'||fault==='accepted_timeout')provider.health=()=>new SimulatorProvider().health();
 return provider;
}
export async function flushWarmupSimulatedEvents(){
 return withTransaction(async c=>{const events=(await c.query("SELECT e.*,r.execution_workspace FROM warmup_simulated_events e JOIN warmup_simulation_runs r ON r.id=e.run_id WHERE e.enqueued_at IS NULL AND e.due_at<=r.virtual_now AND r.status IN('RUNNING','ATTENTION') FOR UPDATE OF e SKIP LOCKED")).rows;
 for(const e of events){await c.query("INSERT INTO inbound_envelopes(workspace_id,environment,account_id,provider,provider_event_id,payload_ciphertext,metadata,occurred_at) VALUES($1,'SIMULATION',$2,'simulator',$3,$4,$5,$6) ON CONFLICT DO NOTHING",[e.execution_workspace,e.account_id,e.event_key,encrypt(e.event),{simulation_run_id:e.run_id,effect_id:e.effect_id},e.due_at]);await c.query('UPDATE warmup_simulated_events SET enqueued_at=now() WHERE id=$1',[e.id]);}return events.length;});
}

/** Only virtual run accounts may acquire an isolated simulator lease automatically. */
export async function prepareWarmupSimulationAccounts(owner:string,observeHealth?:(account:DomainRecord)=>Promise<unknown>){
 const accounts=(await pool.query("SELECT a.* FROM records a JOIN warmup_simulation_runs r ON r.id::text=a.body->>'simulation_run_id' AND r.execution_workspace=a.workspace_id WHERE a.environment='SIMULATION' AND a.kind='channel_account' AND a.body->>'provider'='simulator' AND r.status='RUNNING'")).rows as DomainRecord[];
 for(const account of accounts){
  await withTransaction(async c=>{await c.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,frozen,lease_expires_at) VALUES($1,$2,$3,1,false,now()+interval '60 seconds') ON CONFLICT(account_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,generation=CASE WHEN session_ownership.owner_id=EXCLUDED.owner_id THEN session_ownership.generation ELSE session_ownership.generation+1 END,frozen=false,lease_expires_at=EXCLUDED.lease_expires_at WHERE session_ownership.owner_id=EXCLUDED.owner_id OR session_ownership.lease_expires_at<now()",[account.id,account.workspace_id,owner]);});
  // A newly created virtual run must not wait behind unrelated accounts in
  // the global periodic health queue. This callback is SIMULATION-only.
  const checkedAt=Date.parse(String(account.body.health_checked_at??''));
  if(observeHealth&&(!Number.isFinite(checkedAt)||Date.now()-checkedAt>25_000))await observeHealth(account);
 }
 return accounts.length;
}
