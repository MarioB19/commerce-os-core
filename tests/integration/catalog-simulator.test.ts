import {afterAll,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Body,DomainRecord} from '../../packages/contracts/src/index.js';
import {pool,putRecord,getRecord,withTransaction,encrypt,decrypt,hash,appendEvent} from '../../packages/db/src/index.js';
import {catalogSimulator} from '../../apps/channel-worker/src/catalog-simulator.js';
import {providerFor} from '../../apps/channel-worker/src/providers.js';
import {dispatchOutbox} from '../../apps/channel-worker/src/dispatch.js';
import {consumeProviderObservations} from '../../apps/channel-worker/src/observations.js';
import {processInbound} from '../../apps/automation-worker/src/inbound.js';
import {advanceWorkflow,ensureOrder} from '../../apps/automation-worker/src/workflows.js';
import {materializeEffectResults} from '../../apps/automation-worker/src/effect-results.js';
import {proposeEffect} from '../../apps/automation-worker/src/shared.js';
import {applyCommand} from '../../apps/automation-worker/src/commands.js';
import {roleExecutor} from '../support/database-role.js';
import {isIsolatedNumberFlowTest} from '../../packages/db/src/number-flow-controls.js';

const withRole=roleExecutor(pool),roots:string[]=[];
const originalStorage=process.env.PRIVATE_STORAGE_DIR;
afterAll(async()=>{if(originalStorage===undefined)delete process.env.PRIVATE_STORAGE_DIR;else process.env.PRIVATE_STORAGE_DIR=originalStorage;await Promise.all(roots.map(path=>rm(path,{recursive:true,force:true})));await pool.end();});
const update=(record:DomainRecord,body:Body)=>putRecord(pool,{id:record.id,version:record.version,workspaceId:record.workspace_id,environment:record.environment,kind:record.kind,body:{...record.body,...body}});
async function fixture(mode:'catalog'|'number'='catalog',fault?:string){
 const workspace='catalog-sim-'+randomUUID(),now=new Date().toISOString(),owner='synthetic-owner-'+randomUUID();
 const record=(kind:string,body:Body)=>putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind,body});
 const account=await record('channel_account',{name:'Synthetic lab',provider:'simulator',status:'WORKING',sending_enabled:false,...(mode==='catalog'?{lab_snapshot:true}:{flow_test_transport:'ISOLATED_SIMULATOR'}),...(fault?{simulated_fault:fault}:{})});
 const contact=await record('contact',{identity:'opaque:synthetic-'+randomUUID(),status:'LEAD'});
 let simulation=await record('simulation',{status:'RUNNING',virtual_now:now,account_id:account.id,...(mode==='number'?{mode:'NUMBER_FLOW_TEST_V1'}:{})});
 const conversation=await record('conversation',{account_id:account.id,contact_id:contact.id,simulation_id:simulation.id,status:'OPEN',stage:'COMMITTED',last_inbound_at:now});
 simulation=await update(simulation,{conversation_id:conversation.id});
 await pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,lease_expires_at,frozen) VALUES($1,$2,$3,1,now()+interval '1 hour',false)",[account.id,workspace,owner]);
 await record('health_signal',{account_id:account.id,dimension:'session',status:'OK',value:'WORKING',source:'local_probe',scope:'account',observed_at:now,expires_at:new Date(Date.now()+3600000).toISOString()});
 const effect=await withTransaction(c=>proposeEffect(c,conversation,{kind:'text',text:'Synthetic message'},'fixture:'+randomUUID()));
 return{workspace,account,contact,simulation,conversation,effect,record,owner};
}
const effects=async(workspace:string)=>(await pool.query('SELECT * FROM outbox WHERE workspace_id=$1 ORDER BY dispatch_sequence',[workspace])).rows;
const envelopes=async(workspace:string)=>(await pool.query('SELECT * FROM inbound_envelopes WHERE workspace_id=$1 ORDER BY received_at',[workspace])).rows;
async function consume(){await processInbound(1000);await consumeProviderObservations(1000);await materializeEffectResults(1000);}

