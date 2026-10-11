import {afterAll,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {pool,putRecord,withTransaction} from '../../packages/db/src/index.js';
import {proposeEffect} from '../../apps/automation-worker/src/shared.js';
import {acquireOwnership,dispatchOutbox,recordHealth} from '../../apps/channel-worker/src/runtime.js';
import {SimulatorProvider} from '../../packages/messaging/src/index.js';

const workspace='causal-'+randomUUID();
afterAll(async()=>pool.end());
// These tests inspect one complete causal pass, not global scheduler pagination.
// Other files retain isolated fixtures; LIMIT 100 can exclude this account's third sibling.
async function completeFixturePassLimit(){return Math.max(1,Number((await pool.query("SELECT count(*) FROM outbox WHERE status IN('READY','BLOCKED')")).rows[0].count));}
async function fixture(){
 const account=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body:{name:'Causal fixture',provider:'simulator',status:'WORKING'}});
 const contact=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'contact',body:{name:'Synthetic contact',identity:'opaque:'+randomUUID()}});
 const conversation=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'conversation',body:{account_id:account.id,contact_id:contact.id,last_inbound_at:new Date().toISOString()}});
 return {account,contact,conversation};
}

describe('Durable causal order with real PostgreSQL',()=>{
 it('chains every proposal from one transaction despite identical timestamps',async()=>{
  const f=await fixture();
  const effects=await withTransaction(async client=>{
   await client.query('SET LOCAL ROLE commerce_automation');
   const rows=[];
   for(let i=0;i<20;i++)rows.push(await proposeEffect(client,f.conversation,{kind:'text',text:'Step '+i},randomUUID()));
   return rows;
  });
  expect(new Set(effects.map(e=>new Date(e.created_at).getTime())).size).toBe(1);
  expect(effects.map(e=>e.predecessor_id)).toEqual([null,...effects.slice(0,-1).map(e=>e.id)]);
  for(let i=1;i<effects.length;i++)expect(BigInt(effects[i].dispatch_sequence)).toBeGreaterThan(BigInt(effects[i-1].dispatch_sequence));
 });

 it('serializes concurrent proposals into one chain without branches',async()=>{
  const f=await fixture();
  await Promise.all(Array.from({length:20},(_,i)=>withTransaction(client=>proposeEffect(client,f.conversation,{kind:'text',text:'Concurrent '+i},randomUUID()))));
  const effects=(await pool.query('SELECT * FROM outbox WHERE conversation_id=$1 ORDER BY dispatch_sequence',[f.conversation.id])).rows;
  expect(effects).toHaveLength(20);
  expect(effects.map(e=>e.predecessor_id)).toEqual([null,...effects.slice(0,-1).map(e=>e.id)]);
 });

 it('rejects cross-conversation predecessors and runtime changes to causal edges',async()=>{
  const a=await fixture(),b=await fixture();
  const first=await withTransaction(client=>proposeEffect(client,a.conversation,{kind:'text',text:'First'},randomUUID()));
  const second=await withTransaction(client=>proposeEffect(client,a.conversation,{kind:'text',text:'Second'},randomUUID()));
  await expect(withTransaction(client=>proposeEffect(client,b.conversation,{kind:'text',text:'Invalid predecessor'},randomUUID(),{predecessorId:first.id}))).rejects.toThrow('INVALID_EFFECT_PREDECESSOR');
  await expect(withTransaction(async client=>{
   await client.query('SET LOCAL ROLE commerce_channel');
   await client.query('UPDATE outbox SET predecessor_id=NULL WHERE id=$1',[second.id]);
  })).rejects.toThrow('IMMUTABLE_EFFECT_CAUSALITY');
 });

 it('dispatches transaction siblings in sequence and blocks the tail after uncertainty',async()=>{
  const f=await fixture(),owner='causal-fixture-owner';
  await acquireOwnership(f.account,owner);
  await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[f.account.id]);
  await recordHealth(f.account,()=>new SimulatorProvider());
  const effects=await withTransaction(async client=>{
   const rows=[];
   for(const text of ['first','uncertain','must wait'])rows.push(await proposeEffect(client,f.conversation,{kind:'text',text},randomUUID()));
   return rows;
  });
  const observed:string[]=[];
  const provider=Object.assign(new SimulatorProvider(),{send:async(message:{text?:string})=>{
   observed.push(message.text??'');
   return message.text==='uncertain'?{status:'UNKNOWN' as const,reason:'FIXTURE_RESPONSE_LOST'}:{status:'ACCEPTED' as const,providerMessageId:'fixture-'+message.text};
  }});
  await dispatchOutbox(await completeFixturePassLimit(),account=>account.id===f.account.id&&account.workspace_id===workspace?provider:new SimulatorProvider(),owner);
  expect(observed).toEqual(['first','uncertain']);
  const rows=(await pool.query('SELECT status,result,updated_at FROM outbox WHERE id=ANY($1) ORDER BY dispatch_sequence',[effects.map(e=>e.id)])).rows;
  expect(rows.map(e=>e.status)).toEqual(['SENT','UNKNOWN','BLOCKED']);
  expect(rows[2].result.reason).toBe('CAUSAL_PREDECESSOR_UNRESOLVED');
  const blockedUpdatedAt=new Date(rows[2].updated_at).toISOString();
  await new Promise(resolve=>setTimeout(resolve,10));
  await dispatchOutbox(await completeFixturePassLimit(),account=>account.id===f.account.id&&account.workspace_id===workspace?provider:new SimulatorProvider(),owner);
  const repeated=(await pool.query('SELECT status,result,updated_at FROM outbox WHERE id=$1',[effects[2].id])).rows[0];
  expect(repeated).toMatchObject({status:'BLOCKED',result:{reason:'CAUSAL_PREDECESSOR_UNRESOLVED'}});
  expect(new Date(repeated.updated_at).toISOString()).toBe(blockedUpdatedAt);
 });

 it('lets a conversation control cancel a queued effect while dispatch waits without deadlocking',async()=>{
  const f=await fixture(),owner='control-lock-fixture-owner';
  await acquireOwnership(f.account,owner);
  await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[f.account.id]);
  await recordHealth(f.account,()=>new SimulatorProvider());
  const effect=await withTransaction(client=>proposeEffect(client,f.conversation,{kind:'text',text:'Must cancel'},randomUUID()));
  let locked!:()=>void,release!:()=>void;
  const holding=new Promise<void>(resolve=>{locked=resolve;});
  const releaseControl=new Promise<void>(resolve=>{release=resolve;});
  const control=withTransaction(async client=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[f.conversation.id]);
   locked();
   await releaseControl;
   await client.query("UPDATE outbox SET status='CANCELLED',result='{}' WHERE id=$1",[effect.id]);
  });
  await holding;
  let remoteCalls=0;
  const provider=Object.assign(new SimulatorProvider(),{send:async()=>{remoteCalls++;return{status:'ACCEPTED' as const,providerMessageId:'unexpected-fixture'};}});
  const dispatch=dispatchOutbox(await completeFixturePassLimit(),account=>account.id===f.account.id&&account.workspace_id===workspace?provider:new SimulatorProvider(),owner);
  let observedWait=false;
  try{
   const deadline=Date.now()+5000;
   while(Date.now()<deadline){
    observedWait=Number((await pool.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'")).rows[0].count)>0;
    if(observedWait)break;
    await new Promise(resolve=>setTimeout(resolve,10));
   }
  }finally{release();}
  await Promise.all([control,dispatch]);
  expect(observedWait).toBe(true);
  expect(remoteCalls).toBe(0);
  expect((await pool.query('SELECT status FROM outbox WHERE id=$1',[effect.id])).rows[0].status).toBe('CANCELLED');
 });
});
