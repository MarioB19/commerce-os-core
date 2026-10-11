import {explicitFixtureEnvironment} from './explicit-fixture-environment.js';
import {describe,it,expect,afterAll} from 'vitest';
import {randomUUID} from 'node:crypto';
import {pool,putRecord,withTransaction} from '../../packages/db/src/index.js';
import {proposeEffect} from '../../apps/automation-worker/src/shared.js';
import {dispatchOutbox,recoverSending,acquireOwnership,recordHealth} from '../../apps/channel-worker/src/runtime.js';
import {SimulatorProvider,type MessagingProvider,type SendResult} from '../../packages/messaging/src/index.js';
import {buildIngress} from '../../apps/ingress/src/server.js';
import type {DomainRecord} from '../../packages/contracts/src/index.js';
const workspace='fault-'+randomUUID(),owner='test-channel-owner';
const normalSimulator=new SimulatorProvider();
// The worker scans all workspaces; fault injection belongs only to this fixture.
const scopedProvider=(provider:MessagingProvider)=>(account:DomainRecord)=>account.workspace_id===workspace?provider:normalSimulator;
afterAll(async()=>pool.end());
async function fixture(provider:MessagingProvider=new SimulatorProvider(),existingContact?:DomainRecord,fixtureWorkspace=workspace){
 const account=await putRecord(pool,{workspaceId:fixtureWorkspace,environment:'SIMULATION',kind:'channel_account',body:{name:'Synthetic fault account',provider:'simulator',status:'WORKING'}});
 const contact=existingContact??await putRecord(pool,{workspaceId:fixtureWorkspace,environment:'SIMULATION',kind:'contact',body:{name:'Synthetic contact',identity:'opaque:'+randomUUID(),status:'LEAD'}});
 const conversation=await putRecord(pool,{workspaceId:fixtureWorkspace,environment:'SIMULATION',kind:'conversation',body:{account_id:account.id,contact_id:contact.id,status:'OPEN',last_inbound_at:new Date().toISOString()}});
 await acquireOwnership(account,owner);await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[account.id]);
 await recordHealth(account,()=>provider);
 const effect=await withTransaction(c=>proposeEffect(c,conversation,{kind:'text',text:'Synthetic dispatch'},randomUUID()));
 return {account,contact,conversation,effect,provider};
}
const state=async(id:string)=>(await pool.query('SELECT * FROM outbox WHERE id=$1',[id])).rows[0];
describe('Durable channel fault boundaries with real PostgreSQL',()=>{
 it('claims before HTTP; ambiguous acceptance stays UNKNOWN across recovery and blocks causal successor',async()=>{
  let calls=0,claimedBeforeSend=false;const provider=new SimulatorProvider();provider.send=async()=>{calls++;const r=(await pool.query("SELECT status,attempts FROM outbox WHERE workspace_id=$1 AND status='SENDING'",[workspace])).rows;claimedBeforeSend=r.some(x=>x.attempts===1);return{status:'UNKNOWN',reason:'Simulated accepted then connection lost'};};
  const f=await fixture(provider),successor=await withTransaction(c=>proposeEffect(c,f.conversation,{kind:'text',text:'Must wait'},randomUUID()));
  // A foreign workspace with the same owner is deliberately eligible in this scan.
  const foreign=await fixture(normalSimulator,undefined,'foreign-fault-'+randomUUID());
  await dispatchOutbox(200,scopedProvider(provider),owner);expect(claimedBeforeSend).toBe(true);expect((await state(f.effect.id)).status).toBe('UNKNOWN');expect((await state(successor.id)).status).toBe('BLOCKED');
  expect(await state(foreign.effect.id)).toMatchObject({status:'SENT',attempts:1,result:{provider:'simulator',reason:null}});
  await recoverSending(0);await dispatchOutbox(200,scopedProvider(provider),owner);expect(calls).toBe(1);expect((await state(f.effect.id)).attempts).toBe(1);
 });
 it('cannot transfer an expired lease while the old owner may still be alive',async()=>{
  const f=await fixture();await pool.query("UPDATE session_ownership SET lease_expires_at=now()-interval '1 second' WHERE account_id=$1",[f.account.id]);
  const attempt=await acquireOwnership(f.account,'second-owner');expect(attempt.acquired).toBe(false);
  const ownership=(await pool.query('SELECT * FROM session_ownership WHERE account_id=$1',[f.account.id])).rows[0];expect(ownership.owner_id).toBe(owner);expect(ownership.frozen).toBe(true);
 });
 it('suppresses the same contact across accounts before a dispatch',async()=>{
  const first=await fixture(),second=await fixture(new SimulatorProvider(),first.contact);let calls=0;
  await pool.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,suppressed,reason,actor_id) VALUES($1,'contact',$2,true,'synthetic opt out','test')",[workspace,first.contact.id]);
  const provider=new SimulatorProvider();provider.send=async()=>{calls++;return{status:'ACCEPTED'}};
  await dispatchOutbox(200,scopedProvider(provider),owner);expect((await state(first.effect.id)).status).toBe('CANCELLED');expect((await state(second.effect.id)).status).toBe('CANCELLED');expect(calls).toBe(0);
 });
 it('revalidates takeover after content preparation and records in-flight result on late return',async()=>{
  const f=await fixture();let entered!:()=>void,release!:(r:SendResult)=>void;
  const started=new Promise<void>(r=>{entered=r});const response=new Promise<SendResult>(r=>{release=r});
  const provider=new SimulatorProvider();provider.send=async()=>{entered();return response;};
  const run=dispatchOutbox(200,scopedProvider(provider),owner);await started;
  await pool.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,takeover,reason,actor_id) VALUES($1,'conversation',$2,true,'human takeover','test')",[workspace,f.conversation.id]);
  await pool.query("UPDATE outbox SET claimed_at=now()-interval '2 minutes' WHERE id=$1",[f.effect.id]);await recoverSending(60);
  release({status:'ACCEPTED',providerMessageId:'synthetic-late-acceptance'});await run;
  expect((await state(f.effect.id)).status).toBe('UNKNOWN');
  const attempts=(await pool.query('SELECT * FROM effect_attempts WHERE effect_id=$1',[f.effect.id])).rows;
  expect(JSON.stringify(attempts)).toContain('synthetic-late-acceptance');
 });
 it('persists authenticated envelopes before ACK, rejects tampering and fails closed on DB write failure',async()=>{
  const f=await fixture();process.env.SIMULATOR_INGRESS_TOKEN='synthetic-fixture-ingress-token';const app=await buildIngress();
  const payload={id:'duplicate-event',identity:'opaque:test-ingress',text:'Synthetic input'};
  const inject=()=>app.inject(explicitFixtureEnvironment({method:'POST',url:`/webhooks/simulator/${workspace}/${f.account.id}`,headers:{authorization:'Bearer synthetic-fixture-ingress-token'},payload}));
  const a=await inject(),b=await inject();expect(a.statusCode).toBe(200);expect(b.json().duplicate).toBe(true);
  const rows=(await pool.query('SELECT * FROM inbound_envelopes WHERE workspace_id=$1 AND account_id=$2',[workspace,f.account.id])).rows;expect(rows).toHaveLength(1);expect(rows[0].payload_ciphertext).not.toContain(payload.text);
  const unauthenticated=await app.inject(explicitFixtureEnvironment({method:'POST',url:`/webhooks/simulator/${workspace}/${f.account.id}`,payload}));expect(unauthenticated.statusCode).toBe(401);
  // Failure occurs after account read/auth and before durable insert, so an ACK would be data loss.
  await pool.query("CREATE FUNCTION injected_ingress_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED_PERSISTENCE_FAILURE'; END $$");
  await pool.query('CREATE TRIGGER injected_ingress_failure BEFORE INSERT ON inbound_envelopes FOR EACH ROW EXECUTE FUNCTION injected_ingress_failure()');
  try{expect((await inject()).statusCode).toBe(503);}finally{await pool.query('DROP TRIGGER injected_ingress_failure ON inbound_envelopes');await pool.query('DROP FUNCTION injected_ingress_failure()');await app.close();}
 });
});
