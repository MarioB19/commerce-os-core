import type {DomainRecord} from '@commerce/contracts';
import {encrypt,withTransaction} from '@commerce/db';
import {SimulatorProvider,type SendResult} from '@commerce/messaging';

/** Closed laboratory adapter. Delivery is synthetic and uses the normal ACK consumers. */
export function catalogSimulator(account:DomainRecord):SimulatorProvider {
 if(account.environment!=='SIMULATION'||account.body.provider!=='simulator')throw new Error('SIMULATION_SCOPE_INVALID');
 const provider=new SimulatorProvider(account.body.simulated_fault==='UNKNOWN'?'AMBIGUOUS':account.body.simulated_fault==='FAILED'?'FAILED':'WORKING');
 const send=provider.send.bind(provider);
 provider.send=message=>withTransaction(async client=>{
  // Recheck persisted ownership of the graph, not just the factory's account snapshot.
  const scope=(await client.query(`SELECT s.id simulation_id,s.body->>'virtual_now' virtual_now
   FROM outbox e
   JOIN records a ON a.id::text=e.account_id AND a.workspace_id=e.workspace_id AND a.environment=e.environment AND a.kind='channel_account'
   JOIN records c ON c.id::text=e.conversation_id AND c.workspace_id=e.workspace_id AND c.environment=e.environment AND c.kind='conversation'
    AND c.body->>'account_id'=e.account_id AND c.body->>'contact_id'=e.contact_id
   JOIN records contact ON contact.id::text=e.contact_id AND contact.workspace_id=e.workspace_id AND contact.environment=e.environment AND contact.kind='contact'
    AND contact.body->>'identity'=$4
   JOIN records s ON s.id::text=c.body->>'simulation_id' AND s.workspace_id=e.workspace_id AND s.environment=e.environment AND s.kind='simulation'
    AND s.body->>'account_id'=e.account_id AND s.body->>'status' IN('RUNNING','COMPLETED')
   WHERE e.id::text=$1 AND e.account_id=$2 AND e.workspace_id=$3 AND e.environment='SIMULATION'
    AND e.status='SENDING' AND COALESCE(e.payload->>'kind','text')<>'grant'
    AND a.body->>'provider'='simulator' AND NOT (a.body ? 'deleted_at')
    AND (a.body->'lab_snapshot'='true'::jsonb OR (a.body->>'flow_test_transport'='ISOLATED_SIMULATOR' AND s.body->>'mode'='NUMBER_FLOW_TEST_V1'))
   FOR UPDATE OF e`,[message.effectId,account.id,account.workspace_id,message.recipient])).rows[0];
  const observedAt=Date.parse(String(scope?.virtual_now));
  if(!scope||!Number.isFinite(observedAt))return{status:'REJECTED',reason:'SIMULATION_SCOPE_INVALID'} satisfies SendResult;
  const result=await send(message);
  if(result.status!=='ACCEPTED'||!result.providerMessageId)return result;
  const providerId=result.providerMessageId,eventId=providerId+':catalog-delivered';
  // No effect_id_hint: observations must wait until dispatch persists this provider ID.
  // In particular, an early ACK must not advance SENDING or reconcile UNKNOWN.
  const event={id:eventId,type:'ack',status:'DELIVERED',provider_message_id:providerId,provider_at:new Date(observedAt).toISOString()};
  await client.query(`INSERT INTO inbound_envelopes(workspace_id,environment,account_id,provider,provider_event_id,payload_ciphertext,metadata,occurred_at)
   VALUES($1,'SIMULATION',$2,'simulator',$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
  [account.workspace_id,account.id,eventId,encrypt(event),{source:'catalog_simulator',simulation_id:scope.simulation_id,effect_id:message.effectId,external_network:false,external_effects:false},event.provider_at]);
  return result;
 });
 return provider;
}
