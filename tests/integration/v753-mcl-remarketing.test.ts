import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {applyCommand} from '../../apps/automation-worker/src/commands.js';
import {materializeEffectResults} from '../../apps/automation-worker/src/effect-results.js';
import {materializeMessage} from '../../apps/automation-worker/src/inbound.js';
import {advanceWorkflow,processTimers} from '../../apps/automation-worker/src/workflows.js';
import {pool,putRecord,getRecord,withTransaction} from '../../packages/db/src/index.js';
import {normalizeRemarketingPolicy,nextRemarketingTime} from '../../packages/domain/src/sales/remarketing.js';
import {salesAgreementRecipeV1,salesAgreementWorkflowV1} from '../../packages/domain/src/sales/sales-recipe-v2.js';
import type {Body,DomainRecord} from '../../packages/contracts/src/index.js';

// V7.5.3 §5: the Mi Ciclo Listo reminder policy, end to end on the guided
// recipe with a controlled clock (a simulation's virtual time; dates far in
// the future so the database clock never fires a timer by itself).
// Policy: at most ONE message per customer cycle, shared by the agreement and
// payment stages; 2 h after a transport-confirmed anchor; only 09:00–18:00
// America/Mexico_City (deferred otherwise, never a burst); exact texts;
// cancelled by a reply, a receipt (before it is read), opt-out or a person.
const workspace=`v753-mcl-remarketing-${randomUUID()}`;
const environment='SIMULATION' as const;
const AGREEMENT_TEXT='¿Te quedó alguna duda de Mi Ciclo Listo? Si quieres el paquete, podemos resolverla por aquí 💛';
const PAYMENT_TEXT='¿Pudiste abrir tu material? Si ya realizaste el pago, puedes enviarme el comprobante por aquí 💛';
const MCL_POLICY={schema_version:1,policy_id:'remarketing-3-slot',policy_revision:1,window:{start_hour:9,end_hour:18,timezone:'America/Mexico_City'},
 slots:[1,2,3].map((position,i)=>({id:'slot-'+position,position,enabled:position===1,delay:{quantity:[2,8,24][i]!,unit:'hours'},
  stages:{awaiting_agreement:{medium:'text',text:AGREEMENT_TEXT},awaiting_payment:{medium:'text',text:PAYMENT_TEXT}}}))};
/** A Mexico City wall-clock instant (UTC−6, no daylight saving time). */
const cdmx=(local:string)=>new Date(local+':00.000-06:00').toISOString();
let account:DomainRecord;
const record=(kind:string,body:Body)=>putRecord(pool,{workspaceId:workspace,environment,kind,body});

beforeAll(async()=>{
 await fixtureProfiles(workspace);
 const file=(name:string,mime:string)=>record('asset',{name,kind:'file',mime_type:mime,storage_key:`fixtures/${randomUUID()}`,sha256:randomBytes(32).toString('hex'),status:'READY'});
 const link=(name:string)=>record('asset',{name,kind:'link',url:`https://example.invalid/mcl/${name}`,status:'READY'});
 const [presentation,pack,agreement,collection]=[await file('presentation','audio/mpeg'),await file('pack','image/png'),await file('agreement','audio/mpeg'),await file('collection','audio/mpeg')];
 const [core,calendar]=[await link('core'),await link('calendar')];
 const bank=await record('bank_profile',{name:'Synthetic protected bank',bank:'SIMULATION',last4:'0000',status:'READY'});
 const policy=await record('receipt_policy',{name:'Synthetic human review',auto_approve:false,allow_amount_mismatch:true,min_amount_minor:1,require_currency:true,status:'PUBLISHED'});
 const product=await record('product',{name:'Mi Ciclo Listo — Preescolar y Primaria',status:'PUBLISHED',aliases:['Mi Ciclo Listo']});
 const agent=await record('agent',{name:'Synthetic seller',product_id:product.id,status:'PUBLISHED',provider:'deterministic',knowledge:'Synthetic',instructions:'Synthetic'});
 const workflow=await record('workflow',{...salesAgreementWorkflowV1({presentation_audio_id:presentation.id,pack_image_id:pack.id,agreement_audio_id:agreement.id,collection_audio_id:collection.id},
  {offer:'Recibes el paquete completo por $97 MXN.',agreement:'¿Llegamos a este acuerdo?',payment:'{{bank_instructions}}\nEnvía tu comprobante.',thanks:'Comprobante aprobado.'}),product_id:product.id,status:'PUBLISHED'});
 const offer=await record('offer',{name:'Mi Ciclo Listo',product_id:product.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:9700,payment_profile_version_id:bank.id,receipt_policy_version_id:policy.id,
  workflow_version_id:workflow.id,agent_version_id:agent.id,billing_delay_seconds:0,positive_payment_unlocks_all:true,
  fulfillment:[{asset_id:core.id,release_on:'commitment_accepted'},{asset_id:calendar.id,release_on:'receipt_approved'}],
  sales_flow:{entry_aliases:['Mi Ciclo Listo'],recipe:salesAgreementRecipeV1(),remarketing:MCL_POLICY}});
 account=await record('channel_account',{name:'Synthetic number',provider:'simulator',status:'WORKING',sending_enabled:false});
 const assignment=randomUUID();
 const binding=await record('binding',{account_id:account.id,product_id:product.id,offer_version_id:offer.id,workflow_version_id:workflow.id,agent_version_id:agent.id,entry_rules:[{kind:'keyword',value:'Mi Ciclo Listo'}],
  assignment_id:assignment,assignment_revision:1,valid_from:'2026-01-01T00:00:00.000Z',source:'v753-remarketing-fixture',evidence:'Explicit synthetic routing fixture',confidence:'confirmed'});
 await pool.query('INSERT INTO commercial_assignments(id,workspace_id,environment,account_id,product_id,binding_id,revision) VALUES($1,$2,$3,$4,$5,$6,1)',[assignment,workspace,environment,account.id,product.id,binding.id]);
 await pool.query("INSERT INTO commercial_assignment_history(assignment_id,revision,binding_id,state,actor_id,reason) VALUES($1,1,$2,'ACTIVE','integration-test','Explicit synthetic routing fixture')",[assignment,binding.id]);
});
afterAll(async()=>{await pool.end();});

