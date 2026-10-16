import {afterAll,expect,it,beforeAll} from 'vitest';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {randomUUID} from 'node:crypto';
import {pool,putRecord,getRecord,withTransaction,appendEvent,hash} from '../../packages/db/src/index.js';
import type {Body,DomainRecord} from '../../packages/contracts/src/index.js';
import {preschoolWorkflow} from '../../packages/domain/src/sales/preschool.js';
import {composeSellerContext} from '../../packages/domain/src/sales/seller-context.js';
import {preschoolSeller} from '../fixtures/preschool-commercial.js';
import {materializeMessage} from '../../apps/automation-worker/src/inbound.js';
import {advanceWorkflow,ensureOrder} from '../../apps/automation-worker/src/workflows.js';
import {applyCommand,applyReceiptAnalysis} from '../../apps/automation-worker/src/commands.js';
import {materializeEffectResults} from '../../apps/automation-worker/src/effect-results.js';
import {consumeProviderObservations} from '../../apps/channel-worker/src/observations.js';

const workspace='preschool-operational-'+randomUUID();
// V7 F2: fixture workspaces are adopted profiles (max three per installation).
beforeAll(()=>fixtureProfiles(workspace));
afterAll(async()=>pool.end());
const record=(kind:string,body:Body)=>putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind,body});
async function fixture(){
 const assets:Record<string,DomainRecord>={};for(const name of ['pitch','agreement','collection','calendar','core','kit'])assets[name]=await record('asset',{name:'Synthetic '+name,kind:['core','kit'].includes(name)?'link':'file',status:'READY',mime_type:name==='calendar'?'application/pdf':'audio/mpeg',url:'https://example.com/synthetic-'+name,storage_key:randomUUID(),sha256:hash(randomUUID())});
 const product=await record('product',{name:'Synthetic preschool'}),policy=await record('receipt_policy',{allow_amount_mismatch:true,min_amount_minor:1,auto_approve:false,require_currency:true});
 const recipe=preschoolWorkflow({pitch:assets.pitch!.id,agreement:assets.agreement!.id,collection:assets.collection!.id});
 // A sealed historical version can keep English variables and still feed the canonical seller.
 recipe.nodes.find(n=>n.id==='grade')!.config.variable='grade';recipe.nodes.find(n=>n.id==='pitch_reply')!.config.variable='interest';
 const flow=await record('workflow',{...recipe,status:'PUBLISHED'});
 const offer=await record('offer',{product_id:product.id,name:'Synthetic 97 / 107 total',status:'PUBLISHED',currency:'MXN',base_amount_minor:9700,receipt_policy_version_id:policy.id,workflow_version_id:flow.id,fulfillment:[{asset_id:assets.core!.id,release_on:'commitment_accepted'},{asset_id:assets.calendar!.id,release_on:'receipt_approved',min_amount_minor:1},{asset_id:assets.kit!.id,release_on:'receipt_approved',min_amount_minor:10700}]});
 const account=await record('channel_account',{name:'Synthetic channel',provider:'simulator',status:'WORKING',offer_version_id:offer.id,workflow_version_id:flow.id});
 const identity='opaque:'+randomUUID();let instant=Date.now();
 const receive=(text:string,key=randomUUID(),at?:string)=>withTransaction(c=>materializeMessage(c,account,{key,type:'message',providerAt:at??new Date(instant+=1000).toISOString(),identity,text,kind:'text',payload:{}},randomUUID()));
 const conversation=(await receive('Hola'))!;await withTransaction(c=>advanceWorkflow(c,conversation));
 const current=async()=>(await getRecord(pool,workspace,'conversation',conversation.id))!;
 const order=async()=>(await withTransaction(c=>ensureOrder(c,conversation)))!;
 const fulfillments=async()=>(await pool.query("SELECT * FROM records WHERE workspace_id=$1 AND kind='fulfillment' AND body->>'conversation_id'=$2 ORDER BY created_at",[workspace,conversation.id])).rows as DomainRecord[];
 const command=(kind:string,resource_id:string,payload:Body)=>withTransaction(c=>applyCommand(c,{id:randomUUID(),workspace_id:workspace,environment:'SIMULATION',kind,resource_id,actor_id:'synthetic-operator',payload}));
 const receipt=async()=>record('receipt',{conversation_id:conversation.id,order_id:(await order()).id,asset_id:(await record('asset',{name:'Synthetic receipt',kind:'file',status:'READY',storage_key:randomUUID(),sha256:hash(randomUUID())})).id,status:'HUMAN_REVIEW',extraction:{amount_minor:9700,currency:'MXN'}});
 const review=async(r:DomainRecord,amount=9700,extra:Body={})=>command('receipt_review',r.id,{expected_version:(await getRecord(pool,workspace,'receipt',r.id))!.version,decision:'APPROVED',amount_minor:amount,currency:'MXN',reason:'Synthetic accepted document',...extra});
 const commit=async()=>{for(const text of ['segundo','me interesa','SÍ, QUIERO MI CICLO LISTO'])await receive(text);};
 return {assets,account,conversation,current,order,receive,fulfillments,command,receipt,review,commit};
}
it('runs pinned recipe once per reply, preserves aliases and refuses early, bare and late commitment',async()=>{
 const f=await fixture();
 await expect(f.command('conversation_command',f.conversation.id,{type:'commitment'})).rejects.toThrow('WORKFLOW_NOT_AWAITING_COMMITMENT');
 const key=randomUUID();await f.receive('segundo',key);expect(await f.receive('segundo',key)).toBeUndefined();
 expect((await f.current()).body.flow_state).toMatchObject({waiting_for:'customer_reply',waiting_node_id:'pitch_reply',variables:{grado:'segundo'}});
 await f.receive('SÍ, QUIERO MI CICLO LISTO',randomUUID(),'2020-01-01T00:00:00Z');
 expect((await f.current()).body.flow_state.waiting_node_id).toBe('pitch_reply');
 await f.receive('me interesa');await f.receive('sí');
 expect((await f.current()).body.flow_state).toMatchObject({waiting_for:'commitment',waiting_node_id:'commitment'});expect(await f.fulfillments()).toHaveLength(0);
 expect(composeSellerContext(preschoolSeller,{text:'precio',variables:(await f.current()).body.flow_state.variables}).variables).toEqual({grado:'segundo',interes:'me interesa'});
 expect((await pool.query('SELECT count(*)::int n FROM timers WHERE conversation_id=$1',[f.conversation.id])).rows[0].n).toBe(0);
 await f.receive('SÍ, QUIERO MI CICLO LISTO');expect((await f.order()).body.committed_at).toBeTruthy();expect((await f.fulfillments()).map(r=>r.body.asset_id)).toEqual([f.assets.core!.id]);
 expect((await f.current()).body.flow_state.waiting_for).toBe('receipt_approved');
});
it.each(['takeover','suppressed'] as const)('keeps commitment and Core behind %s controls',async control=>{
 const f=await fixture();await f.receive('segundo');await f.receive('me interesa');
 const conv=await f.current();await pool.query(`INSERT INTO manual_controls(workspace_id,scope_type,scope_id,${control},reason,actor_id) VALUES($1,$2,$3,true,'Synthetic control','test')`,[workspace,control==='takeover'?'conversation':'contact',control==='takeover'?conv.id:conv.body.contact_id]);
 await f.receive('SÍ, QUIERO MI CICLO LISTO');expect((await f.order()).body.committed_at).toBeUndefined();expect(await f.fulfillments()).toHaveLength(0);
});
it('preserves human receipt review, positive evidence, threshold totals and idempotent additional benefits',async()=>{
 const f=await fixture();await f.commit();const r=await f.receipt();
 await withTransaction(c=>applyReceiptAnalysis(c,r,{is_receipt:true,amount_minor:9700,currency:'MXN',destination_suffix:null,bank:null,reference:null,status:'completed',confidence:1,contradictions:[]},randomUUID()));
 expect((await getRecord(pool,workspace,'receipt',r.id))!.body.status).toBe('HUMAN_REVIEW');expect(await f.fulfillments()).toHaveLength(1);
 await expect(f.review(r,0)).rejects.toThrow('RECEIPT_AMOUNT_REQUIRED');
 await f.review(r,9700);expect((await f.order()).body).toMatchObject({sale_definition:'receipt_sales_v1',sale_amount_minor:9700,reconciliation_status:'UNRECONCILED'});
 expect((await f.fulfillments()).map(r=>r.body.asset_id)).toEqual([f.assets.core!.id,f.assets.calendar!.id]);
 const extra=await f.receipt();await f.review(extra,1000,{payment_key:'additional-1'});
 expect((await f.order()).body.sale_amount_minor).toBe(10700);expect((await f.fulfillments()).map(r=>r.body.asset_id)).toEqual([f.assets.core!.id,f.assets.calendar!.id,f.assets.kit!.id]);
 await f.review(extra,1000,{payment_key:'additional-1'});expect(await f.fulfillments()).toHaveLength(3);
 const duplicate=await record('receipt',{...r.body,status:'HUMAN_REVIEW'});await expect(f.review(duplicate)).rejects.toThrow('DUPLICATE_PAYMENT_EVIDENCE');
 const count=await f.fulfillments();await f.review(r,9600);expect((await f.order()).body.sale_amount_minor).toBe(10600);expect(await f.fulfillments()).toHaveLength(count.length);
 await f.command('receipt_classification',r.id,{expected_version:(await getRecord(pool,workspace,'receipt',r.id))!.version,classification:'FALSE',reason:'Synthetic false evidence'});
 expect((await f.order()).body.sale_amount_minor).toBe(1000);
 await f.command('receipt_classification',r.id,{expected_version:(await getRecord(pool,workspace,'receipt',r.id))!.version,classification:'GENUINE',reason:'Synthetic restored evidence'});
 expect((await f.order()).body.sale_amount_minor).toBe(10600);expect(await f.fulfillments()).toHaveLength(3);
});
it('keeps test orders out of recognized revenue and benefits; rejected receipt contributes nothing',async()=>{
 const f=await fixture();await f.commit();const r=await f.receipt();await f.review(r,9700,{decision:'REJECTED'});expect((await f.order()).body.sale_amount_minor).toBe(0);expect(await f.fulfillments()).toHaveLength(1);
 await f.command('order_classification',(await f.order()).id,{expected_version:(await f.order()).version,classification:'TEST',reason:'Synthetic test operation'});
 await f.review(r);expect((await f.order()).body).toMatchObject({sale_amount_minor:0,sale_status:'TEST'});expect(await f.fulfillments()).toHaveLength(1);
});
it('repairs old SENT aggregation, requires ACK for delivery/read, leaves portal access unverified',async()=>{
 const f=await fixture();await f.commit();await f.review(await f.receipt(),10700);
 await pool.query("UPDATE outbox SET status='SENT',provider_message_id=id::text WHERE conversation_id=$1",[f.conversation.id]);
 await pool.query("UPDATE records SET body=body||'{\"fulfillment_status\":\"DELIVERED\"}'::jsonb,version=version+1 WHERE id=$1",[(await f.order()).id]);
 await materializeEffectResults(1000);expect((await f.order()).body.fulfillment_status).toBe('SENT');
 const all=await f.fulfillments();expect(all.filter(r=>r.body.asset_id!==f.assets.calendar!.id).every(r=>r.body.access_verification_status==='UNVERIFIED')).toBe(true);
 const ack=async(effectId:string,status:string)=>{await appendEvent(pool,{workspace_id:workspace,environment:'SIMULATION',event_type:'provider.ack.observed',aggregate_id:f.account.id,payload:{provider_message_id:effectId,status,canonical_key:randomUUID(),provider_at:new Date().toISOString(),envelope_id:randomUUID()}});await consumeProviderObservations(1000);await materializeEffectResults(1000);};
 await ack(all[0]!.body.effect_id,'DELIVERED');expect((await f.order()).body.fulfillment_status).toBe('SENT');
 for(const row of all)await ack(row.body.effect_id,'DELIVERED');expect((await f.order()).body.fulfillment_status).toBe('DELIVERED');
 for(const row of all)await ack(row.body.effect_id,'READ');expect((await f.order()).body.fulfillment_status).toBe('READ');
 await ack(all[0]!.body.effect_id,'SENT');expect((await f.order()).body.fulfillment_status).toBe('READ');
 expect((await f.fulfillments()).filter(r=>r.body.asset_id!==f.assets.calendar!.id).every(r=>r.body.access_verification_status==='UNVERIFIED')).toBe(true);
 await pool.query("UPDATE outbox SET status='UNKNOWN' WHERE id=$1",[all[0]!.body.effect_id]);await ack(all[0]!.body.effect_id,'READ');expect((await f.order()).body.fulfillment_status).toBe('UNKNOWN');
 const before=(await f.order()).version;await materializeEffectResults(1000);expect((await f.order()).version).toBe(before);
});
