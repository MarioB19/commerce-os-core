import {afterAll,afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {pool,putRecord,getRecord,withTransaction} from '../../packages/db/src/index.js';
import type {DomainRecord,Environment} from '../../packages/contracts/src/index.js';
import {advanceWorkflow,processTimers} from '../../apps/automation-worker/src/workflows.js';

afterAll(async()=>pool.end());
afterEach(()=>vi.restoreAllMocks());

// Observe the real PostgreSQL selector result, including candidates that a
// later locked recheck would reject. Other integration fixtures may be due.
function selectedTimers(){
 const selected=new Set<string>();
 const original=pool.query.bind(pool);
 vi.spyOn(pool,'query').mockImplementation(((...args:any[])=>{
  const pending=(original as any)(...args);
  if(typeof args[0]==='string'&&args[0].startsWith('SELECT t.id FROM timers t')){
   return pending.then((result:any)=>{for(const row of result.rows)selected.add(row.id);return result;});
  }
  return pending;
 }) as typeof pool.query);
 return selected;
}

async function record(workspace:string,kind:string,body:Record<string,any>,environment:Environment='SIMULATION'){
 return putRecord(pool,{workspaceId:workspace,environment,kind,body});
}
async function timer(workspace:string,conversation:DomainRecord,dueAt:string,environment:Environment='SIMULATION'){
 return (await pool.query(`INSERT INTO timers(workspace_id,environment,conversation_id,kind,due_at,logical_key)
  VALUES($1,$2,$3,'wait',$4,$5) RETURNING *`,[workspace,environment,conversation.id,dueAt,randomUUID()])).rows[0];
}
async function state(id:string){return(await pool.query('SELECT status FROM timers WHERE id=$1',[id])).rows[0].status;}

describe('Timer selection keeps virtual clocks within their record scope',()=>{
 for(const mismatch of ['workspace','environment','kind']as const){
  it(`does not select a timer using a simulation from another ${mismatch}`,async()=>{
   const workspace='timer-scope-'+randomUUID();
   const clock=await record(mismatch==='workspace'?'foreign-'+randomUUID():workspace,mismatch==='kind'?'product':'simulation',
    {virtual_now:'2040-01-03T00:00:00.000Z'},mismatch==='environment'?'REAL':'SIMULATION');
   const conversation=await record(workspace,'conversation',{simulation_id:clock.id,ai_status:'HUMAN_REVIEW'});
   const pending=await timer(workspace,conversation,'2040-01-02T00:00:00.000Z');
   const selected=selectedTimers();
   await processTimers(10000);
   expect(selected.has(pending.id)).toBe(false);
   expect(await state(pending.id)).toBe('PENDING');
   expect((await pool.query('SELECT id FROM outbox WHERE conversation_id=$1',[conversation.id])).rows).toHaveLength(0);
  });
 }

 it('does not borrow a foreign conversation clock even when its identifier exists',async()=>{
  const workspace='timer-scope-'+randomUUID(),foreign='timer-foreign-'+randomUUID();
  const clock=await record(foreign,'simulation',{virtual_now:'2040-01-03T00:00:00.000Z'});
  const conversation=await record(foreign,'conversation',{simulation_id:clock.id,ai_status:'HUMAN_REVIEW'});
  const pending=await timer(workspace,conversation,'2040-01-02T00:00:00.000Z');
  const selected=selectedTimers();
  await processTimers(10000);
  expect(selected.has(pending.id)).toBe(false);
  expect(await state(pending.id)).toBe('PENDING');
 });

 it('keeps wall-clock due selection without a simulation and preserves human review',async()=>{
  const workspace='timer-wall-'+randomUUID();
  const conversation=await record(workspace,'conversation',{ai_status:'HUMAN_REVIEW'});
  const due=await timer(workspace,conversation,'2000-01-01T00:00:00.000Z');
  const selected=selectedTimers();
  await processTimers(10000);
  expect(selected.has(due.id)).toBe(true);
  expect(await state(due.id)).toBe('PENDING');
  expect((await getRecord(pool,workspace,'conversation',conversation.id))?.version).toBe(conversation.version);
 });

 for(const environment of ['SIMULATION','REAL']as const){
  it(`leaves a wall-clock due ${environment} timer untouched when its conversation has another environment`,async()=>{
   const workspace='timer-mixed-environment-'+randomUUID();
   const conversation=await record(workspace,'conversation',{routing_state:'PRODUCT_SELECTION_REQUIRED'},environment==='REAL'?'SIMULATION':'REAL');
   const due=await timer(workspace,conversation,'2000-01-01T00:00:00.000Z',environment);
   const selected=selectedTimers();
   await processTimers(10000);
   // Wall-clock candidacy alone grants no authority to mutate either scope.
   expect(selected.has(due.id)).toBe(true);
   expect(await state(due.id)).toBe('PENDING');
   expect((await getRecord(pool,workspace,'conversation',conversation.id))?.version).toBe(conversation.version);
   expect((await pool.query('SELECT id FROM outbox WHERE conversation_id=$1',[conversation.id])).rows).toHaveLength(0);
   expect((await pool.query('SELECT id FROM domain_events WHERE aggregate_id=$1',[conversation.id])).rows).toHaveLength(0);
  });
 }

 it('rechecks a valid wall-clock timer without borrowing a REAL simulation clock',async()=>{
  const workspace='timer-real-clock-'+randomUUID();
  const clock=await record(workspace,'simulation',{virtual_now:'1999-01-01T00:00:00.000Z'},'REAL');
  const conversation=await record(workspace,'conversation',{simulation_id:clock.id,routing_state:'PRODUCT_SELECTION_REQUIRED'});
  const due=await timer(workspace,conversation,'2000-01-01T00:00:00.000Z');
  await processTimers(10000);
  // The normal routing gate cancels this due timer. The foreign virtual clock
  // must not make it appear early and leave it pending before reaching that gate.
  expect(await state(due.id)).toBe('CANCELLED');
  expect((await pool.query('SELECT id FROM outbox WHERE conversation_id=$1',[conversation.id])).rows).toHaveLength(0);
  expect((await getRecord(pool,workspace,'conversation',conversation.id))?.version).toBe(conversation.version);
 });

 it('does not revive an expired assignment with a REAL simulation clock',async()=>{
  const workspace='timer-assignment-clock-'+randomUUID();
  const clock=await record(workspace,'simulation',{virtual_now:'2005-01-01T00:00:00.000Z'},'REAL');
  const product=await record(workspace,'product',{name:'Synthetic expired product'});
  const account=await record(workspace,'channel_account',{provider:'simulator',status:'WORKING'});
  const binding=await record(workspace,'binding',{valid_from:'2001-01-01T00:00:00.000Z',valid_to:'2010-01-01T00:00:00.000Z'});
  const assignment=(await pool.query(`INSERT INTO commercial_assignments(workspace_id,environment,account_id,product_id,binding_id)
   VALUES($1,'SIMULATION',$2,$3,$4) RETURNING *`,[workspace,account.id,product.id,binding.id])).rows[0];
  const conversation=await record(workspace,'conversation',{simulation_id:clock.id,account_id:account.id,
   assignment_id:assignment.id,assignment_revision:assignment.revision,binding_id:binding.id});
  const due=await timer(workspace,conversation,'2000-01-01T00:00:00.000Z');
  await processTimers(10000);
  expect(await state(due.id)).toBe('CANCELLED');
  expect((await pool.query('SELECT id FROM outbox WHERE conversation_id=$1',[conversation.id])).rows).toHaveLength(0);
  expect((await getRecord(pool,workspace,'conversation',conversation.id))?.version).toBe(conversation.version);
 });

 for(const environment of ['SIMULATION','REAL']as const){
  it(`does not complete another environment's simulation when a ${environment} workflow ends`,async()=>{
   const workspace='timer-finish-scope-'+randomUUID();
   const clockEnvironment=environment==='SIMULATION'?'REAL':'SIMULATION';
   const clock=await record(workspace,'simulation',{status:'RUNNING',virtual_now:'2040-01-03T00:00:00.000Z'},clockEnvironment);
   const product=await record(workspace,'product',{name:'Synthetic end product'},environment);
   const offer=await record(workspace,'offer',{product_id:product.id,base_amount_minor:9900,currency:'MXN',status:'PUBLISHED',fulfillment:[]},environment);
   const account=await record(workspace,'channel_account',{provider:'simulator',status:'WORKING'},environment);
   const contact=await record(workspace,'contact',{name:'Synthetic end contact',identity:'opaque:'+randomUUID()},environment);
   const workflow=await record(workspace,'workflow',{status:'PUBLISHED',entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]},environment);
   const conversation=await record(workspace,'conversation',{account_id:account.id,contact_id:contact.id,offer_version_id:offer.id,
    workflow_version_id:workflow.id,simulation_id:clock.id,status:'OPEN',sequence:1},environment);
   const due=await timer(workspace,conversation,'2000-01-01T00:00:00.000Z',environment);
   await processTimers(10000);
   expect(await state(due.id)).toBe('FIRED');
   expect((await getRecord(pool,workspace,'conversation',conversation.id))?.body.flow_state.status).toBe('FINISHED');
   expect(await getRecord(pool,workspace,'simulation',clock.id)).toMatchObject({version:clock.version,body:clock.body});
   expect((await pool.query('SELECT id FROM outbox WHERE conversation_id=$1',[conversation.id])).rows).toHaveLength(0);
  });
 }

 it('fires a valid virtual wait once under concurrent and repeated workers',async()=>{
  const workspace='timer-concurrent-'+randomUUID();
  const product=await record(workspace,'product',{name:'Synthetic timer product'});
  const offer=await record(workspace,'offer',{product_id:product.id,base_amount_minor:9900,currency:'MXN',status:'PUBLISHED',fulfillment:[]});
  const account=await record(workspace,'channel_account',{name:'Synthetic timer account',provider:'simulator',status:'WORKING'});
  const contact=await record(workspace,'contact',{name:'Synthetic timer contact',identity:'opaque:'+randomUUID(),status:'LEAD'});
  const workflow=await record(workspace,'workflow',{name:'Synthetic durable wait',status:'PUBLISHED',entry_node_id:'wait',nodes:[
   {id:'wait',type:'wait',config:{seconds:30},next:'message'},
   {id:'message',type:'message',config:{text:'After the synthetic wait'},next:'end'},
   {id:'end',type:'end',config:{}},
  ]});
  const clock=await record(workspace,'simulation',{status:'RUNNING',virtual_now:'2040-01-01T00:00:00.000Z'});
  const conversation=await record(workspace,'conversation',{account_id:account.id,contact_id:contact.id,offer_version_id:offer.id,
   workflow_version_id:workflow.id,simulation_id:clock.id,status:'OPEN',stage:'NEW',sequence:1,ai_pending:false});
  await withTransaction(client=>advanceWorkflow(client,conversation));
  const pending=(await pool.query('SELECT * FROM timers WHERE conversation_id=$1',[conversation.id])).rows[0];
  expect(await state(pending.id)).toBe('PENDING');
  const selected=selectedTimers();
  await processTimers(10000);
  expect(selected.has(pending.id)).toBe(false);
  await putRecord(pool,{id:clock.id,workspaceId:workspace,environment:'SIMULATION',kind:'simulation',version:clock.version,
   body:{...clock.body,virtual_now:'2040-01-01T00:01:00.000Z'}});
  await Promise.all([processTimers(10000),processTimers(10000)]);
  await processTimers(10000);
  expect(selected.has(pending.id)).toBe(true);
  expect(await state(pending.id)).toBe('FIRED');
  expect((await pool.query('SELECT id FROM outbox WHERE conversation_id=$1',[conversation.id])).rows).toHaveLength(1);
  expect((await getRecord(pool,workspace,'conversation',conversation.id))?.body.flow_state.status).toBe('FINISHED');
  expect((await getRecord(pool,workspace,'simulation',clock.id))?.body.status).toBe('COMPLETED');
 });
});
