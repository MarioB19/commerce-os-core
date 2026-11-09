import {writeFileSync} from 'node:fs';
import {evidencePath} from '../support/evidence.js';
import {randomBytes,randomUUID} from 'node:crypto';
import Fastify,{type FastifyInstance} from 'fastify';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {metaPortfolioRoutes} from '../../apps/api/src/meta-portfolios.js';
import {campaignsV2Routes} from '../../apps/api/src/campaigns-v2.js';
import {processMetaPortfolioTask,claimMetaPortfolioTask,scheduleMetaPortfolioReads} from '../../apps/automation-worker/src/meta-portfolios.js';
import {withProfileTransaction,type ProfilePool} from '../../packages/db/src/profile-context.js';
import {createProfileWorkerRuntime,withWorkerProfilePhase} from '../../packages/db/src/profile-worker-scope.js';
import {bindProfileEnvironment} from '../../packages/db/src/profile-environment.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../packages/domain/src/core/profile-authorization.js';
import {metaDate,shiftMetaDay,readMetaConnectionToken} from '../../packages/db/src/meta-portfolios.js';
import {fixtureProfileRow,isolatedAdminUrl,requireMigratedProfileSchema} from '../support/migrated-database.js';
import {campaignCsv} from '../../packages/contracts/src/campaign-export.js';
const suffix=randomBytes(5).toString('hex'),one='v73-a-'+suffix,two='v73-b-'+suffix,origin='https://commerce.example.test',created:string[]=[];
const credentials=[0,1,2].map(()=>({id:randomUUID(),token:'EAAG'+randomBytes(24).toString('hex')}));
let admin:pg.Pool,api:ProfilePool,app:FastifyInstance,dbQueries=0;
const day=()=>metaDate('America/Mexico_City');
const rolePool=(role:string):ProfilePool=>({async connect(){const c=await admin.connect();await c.query('SET ROLE '+role);return{query:(...args:any[])=>{dbQueries++;return (c.query as any).apply(c,args);},release:(e?:Error)=>{void c.query('RESET ROLE').finally(()=>c.release(e));}};}});
async function auth(db:any,w:string,user:string,kind:'session'|'personal_token'='session'):Promise<ProfileAuthority>{return{profile:{id:w,state:'ACTIVE'},membership:{userId:user,workspaceId:w,role:user==='operator'?'operator':'owner',active:true,version:1},credential:{kind,userId:user,workspaceId:w,revoked:false,expiresAt:new Date(Date.now()+3600000).toISOString(),scopes:kind==='personal_token'?['integrations:read','integrations:write','campaigns:read']:[],membershipVersion:1}};}
async function request(user:string,f:any,e:any,a:any,work:any,kind:'session'|'personal_token'='session'){return withProfileTransaction(api,f.workspaceId,async db=>{const authority=await auth(db,f.workspaceId,user,kind);authorizeProfileAction(authority,{...a,workspaceId:f.workspaceId},new Date());await bindProfileEnvironment(db,e);return work({db,profile:{authority,profile:{timezone:'America/Mexico_City'}},environment:e});});}
function call(method:string,path:string,body?:unknown,w=one,user='owner'){return app.inject({method:method as 'GET',url:path,headers:{origin,'x-user':user,'x-commerce-profile-id':w,'x-commerce-profile-version':'1',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{payload:JSON.stringify(body)})});}
const body=(r:any)=>{expect(r.statusCode,r.body).toBe(200);return r.json().data;};
async function scoped<T>(work:()=>Promise<T>,w=one){const runtime=createProfileWorkerRuntime(rolePool('commerce_automation'),'commerce_automation','REAL'),selection=(await runtime.discover()).find(p=>p.workspaceId===w)!;return runtime.run(selection,work);}
async function drain(fetcher:typeof fetch=graph){return scoped(async()=>{let count=0;while(count++<400&&await processMetaPortfolioTask(fetcher));expect(count).toBeLessThan(400);return count;});}
const calls:{method:string;path:string}[]=[];
const graph:typeof fetch=async(input,init)=>{
 const u=new URL(String(input)),path=u.pathname.split('/').slice(2).join('/'),token=new Headers(init?.headers).get('Authorization')?.replace('Bearer ',''),n=credentials.findIndex(c=>c.token===token);calls.push({method:init?.method??'',path});expect(init?.method).toBe('GET');expect(n).toBeGreaterThanOrEqual(0);
 if(path==='me')return Response.json({id:'system-user'});
 if(path==='me/permissions')return Response.json({data:[{permission:'ads_read',status:'granted'}]});
 if(path==='me/businesses')return Response.json({data:[]});
 if(path==='me/adaccounts'){
  const page=Number(u.searchParams.get('after')??0);const account=n===1?'222':'111',business=n===1?'200':'100';
  // More than the old 25-page ceiling, with duplicate account names and IDs across credentials.
  return Response.json({data:page===0||page===26?[{id:'act_'+account,name:'Same account name',currency:'MXN',timezone_name:'America/Mexico_City',business:{id:business,name:'Portfolio '+business}}]:[],...(n===0&&page<26?{paging:{next:`https://graph.facebook.com/v26.0/me/adaccounts?after=${page+1}`,cursors:{after:String(page+1)}}}:{})});
 }
 if(path.endsWith('/ads'))return Response.json({data:[]});
 if(path.endsWith('/insights')){
  const account=path.split('/')[0]!.slice(4);if(account==='222')return Response.json({data:[]});
  const range=JSON.parse(u.searchParams.get('time_range')!),rows=[];
  for(let d=range.since;d<=range.until;d=shiftMetaDay(d,1))rows.push({account_id:account,account_currency:'MXN',date_start:d,date_stop:d,campaign_id:'44',campaign_name:'Campaign',ad_id:'55',ad_name:'Ad',adset_id:'66',spend:'1.00',impressions:'100',clicks:'10',actions:[{action_type:'onsite_conversion.messaging_conversation_started_7d',value:'2'}]});
  return Response.json({data:rows});
 }
 throw Error('UNEXPECTED_GRAPH_PATH');
};
describe('V7.3 durable multi-portfolio reads',()=>{
 beforeAll(async()=>{vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));admin=new pg.Pool({connectionString:isolatedAdminUrl().toString(),max:8});await requireMigratedProfileSchema(admin);api=rolePool('commerce_api');
  for(const w of [one,two])await fixtureProfileRow(admin,created,w,{businessName:'Synthetic '+w,numbers:0});
  app=Fastify({logger:false});app.setErrorHandler((e:any,_r,r)=>r.code(e.statusCode??(e.name==='ZodError'?400:e.code?.startsWith('PROFILE_')?403:500)).send({error:{code:e.code??e.message}}));
  const deps={origins:[origin],nativeSession:async(r:any)=>({id:'session',userId:String(r.headers['x-user'])}),session:(s:any,f:any,e:any,a:any,w:any)=>request(s.userId,f,e,a,w),personal:async(_t:any,e:any,a:any,w:any)=>request('owner',{workspaceId:one},e,a,w,'personal_token')};
  await app.register(async scoped=>{await metaPortfolioRoutes(scoped,{request:deps,metaFetcher:graph});await campaignsV2Routes(scoped,deps);});await app.ready();
 },60000);
 afterAll(async()=>{await app?.close();await admin?.end();vi.unstubAllEnvs();});
 it('saves two independent encrypted credentials, paginates beyond 25 pages and deduplicates account access',async()=>{
  for(const [i,c]of credentials.entries())body(await call('PUT',`/v2/meta/connections/${c.id}/token?environment=REAL`,{alias:'Connection '+i,expectedRevision:0,token:c.token}));
  await drain();const inventory=body(await call('GET','/v2/meta?environment=REAL'));
  expect(inventory.counts).toMatchObject({discoveredPortfolios:2,storedAccounts:2,accessibleAccounts:2,selectedPortfolios:0});expect(inventory.connections).toHaveLength(3);expect(inventory.accounts.map((a:any)=>a.name)).toEqual(['Same account name','Same account name']);
  for(const c of credentials)expect(JSON.stringify(inventory)).not.toContain(c.token);
  expect((await admin.query('SELECT count(*)::int n FROM meta_account_access WHERE workspace_id=$1',[one])).rows[0].n).toBe(3);
  expect(body(await call('GET','/v2/meta',undefined,two)).counts.storedAccounts).toBe(0);
  expect((await call('PUT',`/v2/meta/connections/${randomUUID()}/token`,{alias:'No',expectedRevision:0,token:credentials[0]!.token},one,'operator')).statusCode).toBe(403);
  expect((await call('GET','/v2/meta?workspace_id='+two)).statusCode).toBe(400);
 });
 it('selects five portfolios at most under concurrent writes, then reads all accounts with 90 inclusive days',async()=>{
  await admin.query("INSERT INTO meta_portfolios(workspace_id,business_id,name) SELECT $1,n::text,'Extra '||n FROM generate_series(300,600,100)n",[one]);
  const choices=await Promise.all(['100','200','300','400','500','600'].map(id=>call('PATCH','/v2/meta/portfolios/'+id,{expectedVersion:1,selected:true})));
  expect(choices.filter(r=>r.statusCode===200)).toHaveLength(5);expect(choices.filter(r=>r.statusCode===409)).toHaveLength(1);
  const inventory=body(await call('GET','/v2/meta'));for(const p of inventory.portfolios)if(p.selected&&!['100','200'].includes(p.id))body(await call('PATCH','/v2/meta/portfolios/'+p.id,{expectedVersion:p.version,selected:false}));
  for(const p of inventory.portfolios)if(!p.selected&&['100','200'].includes(p.id))body(await call('PATCH','/v2/meta/portfolios/'+p.id,{expectedVersion:p.version,selected:true}));
  await scoped(()=>withWorkerProfilePhase(scheduleMetaPortfolioReads));await drain();
  const rows=(await admin.query("SELECT meta_ad_account_id,count(*)::int days,min(day)::text first,max(day)::text last FROM meta_insight_coverage WHERE workspace_id=$1 GROUP BY meta_ad_account_id ORDER BY 1",[one])).rows;
  expect(rows).toEqual(['act_111','act_222'].map(id=>({meta_ad_account_id:id,days:90,first:shiftMetaDay(day(),-89),last:day()})));
  expect(calls.every(c=>c.method==='GET')).toBe(true);
  const before=(await admin.query('SELECT count(*)::int n FROM meta_read_tasks WHERE workspace_id=$1',[one])).rows[0].n;await scoped(()=>withWorkerProfilePhase(scheduleMetaPortfolioReads));expect((await admin.query('SELECT count(*)::int n FROM meta_read_tasks WHERE workspace_id=$1',[one])).rows[0].n).toBe(before);
 },60000);
 it('reports portfolio/account parity, true zero for an empty response, and CSV uses the same projection',async()=>{
  const view=body(await call('GET',`/v2/campaigns?from=${shiftMetaDay(day(),-89)}&to=${day()}&currency=MXN`)),r=view.report;
  expect(r.summary).toMatchObject({spend_minor:9000,sales:0,attributed_sales:0,ctr:10,cpc_minor:10,cpm_minor:1000});
  expect(r.groups.accounts.find((a:any)=>a.id==='act_222')).toMatchObject({spend_minor:0,roas:null,impressions:'0',clicks:'0',conversations:null});
  expect(r.groups.portfolios.map((p:any)=>p.spend_minor).sort()).toEqual([0,9000]);
  const csv=await call('GET',`/v2/campaigns/export?from=${shiftMetaDay(day(),-89)}&to=${day()}&currency=MXN`);expect(csv.statusCode).toBe(200);expect(csv.body).toBe(campaignCsv(r));
  expect((await call('GET',`/v2/campaigns?from=${day()}&to=${day()}&portfolio_id=200&meta_ad_account_id=act_111`)).statusCode).toBe(400);
  expect((await call('GET',`/v2/campaigns?from=${day()}&to=${day()}&portfolio_id=100`,undefined,two)).statusCode).toBe(404);
 });
 it('does not hide a healthy account when another loses coverage or has an incompatible calendar',async()=>{
  await admin.query("DELETE FROM meta_insight_coverage WHERE workspace_id=$1 AND meta_ad_account_id='act_222' AND day=$2",[one,day()]);
  const r=body(await call('GET',`/v2/campaigns?from=${day()}&to=${day()}`)).report;
  expect(r.summary.spend_minor).toBeNull();expect(r.groups.accounts.find((a:any)=>a.id==='act_111').spend_minor).toBe(100);expect(r.groups.portfolios.find((a:any)=>a.id==='200').spend_minor).toBeNull();
  await admin.query("UPDATE meta_insight_accounts SET timezone='America/New_York' WHERE workspace_id=$1 AND meta_ad_account_id='act_222'",[one]);
  const mixed=body(await call('GET',`/v2/campaigns?from=${day()}&to=${day()}`)).report;expect(mixed.quality.blockers).toContain('MIXED_TIMEZONES');expect(mixed.summary.roas).toBeNull();
  await admin.query("UPDATE meta_insight_accounts SET timezone='America/Mexico_City' WHERE workspace_id=$1",[one]);
 });
 it('uses durable operation IDs, closes the third abandoned lease, and retries without duplicating facts',async()=>{
  const input={operationId:randomUUID(),from:day(),to:day(),meta_ad_account_id:'act_111'},a=body(await call('POST','/v2/meta/sync',input));expect(body(await call('POST','/v2/meta/sync',input)).id).toBe(a.id);
  expect((await call('POST','/v2/meta/sync',{...input,meta_ad_account_id:'act_222'})).statusCode).toBe(409);
  await admin.query("UPDATE meta_read_tasks SET status='RUNNING',attempts=3,lease_token=$3,lease_until=now()-interval '1 minute' WHERE workspace_id=$1 AND operation_id=$2",[one,a.id,randomUUID()]);
  await scoped(()=>withWorkerProfilePhase(claimMetaPortfolioTask));expect(body(await call('GET','/v2/meta/operations/'+a.id)).status).toBe('UNAVAILABLE');
  body(await call('POST','/v2/meta/operations/'+a.id+'/retry',{}));await drain();expect(body(await call('GET','/v2/meta/operations/'+a.id)).status).toBe('SYNCED');
  expect((await admin.query("SELECT count(*)::int n FROM meta_insight_days WHERE workspace_id=$1 AND meta_ad_account_id='act_111' AND level='ad'",[one])).rows[0].n).toBe(90);
 });
 it('reactivates only cancelled tasks in the same credential revision and excludes deselected portfolios by default',async()=>{
  const input={operationId:randomUUID(),from:day(),to:day(),meta_ad_account_id:'act_222'},op=body(await call('POST','/v2/meta/sync',input)),id=credentials[1]!.id;
  body(await call('POST',`/v2/meta/connections/${id}/state`,{expectedRevision:1,enabled:false}));expect(body(await call('GET','/v2/meta/operations/'+op.id)).status).toBe('CANCELLED');
  body(await call('POST',`/v2/meta/connections/${id}/state`,{expectedRevision:1,enabled:true}));expect(body(await call('GET','/v2/meta/operations/'+op.id)).status).toBe('PENDING');
  let p=body(await call('GET','/v2/meta')).portfolios.find((p:any)=>p.id==='200');body(await call('PATCH','/v2/meta/portfolios/200',{expectedVersion:p.version,selected:false}));
  const r=body(await call('GET',`/v2/campaigns?from=${day()}&to=${day()}`)).report;expect(r.groups.accounts.map((a:any)=>a.id)).toEqual(['act_111']);expect(r.summary.spend_minor).toBe(100);
  p=body(await call('GET','/v2/meta')).portfolios.find((p:any)=>p.id==='200');body(await call('PATCH','/v2/meta/portfolios/200',{expectedVersion:p.version,selected:true}));await drain();
  expect(body(await call('GET','/v2/meta/operations/'+op.id)).status).toBe('SYNCED');
  const count=(await admin.query('SELECT count(*)::int n FROM meta_read_tasks WHERE workspace_id=$1 AND operation_id=$2',[one,op.id])).rows[0].n;body(await call('POST','/v2/meta/sync',input));expect((await admin.query('SELECT count(*)::int n FROM meta_read_tasks WHERE workspace_id=$1 AND operation_id=$2',[one,op.id])).rows[0].n).toBe(count);
 });
 it('persists 429 cooldown and can resume after a restart with a fresh reader',async()=>{
  const op=body(await call('POST','/v2/meta/sync',{operationId:randomUUID(),from:day(),to:day(),meta_ad_account_id:'act_222'}));
  await scoped(()=>processMetaPortfolioTask(async()=>Response.json({error:{code:4}},{status:429,headers:{'retry-after':'120'}})));
  const t=(await admin.query('SELECT status,issue FROM meta_read_tasks WHERE workspace_id=$1 AND operation_id=$2',[one,op.id])).rows[0];expect(t).toMatchObject({status:'PENDING',issue:{code:'META_RATE_LIMIT'}});
  await admin.query('UPDATE meta_connections SET cooldown_until=NULL WHERE workspace_id=$1',[one]);await admin.query("UPDATE meta_read_tasks SET next_attempt_at=now() WHERE workspace_id=$1 AND operation_id=$2",[one,op.id]);await drain();expect(body(await call('GET','/v2/meta/operations/'+op.id)).status).toBe('SYNCED');
 });
 it('rotates A during a read without committing that page or affecting B, and fences ciphertext',async()=>{
  const a=credentials[0]!,op=body(await call('POST','/v2/meta/sync',{operationId:randomUUID(),from:day(),to:day(),meta_ad_account_id:'act_111'}));
  await scoped(()=>processMetaPortfolioTask(async(input,init)=>{body(await call('PUT',`/v2/meta/connections/${a.id}/token`,{alias:'Rotated A',expectedRevision:1,token:a.token}));return graph(input,init);}));
  expect(body(await call('GET','/v2/meta/operations/'+op.id)).status).toBe('CANCELLED');
  expect(body(await call('GET','/v2/meta')).connections.find((c:any)=>c.id===credentials[1]!.id).state).toBe('VERIFIED');
  await expect(withProfileTransaction(api,one,async db=>{await bindProfileEnvironment(db,'REAL');return db.query('SELECT ciphertext FROM meta_connection_versions');})).rejects.toThrow(/permission denied/);
  await expect(scoped(()=>withWorkerProfilePhase(db=>readMetaConnectionToken(db,a.id,2)),two)).rejects.toThrow('META_CREDENTIAL_CHANGED');
  const serialized=JSON.stringify((await admin.query('SELECT request FROM meta_read_operations WHERE workspace_id=$1',[one])).rows);for(const c of credentials)expect(serialized).not.toContain(c.token);
 });
 it('ignores an expired-token response from a rotated revision without poisoning its replacement work',async()=>{
  await drain();const a=credentials[0]!,op=body(await call('POST','/v2/meta/sync',{operationId:randomUUID(),from:day(),to:day(),meta_ad_account_id:'act_111'}));let replacement:any;
  await scoped(()=>processMetaPortfolioTask(async()=>{replacement=body(await call('PUT',`/v2/meta/connections/${a.id}/token`,{alias:'Rotated again',expectedRevision:2,token:a.token}));return Response.json({error:{code:190}},{status:400});}));
  expect(body(await call('GET','/v2/meta/operations/'+op.id)).status).toBe('CANCELLED');
  expect(body(await call('GET','/v2/meta')).connections.find((c:any)=>c.id===a.id)).toMatchObject({revision:3,state:'VERIFIED'});
  expect(body(await call('GET','/v2/meta/operations/'+replacement.operationId))).toMatchObject({status:'PENDING',pending:1,failed:0});
  expect((await admin.query("SELECT status FROM meta_insight_accounts WHERE workspace_id=$1 AND meta_ad_account_id='act_111'",[one])).rows[0].status).toBe('SYNCED');
  await drain();expect(body(await call('GET','/v2/meta/operations/'+replacement.operationId)).status).toBe('SYNCED');
 });
 it('loads five portfolios with fifteen accounts and keeps all counts complete across pages',async()=>{
  const id=randomUUID();body(await call('PUT',`/v2/meta/connections/${id}/token`,{alias:'Volume fixture',expectedRevision:0,token:credentials[2]!.token},two));
  const inventory=Array.from({length:15},(_,n)=>({id:'act_'+(1000+n),name:'Repeated label',currency:'MXN',timezone_name:'America/Mexico_City',business:{id:String(700+Math.floor(n/3)),name:'Synthetic volume'}}));
  const volume:typeof fetch=async(input,init)=>{const u=new URL(String(input));if(u.pathname.endsWith('/me/adaccounts')){const start=Number(u.searchParams.get('after')??0),next=start+2;return Response.json({data:inventory.slice(start,next),...(next<15?{paging:{next:`https://graph.facebook.com/v26.0/me/adaccounts?after=${next}`,cursors:{after:String(next)}}}:{})});}return graph(input,init);};
  const drainVolume=()=>scoped(async()=>{let n=0;while(n++<1000&&await processMetaPortfolioTask(volume));expect(n).toBeLessThan(1000);},two);
  await drainVolume();let v=body(await call('GET','/v2/meta',undefined,two));expect(v.counts).toMatchObject({discoveredPortfolios:5,storedAccounts:15});
  for(const p of v.portfolios)body(await call('PATCH','/v2/meta/portfolios/'+p.id,{expectedVersion:p.version,selected:true},two));
  const start=performance.now(),queryStart=dbQueries;await scoped(()=>withWorkerProfilePhase(scheduleMetaPortfolioReads),two);await drainVolume();
  v=body(await call('GET','/v2/meta',undefined,two));expect(v.counts).toMatchObject({selectedPortfolios:5,includedAccounts:15,syncedAccounts:15});expect(v.accounts.every((a:any)=>a.coveredDays===90)).toBe(true);
  const reportStart=performance.now(),r=body(await call('GET',`/v2/campaigns?from=${shiftMetaDay(day(),-89)}&to=${day()}`,undefined,two)).report;
  expect(r.groups.portfolios).toHaveLength(5);expect(r.groups.accounts).toHaveLength(15);expect(r.summary.spend_minor).toBe(135000);
  writeFileSync(evidencePath('v73-meta-volume.json'),JSON.stringify({dbQueries:dbQueries-queryStart,fixture:'v73-meta-volume',portfolios:5,accounts:15,accountDays:1350,loadMs:Math.round(reportStart-start),reportMs:Math.round(performance.now()-reportStart),rssMiB:Math.round(process.memoryUsage().rss/1048576),externalCalls:0},null,2));
 },60000);

});
