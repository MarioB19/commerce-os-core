import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {applyCommand} from '../../apps/automation-worker/src/commands.js';
import {processAgents} from '../../apps/automation-worker/src/agents.js';
import {materializeEffectResults} from '../../apps/automation-worker/src/effect-results.js';
import {materializeMessage} from '../../apps/automation-worker/src/inbound.js';
import {advanceWorkflow,ensureOrder} from '../../apps/automation-worker/src/workflows.js';
import {buyerExcluded,pool,putRecord,getRecord,withTransaction} from '../../packages/db/src/index.js';
import {salesAgreementRecipeV1,salesAgreementWorkflowV1} from '../../packages/domain/src/sales/sales-recipe-v2.js';
import type {Body,DomainRecord} from '../../packages/contracts/src/index.js';

const primaryWorkspace=`mcl-sales-v2-${randomUUID()}`;
const isolatedWorkspace=`mcl-sales-v2-isolated-${randomUUID()}`;
const interruptionWorkspace=`mcl-sales-v2-interruption-${randomUUID()}`;
const pdfWorkspace=`mcl-sales-v2-pdfs-${randomUUID()}`;
const environment='SIMULATION' as const;
const expectedRecipeNodes=[
 'presentation_audio','pack_image','offer_text','agreement_audio','agreement_prompt',
 'prepayment_fulfillment','collection_audio','payment_instructions','receipt_thanks','postpayment_fulfillment',
] as const;

type Catalog={
 account:DomainRecord;
 secondAccount:DomainRecord;
 mclProduct:DomainRecord;
 otherProduct:DomainRecord;
 mclOffer:DomainRecord;
 otherOffer:DomainRecord;
 mclWorkflow:DomainRecord;
 otherWorkflow:DomainRecord;
 mclAgent:DomainRecord;
 otherAgent:DomainRecord;
 assets:Record<'presentation'|'pack'|'agreement'|'collection'|'core'|'calendar'|'kit',DomainRecord>;
 pdfs:DomainRecord[];
};

let catalog:Catalog;
let isolatedCatalog:Catalog;
let interruptionCatalog:Catalog;
let pdfCatalog:Catalog;

const record=(workspace:string,kind:string,body:Body)=>putRecord(pool,{workspaceId:workspace,environment,kind,body});

async function createAssignment(
 workspace:string,
 account:DomainRecord,
 product:DomainRecord,
 offer:DomainRecord,
 workflow:DomainRecord,
 agent:DomainRecord,
 aliases:string[],
){
 const id=randomUUID();
 const binding=await record(workspace,'binding',{
  account_id:account.id,
  product_id:product.id,
  offer_version_id:offer.id,
  workflow_version_id:workflow.id,
  agent_version_id:agent.id,
  entry_rules:aliases.map(value=>({kind:'keyword',value})),
  assignment_id:id,
  assignment_revision:1,
  valid_from:'2026-01-01T00:00:00.000Z',
  source:'mcl-sales-v2-integration-fixture',
  evidence:'Explicit synthetic routing fixture',
  confidence:'confirmed',
 });
 await pool.query(
  `INSERT INTO commercial_assignments(id,workspace_id,environment,account_id,product_id,binding_id,revision)
   VALUES($1,$2,$3,$4,$5,$6,1)`,
  [id,workspace,environment,account.id,product.id,binding.id],
 );
 await pool.query(
  `INSERT INTO commercial_assignment_history(assignment_id,revision,binding_id,state,actor_id,reason)
   VALUES($1,1,$2,'ACTIVE','integration-test','Explicit synthetic routing fixture')`,
  [id,binding.id],
 );
 return{id,binding};
}

