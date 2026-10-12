import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {disposeAllFixtureProfiles} from '../support/migrated-database.js';
import {randomUUID,randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord,withTransaction} from '../../packages/db/src/index.js';
import {persistInsightAccount} from '../../apps/automation-worker/src/meta-insights.js';
import type {Body} from '../../packages/contracts/src/index.js';

let app:FastifyInstance,w:string,cookie:string,actor:string;
const origin=(process.env.TRUSTED_ORIGINS??'http://127.0.0.1:5173').split(',')[0]!;
beforeAll(async()=>{app=await createApp();});
afterAll(async()=>{vi.restoreAllMocks();await app.close();await pool.end();});
// V7 F2: each case starts from a fresh workspace; an installation admits three
// profiles, so the previous cases' fixture profiles are disposed first.
beforeEach(async()=>{await disposeAllFixtureProfiles(pool);
 w='campaign-filter-'+randomUUID();const email=randomUUID()+'@commerce.test',password=randomBytes(24).toString('base64url');
 actor=(await provisionUser({email,password,name:'Synthetic coverage reviewer',workspace_id:w,role:'owner'})).id;
 const r=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.76',headers:{origin},payload:{email,password}});
 expect(r.statusCode,r.body).toBe(200);cookie=(Array.isArray(r.headers['set-cookie'])?r.headers['set-cookie']:[r.headers['set-cookie']]).map(x=>String(x).split(';')[0]).join('; ');
});
const call=(method:'GET'|'POST',url:string,payload?:Body)=>app.inject({method,url,headers:{cookie,origin,'idempotency-key':randomUUID()},...(payload?{payload}:{})});
async function report(from:string,to:string,extra='',path='campaign-performance'){
 const r=await call('GET',`/v1/reports/${path}?environment=SIMULATION&from=${from}&to=${to}${extra}`);expect(r.statusCode,r.body).toBe(200);return r.json().data;
}
async function seed(from:string,to:string,spendDay:string,amount:number,accountId='act_123'){
 const job=(await pool.query("INSERT INTO meta_insight_jobs(workspace_id,environment,actor_id,request,status) VALUES($1,'SIMULATION',$2,$3,'SYNCED') RETURNING *",[w,actor,{from,to}])).rows[0];
 const account={id:accountId,name:'Synthetic '+accountId,currency:'MXN',timezone_name:'America/Mexico_City'};
 const row={day:spendDay,level:'ad',entity_id:'55',campaign_id:'44',ad_set_id:'66',name:'Synthetic ad',campaign_name:'WA | TEST | Preescolar | A1',currency:'MXN',timezone:account.timezone_name,spend_minor:amount,impressions:1000,clicks:20,conversations:10,action_type:null};
 await withTransaction(c=>persistInsightAccount(c,job,account,[row,{...row,level:'campaign',entity_id:'44'}],[{id:'55',name:row.name,campaign_id:'44',adset_id:'66',campaign:{name:row.campaign_name}}]));
}
async function acceptedReceipt(day:string,accountId='act_123'){
 const order=await putRecord(pool,{workspaceId:w,environment:'SIMULATION',kind:'order',body:{currency:'MXN',reconciliation_status:'UNRECONCILED',attribution:{classification:'observed',meta_ad_account_id:accountId,ad_id:'55'}}});
 const receipt=await putRecord(pool,{workspaceId:w,environment:'SIMULATION',kind:'receipt',body:{order_id:order.id,status:'APPROVED'}});
 await pool.query("INSERT INTO payment_contributions(workspace_id,environment,order_id,receipt_id,payment_key,amount_minor,currency,currency_source,evidence_sha256,effective_at,provenance) VALUES($1,'SIMULATION',$2,$3,'primary',20400,'MXN','receipt',$4,$5,$6)",[w,order.id,receipt.id,randomUUID(),day+'T12:00:00Z',{source:'synthetic_approved_receipt'}]);
 return order.id;
}