it('enqueues one explicitly synthetic ACK under commerce_channel and defers an early ACK until SENT is persisted',async()=>{
 const f=await fixture();await pool.query("UPDATE outbox SET status='SENDING',attempts=1 WHERE id=$1",[f.effect.id]);
 const provider=await providerFor(f.account),message={effectId:f.effect.id,recipient:f.contact.body.identity,kind:'text' as const,text:'Synthetic'};
 const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('EXTERNAL_NETWORK_FORBIDDEN'));
 try{
  const first=await withRole('commerce_channel',()=>provider.send(message));
  expect(first).toMatchObject({status:'ACCEPTED',providerMessageId:'sim:'+f.effect.id});
  await withRole('commerce_channel',()=>provider.send(message));
  expect(network).not.toHaveBeenCalled();
  const queue=await envelopes(f.workspace);expect(queue).toHaveLength(1);
  expect(queue[0]).toMatchObject({environment:'SIMULATION',provider:'simulator',metadata:{source:'catalog_simulator',effect_id:f.effect.id,simulation_id:f.simulation.id,external_network:false,external_effects:false}});
  expect(JSON.parse(decrypt(queue[0].payload_ciphertext))).not.toHaveProperty('biz_opaque_callback_data');
  await processInbound(1000);await consumeProviderObservations(1000);
  expect((await effects(f.workspace))[0].status).toBe('SENDING');
  const event=(await pool.query("SELECT id FROM domain_events WHERE workspace_id=$1 AND event_type='provider.ack.observed'",[f.workspace])).rows[0];
  expect((await pool.query("SELECT 1 FROM consumer_receipts WHERE consumer='channel-v1' AND event_id=$1",[event.id])).rowCount).toBe(0);
  // Emulate the dispatch persistence boundary after the early consumer has run.
  await pool.query("UPDATE outbox SET status='SENT',provider_message_id=$2 WHERE id=$1",[f.effect.id,first.providerMessageId]);
  await consumeProviderObservations(1000);await consumeProviderObservations(1000);
  const delivered=(await effects(f.workspace))[0];expect(delivered.status).toBe('DELIVERED');expect(delivered.result.ack_keys).toHaveLength(1);
 }finally{network.mockRestore();}
});

it.each(['real-factory','real-persisted','wrong-account','wrong-contact','wrong-recipient','foreign-workspace','foreign-simulation','missing-simulation','unmarked','reset','grant','not-sending'] as const)('rejects %s without creating delivery evidence',async boundary=>{
 const f=await fixture();await pool.query("UPDATE outbox SET status='SENDING' WHERE id=$1",[f.effect.id]);
 if(boundary==='real-factory'){expect(()=>catalogSimulator({...f.account,environment:'REAL'})).toThrow('SIMULATION_SCOPE_INVALID');return;}
 if(boundary==='real-persisted'){
  const real=await putRecord(pool,{workspaceId:f.workspace,environment:'REAL',kind:'channel_account',body:{provider:'simulator',lab_snapshot:true}});
  const contact=await putRecord(pool,{workspaceId:f.workspace,environment:'REAL',kind:'contact',body:{identity:f.contact.body.identity}});
  const conversation=await putRecord(pool,{workspaceId:f.workspace,environment:'REAL',kind:'conversation',body:{account_id:real.id,contact_id:contact.id}});
  f.account={...real,environment:'SIMULATION'};
  f.effect=(await pool.query("INSERT INTO outbox(workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,status,config_hash) VALUES($1,'REAL',$2,$3,$4,$5,'{\"kind\":\"text\"}','SENDING','synthetic') RETURNING *",[f.workspace,real.id,conversation.id,contact.id,randomUUID()])).rows[0];
 }
 if(boundary==='wrong-account')await update(f.conversation,{account_id:(await f.record('channel_account',{provider:'simulator'})).id});
 if(boundary==='wrong-contact')await update(f.conversation,{contact_id:(await f.record('contact',{identity:'opaque:another'})).id});
 if(boundary==='foreign-workspace')f.account={...f.account,workspace_id:'outside-'+randomUUID()};
 if(boundary==='foreign-simulation')await update(f.simulation,{account_id:(await f.record('channel_account',{provider:'simulator'})).id});
 if(boundary==='missing-simulation')await update(f.conversation,{simulation_id:randomUUID()});
 if(boundary==='unmarked')await update(f.account,{lab_snapshot:false});
 if(boundary==='reset')await update(f.simulation,{status:'RESET'});
 if(boundary==='grant')await pool.query("UPDATE outbox SET payload=payload||'{\"kind\":\"grant\"}'::jsonb WHERE id=$1",[f.effect.id]);
 if(boundary==='not-sending')await pool.query("UPDATE outbox SET status='UNKNOWN' WHERE id=$1",[f.effect.id]);
 const provider=catalogSimulator(f.account);
 expect(await provider.send({effectId:f.effect.id,recipient:boundary==='wrong-recipient'?'opaque:other':f.contact.body.identity,kind:'text'})).toEqual({status:'REJECTED',reason:'SIMULATION_SCOPE_INVALID'});
 expect(provider.sent).toHaveLength(0);expect(await envelopes(f.workspace)).toHaveLength(0);
 await pool.query("UPDATE outbox SET status='CANCELLED' WHERE workspace_id=$1",[f.workspace]);
});

