import {explicitFixtureEnvironment} from './explicit-fixture-environment.js';
import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
import {disposeAllFixtureProfiles} from '../support/migrated-database.js';
import {randomUUID,randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord,getRecord,withTransaction,hash} from '../../packages/db/src/index.js';
import {processCommands,applyReceiptAnalysis} from '../../apps/automation-worker/src/commands.js';
import {ensureOrder} from '../../apps/automation-worker/src/workflows.js';
import {firstObservedAttribution} from '../../packages/db/src/receipt-sales.js';
import {persistInsightAccount,executeInsightJob} from '../../apps/automation-worker/src/meta-insights.js';
import {saveIntegrationSetting} from '../../packages/db/src/integration-settings.js';
import {proposeEffect} from '../../apps/automation-worker/src/shared.js';
import {campaignPerformance,campaignSales,campaignFilterSchema} from '../../apps/api/src/campaign-performance.js';
import {enqueueCommand} from '../support/commands.js';
import type {Body,DomainRecord} from '../../packages/contracts/src/index.js';
let app:FastifyInstance,w:string,cookie:string;let loginIp=1;const origin=(process.env.TRUSTED_ORIGINS??'http://127.0.0.1:5173').split(',')[0]!,day='2026-09-06';
beforeAll(async()=>{app=await createApp();});afterAll(async()=>{await app.close();await pool.end();});
async function login(role='owner',workspace=w){const email=randomUUID()+'@commerce.test',password=randomBytes(24).toString('base64url');await provisionUser({email,password,name:'Synthetic campaign reviewer',workspace_id:workspace,role:role as 'owner'});const r=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.24',headers:{origin,'x-forwarded-for':'192.0.2.'+(loginIp++)},payload:{email,password}});expect(r.statusCode).toBe(200);return(Array.isArray(r.headers['set-cookie'])?r.headers['set-cookie']:[r.headers['set-cookie']]).map(x=>String(x).split(';')[0]).join('; ');}
// V7 F2: each case starts from a fresh workspace; an installation admits three
// profiles, so the previous cases' fixture profiles are disposed first.
beforeEach(async()=>{await disposeAllFixtureProfiles(pool);w='campaign-'+randomUUID();cookie=await login();});
const call=(method:'GET'|'POST',url:string,payload?:Body,key=randomUUID(),auth=cookie)=>app.inject(explicitFixtureEnvironment({method,url,headers:{cookie:auth,origin,'idempotency-key':key},...(payload?{payload}:{})}));
async function applied(id:string){await processCommands(200);const r=(await pool.query('SELECT * FROM commands WHERE id=$1',[id])).rows[0];expect(r.status,JSON.stringify(r.result)).toBe('APPLIED');return r.result;}
const record=(kind:string,body:Body)=>putRecord(pool,{workspaceId:w,environment:'SIMULATION',kind,body});
async function fixture(amount=9700,auto=false,ad=true,product?:DomainRecord){
 const p=product??await record('product',{name:'Product '+randomUUID().slice(0,5)}),policy=await record('receipt_policy',{name:'Synthetic receipt policy',auto_approve:auto,allow_amount_mismatch:true});
 const offer=await record('offer',{name:'Synthetic offer',product_id:p.id,currency:'MXN',base_amount_minor:9900,receipt_policy_version_id:policy.id,fulfillment:[]});
 const conv=await record('conversation',{offer_version_id:offer.id,product_id:p.id,status:'OPEN',flow_state:{status:'FINISHED'},started_at:'2026-07-01T12:00:00Z'});
 if(ad)await record('touchpoint',{conversation_id:conv.id,classification:'observed',referral:{source_id:'55',source_type:'ad'},evidence_ref:'synthetic-provider-event',occurred_at:'2026-07-01T12:00:00Z'});
 const order=await withTransaction(c=>ensureOrder(c,conv));expect(order).toBeTruthy();
 const asset=await record('asset',{name:'Synthetic receipt',status:'READY',kind:'file',storage_key:randomUUID(),sha256:hash(randomUUID())});
 const receipt=await record('receipt',{order_id:order!.id,conversation_id:conv.id,asset_id:asset.id,status:'HUMAN_REVIEW',analysis_status:'HUMAN_REQUIRED',received_at:'2026-09-06T12:00:00Z',extraction:{is_receipt:true,amount_minor:amount,currency:'MXN',destination_suffix:null,bank:null,reference:randomUUID(),status:'completed',confidence:.99,contradictions:[]}});
 return{p,offer,conv,order:order!,asset,receipt};
}
// V7 F8-D: the durable commands the retired V5 review/classification routes
// inserted, and the report function /v2/campaigns reads, called directly.
const actor='synthetic-reviewer';
const enqueue=(kind:string,resourceId:string,payload:Body)=>withTransaction(c=>enqueueCommand(c,{workspace:w,environment:'SIMULATION',kind,resourceId,actorId:actor,payload}));
const commandRow=async(id:string)=>(await pool.query('SELECT * FROM commands WHERE id=$1',[id])).rows[0];
async function review(r:DomainRecord,extra:Body={}){const current=(await getRecord(pool,w,'receipt',r.id))!;return applied((await enqueue('receipt_review',r.id,{decision:'APPROVED',reason:'Synthetic accepted document',expected_version:current.version,...extra})).id);}
async function classify(kind:'orders'|'receipts',id:string,classification:string){const r=(await getRecord(pool,w,kind==='orders'?'order':'receipt',id))!;await applied((await enqueue(kind==='orders'?'order_classification':'receipt_classification',id,{expected_version:r.version,classification,reason:'Synthetic classification correction'})).id);}
async function spend(product:DomainRecord,amount=10000){const job=(await pool.query("INSERT INTO meta_insight_jobs(workspace_id,environment,actor_id,request,status) VALUES($1,'SIMULATION','fixture',$2,'SYNCED') RETURNING *",[w,{from:day,to:day}])).rows[0];const a={id:'act_123',name:'Synthetic ad account',currency:'MXN',timezone_name:'America/Mexico_City'};const row={day,level:'ad',entity_id:'55',campaign_id:'44',ad_set_id:'66',name:'Synthetic ad',campaign_name:'Campaign A',currency:'MXN',timezone:a.timezone_name,spend_minor:amount,impressions:1000,clicks:20,conversations:10,action_type:'onsite_conversion.messaging_conversation_started_7d'};await withTransaction(c=>persistInsightAccount(c,job,a,[row,{...row,level:'campaign',entity_id:'44'}],[{id:'55',name:'Synthetic ad',campaign_id:'44',adset_id:'66',campaign:{name:'Campaign A'}}]));await pool.query("INSERT INTO campaign_products(workspace_id,environment,meta_ad_account_id,entity_type,entity_id,product_id,valid_from,actor_id,reason,revision) VALUES($1,'SIMULATION','act_123','campaign','44',$2,$3,$4,'Synthetic promoted product',1)",[w,product.id,day,actor]);return{job,a,row};}
async function periodReceipts(){await pool.query("UPDATE payment_contributions SET effective_at='2026-09-06T12:00:00Z' WHERE workspace_id=$1",[w]);}
const filters=(extra='',environment='SIMULATION')=>campaignFilterSchema.parse({environment,from:day,to:day,...Object.fromEntries(new URLSearchParams(extra))});
const report=(extra='',environment='SIMULATION')=>withTransaction(async c=>{await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');return campaignPerformance(c,w,environment,filters(extra,environment));}) as Promise<Body>;
describe('Receipt → sale → campaign performance in PostgreSQL',()=>{
 it('matches $100 / $204, excludes TEST/FALSE, restores without double effects, and corrects the original period',async()=>{
  const a=await fixture(),b=await fixture(10700,true),test=await fixture(5000);await spend(a.p);await classify('orders',test.order.id,'TEST');
  await review(a.receipt);await withTransaction(c=>applyReceiptAnalysis(c,b.receipt,b.receipt.body.extraction,randomUUID()));await review(test.receipt);await periodReceipts();
  let result=await report();expect(result.summary).toMatchObject({spend_minor:10000,revenue_minor:20400,sales:2,cpa_minor:5000,roas:2.04,balance_minor:10400});expect(result.quality.controls.find((c:Body)=>c.classification==='TEST').orders).toBe(1);
  const before=(await pool.query('SELECT count(*) FROM outbox WHERE workspace_id=$1',[w])).rows[0].count;
  await classify('receipts',a.receipt.id,'FALSE');result=await report();expect(result.summary).toMatchObject({spend_minor:10000,revenue_minor:10700,sales:1,cpa_minor:10000,roas:1.07,balance_minor:700});
  await classify('receipts',a.receipt.id,'GENUINE');expect((await report()).summary).toMatchObject({revenue_minor:20400,sales:2,roas:2.04});
  await classify('orders',b.order.id,'TEST');expect((await report()).summary.revenue_minor).toBe(9700);await classify('orders',b.order.id,'COMMERCIAL');expect((await report()).summary.revenue_minor).toBe(20400);
  expect((await pool.query('SELECT count(*) FROM outbox WHERE workspace_id=$1',[w])).rows[0].count).toBe(before);expect((await getRecord(pool,w,'order',a.order.id))?.body.reconciliation_status).toBe('UNRECONCILED');
  const sales=(await campaignSales(pool,w,'SIMULATION',filters())).data;expect(sales).toHaveLength(2);expect(sales.reduce((s:number,r:Body)=>s+r.revenue_minor,0)).toBe(20400);
 });
 it('aggregates one shared product and offer across three numbers without counting approved documents twice',async()=>{
  const first=await fixture(9700,false,false),accounts=await Promise.all([1,2,3].map(i=>record('channel_account',{name:'Synthetic reporting number '+i,provider:'simulator'})));
  const contact=await record('contact',{name:'Synthetic shared reporting identity',identity:'opaque:reporting-fixture'});
  const fixtures=[first];
  for(let i=0;i<3;i++){
   const conv=i===0?await putRecord(pool,{id:first.conv.id,workspaceId:w,environment:'SIMULATION',kind:'conversation',version:first.conv.version,body:{...first.conv.body,account_id:accounts[i]!.id,contact_id:contact.id}}):await record('conversation',{...first.conv.body,account_id:accounts[i]!.id,contact_id:contact.id});
   if(i===0){await putRecord(pool,{id:first.order.id,workspaceId:w,environment:'SIMULATION',kind:'order',version:first.order.version,body:{...first.order.body,account_id:accounts[i]!.id,contact_id:contact.id}});continue;}
   const order=(await withTransaction(c=>ensureOrder(c,conv)))!,asset=await record('asset',{name:'Synthetic reporting receipt',status:'READY',kind:'file',storage_key:randomUUID(),sha256:hash(randomUUID())});
   const receipt=await record('receipt',{...first.receipt.body,order_id:order.id,conversation_id:conv.id,asset_id:asset.id,extraction:{...first.receipt.body.extraction,amount_minor:i===1?10700:12000,reference:randomUUID()}});fixtures.push({...first,conv,order,asset,receipt});
  }
  for(const f of fixtures){await review(f.receipt);await review(f.receipt);}
  const byAccount=(await pool.query(`SELECT o.body->>'account_id' account_id,count(*)::int sales,sum(pc.amount_minor)::int revenue FROM payment_contributions pc JOIN records o ON o.id=pc.order_id WHERE pc.workspace_id=$1 GROUP BY 1 ORDER BY 1`,[w])).rows;
  expect(byAccount).toHaveLength(3);expect(byAccount.every(r=>r.sales===1)).toBe(true);expect(byAccount.reduce((s,r)=>s+r.revenue,0)).toBe(32400);
  expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind='product'",[w])).rows[0].n).toBe(1);expect((await pool.query('SELECT count(*)::int n FROM payment_contributions WHERE workspace_id=$1',[w])).rows[0].n).toBe(3);
 });
 it('requires positive evidence money, permits explicit additional payments and serializes corrections',async()=>{
  const f=await fixture(0);const cmd=await enqueue('receipt_review',f.receipt.id,{decision:'APPROVED',expected_version:f.receipt.version,reason:'Missing amount'});await processCommands();expect((await commandRow(cmd.id)).result.error).toBe('RECEIPT_AMOUNT_REQUIRED');
  await review(f.receipt,{amount_minor:9700});const second=await record('receipt',{...f.receipt.body,asset_id:(await record('asset',{status:'READY',storage_key:randomUUID(),sha256:hash(randomUUID())})).id});
  await review(second,{amount_minor:1000,payment_key:'additional-1'});await periodReceipts();expect((await report()).summary).toMatchObject({sales:1,revenue_minor:10700,spend_minor:null});
  const current=(await getRecord(pool,w,'receipt',f.receipt.id))!;const correction=await enqueue('receipt_review',f.receipt.id,{expected_version:current.version,decision:'APPROVED',amount_minor:9900,reason:'Correct accepted amount'});const excluded=await enqueue('receipt_classification',f.receipt.id,{classification:'FALSE',expected_version:current.version,reason:'Concurrent classification'});await processCommands();expect((await commandRow(excluded.id)).result.error).toBe('VERSION_CONFLICT');
  expect((await commandRow(correction.id)).status).toBe('APPLIED');expect((await report()).summary.revenue_minor).toBe(10900); // queued correction won; stale classification fails
 });
 it('preserves the evidence ledger when an alternative document replaces a payment',async()=>{
  const f=await fixture();await review(f.receipt);await periodReceipts();
  const replacement=await record('receipt',{...f.receipt.body,asset_id:(await record('asset',{status:'READY',storage_key:randomUUID(),sha256:hash(randomUUID())})).id});
  await review(replacement,{amount_minor:9900,replaces_receipt_id:f.receipt.id});expect((await report()).summary).toMatchObject({sales:1,revenue_minor:9900});
  const other=await fixture();const duplicate=await record('receipt',{...other.receipt.body,asset_id:f.asset.id});const command=await enqueue('receipt_review',duplicate.id,{decision:'APPROVED',expected_version:duplicate.version,reason:'Old superseded image replay'});await processCommands();expect((await commandRow(command.id)).result.error).toBe('DUPLICATE_PAYMENT_EVIDENCE');
 });
 it('preserves product cross-sales, unknown/post IDs and late ads without duplicating cost',async()=>{
  const promoted=await record('product',{name:'Promoted A'}),b=await fixture(10700),unknown=await fixture(9700,false,false);await spend(promoted);await review(b.receipt);await review(unknown.receipt);await periodReceipts();
  const all=await report();expect(all.summary.revenue_minor).toBe(20400);expect(all.summary.attributed_revenue_minor).toBe(10700);expect(all.summary.roas).toBe(1.07);expect(all.quality.unattributed.sales).toBe(1);
  expect((await report('&product_id='+promoted.id)).summary).toMatchObject({spend_minor:10000,revenue_minor:10700,sales:1});
  const sold=(await campaignSales(pool,w,'SIMULATION',filters('sold_product_id='+b.p.id))).data;expect(sold[0]).toMatchObject({sold_product_id:b.p.id,promoted_product_id:promoted.id,campaign_id:'44'});
  const post=await fixture();const touches=(await pool.query("SELECT * FROM records WHERE workspace_id=$1 AND kind='touchpoint' AND body->>'conversation_id'=$2",[w,post.conv.id])).rows;await putRecord(pool,{workspaceId:w,environment:'SIMULATION',kind:'touchpoint',id:touches[0].id,version:touches[0].version,body:{...touches[0].body,referral:{source_type:'post',source_id:'55'}}});expect((await firstObservedAttribution(pool,post.order)).classification).toBe('unknown');
 });
 it('makes snapshots idempotent, separates currencies/timezones and preserves last valid data on account failure',async()=>{
  const f=await fixture();const s=await spend(f.p);await withTransaction(c=>persistInsightAccount(c,s.job,s.a,[s.row,{...s.row,level:'campaign',entity_id:'44'}],[]));expect((await report()).summary.spend_minor).toBe(10000);expect((await report()).summary.roas).toBe(0);
  await pool.query("UPDATE meta_insight_accounts SET status='UNAVAILABLE',last_success_at=now()-interval '2 hours' WHERE workspace_id=$1",[w]);const partial=await report();expect(partial.quality.status).toBe('PARTIAL');expect(partial.summary.spend_minor).toBe(10000);
  expect((await report('&cost_basis=estimated_tax')).summary.spend_minor).toBeNull();
  await pool.query("UPDATE meta_insight_accounts SET timezone='America/New_York' WHERE workspace_id=$1",[w]);expect((await report()).summary.roas).toBeNull();expect((await report('&currency=USD')).summary.spend_minor).toBeNull();
 });
 it('isolates workspaces and environments; viewers read orders only within their profile',async()=>{
  const f=await fixture();await spend(f.p);const viewer=await login('viewer'),other=await login('owner','other-'+randomUUID());
  expect((await call('GET',`/v1/orders/${f.order.id}`,undefined,randomUUID(),viewer)).statusCode).toBe(200);
  expect((await call('GET',`/v1/orders/${f.order.id}`,undefined,randomUUID(),other)).statusCode).toBe(404);expect((await report('','REAL')).summary.sales).toBe(0);
 });
 it('unblocks legacy reconcile waits, cancels collections and never redelivers on restoration or a duplicate document',async()=>{
  const f=await fixture(10700),account=await record('channel_account',{name:'Synthetic account',provider:'simulator'}),contact=await record('contact',{name:'Synthetic customer',identity:'opaque:synthetic'}),bonus=await record('asset',{name:'Synthetic bonus',kind:'link',status:'READY',url:'https://example.com/fixture'});
  const workflow=await record('workflow',{name:'Legacy sealed flow',status:'PUBLISHED',entry_node_id:'receipt',nodes:[{id:'receipt',type:'receipt',config:{},next:'reconcile'},{id:'reconcile',type:'reconcile',config:{},next:'bonus'},{id:'bonus',type:'fulfillment',config:{release_on:'reconciled'},next:'end'},{id:'end',type:'end',config:{}}]});
  const conv=await putRecord(pool,{id:f.conv.id,workspaceId:w,environment:'SIMULATION',kind:'conversation',version:f.conv.version,body:{...f.conv.body,account_id:account.id,contact_id:contact.id,workflow_version_id:workflow.id,flow_state:{status:'WAITING',waiting_for:'reconciled',node_id:'bonus',steps:2,variables:{},stack:[]}}});
  await putRecord(pool,{id:f.order.id,workspaceId:w,environment:'SIMULATION',kind:'order',version:f.order.version,body:{...f.order.body,offer_snapshot:{...f.order.body.offer_snapshot,fulfillment:[{asset_id:bonus.id,release_on:'reconciled',min_amount_minor:10700}]}}});
  await withTransaction(c=>proposeEffect(c,conv,{kind:'text',text:'Synthetic pending collection',purpose:'collection'},randomUUID()));
  await pool.query("INSERT INTO timers(workspace_id,environment,conversation_id,kind,payload,due_at,logical_key) VALUES($1,'SIMULATION',$2,'followup','{}',now()+interval '1 day',$3)",[w,conv.id,randomUUID()]);
  await review(f.receipt);expect((await getRecord(pool,w,'conversation',conv.id))?.body.flow_state.status).toBe('FINISHED');expect((await getRecord(pool,w,'order',f.order.id))?.body.reconciliation_status).toBe('UNRECONCILED');
  const before=(await pool.query('SELECT count(*) FROM outbox WHERE workspace_id=$1',[w])).rows[0].count;
  expect((await pool.query("SELECT status FROM timers WHERE workspace_id=$1",[w])).rows[0].status).toBe('CANCELLED');expect((await pool.query("SELECT status FROM outbox WHERE workspace_id=$1 AND payload->>'purpose'='collection'",[w])).rows[0].status).toBe('CANCELLED');
  await classify('receipts',f.receipt.id,'FALSE');await classify('receipts',f.receipt.id,'GENUINE');await review(f.receipt);expect((await pool.query('SELECT count(*) FROM outbox WHERE workspace_id=$1',[w])).rows[0].count).toBe(before);
  const duplicate=await record('receipt',{...f.receipt.body,duplicate_of:f.receipt.id});const cmd=await enqueue('receipt_review',duplicate.id,{decision:'APPROVED',reason:'Duplicate image',expected_version:duplicate.version});await processCommands();expect((await commandRow(cmd.id)).result.error).toBe('DUPLICATE_PAYMENT_EVIDENCE');
  expect((await pool.query("SELECT count(*) FROM records WHERE workspace_id=$1 AND kind='fulfillment'",[w])).rows[0].count).toBe('1');
 });
 it('reads official GET fixtures through durable account persistence and keeps successful accounts on a partial failure',async()=>{
  await withTransaction(c=>saveIntegrationSetting(c,w,'REAL','meta:fixture',{expected_version:0,label:'Synthetic reader',enabled:true,config:{},secrets:{access_token:'synthetic-insights-token'},clear_secrets:[],reason:'Synthetic GET-only contract'},'fixture'));
  const lease=randomUUID(),job=(await pool.query("INSERT INTO meta_insight_jobs(workspace_id,environment,actor_id,request,status,lease_token) VALUES($1,'REAL','fixture',$2,'RUNNING',$3) RETURNING *",[w,{from:day,to:day,recurring:false},lease])).rows[0];const paths:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{expect(init?.method).toBe('GET');const url=new URL(String(input));paths.push(url.pathname);if(url.pathname.endsWith('/me/adaccounts'))return Response.json({data:[{id:'act_123',name:'Fixture A',currency:'MXN',timezone_name:'America/Mexico_City'},{id:'act_456',name:'Fixture B',currency:'USD',timezone_name:'America/New_York'}]});if(url.pathname.includes('act_456'))return Response.json({error:{code:200}},{status:403});if(url.pathname.endsWith('/ads'))return Response.json({data:[{id:'55',name:'Ad paused, late sales supported',campaign_id:'44',adset_id:'66',campaign:{name:'Fixture campaign'}}]});expect(url.searchParams.get('time_increment')).toBe('1');return Response.json({data:[{account_id:'123',account_currency:'MXN',date_start:day,date_stop:day,campaign_id:'44',campaign_name:'Fixture campaign',ad_id:'55',ad_name:'Fixture ad',adset_id:'66',spend:'100.00',impressions:'500',clicks:'8'}]});};
  const result=await executeInsightJob(job,fetcher);expect(result).toMatchObject({status:'PARTIAL',succeeded:1,external_mutations:0});expect(result.issues[0]?.code).toBe('META_PERMISSION_DENIED');expect((await pool.query('SELECT sum(spend_minor)::text n FROM meta_insight_days WHERE workspace_id=$1 AND level=\'ad\'',[w])).rows[0].n).toBe('10000');
  await executeInsightJob(job,fetcher);expect((await pool.query('SELECT count(*)::int n FROM meta_insight_days WHERE workspace_id=$1',[w])).rows[0].n).toBe(2);expect(paths.every(p=>/adaccounts|insights|ads/.test(p))).toBe(true);
  await withTransaction(async c=>{await c.query('SET LOCAL ROLE commerce_automation');expect((await c.query('SELECT count(*)::int n FROM integration_secrets WHERE workspace_id=$1 AND type=\'meta\'',[w])).rows[0].n).toBe(1);});
 });
 it('refuses Meta external reads in simulation',async()=>{let calls=0;await expect(executeInsightJob({environment:'SIMULATION'},async()=>{calls++;throw Error();})).rejects.toThrow('META_REAL_ENVIRONMENT_REQUIRED');expect(calls).toBe(0);});
});