describe('Campaign filter coverage and explicit tax estimates',()=>{
 it('preserves covered days and observed spend when a seven-day report expands to thirty days',async()=>{
  await seed('2026-09-01','2026-09-08','2026-09-01',47958);
  const fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('UNEXPECTED_PROVIDER_READ'));
  try{
   const seven=await report('2026-09-02','2026-09-08');expect(seven.quality).toMatchObject({available:true,complete:true,coverage_days_count:7,missing_days:[],tax_status:'NOT_REQUESTED'});expect(seven.summary).toMatchObject({spend_minor:0,net_spend_observed_minor:0});
   const thirty=await report('2026-08-10','2026-09-08');expect(thirty.quality).toMatchObject({status:'PARTIAL',available:false,complete:false,days:30,coverage_days_count:8,observed_days_count:8,blockers:['INCOMPLETE_COVERAGE']});expect(thirty.quality.missing_days).toHaveLength(22);expect(thirty.quality.spend_control).toMatchObject({unassigned_spend_minor:null,net_unassigned_spend_observed_minor:47958});
   expect(thirty.summary).toMatchObject({spend_minor:null,net_spend_observed_minor:47958,roas:null,balance_minor:null});
   expect(thirty.series.find((r:Body)=>r.day==='2026-09-01')).toMatchObject({spend_minor:47958,net_spend_observed_minor:47958,complete:true});
   expect(thirty.series.find((r:Body)=>r.day==='2026-09-02')).toMatchObject({spend_minor:0,net_spend_observed_minor:0,complete:true});
   expect(thirty.series.find((r:Body)=>r.day==='2026-08-31')).toMatchObject({spend_minor:null,net_spend_observed_minor:null,complete:false});
   expect(thirty.groups.products[0]).toMatchObject({spend_minor:null,net_spend_observed_minor:47958});
   const weekly=await report('2026-08-10','2026-09-08','&granularity=week');expect(weekly.series.find((r:Body)=>r.day==='2026-08-31')).toMatchObject({spend_minor:null,net_spend_observed_minor:47958,coverage_days_count:6,days:7,complete:false});expect(weekly.series.find((r:Body)=>r.day==='2026-09-07')).toMatchObject({spend_minor:0,coverage_days_count:2,days:2,complete:true});
   expect(fetcher).not.toHaveBeenCalled();
  }finally{fetcher.mockRestore();}
 });
 it('keeps net receipts and spend while tax is missing, and applies only an explicit query estimate',async()=>{
  const day='2026-09-06';await seed(day,day,day,10000);const saleId=await acceptedReceipt(day);
  const missing=await report(day,day,'&cost_basis=estimated_tax');expect(missing.quality).toMatchObject({status:'SYNCED',complete:true,available:false,tax_status:'MISSING',tax_missing:true,blockers:['TAX_RATE_MISSING'],tax_estimate:{fallback_bps:null,applied_accounts:[]}});expect(missing.quality.spend_control).toMatchObject({unassigned_spend_minor:null,net_unassigned_spend_observed_minor:10000});expect(missing.summary).toMatchObject({spend_minor:null,net_spend_observed_minor:10000,revenue_minor:20400,sales:1,roas:null,balance_minor:null});
  const estimated=await report(day,day,'&cost_basis=estimated_tax&fallback_tax_bps=1600');expect(estimated.quality).toMatchObject({available:true,tax_status:'ESTIMATED',tax_missing:false,tax_estimate:{fallback_bps:1600,applied_accounts:['act_123']}});expect(estimated.summary).toMatchObject({spend_minor:11600,net_spend_observed_minor:10000,revenue_minor:20400,sales:1,balance_minor:8800});
  expect((await report(day,day,'&cost_basis=estimated_tax&fallback_tax_bps=0')).summary.spend_minor).toBe(10000);
  expect((await report(day,day,'&fallback_tax_bps=1600')).quality).toMatchObject({tax_status:'NOT_REQUESTED',tax_estimate:{fallback_bps:null,applied_accounts:[]}});
  expect((await pool.query('SELECT tax_bps FROM meta_insight_accounts WHERE workspace_id=$1',[w])).rows[0].tax_bps).toBeNull();
  const exported=await report(day,day,'&cost_basis=estimated_tax&fallback_tax_bps=1600','campaign-export');expect(exported.summary).toMatchObject(estimated.summary);
  const sales=await report(day,day,'&cost_basis=estimated_tax&fallback_tax_bps=1600&limit=1&offset=0','campaign-sales');expect(sales).toHaveLength(1);expect(sales[0]).toMatchObject({sale_id:saleId,revenue_minor:20400});expect(await report(day,day,'&fallback_tax_bps=1600&limit=1&offset=1','campaign-sales')).toEqual([]);
 });
 it('requires every account for complete buckets and gives stored zero and configured rates precedence',async()=>{
  await seed('2026-09-01','2026-09-08','2026-09-01',10000);await seed('2026-09-05','2026-09-08','2026-09-05',20000,'act_456');
  const saved=await call('POST','/v1/meta/insights/tax',{environment:'SIMULATION',meta_ad_account_id:'act_123',tax_bps:0,reason:'Synthetic explicit exemption'});expect(saved.statusCode,saved.body).toBe(200);
  const all=await report('2026-09-01','2026-09-08','&cost_basis=estimated_tax&fallback_tax_bps=1600');expect(all.quality).toMatchObject({coverage_days_count:4,observed_days_count:8,tax_status:'ESTIMATED',tax_estimate:{fallback_bps:1600,applied_accounts:['act_456']}});expect(all.summary).toMatchObject({spend_minor:null,net_spend_observed_minor:30000});
  expect(all.series.find((r:Body)=>r.day==='2026-09-01')).toMatchObject({spend_minor:null,net_spend_observed_minor:10000,complete:false});expect(all.series.find((r:Body)=>r.day==='2026-09-05')).toMatchObject({spend_minor:23200,net_spend_observed_minor:20000,complete:true});
  const onlyA=await report('2026-09-01','2026-09-08','&meta_ad_account_id=act_123&cost_basis=estimated_tax&fallback_tax_bps=1600');expect(onlyA.quality).toMatchObject({complete:true,tax_status:'CONFIGURED',tax_estimate:{fallback_bps:1600,applied_accounts:[]}});expect(onlyA.summary.spend_minor).toBe(10000);
  expect((await call('POST','/v1/meta/insights/tax',{environment:'SIMULATION',meta_ad_account_id:'act_123',tax_bps:500,reason:'Synthetic configured estimate'})).statusCode).toBe(200);
  expect((await report('2026-09-01','2026-09-08','&meta_ad_account_id=act_123&cost_basis=estimated_tax&fallback_tax_bps=1600')).summary.spend_minor).toBe(10500);
 });
 it('does not transfer one account coverage to a campaign or ad that only has a receipt',async()=>{
  const day='2026-09-06';await seed(day,day,day,10000);await seed('2026-08-31','2026-08-31','2026-08-31',5000,'act_456');await acceptedReceipt(day,'act_456');
  const result=await report(day,day);expect(result.summary).toMatchObject({spend_minor:null,net_spend_observed_minor:10000,revenue_minor:20400});
  for(const groups of [result.groups.campaigns,result.groups.ads]){
   expect(groups.find((r:Body)=>r.meta_ad_account_id==='act_123')).toMatchObject({net_spend_observed_minor:10000});
   expect(groups.find((r:Body)=>r.meta_ad_account_id==='act_456')).toMatchObject({spend_minor:null,net_spend_observed_minor:null,revenue_minor:20400});
  }
 });
 it('does not fabricate zeroes for no source and validates the optional rate without modifying accounts',async()=>{
  const spec=(await app.inject({method:'GET',url:'/v1/openapi.json'})).json();for(const path of ['campaign-performance','campaign-sales','campaign-export']){const parameter=spec.paths['/v1/reports/'+path].get.parameters.find((p:Body)=>p.name==='fallback_tax_bps');expect(parameter).toMatchObject({required:false,schema:{type:'integer',minimum:0,maximum:10000}});expect(parameter.schema.default).toBeUndefined();}
  const day='2026-09-06',empty=await report(day,day);expect(empty.summary).toMatchObject({spend_minor:null,net_spend_observed_minor:null});expect(empty.series[0]).toMatchObject({spend_minor:null,net_spend_observed_minor:null,complete:false});expect(empty.quality.blockers).toContain('NO_COMPARABLE_ACCOUNTS');
  for(const rate of ['-1','10001','16.5','invalid'])expect((await call('GET',`/v1/reports/campaign-performance?from=${day}&to=${day}&fallback_tax_bps=${rate}`)).statusCode).toBe(400);
  await seed(day,day,day,10000);const real=await call('GET',`/v1/reports/campaign-performance?from=${day}&to=${day}&cost_basis=estimated_tax&fallback_tax_bps=1600`);expect(real.statusCode,real.body).toBe(200);expect(real.json().data.summary.net_spend_observed_minor).toBeNull();
  expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[w])).rows[0].n).toBe(0);
 });
});
