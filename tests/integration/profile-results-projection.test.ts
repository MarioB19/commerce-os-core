/** PostgreSQL projection proof. AI ledger is an explicit contract fixture here;
 * the combined 019/020 suite must verify the actual ledger/RLS before mounting. */
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {fixtureProfileRow,openMigratedDatabase,isolatedAdminUrl} from '../support/migrated-database.js';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from '../../packages/db/src/profile-context.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {readResultFacts,readResultSpend,observedResultsReport as resultsReport} from '../../packages/db/src/results.js';
import {resultOptions} from '../../packages/db/src/result-options.js';
import {summarizeResults} from '../../packages/domain/src/sales/results.js';
import {resultFiltersSchema} from '../../packages/contracts/src/results.js';
// V7 F2: an installation admits three profiles and 20 numbers; each fresh
// fixture profile is sealed and the oldest are disposed to make room.
const createdProfiles:string[]=[];
const suffix=randomBytes(8).toString('hex'),login='results_'+suffix;let admin:pg.Pool,api:pg.Pool,scoped:ProfilePool,serial=0,closeDatabase:(()=>Promise<void>)|undefined;
const day='2026-10-10',started='2026-10-10T16:00:00.000Z',response='2026-10-10T16:00:30.000Z',paid='2026-10-10T17:00:00.000Z';
const query=resultFiltersSchema.parse({from:day,to:day,currency:'MXN'});
function tx<T>(w:string,work:(db:ProfileExecutor)=>Promise<T>){return withProfileTransaction(scoped,w,work);}
async function profile(timezone='America/Mexico_City'){return fixtureProfileRow(admin,createdProfiles,'results_'+suffix+'_'+(++serial),{businessName:'Synthetic Results',timezone,numbers:6,products:20,daily:100});}
async function rec(w:string,kind:string,body:Record<string,unknown>,environment='REAL'){const id=randomUUID();await admin.query('INSERT INTO records(id,workspace_id,environment,kind,body,created_at) VALUES($1,$2,$3,$4,$5,$6)',[id,w,environment,kind,body,started]);return id;}
async function journey(w:string,patch:Record<string,unknown>={},environment='REAL'){
 const family=await rec(w,'product',{name:'Synthetic product'},environment),account=await rec(w,'channel_account',{provider:'simulator'},environment),offer=await rec(w,'offer',{currency:'MXN',product_id:family},environment);
 const conversation=await rec(w,'conversation',{started_at:started,account_id:account,product_id:family,offer_version_id:offer,origin:{classification:'observed',ad_id:'100',meta_ad_account_id:'act_1'},...patch},environment);
 const order=await rec(w,'order',{conversation_id:conversation,product_id:family,currency:'MXN',attribution:{classification:'observed',ad_id:'100',meta_ad_account_id:'act_1'}},environment);return{w,conversation,order,family,account,offer,environment};
}
type Journey=Awaited<ReturnType<typeof journey>>;
async function effect(j:Journey,purpose='offer',status='SENT',at=response){const id=randomUUID();await admin.query("INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,logical_key,kind,payload,config_hash,status,provider_message_id,result) VALUES($1,$2,$3,$4,$5,$6,$1::uuid::text,'message',$7,$8,$9,$10,$11)",[id,j.w,j.environment,j.account,j.conversation,randomUUID(),{kind:'text',purpose,text:'Synthetic non-customer text'},'a'.repeat(64),status,status==='SENT'?'synthetic-'+id:null,{accepted_at:at}]);return id;}
async function payment(j:Journey,amount='10000',at=paid,currency='MXN'){
 const receipt=await rec(j.w,'receipt',{order_id:j.order,conversation_id:j.conversation,status:'APPROVED',text:'synthetic'},j.environment),id=randomUUID();
 await admin.query('INSERT INTO payment_contributions(id,workspace_id,environment,order_id,receipt_id,payment_key,amount_minor,currency,currency_source,evidence_sha256,effective_at,provenance) VALUES($1,$2,$3,$4,$5,$1::uuid::text,$6,$7,$8,$9,$10,$11)',[id,j.w,j.environment,j.order,receipt,amount,currency,'SYNTHETIC_FIXTURE',randomBytes(32).toString('hex'),at,{}]);return{id,receipt};
}
async function metadata(w:string){await admin.query("INSERT INTO meta_ad_metadata(workspace_id,environment,meta_ad_account_id,ad_id,campaign_id,ad_name,campaign_name,source) VALUES($1,'REAL','act_1','100','10','Synthetic ad','Synthetic campaign','SYNTHETIC_FIXTURE')",[w]);}
async function meta(w:string,{complete=true,ad='2000',campaign='2000',conversations='2.5',timezone='America/Mexico_City'}={}){
 const job=randomUUID();await admin.query("INSERT INTO meta_insight_jobs(id,workspace_id,environment,actor_id,request,status) VALUES($1,$2,'REAL','synthetic','{}','COMPLETE')",[job,w]);
 await admin.query("INSERT INTO meta_insight_accounts(workspace_id,environment,meta_ad_account_id,name,currency,timezone,status) VALUES($1,'REAL','act_1','Synthetic','MXN',$2,'SYNCED')",[w,timezone]);
 for(const [level,id,spend]of [['ad','100',ad],['campaign','10',campaign]])await admin.query("INSERT INTO meta_insight_days(workspace_id,environment,meta_ad_account_id,day,level,entity_id,campaign_id,name,campaign_name,currency,timezone,spend_minor,conversations,job_id) VALUES($1,'REAL','act_1',$2,$3,$4,'10','Synthetic','Synthetic','MXN',$5,$6,$7,$8)",[w,day,level,id,timezone,spend,conversations,job]);
 if(complete)await admin.query("INSERT INTO meta_insight_coverage(workspace_id,environment,meta_ad_account_id,day,job_id) VALUES($1,'REAL','act_1',$2,$3)",[w,day,job]);
}
async function report(j:Journey,q=query){return tx(j.w,db=>resultsReport(db,q));}
async function ai(j:Journey,{cost='150',classification='OPERATION',intent=paid,status='SUCCEEDED'}:{cost?:string|null;classification?:string;intent?:string|null;status?:string}={}){await admin.query('INSERT INTO synthetic_result_ai_cost_facts(workspace_id,environment,conversation_id,provider,model,task,operation_class,occurred_at,status,measured_cost_microusd,input_tokens,output_tokens,intent_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,50,20,$11)',[j.w,j.environment,j.conversation,'synthetic','contract-only','seller',classification,paid,status,cost,intent]);}
describe('scoped SQL results projections against observed evidence',()=>{
 beforeAll(async()=>{
  // V7 F2: this projection contract reads the 017 result facts with a synthetic
  // AI cost view; it runs on a database migrated through 0081 (before the AI
  // admission migration that installs the real view) instead of applying sources.
  const database=await openMigratedDatabase('0081');admin=database.pool;closeDatabase=database.close;const url=new URL(database.url);
  await admin.query("INSERT INTO profile_quota_policy(singleton,max_profiles,max_numbers,daily_conversations,calendar_timezone,adoption_sha256) VALUES(true,3,20,300,'UTC',repeat('a',64))");
  
  await admin.query(`CREATE TABLE synthetic_result_ai_cost_facts(workspace_id text,environment text,conversation_id uuid,variant_id uuid,provider text,model text,task text,operation_class text,occurred_at timestamptz,status text,measured_cost_microusd bigint,input_tokens bigint,output_tokens bigint,cache_read_tokens bigint DEFAULT 0,cache_write_tokens bigint DEFAULT 0,audio_input_tokens bigint DEFAULT 0,intent_at timestamptz);
   CREATE VIEW result_ai_cost_facts WITH(security_invoker=true) AS SELECT * FROM synthetic_result_ai_cost_facts;
   GRANT SELECT ON result_ai_cost_facts,synthetic_result_ai_cost_facts TO commerce_api;`);
  const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;GRANT commerce_api TO "${login}"`);
  const native=new URL(url);native.username=login;native.password=secret;api=new pg.Pool({connectionString:native.toString(),max:3});scoped={async connect(){const c=await api.connect();try{await c.query('SET ROLE commerce_api');return{query:c.query.bind(c),release:()=>c.release()};}catch(e){c.release();throw e;}}};
 },60000);
 afterAll(async()=>{await api?.end();await closeDatabase?.();const parent=new pg.Pool({connectionString:isolatedAdminUrl().toString(),max:1});try{await parent.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await parent.end();}});
 it('projects only independently observed funnel milestones and latency',async()=>{
  const j=await journey(await profile());await effect(j);await effect(j,'collection');await payment(j);await metadata(j.w);const r=await report(j);
  expect(r.summary.funnel.map(s=>s.count)).toEqual(['1','1','1','1','1','1']);expect(r.summary.first_response_ms.value).toBe('30000.000000');expect(r.summary.first_sale_ms.value).toBe('3600000.000000');expect(r.summary.totals.revenue_minor).toBe('10000');
 });
 it('does not infer delivery, response or offer from a recognized sale',async()=>{
  const j=await journey(await profile());await effect(j,'offer','UNKNOWN');await payment(j);const r=await report(j);expect(r.summary.funnel.map(s=>s.count)).toEqual(['1','0','0','0','1','1']);expect(r.summary.first_response_ms.value).toBeNull();
 });
 it('excludes SIMULATION, TEST and foreign profiles even through the raw view',async()=>{
  const w=await profile(),j=await journey(w);await payment(j);await payment(await journey(w,{commercial_classification:'TEST'}));await payment(await journey(w,{},'SIMULATION'));
  const foreign=await journey(await profile());await payment(foreign);expect((await report(j)).summary.totals.revenue_minor).toBe('10000');
  expect(await tx(w,async db=>(await db.query('SELECT journey_id FROM result_journey_facts')).rows)).toEqual([{journey_id:j.conversation}]);
  await expect(tx(w,db=>readResultFacts({...db,workspaceId:foreign.w},query))).rejects.toThrow('RESULT_PROFILE_CONTEXT_REQUIRED');
 });
 it('counts an order once while later partial payments keep their activity dates',async()=>{
  const j=await journey(await profile());await payment(j,'9007199254740991');await payment(j,'9007199254740991','2026-10-11T17:00:00.000Z');
  const r=await report(j,{...query,to:'2026-10-11'});expect(r.summary.totals.revenue_minor).toBe('18014398509481982');expect(r.summary.totals.sales).toBe('1');expect(r.series[1]!.summary.totals.sales).toBe('0');
 });
 it('separates currencies and excludes a different-currency payment from cohort conversion',async()=>{
  const j=await journey(await profile());await payment(j,'100','2026-10-10T17:00:00.000Z','USD');const mx=await report(j);expect(mx.summary.totals.revenue_minor).toBe('0');expect(mx.summary.conversion.value).toBe('0.000000');
  const usd=await report(j,{...query,currency:'USD'});expect(usd.summary.totals.revenue_minor).toBe('100');expect(usd.summary.conversion.value).toBeNull();
 });
 it('reflects reviewed false receipts without deleting their contribution history',async()=>{
  const j=await journey(await profile()),p=await payment(j);expect((await report(j)).summary.totals.revenue_minor).toBe('10000');await admin.query("UPDATE records SET body=body||'{\"commercial_classification\":\"FALSE\"}',version=version+1 WHERE id=$1",[p.receipt]);expect((await report(j)).summary.totals.revenue_minor).toBe('0');expect((await admin.query('SELECT id FROM payment_contributions WHERE id=$1',[p.id])).rows).toHaveLength(1);
 });
 it('retains metrics when content is redacted and never uses updated_at as send time',async()=>{
  const j=await journey(await profile()),e=await effect(j);await payment(j);const before=(await report(j)).summary;
  await admin.query("UPDATE records SET body=(body-'last_customer_text')||'{\"content_redacted\":true}',version=version+1,updated_at=clock_timestamp() WHERE id=$1",[j.conversation]);await admin.query("UPDATE outbox SET payload=(payload-'text')||'{\"content_redacted\":true}',updated_at=clock_timestamp() WHERE id=$1",[e]);expect((await report(j)).summary).toEqual(before);
 });
 it('canonical retention preserves metrics, audit and repeat application without manual data redaction',async()=>{
  const j=await journey(await profile(),{last_customer_text:'Synthetic expired private payload'}),e=await effect(j);await payment(j);const before=(await report(j)).summary;
  const old=new Date(Date.now()-100*86400000).toISOString(),actor=randomUUID();
  await admin.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',[actor,'Synthetic retention owner',actor+'@example.invalid']);
  await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[actor,j.w]);
  await admin.query('UPDATE records SET updated_at=$2,version=version+1 WHERE id=$1',[j.conversation,old]);await admin.query('UPDATE outbox SET updated_at=$2 WHERE id=$1',[e,old]);
  const policy=(await admin.query("INSERT INTO retention_policies(workspace_id,environment,approved_by,expires_at,ttl,reason) VALUES($1,'REAL',$2,clock_timestamp()+interval '1 day',$3,'Synthetic retention projection validation') RETURNING id",[j.w,actor,{envelopes_days:7,messages_days:90,assets_days:30,ai_days:30,idempotency_days:90}])).rows[0].id;
  const record=(await admin.query("SELECT version,encode(digest(body::text,'sha256'),'hex') AS hash FROM records WHERE id=$1",[j.conversation])).rows[0],outbox=(await admin.query("SELECT encode(digest(payload::text,'sha256'),'hex') AS hash FROM outbox WHERE id=$1",[e])).rows[0],at=new Date().toISOString();
  const manifest={policy_id:policy,workspace_id:j.w,environment:'REAL',planned_at:at,candidates:[{kind:'conversation',id:j.conversation,version:record.version,snapshot_hash:record.hash},{kind:'outbox',id:e,snapshot_hash:outbox.hash}]};
  const plan=(await admin.query("INSERT INTO retention_plans(policy_id,plan_digest,manifest,created_at) VALUES($1,encode(digest(retention_canonical_json($2::jsonb),'sha256'),'hex'),$2,$3) RETURNING id,plan_digest",[policy,manifest,at])).rows[0];
  await expect(tx(j.w,db=>db.query('SELECT apply_retention_plan($1,$2,true)',[plan.id,plan.plan_digest]))).rejects.toThrow('permission denied');
  const first=(await admin.query('SELECT apply_retention_plan($1,$2,true) AS result',[plan.id,plan.plan_digest])).rows[0].result;
  expect(first.redacted).toBe(2);expect((await report(j)).summary).toEqual(before);
  expect((await admin.query('SELECT body FROM records WHERE id=$1',[j.conversation])).rows[0].body.last_customer_text).toBeUndefined();
  expect((await admin.query('SELECT payload FROM outbox WHERE id=$1',[e])).rows[0].payload).toMatchObject({purpose:'offer',content_redacted:true});
  expect((await admin.query('SELECT apply_retention_plan($1,$2,true) AS result',[plan.id,plan.plan_digest])).rows[0].result).toEqual(first);
  expect((await admin.query('SELECT 1 FROM retention_tombstones WHERE plan_id=$1',[plan.id])).rowCount).toBe(2);expect((await report(j)).summary).toEqual(before);
 });
 it('requires complete comparable reconciled Meta coverage and keeps fractional conversations',async()=>{
  const j=await journey(await profile());await payment(j);await metadata(j.w);await meta(j.w);const r=await report(j);expect(r.summary.spend_minor.value).toBe('2000');expect(r.summary.cost_per_conversation_minor.value).toBe('800.000000');expect(r.summary.roas.value).toBe('5.000000');
  const w=await profile();await meta(w,{campaign:'2200'});expect((await tx(w,db=>readResultSpend(db,query)))[0]?.reason).toBe('SPEND_RECONCILIATION_DIFFERENCE');
  const incomplete=await profile();await meta(incomplete,{complete:false});expect((await tx(incomplete,db=>readResultSpend(db,query)))[0]?.reason).toBe('SPEND_COVERAGE_INCOMPLETE');
 });
 it('does not apportion unsupported cuts or call an unmapped product zero spend',async()=>{
  const j=await journey(await profile());await meta(j.w);expect((await tx(j.w,db=>readResultSpend(db,{...query,family_id:j.family})))[0]?.reason).toBe('SPEND_PRODUCT_MAPPING_INCOMPLETE');
  expect((await tx(j.w,db=>readResultSpend(db,{...query,account_id:j.account})))[0]?.reason).toBe('SPEND_DIMENSION_NOT_ATTRIBUTABLE');
 });
 it('keeps TEST and reservations out of measured AI and preserves uncertainty',async()=>{
  const j=await journey(await profile());await ai(j);await ai(j,{cost:'900',classification:'TEST'});await ai(j,{cost:null,intent:null,status:'RESERVED'});const facts=await tx(j.w,db=>readResultFacts(db,query));expect(summarizeResults(facts,[],query).ai.cost.value).toBe('150');
  await ai(j,{cost:null,status:'UNCERTAIN'});const r=await report(j);expect(r.summary.ai.cost.reason).toBe('AI_COST_INCOMPLETE');expect(r.summary.totals.ai_cost_microusd).toBe('150');expect(r.summary.totals.ai_input_tokens).toBe('100');
 });
 it('uses profile civil boundaries and equal length previous periods',async()=>{
  const j=await journey(await profile('America/Los_Angeles'),{started_at:'2026-11-01T08:30:00.000Z'});await effect(j,'offer','SENT','2026-11-01T09:30:00.000Z');const q={...query,from:'2026-11-01',to:'2026-11-01'},r=await report(j,q);expect(r.summary.first_response_ms.value).toBe('3600000.000000');expect(r.previous.from).toBe('2026-10-31');expect(r.series).toHaveLength(1);
 });
 it('returns bounded profile-owned labels for every result filter',async()=>{
  const j=await journey(await profile());await metadata(j.w);await journey(await profile());
  expect((await tx(j.w,db=>resultOptions(db,{kind:'family',limit:1}))).data).toEqual([{id:j.family,label:'Synthetic product'}]);
  expect((await tx(j.w,db=>resultOptions(db,{kind:'account'}))).data).toEqual([{id:j.account,label:'Número'}]);
  expect((await tx(j.w,db=>resultOptions(db,{kind:'campaign'}))).data).toEqual([{id:'10',label:'Synthetic campaign'}]);
  expect((await tx(j.w,db=>resultOptions(db,{kind:'ad'}))).data).toEqual([{id:'100',label:'Synthetic ad'}]);
  expect((await tx(j.w,db=>resultOptions(db,{kind:'variant',family_id:j.family}))).data).toEqual([]);
  expect((await tx(j.w,db=>resultOptions(db,{kind:'market'}))).data).toEqual([]);
  expect((await tx(j.w,db=>resultOptions(db,{kind:'family',after:j.family}))).data).toEqual([]);
  await expect(tx(j.w,db=>resultOptions({...db,workspaceId:'foreign'},{kind:'family'}))).rejects.toThrow('RESULT_PROFILE_CONTEXT_REQUIRED');
 });
 it('uses confirmed remarketing before payment as its own payment cut',async()=>{
  const j=await journey(await profile());await effect(j,'remarketing');await payment(j);const r=await report(j,{...query,touch:'REMARKETING'});expect(r.summary.totals.sales).toBe('1');expect(r.summary.funnel[0]?.count).toBe('0');expect(r.summary.spend_minor.value).toBeNull();
 });
});
