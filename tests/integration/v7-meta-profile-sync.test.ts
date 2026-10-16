import {randomBytes} from 'node:crypto';
import Fastify,{type FastifyInstance} from 'fastify';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {profileIntegrationRoutes} from '../../apps/api/src/profile-integrations.js';
import {campaignsV2Routes} from '../../apps/api/src/campaigns-v2.js';
import {processMetaProfileSync} from '../../apps/automation-worker/src/meta-profile-sync.js';
import {accountDay,processInsightJobs} from '../../apps/automation-worker/src/meta-insights.js';
import {withProfileTransaction,type ProfilePool} from '../../packages/db/src/profile-context.js';
import {createProfileWorkerRuntime} from '../../packages/db/src/profile-worker-scope.js';
import {bindProfileEnvironment} from '../../packages/db/src/profile-environment.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../packages/domain/src/core/profile-authorization.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {fixtureProfileRow,requireMigratedProfileSchema} from '../support/migrated-database.js';

// V7 RF-11 (D-06): each profile reads its own Meta accounts with its own token,
// GET only, inside its WorkerScope; the owner may ask for a fresh read.
const suffix=randomBytes(8).toString('hex'),apiLogin='meta_sync_api_'+suffix,origin='https://commerce.example.test';
const created:string[]=[],one='meta-sync-one-'+suffix,two='meta-sync-two-'+suffix;
const users={owner:'owner-'+suffix,operator:'operator-'+suffix,other:'other-'+suffix};
const token='EAAG'+randomBytes(24).toString('hex');
let admin:pg.Pool,api:pg.Pool,native:pg.Pool,app:FastifyInstance,graphCalls:{path:string;method:string;bearer:string}[]=[];
type Kind='session'|'personal_token';
async function authority(db:{query:(s:string,v?:unknown[])=>Promise<{rows:any[]}>},workspace:string,user:string,kind:Kind):Promise<ProfileAuthority>{
 const m=(await db.query('SELECT role,active,version FROM memberships WHERE workspace_id=$1 AND user_id=$2',[workspace,user])).rows[0];
 const p=(await db.query('SELECT state FROM profiles WHERE id=$1',[workspace])).rows[0];
 if(!m||!p)throw Object.assign(Error('PROFILE_MEMBERSHIP_REQUIRED'),{code:'PROFILE_MEMBERSHIP_REQUIRED',statusCode:403});
 return{profile:{id:workspace,state:p.state},membership:{userId:user,workspaceId:workspace,role:m.role,active:m.active,version:m.version},
  credential:{kind,userId:user,workspaceId:workspace,revoked:false,expiresAt:new Date(Date.now()+3600000).toISOString(),scopes:[],membershipVersion:m.version}};
}
const run=async(user:string,fence:{workspaceId:string},environment:'REAL'|'SIMULATION',action:any,work:any)=>withProfileTransaction(api,fence.workspaceId,async db=>{
 const auth=await authority(db,fence.workspaceId,user,'session');
 try{authorizeProfileAction(auth,{...action,workspaceId:fence.workspaceId},new Date());}catch(error){throw Object.assign(error as Error,{statusCode:403,code:(error as {code:string}).code});}
 await bindProfileEnvironment(db,environment);
 return work({db,profile:{authority:auth},environment});
});
function call(method:string,url:string,user:string,workspace:string,body?:unknown){
 return app.inject({method:method as 'GET',url,headers:{origin,'x-user':user,'x-commerce-profile-id':workspace,'x-commerce-profile-version':'1',...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{payload:JSON.stringify(body)}:{})});
}
const rolePool=(pool:pg.Pool,role:string):ProfilePool=>({async connect(){const c=await pool.connect();await c.query('SET ROLE '+role);return{query:c.query.bind(c),release:(e?:Error)=>{void c.query('RESET ROLE').finally(()=>c.release(e));}};}});
const workers=()=>createProfileWorkerRuntime(rolePool(native,'commerce_automation'),'commerce_automation','REAL');
const today=()=>accountDay('America/Mexico_City',new Date());
/** Official Graph GET fixtures; anything else fails the test. */
const graph:typeof fetch=async(input,init)=>{
 const url=new URL(String(input)),bearer=String((init?.headers as Record<string,string>)?.Authorization??'');graphCalls.push({path:url.pathname,method:String(init?.method),bearer});
 if(init?.method!=='GET')throw Error('NON_GET_META_CALL');
 if(url.pathname==='/v26.0/me/adaccounts')return Response.json({data:[{id:'act_123',name:'Synthetic account',currency:'MXN',timezone_name:'America/Mexico_City'}]});
 if(url.pathname==='/v26.0/act_123/ads')return Response.json({data:[{id:'55',name:'Synthetic ad',campaign_id:'44',adset_id:'66',campaign:{name:'Synthetic campaign'}}]});
 if(url.pathname==='/v26.0/act_123/insights'){const day=today(),range=JSON.parse(url.searchParams.get('time_range')!);expect(range.until).toBe(day);
  return Response.json({data:[{account_id:'123',account_currency:'MXN',date_start:day,date_stop:day,campaign_id:'44',campaign_name:'Synthetic campaign',ad_id:'55',ad_name:'Synthetic ad',adset_id:'66',spend:'100.00',impressions:'1000',clicks:'20',actions:[{action_type:'onsite_conversion.messaging_conversation_started_7d',value:'5'}]}]});}
 throw Error('UNEXPECTED_META_PATH');
};
const jobs=async(workspace:string)=>(await admin.query("SELECT id,status,request,result,attempts FROM meta_insight_jobs WHERE workspace_id=$1 ORDER BY created_at",[workspace])).rows;

