import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {fixtureProfilesIn} from '../support/profile-fixture.js';
import {fixtureProfiles} from '../support/profile-fixture.js';
import pg from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {execFile,spawn,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readFileSync,readdirSync,realpathSync} from 'node:fs';
import {setTimeout as pause} from 'node:timers/promises';
import type {FastifyInstance} from 'fastify';

// A new database per file prevents the real worker from consuming other fixtures.
const original=process.env.DATABASE_URL!;
const control=new pg.Pool({connectionString:original});
const database='copy_hold_'+randomUUID().replaceAll('-','');
const ownerUrl=new URL(original);ownerUrl.pathname='/'+database;
const apiUrl=new URL(ownerUrl);apiUrl.searchParams.set('options','-c role=commerce_api -c application_name=copy-hold-api');
const workerUrl=new URL(ownerUrl);workerUrl.searchParams.set('options','-c role=commerce_channel -c application_name=copy-hold-worker');
const root=fileURLToPath(new URL('../../',import.meta.url));
const migration=realpathSync(fileURLToPath(new URL('../../packages/db/src/migrate.ts',import.meta.url)));
const workerFixture=fileURLToPath(new URL('../fixtures/copy-release-hold-worker.ts',import.meta.url));
const execute=promisify(execFile),workspace='copy-hold-'+randomUUID(),user=randomUUID();
// V7 F2: fixture workspaces are adopted profiles (max three per installation).
beforeAll(()=>fixtureProfiles(workspace));
let app:FastifyInstance,admin:pg.Pool,pool:pg.Pool,token:string,created=false,changed=false;
let putRecord:typeof import('../../packages/db/src/index.js').putRecord;
let defaultPolicy:typeof import('../../packages/contracts/src/index.js').defaultOperationalSettings;
const processes=new Set<ChildProcess>();

