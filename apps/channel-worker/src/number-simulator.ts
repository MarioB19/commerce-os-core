import {SimulatorProvider,type ProviderGroup,type OutboundMessage,type MessagingProvider,type SendResult} from '@commerce/messaging';
import {pool,withTransaction,encrypt,hash} from '@commerce/db';
import type {DomainRecord} from '@commerce/contracts';
import {numberNow} from '../../../packages/db/src/number-clock.js';
/** Closed adapter: no fetch, socket, URL or externally supplied executable input. */
export async function numberSimulator(account:DomainRecord){
 if(account.environment!=='SIMULATION'||account.body.provider!=='simulator')throw new Error('SIMULATION_SCOPE_INVALID');
 const identity='wa:8'+BigInt('0x'+hash(account.id).slice(0,10)).toString().padStart(13,'0');
 // Reconstruct an explicit canonical stop; NEW keeps the existing simulator contract.
 let stopped=['STOPPED','DISCONNECTED'].includes(String(account.body.status));
 const provider:MessagingProvider=new SimulatorProvider(stopped?'FAILED':account.body.simulated_fault==='UNKNOWN'?'AMBIGUOUS':account.body.simulated_fault==='FAILED'?'FAILED':'WORKING',async(message:OutboundMessage,providerId:string)=>{
  const group=(await pool.query('SELECT * FROM number_simulation_groups WHERE workspace_id=$1 AND provider_id=$2',[account.workspace_id,message.recipient])).rows[0];if(!group){
   const turn=(await pool.query("SELECT t.recipient_id FROM warmup_turns t JOIN warmup_identities i ON i.account_id=t.recipient_id WHERE t.effect_id=$1 AND t.workspace_id=$2 AND t.environment='SIMULATION' AND i.address_fingerprint=$3",[message.effectId,account.workspace_id,hash(message.recipient)])).rows[0];if(!turn)return;
   const now=await numberNow(pool,account.workspace_id,'SIMULATION');
   const events=[{account:turn.recipient_id,event:{id:providerId+':message',type:'message',provider_message_id:providerId,identity,text:message.text,provider_at:now.toISOString()}},{account:account.id,event:{id:providerId+':ack',type:'ack',provider_message_id:providerId,status:'DELIVERED',provider_at:now.toISOString()}}];
   await withTransaction(async c=>{for(const item of events)await c.query("INSERT INTO inbound_envelopes(workspace_id,environment,account_id,provider,provider_event_id,payload_ciphertext,metadata,occurred_at) VALUES($1,'SIMULATION',$2,'simulator',$3,$4,$5,$6) ON CONFLICT DO NOTHING",[account.workspace_id,item.account,item.event.id,encrypt(item.event),{source:'number_simulator',external_network:false},now]);});return;
  }
  const now=await numberNow(pool,account.workspace_id,'SIMULATION');
  await withTransaction(async c=>{for(const recipient of group.account_ids.filter((id:string)=>id!==account.id)){
   const event={id:`${providerId}:${recipient}`,type:'message',provider_message_id:providerId,identity:message.recipient,group_id:message.recipient,sender_identity:identity,receiving_session:recipient,provider_at:now.toISOString(),text:message.text};
   if(group.fault==='peer_disconnected'&&recipient===group.account_ids[1])continue;
   if(['delay','out_of_order'].includes(group.fault)){const run=(await c.query("SELECT id FROM warmup_simulation_runs WHERE execution_workspace=$1 AND input->>'scenario'='numbers-lifecycle'",[account.workspace_id])).rows[0];if(!run)throw new Error('SIMULATION_CLOCK_REQUIRED');const delay=group.fault==='delay'?240000:recipient===group.account_ids[1]?3000:1000;await c.query('INSERT INTO warmup_simulated_events(run_id,effect_id,account_id,event_key,event,due_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[run.id,message.effectId,recipient,event.id,event,new Date(now.getTime()+delay)]);continue;}
   await c.query("INSERT INTO inbound_envelopes(workspace_id,environment,account_id,provider,provider_event_id,payload_ciphertext,metadata,occurred_at) VALUES($1,'SIMULATION',$2,'simulator',$3,$4,$5,$6) ON CONFLICT DO NOTHING",[account.workspace_id,recipient,event.id,encrypt(event),{source:'number_simulator',external_network:false},now]);
   if(group.fault==='duplicate')await c.query("INSERT INTO inbound_envelopes(workspace_id,environment,account_id,provider,provider_event_id,payload_ciphertext,metadata,occurred_at) VALUES($1,'SIMULATION',$2,'simulator',$3,$4,$5,$6) ON CONFLICT DO NOTHING",[account.workspace_id,recipient,event.id+':duplicate',encrypt(event),{source:'number_simulator',external_network:false},now]);
  }});
 });
 const originalLifecycle=provider.lifecycle.bind(provider);
 provider.lifecycle=async action=>{const result=await originalLifecycle(action);stopped=action==='stop'||action==='logout';return stopped?{status:'STOPPED'}:result;};
 const originalSend=provider.send.bind(provider);
 provider.send=async(message:OutboundMessage):Promise<SendResult>=>{if(stopped)return{status:'REJECTED',reason:'SIMULATED_SESSION_STOPPED'};const fixture=(await pool.query('SELECT fault FROM number_simulation_groups WHERE workspace_id=$1 AND provider_id=$2',[account.workspace_id,message.recipient])).rows[0];if(fixture?.fault==='rejected')return{status:'REJECTED',reason:'SIMULATED_REJECTED'};if(fixture?.fault==='slow_gateway')await new Promise(resolve=>setTimeout(resolve,1200));const result=await originalSend(message);return fixture?.fault==='accepted_timeout'?{status:'UNKNOWN',reason:'SIMULATED_ACCEPTED_WITH_LOST_RESPONSE'}:result;};
 provider.profile=async()=>({identity,name:String(account.body.name)});
 provider.health=async()=>{const now=await numberNow(pool,account.workspace_id,'SIMULATION');return[{dimension:'session',status:stopped||account.body.status==='FAILED'?'BLOCKED':'OK',value:stopped?'STOPPED':'WORKING',source:'local_probe',scope:'account',availability:'supported',observedAt:now.toISOString(),expiresAt:new Date(now.getTime()+60000).toISOString()},{dimension:'transport',status:'OK',value:{identity_fingerprint:hash(identity),identity_verified:true},source:'local_probe',scope:'account',availability:'supported',observedAt:now.toISOString(),expiresAt:new Date(now.getTime()+60000).toISOString()}];};
 const listGroups=async({offset,limit}:{offset:number;limit:number})=>{const rows=(await pool.query('SELECT * FROM number_simulation_groups WHERE workspace_id=$1 AND $2=ANY(account_ids) ORDER BY id LIMIT $3 OFFSET $4',[account.workspace_id,account.id,limit+1,offset])).rows;return{groups:rows.slice(0,limit).map(g=>({id:g.provider_id,name:g.name})),hasMore:rows.length>limit};};
 const group=async(id:string):Promise<ProviderGroup>=>{const row=(await pool.query('SELECT * FROM number_simulation_groups WHERE workspace_id=$1 AND provider_id=$2 AND $3=ANY(account_ids)',[account.workspace_id,id,account.id])).rows[0];if(!row)throw new Error('SIMULATION_GROUP_NOT_FOUND');if(row.fault==='slow_gateway')await new Promise(resolve=>setTimeout(resolve,1200));const now=await numberNow(pool,account.workspace_id,'SIMULATION');return{id:row.provider_id,name:row.name,complete:true,adminOnly:row.admin_only,observedAt:now.toISOString(),runtime:{version:'numbers-simulator/v1',engine:'SIMULATOR'},members:row.account_ids.map((id:string)=>{const identity='wa:8'+BigInt('0x'+hash(id).slice(0,10)).toString().padStart(13,'0');return{identity,verifiedIdentity:identity,admin:false,mappingSource:'provider_identity'};})};};
 return Object.assign(provider,{listGroups,group});
}
