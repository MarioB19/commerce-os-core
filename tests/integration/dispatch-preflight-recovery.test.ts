import {afterAll,describe,expect,it,vi,beforeAll} from 'vitest';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {pool,putRecord,withTransaction} from '../../packages/db/src/index.js';
import {proposeEffect} from '../../apps/automation-worker/src/shared.js';
import {dispatchOutbox,recoverSending,acquireOwnership,recordHealth} from '../../apps/channel-worker/src/runtime.js';
import {SimulatorProvider,type MessagingProvider} from '../../packages/messaging/src/index.js';
import type {ProviderFactory} from '../../apps/channel-worker/src/providers.js';

afterAll(async()=>pool.end());
// V7 F2: an installation admits three profiles; fixtures share one adopted profile.
const fixtureWorkspace='preflight-'+randomUUID();
beforeAll(()=>fixtureProfiles(fixtureWorkspace));
async function fixture(){
 const workspace=fixtureWorkspace,owner='preflight-owner-'+randomUUID();
 const account=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body:{name:'Synthetic preflight account',provider:'simulator',status:'WORKING'}});
 const contact=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'contact',body:{identity:'opaque:'+randomUUID(),status:'LEAD'}});
 const conversation=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'conversation',body:{account_id:account.id,contact_id:contact.id,status:'OPEN',last_inbound_at:new Date().toISOString()}});
 await acquireOwnership(account,owner);
 await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[account.id]);
 await recordHealth(account,()=>new SimulatorProvider());
 const effects=await withTransaction(async c=>[
  await proposeEffect(c,conversation,{kind:'text',text:'First'},randomUUID()),
  await proposeEffect(c,conversation,{kind:'text',text:'Second'},randomUUID()),
 ]);
 const states=async()=>(await pool.query('SELECT * FROM outbox WHERE conversation_id=$1 ORDER BY dispatch_sequence',[conversation.id])).rows;
 const run=async(factory:ProviderFactory)=>{
  const limit=Number((await pool.query("SELECT count(*)::int n FROM outbox WHERE status IN('READY','BLOCKED')")).rows[0].n);
  // Group observations can inspect fixtures owned by other tests before their
  // ownership gate; fault injection belongs only to this synthetic account.
  return dispatchOutbox(Math.max(1,limit),candidate=>candidate.id===account.id?factory(candidate):new SimulatorProvider(),owner);
 };
 return{workspace,owner,account,contact,conversation,effects,states,run};
}