beforeAll(async()=>{
 await control.query(`CREATE DATABASE "${database}" TEMPLATE template0`);created=true;
 await execute(process.execPath,['--import','tsx',migration],{cwd:root,env:{...process.env,DATABASE_URL:ownerUrl.toString()},timeout:30000});
 admin=new pg.Pool({connectionString:ownerUrl.toString()});
 process.env.DATABASE_URL=apiUrl.toString();changed=true;vi.resetModules();
 const db=await import('../../packages/db/src/index.js');pool=db.pool;putRecord=db.putRecord;
 expect((await pool.query('SELECT current_user role')).rows[0].role).toBe('commerce_api');
 defaultPolicy=(await import('../../packages/contracts/src/index.js')).defaultOperationalSettings;
 const personal=await import('../../packages/db/src/personal-access-tokens.js');token=personal.newPersonalToken();
 await admin.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[user,'Synthetic hold owner',user+'@example.invalid']);
 await fixtureProfilesIn(admin,workspace);// V7 F2: memberships belong to an adopted profile.
 await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[user,workspace]);
 await personal.insertPersonalToken(admin,{workspace_id:workspace,user_id:user,name:'Synthetic hold owner API',allowed_environments:['REAL'],expires_at:new Date(Date.now()+3600000).toISOString()},token);
 await admin.query("INSERT INTO operational_settings(workspace_id,environment,version,body,updated_by) VALUES($1,'REAL',1,$2,$3)",[workspace,{...defaultPolicy,allow_channel_onboarding:true},user]);
 await admin.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at) VALUES($1,'REAL',$2,'{}','synthetic-held-custody',now()+interval '1 hour')",[workspace,user]);
 await admin.query("INSERT INTO creative_budgets(id,workspace_id,environment,provider,limit_usd,max_units,reserved_usd,spent_usd,reserved_units,spent_units,authorization_source,actor_id,expires_at) VALUES($1,$2,'REAL','openai',20,1000,3,2,30,20,'synthetic-held-budget',$3,now()+interval '1 hour')",[randomUUID(),workspace,user]);
 await admin.query("INSERT INTO creative_global_budgets(workspace_id,limit_usd,external_status,external_reserved_usd,authorization_source,actor_id,expires_at) VALUES($1,20,'NONE',0,'synthetic-held-global-budget',$2,now()+interval '1 hour')",[workspace,user]);
 app=await(await import('../../apps/api/src/app.js')).createApp();
});
beforeEach(async()=>{
 await admin.query("UPDATE operational_settings SET release_hold=false,body=$2 WHERE workspace_id=$1 AND environment='REAL'",[workspace,{...defaultPolicy,allow_channel_onboarding:true}]);
 await admin.query("UPDATE commands SET status='FAILED',result='{\"synthetic_retired\":true}' WHERE workspace_id=$1 AND status='PENDING'",[workspace]);
});
afterAll(async()=>{
 for(const child of processes)if(child.exitCode===null)child.kill('SIGKILL');
 try{await app?.close();}finally{try{await pool?.end();await admin?.end();}finally{
  if(changed)process.env.DATABASE_URL=original;
  try{if(created)await control.query(`DROP DATABASE "${database}"`);}finally{await control.end();}
 }}
});
function request(method:any,path:string,payload?:any,key=randomUUID()){
 return app.inject({method,url:path+'?environment=REAL',payload,headers:{authorization:'Bearer '+token,'idempotency-key':key}});
}
async function fixture(){
 const account=await putRecord(admin,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Synthetic held account',provider:'waha',gateway_ref:'hold-'+randomUUID(),engine:'GOWS',status:'STOPPED',sending_enabled:false}});
 const session=(await admin.query('SELECT * FROM channel_sessions WHERE account_id=$1',[account.id])).rows[0];
 return{account,session};
}
async function pending(account:string,type='logout'){
 return(await admin.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key) VALUES($1,'REAL','channel_command',$2,$3,$4,$5) RETURNING *",[workspace,account,user,{type},randomUUID()])).rows[0];
}
async function hold(){
 const client=await admin.connect();
 await client.query('BEGIN');
 try{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`operations:${workspace}:REAL`]);
  await client.query("UPDATE operational_settings SET release_hold=true,release_hold_at=clock_timestamp() WHERE workspace_id=$1 AND environment='REAL'",[workspace]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function watched(){
 const tables=['records','record_versions','channel_sessions','session_ownership','commands','idempotency','domain_events','operational_settings','integration_settings','integration_setting_versions','integration_secrets','operation_authorizations','manual_controls','number_capacity_slots','number_operations','creative_budgets','creative_global_budgets'];
 const values:Record<string,unknown>={};
 for(const table of tables)values[table]=(await admin.query(`SELECT row_to_json(t) data FROM ${table} t WHERE workspace_id=$1 ORDER BY row_to_json(t)::text`,[workspace])).rows;
 return values;
}
async function waitFor(check:()=>Promise<boolean>,code:string){
 const until=Date.now()+5000;
 while(Date.now()<until){if(await check())return;await pause(10);}
 throw new Error(code);
}
function worker(mode:'held'|'inflight'|'media-inflight',account:string,jobs=false){
 const child=spawn(process.execPath,['--import','tsx',workerFixture],{cwd:root,env:{...process.env,DATABASE_URL:workerUrl.toString(),COPY_HOLD_FIXTURE:JSON.stringify({mode,workspace,account,jobs})},stdio:['ignore','pipe','pipe','ipc']});
 processes.add(child);let stdout='',stderr='';child.stdout!.on('data',data=>stdout+=String(data));child.stderr!.on('data',data=>stderr+=String(data));
 const done=new Promise<any>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>{processes.delete(child);if(code!==0)reject(new Error('SYNTHETIC_WORKER_EXIT_'+code+': '+stderr));else{try{resolve(JSON.parse(stdout.trim()));}catch(error){reject(error);}}});});
 void done.catch(()=>{});
 return{child,done,entered:new Promise<void>((resolve,reject)=>{child.once('error',reject);child.on('message',message=>{if((message as any)?.kind==='REMOTE_ENTERED')resolve();});})};
}
const integration=(type:'openai'|'waha',extra:Record<string,unknown>={})=>({expected_version:0,label:'Synthetic held integration',enabled:true,config:type==='waha'?{base_url:'http://waha-01:3000'}:{},secrets:type==='waha'?{api_key:'synthetic-fixture-key',webhook_secret:'synthetic-fixture-hook'}:{api_key:'synthetic-fixture-openai'},reason:'Synthetic integration hold regression',...extra});