async function createCatalog(workspace:string,pdfCount=0):Promise<Catalog>{
 const assets={} as Catalog['assets'];
 for(const [key,mime] of [
  ['presentation','audio/mpeg'],['pack','image/png'],['agreement','audio/mpeg'],['collection','audio/mpeg'],
 ] as const)assets[key]=await record(workspace,'asset',{
  name:`Synthetic ${key}`,
  kind:'file',
  mime_type:mime,
  storage_key:`fixtures/${randomUUID()}`,
  sha256:randomBytes(32).toString('hex'),
  status:'READY',
 });
 for(const key of ['core','calendar','kit'] as const)assets[key]=await record(workspace,'asset',{
  name:`Synthetic ${key}`,
  kind:'link',
  url:`https://example.invalid/mcl/${key}`,
  status:'READY',
 });
 const pdfs=[];
 for(let index=0;index<pdfCount;index++)pdfs.push(await record(workspace,'asset',{name:`Mi Ciclo Listo · bono-${index+1}.pdf`,kind:'file',mime_type:'application/pdf',status:'READY',storage_key:`fixtures/${randomUUID()}`,sha256:randomBytes(32).toString('hex')}));

 const bank=await record(workspace,'bank_profile',{name:'Synthetic protected bank',bank:'SIMULATION',last4:'0000',status:'READY'});
 const policy=await record(workspace,'receipt_policy',{name:'Synthetic human review',auto_approve:false,allow_amount_mismatch:true,min_amount_minor:1,require_currency:true,status:'PUBLISHED'});
 const mclProduct=await record(workspace,'product',{name:'Mi Ciclo Listo — Preescolar y Primaria',status:'PUBLISHED',aliases:['Mi Ciclo Listo','Ciclo Listo']});
 const otherProduct=await record(workspace,'product',{name:'Curso Alterno',status:'PUBLISHED',aliases:['Curso Alterno','Producto B']});
 const mclAgent=await record(workspace,'agent',{name:'Lupita synthetic',product_id:mclProduct.id,status:'PUBLISHED',provider:'deterministic',knowledge:'Synthetic MCL knowledge',instructions:'Synthetic MCL instructions'});
 const otherAgent=await record(workspace,'agent',{name:'Seller B synthetic',product_id:otherProduct.id,status:'PUBLISHED',provider:'deterministic',knowledge:'Synthetic B knowledge',instructions:'Synthetic B instructions'});
 const workflowDefinition=salesAgreementWorkflowV1({
  presentation_audio_id:assets.presentation.id,
  pack_image_id:assets.pack.id,
  agreement_audio_id:assets.agreement.id,
  collection_audio_id:assets.collection.id,
 },{
  offer:'Recibes el paquete completo por $97 MXN.',
  agreement:'¿Llegamos a este acuerdo? Responde SÍ, LO QUIERO.',
  payment:'{{bank_instructions}}\nEnvía tu comprobante.',
  thanks:'Comprobante aprobado. Gracias por cumplir tu palabra.',
 });
 const mclWorkflow=await record(workspace,'workflow',{...workflowDefinition,product_id:mclProduct.id,status:'PUBLISHED'});
 const otherWorkflow=await record(workspace,'workflow',{name:'Alternate terminal flow',product_id:otherProduct.id,status:'PUBLISHED',entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]});
 const mclOffer=await record(workspace,'offer',{
  name:'Mi Ciclo Listo · pago positivo',
  product_id:mclProduct.id,
  status:'PUBLISHED',
  currency:'MXN',
  base_amount_minor:9700,
  payment_profile_version_id:bank.id,
  receipt_policy_version_id:policy.id,
  workflow_version_id:mclWorkflow.id,
  agent_version_id:mclAgent.id,
  billing_delay_seconds:0,
  positive_payment_unlocks_all:true,
  fulfillment:[
   {asset_id:assets.core.id,release_on:'commitment_accepted'},
   ...pdfs.map(asset=>({asset_id:asset.id,release_on:'commitment_accepted'})),
   {asset_id:assets.calendar.id,release_on:'receipt_approved'},
   {asset_id:assets.kit.id,release_on:'receipt_approved'},
  ],
  sales_flow:{entry_aliases:['Mi Ciclo Listo','Ciclo Listo'],recipe:salesAgreementRecipeV1()},
 });
 const otherOffer=await record(workspace,'offer',{
  name:'Curso Alterno',product_id:otherProduct.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:23000,
  workflow_version_id:otherWorkflow.id,agent_version_id:otherAgent.id,fulfillment:[],sales_flow:{entry_aliases:['Curso Alterno','Producto B']},
 });
 const account=await record(workspace,'channel_account',{name:'Synthetic number one',provider:'simulator',status:'WORKING',sending_enabled:false});
 const secondAccount=await record(workspace,'channel_account',{name:'Synthetic number two',provider:'simulator',status:'WORKING',sending_enabled:false});
 await createAssignment(workspace,account,mclProduct,mclOffer,mclWorkflow,mclAgent,['Mi Ciclo Listo','Ciclo Listo']);
 await createAssignment(workspace,account,otherProduct,otherOffer,otherWorkflow,otherAgent,['Curso Alterno','Producto B']);
 await createAssignment(workspace,secondAccount,otherProduct,otherOffer,otherWorkflow,otherAgent,['Curso Alterno','Producto B']);
 return{account,secondAccount,mclProduct,otherProduct,mclOffer,otherOffer,mclWorkflow,otherWorkflow,mclAgent,otherAgent,assets,pdfs};
}

async function inbound(account:DomainRecord,identity:string,text:string,extra:Body={}){
 const event={
  key:randomUUID(),type:'message' as const,providerAt:new Date().toISOString(),identity,text,kind:'text' as const,payload:{},...extra,
 };
 return withTransaction(client=>materializeMessage(client,account,event as never,randomUUID()));
}

async function current(conversation:DomainRecord){
 return(await getRecord(pool,conversation.workspace_id,'conversation',conversation.id))!;
}

async function attachAndApprove(conversation:DomainRecord,amountMinor:number,paymentKey:string){
 const asset=await record(conversation.workspace_id,'asset',{
  name:`Synthetic receipt ${paymentKey}`,
  kind:'file',mime_type:'image/png',storage_key:`receipts/${randomUUID()}`,
  sha256:randomBytes(32).toString('hex'),status:'READY',
 });
 const received=await withTransaction(client=>applyCommand(client,{
  id:randomUUID(),workspace_id:conversation.workspace_id,environment,kind:'conversation_command',resource_id:conversation.id,actor_id:'synthetic-customer',
  payload:{type:'receipt_received',asset_id:asset.id},
 }));
 const receipt=(await getRecord(pool,conversation.workspace_id,'receipt',String(received.receipt_id)))!;
 await withTransaction(client=>applyCommand(client,{
  id:randomUUID(),workspace_id:conversation.workspace_id,environment,kind:'receipt_review',resource_id:receipt.id,actor_id:'synthetic-reviewer',
  payload:{expected_version:receipt.version,decision:'APPROVED',amount_minor:amountMinor,currency:'MXN',payment_key:paymentKey,reason:'Observed synthetic receipt amount'},
 }));
 return(await getRecord(pool,conversation.workspace_id,'order',String(received.order_id)))!;
}

