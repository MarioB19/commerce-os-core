import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {fixtureProfilesIn} from '../support/profile-fixture.js';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {execFile,spawn,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';
import {setTimeout as pause} from 'node:timers/promises';
import type {FastifyInstance} from 'fastify';

// Own database, restricted API/worker roles and synthetic provider only.
const original=process.env.DATABASE_URL!;
const control=new pg.Pool({connectionString:original});
const database='qr_hold_'+randomUUID().replaceAll('-','');
const ownerUrl=new URL(original);ownerUrl.pathname='/'+database;
const apiUrl=new URL(ownerUrl);apiUrl.searchParams.set('options','-c role=commerce_api -c application_name=qr-hold-api');
const workerUrl=new URL(ownerUrl);workerUrl.searchParams.set('options','-c role=commerce_channel -c application_name=qr-hold-worker');
const root=fileURLToPath(new URL('../../',import.meta.url));
const migration=realpathSync(fileURLToPath(new URL('../../packages/db/src/migrate.ts',import.meta.url)));
const fixture=fileURLToPath(new URL('../fixtures/qr-release-hold-worker.ts',import.meta.url));
const execute=promisify(execFile),workspace='qr-hold-'+randomUUID(),user=randomUUID();
const children=new Set<ChildProcess>();
let app:FastifyInstance,admin:pg.Pool,pool:pg.Pool,token:string,created=false,changed=false;
let putRecord:typeof import('../../packages/db/src/index.js').putRecord;
let defaultPolicy:typeof import('../../packages/contracts/src/index.js').defaultOperationalSettings;

beforeAll(async()=>{
 await control.query(`CREATE DATABASE "${database}" TEMPLATE template0`);created=true;
 await execute(process.execPath,['--import','tsx',migration],{cwd:root,env:{...process.env,DATABASE_URL:ownerUrl.toString()},timeout:30000});
 admin=new pg.Pool({connectionString:ownerUrl.toString()});process.env.DATABASE_URL=apiUrl.toString();changed=true;vi.resetModules();
 const db=await import('../../packages/db/src/index.js');pool=db.pool;putRecord=db.putRecord;
 expect((await pool.query('SELECT current_user role')).rows[0].role).toBe('commerce_api');
 defaultPolicy=(await import('../../packages/contracts/src/index.js')).defaultOperationalSettings;
 const personal=await import('../../packages/db/src/personal-access-tokens.js');token=personal.newPersonalToken();
 await admin.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[user,'Synthetic QR operator',user+'@example.invalid']);
 await fixtureProfilesIn(admin,workspace);// V7 F2: memberships belong to an adopted profile.
 await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[user,workspace]);
 await personal.insertPersonalToken(admin,{workspace_id:workspace,user_id:user,name:'Synthetic QR owner API',allowed_environments:['REAL'],expires_at:new Date(Date.now()+3600000).toISOString()},token);
 await admin.query("INSERT INTO operational_settings(workspace_id,environment,version,body,updated_by) VALUES($1,'REAL',1,$2,$3)",[workspace,{...defaultPolicy,allow_channel_onboarding:true},user]);
 vi.stubEnv('CHANNEL_INTERNAL_URL','http://channel.synthetic.invalid');
 app=await(await import('../../apps/api/src/app.js')).createApp();
});
beforeEach(async()=>{
 await admin.query("UPDATE operational_settings SET release_hold=false WHERE workspace_id=$1 AND environment='REAL'",[workspace]);
});
afterEach(()=>{
 vi.unstubAllGlobals();
 for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');
});
afterAll(async()=>{
 for(const child of children)if(child.exitCode===null)child.kill('SIGKILL');
 try{await app?.close();}finally{try{await pool?.end();await admin?.end();}finally{
  if(changed)process.env.DATABASE_URL=original;
  try{if(created)await control.query(`DROP DATABASE "${database}"`);}finally{try{await control.end();}finally{vi.unstubAllEnvs();}}
 }}
});
async function account(){return putRecord(admin,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Synthetic QR account',provider:'waha',gateway_ref:'qr-'+randomUUID(),engine:'GOWS',status:'STOPPED',sending_enabled:false}});}
function qr(id:string){return app.inject({method:'GET',url:`/v1/channel-accounts/${id}/qr?environment=REAL`,headers:{authorization:'Bearer '+token}});}
async function successes(id:string){return Number((await admin.query("SELECT count(*) n FROM domain_events WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='channel.qr_requested'",[workspace,id])).rows[0].n);}
async function noStoredQr(){expect(Number((await admin.query("SELECT count(*) n FROM domain_events WHERE workspace_id=$1 AND payload::text LIKE '%PUBLIC_SYNTHETIC_QR_FIXTURE%'",[workspace])).rows[0].n)).toBe(0);}
async function hold(){
 const client=await admin.connect();await client.query('BEGIN');
 try{await client.query("SET LOCAL lock_timeout='500ms'");await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`operations:${workspace}:REAL`]);await client.query("UPDATE operational_settings SET release_hold=true,release_hold_at=clock_timestamp() WHERE workspace_id=$1 AND environment='REAL'",[workspace]);await client.query('COMMIT');}
 catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
function worker(id:string){
 const child=spawn(process.execPath,['--import','tsx',fixture],{cwd:root,env:{...process.env,DATABASE_URL:workerUrl.toString(),COPY_QR_FIXTURE:JSON.stringify({workspace,account:id})},stdio:['ignore','pipe','pipe']});children.add(child);let stdout='';child.stdout!.on('data',data=>stdout+=String(data));child.stderr!.resume();
 const done=new Promise<{status:number;body:any;qrCalls:number;role:string}>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>{children.delete(child);if(code!==0)reject(new Error('SYNTHETIC_QR_WORKER_FAILED_'+code));else{try{resolve(JSON.parse(stdout));}catch{reject(new Error('SYNTHETIC_QR_WORKER_OUTPUT_INVALID'));}}});});
 void done.catch(()=>{});return{child,done};
}
function response(value:{status:number;body:unknown}){return new Response(JSON.stringify(value.body),{status:value.status});}