it.each(['UNKNOWN','FAILED'])('does not generate an ACK or retry a simulated %s result',async fault=>{
 const f=await fixture('number',fault);
 await dispatchOutbox(1000,providerFor,f.owner);await dispatchOutbox(1000,providerFor,f.owner);await consume();
 expect((await effects(f.workspace))[0]).toMatchObject({status:fault,attempts:1});
 expect(await envelopes(f.workspace)).toHaveLength(0);
});

it('keeps UNKNOWN unresolved even if a previously accepted simulator ACK arrives later',async()=>{
 const f=await fixture('number');await pool.query("UPDATE outbox SET status='SENDING',attempts=1 WHERE id=$1",[f.effect.id]);
 const provider=await providerFor(f.account),result=await provider.send({effectId:f.effect.id,recipient:f.contact.body.identity,kind:'text'});
 expect(result.status).toBe('ACCEPTED');expect(await envelopes(f.workspace)).toHaveLength(1);
 // A crash/reconciliation boundary can mark the effect UNKNOWN before the ACK consumer runs.
 await pool.query("UPDATE outbox SET status='UNKNOWN',provider_message_id=$2 WHERE id=$1",[f.effect.id,result.providerMessageId]);
 await consume();await dispatchOutbox(1000,providerFor,f.owner);
 expect((await effects(f.workspace))[0]).toMatchObject({status:'UNKNOWN',attempts:1,result:{last_ack:{status:'DELIVERED'}}});
 expect(await envelopes(f.workspace)).toHaveLength(1);
});

it.each(['REAL','foreign-account'] as const)('rejects simulation advance with %s source scope without committing the virtual clock',async boundary=>{
 const f=await fixture('number');
 if(boundary==='foreign-account')await update(f.conversation,{account_id:(await f.record('channel_account',{provider:'simulator'})).id});
 await expect(withTransaction(c=>applyCommand(c,{id:randomUUID(),workspace_id:f.workspace,environment:boundary==='REAL'?'REAL':'SIMULATION',kind:'simulation_advance',resource_id:f.simulation.id,payload:{seconds:61,message:'Synthetic'}}))).rejects.toThrow(boundary==='REAL'?'SIMULATION_ENVIRONMENT_REQUIRED':'SIMULATION_SCOPE_INVALID');
 expect((await getRecord(pool,f.workspace,'simulation',f.simulation.id))!.body.virtual_now).toBe(f.simulation.body.virtual_now);
 expect(await envelopes(f.workspace)).toHaveLength(0);
 await pool.query("UPDATE outbox SET status='CANCELLED' WHERE workspace_id=$1",[f.workspace]);
});