async function addFollowup(conversation:DomainRecord,label:string){
 await pool.query(
  `INSERT INTO timers(workspace_id,environment,conversation_id,kind,payload,due_at,logical_key)
   VALUES($1,$2,$3,'followup',$4,now()+interval '1 hour',$5)`,
  [conversation.workspace_id,environment,conversation.id,{purpose:'remarketing'},`mcl-v2:${label}:${randomUUID()}`],
 );
}
async function confirmInitialDelivery(conversation:DomainRecord){
 const effects=(await pool.query("SELECT id FROM outbox WHERE workspace_id=$1 AND environment=$2 AND conversation_id=$3 AND payload ? 'fulfillment_id' ORDER BY dispatch_sequence",[conversation.workspace_id,environment,conversation.id])).rows;
 for(const [index,effect] of effects.entries())await pool.query("UPDATE outbox SET status='DELIVERED',provider_message_id=$2,updated_at=now() WHERE id=$1",[effect.id,`prepayment-confirmed-${index}`]);
 await materializeEffectResults(1000);
}

beforeAll(async()=>{
 catalog=await createCatalog(primaryWorkspace);
 isolatedCatalog=await createCatalog(isolatedWorkspace);
 interruptionCatalog=await createCatalog(interruptionWorkspace);
 pdfCatalog=await createCatalog(pdfWorkspace,9);
});

afterAll(async()=>{await pool.end();});

