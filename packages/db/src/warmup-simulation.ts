import type {QueryExecutor} from './index.js';
import {hash,encrypt,stableJson,putRecord,uuid,readOperationalSettings} from './index.js';
import {warmupProfileSchema} from '../../domain/src/warmup/policy.js';
export type WarmupSimulationInput={seed:number;at:string;participants:2|3;fault:'none'|'delay'|'duplicate'|'out_of_order'|'accepted_timeout'|'rejected'|'peer_disconnected'};
/** Virtual participants are provider fixtures, never sales contacts or real identities. */
export async function createWarmupSimulation(c:QueryExecutor,workspace:string,input:WarmupSimulationInput){
 const id=uuid(),execution=workspace+':warmup:'+id,now=new Date(input.at),profile=warmupProfileSchema.parse({name:'Laboratorio conversacional',mode:'inbound-light',policy_version:'inbound-light/v1',timezone:'UTC',start_hour:0,end_hour:23,weekend_factor:1,jitter_seconds:0,rate_per_minute:2});
 await c.query("INSERT INTO warmup_simulation_runs(id,workspace_id,execution_workspace,seed,virtual_now,input) VALUES($1,$2,$3,$4,$5,$6)",[id,workspace,execution,input.seed,now,input]);
 const p=(await c.query("INSERT INTO warmup_profiles(workspace_id,environment,config) VALUES($1,'SIMULATION',$2) RETURNING id",[execution,profile])).rows[0];
 const group=(await c.query("INSERT INTO warmup_pools(workspace_id,environment,profile_id,enabled,allow_small_pool_concentration) VALUES($1,'SIMULATION',$2,true,true) RETURNING *",[execution,p.id])).rows[0],ids:string[]=[];
 for(let i=0;i<input.participants;i++){
  const digest=hash(id),accountId=`${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,30)}${String(i).padStart(2,'0')}`,identity='opaque:virtual-'+hash(String(input.seed)+':'+i).slice(0,20),account=await putRecord(c,{id:accountId,workspaceId:execution,environment:'SIMULATION',kind:'channel_account',body:{name:'Virtual '+(i+1),provider:'simulator',status:input.fault==='peer_disconnected'&&i===1?'FAILED':'WORKING',sending_enabled:false,simulation_run_id:id,virtual_identity:identity}});ids.push(account.id);
  const ident=(await c.query("INSERT INTO warmup_identities(workspace_id,environment,account_id,address_fingerprint,address_ciphertext,profile_ciphertext,ownership_evidence,profile_verified_at) VALUES($1,'SIMULATION',$2,$3,$4,$5,'SIMULATION fixture identity only',$6) RETURNING id",[execution,account.id,hash(identity),encrypt(identity),encrypt({name:'Virtual '+(i+1),about:'Laboratorio sin red externa'}),new Date(now.getTime()-25*3600000)])).rows[0];
  await c.query("INSERT INTO warmup_states(account_id,workspace_id,environment,pool_id,profile_id,identity_id,status,enrolled_at,profile_ready_at) VALUES($1,$2,'SIMULATION',$3,$4,$5,'WARMING',$6,$6)",[account.id,execution,group.id,p.id,ident.id,new Date(now.getTime()-25*3600000)]);
 }
 const content={label:'Conversación de laboratorio '+input.seed,turns:Array.from({length:6},(_,i)=>({kind:'text',text:['Hola, comprobamos esta conversación propia.','Recibido. Confirmo recepción del primer mensaje.','Continuamos la prueba del siguiente turno.','Recibido el siguiente turno, respondo.','Última comprobación de recepción y entrega.','Conversación de prueba recibida.'][i]}))};
 const material=(await c.query("INSERT INTO warmup_content(workspace_id,environment,content_hash,body,approved_by) VALUES($1,'SIMULATION',$2,$3,'simulator-fixture') RETURNING id",[execution,hash(stableJson(content)),content])).rows[0];
 const materialIds=[material.id];if(input.participants===3){const extra={...content,label:content.label+' · compañero adicional',turns:content.turns.map(t=>({...t,text:t.text+' Prueba del compañero adicional.'}))};materialIds.push((await c.query("INSERT INTO warmup_content(workspace_id,environment,content_hash,body,approved_by) VALUES($1,'SIMULATION',$2,$3,'simulator-fixture') RETURNING id",[execution,hash(stableJson(extra)),extra])).rows[0].id);}
 const settings=await readOperationalSettings(c,execution,'SIMULATION'),scope={mode:'warmup',pool_id:group.id,account_ids:ids,content_ids:materialIds,max_messages:50,allow_profile_updates:false,simulation_run_id:id};
 const auth=(await c.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at,configuration_version) VALUES($1,'SIMULATION','simulator-fixture',$2,$3,now()+interval '1 day',$4) RETURNING id",[execution,scope,hash(stableJson(scope)),settings.version])).rows[0];
 await c.query('UPDATE warmup_pools SET authorization_id=$2 WHERE id=$1',[group.id,auth.id]);
 return {id,run_id:id,environment:'SIMULATION',status:'RUNNING',seed:input.seed,virtual_now:input.at,account_ids:ids,external_effects:0,real_observation:false};
}
export async function readWarmupSimulation(c:QueryExecutor,id:string,workspace:string){
 const run=(await c.query('SELECT * FROM warmup_simulation_runs WHERE id=$1 AND workspace_id=$2',[id,workspace])).rows[0];if(!run)return null;
 const turns=(await c.query(`SELECT t.position,t.id turn_id,t.sender_id,t.recipient_id,t.received_envelope_id,t.received_at,o.id effect_id,o.status,o.provider_message_id,o.attempts,o.result FROM warmup_turns t JOIN outbox o ON o.id=t.effect_id WHERE t.workspace_id=$1 ORDER BY t.conversation_id,t.position`,[run.execution_workspace])).rows;
 return{run_id:run.id,seed:run.seed,virtual_now:run.virtual_now,status:run.status,version:run.version,fault:run.input.fault,turns,external_effects:0,real_observation:false,temporal_observation:'VIRTUAL_ONLY',internal_criteria_met:false,cost_minor:0,result:run.result};
}
