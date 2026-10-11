import {afterAll,beforeAll,expect,it} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import {pool as adminPool,putRecord} from '../../packages/db/src/index.js';

const execute=promisify(execFile),suffix=randomUUID().replaceAll('-','');
const database='metric_roles_'+suffix,login='metric_login_'+suffix,loginPassword=randomUUID();
const connection=new URL(process.env.DATABASE_URL!);connection.pathname='/'+database;
const workspace='metric-fixture-'+randomUUID();
let pool:pg.Pool;
let metricId:string;

beforeAll(async()=>{
 await adminPool.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
 await execute(process.execPath,['--import','tsx','packages/db/src/migrate.ts'],{env:{...process.env,DATABASE_URL:connection.toString()},timeout:30000});
 pool=new pg.Pool({connectionString:connection.toString()});
 // This login has no superuser privilege. Its inherited role uses the same
 // role=none branch as a runtime connection rather than a migration owner.
 await adminPool.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${loginPassword}' IN ROLE commerce_automation`);
 const metric=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'operational_metric',body:{key:'private_storage_disk',source:'synthetic-role-fixture'}});metricId=metric.id;
 for(const environment of ['SIMULATION','REAL'] as const)await putRecord(pool,{workspaceId:workspace,environment,kind:'channel_account',body:{name:'Synthetic monitor fixture',provider:'simulator',sending_enabled:false}});
});
afterAll(async()=>{
 await pool?.end();
 await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`);
 await adminPool.query(`DROP ROLE IF EXISTS "${login}"`);
 await adminPool.end();
});
async function asRole<T>(role:string,work:(client:pg.PoolClient)=>Promise<T>){
 if(!['commerce_api','commerce_channel','commerce_automation','commerce_ingress','commerce_maintenance'].includes(role))throw Error('SYNTHETIC_ROLE_REQUIRED');
 const client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE '+role);return await work(client);}
 finally{await client.query('ROLLBACK');client.release();}
}

it('reproduces the previous writer rejection without changing migration history',async()=>{
 const old=await readFile(new URL('../../packages/db/migrations/0048_channel_api_runtime_permissions.sql',import.meta.url),'utf8');
 const definition=old.slice(old.indexOf('CREATE OR REPLACE FUNCTION enforce_record_writer()'));
 const client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query(definition);await client.query('SET LOCAL ROLE commerce_automation');
  await expect(putRecord(client,{workspaceId:workspace,environment:'SIMULATION',kind:'operational_metric',body:{key:'private_storage_disk'}})).rejects.toThrow('WRITE_OWNER_AUTOMATION');
 }finally{await client.query('ROLLBACK');client.release();}
 expect((await pool.query("SELECT count(*)::int n FROM schema_migrations WHERE name='0068_operational_metric_writer.sql'")).rows[0].n).toBe(1);
});

it('allows automation to insert and update operational metrics with record history',async()=>{
 await asRole('commerce_automation',async client=>{
  const first=await putRecord(client,{workspaceId:workspace,environment:'SIMULATION',kind:'operational_metric',body:{key:'private_storage_disk',status:'OBSERVED',available_bytes:10}});
  const second=await putRecord(client,{id:first.id,version:first.version,workspaceId:workspace,environment:'SIMULATION',kind:'operational_metric',body:{...first.body,available_bytes:9}});
  expect(second.id).toBe(first.id);expect(second.version).toBe(first.version+1);
  expect(second.body.available_bytes).toBe(9);
  expect((await client.query('SELECT count(*)::int n FROM record_versions WHERE record_id=$1',[first.id])).rows[0].n).toBe(2);
 });
});

it.each(['commerce_api','commerce_channel'])('preserves %s denial for metric insert and update',async role=>{
 const expected=role==='commerce_api'?'WRITE_OWNER_API':'WRITE_OWNER_CHANNEL';
 await expect(asRole(role,c=>putRecord(c,{workspaceId:workspace,environment:'SIMULATION',kind:'operational_metric',body:{key:'private_storage_disk'}}))).rejects.toThrow(expected);
 await expect(asRole(role,c=>c.query('UPDATE records SET body=body||$2::jsonb WHERE id=$1',[metricId,{available_bytes:0}]))).rejects.toThrow(expected);
});

it.each(['commerce_ingress','commerce_maintenance'])('does not grant %s record writes',async role=>{
 await expect(asRole(role,c=>putRecord(c,{workspaceId:workspace,environment:'SIMULATION',kind:'operational_metric',body:{key:'private_storage_disk'}}))).rejects.toMatchObject({code:'42501'});
 await expect(asRole(role,c=>c.query('UPDATE records SET body=body||$2::jsonb WHERE id=$1',[metricId,{available_bytes:0}]))).rejects.toMatchObject({code:'42501'});
});

it.each(['product','category','agent','channel_account','unknown_metric_kind'])('still denies automation writes to %s',async kind=>{
 await expect(asRole('commerce_automation',c=>putRecord(c,{workspaceId:workspace,environment:'SIMULATION',kind,body:{name:'Synthetic forbidden write'}}))).rejects.toThrow('WRITE_OWNER_AUTOMATION');
});

it('preserves the automation asset guard and existing API/channel writer boundaries',async()=>{
 await expect(asRole('commerce_automation',c=>putRecord(c,{workspaceId:workspace,environment:'SIMULATION',kind:'asset',body:{source:'synthetic-untrusted'}}))).rejects.toThrow('WRITE_OWNER_AUTOMATION_ASSET');
 await asRole('commerce_api',async c=>{expect((await putRecord(c,{workspaceId:workspace,environment:'SIMULATION',kind:'product',body:{name:'Synthetic API product'}})).kind).toBe('product');});
 await asRole('commerce_channel',async c=>{expect((await putRecord(c,{workspaceId:workspace,environment:'SIMULATION',kind:'health_signal',body:{source:'synthetic-channel'}})).kind).toBe('health_signal');});
});

it('collects durable metrics and advances them through the real inherited automation login without delivery',async()=>{
 const url=new URL(connection);url.username=login;url.password=loginPassword;url.searchParams.delete('options');
 const program=`
  import assert from 'node:assert/strict';
  import {pool} from './packages/db/src/index.ts';
  import {collectOperationalAlerts,deliverOperationalAlerts} from './apps/automation-worker/src/operations-monitor.ts';
  const workspace=process.env.OPERATIONAL_METRIC_FIXTURE;
  const identity=(await pool.query("SELECT current_user runtime,current_setting('role') role,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser")).rows[0];
  assert.equal(identity.runtime,process.env.OPERATIONAL_METRIC_LOGIN);assert.equal(identity.role,'none');assert.equal(identity.superuser,false);
  const read=async()=>(await pool.query("SELECT id,environment,version,updated_at,body FROM records WHERE workspace_id=$1 AND kind='operational_metric' AND body->>'key'='private_storage_disk' ORDER BY environment",[workspace])).rows;
  await collectOperationalAlerts();const first=await read();
  await new Promise(resolve=>setTimeout(resolve,10));await collectOperationalAlerts();const second=await read();
  let externalCalls=0;await deliverOperationalAlerts(async()=>{externalCalls++;throw Error('SYNTHETIC_NO_DELIVERY_ALLOWED');});
  const alerts=(await pool.query("SELECT kind,status FROM operational_alerts WHERE workspace_id=$1 ORDER BY kind",[workspace])).rows;
  await pool.end();console.log(JSON.stringify({identity,first,second,alerts,externalCalls}));
 `;
 const {stdout}=await execute(process.execPath,['--import','tsx','--input-type=module','-e',program],{env:{...process.env,DATABASE_URL:url.toString(),OPERATIONAL_METRIC_FIXTURE:workspace,OPERATIONAL_METRIC_LOGIN:login,PRIVATE_STORAGE_DIR:process.cwd()},timeout:30000,maxBuffer:1024*1024});
 const result=JSON.parse(stdout.trim());
 expect(result.identity).toMatchObject({runtime:login,role:'none',superuser:false});
 expect(result.first).toHaveLength(2);expect(result.second).toHaveLength(2);expect(result.externalCalls).toBe(0);
 for(let i=0;i<2;i++){
  const before=result.first[i],after=result.second[i];
  expect(after.id).toBe(before.id);expect(after.version).toBe(before.version+1);
  expect(Date.parse(after.updated_at)).toBeGreaterThan(Date.parse(before.updated_at));
  expect(after.body).toMatchObject({key:'private_storage_disk',status:'OBSERVED',source:'MOUNTED_PRIVATE_STORAGE_STATFS'});
  expect(after.body.available_bytes).toBeGreaterThan(0);expect(after.body.total_bytes).toBeGreaterThan(0);
  expect(Date.parse(after.body.expires_at)-Date.parse(after.body.observed_at)).toBe(180000);
 }
 expect(result.alerts.some((a:{kind:string;status:string})=>a.kind==='EXTERNAL_BACKUP_NOT_CURRENT'&&a.status==='PENDING')).toBe(true);
});
