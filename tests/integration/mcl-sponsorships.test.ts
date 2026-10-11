import {afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {pool,putRecord,getRecord,withTransaction,hash} from '../../packages/db/src/index.js';
import type {Body} from '../../packages/contracts/src/index.js';
import {ensureOrder} from '../../apps/automation-worker/src/workflows.js';
import {applyCommand} from '../../apps/automation-worker/src/commands.js';
import {approvedBenefitTotal,launchEffectBlockReason} from '../../packages/db/src/launch-test-scope.js';

const workspace='mcl-sponsorship-'+randomUUID();
afterAll(async()=>pool.end());
const record=(kind:string,body:Body)=>putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind,body});
async function fixture(test=false){
 const core=await record('asset',{name:'Synthetic Core',kind:'link',url:'https://example.invalid/synthetic-core',status:'READY'});
 const calendar=await record('asset',{name:'Synthetic calendar',kind:'file',mime_type:'application/pdf',status:'READY',storage_key:randomUUID(),sha256:hash(randomUUID())});
 const kit=await record('asset',{name:'Synthetic Kit',kind:'link',url:'https://example.invalid/synthetic-kit',status:'READY'});
 const product=await record('product',{name:'Synthetic nine grades'});
 const flow=await record('workflow',{name:'Synthetic end',status:'PUBLISHED',entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]});
 const offer=await record('offer',{name:'Synthetic 97/107/>107',status:'PUBLISHED',product_id:product.id,currency:'MXN',base_amount_minor:9700,workflow_version_id:flow.id,madrina:{enabled:true,core_asset_id:core.id,threshold_exclusive_minor:10700,historical_reference_minor:19400},fulfillment:[{asset_id:core.id,release_on:'commitment_accepted'},{asset_id:calendar.id,release_on:'receipt_approved',min_amount_minor:1},{asset_id:kit.id,release_on:'receipt_approved',min_amount_minor:10700}]});
 const account=await record('channel_account',{name:'Synthetic test channel',provider:'simulator',status:'WORKING',offer_version_id:offer.id,workflow_version_id:flow.id});
 const buyer=await record('contact',{name:'Synthetic sponsor',identity:'opaque:'+randomUUID()});
 let scope:any;
 if(test)scope=(await pool.query(`INSERT INTO mcl_test_scopes(workspace_id,environment,account_id,offer_version_id,participants,purpose,actor_id,expires_at) VALUES($1,'SIMULATION',$2,$3,$4,'Synthetic own phone rehearsal','fixture',now()+interval '1 day') RETURNING *`,[workspace,account.id,offer.id,JSON.stringify([{contact_id:buyer.id,role:'buyer'}])])).rows[0];
 const conversation=async(contact:{id:string})=>record('conversation',{contact_id:contact.id,account_id:account.id,offer_version_id:offer.id,workflow_version_id:flow.id,status:'OPEN',stage:'NEW',last_inbound_at:new Date().toISOString(),flow_state:{status:'FINISHED',node_id:'end',variables:{}}});
 const sponsor=await conversation(buyer);
 const order=(await withTransaction(c=>ensureOrder(c,sponsor)))!;
 const currentOrder=async()=>(await getRecord(pool,workspace,'order',order.id))!;
 const sponsorship=async()=>(await pool.query('SELECT * FROM mcl_sponsorships WHERE order_id=$1',[order.id])).rows[0];
 const command=(kind:string,resource_id:string,payload:Body)=>withTransaction(c=>applyCommand(c,{id:randomUUID(),workspace_id:workspace,environment:'SIMULATION',kind,resource_id,actor_id:'synthetic-human',payload}));
 const receipt=async(amount:number,key='primary')=>{
  const asset=await record('asset',{name:'LABORATORIO SIN VALOR COMERCIAL',kind:'file',status:'READY',storage_key:randomUUID(),sha256:hash(randomUUID())});
  const r=await record('receipt',{order_id:order.id,conversation_id:sponsor.id,asset_id:asset.id,status:'HUMAN_REVIEW'});
  await command('receipt_review',r.id,{expected_version:r.version,decision:'APPROVED',amount_minor:amount,currency:'MXN',payment_key:key,reason:'Synthetic human review'});return r;
 };
 return{core,calendar,kit,account,buyer,offer,sponsor,scope,order,currentOrder,sponsorship,command,receipt};
}
it.each([96,97,106.99,107,107.01,108,194,1000])('credits total %s with generic tier and zero third-party obligations',async amount=>{
 const f=await fixture();await f.receipt(Math.round(amount*100));const order=await f.currentOrder();expect(order.body.sale_amount_minor).toBe(Math.round(amount*100));expect(order.body.credited_tier).toBe(amount>107?'madrina':amount>=107?'kit':amount>=97?'acuerdo':null);expect(order.body.payment_extra_minor).toBe(Math.max(0,Math.round(amount*100)-10700));expect(await f.sponsorship()).toBeUndefined();
 const fulfilled=(await pool.query("SELECT body->>'asset_id' id FROM records WHERE workspace_id=$1 AND kind='fulfillment' AND body->>'order_id'=$2",[workspace,f.order.id])).rows.map(r=>r.id);expect(fulfilled).toContain(f.calendar.id);expect(fulfilled.includes(f.kit.id)).toBe(amount>=107);
 expect((await pool.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND (payload ? 'sponsorship_id' OR payload->>'purpose' IN('sponsorship','sponsorship_notice'))",[workspace])).rows[0].n).toBe(0);
});
it('accumulates partials 97+10+0.01 once, dedupes reviews and credits Madrina at the exact cent',async()=>{const f=await fixture();await expect(f.receipt(0)).rejects.toThrow('RECEIPT_AMOUNT_REQUIRED');await f.receipt(9700);await f.receipt(1000,'topup');expect((await f.currentOrder()).body.credited_tier).toBe('kit');const cent=await f.receipt(1,'cent');await f.command('receipt_review',cent.id,{expected_version:(await getRecord(pool,workspace,'receipt',cent.id))!.version,decision:'APPROVED',amount_minor:1,currency:'MXN',reason:'Same receipt re-reviewed'});expect((await f.currentOrder()).body).toMatchObject({credited_tier:'madrina',sale_amount_minor:10701,payment_extra_minor:1});expect((await pool.query('SELECT count(*)::int n FROM payment_contributions WHERE order_id=$1',[f.order.id])).rows[0].n).toBe(3);expect(await f.sponsorship()).toBeUndefined();});
it('reverses FALSE receipts and restores the same contribution without duplicating totals or effects',async()=>{const f=await fixture(),receipt=await f.receipt(10800);const before=(await pool.query('SELECT count(*)::int n FROM outbox WHERE conversation_id=$1',[f.sponsor.id])).rows[0].n;await f.command('receipt_classification',receipt.id,{expected_version:(await getRecord(pool,workspace,'receipt',receipt.id))!.version,classification:'FALSE',reason:'Synthetic false evidence'});expect((await f.currentOrder()).body).toMatchObject({credited_tier:null,sale_amount_minor:0,payment_extra_minor:0});await f.command('receipt_classification',receipt.id,{expected_version:(await getRecord(pool,workspace,'receipt',receipt.id))!.version,classification:'GENUINE',reason:'Synthetic restored evidence'});expect((await f.currentOrder()).body).toMatchObject({credited_tier:'madrina',sale_amount_minor:10800});expect((await pool.query('SELECT count(*)::int n FROM payment_contributions WHERE order_id=$1',[f.order.id])).rows[0].n).toBe(1);expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE conversation_id=$1',[f.sponsor.id])).rows[0].n).toBe(before);expect(await f.sponsorship()).toBeUndefined();});
it('rehearses with one buyer, excluding TEST income while showing its credited tier',async()=>{const f=await fixture(true);expect(f.scope.participants).toHaveLength(1);await f.receipt(10800);const order=await f.currentOrder();expect(order.body).toMatchObject({commercial_classification:'TEST',sale_status:'TEST',sale_amount_minor:0,test_approved_amount_minor:10800,credited_tier:'madrina'});expect(await approvedBenefitTotal(pool,order)).toBe(10800);expect(await f.sponsorship()).toBeUndefined();await expect(f.command('order_classification',order.id,{expected_version:order.version,classification:'COMMERCIAL',reason:'Synthetic forbidden promotion'})).rejects.toThrow('LAUNCH_TEST_CLASSIFICATION_IMMUTABLE');await pool.query('UPDATE mcl_test_scopes SET revoked_at=now() WHERE id=$1',[f.scope.id]);expect(await launchEffectBlockReason(pool,f.sponsor,{})).toBe('LAUNCH_TEST_SCOPE_INACTIVE');});
it('blocks queued/old sponsorship commands and direct historical callers',async()=>{const f=await fixture();await expect(f.command('mcl_sponsorship',randomUUID(),{action:'deliver'})).rejects.toThrow('SPONSORSHIP_RETIRED');expect(await launchEffectBlockReason(pool,f.sponsor,{purpose:'sponsorship_notice'})).toBe('SPONSORSHIP_RETIRED');await expect(pool.query('INSERT INTO mcl_sponsorships DEFAULT VALUES')).rejects.toThrow('SPONSORSHIP_RETIRED');});