it.each(['catalog','number'] as const)('releases collection only after normal consumers confirm nine PDF ACKs and portal access in the %s lab',async mode=>{
 const f=await fixture(mode);
 // Remove the fixture-only text before creating the actual fulfillment workflow.
 await pool.query('DELETE FROM outbox WHERE id=$1',[f.effect.id]);
 const root=await mkdtemp(join(tmpdir(),'commerce-catalog-simulator-'));roots.push(root);await mkdir(join(root,'assets'));process.env.PRIVATE_STORAGE_DIR=root;
 const assets=[];
 const access=await f.record('asset',{name:'Synthetic portal',kind:'access',adapter:'link',status:'READY',delivery_ciphertext:encrypt({adapter:'link',delivery_reference:'https://simulation.invalid/LAB-ONLY'})});assets.push(access);
 for(let i=0;i<9;i++){const bytes=Buffer.from('%PDF-1.4\n% synthetic '+i+'\n%%EOF'),key=randomUUID();await writeFile(join(root,'assets',key+'.enc'),encrypt(bytes.toString('base64')));assets.push(await f.record('asset',{name:'Synthetic '+i+'.pdf',kind:'file',mime_type:'application/pdf',storage_key:key,size_bytes:bytes.length,sha256:hash(bytes),status:'READY'}));}
 const product=await f.record('product',{name:'Synthetic catalog',status:'PUBLISHED'});
 const workflow=await f.record('workflow',{name:'Synthetic prepayment workflow',product_id:product.id,status:'PUBLISHED',entry_node_id:'prepayment',nodes:[{id:'prepayment',type:'fulfillment',config:{recipe_step:6,release_on:'commitment_accepted'},next:'collection'},{id:'collection',type:'message',config:{recipe_step:7,text:'Material confirmado'},next:'receipt'},{id:'receipt',type:'receipt',config:{},next:'end'},{id:'end',type:'end',config:{}}]});
 const offer=await f.record('offer',{name:'Synthetic offer',product_id:product.id,workflow_version_id:workflow.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:9700,fulfillment:assets.map(asset=>({asset_id:asset.id,release_on:'commitment_accepted'}))});
 let simulation=await getRecord(pool,f.workspace,'simulation',f.simulation.id);let route:Body={};
 if(mode==='number'){
  // This scenario enters the order/workflow layer, unlike the transport-only
  // fixtures above. Reproduce the required persisted graph with an explicitly synthetic origin.
  const sourceAccountId=randomUUID(),assignmentId=randomUUID();
  await update(f.account,{lab_snapshot:true});await update(f.contact,{identity:'opaque:sim-'+f.simulation.id});
  const binding=await f.record('binding',{account_id:f.account.id,product_id:product.id,offer_version_id:offer.id,workflow_version_id:workflow.id,assignment_id:assignmentId,assignment_revision:1,valid_from:f.simulation.body.virtual_now,entry_rules:[],source:'number_flow_test_snapshot_v1',evidence:'Synthetic API-shaped integration fixture',confidence:'observed'});
  await pool.query("INSERT INTO commercial_assignments(id,workspace_id,environment,account_id,product_id,binding_id,revision,state) VALUES($1,$2,'SIMULATION',$3,$4,$5,1,'ACTIVE')",[assignmentId,f.workspace,f.account.id,product.id,binding.id]);
  await pool.query("INSERT INTO commercial_assignment_history(assignment_id,revision,binding_id,state,actor_id,reason) VALUES($1,1,$2,'ACTIVE','synthetic-fixture','NUMBER_FLOW_TEST_SNAPSHOT')",[assignmentId,binding.id]);
  simulation=await update(simulation!,{assignments:[{selection_key:'ruta-1',assignment_id:assignmentId,product_id:product.id,offer_version_id:offer.id,workflow_version_id:workflow.id}],source:{account:{id:sourceAccountId}},isolation:{transport:'simulator',external_network:false,real_mutation:false,bank:'LAB_PLACEHOLDER',access:'LAB_ONLY'},external_effects:false});
  await appendEvent(pool,{workspace_id:f.workspace,environment:'SIMULATION',event_type:'number.flow_test_started',aggregate_id:simulation.id,actor:{type:'synthetic-fixture'},payload:{source_account_id:sourceAccountId,assignment_count:1,external_effects:false}});
  route={assignment_id:assignmentId,assignment_revision:1,binding_id:binding.id,routing_state:'RESOLVED'};
 }else await update(simulation!,{offer_version_id:offer.id,workflow_version_id:workflow.id});
 let conversation=await update(f.conversation,{product_id:product.id,offer_version_id:offer.id,workflow_version_id:workflow.id,...route});
 if(mode==='number')expect(await isIsolatedNumberFlowTest(pool,conversation)).toBe(true);
 const order=await withTransaction(c=>ensureOrder(c,conversation));expect(order!.body.commercial_classification).toBe('TEST');await update(order!,{status:'COMMITTED',committed_at:new Date().toISOString()});
 conversation=await withTransaction(c=>advanceWorkflow(c,conversation));expect(conversation.body.flow_state.waiting_for).toBe('prepayment_delivery_confirmed');
 for(let round=0;round<3;round++){
  await dispatchOutbox(1000,providerFor,f.owner);
  simulation=(await getRecord(pool,f.workspace,'simulation',f.simulation.id))!;await update(simulation,{virtual_now:new Date(Date.parse(simulation.body.virtual_now)+61_000).toISOString()});
 }
 const before=await effects(f.workspace);expect(before).toHaveLength(11);expect(before.every(e=>e.status==='SENT')).toBe(true);
 expect(before.filter(e=>e.payload.kind==='document')).toHaveLength(9);
 const pending=await envelopes(f.workspace);expect(pending).toHaveLength(10);expect(pending.some(e=>e.metadata.effect_id===before.find(e=>e.payload.kind==='grant').id)).toBe(false);
 await materializeEffectResults(1000);expect((await getRecord(pool,f.workspace,'conversation',conversation.id))!.body.flow_state.waiting_for).toBe('prepayment_delivery_confirmed');
 // Process only nine ACKs first: the tenth material is still unconfirmed.
 await processInbound(9);await consumeProviderObservations(1000);await materializeEffectResults(1000);
 expect((await getRecord(pool,f.workspace,'conversation',conversation.id))!.body.flow_state.waiting_for).toBe('prepayment_delivery_confirmed');
 await consume();
 expect((await getRecord(pool,f.workspace,'conversation',conversation.id))!.body.flow_state.waiting_for).toBe('receipt_approved');
 const after=await effects(f.workspace);expect(after.filter(e=>e.payload.workflow_recipe_step===7)).toHaveLength(1);
 expect(after.filter(e=>e.payload.fulfillment_id).every(e=>e.status==='DELIVERED'&&e.attempts===1)).toBe(true);
 expect((await pool.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND environment='REAL'",[f.workspace])).rows[0].n).toBe(0);
 // Finish remaining synthetic collection effect so this fixture cannot affect later suites.
 await dispatchOutbox(1000,providerFor,f.owner);await consume();
});
