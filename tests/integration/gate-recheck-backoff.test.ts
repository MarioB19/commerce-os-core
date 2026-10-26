import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {pool,putRecord,withTransaction} from '../../packages/db/src/index.js';
import {proposeEffect} from '../../apps/automation-worker/src/shared.js';
import {GATE_RECHECK_SQL,GATE_RECHECK_MAX_SECONDS,TRANSIENT_GATE_REASONS} from '../../apps/channel-worker/src/dispatch.js';

// 25-oct-2026 (V7.1): 15 SIMULATION effects that can never pass (invalid asset
// scope, unresolved predecessor) were re-evaluated and rewritten on every 500 ms
// pass in production: 30 gate-schedule upserts/s and their WAL. A reason that
// repeats on a block older than ten minutes now backs off; see
// docs/adr-v7-1-worker-loop-budget.md.
const workspace='gate-backoff-'+randomUUID();
beforeAll(()=>fixtureProfiles(workspace));
afterAll(async()=>pool.end());
let effectId='';
beforeAll(async()=>{
 const product=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'product',body:{name:'Gate backoff product'}});
 const offer=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'offer',body:{product_id:product.id,base_amount_minor:9900,currency:'MXN',status:'PUBLISHED',fulfillment:[],billing_delay_seconds:30}});
 const account=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body:{name:'Gate backoff account',provider:'simulator',status:'WORKING'}});
 const contact=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'contact',body:{name:'Gate backoff contact',identity:'opaque:'+randomUUID(),status:'LEAD',consent:{purpose:'messages',source:'fixture',evidence:'local explicit consent fixture',observed_at:new Date().toISOString()}}});
 const conversation=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'conversation',body:{account_id:account.id,contact_id:contact.id,offer_version_id:offer.id,status:'OPEN',stage:'NEW',sequence:1,last_inbound_at:new Date().toISOString(),ai_pending:false}});
 effectId=(await withTransaction(c=>proposeEffect(c,conversation,{kind:'text',text:'Gate backoff'},randomUUID()))).id;
});

/** One recheck in its own transaction; `checkedAgo` places the previous check that long ago and
 * `blockedAgo` the moment the effect entered its current block (outbox.updated_at). */
async function recheck(reason:string,checkedAgo?:string,blockedAgo='1 hour'){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query(`UPDATE outbox SET updated_at=now()-$2::interval WHERE id=$1`,[effectId,blockedAgo]);
  if(checkedAgo)await client.query(`UPDATE outbox_gate_schedule SET updated_at=now()-$2::interval WHERE effect_id=$1`,[effectId,checkedAgo]);
  await client.query(GATE_RECHECK_SQL,[effectId,reason,[...TRANSIENT_GATE_REASONS]]);
  const row=(await client.query(`SELECT last_reason,extract(epoch FROM next_check_at-now())::float8 AS wait,updated_at=now() AS checked_now FROM outbox_gate_schedule WHERE effect_id=$1`,[effectId])).rows[0];
  await client.query('COMMIT');
  return row as {last_reason:string;wait:number;checked_now:boolean};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

it('first check of a reason keeps the base interval (SIMULATION 0 s)',async()=>{
 expect(await recheck('ASSET_SCOPE_INVALID')).toEqual({last_reason:'ASSET_SCOPE_INVALID',wait:0,checked_now:true});
});
it('a repeated reason waits twice the time since the previous check, at least 1 s',async()=>{
 expect((await recheck('ASSET_SCOPE_INVALID','0 seconds')).wait).toBe(1);
 expect((await recheck('ASSET_SCOPE_INVALID','4 seconds')).wait).toBe(8);
});
it('the backoff is capped',async()=>{
 expect((await recheck('ASSET_SCOPE_INVALID','1 hour')).wait).toBe(GATE_RECHECK_MAX_SECONDS);
});
it('a new reason resets to the base interval',async()=>{
 expect(await recheck('CAUSAL_PREDECESSOR_UNRESOLVED','1 hour')).toEqual({last_reason:'CAUSAL_PREDECESSOR_UNRESOLVED',wait:0,checked_now:true});
});
it('a recent block keeps the base interval so live flows and simulations progress',async()=>{
 await recheck('CAUSAL_PREDECESSOR_UNRESOLVED','1 hour');
 expect((await recheck('CAUSAL_PREDECESSOR_UNRESOLVED','4 seconds','9 minutes')).wait).toBe(0);
 expect((await recheck('CAUSAL_PREDECESSOR_UNRESOLVED','4 seconds','10 minutes')).wait).toBe(8);
});
it('transient contention never backs off',async()=>{
 for(const reason of TRANSIENT_GATE_REASONS){
  await recheck(reason);
  expect((await recheck(reason,'20 seconds')).wait).toBe(0);
 }
});
