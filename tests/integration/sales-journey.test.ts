import {explicitFixtureEnvironment} from './explicit-fixture-environment.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID,randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../apps/api/src/app.js';
import { provisionUser } from '../../apps/api/src/auth.js';
import {startEngineSimulation,advanceEngineSimulation} from '../support/engine-simulation.js';
import { pool,putRecord } from '../../packages/db/src/index.js';
import { processChannelCommands,dispatchOutbox } from '../../apps/channel-worker/src/runtime.js';
import {SimulatorProvider} from '../../packages/messaging/src/index.js';
import {materializeEffectResults} from '../../apps/automation-worker/src/effect-results.js';
import { processCommands,processTimers } from '../../apps/automation-worker/src/runtime.js';

const workspace='journey-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://127.0.0.1:5173').split(',')[0]!;
let app:FastifyInstance,cookie:string;
async function request(method:'GET'|'POST'|'PATCH'|'PUT'|'DELETE',url:string,payload?:any,key:string=randomUUID(),auth=cookie){
 const r=await app.inject(explicitFixtureEnvironment({method,url,headers:{cookie:auth,origin,'idempotency-key':key},...(payload===undefined?{}:{payload})}));
 return {status:r.statusCode,json:r.headers['content-type']?.includes('json')?r.json():undefined,raw:r.body};
}
async function ok(method:'GET'|'POST'|'PATCH'|'PUT'|'DELETE',url:string,payload?:any,key?:string){const r=await request(method,url,payload,key);expect(r.status,`${method} ${url}: ${r.raw}`).toBeLessThan(300);return r.json?.data;}
async function apply(commandId:string){await processCommands(100);const cmd=(await pool.query('SELECT * FROM commands WHERE id=$1',[commandId])).rows[0];expect(cmd?.status,JSON.stringify(cmd?.result)).toBe('APPLIED');return cmd.result;}
async function projectedDeliveries(orderId:string,simulator:SimulatorProvider,channelOwner:string){
 // Both workers consume global, bounded queues shared by this integration DB.
 // Advance real worker ticks so an older predecessor can unblock this order's
 // next effect instead of only re-running the read-model projection.
 let mine:any[]=[];
 for(let batch=0;batch<20;batch++){
  await dispatchOutbox(100,()=>simulator,channelOwner);
  await materializeEffectResults(100);
  const fulfillment=await ok('GET','/v1/fulfillments');mine=fulfillment.filter((f:any)=>f.order_id===orderId);
  if(mine.length===2&&mine.every((f:any)=>f.status==='SENT'))return mine;
 }
 return mine; // Original assertions below report missing/incorrect deliveries.
}
async function evidence(label:string){
 const bytes=Buffer.from(`%PDF-1.4\n% Explicit synthetic test evidence ${label}\n1 0 obj << /Type /Catalog >> endobj\n%%EOF`);
 const a=await ok('POST','/v1/assets/upload-intents',{name:'Evidencia sintética '+label,kind:'file',mime_type:'application/pdf',size_bytes:bytes.length});
 await ok('PUT',`/v1/assets/${a.id}/content`,{base64:bytes.toString('base64')});await ok('POST',`/v1/assets/${a.id}/complete`,{});return a.id;
}
beforeAll(async()=>{app=await createApp();const email=`${randomUUID()}@commerce.test`,password=randomBytes(24).toString('base64url');await provisionUser({email,password,name:'Synthetic journey owner',workspace_id:workspace,role:'owner'});const r=await app.inject(explicitFixtureEnvironment({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.44',headers:{origin},payload:{email,password}}));expect(r.statusCode).toBe(200);const c=r.headers['set-cookie'];cookie=(Array.isArray(c)?c:[c]).filter(Boolean).map(x=>String(x).split(';')[0]).join('; ');});
afterAll(async()=>{await app.close();await pool.end();});
describe('Integrated sales API and PostgreSQL automation',()=>{
 it('runs two product/conversation journeys concurrently with immutable offers, review, TEST receipt recognition and exclusion from commercial reporting',async()=>{
  const simulator=new SimulatorProvider(),channelOwner='journey-channel';
  // Explicit terminal read-model fixtures precede this test's real simulator
  // effects. They exercise global queue pressure, not observed provider sends.
  const backlogScope={workspaceId:workspace+'-projection-backlog',environment:'SIMULATION' as const},backlogAccount=await putRecord(pool,{...backlogScope,kind:'channel_account',body:{name:'Projection fixture only',provider:'simulator',status:'STOPPED',sending_enabled:false}}),backlogContact=await putRecord(pool,{...backlogScope,kind:'contact',body:{name:'Projection fixture only',identity:'opaque:projection-fixture'}}),backlogConversation=await putRecord(pool,{...backlogScope,kind:'conversation',body:{account_id:backlogAccount.id,contact_id:backlogContact.id,status:'CLOSED',ai_pending:false}});
  await pool.query(`INSERT INTO outbox(workspace_id,environment,account_id,conversation_id,contact_id,logical_key,kind,payload,status,config_hash,created_at,updated_at)
   SELECT $1,'SIMULATION',$2,$3,$4,'projection-fixture-'||n,'message','{"kind":"text","synthetic_projection_fixture":true}'::jsonb,'SENT','read-model-fixture-only','2001-01-01T00:00:00Z','2001-01-01T00:00:00Z'
   FROM generate_series(1,220) n`,[backlogScope.workspaceId,backlogAccount.id,backlogConversation.id,backlogContact.id]);

  const policy=await ok('POST','/v1/receipt-policies',{name:'Human document review',allow_amount_mismatch:true,auto_approve:false});
  const journeys=await Promise.all([0,1].map(async i=>{
   const core=await ok('POST','/v1/assets',{name:`Core ${i}`,kind:'link',url:`https://example.com/synthetic/core-${i}`});
   const bonus=await ok('POST','/v1/assets',{name:`Bonus ${i}`,kind:'link',url:`https://example.com/synthetic/bonus-${i}`});
   const amount=9900+i*5000;
   const product=await ok('POST','/v1/products',{name:`Producto ${i}`,initial_offer:{currency:'MXN',base_amount_minor:amount,billing_delay_seconds:30,receipt_policy_version_id:policy.id,fulfillment:[{asset_id:core.id,release_on:'commitment_accepted'},{asset_id:bonus.id,release_on:'receipt_approved'}]}});
   const account=await ok('POST','/v1/channel-accounts',{name:`Cuenta ${i}`,provider:'simulator'});
   const sim:any=await startEngineSimulation(workspace,'synthetic-journey-owner',{account_id:account.id,offer_version_id:product.initial_offer.id,contact_name:`Cliente sintético ${i}`});
   return {product,account,sim,core,bonus,amount};
  }));
  await processCommands(100);
  for(const j of journeys)await ok('POST',`/v1/channel-accounts/${j.account.id}/commands`,{type:'connect'});
  await processChannelCommands(100,()=>simulator,channelOwner);
  for(const j of journeys){
   const started=(await pool.query('SELECT result,status FROM commands WHERE id=$1',[j.sim.command_id])).rows[0];expect(started.status,JSON.stringify(started.result)).toBe('APPLIED');j.sim.conversation_id=started.result.conversation_id;
   const commitment=await ok('POST',`/v1/conversations/${j.sim.conversation_id}/commands`,{type:'commitment'});await apply(commitment.id);
  }
  await dispatchOutbox(100,()=>simulator,channelOwner);await materializeEffectResults(100);
  expect((await pool.query("SELECT count(*)::int count FROM records WHERE workspace_id=$1 AND kind='message' AND body ? 'effect_id'",[workspace])).rows[0].count).toBe(0); // The first batch is deliberately occupied by older fixtures.
  const before=await ok('GET','/v1/reports/summary');expect(before.counts.reconciled).toBe(0);
  for(const [i,j]of journeys.entries()){
   // A new offer must not change this existing order or its delivery references.
   await ok('POST',`/v1/products/${j.product.id}/offers`,{currency:'MXN',base_amount_minor:55555,fulfillment:[]});
   const advanced=await advanceEngineSimulation(workspace,'synthetic-journey-owner',j.sim.id,{seconds:31});await apply(advanced.id);await processTimers(100);
   const assetId=await evidence('receipt-'+i);
   const received=await ok('POST',`/v1/conversations/${j.sim.conversation_id}/commands`,{type:'receipt_received',asset_id:assetId,extraction:{is_receipt:true,amount_minor:j.amount-100,currency:'MXN',destination_suffix:null,bank:null,reference:`synthetic-${i}`,status:'completed',confidence:0.99,contradictions:[]}});
   const rr=await apply(received.id);
   const receipt=await ok('GET',`/v1/receipts/${rr.receipt_id}`);
   const review=await ok('POST',`/v1/receipts/${receipt.id}/review`,{decision:'APPROVED',reason:'Revisión documental sintética explícita',expected_version:receipt.version});await apply(review.id);
   const order=await ok('GET',`/v1/orders/${rr.order_id}`);expect(order.offer_version_id).toBe(j.product.initial_offer.id);expect(order.amount_minor).toBe(j.amount);expect(order.reconciliation_status).not.toBe('RECONCILED');
   const complete=await ok('GET',`/v1/orders/${order.id}`);expect(complete.sale_status).toBe('TEST');expect(complete.sale_amount_minor).toBe(0);expect(complete.test_approved_amount_minor).toBe(j.amount-100);expect(complete.product_id).toBe(j.product.id);
   await dispatchOutbox(100,()=>simulator,channelOwner);
   const mine=await projectedDeliveries(order.id,simulator,channelOwner);expect(new Set(mine.map((f:any)=>f.asset_id))).toEqual(new Set([j.core.id,j.bonus.id]));expect(mine.every((f:any)=>f.status==='SENT'),JSON.stringify(mine.map((f:any)=>({id:f.id,status:f.status})))).toBe(true);
   const conversation=await ok('GET',`/v1/conversations/${j.sim.conversation_id}`);
   // The API redacts digit-heavy identities, including some random simulation UUIDs.
   // Correlate immutable effects, then verify the actual recipient in this isolated DB.
   const effectIds=new Set(conversation.outbox.map((effect:any)=>effect.id));
   const sent=simulator.sent.filter(message=>effectIds.has(message.effectId));
   const contact=(await pool.query("SELECT body->>'identity' AS identity FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='contact' AND id=$2",[workspace,conversation.contact.id])).rows[0];
   expect(sent.every(message=>message.recipient===contact.identity)).toBe(true);
   expect(sent.map(m=>m.text)).toContain(j.core.url);expect(sent.map(m=>m.text)).toContain(j.bonus.url);const other=journeys[1-i]!;expect(sent.map(m=>m.text)).not.toContain(other.core.url);
  }
  await processCommands(100);await processTimers(100);
  const summary=await ok('GET','/v1/reports/summary');expect(summary.counts.reconciled).toBe(0);expect(summary.counts.orders).toBe(0);expect(summary.revenue_by_currency).toEqual([]);expect(summary.roas).toBeNull();
  const real=await ok('GET','/v1/reports/summary?environment=REAL');expect(real.counts.orders).toBe(0);
 });
 it('enforces command idempotency and rejects reused keys with different product payloads',async()=>{
  const key=randomUUID(),body={name:'Idempotent product'};
  const a=await ok('POST','/v1/products',body,key),b=await ok('POST','/v1/products',body,key);expect(a.id).toBe(b.id);
  expect((await request('POST','/v1/products',{name:'Different'},key)).status).toBe(409);
  expect((await request('POST','/v1/products',{name:'Denied'},randomUUID(),'')).status).toBe(401);
 });
 it('seals evidence once completed and does not allow a replay key to replace its bytes',async()=>{
  const id=await evidence('sealed');const before=await request('GET',`/v1/assets/${id}/content`);
  expect((await request('PUT',`/v1/assets/${id}/content`,{base64:Buffer.from('replacement').toString('base64')})).status).toBeGreaterThanOrEqual(400);
  const after=await request('GET',`/v1/assets/${id}/content`);expect(after.raw).toBe(before.raw);
 });
});