describe('V7 Meta read sync with the profile credential',()=>{
 beforeAll(async()=>{
  vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:4});await requireMigratedProfileSchema(admin);
  native=new pg.Pool({connectionString:url.toString(),max:4});
  const password=randomBytes(24).toString('hex');
  await admin.query(`CREATE ROLE "${apiLogin}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;GRANT commerce_api TO "${apiLogin}"`);
  const u=new URL(url);u.username=apiLogin;u.password=password;api=new pg.Pool({connectionString:u.toString(),max:4});api.on('connect',c=>{void c.query('SET ROLE commerce_api');});
  for(const id of [one,two])await fixtureProfileRow(admin,created,id,{businessName:'Synthetic '+id,numbers:0});
  for(const [user,role,workspace] of [[users.owner,'owner',one],[users.operator,'operator',one],[users.other,'owner',two]] as const){
   await admin.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true) ON CONFLICT DO NOTHING',[user,user+'@example.test']);
   await admin.query('INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,$3)',[user,workspace,role]);
  }
  app=Fastify({logger:false});
  app.setErrorHandler((e:any,_r,reply)=>reply.code(e.statusCode??500).send({error:{code:e.code??e.message}}));
  const deps={origins:[origin],nativeSession:async(req:any)=>({id:'session-'+req.headers['x-user'],userId:String(req.headers['x-user'])}),
   session:(s:any,f:any,e:any,a:any,w:any)=>run(s.userId,f,e,a,w),personal:async()=>{throw Object.assign(Error('unused'),{statusCode:500});}};
  await app.register(async scoped=>{
   await profileIntegrationRoutes(scoped,{request:deps,metaFetcher:async u=>{const path=new URL(String(u)).pathname;return Response.json(path.endsWith('/me/permissions')?{data:[{permission:'ads_read',status:'granted'}]}:{id:'synthetic'});}});
   await campaignsV2Routes(scoped,deps);
  });
  await app.ready();
  expect((await call('PUT','/v2/integrations/meta/token',users.owner,one,{expectedRevision:0,token})).json().data.check).toEqual({state:'VERIFIED'});
 },60000);
 afterAll(async()=>{await app?.close();await api?.end();await native?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${apiLogin}"`);}finally{await admin.end();}}vi.unstubAllEnvs();});

 it('shows a connected profile with no accounts read yet, and the unconnected one points to Integraciones',async()=>{
  const day=today(),connected=(await call('GET',`/v2/campaigns?from=${day}&to=${day}`,users.owner,one)).json().data;
  expect(connected).toMatchObject({connected:true,accounts:[],report:null,read_only:true,sync:{credential:'VERIFIED',last_sync:null}});expect(connected.note).toContain('primera vez');
  expect((await call('GET',`/v2/campaigns?from=${day}&to=${day}`,users.other,two)).json().data).toMatchObject({connected:false,sync:{credential:'MISSING'}});
 });

 it('lets only the owner ask for a read, once at a time, and only with a verified token',async()=>{
  expect((await call('POST','/v2/campaigns/sync',users.operator,one,{})).statusCode).toBe(403);
  const none=await call('POST','/v2/campaigns/sync',users.other,two,{});expect(none.statusCode).toBe(409);expect(none.json().error.code).toBe('META_NOT_CONNECTED');
  expect((await call('POST','/v2/campaigns/sync?from=x',users.owner,one,{})).statusCode).toBe(400);
  const first=(await call('POST','/v2/campaigns/sync?environment=REAL',users.owner,one,{})).json().data;expect(first).toMatchObject({status:'QUEUED',read_only:true});
  expect((await call('POST','/v2/campaigns/sync',users.owner,one,{})).json().data).toEqual({status:'ALREADY_QUEUED',jobId:first.jobId,read_only:true});
  const [job]=await jobs(one);expect(job.request).toEqual({source:'V7_PROFILE',lookback_days:7,credential_revision:1,scheduled:false});expect(JSON.stringify(job)).not.toContain(token);
  expect((await admin.query("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND event_type='profile.campaigns.sync_requested'",[one])).rows[0].n).toBe(1);
 });

 it('leaves V7 jobs to the profile worker: the V5 loop never claims them',async()=>{
  await processInsightJobs();expect((await jobs(one)).map(j=>j.status)).toEqual(['PENDING']);
 });

 it('reads with GET only and the profile token, persists only that profile and needs no transaction during the reads',async()=>{
  graphCalls=[];
  const result=await processMetaProfileSync({runtime:workers(),fetcher:graph});
  expect(result.profiles).toEqual(expect.arrayContaining([{profile:one,status:'SYNCED'},{profile:two,status:'IDLE'}]));
  expect(graphCalls.length).toBeGreaterThanOrEqual(4);expect(graphCalls.every(c=>c.method==='GET'&&c.bearer==='Bearer '+token)).toBe(true);
  const [job]=await jobs(one);expect(job).toMatchObject({status:'SYNCED',attempts:1,result:{status:'SYNCED',succeeded:1,external_mutations:0,source:'META_API'}});expect(JSON.stringify(job)).not.toContain(token);
  expect((await admin.query("SELECT workspace_id,level,spend_minor::int,conversations::int FROM meta_insight_days ORDER BY level")).rows).toEqual([
   {workspace_id:one,level:'ad',spend_minor:10000,conversations:5},{workspace_id:one,level:'campaign',spend_minor:10000,conversations:5}]);
  const day=today(),view=(await call('GET',`/v2/campaigns?from=${day}&to=${day}&currency=MXN`,users.owner,one)).json().data;
  expect(view).toMatchObject({connected:true,accounts:[{id:'act_123',currency:'MXN',status:'SYNCED'}],sync:{credential:'VERIFIED',last_sync:{status:'SYNCED',issues:[]}}});
  expect(view.report.summary.spend_minor).toBe(10000);
  expect((await call('GET',`/v2/campaigns?from=${day}&to=${day}`,users.other,two)).json().data.accounts).toEqual([]);
 });

 it('schedules hourly, not on every loop, and never for a profile without a verified token',async()=>{
  graphCalls=[];await processMetaProfileSync({runtime:workers(),fetcher:graph});
  expect(graphCalls).toEqual([]);expect(await jobs(one)).toHaveLength(1);expect(await jobs(two)).toHaveLength(0);
  await admin.query("UPDATE meta_insight_jobs SET created_at=created_at-interval '61 minutes' WHERE workspace_id=$1",[one]);
  await processMetaProfileSync({runtime:workers(),fetcher:graph});
  const all=await jobs(one);expect(all).toHaveLength(2);expect(all[1]).toMatchObject({status:'SYNCED',request:{source:'V7_PROFILE',scheduled:true}});
 });

 it('cancels a queued read when the token changed, without calling Meta, and stops when Meta is disabled',async()=>{
  const queued=(await call('POST','/v2/campaigns/sync',users.owner,one,{})).json().data;expect(queued.status).toBe('QUEUED');
  expect((await call('PUT','/v2/integrations/meta/token',users.owner,one,{expectedRevision:1,token:'EAAG'+randomBytes(24).toString('hex')})).json().data.check).toEqual({state:'VERIFIED'});
  graphCalls=[];await processMetaProfileSync({runtime:workers(),fetcher:graph});expect(graphCalls).toEqual([]);
  expect((await admin.query('SELECT status,result FROM meta_insight_jobs WHERE id=$1',[queued.jobId])).rows[0]).toMatchObject({status:'CANCELLED',result:{issues:[{code:'META_CREDENTIAL_CHANGED'}]}});
  expect((await call('POST','/v2/integrations/meta/state',users.owner,one,{expectedRevision:2,enabled:false})).statusCode).toBe(200);
  await admin.query("UPDATE meta_insight_jobs SET created_at=created_at-interval '2 hours' WHERE workspace_id=$1",[one]);
  const before=(await jobs(one)).length;await processMetaProfileSync({runtime:workers(),fetcher:graph});expect(await jobs(one)).toHaveLength(before);
  expect((await call('POST','/v2/campaigns/sync',users.owner,one,{})).json().error.code).toBe('META_NOT_CONNECTED');
 });

 it('gives the automation role the ciphertext only inside the owning profile context',async()=>{
  const c=await native.connect();
  try{
   await c.query('BEGIN');await c.query('SET LOCAL ROLE commerce_automation');
   expect((await c.query('SELECT count(*)::int n FROM meta_profile_credential_versions')).rows[0].n).toBe(0);
   await c.query("SELECT set_config('app.workspace_id',$1,true)",[two]);expect((await c.query('SELECT count(*)::int n FROM meta_profile_credential_versions')).rows[0].n).toBe(0);
   await c.query("SELECT set_config('app.workspace_id',$1,true)",[one]);expect((await c.query('SELECT count(*)::int n FROM meta_profile_credential_versions')).rows[0].n).toBe(2);
   await c.query('SAVEPOINT s');await expect(c.query('SELECT key_hint FROM meta_profile_credential_versions')).rejects.toThrow(/permission denied/);await c.query('ROLLBACK TO SAVEPOINT s');
   await expect(c.query("UPDATE meta_profile_credentials SET enabled=true WHERE workspace_id=$1",[one])).rejects.toThrow(/permission denied/);
  }finally{await c.query('ROLLBACK');c.release();}
 });
});
