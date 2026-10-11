import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord} from '../../packages/db/src/index.js';
import {ChannelLoopMonitor} from '../../apps/channel-worker/src/loop-monitor.js';
import {persistChannelHeartbeat} from '../../apps/channel-worker/src/heartbeat.js';
import type {Body} from '../../packages/contracts/src/index.js';
import {defaultOperationalSettings} from '../../packages/contracts/src/index.js';

const workspace='readiness-progress-'+randomUUID(),instance='fixture-progress-'+randomUUID();
const origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:FastifyInstance,cookie='';
beforeAll(async()=>{
 app=await createApp();
 const email=`progress-${randomUUID()}@example.invalid`,password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Synthetic progress owner',email,password,workspace_id:workspace,role:'owner'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});
 expect(login.statusCode).toBe(200);cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(value=>String(value).split(';')[0]).join('; ');
 await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Synthetic readiness account',provider:'waha',status:'DISCONNECTED',sending_enabled:false}});
});
afterAll(async()=>{await app.close();await pool.end();});
async function readiness(){
 const response=await app.inject({method:'GET',url:'/v1/readiness?environment=REAL',headers:{origin,cookie}});
 expect(response.statusCode,response.body).toBe(200);
 return response.json().data.checks.find((check:Body)=>check.key==='channel-worker');
}

it('uses fresh worker progress instead of treating a fresh publisher as healthy',async()=>{
 expect((await readiness()).status).toBe('UNAVAILABLE');
 const monitor=new ChannelLoopMonitor(),loop=monitor.add('ownership_heartbeat',async()=>{}, {deadlineMs:45_000});
 await persistChannelHeartbeat(instance,monitor.snapshot());
 expect(await readiness()).toMatchObject({status:'BLOCKED',message:'CHANNEL_WORKER_BLOCKED'});
 await loop.run();await persistChannelHeartbeat(instance,monitor.snapshot());
 expect((await readiness()).status).toBe('VERIFIED');
 let beat=(await pool.query("SELECT id,version,body FROM records WHERE workspace_id=$1 AND kind='service_heartbeat' AND body->>'instance'=$2",[workspace,instance])).rows[0];
 const healthy=beat.body;
 const write=async(body:Body)=>{beat=await putRecord(pool,{id:beat.id,version:beat.version,workspaceId:workspace,environment:'REAL',kind:'service_heartbeat',body});};
 await write({...healthy,status:'OK',loops:[{...healthy.loops[0],status:'FAILED'}]});
 expect(await readiness()).toMatchObject({status:'BLOCKED',message:'CHANNEL_LOOPS_NOT_READY'});
 await write({...healthy,loops:[{...healthy.loops[0],last_success_at:new Date(Date.now()-60_000).toISOString()}]});
 expect((await readiness()).status).toBe('BLOCKED');
 await write({...healthy,observed_at:'invalid'});
 expect(await readiness()).toMatchObject({status:'STALE',observed_at:null});
 await write({...healthy,expires_at:new Date(Date.now()-1000).toISOString()});
 expect((await readiness()).status).toBe('STALE');
 await write({...healthy,source:'persistHeartbeat',loops:undefined});
 expect((await readiness()).status).toBe('VERIFIED');
 expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
});

