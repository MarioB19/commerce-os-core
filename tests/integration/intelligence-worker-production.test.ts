import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {spawn,execFile,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {build} from 'esbuild';
import pg from 'pg';
import {pool as adminPool} from '../../packages/db/src/index.js';
import {AUTOMATION_LOOP_NAMES} from '../../packages/domain/src/operations/automation-progress.js';
const execute=promisify(execFile),database='intelligence_boot_'+randomUUID().replaceAll('-',''),workspace='automation-boot-'+randomUUID(),connection=new URL(process.env.DATABASE_URL!);connection.pathname='/'+database;
let databasePool:pg.Pool,directory:string,child:ChildProcess|undefined;
beforeAll(async()=>{
 await adminPool.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
 await execute(process.execPath,['--import','tsx','packages/db/src/migrate.ts'],{env:{...process.env,DATABASE_URL:connection.toString()},timeout:30000});
 databasePool=new pg.Pool({connectionString:connection.toString()});await databasePool.query('CREATE SCHEMA pgboss_automation AUTHORIZATION commerce_automation');
 await databasePool.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'SIMULATION','channel_account',$2)",[workspace,{name:'Synthetic worker scope',provider:'simulator',status:'DISCONNECTED',sending_enabled:false}]);
 await mkdir('dist',{recursive:true});directory=await mkdtemp(join(process.cwd(),'dist','intelligence-worker-production-'));
 const pkg=JSON.parse(await readFile('package.json','utf8'));
 await build({entryPoints:['apps/automation-worker/src/index.ts'],outfile:join(directory,'worker.mjs'),bundle:true,platform:'node',target:'node24',format:'esm',external:Object.keys(pkg.dependencies),logLevel:'silent'});
 await writeFile(join(directory,'guard.mjs'),`if(process.env.BETTER_AUTH_SECRET||process.env.NODE_ENV!=='production')throw Error('INVALID_PRODUCTION_BOUNDARY_FIXTURE');globalThis.fetch=async()=>{throw Error('EXTERNAL_REQUEST_FORBIDDEN_IN_EMPTY_BOOT_FIXTURE');};`);
});
afterAll(async()=>{if(child?.exitCode===null){child.kill('SIGKILL');await new Promise<void>(resolve=>child!.once('close',()=>resolve()));}await databasePool?.end();await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`);await adminPool.end();if(directory)await rm(directory,{recursive:true,force:true});});
async function freePort(){const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('PORT_FIXTURE_FAILED');const port=address.port;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return port;}
describe('Deployed automation bundle under production permissions',()=>{
 it('boots and serves healthy requests with commerce_automation and no Better Auth secret',async()=>{
  const url=new URL(connection);url.searchParams.set('options','-c role=commerce_automation');const rolePool=new pg.Pool({connectionString:url.toString()});try{expect((await rolePool.query('SELECT current_user name')).rows[0].name).toBe('commerce_automation');await expect(rolePool.query('SELECT password FROM account')).rejects.toThrow('permission denied');}finally{await rolePool.end();}
  const port=await freePort(),env:NodeJS.ProcessEnv={...process.env,DATABASE_URL:url.toString(),NODE_ENV:'production',PORT:String(port),HOST:'127.0.0.1',JOB_SCHEMA:'pgboss_automation',DB_POOL_MAX:'5'};delete env.BETTER_AUTH_SECRET;delete env.AUTH_SECRET;
  let stderr='',stdout='';child=spawn(process.execPath,['--import',join(directory,'guard.mjs'),join(directory,'worker.mjs')],{env,stdio:['ignore','pipe','pipe']});child.stderr!.on('data',chunk=>{stderr+=chunk.toString();});child.stdout!.on('data',chunk=>{stdout+=chunk.toString();});const stopped=new Promise<number|null>(resolve=>child!.once('close',code=>resolve(code)));
  const health=async()=>{if(child!.exitCode!==null)throw Error('AUTOMATION_BOOT_EXITED: '+stderr.slice(-2000));try{const response=await fetch(`http://127.0.0.1:${port}/readyz`,{signal:AbortSignal.timeout(1000)});return response.ok?await response.json():null;}catch{return null;}};
  let ready:any=null;const deadline=Date.now()+15000;while(Date.now()<deadline&&!ready){ready=await health();if(!ready)await new Promise(resolve=>setTimeout(resolve,100));}
  expect(ready,stderr).toMatchObject({ok:true,service:'automation-worker',ready:true,code:'READY'});
  expect(ready.loops.map((loop:any)=>loop.name).sort()).toEqual([...AUTOMATION_LOOP_NAMES].sort());
  expect(ready.loops.every((loop:any)=>loop.status==='OK'&&loop.required&&loop.successes>=1&&loop.failures===0)).toBe(true);
  // Cover a second Intelligence tick and pg-boss initialization after HTTP listen.
  await new Promise(resolve=>setTimeout(resolve,5500));const later=await health();expect(later,stderr).toMatchObject({ok:true,service:'automation-worker',last_success_at:expect.any(String)});
  for(const name of ['automation_inbound','intelligence','automation_commands'])expect(later.loops.find((loop:any)=>loop.name===name).successes).toBeGreaterThan(ready.loops.find((loop:any)=>loop.name===name).successes);
  let heartbeat:any;const heartbeatDeadline=Date.now()+20000;
  while(Date.now()<heartbeatDeadline){heartbeat=(await databasePool.query("SELECT body FROM records WHERE workspace_id=$1 AND kind='service_heartbeat' AND body->>'service'='automation-worker' ORDER BY updated_at DESC LIMIT 1",[workspace])).rows[0]?.body;if(heartbeat?.status==='OK')break;await new Promise(resolve=>setTimeout(resolve,100));}
  expect(heartbeat,stderr).toMatchObject({status:'OK',source:'AUTOMATION_LOOP_PROGRESS',service:'automation-worker'});expect(heartbeat.loops).toHaveLength(14);
  expect((await databasePool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind='operational_metric'",[workspace])).rows[0].n).toBeGreaterThan(0);
  expect((await databasePool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
  expect(stderr).not.toMatch(/BetterAuth|default secret|job_bus_error|_failed|tick failed|EXTERNAL_REQUEST_FORBIDDEN/);expect(stdout).not.toContain('BetterAuth');
  child.kill('SIGTERM');const timer=setTimeout(()=>child?.kill('SIGKILL'),5000);try{expect(await stopped).toBe(0);}finally{clearTimeout(timer);}
 });
});