describe('Recovery before an external dispatch starts',()=>{
 it('does not start HTTP when the final gate COMMIT consumes the remaining local lease',async()=>{
  const f=await fixture();let sends=0,elapsed=0,commitsDelayed=0;
  const now=performance.now.bind(performance),clock=vi.spyOn(performance,'now').mockImplementation(()=>now()+elapsed);
  const connect=pool.connect.bind(pool);
  const provider=new SimulatorProvider();provider.send=async()=>{sends++;return{status:'ACCEPTED'};};
  try{
   await f.run(()=>{
    // The next transaction is the final guard. Its SQL checks see a valid
    // lease, but completion of COMMIT advances monotonic time past expiry.
    vi.spyOn(pool,'connect').mockImplementationOnce(async()=>{
     const client=await connect(),query=client.query.bind(client);
     const querySpy=vi.spyOn(client,'query').mockImplementation((...args:any[])=>{
      const result=(query as any)(...args);
      if(args[0]!=='COMMIT')return result;
      return result.then((value:any)=>{querySpy.mockRestore();elapsed+=60_000;commitsDelayed++;return value;});
     });
     return client;
    });
    return provider;
   });
   expect(commitsDelayed).toBe(1);expect(sends).toBe(0);
   expect((await f.states())[0]).toMatchObject({status:'BLOCKED',attempts:0,claim_id:null,result:{reason:'LOCAL_OWNERSHIP_DEADLINE',external_attempt:false}});
   expect((await pool.query('SELECT status FROM effect_attempts WHERE effect_id=$1',[f.effects[0].id])).rows).toEqual([{status:'NOT_SENT'}]);
   expect((await pool.query('SELECT released_at FROM number_dispatch_slots WHERE effect_id=$1',[f.effects[0].id])).rows[0].released_at).toBeTruthy();
  }finally{clock.mockRestore();vi.restoreAllMocks();}
 });

 it('releases an expired pre-HTTP lease claim and sends the unchanged causal chain exactly once after recovery',async()=>{
  const f=await fixture(),sent:string[]=[];
  const provider=new SimulatorProvider();provider.send=async message=>{sent.push(message.text!);return{status:'ACCEPTED',providerMessageId:'preflight-'+message.effectId};};
  // Provider configuration is asynchronous. The lease can expire after the
  // initial durable claim but before the final guard and any external call.
  await f.run(async()=>{await pool.query("UPDATE session_ownership SET lease_expires_at=now()+interval '1 second' WHERE account_id=$1",[f.account.id]);return provider;});
  let rows=await f.states();
  expect(sent).toEqual([]);
  expect(rows.map(row=>[row.status,row.attempts])).toEqual([['BLOCKED',0],['BLOCKED',0]]);
  expect(rows[0]).toMatchObject({claim_id:null,claimed_at:null,result:{reason:'OWNERSHIP_NOT_CONFIRMED',external_attempt:false}});
  expect(rows[1].result.reason).toBe('CAUSAL_PREDECESSOR_UNRESOLVED');
  const slot=(await pool.query('SELECT released_at FROM number_dispatch_slots WHERE effect_id=$1',[f.effects[0].id])).rows[0];
  expect(slot.released_at).toBeTruthy();
  const unsent=(await pool.query('SELECT status,result,finished_at FROM effect_attempts WHERE effect_id=$1',[f.effects[0].id])).rows;
  expect(unsent).toHaveLength(1);
  expect(unsent[0]).toMatchObject({status:'NOT_SENT',result:{reason:'OWNERSHIP_NOT_CONFIRMED',external_attempt:false}});
  expect(unsent[0].finished_at).toBeTruthy();
  await pool.query("UPDATE session_ownership SET lease_expires_at=now()+interval '60 seconds' WHERE account_id=$1",[f.account.id]);
  await recordHealth(f.account,()=>provider);
  await f.run(()=>provider);
  await f.run(()=>provider);
  rows=await f.states();
  expect(sent).toEqual(['First','Second']);
  expect(rows.map(row=>[row.status,row.attempts])).toEqual([['SENT',1],['SENT',1]]);
  expect(rows.map(row=>row.id)).toEqual(f.effects.map(effect=>effect.id));
  expect(rows.map(row=>row.predecessor_id)).toEqual([null,f.effects[0].id]);
  expect((await pool.query('SELECT status FROM effect_attempts WHERE effect_id=$1 ORDER BY started_at',[f.effects[0].id])).rows.map(row=>row.status)).toEqual(['NOT_SENT','SENT']);
 });

 it('cancels a newly suppressed contact without an external attempt or an uncertain result',async()=>{
  const f=await fixture();let sends=0;
  const provider=new SimulatorProvider();provider.send=async()=>{sends++;return{status:'ACCEPTED'};};
  await f.run(async()=>{
   await pool.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,suppressed,reason,actor_id) VALUES($1,'contact',$2,true,'Synthetic opt out before HTTP','test')",[f.workspace,f.contact.id]);
   return provider;
  });
  expect(sends).toBe(0);
  const rows=await f.states();
  expect(rows.map(row=>[row.status,row.attempts])).toEqual([['CANCELLED',0],['CANCELLED',0]]);
  expect(rows[0].result).toMatchObject({reason:'CONTACT_SUPPRESSED',external_attempt:false});
  expect(rows[1].result.reason).toBe('CAUSAL_PREDECESSOR_FAILED');
 });

 it('preserves UNKNOWN and its admission slot when recovery wins while preparation is still running',async()=>{
  const f=await fixture();let sends=0;
  const provider=new SimulatorProvider();provider.send=async()=>{sends++;return{status:'ACCEPTED'};};
  await f.run(async()=>{
   await pool.query("UPDATE outbox SET claimed_at=now()-interval '2 minutes' WHERE id=$1",[f.effects[0].id]);
   await recoverSending(60);
   return provider;
  });
  await f.run(()=>provider);
  expect(sends).toBe(0);
  const rows=await f.states();
  expect(rows[0]).toMatchObject({status:'UNKNOWN',attempts:1,result:{reason:'ABANDONED_SENDING_REQUIRES_RECONCILIATION'}});
  expect(rows[0].claim_id).toBeTruthy();
  expect(rows[1]).toMatchObject({status:'BLOCKED',attempts:0});
  expect((await pool.query('SELECT released_at FROM number_dispatch_slots WHERE effect_id=$1',[f.effects[0].id])).rows[0].released_at).toBeNull();
 });

 it('defers provider configuration failures before HTTP and recovers without consuming an external attempt',async()=>{
  const f=await fixture();
  await f.run(async():Promise<MessagingProvider>=>{throw new Error('PROVIDER_CONFIGURATION_REQUIRED_PROFILE');});
  expect((await f.states())[0]).toMatchObject({status:'BLOCKED',attempts:0,result:{reason:'PROVIDER_CONFIGURATION_REQUIRED_PROFILE',external_attempt:false}});
  let sends=0;const provider=new SimulatorProvider();provider.send=async message=>{sends++;return{status:'ACCEPTED',providerMessageId:message.effectId};};
  await f.run(()=>provider);
  await f.run(()=>provider);
  expect(sends).toBe(2);
  expect((await f.states()).map(row=>[row.status,row.attempts])).toEqual([['SENT',1],['SENT',1]]);
 });

 it('keeps a definitive provider rejection terminal and never retries it',async()=>{
  const f=await fixture();let sends=0;
  const provider=new SimulatorProvider();provider.send=async()=>{sends++;return{status:'REJECTED',reason:'PROVIDER_REJECTED'};};
  await f.run(()=>provider);
  await f.run(()=>provider);
  expect(sends).toBe(1);
  expect((await f.states()).map(row=>[row.status,row.attempts])).toEqual([['FAILED',1],['CANCELLED',0]]);
 });
});