describe('Mi Ciclo Listo sales agreement v2 runtime',()=>{
 it('holds collection until all nine direct PDFs and portal access are delivered',async()=>{
  const identity=`opaque:pdf-buyer-${randomUUID()}`;
  let journey=(await inbound(pdfCatalog.account,identity,'Quiero Mi Ciclo Listo'))!;
  journey=await withTransaction(client=>advanceWorkflow(client,journey));
  await inbound(pdfCatalog.account,identity,'Si envíalo');
  journey=await current(journey);
  expect(journey.body.flow_state).toMatchObject({status:'WAITING',waiting_for:'prepayment_delivery_confirmed'});
  const effects=(await pool.query("SELECT * FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 AND payload ? 'fulfillment_id' ORDER BY dispatch_sequence",[pdfWorkspace,journey.id])).rows;
  expect(effects).toHaveLength(10);
  expect((await pool.query("SELECT count(*)::int count FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 AND payload->>'workflow_recipe_step' IN ('7','8')",[pdfWorkspace,journey.id])).rows[0].count).toBe(0);
  for(const [index,effect] of effects.entries())await pool.query("UPDATE outbox SET status=$2,provider_message_id=$3,updated_at=now() WHERE id=$1",[effect.id,index===9?'SENT':'DELIVERED',`pdf-delivery-${index}`]);
  await materializeEffectResults(1000);
  expect((await current(journey)).body.flow_state.waiting_for).toBe('prepayment_delivery_confirmed');
  await inbound(pdfCatalog.account,identity,'Porque no contestas');
  await processAgents(100,{propose:async()=>({proposal:{reply:'Mensaje sin fuente',intent:'question',confidence:1,tool:'none',grounding:[]},usage:{input_tokens:1,output_tokens:1,cost_minor:0},provider:'fixture',model:'fixture'}),receipt:async()=>{throw new Error('UNUSED');}});
  expect((await current(journey)).body).toMatchObject({ai_status:'COMPLETED',flow_state:{waiting_for:'prepayment_delivery_confirmed'}});
  const reply=(await pool.query("SELECT payload FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 AND payload->>'purpose'='seller_reply' ORDER BY dispatch_sequence DESC LIMIT 1",[pdfWorkspace,journey.id])).rows[0];
  expect(reply?.payload.text).toContain('Aquí sigo');
  await pool.query("UPDATE outbox SET status='DELIVERED',updated_at=now() WHERE id=$1",[effects[9].id]);
  await materializeEffectResults(1000);
  expect((await current(journey)).body.flow_state.waiting_for).toBe('receipt_approved');
  await materializeEffectResults(1000);
  expect((await pool.query("SELECT payload->>'workflow_recipe_step' step FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 AND payload->>'workflow_recipe_step' IN ('7','8') ORDER BY dispatch_sequence",[pdfWorkspace,journey.id])).rows.map(row=>row.step)).toEqual(['7','8']);
  await inbound(pdfCatalog.account,identity,'¿Me garantizas algo fuera de la oferta?');
  await processAgents(100,{propose:async()=>({proposal:{reply:'Afirmación no sustentada',intent:'question',confidence:1,tool:'none',grounding:[]},usage:{input_tokens:1,output_tokens:1,cost_minor:0},provider:'fixture',model:'fixture'}),receipt:async()=>{throw new Error('UNUSED');}});
  expect((await current(journey)).body.ai_status).toBe('HUMAN_REVIEW');
  const acknowledgement=(await pool.query("SELECT payload FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 AND payload->>'purpose'='seller_review_ack' ORDER BY dispatch_sequence DESC LIMIT 1",[pdfWorkspace,journey.id])).rows[0];
  expect(acknowledgement?.payload.text).toContain('Recibí tu mensaje');
 });
 it.each(['Si envíalo','Ok dámelo'])('commits an explicit pending agreement and releases the initial material: %s',async reply=>{
  const identity=`opaque:agreement-${randomUUID()}`;
  let journey=(await inbound(catalog.account,identity,'Quiero Mi Ciclo Listo'))!;
  journey=await withTransaction(client=>advanceWorkflow(client,journey));
  expect(journey.body.flow_state).toMatchObject({status:'WAITING',waiting_for:'commitment'});
  await inbound(catalog.account,identity,reply);
  journey=await current(journey);
  const order=(await withTransaction(client=>ensureOrder(client,journey)))!;
  expect(order.body).toMatchObject({status:'COMMITTED'});
  expect(order.body.committed_at).toBeTruthy();
  expect(journey.body.flow_state).toMatchObject({status:'WAITING',waiting_for:'prepayment_delivery_confirmed'});
  const initial=(await pool.query("SELECT body FROM records WHERE workspace_id=$1 AND kind='fulfillment' AND body->>'order_id'=$2",[primaryWorkspace,order.id])).rows;
  expect(initial.map(row=>row.body.asset_id)).toEqual([catalog.assets.core.id]);
  await confirmInitialDelivery(journey);
  expect((await current(journey)).body.flow_state).toMatchObject({status:'WAITING',waiting_for:'receipt_approved'});
 });

 it('routes two assigned products explicitly and never guesses from yes, amount or receipt evidence',async()=>{
  const ambiguousInputs:[string,Body][]=[
   ['Sí',{}],
   ['$97 MXN',{}],
   ['Adjunto el comprobante',{}],
   ['',{kind:'image',media:{providerId:'synthetic-receipt',mimeType:'image/png',filename:'comprobante.png'}}],
  ];
  for(const [index,[text,extra]] of ambiguousInputs.entries()){
   const unresolved=(await inbound(catalog.account,`opaque:unresolved-${index}-${randomUUID()}`,text,extra))!;
   expect(unresolved.body).toMatchObject({routing_state:'PRODUCT_SELECTION_REQUIRED'});
   expect(unresolved.body.product_id).toBeUndefined();
   expect(await withTransaction(client=>ensureOrder(client,unresolved))).toBeUndefined();
  }

  const mcl=(await inbound(catalog.account,`opaque:mcl-route-${randomUUID()}`,'Quiero Mi Ciclo Listo'))!;
  const alternate=(await inbound(catalog.account,`opaque:alternate-route-${randomUUID()}`,'Me interesa Curso Alterno'))!;
  expect(mcl.body).toMatchObject({routing_state:'RESOLVED',product_id:catalog.mclProduct.id,offer_version_id:catalog.mclOffer.id});
  expect(alternate.body).toMatchObject({routing_state:'RESOLVED',product_id:catalog.otherProduct.id,offer_version_id:catalog.otherOffer.id});
  expect(mcl.body.assignment_id).not.toBe(alternate.body.assignment_id);
 });

 it('pauses the unstarted recipe suffix, answers, and resumes from that exact step only after effect-results confirms transport',async()=>{
  const identity=`opaque:interrupted-buyer-${randomUUID()}`;
  let journey=(await inbound(interruptionCatalog.account,identity,'Quiero Mi Ciclo Listo'))!;
  journey=await withTransaction(client=>advanceWorkflow(client,journey));
  expect(journey.body.flow_state).toMatchObject({status:'WAITING',waiting_for:'commitment'});
  const initial=(await pool.query(
   `SELECT * FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 AND payload ? 'workflow_recipe_step' ORDER BY dispatch_sequence`,
   [interruptionWorkspace,journey.id],
  )).rows;
  expect(initial.map(effect=>Number(effect.payload.workflow_recipe_step))).toEqual([1,2,3,4,5]);

  await pool.query(
   "UPDATE outbox SET status='SENT',provider_message_id='confirmed-1',result=$2,updated_at=now() WHERE id=$1",
   [initial[0].id,{accepted_at:new Date().toISOString()}],
  );
  await pool.query(
   "UPDATE outbox SET status='UNKNOWN',attempts=1,result=$2,updated_at=now() WHERE id=$1",
   [initial[1].id,{reason:'FIXTURE_RECIPE_RESPONSE_LOST'}],
  );
  await materializeEffectResults(1000);
  await inbound(interruptionCatalog.account,identity,'¿Sí funciona para mi hija?');
  journey=await current(journey);
  const interrupted=(await pool.query(
   `SELECT * FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 AND payload ? 'workflow_recipe_step' ORDER BY dispatch_sequence`,
   [interruptionWorkspace,journey.id],
  )).rows;
  expect(interrupted.map(effect=>effect.status)).toEqual(['SENT','UNKNOWN','CANCELLED','CANCELLED','CANCELLED']);
  expect(interrupted.slice(2).every(effect=>Number(effect.attempts)===0&&effect.result.superseded_before_send===true)).toBe(true);
  expect(journey.body.recipe_interruption).toMatchObject({status:'AWAITING_SELLER_REPLY',pending_recipe_steps:[3,4,5]});
  expect((await withTransaction(client=>ensureOrder(client,journey)))!.body.committed_at).toBeUndefined();

  await processAgents(100,{
   propose:async()=>({proposal:{reply:'Sí. El material corresponde a la oferta seleccionada.',intent:'question',confidence:1,tool:'none',grounding:['offer_snapshot']},usage:{input_tokens:1,output_tokens:1,cost_minor:0},provider:'fixture',model:'fixture'}),
   receipt:async()=>{throw new Error('UNUSED');},
  });
  journey=await current(journey);
  expect(journey.body.recipe_interruption.status).toBe('AWAITING_SELLER_CONFIRMATION');
  const seller=(await pool.query('SELECT * FROM outbox WHERE id=$1',[journey.body.recipe_interruption.seller_effect_id])).rows[0];
  expect(seller.payload.purpose).toBe('seller_reply');
  expect(seller.predecessor_id).toBe(initial[4].id);

  await pool.query("UPDATE outbox SET status='SENT',provider_message_id='confirmed-2',result=$2,updated_at=now() WHERE id=$1",[initial[1].id,{accepted_at:new Date().toISOString()}]);
  await materializeEffectResults(1000);

  await pool.query("UPDATE outbox SET status='SENDING',attempts=1,updated_at=now() WHERE id=$1",[seller.id]);
  await materializeEffectResults(1000);
  expect((await pool.query("SELECT status FROM outbox WHERE id=$1",[seller.id])).rows[0].status).toBe('SENDING');
  expect((await pool.query("SELECT count(*)::int count FROM outbox WHERE workspace_id=$1 AND payload->>'recipe_resume_token'=$2",[interruptionWorkspace,journey.body.recipe_interruption.token])).rows[0].count).toBe(0);

  await pool.query("UPDATE outbox SET status='UNKNOWN',result=$2,updated_at=now() WHERE id=$1",[seller.id,{reason:'FIXTURE_RESPONSE_LOST'}]);
  await materializeEffectResults(1000);
  expect((await pool.query("SELECT status FROM outbox WHERE id=$1",[seller.id])).rows[0].status).toBe('UNKNOWN');
  expect((await pool.query("SELECT count(*)::int count FROM outbox WHERE workspace_id=$1 AND payload->>'recipe_resume_token'=$2",[interruptionWorkspace,journey.body.recipe_interruption.token])).rows[0].count).toBe(0);

  await pool.query("UPDATE outbox SET status='SENT',provider_message_id='seller-confirmed',result=$2,updated_at=now() WHERE id=$1",[seller.id,{accepted_at:new Date().toISOString()}]);
  await materializeEffectResults(1000);
  journey=await current(journey);
  expect(journey.body.recipe_interruption.status).toBe('RESUMED');
  const resumed=(await pool.query(
   "SELECT * FROM outbox WHERE workspace_id=$1 AND payload->>'recipe_resume_token'=$2 ORDER BY dispatch_sequence",
   [interruptionWorkspace,journey.body.recipe_interruption.token],
  )).rows;
  expect(resumed.map(effect=>Number(effect.payload.workflow_recipe_step))).toEqual([3,4,5]);
  expect(resumed.map(effect=>effect.status)).toEqual(['READY','READY','READY']);
  expect(resumed.map(effect=>effect.predecessor_id)).toEqual([seller.id,resumed[0].id,resumed[1].id]);
  expect(resumed.map(effect=>effect.payload.resumed_from_effect_id)).toEqual(initial.slice(2).map(effect=>effect.id));
  expect((await pool.query(
   `SELECT payload->>'workflow_recipe_step' step,count(*)::int count FROM outbox
    WHERE workspace_id=$1 AND conversation_id=$2 AND payload ? 'workflow_recipe_step'
    GROUP BY payload->>'workflow_recipe_step' ORDER BY (payload->>'workflow_recipe_step')::int`,
   [interruptionWorkspace,journey.id],
  )).rows.map(row=>[Number(row.step),row.count])).toEqual([[1,1],[2,1],[3,2],[4,2],[5,2]]);
  expect((await pool.query(
   `SELECT payload->>'node_id' node_id,count(*)::int count FROM domain_events
    WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='workflow.node_executed'
     AND payload->>'node_id'=ANY($3::text[]) GROUP BY payload->>'node_id' ORDER BY min((payload->>'step')::int)`,
   [interruptionWorkspace,journey.id,['presentation_audio','pack_image','offer_text','agreement_audio','agreement_prompt']],
  )).rows.map(row=>[row.node_id,row.count])).toEqual([
   ['presentation_audio',1],['pack_image',1],['offer_text',1],['agreement_audio',1],['agreement_prompt',1],
  ]);
  expect((await withTransaction(client=>ensureOrder(client,journey)))!.body.committed_at).toBeUndefined();
  await materializeEffectResults(1000);
  expect((await pool.query("SELECT count(*)::int count FROM outbox WHERE workspace_id=$1 AND payload->>'recipe_resume_token'=$2",[interruptionWorkspace,journey.body.recipe_interruption.token])).rows[0].count).toBe(3);
 });

 it('executes the exact ten-step causal path, accumulates real late payments and scopes buyer exclusion correctly',async()=>{
  const identity=`opaque:late-buyer-${randomUUID()}`;
  let journey=(await inbound(catalog.account,identity,'Quiero Mi Ciclo Listo'))!;
  journey=await withTransaction(client=>advanceWorkflow(client,journey));
  expect(journey.body.flow_state).toMatchObject({status:'WAITING',waiting_for:'commitment',waiting_node_id:'commitment'});

  let order=(await withTransaction(client=>ensureOrder(client,journey)))!;
  expect(order.body.committed_at).toBeUndefined();
  await inbound(catalog.account,identity,'Sí');
  journey=await current(journey);
  order=(await withTransaction(client=>ensureOrder(client,journey)))!;
  expect(order.body.status).toBe('COMMITTED');
  expect(journey.body.flow_state).toMatchObject({status:'WAITING',waiting_for:'prepayment_delivery_confirmed',node_id:'collection_audio'});
  await confirmInitialDelivery(journey);
  journey=await current(journey);
  expect(journey.body.flow_state).toMatchObject({status:'WAITING',waiting_for:'receipt_approved',node_id:'receipt_thanks'});

  const sameNumberOtherProduct=(await inbound(catalog.account,identity,'Curso Alterno'))!;
  const otherNumberOtherProduct=(await inbound(catalog.secondAccount,identity,'Curso Alterno'))!;
  const otherContact=(await inbound(catalog.account,`opaque:other-contact-${randomUUID()}`,'Mi Ciclo Listo'))!;
  const otherWorkspaceSameIdentity=(await inbound(isolatedCatalog.account,identity,'Mi Ciclo Listo'))!;
  expect(new Set([journey.body.contact_id,sameNumberOtherProduct.body.contact_id,otherNumberOtherProduct.body.contact_id]).size).toBe(1);
  expect(otherContact.body.contact_id).not.toBe(journey.body.contact_id);
  expect(otherWorkspaceSameIdentity.body.contact_id).not.toBe(journey.body.contact_id);
  for(const [conversation,label] of [
   [journey,'target'],[sameNumberOtherProduct,'same-number-other-product'],[otherNumberOtherProduct,'other-number-other-product'],
   [otherContact,'other-contact'],[otherWorkspaceSameIdentity,'other-workspace'],
  ] as const)await addFollowup(conversation,label);

  order=await attachAndApprove(journey,2700,'primary');
  expect(order.body).toMatchObject({sale_status:'RECOGNIZED',sale_amount_minor:2700,sale_currency:'MXN',sale_definition:'receipt_sales_v1'});
  const afterFirst=(await pool.query(
   "SELECT body->>'asset_id' asset_id FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='fulfillment' AND body->>'order_id'=$3",
   [primaryWorkspace,environment,order.id],
  )).rows.map(row=>row.asset_id).sort();
  expect(afterFirst).toEqual([catalog.assets.calendar.id,catalog.assets.core.id,catalog.assets.kit.id].sort());

  order=await attachAndApprove(journey,7123,'additional');
  expect(order.body.sale_amount_minor).toBe(9823);
  const contributions=(await pool.query(
   'SELECT payment_key,amount_minor FROM payment_contributions WHERE workspace_id=$1 AND environment=$2 AND order_id=$3 ORDER BY payment_key',
   [primaryWorkspace,environment,order.id],
  )).rows;
  expect(contributions.map(row=>[row.payment_key,Number(row.amount_minor)])).toEqual([['additional',7123],['primary',2700]]);
  expect((await pool.query(
   "SELECT count(*)::int count FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='fulfillment' AND body->>'order_id'=$3",
   [primaryWorkspace,environment,order.id],
  )).rows[0].count).toBe(3);

  const recipeMap=new Map((catalog.mclWorkflow.body.nodes as Body[]).filter(node=>node.config?.recipe_step).map(node=>[node.id,Number(node.config.recipe_step)]));
  expect([...recipeMap.entries()].sort((a,b)=>a[1]-b[1]).map(([node])=>node)).toEqual(expectedRecipeNodes);
  const nodeEvents=(await pool.query(
   "SELECT payload FROM domain_events WHERE workspace_id=$1 AND environment=$2 AND aggregate_id=$3 AND event_type='workflow.node_executed' ORDER BY (payload->>'step')::int",
   [primaryWorkspace,environment,journey.id],
  )).rows.map(row=>row.payload).filter(payload=>recipeMap.has(payload.node_id));
  expect(nodeEvents.map(payload=>payload.node_id)).toEqual(expectedRecipeNodes);
  expect(nodeEvents.map(payload=>recipeMap.get(payload.node_id))).toEqual([1,2,3,4,5,6,7,8,9,10]);
  expect(nodeEvents.map(payload=>Number(payload.step))).toEqual([...nodeEvents.map(payload=>Number(payload.step))].sort((a,b)=>a-b));

  const effects=(await pool.query('SELECT * FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY dispatch_sequence',[primaryWorkspace,journey.id])).rows;
  expect(effects.map(effect=>effect.predecessor_id)).toEqual([null,...effects.slice(0,-1).map(effect=>effect.id)]);
  const causalOutputs=effects.map(effect=>effect.payload.workflow_node_id??({
   [catalog.assets.core.id]:'prepayment_fulfillment',
   [catalog.assets.calendar.id]:'postpayment_fulfillment',
   [catalog.assets.kit.id]:'postpayment_fulfillment',
  } as Record<string,string>)[effect.payload.asset_id]).filter(Boolean);
  expect(causalOutputs).toEqual([
   'presentation_audio','pack_image','offer_text','agreement_audio','agreement_prompt','prepayment_fulfillment',
   'collection_audio','payment_instructions','receipt_thanks','postpayment_fulfillment','postpayment_fulfillment',
  ]);

  expect(await buyerExcluded(pool,{workspace_id:primaryWorkspace,environment,contact_id:String(journey.body.contact_id)})).toBe(true);
  expect(await buyerExcluded(pool,{workspace_id:primaryWorkspace,environment,contact_id:String(otherContact.body.contact_id)})).toBe(false);
  expect(await buyerExcluded(pool,{workspace_id:isolatedWorkspace,environment,contact_id:String(otherWorkspaceSameIdentity.body.contact_id)})).toBe(false);
  const timerStatus=async(conversation:DomainRecord)=>(await pool.query("SELECT status FROM timers WHERE workspace_id=$1 AND conversation_id=$2 AND logical_key LIKE 'mcl-v2:%'",[conversation.workspace_id,conversation.id])).rows[0]?.status;
  expect(await timerStatus(journey)).toBe('CANCELLED');
  expect(await timerStatus(sameNumberOtherProduct)).toBe('CANCELLED');
  expect(await timerStatus(otherNumberOtherProduct)).toBe('CANCELLED');
  expect(await timerStatus(otherContact)).toBe('PENDING');
  expect(await timerStatus(otherWorkspaceSameIdentity)).toBe('PENDING');
 });

 it('closes only after durable delivery confirmation and keeps post-sale support separate from sales automation',async()=>{
  const identity=`opaque:durable-close-${randomUUID()}`;
  let journey=(await inbound(catalog.account,identity,'Mi Ciclo Listo'))!;
  journey=await withTransaction(client=>advanceWorkflow(client,journey));
  const order=await attachAndApprove(journey,9700,'durable-close');
  journey=await current(journey);
  expect(journey.body.flow_state).toMatchObject({status:'WAITING',waiting_for:'closing_delivery_confirmed',node_id:'end',waiting_node_id:'postpayment_fulfillment'});

  const closingEffects=async()=>(await pool.query(
   'SELECT * FROM outbox WHERE workspace_id=$1 AND environment=$2 AND conversation_id=$3 ORDER BY dispatch_sequence',
   [primaryWorkspace,environment,journey.id],
  )).rows;
  const effects=await closingEffects();
  const thanks=effects.find(effect=>Number(effect.payload.workflow_recipe_step)===9);
  const fulfillmentEffects=effects.filter(effect=>effect.payload.fulfillment_id);
  expect(thanks).toBeTruthy();
  expect(fulfillmentEffects).toHaveLength(3);
  expect((await pool.query(
   "SELECT body->>'status' status FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='fulfillment' AND body->>'order_id'=$3 ORDER BY id",
   [primaryWorkspace,environment,order.id],
  )).rows.map(row=>row.status)).toEqual(['PROPOSED','PROPOSED','PROPOSED']);
  const originalEffectCount=effects.length;

  await pool.query("UPDATE outbox SET status='SENDING',attempts=1,updated_at=now() WHERE id=$1",[thanks.id]);
  await materializeEffectResults(1000);
  expect((await current(journey)).body.flow_state.status).toBe('WAITING');
  expect((await closingEffects())).toHaveLength(originalEffectCount);

  await pool.query("UPDATE outbox SET status='UNKNOWN',result=$2,updated_at=now() WHERE id=$1",[thanks.id,{reason:'SYNTHETIC_UNCERTAIN_THANKS'}]);
  await materializeEffectResults(1000);
  expect((await current(journey)).body.flow_state.status).toBe('WAITING');
  expect((await closingEffects())).toHaveLength(originalEffectCount);

  await pool.query("UPDATE outbox SET status='SENT',provider_message_id=$2,result=$3,updated_at=now() WHERE id=$1",[thanks.id,`accepted:${thanks.id}`,{accepted_at:new Date().toISOString()}]);
  await pool.query("UPDATE outbox SET status='SENT',provider_message_id='accepted:'||id::text,result=jsonb_build_object('accepted_at',now()),updated_at=now() WHERE id=ANY($1::uuid[])",[fulfillmentEffects.map(effect=>effect.id)]);
  await materializeEffectResults(1000);
  expect((await current(journey)).body.flow_state.status).toBe('WAITING');
  expect((await pool.query(
   "SELECT body->>'status' status FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='fulfillment' AND body->>'order_id'=$3 ORDER BY id",
   [primaryWorkspace,environment,order.id],
  )).rows.map(row=>row.status)).toEqual(['SENT','SENT','SENT']);

  await pool.query("UPDATE outbox SET status='DELIVERED',updated_at=now() WHERE id=ANY($1::uuid[]) AND id<>$2",[fulfillmentEffects.map(effect=>effect.id),fulfillmentEffects.at(-1)!.id]);
  await materializeEffectResults(1000);
  expect((await current(journey)).body.flow_state.status).toBe('WAITING');
  await pool.query("UPDATE outbox SET status='DELIVERED',updated_at=now() WHERE id=$1",[fulfillmentEffects.at(-1)!.id]);
  await materializeEffectResults(1000);
  journey=await current(journey);
  expect(journey.body.flow_state.status).toBe('FINISHED');
  expect((await pool.query(
   "SELECT count(*)::int count FROM domain_events WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='workflow.closing_delivery_confirmed'",
   [primaryWorkspace,journey.id],
  )).rows[0].count).toBe(1);

  const fulfillmentCount=Number((await pool.query(
   "SELECT count(*) FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='fulfillment' AND body->>'order_id'=$3",
   [primaryWorkspace,environment,order.id],
  )).rows[0].count);
  await inbound(catalog.account,identity,'No puedo abrir uno de los regalos, ¿me ayudas?');
  journey=await current(journey);
  expect(journey.body).toMatchObject({ai_pending:true,flow_state:{status:'FINISHED'}});
  await processAgents(100,{
   propose:async()=>({proposal:{reply:'Claro. Revisemos el acceso sin volver a cobrarte.',intent:'question',confidence:1,tool:'none',grounding:['offer_snapshot']},usage:{input_tokens:1,output_tokens:1,cost_minor:0},provider:'fixture',model:'fixture'}),
   receipt:async()=>{throw new Error('UNUSED');},
  });
  journey=await current(journey);
  expect(journey.body.flow_state.status).toBe('FINISHED');
  const support=(await pool.query(
   "SELECT * FROM outbox WHERE workspace_id=$1 AND environment=$2 AND conversation_id=$3 AND payload->>'purpose'='seller_reply' ORDER BY dispatch_sequence DESC LIMIT 1",
   [primaryWorkspace,environment,journey.id],
  )).rows[0];
  expect(support.payload.text).toBe('Claro. Revisemos el acceso sin volver a cobrarte.');
  expect(Number((await pool.query(
   "SELECT count(*) FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='fulfillment' AND body->>'order_id'=$3",
   [primaryWorkspace,environment,order.id],
  )).rows[0].count)).toBe(fulfillmentCount);
  expect((await pool.query(
   "SELECT count(*)::int count FROM timers WHERE workspace_id=$1 AND environment=$2 AND conversation_id=$3 AND status='PENDING' AND kind='followup'",
   [primaryWorkspace,environment,journey.id],
  )).rows[0].count).toBe(0);
  expect(await buyerExcluded(pool,{workspace_id:primaryWorkspace,environment,contact_id:String(journey.body.contact_id)})).toBe(true);
 });

 it('accepts every required positive early-payment amount, records the exact value and unlocks the complete bundle once',async()=>{
  for(const amountMinor of [100,5000,9700,10700,15000]){
   const identity=`opaque:early-buyer-${amountMinor}-${randomUUID()}`;
   let journey=(await inbound(catalog.account,identity,'Mi Ciclo Listo'))!;
   journey=await withTransaction(client=>advanceWorkflow(client,journey));
   expect(journey.body.flow_state).toMatchObject({status:'WAITING',waiting_for:'commitment'});

   const order=await attachAndApprove(journey,amountMinor,`primary-${amountMinor}`);
   journey=await current(journey);
   expect(order.body).toMatchObject({sale_status:'RECOGNIZED',sale_amount_minor:amountMinor,sale_currency:'MXN'});
   expect(order.body.committed_at).toBeUndefined();
   expect(journey.body.flow_state).toMatchObject({status:'WAITING',waiting_for:'closing_delivery_confirmed'});
   const fulfillments=(await pool.query(
    "SELECT body->>'asset_id' asset_id FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='fulfillment' AND body->>'order_id'=$3",
    [primaryWorkspace,environment,order.id],
   )).rows.map(row=>row.asset_id).sort();
   expect(fulfillments).toEqual([catalog.assets.calendar.id,catalog.assets.core.id,catalog.assets.kit.id].sort());
   const executed=(await pool.query(
    "SELECT payload->>'node_id' node_id FROM domain_events WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='workflow.node_executed' ORDER BY (payload->>'step')::int",
    [primaryWorkspace,journey.id],
   )).rows.map(row=>row.node_id);
   expect(executed).toEqual(['presentation_audio','pack_image','offer_text','agreement_audio','agreement_prompt','commitment','receipt_thanks','postpayment_fulfillment']);
   expect(executed).not.toContain('collection_audio');
   expect(executed).not.toContain('payment_instructions');
  }
 });

 it('keeps the whole proof synthetic with no provider delivery or REAL mutation',async()=>{
  for(const workspace of [primaryWorkspace,isolatedWorkspace]){
   expect((await pool.query("SELECT count(*)::int count FROM outbox WHERE workspace_id=$1 AND environment='REAL'",[workspace])).rows[0].count).toBe(0);
   expect((await pool.query("SELECT count(*)::int count FROM records WHERE workspace_id=$1 AND environment='REAL'",[workspace])).rows[0].count).toBe(0);
   expect((await pool.query("SELECT count(*)::int count FROM outbox WHERE workspace_id=$1 AND environment='REAL' AND (provider_message_id IS NOT NULL OR status IN('SENT','DELIVERED','READ'))",[workspace])).rows[0].count).toBe(0);
  }
 });
});
