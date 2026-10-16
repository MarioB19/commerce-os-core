import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {deliverOperationalAlerts} from '../../apps/automation-worker/src/operations-monitor.js';
import {pool,putRecord,withTransaction} from '../../packages/db/src/index.js';
import {integrationPatchSchema,saveIntegrationSetting} from '../../packages/db/src/integration-settings.js';
import {lowDiskObservation,providerHttpFaults,staleWorkerHeartbeat,unavailableGatewayAccount} from '../fixtures/resilience-faults.js';

const workspace='resilience-fault-'+randomUUID();
const origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:FastifyInstance,cookie='';

async function alert(){
 return(await pool.query("INSERT INTO operational_alerts(workspace_id,environment,dedupe_key,kind,severity,summary_code) VALUES($1,'REAL',$2,'SYNTHETIC_PROVIDER_FAULT','WARNING','SYNTHETIC_PROVIDER_FAULT') RETURNING id",[workspace,randomUUID()])).rows[0];
}
const alertStatus=async(id:string)=>(await pool.query('SELECT status FROM operational_alerts WHERE id=$1',[id])).rows[0].status;

beforeAll(async()=>{
 app=await createApp();
 const email=`fault-${randomUUID()}@example.invalid`,password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Synthetic resilience owner',email,password,workspace_id:workspace,role:'owner'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.48',payload:{email,password},headers:{origin}});
 expect(login.statusCode).toBe(200);cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(value=>String(value).split(';')[0]).join('; ');
 await withTransaction(client=>saveIntegrationSetting(client,workspace,'REAL','alerts:default',integrationPatchSchema.parse({expected_version:0,label:'Synthetic injected transport',enabled:true,config:{endpoint:'https://alerts.example.invalid/injected'},secrets:{token:'synthetic-fault-token'},reason:'Deterministic fault injection without network'}),'synthetic-owner'));
});
afterAll(async()=>{await app.close();await pool.end();});

describe('deterministic resilience fault injection',()=>{
 it.each(providerHttpFaults)('$name is classified without blind retry',async fault=>{
  const row=await alert();let calls=0;
  const fetcher:typeof fetch=async()=>{calls++;return new Response(null,{status:fault.status});};
  await deliverOperationalAlerts(fetcher);
  expect(await alertStatus(row.id)).toBe(fault.expected);
  await deliverOperationalAlerts(fetcher);
  expect(calls).toBe(1);
 });

 it('surfaces stopped workers, low disk and an unavailable gateway as current blocking evidence',async()=>{
  const now=Date.now();
  for(const service of ['automation-worker','channel-worker'] as const)await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'service_heartbeat',body:staleWorkerHeartbeat(service,now)});
  await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'operational_metric',body:lowDiskObservation(now)});
  const account=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:unavailableGatewayAccount});
  const response=await app.inject({method:'GET',url:'/v1/readiness?environment=REAL',headers:{origin,cookie}});
  expect(response.statusCode,response.body).toBe(200);
  const data=response.json().data,checks=Object.fromEntries(data.checks.map((check:any)=>[check.key,check]));
  expect(checks['automation-worker']).toMatchObject({status:'STALE',source:'WORKER_HEARTBEAT'});
  expect(checks['channel-worker']).toMatchObject({status:'STALE',source:'WORKER_HEARTBEAT'});
  expect(checks.private_storage_disk).toMatchObject({status:'BLOCKED',source:'MOUNTED_PRIVATE_STORAGE_STATFS'});
  expect(data.accounts.find((item:any)=>item.id===account.id)?.checks.find((check:any)=>check.key==='connection')).toMatchObject({status:'BLOCKED',source:'PROVIDER_SESSION_RECORD'});
  expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
 });
});