describe('QR proxy continuity with real PostgreSQL locks',()=>{
 it('does not retain API SHARE while a Root hold is queued before the worker SHARE',async()=>{
  const a=await account(),before=await successes(a.id);let proxyCalls=0,sdkCalls=0;
  vi.stubGlobal('fetch',async()=>{
   proxyCalls++;const client=await admin.connect();await client.query('BEGIN');
   try{
    await client.query("SET LOCAL lock_timeout='500ms'");const rootPid=(await client.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`operations:${workspace}:REAL`]);
    const running=worker(a.id);const until=Date.now()+5000;let blocked=false;
    while(Date.now()<until){blocked=Number((await admin.query("SELECT count(*) n FROM pg_stat_activity WHERE datname=$1 AND application_name='qr-hold-worker' AND $2=ANY(pg_blocking_pids(pid))",[database,rootPid])).rows[0].n)>0;if(blocked)break;await pause(10);}
    expect(blocked).toBe(true);
    await client.query("UPDATE operational_settings SET release_hold=true,release_hold_at=clock_timestamp() WHERE workspace_id=$1 AND environment='REAL'",[workspace]);await client.query('COMMIT');
    const remote=await running.done;expect(remote.role).toBe('commerce_channel');expect(remote.status).toBe(409);sdkCalls+=remote.qrCalls;return response(remote);
   }finally{await client.query('ROLLBACK');client.release();}
  });
  const result=await qr(a.id);expect(result.statusCode,result.body).toBe(409);expect(result.json().error.code).toBe('RELEASE_HOLD_ACTIVE');
  expect(proxyCalls).toBe(1);expect(sdkCalls).toBe(0);expect(result.body).not.toContain('PUBLIC_SYNTHETIC_QR_FIXTURE');expect(await successes(a.id)).toBe(before);await noStoredQr();
 });
 it('discards successful provider QR when Root hold commits before API postcheck',async()=>{
  const a=await account(),before=await successes(a.id);let sdkCalls=0;
  vi.stubGlobal('fetch',async()=>{const remote=await worker(a.id).done;expect(remote.role).toBe('commerce_channel');expect(remote.status).toBe(200);sdkCalls+=remote.qrCalls;await hold();return response(remote);});
  const result=await qr(a.id);expect(result.statusCode,result.body).toBe(409);expect(result.json().error.code).toBe('RELEASE_HOLD_ACTIVE');
  expect(sdkCalls).toBe(1);expect(result.body).not.toContain('PUBLIC_SYNTHETIC_QR_FIXTURE');expect(await successes(a.id)).toBe(before);await noStoredQr();
 });
 it('preserves unheld QR delivery and audits metadata without persisting its bytes',async()=>{
  const a=await account(),before=await successes(a.id);
  vi.stubGlobal('fetch',async()=>{const remote=await worker(a.id).done;expect(remote.role).toBe('commerce_channel');expect(remote.qrCalls).toBe(1);return response(remote);});
  const result=await qr(a.id);expect(result.statusCode,result.body).toBe(200);expect(result.json().data.data).toBe('PUBLIC_SYNTHETIC_QR_FIXTURE');
  expect(await successes(a.id)).toBe(before+1);await noStoredQr();
 });
 it('rejects an existing hold before proxy or SDK calls, without success audit',async()=>{
  const a=await account();await hold();const before=await successes(a.id);let proxyCalls=0;
  vi.stubGlobal('fetch',async()=>{proxyCalls++;throw new Error('UNEXPECTED_SYNTHETIC_PROXY');});
  const result=await qr(a.id);expect(result.statusCode,result.body).toBe(409);expect(result.json().error.code).toBe('RELEASE_HOLD_ACTIVE');
  expect(proxyCalls).toBe(0);expect(await successes(a.id)).toBe(before);expect(result.body).not.toContain('PUBLIC_SYNTHETIC_QR_FIXTURE');await noStoredQr();
 });
});