describe('Copy release hold with real restricted roles and PostgreSQL locks',()=>{
 it('retains the API status boundary and every installed migration hash (68 historical + V7 0069-0100)',async()=>{
  expect((await pool.query("SELECT has_column_privilege(current_user,'commands','status','UPDATE') allowed")).rows[0].allowed).toBe(false);
  const history=(await admin.query('SELECT name,sha256 FROM schema_migrations ORDER BY name')).rows;
  const directory=new URL('../../packages/db/migrations/',import.meta.url);
  const expected=readdirSync(directory).filter(name=>name.endsWith('.sql')).sort().map(name=>({name,sha256:createHash('sha256').update(readFileSync(new URL(name,directory))).digest('hex')}));
  expect(history).toHaveLength(100);expect(history).toEqual(expected);
 });
 it('rejects channel/setup/catalog/number and all integration mutations while held without domain delta',async()=>{
  const f=await fixture();await hold();const before=await watched();
  const requests:[any,string,any][]=[
   ['POST',`/v1/channel-accounts/${f.account.id}/commands`,{type:'connect',expected_version:f.account.version,reason:'Synthetic held connect'}],
   ['PATCH',`/v1/channel-accounts/${f.account.id}/setup`,{expected_version:f.account.version,product_id:randomUUID(),offer_version_id:randomUUID(),workflow_version_id:randomUUID(),reason:'Synthetic held setup'}],
   ['PATCH',`/v1/channel-accounts/${f.account.id}`,{expected_version:f.account.version,name:'Synthetic held edit'}],
   ['POST','/v1/numbers',{alias:'Synthetic held alias',responsible:'Synthetic responsible',device_ref:'synthetic-device'}],
   ['PUT','/v1/settings/integrations/openai:default',integration('openai')],
   ['PUT','/v1/settings/integrations/waha:hold',integration('waha')],
   ['POST','/v1/settings/integrations/waha:hold/disable',{expected_version:1,reason:'Synthetic held disable'}],
   ['PATCH','/v1/settings/operations',{expected_version:1,changes:{allow_channel_onboarding:false},reason:'Synthetic held policy'}],
   ['GET',`/v1/channel-accounts/${f.account.id}/qr`,undefined],
  ];
  const fetchMock=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('SYNTHETIC_NETWORK_FORBIDDEN'));
  try{for(const[method,path,input]of requests){const r=await request(method,path,input);expect(r.statusCode,r.body).toBe(409);expect(r.json().error.code).toBe('RELEASE_HOLD_ACTIVE');}expect(fetchMock).not.toHaveBeenCalled();}finally{fetchMock.mockRestore();}
  expect(await watched()).toEqual(before);
 });
 it('leaves pending lifecycle/history/health commands unclaimed and suppresses worker health and QR factories',async()=>{
  const f=await fixture();for(const type of ['connect','logout','sync_inbox','check_health'])await pending(f.account.id,type);
  await hold();const before=await watched(),result=await worker('held',f.account.id).done;
  expect(result).toMatchObject({role:'commerce_channel',processed:0,factoryCalls:0,lifecycleCalls:0,healthCalls:0,qrCalls:0,networkAttempts:0,signals:0,qrStatus:409,qrCode:'RELEASE_HOLD_ACTIVE'});
  expect(await watched()).toEqual(before);
 });
 it('permits canonical cancellation and integration quarantine between publications when no hold is active',async()=>{
  const f=await fixture(),command=await pending(f.account.id);
  const profile=await request('PUT','/v1/settings/integrations/waha:phase',integration('waha'));
  expect(profile.statusCode,profile.body).toBe(200);
  const cancellation=await request('POST',`/v1/numbers/${f.account.id}/setup/commands`,{action:'cancel_pending',command_id:command.id,expected_version:f.account.version,expected_session_version:f.session.revision,reason:'Cancel fixture before next publication'});
  expect(cancellation.statusCode,cancellation.body).toBe(200);
  expect((await admin.query('SELECT status,result FROM commands WHERE id=$1',[command.id])).rows[0]).toMatchObject({status:'FAILED',result:{error:'CHANNEL_COMMAND_CANCELLED_BEFORE_EXECUTION',remote_outcome:'NOT_ATTEMPTED'}});
  const disabled=await request('POST','/v1/settings/integrations/waha:phase/disable',{expected_version:1,reason:'Quarantine fixture before next publication'});
  expect(disabled.statusCode,disabled.body).toBe(200);expect(disabled.json().data).toMatchObject({enabled:false,changed:true});
 });
 it('leaves held identity and group jobs unclaimed without factory, remote reads or database delta',async()=>{
  const f=await fixture();
  for(const[action,input]of [['IDENTITY_OBSERVE',{account_id:f.account.id}],['GROUP_REFRESH',{account_ids:[f.account.id]}]] as const)
   await admin.query("INSERT INTO number_operations(workspace_id,environment,actor_id,action,state,input) VALUES($1,'REAL',$2,$3,'REQUESTED',$4)",[workspace,user,action,input]);
  await hold();const before=await watched(),result=await worker('held',f.account.id,true).done;
  expect(result).toMatchObject({role:'commerce_channel',processed:0,numberProcessed:0,factoryCalls:0,lifecycleCalls:0,healthCalls:0,qrCalls:0,profileCalls:0,groupCalls:0,networkAttempts:0});
  expect(await watched()).toEqual(before);
 });
 it('defers held REAL inbound media without consuming its retry budget or persisting a terminal receipt',async()=>{
  const f=await fixture(),event=randomUUID();
  await admin.query("INSERT INTO domain_events(id,workspace_id,environment,event_type,aggregate_id,correlation_id,payload) VALUES($1,$2,'REAL','provider.media.observed',$3,$4,$5)",[event,workspace,f.account.id,randomUUID(),{media:{providerId:'synthetic-held-pdf'}}]);
  await hold();const before=await watched();
  const receiptsBefore=(await admin.query('SELECT * FROM consumer_receipts ORDER BY consumer,event_id')).rows;
  const result=await worker('held',f.account.id).done;
  expect(result).toMatchObject({mediaCalls:0,factoryCalls:0,networkAttempts:0});
  expect(await watched()).toEqual(before);
  expect((await admin.query('SELECT * FROM consumer_receipts ORDER BY consumer,event_id')).rows).toEqual(receiptsBefore);
 });
 it('rechecks hold before media failure persistence after the protected provider finishes',async()=>{
  const f=await fixture(),event=randomUUID();
  await admin.query("INSERT INTO domain_events(id,workspace_id,environment,event_type,aggregate_id,correlation_id,payload) VALUES($1,$2,'REAL','provider.media.observed',$3,$4,$5)",[event,workspace,f.account.id,randomUUID(),{media:{providerId:'synthetic-inflight-pdf'}}]);
  const before=await watched(),receipts=(await admin.query('SELECT * FROM consumer_receipts ORDER BY consumer,event_id')).rows;
  const running=worker('media-inflight',f.account.id),client=await admin.connect();let started=false;
  try{
   await running.entered;await client.query('BEGIN');started=true;
   const rootPid=(await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const waiting=client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`operations:${workspace}:REAL`]);
   await waitFor(async()=>Number((await admin.query("SELECT count(*) n FROM pg_stat_activity WHERE datname=$1 AND application_name='copy-hold-worker' AND pid=ANY(pg_blocking_pids($2))",[database,rootPid])).rows[0].n)>0,'ROOT_DID_NOT_WAIT_FOR_MEDIA_PROVIDER');
   running.child.send({kind:'RELEASE_SYNTHETIC_SDK'});await waiting;
   await client.query("UPDATE operational_settings SET release_hold=true,release_hold_at=clock_timestamp() WHERE workspace_id=$1 AND environment='REAL'",[workspace]);await client.query('COMMIT');started=false;
   expect(await running.done).toMatchObject({mediaCalls:1,factoryCalls:1,networkAttempts:0});
   const after=await watched();delete before.operational_settings;delete after.operational_settings;expect(after).toEqual(before);
   expect((await admin.query('SELECT * FROM consumer_receipts ORDER BY consumer,event_id')).rows).toEqual(receipts);
  }finally{if(started)await client.query('ROLLBACK');client.release();if(running.child.exitCode===null)running.child.kill('SIGKILL');}
 });
 it('makes a queued API operation observe Root hold after the exclusive lock commits, with zero command writes',async()=>{
  const f=await fixture(),client=await admin.connect();
  try{
   await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`operations:${workspace}:REAL`]);
   const rootPid=(await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const before=await watched(),pendingRequest=request('POST',`/v1/channel-accounts/${f.account.id}/commands`,{type:'connect',reason:'Queued synthetic request'});
   // LightMyRequest starts lazily; attaching the continuation actually queues it.
   const resultPromise=Promise.resolve(pendingRequest);
   await waitFor(async()=>Number((await admin.query("SELECT count(*) n FROM pg_stat_activity WHERE datname=$1 AND application_name='copy-hold-api' AND $2=ANY(pg_blocking_pids(pid))",[database,rootPid])).rows[0].n)>0,'API_DID_NOT_WAIT_ON_CANONICAL_OPERATIONS_LOCK');
   await client.query("UPDATE operational_settings SET release_hold=true,release_hold_at=clock_timestamp() WHERE workspace_id=$1 AND environment='REAL'",[workspace]);await client.query('COMMIT');
   const r=await resultPromise;expect(r.statusCode,r.body).toBe(409);expect(r.json().error.code).toBe('RELEASE_HOLD_ACTIVE');
   const after=await watched();delete before.operational_settings;delete after.operational_settings;expect(after).toEqual(before);
  }finally{await client.query('ROLLBACK');client.release();}
 });
 it('makes Root wait for a provider lifecycle protected by SHARE, then blocks every later call',async()=>{
  const f=await fixture();await pending(f.account.id,'logout');const running=worker('inflight',f.account.id);
  const client=await admin.connect();let started=false;
  try{
   await running.entered;await client.query('BEGIN');started=true;
   const rootPid=(await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   const lockPromise=client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`operations:${workspace}:REAL`]);
   await waitFor(async()=>Number((await admin.query("SELECT count(*) n FROM pg_stat_activity WHERE datname=$1 AND application_name='copy-hold-worker' AND pid=ANY(pg_blocking_pids($2))",[database,rootPid])).rows[0].n)>0,'ROOT_DID_NOT_WAIT_FOR_INFLIGHT_PROVIDER_SHARE');
   running.child.send({kind:'RELEASE_SYNTHETIC_SDK'});await lockPromise;
   await client.query("UPDATE operational_settings SET release_hold=true,release_hold_at=clock_timestamp() WHERE workspace_id=$1 AND environment='REAL'",[workspace]);await client.query('COMMIT');started=false;
   expect(await running.done).toMatchObject({role:'commerce_channel',processed:1,lifecycleCalls:1,healthCalls:0,qrCalls:0,networkAttempts:0});
   expect((await admin.query("SELECT release_hold FROM operational_settings WHERE workspace_id=$1 AND environment='REAL'",[workspace])).rows[0].release_hold).toBe(true);
   await pending(f.account.id,'logout');const later=await worker('held',f.account.id).done;expect(later).toMatchObject({processed:0,factoryCalls:0,lifecycleCalls:0,healthCalls:0,qrCalls:0,networkAttempts:0});
  }finally{if(started)await client.query('ROLLBACK');client.release();if(running.child.exitCode===null)running.child.kill('SIGKILL');}
 });
});
