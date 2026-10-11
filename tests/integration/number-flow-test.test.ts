import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {processAgents} from '../../apps/automation-worker/src/agents.js';
import {materializeEffectResults} from '../../apps/automation-worker/src/effect-results.js';
import {processCommands,processNewWorkflows} from '../../apps/automation-worker/src/runtime.js';
import {gated} from '../../apps/automation-worker/src/shared.js';
import {advanceWorkflow} from '../../apps/automation-worker/src/workflows.js';
import {dispatchOutbox,gateDispatch} from '../../apps/channel-worker/src/dispatch.js';
import {isIsolatedNumberFlowTest} from '../../packages/db/src/number-flow-controls.js';
import {activeLaunchTest,approvedBenefitTotal,launchTestOrderFields,reconcileNumberFlowTestClassification} from '../../packages/db/src/launch-test-scope.js';
import {pool,putRecord,getRecord,stableJson,hash,decrypt,readOperationalSettings,writeOperationalSettings} from '../../packages/db/src/index.js';
import {numberRequest,numberTools} from '../../apps/commerce-mcp/src/numbers.js';
import {createDefaultRemarketingPolicy} from '../../packages/domain/src/sales/remarketing.js';
import {salesAgreementRecipeV1,salesAgreementWorkflowV1} from '../../packages/domain/src/sales/sales-recipe-v2.js';

const workspace='number-flow-test-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://127.0.0.1:5173').split(',')[0]!;
let app:FastifyInstance,cookie:string,sourceAccount:any,realBefore:string;

async function request(method:'GET'|'POST',path:string,body?:Record<string,unknown>,key=randomUUID(),authorization?:string){
 const url=path+(path.includes('?')?'&':'?')+'environment=SIMULATION';
 return app.inject({method,url,headers:{origin,'idempotency-key':key,...(authorization?{authorization}:{cookie})},...(body?{payload:{...body,environment:'SIMULATION'}}:{})});
}
function data(response:any,status=200){expect(response.statusCode,response.body).toBe(status);return response.json().data;}
async function realState(){
 const records=(await pool.query("SELECT id,kind,version,body FROM records WHERE workspace_id=$1 AND environment='REAL' ORDER BY kind,id",[workspace])).rows;
 const assignments=(await pool.query("SELECT id,account_id,product_id,binding_id,revision,state,authorization_id FROM commercial_assignments WHERE workspace_id=$1 AND environment='REAL' ORDER BY id",[workspace])).rows;
 const effects=(await pool.query("SELECT id,status,payload FROM outbox WHERE workspace_id=$1 AND environment='REAL' ORDER BY id",[workspace])).rows;
 const commands=(await pool.query("SELECT id,status,payload FROM commands WHERE workspace_id=$1 AND environment='REAL' ORDER BY id",[workspace])).rows;
 const workspaceControls=(await pool.query("SELECT * FROM manual_controls WHERE workspace_id=$1 AND scope_type='workspace'",[workspace])).rows;
 const policy=await readOperationalSettings(pool,workspace,'REAL');
 return stableJson({records,assignments,effects,commands,workspaceControls,policy});
}
async function flushSimulationEffects(){
 for(let pass=0;pass<20;pass++){
  const sent=await dispatchOutbox(100);
  await materializeEffectResults(1000);
  if(!sent)return;
 }
 throw new Error('SIMULATION_EFFECT_DRAIN_LIMIT');
}
async function continueVisible(testId:string){
 for(let step=0;step<20;step++){
  const state=data(await request('GET',`/v1/number-flow-tests/${testId}`));
  if(!state.available_actions.includes('continue'))return state;
  const action=data(await request('POST',`/v1/number-flow-tests/${testId}/actions`,{type:'continue'}),202);
  await processCommands(100);
  expect((await pool.query('SELECT status,result FROM commands WHERE id=$1',[action.command_id])).rows[0]).toMatchObject({status:'APPLIED'});
  await flushSimulationEffects();
 }
 throw new Error('SIMULATION_VISIBLE_STEP_LIMIT');
}
async function setupProjection(){
 const response=await app.inject({method:'GET',url:`/v1/numbers/${sourceAccount.id}/setup?environment=REAL`,headers:{origin,cookie}});
 expect(response.statusCode,response.body).toBe(200);return response.json().data;
}

beforeAll(async()=>{
 app=await createApp();
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Synthetic flow test owner',email,password,workspace_id:workspace,role:'owner'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.190',headers:{origin},payload:{email,password}});
 expect(login.statusCode).toBe(200);cookie=login.cookies.map(value=>`${value.name}=${value.value}`).join('; ');
 sourceAccount=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Número comercial fuente',provider:'waha',status:'WORKING',sending_enabled:false}});
 for(const [index,label] of ['A','B'].entries()){
  const access=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'asset',body:{name:'Acceso '+label,kind:'access',mime_type:'application/octet-stream',size_bytes:0,status:'READY',delivery_ciphertext:'REAL-SECRET-MUST-NOT-CROSS'}});
  const postAccess=index===1?await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'asset',body:{name:'Acceso final '+label,kind:'access',mime_type:'application/octet-stream',size_bytes:0,status:'READY',delivery_ciphertext:'REAL-SECRET-MUST-NOT-CROSS'}}):undefined;
  const bank=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'bank_profile',body:{name:'Banco '+label,bank:'REAL BANK',last4:'9876',currency:'MXN',secret_ciphertext:'REAL-SECRET-MUST-NOT-CROSS'}});
  const policy=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'receipt_policy',body:{name:'Política '+label,allow_amount_mismatch:true,allow_pending:false,require_currency:false,require_destination:false,min_amount_minor:1,auto_approve:false}});
  const product=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'product',body:{name:'Producto '+label,description:'Fixture',asset_ids:[access.id],status:'PUBLISHED'}});
  const agent=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'agent',body:{name:'Vendedor '+label,product_id:product.id,provider:'openai',model:'external-model',knowledge:'Fixture',instructions:'Fixture',status:'PUBLISHED'}});
  const flow=index===1?salesAgreementWorkflowV1({presentation_audio_id:access.id,pack_image_id:access.id,agreement_audio_id:access.id,collection_audio_id:access.id},{offer:'Oferta B',agreement:'¿Llegamos al acuerdo?',payment:'{{bank_instructions}}',thanks:'Gracias por tu comprobante'}):{name:'Flujo A',entry_node_id:'entry',nodes:[{id:'entry',type:'entry',config:{},next:'offer'},{id:'offer',type:'message',config:{text:'Oferta A'},next:'reply'},{id:'reply',type:'reply',config:{variable:'answer'},next:'answer'},{id:'answer',type:'message',config:{text:'Respuesta A recibida'},next:'agreement'},{id:'agreement',type:'commitment',config:{accepted_phrases:['sí a']},next:'bank'},{id:'bank',type:'bank_instructions',config:{},next:'receipt'},{id:'receipt',type:'receipt',config:{},next:'end'},{id:'end',type:'end',config:{}}]};
  const workflow=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'workflow',body:{...flow,name:'Flujo '+label,product_id:product.id,agent_version_id:agent.id,status:'PUBLISHED'}});
  const stage=(text:string)=>({medium:'audio' as const,asset_id:access.id,text});
  const sales_flow=index===1?{entry_aliases:['Producto B'],recipe:salesAgreementRecipeV1(),remarketing:createDefaultRemarketingPolicy([
   {awaiting_agreement:stage('Acuerdo uno'),awaiting_payment:stage('Pago uno')},
   {awaiting_agreement:stage('Acuerdo dos'),awaiting_payment:stage('Pago dos')},
   {awaiting_agreement:stage('Acuerdo tres'),awaiting_payment:stage('Pago tres')},
  ]),content:{presentation:{audio_asset_id:access.id,pack_image_asset_id:access.id,offer_text:'Oferta B desde la oferta'},agreement:{audio_asset_id:access.id,prompt:'¿Llegamos al acuerdo desde la oferta?'},collection:{audio_asset_id:access.id,payment_instructions:'{{bank_instructions}}'},closure:{receipt_thanks:'Gracias por tu comprobante desde la oferta'}}}:undefined;
  const offer=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'offer',body:{name:'Oferta '+label,product_id:product.id,currency:'MXN',base_amount_minor:9700+index*1000,payment_method:'bank_transfer_receipt',payment_profile_version_id:bank.id,receipt_policy_version_id:policy.id,workflow_version_id:workflow.id,agent_version_id:agent.id,fulfillment:[{asset_id:access.id,release_on:'commitment_accepted'},...(postAccess?[{asset_id:postAccess.id,release_on:'receipt_approved',min_amount_minor:20000}]:[])],positive_payment_unlocks_all:true,...(sales_flow?{sales_flow}:{}),status:'PUBLISHED'}});
  const assignmentId=randomUUID(),binding=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'binding',body:{account_id:sourceAccount.id,product_id:product.id,offer_version_id:offer.id,workflow_version_id:workflow.id,agent_version_id:agent.id,entry_rules:[{kind:'keyword',value:`quiero ${label.toLowerCase()}`},...(index===1?[{kind:'link',value:'https://example.invalid/entry?signature=REAL-SIGNED-VALUE'}]:[])],valid_from:'2026-01-01T00:00:00.000Z',source:'synthetic',evidence:'Synthetic integration assignment',confidence:'observed',assignment_id:assignmentId,assignment_revision:1}});
  await pool.query("INSERT INTO commercial_assignments(id,workspace_id,environment,account_id,product_id,binding_id,revision,state) VALUES($1,$2,'REAL',$3,$4,$5,1,'ACTIVE')",[assignmentId,workspace,sourceAccount.id,product.id,binding.id]);
  await pool.query("INSERT INTO commercial_assignment_history(assignment_id,revision,binding_id,state,actor_id,reason) VALUES($1,1,$2,'ACTIVE','fixture','Synthetic')",[assignmentId,binding.id]);
 }
 await pool.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'workspace',$1,true,'Keep REAL paused during the explicit number laboratory','fixture')",[workspace]);
 const realPolicy=await readOperationalSettings(pool,workspace,'REAL');
 expect(realPolicy.body).toMatchObject({dispatch_frozen:true,real_sends_enabled:false,allow_real_operations:false});
 realBefore=await realState();
});

