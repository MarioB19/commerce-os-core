import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {disposeAllFixtureProfiles} from '../support/migrated-database.js';
import {randomUUID,randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord,withTransaction} from '../../packages/db/src/index.js';
import {saveIntegrationSetting} from '../../packages/db/src/integration-settings.js';
import {persistInsightAccount,executeInsightJob} from '../../apps/automation-worker/src/meta-insights.js';
import type {Body} from '../../packages/contracts/src/index.js';
let app:FastifyInstance,w:string,cookie:string,actor:string;
const origin=(process.env.TRUSTED_ORIGINS??'http://127.0.0.1:5173').split(',')[0]!,day='2026-09-06';
beforeAll(async()=>{app=await createApp();});
afterAll(async()=>{vi.restoreAllMocks();await app.close();await pool.end();});
// V7 F2: each case starts from a fresh workspace; an installation admits three
// profiles, so the previous cases' fixture profiles are disposed first.
beforeEach(async()=>{await disposeAllFixtureProfiles(pool);w='campaign-read-'+randomUUID();const email=randomUUID()+'@commerce.test',password=randomBytes(24).toString('base64url');actor=(await provisionUser({email,password,name:'Synthetic report operator',workspace_id:w,role:'owner'})).id;const r=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.69',headers:{origin},payload:{email,password}});expect(r.statusCode,r.body).toBe(200);cookie=(Array.isArray(r.headers['set-cookie'])?r.headers['set-cookie']:[r.headers['set-cookie']]).map(x=>String(x).split(';')[0]).join('; ');});
const call=(method:'GET'|'POST',url:string,payload?:Body)=>app.inject({method,url,headers:{cookie,origin,'idempotency-key':randomUUID()},...(payload?{payload}:{})});
async function report(extra=''){const r=await call('GET',`/v1/reports/campaign-performance?environment=SIMULATION&from=${day}&to=${day}${extra}`);expect(r.statusCode,r.body).toBe(200);return r.json().data;}
async function seed(names:string[]){
 const job=(await pool.query("INSERT INTO meta_insight_jobs(workspace_id,environment,actor_id,request,status) VALUES($1,'SIMULATION',$2,$3,'SYNCED') RETURNING *",[w,actor,{from:day,to:day}])).rows[0];
 const account={id:'act_123',name:'Synthetic account',currency:'MXN',timezone_name:'America/Mexico_City'};
 const rows=names.map((name,i)=>({day,level:'ad',entity_id:String(55+i),campaign_id:String(44+i),ad_set_id:String(66+i),name:'Synthetic ad '+i,campaign_name:name,currency:'MXN',timezone:account.timezone_name,spend_minor:(i+1)*10000,impressions:100,clicks:10,conversations:null,action_type:null}));
 await withTransaction(c=>persistInsightAccount(c,job,account,[...rows,...rows.map(r=>({...r,level:'campaign',entity_id:r.campaign_id}))],rows.map(r=>({id:r.entity_id,name:r.name,campaign_id:r.campaign_id,adset_id:r.ad_set_id,campaign:{name:r.campaign_name}}))));return job;
}

describe('Campaign read projection and quota boundaries',()=>{
 it('compares extracted labels without catalog creation, fake receipts or ambiguous aliases',async()=>{
  await seed(['WA | TEST | Costura | A1','WA | Costura que Vende | A2','WA | TEST | Oraciones | A3']);
  const initial=await report();expect(initial.summary).toMatchObject({spend_minor:60000,revenue_minor:0,sales:0});expect(initial.options.products).toEqual([]);
  expect(initial.groups.products).toEqual(expect.arrayContaining([expect.objectContaining({id:'campaign-name:costura que vende',name:'Costura que Vende',source:'CAMPAIGN_NAME',product_id:null,spend_minor:30000}),expect.objectContaining({name:'Oraciones',spend_minor:30000})]));
  expect(initial.groups.products.reduce((n:number,r:Body)=>n+r.spend_minor,0)).toBe(60000);
  expect(initial.options.ads).toHaveLength(3);expect(initial.quality.spend_control.unassigned_spend_minor).toBe(60000);
  expect((await report('&extracted_product=costura%20que%20vende')).summary.spend_minor).toBe(30000);
  const sales=await call('GET',`/v1/reports/campaign-sales?environment=SIMULATION&from=${day}&to=${day}&extracted_product=costura%20que%20vende`);expect(sales.statusCode,sales.body).toBe(200);expect(sales.json().data).toEqual([]);
  const product=await putRecord(pool,{workspaceId:w,environment:'SIMULATION',kind:'product',body:{name:'Costura que Vende'}});
  const candidate=await report();expect(candidate.groups.campaigns.find((r:Body)=>r.campaign_id==='44').product_resolution).toMatchObject({status:'EXACT_NAME_CANDIDATE',candidate_product_id:product.id,product_ids:[]});
  const mapped=await call('POST','/v1/campaign-products',{environment:'SIMULATION',meta_ad_account_id:'act_123',entity_type:'ad',entity_id:'55',product_id:product.id,valid_from:day,expected_revision:0,reason:'Synthetic explicit reviewed classification'});expect(mapped.statusCode,mapped.body).toBe(200);
  const confirmed=await report();expect(confirmed.cache.status).toBe('MISS');expect(confirmed.groups.products).toEqual(expect.arrayContaining([expect.objectContaining({id:product.id,source:'EXPLICIT_MAPPING',spend_minor:10000}),expect.objectContaining({id:'campaign-name:costura que vende',spend_minor:20000})]));
  expect((await report('&product_id='+product.id)).summary.spend_minor).toBe(10000);
  expect((await call('GET',`/v1/reports/campaign-performance?environment=SIMULATION&from=${day}&to=${day}&product_id=${product.id}&extracted_product=costura`)).statusCode).toBe(400);
  const exported=await call('GET',`/v1/reports/campaign-export?environment=SIMULATION&from=${day}&to=${day}&extracted_product=costura%20que%20vende`);expect(exported.statusCode,exported.body).toBe(200);expect(exported.json().data.summary.spend_minor).toBe(20000);expect(exported.json().data.cache).toBeUndefined();
  expect((await pool.query('SELECT count(*)::int n FROM payment_contributions WHERE workspace_id=$1',[w])).rows[0].n).toBe(0);
 });
 it('coalesces report reads and invalidates on job, metadata, catalog and account quality changes',async()=>{
  const job=await seed(['WA | TEST | Costura | A1','WA | Costura que Vende | A2','WA | Costura para Principiantes | A3']);
  const [one,two]=await Promise.all([report(),report()]);const statuses=[one.cache.status,two.cache.status];expect(statuses.filter(status=>status==='MISS')).toHaveLength(1);expect(statuses.filter(status=>['COALESCED','HIT'].includes(status))).toHaveLength(1);expect(one.revision).toBe(two.revision);
  expect(one.groups.products.map((r:Body)=>r.name)).toContain('Costura');expect((await report()).cache.status).toBe('HIT');
  await pool.query("UPDATE meta_insight_accounts SET status='UNAVAILABLE',issue='{\"code\":\"META_RATE_LIMIT\"}' WHERE workspace_id=$1",[w]);
  const partial=await report();expect(partial.cache.status).toBe('MISS');expect(partial.quality.status).toBe('PARTIAL');expect(partial.summary.spend_minor).toBe(60000);
  await pool.query("UPDATE meta_insight_jobs SET updated_at=clock_timestamp(),result='{\"status\":\"PARTIAL\"}' WHERE id=$1",[job.id]);expect((await report()).revision).not.toBe(partial.revision);
  await pool.query("UPDATE meta_ad_metadata SET campaign_name='WA | TEST | Invitaciones | A1',observed_at=clock_timestamp() WHERE workspace_id=$1 AND campaign_id='44'",[w]);expect((await report()).groups.products.map((r:Body)=>r.name)).toContain('Invitaciones');
  const real=await call('GET',`/v1/reports/campaign-performance?from=${day}&to=${day}`);expect(real.json().data.summary.spend_minor).toBeNull();expect(real.json().data.environment).toBe('REAL');
 });
 it('preserves Retry-After when the final metadata read is rate limited, keeping verified spend partial',async()=>{
  await withTransaction(c=>saveIntegrationSetting(c,w,'REAL','meta:retry',{expected_version:0,label:'Synthetic quota fixture',enabled:true,config:{},secrets:{access_token:'synthetic-quota-'+randomUUID()},clear_secrets:[],reason:'Synthetic quota regression'},actor));
  const job=(await pool.query("INSERT INTO meta_insight_jobs(workspace_id,environment,actor_id,request,status,lease_token) VALUES($1,'REAL',$2,$3,'RUNNING',$4) RETURNING *",[w,actor,{from:day,to:day,recurring:false},randomUUID()])).rows[0];
  const fetcher=vi.fn(async(input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{expect(init?.method).toBe('GET');const url=new URL(String(input));if(url.pathname.endsWith('/me/adaccounts'))return Response.json({data:[{id:'act_123',name:'Synthetic account',currency:'MXN',timezone_name:'America/Mexico_City'}]});if(url.pathname.endsWith('/ads'))return Response.json({error:{code:4}},{status:429,headers:{'retry-after':'3600'}});return Response.json({data:[{account_id:'123',account_currency:'MXN',date_start:day,date_stop:day,campaign_id:'44',campaign_name:'WA | TEST | Costura | A1',ad_id:'55',ad_name:'Synthetic ad',adset_id:'66',spend:'100.00'}]});});
  const result=await executeInsightJob(job,fetcher);expect(result).toMatchObject({status:'PARTIAL',succeeded:1,external_mutations:0});expect(result.issues.find(i=>i.code==='META_RATE_LIMIT')).toMatchObject({retry_after_seconds:3600,retry_at:expect.any(String)});expect(fetcher).toHaveBeenCalledTimes(4);
  const account=(await pool.query('SELECT status FROM meta_insight_accounts WHERE workspace_id=$1 AND environment=\'REAL\'',[w])).rows[0];expect(account.status).toBe('PARTIAL');
  expect((await pool.query('SELECT spend_minor FROM meta_insight_days WHERE workspace_id=$1 AND environment=\'REAL\' AND level=\'ad\'',[w])).rows[0].spend_minor).toBe('10000');
 });
 it('reuses inventory snapshots and identical durable Insights requests without outbound calls',async()=>{
  await withTransaction(c=>saveIntegrationSetting(c,w,'REAL','meta:fixture',{expected_version:0,label:'Synthetic Meta profile',enabled:true,config:{},secrets:{access_token:'private-fixture-'+randomUUID()},clear_secrets:[],reason:'Synthetic recent snapshot'},actor));
  const id=randomUUID(),inventory={meta_profile_revisions:{'meta:fixture':1},source:'META_API',graph_api_version:'v26.0',synced_at:new Date().toISOString(),valid_until:new Date(Date.now()+3600000).toISOString(),status:'SYNCED',credentials:[],portfolios:[],requests:[],external_mutations:0};
  await pool.query('INSERT INTO meta_syncs(id,workspace_id,actor_id,inventory) VALUES($1,$2,$3,$4)',[id,w,actor,inventory]);
  const fetcher=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('EXTERNAL_SERVICE_FORBIDDEN'));
  try{const replies=await Promise.all([call('POST','/v1/meta/sync',{environment:'REAL'}),call('POST','/v1/meta/sync',{environment:'REAL'})]);for(const r of replies){expect(r.statusCode,r.body).toBe(200);expect(r.json().data).toMatchObject({id,reused:true});}expect(fetcher).not.toHaveBeenCalled();}finally{fetcher.mockRestore();}
  const jobs=await Promise.all([call('POST','/v1/meta/insights/sync',{environment:'REAL',from:day,to:day,recurring:false}),call('POST','/v1/meta/insights/sync',{environment:'REAL',from:day,to:day,recurring:false})]);for(const r of jobs)expect(r.statusCode,r.body).toBe(202);expect(jobs[0]!.json().data.id).toBe(jobs[1]!.json().data.id);
  expect((await pool.query("SELECT count(*)::int n FROM meta_insight_jobs WHERE workspace_id=$1 AND status='PENDING'",[w])).rows[0].n).toBe(1);
  for(const table of ['commands','outbox'])expect((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE workspace_id=$1`,[w])).rows[0].n).toBe(0);
 });
});