type Journey={identity:string;simulation:string;conversation:DomainRecord};
const current=async(j:Journey)=>(await getRecord(pool,workspace,'conversation',j.conversation.id))!;
/** Moves the journey's virtual clock and runs the timer worker once. */
async function at(j:Journey,iso:string,runs=1){
 const s=(await getRecord(pool,workspace,'simulation',j.simulation))!;
 await putRecord(pool,{id:s.id,version:s.version,workspaceId:workspace,environment,kind:'simulation',body:{...s.body,virtual_now:iso}});
 for(let i=0;i<runs;i++)await processTimers(25);
}
/** The customer writes at a virtual instant (the clock is there first). */
async function customer(j:Journey,text:string,when:string){
 const s=(await getRecord(pool,workspace,'simulation',j.simulation))!;
 await putRecord(pool,{id:s.id,version:s.version,workspaceId:workspace,environment,kind:'simulation',body:{...s.body,virtual_now:when}});
 return withTransaction(c=>materializeMessage(c,account,{key:randomUUID(),type:'message',providerAt:when,identity:j.identity,kind:'text',text,payload:{}} as never,randomUUID()));
}
/** Transport acceptance at a virtual instant, as the dispatcher records it. */
async function transport(j:Journey,when:string){
 const rows=(await pool.query("SELECT id FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 AND status='READY' ORDER BY dispatch_sequence",[workspace,j.conversation.id])).rows;
 for(const effect of rows){const claim=randomUUID();
  await pool.query("UPDATE outbox SET status='SENT',attempts=1,claim_id=$2,claimed_at=clock_timestamp(),provider_message_id=$3,result=$4,updated_at=now() WHERE id=$1",[effect.id,claim,`sim:${effect.id}`,{accepted_at:when}]);
  await pool.query("INSERT INTO effect_attempts(effect_id,claim_id,status,finished_at) VALUES($1,$2,'SENT',clock_timestamp())",[effect.id,claim]);}
}
/** The customer asks for the product; the guided recipe sends steps 1–5 (confirmed at `when`). */
async function start(when:string):Promise<Journey>{
 const simulation=(await record('simulation',{virtual_now:when,status:'RUNNING'})).id,identity=`opaque:mcl-remarketing-${randomUUID()}`;
 let conversation=(await withTransaction(c=>materializeMessage(c,account,{key:randomUUID(),type:'message',providerAt:when,identity,kind:'text',text:'Quiero Mi Ciclo Listo',payload:{}} as never,randomUUID())))!;
 conversation=await putRecord(pool,{id:conversation.id,version:conversation.version,workspaceId:workspace,environment,kind:'conversation',body:{...conversation.body,simulation_id:simulation}});
 conversation=await withTransaction(c=>advanceWorkflow(c,conversation));
 expect(conversation.body.flow_state).toMatchObject({status:'WAITING',waiting_for:'commitment'});
 const j={identity,simulation,conversation};await transport(j,when);await at(j,when);return j;
}
/** Accepts, receives the initial delivery and the payment instructions (confirmed at `when`). */
async function toPayment(j:Journey,acceptedAt:string,when:string){
 await customer(j,'Sí, lo quiero',acceptedAt);
 const effects=(await pool.query("SELECT id FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 AND payload ? 'fulfillment_id' ORDER BY dispatch_sequence",[workspace,j.conversation.id])).rows;
 for(const [index,effect] of effects.entries())await pool.query("UPDATE outbox SET status='DELIVERED',provider_message_id=$2,result=$3,updated_at=now() WHERE id=$1",[effect.id,`prepayment-${index}`,{accepted_at:acceptedAt}]);
 await materializeEffectResults(1000);
 expect((await current(j)).body.flow_state).toMatchObject({status:'WAITING',waiting_for:'receipt_approved'});
 await transport(j,when);await at(j,when);
}
const reminders=async(j:Journey)=>(await pool.query("SELECT status,payload FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 AND payload->>'purpose'='remarketing' ORDER BY created_at",[workspace,j.conversation.id])).rows;
const timers=async(j:Journey)=>(await pool.query("SELECT status,due_at,payload FROM timers WHERE workspace_id=$1 AND conversation_id=$2 AND kind='followup' ORDER BY created_at",[workspace,j.conversation.id])).rows;
const pendingTimers=async(j:Journey)=>(await timers(j)).filter(t=>t.status==='PENDING');
const cycle=async(j:Journey)=>(await pool.query('SELECT status,consumed_attempts,max_attempts FROM commercial_remarketing_cycles WHERE workspace_id=$1 AND contact_id=$2',[workspace,(await current(j)).body.contact_id])).rows;