afterAll(async()=>{await app.close();await pool.end();});

describe('number flow laboratory',()=>{
	 it('keeps workspace pause and REAL freeze while dispatching only an explicit isolated lab',async()=>{
	  const started=data(await request('POST',`/v1/channel-accounts/${sourceAccount.id}/flow-tests`,{contact_name:'Laboratorio bajo pausa'}),201);
	  const route=started.assignments.find((item:any)=>item.product_name==='Producto A').selection_key;
	  data(await request('POST',`/v1/number-flow-tests/${started.id}/actions`,{type:'select_product',selection_key:route}),202);
	  await processCommands(100);
	  const simulation=(await getRecord(pool,workspace,'simulation',started.id))!,conversation=(await getRecord(pool,workspace,'conversation',simulation.body.conversation_id))!;
	  expect(await isIsolatedNumberFlowTest(pool,conversation)).toBe(true);expect(await gated(pool,conversation)).toBe(false);
	  const effect=(await pool.query('SELECT * FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY dispatch_sequence LIMIT 1',[workspace,conversation.id])).rows[0];
	  expect(effect).toBeTruthy();expect((await gateDispatch(pool,effect,'synthetic-owner')).allowed).toBe(true);
	  await flushSimulationEffects();
	  expect((await pool.query('SELECT status,attempts FROM outbox WHERE id=$1',[effect.id])).rows[0]).toMatchObject({status:'SENT',attempts:1});
	  expect(await realState()).toBe(realBefore);
	 });

	 it('does not extend the workspace pause exception to forged, reset or nonisolated graphs',async()=>{
	  const started=data(await request('POST',`/v1/channel-accounts/${sourceAccount.id}/flow-tests`,{contact_name:'Guardias de aislamiento',start_mode:'SEEDED',initial_message:'quiero a'}),201);
	  await processCommands(100);
	  const simulation=(await getRecord(pool,workspace,'simulation',started.id))!,conversation=(await getRecord(pool,workspace,'conversation',simulation.body.conversation_id))!;
	  const account=(await getRecord(pool,workspace,'channel_account',simulation.body.account_id))!,contact=(await getRecord(pool,workspace,'contact',conversation.body.contact_id))!;
	  const effect=(await pool.query('SELECT * FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY dispatch_sequence LIMIT 1',[workspace,conversation.id])).rows[0];
	  expect(await isIsolatedNumberFlowTest(pool,conversation)).toBe(true);
	  for(const [record,patch] of [
	   [account,{provider:'waha'}],[account,{lab_snapshot:false}],[account,{flow_test_transport:'generic'}],[account,{sending_enabled:true}],
	   [simulation,{mode:'GENERIC_SIMULATION'}],[simulation,{status:'RESET'}],[simulation,{external_effects:true}],
	   [simulation,{isolation:{...simulation.body.isolation,external_network:true}}],
	   [simulation,{source:{...simulation.body.source,account:{...simulation.body.source.account,id:randomUUID()}}}],
	   [contact,{identity:'opaque:another-laboratory'}],
	  ] as const){
	   const fresh=(await getRecord(pool,workspace,record.kind,record.id))!;
	   const changed=await putRecord(pool,{id:fresh.id,workspaceId:workspace,environment:'SIMULATION',kind:fresh.kind,version:fresh.version,body:{...fresh.body,...patch}});
	   try{expect(await isIsolatedNumberFlowTest(pool,conversation)).toBe(false);expect(await gated(pool,conversation)).toBe(true);expect((await gateDispatch(pool,effect,'synthetic-owner')).allowed).toBe(false);}
	   finally{await putRecord(pool,{id:changed.id,workspaceId:workspace,environment:'SIMULATION',kind:changed.kind,version:changed.version,body:fresh.body});}
	  }
	  // Copying all markers does not copy the immutable API start event.
	  const forged=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'simulation',body:simulation.body});
	  const freshConversation=(await getRecord(pool,workspace,'conversation',conversation.id))!,freshContact=(await getRecord(pool,workspace,'contact',contact.id))!;
	  const changedConversation=await putRecord(pool,{id:conversation.id,workspaceId:workspace,environment:'SIMULATION',kind:'conversation',version:freshConversation.version,body:{...freshConversation.body,simulation_id:forged.id}});
	  const changedContact=await putRecord(pool,{id:contact.id,workspaceId:workspace,environment:'SIMULATION',kind:'contact',version:freshContact.version,body:{...freshContact.body,identity:'opaque:sim-'+forged.id}});
	  try{expect(await isIsolatedNumberFlowTest(pool,changedConversation)).toBe(false);expect(await gated(pool,changedConversation)).toBe(true);expect(await gateDispatch(pool,effect,'synthetic-owner')).toMatchObject({allowed:false,reason:'OPERATION_PAUSED'});}
	  finally{await putRecord(pool,{id:changedConversation.id,workspaceId:workspace,environment:'SIMULATION',kind:'conversation',version:changedConversation.version,body:freshConversation.body});await putRecord(pool,{id:changedContact.id,workspaceId:workspace,environment:'SIMULATION',kind:'contact',version:changedContact.version,body:freshContact.body});}
	  expect(await isIsolatedNumberFlowTest(pool,{...conversation,environment:'REAL'})).toBe(false);
	  expect(await realState()).toBe(realBefore);
	 });

	 it('preserves scoped pauses and workspace suppression or takeover inside the laboratory',async()=>{
	  const started=data(await request('POST',`/v1/channel-accounts/${sourceAccount.id}/flow-tests`,{contact_name:'Pausas del laboratorio',start_mode:'SEEDED',initial_message:'quiero a'}),201);
	  await processCommands(100);
	  const simulation=(await getRecord(pool,workspace,'simulation',started.id))!,conversation=(await getRecord(pool,workspace,'conversation',simulation.body.conversation_id))!;
	  const effect=(await pool.query('SELECT * FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY dispatch_sequence LIMIT 1',[workspace,conversation.id])).rows[0];
	  for(const [scope,scopeId] of [['channel_account',conversation.body.account_id],['contact',conversation.body.contact_id],['conversation',conversation.id],['workflow',conversation.body.workflow_version_id]]){
	   await pool.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,$2,$3,true,'Synthetic scoped pause','fixture')",[workspace,scope,scopeId]);
	   try{expect(await gated(pool,conversation)).toBe(true);expect(await gateDispatch(pool,effect,'synthetic-owner')).toMatchObject({allowed:false,reason:'OPERATION_PAUSED'});}
	   finally{await pool.query('DELETE FROM manual_controls WHERE workspace_id=$1 AND scope_type=$2 AND scope_id=$3',[workspace,scope,scopeId]);}
	  }
	  for(const bit of ['suppressed','takeover'] as const){
	   await pool.query(`UPDATE manual_controls SET ${bit}=true WHERE workspace_id=$1 AND scope_type='workspace'`,[workspace]);
	   try{expect(await gated(pool,conversation)).toBe(true);expect(await gateDispatch(pool,effect,'synthetic-owner')).toMatchObject({allowed:false,reason:bit==='suppressed'?'CONTACT_SUPPRESSED':'HUMAN_TAKEOVER'});}
	   finally{await pool.query(`UPDATE manual_controls SET ${bit}=false WHERE workspace_id=$1 AND scope_type='workspace'`,[workspace]);}
	  }
	  expect(await gated(pool,conversation)).toBe(false);expect(await realState()).toBe(realBefore);
	 });

	 it('never gives a REAL effect the laboratory pause exception or opens its policy',async()=>{
	  const realWorkspace='real-pause-guard-'+randomUUID();
	  const account=await putRecord(pool,{workspaceId:realWorkspace,environment:'REAL',kind:'channel_account',body:{provider:'waha',status:'WORKING',sending_enabled:true,lab_snapshot:true,flow_test_transport:'ISOLATED_SIMULATOR'}});
	  const contact=await putRecord(pool,{workspaceId:realWorkspace,environment:'REAL',kind:'contact',body:{identity:'opaque:synthetic-real-guard',status:'LEAD'}});
	  const conversation=await putRecord(pool,{workspaceId:realWorkspace,environment:'REAL',kind:'conversation',body:{account_id:account.id,contact_id:contact.id}});
	  await pool.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'workspace',$1,true,'Synthetic REAL policy guard','fixture')",[realWorkspace]);
	  const controlsBefore=stableJson((await pool.query('SELECT * FROM manual_controls WHERE workspace_id=$1',[realWorkspace])).rows),policyBefore=stableJson(await readOperationalSettings(pool,realWorkspace,'REAL'));
	  expect(await isIsolatedNumberFlowTest(pool,conversation)).toBe(false);expect(await gated(pool,conversation)).toBe(true);
	  expect(await gateDispatch(pool,{id:randomUUID(),workspace_id:realWorkspace,environment:'REAL',account_id:account.id,contact_id:contact.id,conversation_id:conversation.id,payload:{kind:'text',text:'Synthetic; never send'},expires_at:new Date(Date.now()+60000).toISOString()},'synthetic-owner')).toMatchObject({allowed:false,reason:'REAL_OPERATION_NOT_ENABLED'});
	  expect(stableJson((await pool.query('SELECT * FROM manual_controls WHERE workspace_id=$1',[realWorkspace])).rows)).toBe(controlsBefore);
	  expect(stableJson(await readOperationalSettings(pool,realWorkspace,'REAL'))).toBe(policyBefore);
	  expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[realWorkspace])).rows[0].n).toBe(0);
	 });
	 it('binds a newly selected journey to its simulation before any subsequent UI action or dispatch',async()=>{
	  const started=data(await request('POST',`/v1/channel-accounts/${sourceAccount.id}/flow-tests`,{contact_name:'Selección sin lectura intermedia',start_mode:'SEEDED'}),201);
	  await processCommands(100);
	  const route=started.assignments.find((item:any)=>item.product_name==='Producto B').selection_key;
	  data(await request('POST',`/v1/number-flow-tests/${started.id}/actions`,{type:'select_product',selection_key:route}),202);
	  await processCommands(100);await processNewWorkflows(100);
	  const simulation=(await getRecord(pool,workspace,'simulation',started.id))!;
	  const selected=(await pool.query("SELECT * FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='conversation' AND body->>'account_id'=$2 AND body->>'routing_state'='RESOLVED'",[workspace,simulation.body.account_id])).rows[0];
	  expect(selected.body.simulation_id).toBe(started.id);
	  expect(selected.body.flow_test_single_step).toBe(true);
	  expect(simulation.body.conversation_id).toBe(selected.id);
	  await flushSimulationEffects();
	  const sent=(await pool.query('SELECT status,result FROM outbox WHERE workspace_id=$1 AND conversation_id=$2',[workspace,selected.id])).rows;
	  expect(sent.length).toBeGreaterThan(0);expect(sent.every(row=>row.status==='SENT')).toBe(true);
	 });
	 it('starts empty, can begin with an explicit route and resets to an idempotently empty lab',async()=>{
	  const started=data(await request('POST',`/v1/channel-accounts/${sourceAccount.id}/flow-tests`,{contact_name:'Cliente vacío'}),201);
	  expect(started).toMatchObject({start_mode:'EMPTY',empty:true,command_id:null,transcript:[],external_effects:false});
	  expect(started.available_actions).toContain('select_product');
	  expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind IN('conversation','message') AND (body->>'account_id'=$2 OR body->>'simulation_id'=$3)",[workspace,(await getRecord(pool,workspace,'simulation',started.id))!.body.account_id,started.id])).rows[0].n).toBe(0);
	  const route=started.assignments.find((item:any)=>item.product_name==='Producto B').selection_key;
	  data(await request('POST',`/v1/number-flow-tests/${started.id}/actions`,{type:'select_product',selection_key:route}),202);await processCommands(100);
	  const active=data(await request('GET',`/v1/number-flow-tests/${started.id}`));
	  expect(active.transcript.some((item:any)=>item.direction==='INBOUND'&&item.text==='quiero b')).toBe(true);
	  expect(active.transcript.some((item:any)=>item.text==='Hola, quiero información')).toBe(false);
	  expect((await setupProjection()).steps.find((item:any)=>item.key==='SIMULATION')).toMatchObject({status:'IN_PROGRESS',cause:'SIMULATION_IN_PROGRESS',evidence:{complete:false,blockers:['SIMULATION_STATUS_NOT_COMPLETED']}});
	  const resetKey=randomUUID(),reset=data(await request('POST',`/v1/number-flow-tests/${started.id}/reset`,{},resetKey),201);
	  expect(reset).toMatchObject({start_mode:'EMPTY',empty:true,command_id:null,transcript:[]});
	  const replay=data(await request('POST',`/v1/number-flow-tests/${started.id}/reset`,{},resetKey),201);
	  expect(replay.id).toBe(reset.id);
	 });

	 it('never consumes a customer message while a visible simulation step still needs continuation',async()=>{
	  const started=data(await request('POST',`/v1/channel-accounts/${sourceAccount.id}/flow-tests`,{contact_name:'Cliente por pasos'}),201);
	  const route=started.assignments.find((item:any)=>item.product_name==='Producto A').selection_key;
	  data(await request('POST',`/v1/number-flow-tests/${started.id}/actions`,{type:'select_product',selection_key:route}),202);await processCommands(100);
	  let state=data(await request('GET',`/v1/number-flow-tests/${started.id}`));expect(state.available_actions).toEqual(['continue']);
	  const early=await request('POST',`/v1/number-flow-tests/${started.id}/actions`,{type:'question',text:'Mi respuesta'});expect(early.statusCode).toBe(409);expect(early.json().error.code).toBe('FLOW_TEST_CONTINUE_REQUIRED');
	  expect(state.transcript.some((item:any)=>item.text==='Mi respuesta')).toBe(false);
	  data(await request('POST',`/v1/number-flow-tests/${started.id}/actions`,{type:'continue'}),202);await processCommands(100);
	  data(await request('POST',`/v1/number-flow-tests/${started.id}/actions`,{type:'question',text:'Mi respuesta'}),202);await processCommands(100);
	  state=data(await request('GET',`/v1/number-flow-tests/${started.id}`));
	  expect(state.transcript.filter((item:any)=>item.text==='Mi respuesta')).toHaveLength(1);
	  expect(state.transcript.some((item:any)=>item.text==='Respuesta A recibida')).toBe(true);
	  const simulation=(await getRecord(pool,workspace,'simulation',started.id))!,conversation=(await getRecord(pool,workspace,'conversation',simulation.body.conversation_id))!;
	  expect(conversation.body.flow_state.variables.answer).toBe('Mi respuesta');
	 });

	 it('keeps the creation stage on inbound messages and outbound effects',async()=>{
	  const started=data(await request('POST',`/v1/channel-accounts/${sourceAccount.id}/flow-tests`,{contact_name:'Etapa histórica'}),201);
	  const route=started.assignments.find((item:any)=>item.product_name==='Producto B').selection_key;
	  data(await request('POST',`/v1/number-flow-tests/${started.id}/actions`,{type:'select_product',selection_key:route}),202);
	  await processCommands(100);
	  const simulation=(await getRecord(pool,workspace,'simulation',started.id))!;
	  const conversation=(await getRecord(pool,workspace,'conversation',simulation.body.conversation_id))!;
	  const message=(await pool.query("SELECT id,body FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='message' AND body->>'conversation_id'=$2 AND body->>'direction'='INBOUND' ORDER BY created_at LIMIT 1",[workspace,conversation.id])).rows[0];
	  const effect=(await pool.query("SELECT id,payload FROM outbox WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id=$2 ORDER BY dispatch_sequence LIMIT 1",[workspace,conversation.id])).rows[0];
	  expect(message.body.stage_at_creation).toBe('NEW');
	  expect(effect.payload.stage_at_creation).toBe('NEW');
	  await flushSimulationEffects();
	  const outbound=(await pool.query("SELECT body FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='message' AND body->>'effect_id'=$2",[workspace,effect.id])).rows[0];
	  expect(outbound.body.stage_at_creation).toBe('NEW');
	  await putRecord(pool,{id:conversation.id,workspaceId:conversation.workspace_id,environment:'SIMULATION',kind:'conversation',version:conversation.version,body:{...conversation.body,stage:'COMMITTED'}});
	  const state=data(await request('GET',`/v1/number-flow-tests/${started.id}`));
	  expect(state.transcript.find((item:any)=>item.id===message.id)?.stage).toBe('NEW');
	  expect(state.transcript.find((item:any)=>item.technical?.effect_id===effect.id)?.stage).toBe('NEW');
	 });

	 it.each(['new','legacy'] as const)('classifies the %s lab as TEST through selection, receipt, benefits and canonical completion without REAL mutations',async(mode)=>{
	  const started=data(await request('POST',`/v1/channel-accounts/${sourceAccount.id}/flow-tests`,{contact_name:'Cliente laboratorio',start_mode:'SEEDED'}),201);
	  expect(data(await request('GET',`/v1/channel-accounts/${sourceAccount.id}/flow-tests/latest`))).toMatchObject({id:started.id,external_effects:false});
	  expect(new Set(started.assignments.map((item:any)=>item.product_name))).toEqual(new Set(['Producto A','Producto B']));
	  expect(started).toMatchObject({external_effects:false,isolation:{transport:'simulator',external_network:false,real_mutation:false,bank:'LAB_PLACEHOLDER',access:'LAB_ONLY'}});
	  expect(started.source).toMatchObject({freshness:'CURRENT',stale_reasons:[]});
	  const testSnapshot=(await getRecord(pool,workspace,'simulation',started.id))!,routeBManifest=testSnapshot.body.assignments.find((item:any)=>item.product_name==='Producto B'),routeBOffer=(await getRecord(pool,workspace,'offer',routeBManifest.offer_version_id))!;
	  const offerMedia=[routeBOffer.body.sales_flow.content.presentation.audio_asset_id,routeBOffer.body.sales_flow.content.presentation.pack_image_asset_id,routeBOffer.body.sales_flow.content.agreement.audio_asset_id,routeBOffer.body.sales_flow.content.collection.audio_asset_id];
	  expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='asset' AND id=ANY($2::uuid[])",[workspace,offerMedia])).rows[0].n).toBe(1);
	  expect(JSON.stringify(started)).not.toContain('REAL-SIGNED-VALUE');
	  expect(started.assignments.flatMap((item:any)=>item.entry_rules).find((rule:any)=>rule.kind==='link')?.value).toBe('Enlace configurado · valor protegido');
  await processCommands(100);
  let state=data(await request('GET',`/v1/number-flow-tests/${started.id}`));
  expect(state.routing.state).toBe('PRODUCT_SELECTION_REQUIRED');
  expect((await pool.query("SELECT count(*)::int count FROM commercial_assignments WHERE workspace_id=$1 AND environment='SIMULATION' AND account_id=$2",[workspace,(await getRecord(pool,workspace,'simulation',started.id))!.body.account_id])).rows[0].count).toBe(2);
  const labBindings=(await pool.query("SELECT body FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='binding'",[workspace])).rows;
  expect(JSON.stringify(labBindings)).not.toContain('REAL-SIGNED-VALUE');expect(JSON.stringify(labBindings)).toContain('https://simulation.invalid/entry/');
  const materialIds=started.materials.map((item:any)=>item.id),accessCopies=(await pool.query("SELECT body FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='asset' AND body->>'kind'='access' AND id=ANY($2::uuid[])",[workspace,materialIds])).rows;
  expect(accessCopies).toHaveLength(3);expect(JSON.stringify(accessCopies)).not.toContain('REAL-SECRET-MUST-NOT-CROSS');expect(accessCopies.every(row=>JSON.stringify(JSON.parse(decrypt(row.body.delivery_ciphertext))).includes('LAB-ONLY'))).toBe(true);
  const labOffers=await Promise.all(testSnapshot.body.assignments.map((item:any)=>getRecord(pool,workspace,'offer',item.offer_version_id))),bankIds=labOffers.map(item=>item!.body.payment_profile_version_id),banks=(await pool.query("SELECT body FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='bank_profile' AND id=ANY($2::uuid[])",[workspace,bankIds])).rows;
  expect(banks).toHaveLength(2);expect(banks.every(row=>row.body.bank==='SIMULATION'&&row.body.last4==='0000')).toBe(true);expect(JSON.stringify(banks)).not.toContain('REAL BANK');

  const routeB=started.assignments.find((item:any)=>item.product_name==='Producto B').selection_key;
  const selected=data(await request('POST',`/v1/number-flow-tests/${started.id}/actions`,{type:'select_product',selection_key:routeB}),202);
  await processCommands(100);await processNewWorkflows(100);
  state=data(await request('GET',`/v1/number-flow-tests/${started.id}`));
  expect(state.active_route.product_name).toBe('Producto B');expect(state.routing.state).toBe('RESOLVED');
  expect(state.transcript.some((item:any)=>item.direction==='INBOUND'&&item.text==='quiero b')).toBe(true);
  expect(selected.external_effects).toBe(false);

  await flushSimulationEffects();
  const initialSimulation=(await getRecord(pool,workspace,'simulation',started.id))!,initialConversation=(await getRecord(pool,workspace,'conversation',initialSimulation.body.conversation_id))!;
  const initialOrder=(await pool.query("SELECT * FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='order' AND body->>'conversation_id'=$2",[workspace,initialConversation.id])).rows[0];
  expect(initialOrder.body).toMatchObject({commercial_classification:'TEST',simulation_id:started.id,analytics_excluded_from_creation:true});
  const historicalMessages=(await pool.query("SELECT id,body FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='message' AND body->>'conversation_id'=$2 ORDER BY id",[workspace,initialConversation.id])).rows;
  const reconciliationBefore=(await pool.query("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='number.flow_test_classification_reconciled'",[workspace,started.id])).rows[0].n;
  if(mode==='legacy'){
   // Reproduce the persisted pre-fix graph without resetting any ID/cursor/history.
   for(const record of [initialConversation,initialOrder]){
    const body={...record.body};delete body.commercial_classification;delete body.analytics_excluded_from_creation;delete body.classification_source;if(record.kind==='order')delete body.simulation_id;
    await putRecord(pool,{id:record.id,workspaceId:workspace,environment:'SIMULATION',kind:record.kind,version:record.version,body});
   }
  }
  await continueVisible(started.id);
  const classified=(await getRecord(pool,workspace,'order',initialOrder.id))!;
  expect(classified.body).toMatchObject({commercial_classification:'TEST',simulation_id:started.id,analytics_excluded_from_creation:mode==='new'});
  expect(await activeLaunchTest(pool,classified)).toBe(true);
  expect((await getRecord(pool,workspace,'simulation',started.id))!.body.conversation_id).toBe(initialConversation.id);
  const reconciliationAfter=(await pool.query("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='number.flow_test_classification_reconciled'",[workspace,started.id])).rows[0].n;
  expect(reconciliationAfter-reconciliationBefore).toBe(mode==='legacy'?1:0);
  for(const message of historicalMessages)expect((await getRecord(pool,workspace,'message',message.id))!.body).toEqual(message.body);
  data(await request('POST',`/v1/number-flow-tests/${started.id}/actions`,{type:'question',text:'¿Qué incluye?'}),202);await processCommands(100);
  await processAgents(100,{
   propose:async()=>({proposal:{reply:'Respuesta determinista del vendedor de laboratorio.',intent:'question',confidence:1,tool:'none',grounding:['offer_snapshot']},usage:{input_tokens:1,output_tokens:1,cost_minor:0},provider:'fixture',model:'fixture'}),
   receipt:async()=>{throw new Error('UNUSED');},
  });
  await flushSimulationEffects();
  state=data(await request('GET',`/v1/number-flow-tests/${started.id}`));
  expect(state.transcript.some((item:any)=>item.direction==='OUTBOUND'&&item.text==='Respuesta determinista del vendedor de laboratorio.'&&['SENT','DELIVERED','READ'].includes(item.status))).toBe(true);
  data(await request('POST',`/v1/number-flow-tests/${started.id}/actions`,{type:'accept'}),202);await processCommands(100);
  await flushSimulationEffects();
  await continueVisible(started.id);
  data(await request('POST',`/v1/number-flow-tests/${started.id}/actions`,{type:'receipt',amount_minor:15000,currency:'MXN'}),202);await processCommands(100);
  state=data(await request('GET',`/v1/number-flow-tests/${started.id}`));
  expect(state.transcript.some((item:any)=>item.text==='¿Qué incluye?')).toBe(true);expect(state.orders).toHaveLength(1);expect(state.receipts).toHaveLength(1);
  expect(state.receipts[0]).toMatchObject({status:'HUMAN_REVIEW',analysis_status:'COMPLETED',amount_minor:15000,currency:'MXN'});
  expect(state.orders[0].sale_status).not.toBe('RECOGNIZED');
  const simulationPolicy=await readOperationalSettings(pool,workspace,'SIMULATION');
  await writeOperationalSettings(pool,workspace,'SIMULATION',simulationPolicy.version,{...simulationPolicy.body,contact_messages_per_minute:1},'Verify isolated flow tests can finish independently of REAL contact throttling.');
  data(await request('POST',`/v1/number-flow-tests/${started.id}/actions`,{type:'approve_receipt'}),202);await processCommands(100);
  await flushSimulationEffects();
  await continueVisible(started.id);
  const postApprovalEffects=(await pool.query("SELECT result FROM outbox WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id=$2",[workspace,(await getRecord(pool,workspace,'simulation',started.id))!.body.conversation_id])).rows;
  expect(postApprovalEffects.some((effect:any)=>effect.result?.reason==='CONTACT_FREQUENCY_LIMIT')).toBe(false);
  const limitedPolicy=await readOperationalSettings(pool,workspace,'SIMULATION');
  await writeOperationalSettings(pool,workspace,'SIMULATION',limitedPolicy.version,simulationPolicy.body,'Restore simulation frequency policy after isolated flow test assertion.');
  state=data(await request('GET',`/v1/number-flow-tests/${started.id}`));
  expect(state.receipts[0]).toMatchObject({status:'APPROVED',analysis_status:'HUMAN_REVIEWED'});
  expect(state.orders[0]).toMatchObject({id:initialOrder.id,sale_status:'TEST',sale_amount_minor:0,sale_currency:'MXN'});
  const paidOrder=(await getRecord(pool,workspace,'order',initialOrder.id))!;
  expect(paidOrder.body).toMatchObject({test_approved_amount_minor:15000,commercial_classification:'TEST'});
  expect(await approvedBenefitTotal(pool,paidOrder)).toBe(15000);
  const approvedReceipt=(await getRecord(pool,workspace,'receipt',state.receipts[0].id))!;
  for(const patch of [{status:'HUMAN_REVIEW'},{commercial_classification:'FALSE'},{source:'private_upload'},{conversation_id:randomUUID()}]){
   const c=await pool.connect();try{
    await c.query('BEGIN');
    if(patch.conversation_id)await putRecord(c,{id:patch.conversation_id,workspaceId:workspace,environment:'SIMULATION',kind:'conversation',body:initialConversation.body});
    await putRecord(c,{id:approvedReceipt.id,workspaceId:workspace,environment:'SIMULATION',kind:'receipt',version:approvedReceipt.version,body:{...approvedReceipt.body,...patch}});
    expect(await approvedBenefitTotal(c,paidOrder)).toBe(0);
   }finally{await c.query('ROLLBACK');c.release();}
  }
  expect((await pool.query("SELECT classification,amount_minor FROM receipt_sale_facts WHERE workspace_id=$1 AND environment='SIMULATION' AND order_id=$2",[workspace,paidOrder.id])).rows).toMatchObject([{classification:'TEST',amount_minor:'15000'}]);
  expect((await pool.query("SELECT count(*)::int n,COALESCE(sum(amount_minor),0)::text amount FROM receipt_sale_facts WHERE workspace_id=$1 AND environment='SIMULATION' AND order_id=$2 AND classification='VALID'",[workspace,paidOrder.id])).rows[0]).toEqual({n:0,amount:'0'});
  expect(state.fulfillments.map((item:any)=>item.release_on).sort()).toEqual(['commitment_accepted','receipt_approved']);
  const simulation=(await getRecord(pool,workspace,'simulation',started.id))!;
  const active=(await pool.query("SELECT id FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='conversation' AND body->>'account_id'=$2 AND body->>'routing_state'='RESOLVED' ORDER BY created_at DESC LIMIT 1",[workspace,simulation.body.account_id])).rows[0];
  const causal=(await pool.query("SELECT dispatch_sequence,payload FROM outbox WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id=$2 ORDER BY dispatch_sequence",[workspace,active.id])).rows;
  const thanks=causal.find((item:any)=>item.payload.workflow_node_id==='receipt_thanks'),post=causal.find((item:any)=>state.fulfillments.some((fulfillment:any)=>fulfillment.release_on==='receipt_approved'&&fulfillment.id===item.payload.fulfillment_id));
  expect(thanks).toBeTruthy();expect(post).toBeTruthy();expect(Number(thanks.dispatch_sequence)).toBeLessThan(Number(post.dispatch_sequence));
  expect((await getRecord(pool,workspace,'conversation',active.id))!.body.flow_state).toMatchObject({status:'WAITING',waiting_for:'closing_delivery_confirmed'});
  await pool.query("UPDATE outbox SET status='SENT',provider_message_id='lab-accepted:'||id::text,result=jsonb_build_object('accepted_at',now()),updated_at=now() WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id=$2 AND payload->>'workflow_recipe_step'='9'",[workspace,active.id]);
  await pool.query("UPDATE outbox SET status='SENT',provider_message_id='lab-grant:'||id::text,result=jsonb_build_object('accepted_at',now(),'access_ciphertext','LAB-ONLY'),updated_at=now() WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id=$2 AND payload->>'kind'='grant'",[workspace,active.id]);
  await pool.query("UPDATE outbox SET status='DELIVERED',provider_message_id=COALESCE(provider_message_id,'lab-delivered:'||id::text),updated_at=now() WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id=$2 AND payload ? 'fulfillment_id'",[workspace,active.id]);
  await materializeEffectResults(1000);
  expect((await getRecord(pool,workspace,'conversation',active.id))!.body.flow_state.status).toBe('FINISHED');
  expect((await setupProjection()).steps.find((item:any)=>item.key==='SIMULATION')).toMatchObject({status:'READY',cause:'SIMULATION_COMPLETED_CURRENT',evidence:{complete:true,blockers:[]}});
  await pool.query("INSERT INTO timers(workspace_id,environment,conversation_id,kind,due_at,logical_key) VALUES($1,'SIMULATION',$2,'followup',$3,$4)",[workspace,active.id,new Date(Date.parse(simulation.body.virtual_now)+45*60_000).toISOString(),'number-flow-test:'+randomUUID()]);
  data(await request('POST',`/v1/number-flow-tests/${started.id}/actions`,{type:'next_reminder'}),202);await processCommands(100);
  const advanced=(await getRecord(pool,workspace,'simulation',started.id))!;expect(Date.parse(advanced.body.virtual_now)-Date.parse(simulation.body.virtual_now)).toBe(45*60_000);
  expect(await realState()).toBe(realBefore);

	  const reset=data(await request('POST',`/v1/number-flow-tests/${started.id}/reset`,{}),201);expect(reset.id).not.toBe(started.id);expect((await getRecord(pool,workspace,'simulation',started.id))!.body.status).toBe('RESET');await processCommands(100);expect(await realState()).toBe(realBefore);
	 });

	 it('reconciles the legacy cursor with the automation runtime role and preserves durable history',async()=>{
  const started=data(await request('POST',`/v1/channel-accounts/${sourceAccount.id}/flow-tests`,{start_mode:'SEEDED',initial_message:'quiero b'}),201);
  await processCommands(100);
  const simulation=(await getRecord(pool,workspace,'simulation',started.id))!,conversation=(await getRecord(pool,workspace,'conversation',simulation.body.conversation_id))!;
  const order=(await pool.query("SELECT * FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='order' AND body->>'conversation_id'=$2",[workspace,conversation.id])).rows[0];
  const c=await pool.connect();try{
   await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[conversation.id]);
   for(const record of [conversation,order]){
    const body={...record.body};delete body.commercial_classification;delete body.analytics_excluded_from_creation;if(record.kind==='order')delete body.simulation_id;
    await putRecord(c,{id:record.id,workspaceId:workspace,environment:'SIMULATION',kind:record.kind,version:record.version,body});
   }
   await c.query('SET LOCAL ROLE commerce_automation');
   const resumed=await advanceWorkflow(c,conversation,'simulation_continue');
   expect(resumed.id).toBe(conversation.id);expect(resumed.body.flow_state.steps).toBeGreaterThan(conversation.body.flow_state.steps);
   const classified=(await getRecord(c,workspace,'order',order.id))!;
   expect(classified.version).toBe(order.version+2);expect(classified.body).toMatchObject({simulation_id:started.id,commercial_classification:'TEST',analytics_excluded_from_creation:false});
   expect((await c.query('SELECT count(*)::int n FROM record_versions WHERE record_id=$1 AND version=$2',[order.id,order.version])).rows[0].n).toBe(1);
   const same=await reconcileNumberFlowTestClassification(c,resumed);expect(same.version).toBe(resumed.version);expect((await getRecord(c,workspace,'order',order.id))!.version).toBe(classified.version);
  }finally{await c.query('ROLLBACK');c.release();}
  expect(await realState()).toBe(realBefore);
 });
	 it('rejects forged TEST scopes, mismatched assignments and automatic reclassification of financial history',async()=>{
  const started=data(await request('POST',`/v1/channel-accounts/${sourceAccount.id}/flow-tests`,{start_mode:'SEEDED',initial_message:'quiero b'}),201);
  await processCommands(100);
  const simulation=(await getRecord(pool,workspace,'simulation',started.id))!,conversation=(await getRecord(pool,workspace,'conversation',simulation.body.conversation_id))!;
  const order=(await pool.query("SELECT * FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='order' AND body->>'conversation_id'=$2",[workspace,conversation.id])).rows[0];
  expect(await activeLaunchTest(pool,order)).toBe(true);
  expect(await launchTestOrderFields(pool,{...conversation,environment:'REAL'})).toEqual({});
  expect(await activeLaunchTest(pool,{...order,environment:'REAL'})).toBe(false);
  for(const patch of [{assignment_id:randomUUID()},{offer_version_id:randomUUID()},{product_id:randomUUID()},{workflow_version_id:randomUUID()},{simulation_id:randomUUID()}])expect(await activeLaunchTest(pool,{...order,body:{...order.body,...patch}})).toBe(false);
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const changed=await putRecord(client,{id:conversation.id,workspaceId:workspace,environment:'SIMULATION',kind:'conversation',version:conversation.version,body:{...conversation.body,assignment_id:randomUUID()}});
   await expect(launchTestOrderFields(client,changed)).rejects.toThrow('NUMBER_FLOW_TEST_SCOPE_INVALID');
   expect(await activeLaunchTest(client,order)).toBe(false);
  }finally{await client.query('ROLLBACK');client.release();}
  const modifiedMode=await pool.connect();try{
   await modifiedMode.query('BEGIN');
   await putRecord(modifiedMode,{id:simulation.id,workspaceId:workspace,environment:'SIMULATION',kind:'simulation',version:simulation.version,body:{...simulation.body,mode:'GENERIC_SIMULATION',offer_version_id:conversation.body.offer_version_id}});
   expect(await activeLaunchTest(modifiedMode,order)).toBe(false);
   await expect(launchTestOrderFields(modifiedMode,conversation)).rejects.toThrow('NUMBER_FLOW_TEST_SCOPE_INVALID');
  }finally{await modifiedMode.query('ROLLBACK');modifiedMode.release();}
  for(const evidence of ['receipt','contribution','sale_marker','reconciled_marker','explicit_classification'] as const){
   const c=await pool.connect();try{
    await c.query('BEGIN');
    const body={...order.body};delete body.commercial_classification;delete body.simulation_id;
    if(evidence==='sale_marker')body.sale_status='RECOGNIZED';if(evidence==='reconciled_marker')body.reconciled_amount_minor=100;if(evidence==='explicit_classification')body.commercial_classification='COMMERCIAL';
    const legacy=await putRecord(c,{id:order.id,workspaceId:workspace,environment:'SIMULATION',kind:'order',version:order.version,body});
    if(evidence==='receipt'||evidence==='contribution'){
     const receipt=await putRecord(c,{workspaceId:workspace,environment:'SIMULATION',kind:'receipt',body:{order_id:order.id,conversation_id:conversation.id,status:'APPROVED'}});
     if(evidence==='contribution')await c.query("INSERT INTO payment_contributions(workspace_id,environment,order_id,receipt_id,payment_key,amount_minor,currency,currency_source,evidence_sha256,effective_at,provenance) VALUES($1,'SIMULATION',$2,$3,'primary',100,'MXN','document',$4,now(),'{}')",[workspace,order.id,receipt.id,hash(randomUUID())]);
    }
    await expect(reconcileNumberFlowTestClassification(c,conversation)).rejects.toThrow(evidence==='explicit_classification'?'NUMBER_FLOW_TEST_CLASSIFICATION_CONFLICT':'NUMBER_FLOW_TEST_FINANCIAL_HISTORY_REQUIRES_REVIEW');
    expect((await getRecord(c,workspace,'order',order.id))!.version).toBe(legacy.version);
    expect((await getRecord(c,workspace,'conversation',conversation.id))!.version).toBe(conversation.version);
   }finally{await c.query('ROLLBACK');c.release();}
  }
  expect(await realState()).toBe(realBefore);
 });
	 it('keeps completed setup blocked by unresolved work anywhere in the historical simulation graph',async()=>{
	  const started=data(await request('POST',`/v1/channel-accounts/${sourceAccount.id}/flow-tests`,{contact_name:'Grafo histórico'}),201);
	  let simulation=(await getRecord(pool,workspace,'simulation',started.id))!;const assignment=simulation.body.assignments[0];
	  const contact=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'contact',body:{name:'Contacto de grafo',identity:'opaque:historical-graph',status:'LEAD'}});
	  const conversationBody={simulation_id:simulation.id,account_id:simulation.body.account_id,contact_id:contact.id,assignment_id:assignment.assignment_id,product_id:assignment.product_id,offer_version_id:assignment.offer_version_id,workflow_version_id:assignment.workflow_version_id,routing_state:'RESOLVED',flow_state:{status:'FINISHED'}};
	  const historical=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'conversation',body:{...conversationBody,journey_label:'historical'}});
	  const current=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'conversation',body:{...conversationBody,journey_label:'current'}});
	  simulation=await putRecord(pool,{id:simulation.id,workspaceId:workspace,environment:'SIMULATION',kind:'simulation',version:simulation.version,body:{...simulation.body,status:'COMPLETED',conversation_id:current.id,completed_at:new Date().toISOString()}});
	  let simulationStep=(await setupProjection()).steps.find((item:any)=>item.key==='SIMULATION');
	  expect(simulationStep).toMatchObject({status:'READY',evidence:{complete:true,graph:{conversation_count:2,pending_commands:0,unknown_commands:0,failed_commands:0,pending_effects:0,unknown_effects:0,failed_effects:0,pending_timers:0}}});

	  const receipt=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'receipt',body:{conversation_id:historical.id,status:'HUMAN_REVIEW',analysis_status:'COMPLETED'}});
	  const failed=(await pool.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,status,result,idempotency_key) VALUES($1,'SIMULATION','receipt_review',$2,'fixture',$3,'FAILED',$4,$5) RETURNING id",[workspace,receipt.id,{decision:'APPROVED'},{error:'VERSION_CONFLICT'},randomUUID()])).rows[0];
	  const later=(await pool.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,status,result,idempotency_key) VALUES($1,'SIMULATION','simulation_advance',$2,'fixture','{}','APPLIED','{}',$3) RETURNING id",[workspace,simulation.id,randomUUID()])).rows[0];
	  simulation=await putRecord(pool,{id:simulation.id,workspaceId:workspace,environment:'SIMULATION',kind:'simulation',version:simulation.version,body:{...simulation.body,last_command_id:later.id}});
	  simulationStep=(await setupProjection()).steps.find((item:any)=>item.key==='SIMULATION');
	  expect(simulationStep).toMatchObject({status:'BLOCKED',cause:'SIMULATION_COMMANDS_FAILED',evidence:{complete:false,graph:{failed_commands:1}}});

	  await pool.query("UPDATE commands SET status='APPLIED',result='{}',updated_at=now() WHERE id=$1",[failed.id]);
	  const effect=(await pool.query("INSERT INTO outbox(workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,status,config_hash) VALUES($1,'SIMULATION',$2,$3,$4,$5,$6,'UNKNOWN',$7) RETURNING id",[workspace,simulation.body.account_id,historical.id,contact.id,'historical-graph:'+randomUUID(),{kind:'text',text:'Efecto histórico incierto'},hash('historical-graph')])).rows[0];
	  simulationStep=(await setupProjection()).steps.find((item:any)=>item.key==='SIMULATION');
	  expect(simulationStep).toMatchObject({status:'UNKNOWN',cause:'SIMULATION_EFFECTS_UNKNOWN',evidence:{complete:false,graph:{unknown_effects:1}}});

	  await pool.query("UPDATE outbox SET status='CANCELLED',result=$2,updated_at=now() WHERE id=$1",[effect.id,{reason:'SYNTHETIC_RESOLUTION'}]);
	  const timer=(await pool.query("INSERT INTO timers(workspace_id,environment,conversation_id,kind,due_at,logical_key) VALUES($1,'SIMULATION',$2,'followup',$3,$4) RETURNING id",[workspace,historical.id,new Date(Date.parse(simulation.body.virtual_now)+60_000).toISOString(),'historical-graph:'+randomUUID()])).rows[0];
	  simulationStep=(await setupProjection()).steps.find((item:any)=>item.key==='SIMULATION');
	  expect(simulationStep).toMatchObject({status:'IN_PROGRESS',cause:'SIMULATION_TIMERS_PENDING',evidence:{complete:false,graph:{pending_timers:1}}});

	  await pool.query("UPDATE timers SET status='CANCELLED' WHERE id=$1",[timer.id]);
	  simulationStep=(await setupProjection()).steps.find((item:any)=>item.key==='SIMULATION');
	  expect(simulationStep).toMatchObject({status:'READY',cause:'SIMULATION_COMPLETED_CURRENT',evidence:{complete:true,graph:{conversation_count:2,failed_commands:0,unknown_effects:0,pending_timers:0}}});
	 });

		 it('publishes equivalent strict MCP requests and rejects insufficient service scope',async()=>{
  expect(numberTools.number_flow_test_action.schema.body.safeParse({type:'receipt',amount_minor:0,currency:'MXN'}).success).toBe(false);
  expect(numberTools.number_flow_test_action.schema.body.safeParse({type:'approve_receipt'}).success).toBe(true);
	  expect(numberTools.number_flow_test_start.schema.body.safeParse({initial_message:'No debe sembrarse implícitamente'}).success).toBe(false);
	  expect(numberTools.number_flow_test_reset.schema.body.safeParse({initial_message:'No debe sembrarse implícitamente'}).success).toBe(false);
	  expect(numberRequest('number_flow_test_start',{account_id:sourceAccount.id,body:numberTools.number_flow_test_start.schema.body.parse({contact_name:'MCP fixture'}),idempotency_key:'mcp-fixture-key',environment:'REAL'})).toMatchObject({route:`/v1/channel-accounts/${sourceAccount.id}/flow-tests`,method:'POST',body:{contact_name:'MCP fixture',start_mode:'EMPTY',environment:'SIMULATION'}});
	  expect(numberRequest('number_flow_test_latest',{account_id:sourceAccount.id,environment:'REAL'})).toEqual({route:`/v1/channel-accounts/${sourceAccount.id}/flow-tests/latest?environment=SIMULATION`,method:'GET'});
  expect(numberRequest('number_flow_test_action',{test_id:randomUUID(),body:{type:'next_reminder'},idempotency_key:'mcp-fixture-key',environment:'REAL'})).toMatchObject({method:'POST',body:{type:'next_reminder',environment:'SIMULATION'}});
  expect(numberRequest('number_flow_test_action',{test_id:randomUUID(),body:{type:'approve_receipt'},idempotency_key:'mcp-fixture-key',environment:'REAL'})).toMatchObject({method:'POST',body:{type:'approve_receipt',environment:'SIMULATION'}});
	  expect(numberRequest('number_flow_test_reset',{test_id:randomUUID(),body:numberTools.number_flow_test_reset.schema.body.parse({}),idempotency_key:'mcp-fixture-key',environment:'REAL'})).toMatchObject({method:'POST',body:{start_mode:'EMPTY',environment:'SIMULATION'}});
	  const spec=(await app.inject({method:'GET',url:'/v1/openapi.json',headers:{cookie,origin}})).json(),operation=spec.paths[`/v1/channel-accounts/{id}/flow-tests`].post,reset=spec.paths[`/v1/number-flow-tests/{id}/reset`].post,latest=spec.paths[`/v1/channel-accounts/{id}/flow-tests/latest`].get;
	  expect(operation['x-required-service-scopes']).toEqual(['simulations:run','channels:read','assignments:read','workflows:read','products:read']);expect(operation.parameters.find((item:any)=>item.name==='environment').schema).toEqual({type:'string',enum:['SIMULATION'],default:'SIMULATION'});
	  expect(operation.requestBody.content['application/json'].schema.required??[]).not.toContain('contact_name');
	  expect(operation.requestBody.content['application/json'].schema.properties.start_mode.default).toBe('EMPTY');expect(reset.requestBody.content['application/json'].schema.properties.start_mode.default).toBe('EMPTY');
	  expect(latest).toMatchObject({security:[{session:[]},{service:[]}],'x-mcp-tool':'number_flow_test_latest','x-required-service-scopes':['simulations:run','channels:read','assignments:read','workflows:read','products:read'],'x-environment-contract':'SIMULATION_ONLY_WITH_READ_ONLY_REAL_SNAPSHOT'});
  const token=randomBytes(32).toString('hex');await pool.query("INSERT INTO service_tokens(workspace_id,actor_id,name,token_hash,scopes,expires_at,allowed_environments) VALUES($1,'limited-flow-test','Limited',$2,$3,now()+interval '1 hour',$4)",[workspace,hash(token),JSON.stringify(['simulations:run','channels:read']),JSON.stringify(['REAL','SIMULATION'])]);
  const denied=await request('POST',`/v1/channel-accounts/${sourceAccount.id}/flow-tests`,{},randomUUID(),'Bearer '+token);expect(denied.statusCode).toBe(403);expect(denied.json().error.code).toBe('FORBIDDEN');expect(await realState()).toBe(realBefore);
	 });

	 it('marks a snapshot stale after source revisions change and reset captures the new source',async()=>{
	  const started=data(await request('POST',`/v1/channel-accounts/${sourceAccount.id}/flow-tests`,{contact_name:'Freshness fixture'}),201);
	  expect(started.source).toMatchObject({freshness:'CURRENT',stale_reasons:[]});
	  await processCommands(100);
	  sourceAccount=await putRecord(pool,{id:sourceAccount.id,version:sourceAccount.version,workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{...sourceAccount.body,alias:'Número comercial actualizado'}});
	  await pool.query("UPDATE commercial_assignments SET revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND environment='REAL' AND account_id=$2",[workspace,sourceAccount.id]);
	  const stale=data(await request('GET',`/v1/number-flow-tests/${started.id}`));
	  expect(stale.source.freshness).toBe('STALE');
	  expect(stale.source.stale_reasons).toEqual(expect.arrayContaining(['SOURCE_ACCOUNT_CHANGED','ASSIGNMENTS_CHANGED']));
	  expect((await setupProjection()).steps.find((item:any)=>item.key==='SIMULATION')).toMatchObject({status:'REQUIRES_ATTENTION',cause:'SOURCE_ACCOUNT_CHANGED',blockers:expect.arrayContaining(['SOURCE_ACCOUNT_CHANGED','ASSIGNMENTS_CHANGED']),evidence:{complete:false,blockers:expect.arrayContaining(['SOURCE_ACCOUNT_CHANGED','ASSIGNMENTS_CHANGED'])}});
	  const reset=data(await request('POST',`/v1/number-flow-tests/${started.id}/reset`,{}),201);
	  expect(reset.source).toMatchObject({freshness:'CURRENT',stale_reasons:[]});
	 });
});
