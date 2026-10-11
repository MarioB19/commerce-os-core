import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import type {FastifyInstance} from 'fastify';

// Never let a worker consume another integration file's pending commands.
// CI supplies only its existing disposable DATABASE_URL; no owner secret or local env is required.
const originalDatabaseUrl=process.env.DATABASE_URL!;
const control=new pg.Pool({connectionString:originalDatabaseUrl});
const database='cancel_race_'+randomUUID().replaceAll('-','');
const ownerUrl=new URL(originalDatabaseUrl);ownerUrl.pathname='/'+database;
const apiUrl=new URL(ownerUrl);apiUrl.searchParams.set('options','-c role=commerce_api');
const workerUrl=new URL(ownerUrl);workerUrl.searchParams.set('options','-c role=commerce_channel');
const root=fileURLToPath(new URL('../../',import.meta.url));
const migration=fileURLToPath(new URL('../../packages/db/src/migrate.ts',import.meta.url));
const workerFixture=fileURLToPath(new URL('../fixtures/cancel-race-worker.ts',import.meta.url));
const execute=promisify(execFile);
const workspace='cancel-race-'+randomUUID(),user=randomUUID();
let app:FastifyInstance,admin:pg.Pool,pool:pg.Pool,token:string;
let putRecord:typeof import('../../packages/db/src/index.js').putRecord;
let databaseCreated=false,environmentChanged=false;
const signature='public.cancel_pending_channel_command(text,text,uuid,uuid,text,text,integer,bigint)';
beforeAll(async()=>{
 await control.query(`CREATE DATABASE "${database}" TEMPLATE template0`);databaseCreated=true;
 await execute(process.execPath,['--import','tsx',migration],{cwd:root,env:{...process.env,DATABASE_URL:ownerUrl.toString()},timeout:30000});
 admin=new pg.Pool({connectionString:ownerUrl.toString()});
 // The real exported API pool is created under its restricted role, before any application import.
 process.env.DATABASE_URL=apiUrl.toString();environmentChanged=true;vi.resetModules();
 const db=await import('../../packages/db/src/index.js');pool=db.pool;putRecord=db.putRecord;
 expect((await pool.query('SELECT current_user role')).rows[0].role).toBe('commerce_api');
 const {insertPersonalToken,newPersonalToken}=await import('../../packages/db/src/personal-access-tokens.js');token=newPersonalToken();
 await admin.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[user,'Synthetic cancellation owner',user+'@example.invalid']);
 await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[user,workspace]);
 await insertPersonalToken(admin,{workspace_id:workspace,user_id:user,name:'Synthetic cancellation tests',allowed_environments:['REAL'],expires_at:new Date(Date.now()+3600000).toISOString()},token);
 const {createApp}=await import('../../apps/api/src/app.js');app=await createApp();
});
afterAll(async()=>{
 try{await app?.close();}finally{
  try{await pool?.end();await admin?.end();}finally{
   if(environmentChanged)process.env.DATABASE_URL=originalDatabaseUrl;
   try{if(databaseCreated)await control.query(`DROP DATABASE "${database}"`);}finally{await control.end();}
  }
 }
});
async function fixture(){
 const account=await putRecord(admin,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Synthetic race account',provider:'waha',gateway_ref:'race-'+randomUUID(),sending_enabled:false,status:'STOPPED'}});
 const session=(await admin.query('SELECT * FROM channel_sessions WHERE account_id=$1',[account.id])).rows[0];
 const command=(await admin.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key) VALUES($1,'REAL','channel_command',$2,$3,'{\"type\":\"logout\"}',$4) RETURNING *",[workspace,account.id,user,randomUUID()])).rows[0];
 const body={action:'cancel_pending',command_id:command.id,expected_version:account.version,expected_session_version:session.revision,reason:'Synthetic cancellation with restricted API role'};
 return{account,session,command,body};
}
function request(f:Awaited<ReturnType<typeof fixture>>,body=f.body,key=randomUUID()){
 return app.inject({method:'POST',url:'/v1/numbers/'+f.account.id+'/setup/commands?environment=REAL',payload:body,headers:{authorization:'Bearer '+token,'idempotency-key':key}});
}
async function saved(f:Awaited<ReturnType<typeof fixture>>){
 return{command:(await admin.query('SELECT * FROM commands WHERE id=$1',[f.command.id])).rows[0],
 session:(await admin.query('SELECT * FROM channel_sessions WHERE id=$1',[f.session.id])).rows[0],
 account:(await admin.query('SELECT * FROM records WHERE id=$1',[f.account.id])).rows[0],
 effects:Number((await admin.query('SELECT count(*) n FROM outbox WHERE account_id=$1',[f.account.id])).rows[0].n),
 audits:Number((await admin.query("SELECT count(*) n FROM domain_events WHERE aggregate_id=$1 AND event_type='number.setup.pending_cancelled'",[f.account.id])).rows[0].n)};
}
function worker(){
 const child=spawn(process.execPath,['--import','tsx',workerFixture],{cwd:root,env:{...process.env,DATABASE_URL:workerUrl.toString()},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>{stdout+=b;});child.stderr.on('data',b=>{stderr+=b;});
 const done=new Promise<{processed:number;providerCalls:number;networkAttempts:number;role:string}>((resolve,reject)=>{
  child.on('error',reject);child.on('exit',code=>{if(code!==0)return reject(new Error('SYNTHETIC_WORKER_FAILED:'+code+':'+stderr));try{resolve(JSON.parse(stdout.trim()));}catch{reject(new Error('SYNTHETIC_WORKER_RECEIPT_INVALID'));}});
 });
 // Attach a rejection handler immediately while PostgreSQL barriers are observed.
 // Awaiting `done` still surfaces the failure, without an unhandled process rejection.
 void done.catch(()=>{});
 return{child,done};
}
async function waiters(accountId:string,count:number){
 const deadline=performance.now()+10000;
 while(performance.now()<deadline){
  const rows=(await admin.query("SELECT pid,waitstart FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid AND objid=(hashtextextended($1,0)&4294967295)::oid AND objsubid=1 ORDER BY waitstart",['channel-command:'+accountId])).rows;
  if(rows.length===count){expect(rows.every(row=>row.waitstart)).toBe(true);return rows;}
  await pause(10); // Poll authoritative PostgreSQL lock state; elapsed time is not success.
 }
 throw new Error('POSTGRES_LOCK_QUEUE_NOT_OBSERVED:'+count);
}
async function operationalWaiter(blockingPid:number){
 const deadline=performance.now()+10000;
 while(performance.now()<deadline){
  const rows=(await admin.query("SELECT pid,waitstart,pg_blocking_pids(pid) blockers FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=((hashtextextended($1,0)>>32)&4294967295)::oid AND objid=(hashtextextended($1,0)&4294967295)::oid AND objsubid=1",['operations:'+workspace+':REAL'])).rows;
  const row=rows.find(candidate=>candidate.blockers.includes(blockingPid));
  if(row){expect(row.waitstart).toBeTruthy();expect(row.pid).not.toBe(blockingPid);return row;}
  await pause(10);
 }
 throw new Error('POSTGRES_OPERATIONAL_BLOCKER_NOT_OBSERVED:'+blockingPid);
}
async function hold(accountId:string){
 const client=await admin.connect();await client.query('BEGIN');
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['channel-command:'+accountId]);
 return{release:async()=>{await client.query('COMMIT');client.release();}};
}
describe('restricted PostgreSQL pending cancellation',()=>{
 it('keeps the generic status column forbidden and exposes only the scoped definer function',async()=>{
  const privileges=(await admin.query("SELECT has_column_privilege('commerce_api','commands','status','UPDATE') status_update,has_column_privilege('commerce_api','commands','result','UPDATE') result_update,has_function_privilege('commerce_api',$1,'EXECUTE') scoped_cancel,has_function_privilege('commerce_channel',$1,'EXECUTE') worker_execute,has_function_privilege('commerce_ingress',$1,'EXECUTE') ingress_execute",[signature])).rows[0];
  expect(privileges).toEqual({status_update:false,result_update:true,scoped_cancel:true,worker_execute:false,ingress_execute:false});
  expect((await admin.query("SELECT has_schema_privilege('commerce_api','public','CREATE') writable_public")).rows[0].writable_public).toBe(false);
  await expect(pool.query("UPDATE commands SET status='FAILED' WHERE false")).rejects.toMatchObject({code:'42501'});
 });
 it('cancellation wins the PostgreSQL advisory queue and the real worker never calls its provider',async()=>{
  const f=await fixture(),lock=await hold(f.account.id);let w:ReturnType<typeof worker>|undefined,unlocked=false;
  const cancellation=request(f).then(r=>r);
  try{
   const first=await waiters(f.account.id,1);w=worker();
   // API holds operations EXCLUSIVE before account; worker waits for operations SHARE.
   await operationalWaiter(first[0].pid);
   await lock.release();unlocked=true;
   const response=await cancellation;expect(response.statusCode,response.body).toBe(200);
   expect(response.json().data.remote_outcome).toBe('NOT_ATTEMPTED');
   expect(await w.done).toEqual({processed:0,providerCalls:0,role:'commerce_channel',networkAttempts:0});
   const after=await saved(f);expect(after.command).toMatchObject({status:'FAILED',result:{remote_outcome:'NOT_ATTEMPTED'}});
   expect(after.session).toMatchObject({desired_state:'STOPPED',operational_pause:true,revision:f.session.revision+1,raw_state:f.session.raw_state,auth_state:f.session.auth_state,credential_generation:f.session.credential_generation});
   expect(after.account).toMatchObject({version:f.account.version,body:f.account.body});expect(after.effects).toBe(0);expect(after.audits).toBe(1);
  }finally{if(!unlocked)await lock.release();if(w?.child.exitCode===null)w.child.kill('SIGTERM');await cancellation.catch(()=>{});await w?.done.catch(()=>{});}
 });
 it('the worker claim wins, cancellation loses, and the later UNKNOWN result remains unmodified',async()=>{
  const f=await fixture(),lock=await hold(f.account.id),w=worker();let unlocked=false,cancellation:Promise<Awaited<ReturnType<typeof request>>>|undefined;
  try{
   const first=await waiters(f.account.id,1);cancellation=request(f).then(r=>r);
   // Worker holds operations SHARE before account; API waits for operations EXCLUSIVE.
   await operationalWaiter(first[0].pid);
   await lock.release();unlocked=true;
   const response=await cancellation!;expect(response.statusCode,response.body).toBe(409);expect(response.json().error.code).toBe('CHANNEL_COMMAND_NOT_CANCELLABLE');
   expect(await w.done).toEqual({processed:1,providerCalls:1,role:'commerce_channel',networkAttempts:0});
   const uncertain=await saved(f);expect(uncertain.command).toMatchObject({status:'FAILED',result:{remote_outcome:'UNKNOWN'}});expect(uncertain.effects).toBe(0);expect(uncertain.audits).toBe(0);
   const retry=await request(f,{...f.body,expected_version:uncertain.account.version,expected_session_version:uncertain.session.revision});
   expect(retry.statusCode).toBe(409);expect(retry.json().error.code).toBe('CHANNEL_COMMAND_NOT_CANCELLABLE');
   const preserved=await saved(f);expect(preserved.command).toEqual(uncertain.command);expect(preserved.session).toEqual(uncertain.session);expect(preserved.audits).toBe(0);
  }finally{if(!unlocked)await lock.release();if(w.child.exitCode===null)w.child.kill('SIGTERM');await cancellation?.catch(()=>{});await w.done.catch(()=>{});}
 });
 it('replays the same idempotency key once and rejects changed payload without another mutation',async()=>{
  const f=await fixture(),key=randomUUID();
  const first=await request(f,f.body,key);expect(first.statusCode,first.body).toBe(200);
  const once=await saved(f);expect(once.session.revision).toBe(f.session.revision+1);expect(once.audits).toBe(1);
  const replay=await request(f,f.body,key);expect(replay.statusCode).toBe(200);expect(replay.json()).toEqual(first.json());
  expect(await saved(f)).toEqual(once);
  const changed=await request(f,{...f.body,reason:'Different payload for the same key'},key);
  expect(changed.statusCode).toBe(409);expect(changed.json().error.code).toBe('IDEMPOTENCY_CONFLICT');expect(await saved(f)).toEqual(once);
  expect(once.effects).toBe(0);expect(once.account).toMatchObject({version:f.account.version,body:f.account.body});
 });
});