describe('V7.5.3 Mi Ciclo Listo remarketing (controlled clock)',()=>{
 it('the published policy is one message, 2 h after the anchor, 09:00–18:00 Mexico City, with the exact texts',()=>{
  const normalized=normalizeRemarketingPolicy(MCL_POLICY) as Body;
  expect(normalized.maximum).toBe(1);
  expect(normalized.slots.find((s:Body)=>s.enabled)).toMatchObject({after_seconds:7200,stages:{awaiting_agreement:{medium:'text',text:AGREEMENT_TEXT},awaiting_payment:{medium:'text',text:PAYMENT_TEXT}}});
  expect(normalized.window).toEqual({start_hour:9,end_hour:18,timezone:'America/Mexico_City'});
  // Window arithmetic on fixed instants: inside stays, after 18:00 or before 09:00 moves to 09:00.
  expect(nextRemarketingTime(new Date(cdmx('2036-03-03T12:00')),normalized.window).toISOString()).toBe(cdmx('2036-03-03T12:00'));
  expect(nextRemarketingTime(new Date(cdmx('2036-03-03T19:00')),normalized.window).toISOString()).toBe(cdmx('2036-03-04T09:00'));
  expect(nextRemarketingTime(new Date(cdmx('2036-03-04T07:30')),normalized.window).toISOString()).toBe(cdmx('2036-03-04T09:00'));
  expect(nextRemarketingTime(new Date(cdmx('2036-03-03T17:59')),normalized.window).toISOString()).toBe(cdmx('2036-03-03T17:59'));
 });

 it('sends one agreement reminder 2 h after the confirmed agreement prompt, never twice, and then nothing at the payment stage (shared quota)',async()=>{
  const j=await start(cdmx('2036-03-03T10:00'));
  const [timer]=await pendingTimers(j);
  expect(new Date(timer.due_at).toISOString()).toBe(cdmx('2036-03-03T12:00'));
  expect(timer.payload).toMatchObject({purpose:'remarketing',stage:'AGREEMENT',medium:'text',text:AGREEMENT_TEXT});
  expect(await pendingTimers(j)).toHaveLength(1);
  await at(j,cdmx('2036-03-03T11:59'));
  expect(await reminders(j)).toHaveLength(0);
  // Due: two worker passes and a concurrent one (restart / double worker) send it once.
  await at(j,cdmx('2036-03-03T12:00'),2);await Promise.all([processTimers(25),processTimers(25)]);
  const sent=await reminders(j);
  expect(sent).toHaveLength(1);expect(sent[0].payload).toMatchObject({kind:'text',text:AGREEMENT_TEXT});expect(sent[0].payload.asset_id).toBeUndefined();
  expect(await cycle(j)).toEqual([expect.objectContaining({consumed_attempts:1,max_attempts:1})]);
  await transport(j,cdmx('2036-03-03T12:00'));
  // She accepts later; the payment stage has no message left in this cycle.
  await toPayment(j,cdmx('2036-03-03T12:30'),cdmx('2036-03-03T12:40'));
  expect(await pendingTimers(j)).toHaveLength(0);
  expect((await current(j)).body.followup_plan).toMatchObject({stage:'awaiting_payment',status:'DISABLED'});
  for(const t of ['2036-03-03T14:40','2036-03-03T17:00','2036-03-04T10:00'])await at(j,cdmx(t));
  expect(await reminders(j)).toHaveLength(1);
 },60000);

 it('outside 09:00–18:00 the reminder waits for 09:00 and is sent once then, without a burst',async()=>{
  const j=await start(cdmx('2036-03-05T16:30'));
  const [timer]=await pendingTimers(j);
  expect(new Date(timer.due_at).toISOString()).toBe(cdmx('2036-03-06T09:00'));
  for(const t of ['2036-03-05T18:30','2036-03-05T23:00','2036-03-06T08:59'])await at(j,cdmx(t));
  expect(await reminders(j)).toHaveLength(0);
  await at(j,cdmx('2036-03-06T09:00'),2);
  expect((await reminders(j)).map(r=>r.payload.text)).toEqual([AGREEMENT_TEXT]);
  await at(j,cdmx('2036-03-06T12:00'));
  expect(await reminders(j)).toHaveLength(1);
 },60000);

 it('a reply before 2 h cancels the agreement reminder; the payment reminder follows the confirmed instructions with its exact text',async()=>{
  const j=await start(cdmx('2036-03-09T10:00'));
  await toPayment(j,cdmx('2036-03-09T10:05'),cdmx('2036-03-09T10:10'));
  const all=await timers(j);
  expect(all.find(t=>t.payload.stage==='AGREEMENT')?.status).toBe('CANCELLED');
  const [pending]=await pendingTimers(j);
  expect(pending.payload).toMatchObject({stage:'COLLECTION',text:PAYMENT_TEXT});
  expect(new Date(pending.due_at).toISOString()).toBe(cdmx('2036-03-09T12:10'));
  await at(j,cdmx('2036-03-09T12:09'));expect(await reminders(j)).toHaveLength(0);
  await at(j,cdmx('2036-03-09T12:10'));
  expect((await reminders(j)).map(r=>r.payload.text)).toEqual([PAYMENT_TEXT]);
  expect(await cycle(j)).toEqual([expect.objectContaining({consumed_attempts:1,max_attempts:1})]);
 },60000);

 it('a customer reply cancels the pending reminder and the old pending is never continued',async()=>{
  const j=await start(cdmx('2036-03-10T10:00'));
  expect(await pendingTimers(j)).toHaveLength(1);
  await customer(j,'¿Qué grados incluye?',cdmx('2036-03-10T11:00'));
  expect(await pendingTimers(j)).toHaveLength(0);
  for(const t of ['2036-03-10T12:00','2036-03-10T13:00','2036-03-10T17:00'])await at(j,cdmx(t));
  expect(await reminders(j)).toHaveLength(0);
 },60000);

 it('a receipt (before it is read), an opt-out or a person taking over cancel the payment reminder',async()=>{
  const command=(j:Journey,payload:Body)=>withTransaction(c=>applyCommand(c,{id:randomUUID(),workspace_id:workspace,environment,kind:'conversation_command',resource_id:j.conversation.id,actor_id:'synthetic-operator',payload} as never));
  const cases:[string,(j:Journey)=>Promise<unknown>][]=[
   ['receipt',async j=>{const asset=await record('asset',{name:'Synthetic receipt',kind:'file',mime_type:'image/png',storage_key:`receipts/${randomUUID()}`,sha256:randomBytes(32).toString('hex'),status:'READY'});
    const r=await command(j,{type:'receipt_received',asset_id:asset.id});
    expect((await getRecord(pool,workspace,'receipt',String((r as Body).receipt_id)))!.body.analysis_status).toBe('PENDING');}],
   ['opt-out',j=>command(j,{type:'opt_out'})],
   ['person',j=>command(j,{type:'controls',takeover:true,control_version:1})],
  ];
  for(const [label,cancel] of cases){
   const j=await start(cdmx('2036-03-11T10:00'));
   await toPayment(j,cdmx('2036-03-11T10:05'),cdmx('2036-03-11T10:10'));
   expect(await pendingTimers(j),label).toHaveLength(1);
   await cancel(j);
   expect(await pendingTimers(j),label).toHaveLength(0);
   for(const t of ['2036-03-11T12:10','2036-03-11T15:00'])await at(j,cdmx(t));
   expect(await reminders(j),label).toHaveLength(0);
  }
 },120000);
});