it('keeps a fully configured REAL account blocked when control expires or is frozen, including Cloud dispatch',async()=>{
 // This database is isolated; no worker, provider or outbound effect runs.
 const base={workspaceId:workspace,environment:'REAL' as const};
 const asset=await putRecord(pool,{...base,kind:'asset',body:{name:'Synthetic asset',kind:'link',status:'READY',url:'https://example.invalid/fixture'}});
 const bank=await putRecord(pool,{...base,kind:'bank_profile',body:{name:'Synthetic bank'}});
 const receipt=await putRecord(pool,{...base,kind:'receipt_policy',body:{name:'Synthetic policy'}});
 const product=await putRecord(pool,{...base,kind:'product',body:{name:'Synthetic product',status:'PUBLISHED'}});
 const workflow=await putRecord(pool,{...base,kind:'workflow',body:{name:'Synthetic workflow',status:'PUBLISHED',entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]}});
 const offer=await putRecord(pool,{...base,kind:'offer',body:{name:'Synthetic offer',status:'PUBLISHED',product_id:product.id,workflow_version_id:workflow.id,payment_profile_version_id:bank.id,receipt_policy_version_id:receipt.id,fulfillment:[{asset_id:asset.id,release_on:'payment_confirmed'}]}});
 const authorization=(await pool.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,configuration_version,expires_at) VALUES($1,'REAL','fixture','{}','synthetic',1,now()+interval '1 hour') RETURNING *",[workspace])).rows[0];
 const account=await putRecord(pool,{...base,kind:'channel_account',body:{name:'Synthetic Cloud control',provider:'cloud',status:'WORKING',identity_verified:true,sending_enabled:true,active_authorization_id:authorization.id}});
 await putRecord(pool,{...base,kind:'binding',body:{account_id:account.id,offer_version_id:offer.id,workflow_version_id:workflow.id,valid_from:new Date(Date.now()-60_000).toISOString()}});
 for(const dimension of ['transport','quality'])await putRecord(pool,{...base,kind:'health_signal',body:{account_id:account.id,dimension,scope:'account',status:'OK',source:'provider_read',observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+300_000).toISOString()}});
 await pool.query("INSERT INTO operational_settings(workspace_id,environment,version,body,updated_by) VALUES($1,'REAL',1,$2,'fixture')",[workspace,{...defaultOperationalSettings,dispatch_frozen:false,real_sends_enabled:true,allow_real_operations:true}]);
 const read=async()=>{
  const response=await app.inject({method:'GET',url:'/v1/readiness?environment=REAL',headers:{origin,cookie}});
  expect(response.statusCode,response.body).toBe(200);return response.json().data.accounts.find((item:Body)=>item.id===account.id);
 };
 const check=(value:Body)=>value.checks.find((item:Body)=>item.key==='ownership');
 expect(check(await read())).toMatchObject({status:'BLOCKED',message:'OWNERSHIP_NOT_CONFIRMED'});
 await pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,frozen,release_frozen,lease_expires_at) VALUES($1,$2,'synthetic-worker',1,false,false,now()+interval '5 minutes')",[account.id,workspace]);
 const healthy=await read();expect(healthy.configuration_ready,JSON.stringify(healthy.checks)).toBe(true);expect(check(healthy).status).toBe('VERIFIED');
 for(const scenario of [
  {frozen:false,release:false,lease:-60,code:'OWNERSHIP_EXPIRED'},
  {frozen:true,release:false,lease:300,code:'OWNERSHIP_FROZEN'},
  {frozen:false,release:true,lease:300,code:'RELEASE_RECOVERY_PENDING'},
 ]){
  await pool.query("UPDATE session_ownership SET frozen=$2,release_frozen=$3,lease_expires_at=now()+$4*interval '1 second' WHERE account_id=$1",[account.id,scenario.frozen,scenario.release,scenario.lease]);
  const blocked=await read();expect(blocked.configuration_ready).toBe(false);expect(check(blocked)).toMatchObject({status:'BLOCKED',message:scenario.code});
  expect(blocked.checks.find((item:Body)=>item.key==='health').status).toBe('VERIFIED');
 }
 expect((await pool.query('SELECT * FROM operation_authorizations WHERE id=$1',[authorization.id])).rows[0]).toEqual(authorization);
 expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
});

it('does not turn SIMULATION configuration into a claim about REAL ownership',async()=>{
 const account=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body:{name:'Synthetic simulation control',provider:'simulator',status:'WORKING'}});
 const response=await app.inject({method:'GET',url:'/v1/readiness?environment=SIMULATION',headers:{origin,cookie}});
 expect(response.statusCode,response.body).toBe(200);
 const row=response.json().data.accounts.find((item:Body)=>item.id===account.id);
 expect(row.checks.find((item:Body)=>item.key==='ownership')).toMatchObject({status:'NOT_APPLICABLE',source:'SESSION_OWNERSHIP'});
});
