import {consumeProviderObservations} from '../../apps/channel-worker/src/observations.js';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord,withTransaction,getRecord,appendEvent,writeOperationalSettings,readOperationalSettings} from '../../packages/db/src/index.js';
import {observeChannelSession,readChannelSession} from '../../packages/db/src/channel-sessions.js';
import {readEffectiveHealth} from '../../packages/db/src/effective-health.js';
import {recordHealth,collectHealth,processChannelCommands,acquireOwnership} from '../../apps/channel-worker/src/lifecycle.js';
import {superviseSessions} from '../../apps/channel-worker/src/session-supervisor.js';
import {collectSessionAlerts} from '../../apps/automation-worker/src/session-alerts.js';
import {SimulatorProvider,type HealthSignal} from '../../packages/messaging/src/index.js';
import type {DomainRecord} from '../../packages/contracts/src/index.js';
const workspace='continuity-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:Awaited<ReturnType<typeof createApp>>,cookie:string,user:string;
const request=(method:any,url:string,body?:any,key=randomUUID())=>app.inject({method,url:url+(url.includes('?')?'&':'?')+'environment=REAL',payload:body,headers:{cookie,origin,'idempotency-key':key}});
const signals=(state='WORKING',fingerprint='fixture-identity',at=new Date()):HealthSignal[]=>[{dimension:'session',status:state==='WORKING'?'OK':'BLOCKED',value:state,source:'provider_read',scope:'account',availability:'supported',observedAt:at.toISOString(),expiresAt:new Date(at.getTime()+60000).toISOString()},...(state==='WORKING'?[{dimension:'transport' as const,status:'OK' as const,value:{identity_fingerprint:fingerprint},source:'provider_read' as const,scope:'account' as const,availability:'supported' as const,observedAt:at.toISOString(),expiresAt:new Date(at.getTime()+60000).toISOString()}]:[])];
async function account(provider='waha'){return putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Synthetic continuity',provider,gateway_ref:'fixture-'+randomUUID(),status:'STOPPED',sending_enabled:false}});}
const session=async(a:DomainRecord)=>(await pool.query('SELECT * FROM channel_sessions WHERE account_id=$1',[a.id])).rows[0];
async function enableRecoveryPolicy(){await withTransaction(async c=>{const p=await readOperationalSettings(c,workspace,'REAL');await writeOperationalSettings(c,workspace,'REAL',p.version,{...p.body,allow_channel_onboarding:true,dispatch_frozen:false},'synthetic');});}
async function configureRecovery(a:DomainRecord){await pool.query("UPDATE channel_sessions SET recovery_enabled=true,desired_state='RUNNING',operational_pause=false,primary_device_id='test-primary',responsible_user_id=$2,primary_last_used_at=now(),inventory='{\"primary_availability\":\"AVAILABLE\"}',observed_state='STOPPED',disconnect_reason='CONFIRMED_STOPPED_AFTER_CONNECTION',expected_identity_fingerprint='fixture-identity',health_expires_at=now()+interval '1 minute',next_retry_at=now()-interval '1 second' WHERE account_id=$1",[a.id,user]);}
async function recoveryEvidence(a:DomainRecord,owner:string,frozen=false){
 await acquireOwnership(a,owner);await pool.query("UPDATE session_ownership SET frozen=$2,lease_expires_at=now()+interval '1 minute',updated_at=now() WHERE account_id=$1",[a.id,frozen]);
 const now=Date.now();
 await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'health_signal',body:{account_id:a.id,dimension:'session',status:'BLOCKED',value:'STOPPED',source:'provider_read',scope:'account',availability:'supported',observed_at:new Date(now-2000).toISOString(),expires_at:new Date(now+60000).toISOString()}});
 await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'health_signal',body:{account_id:a.id,dimension:'restriction',status:'OK',value:{latest_read:{timelock:true,capping:true}},source:'provider_read',scope:'account',availability:'supported',observed_at:new Date(now-1000).toISOString(),expires_at:new Date(now+60000).toISOString()}});
}
beforeAll(async()=>{app=await createApp();const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');await provisionUser({name:'Continuity operator',email,password,workspace_id:workspace,role:'owner'});const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.143',payload:{email,password},headers:{origin}});expect(login.statusCode).toBe(200);cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(x=>String(x).split(';')[0]).join('; ');user=login.json().user.id;});
afterAll(async()=>{await app.close();await pool.end();});
it('backfills conservative state, validates scope, revisions and primary declarations without enabling sending',async()=>{
 const a=await account(),url=`/v1/channel-accounts/${a.id}`;expect(await session(a)).toMatchObject({desired_state:'STOPPED',observed_state:'UNKNOWN',recovery_enabled:false,operational_pause:true,primary_last_used_at:null});
 expect((await request('GET',url+'/session')).statusCode).toBe(200);
 const key=randomUUID(),body={expected_version:1,source:'operator_confirmation',used_at:new Date(Date.now()-1000).toISOString(),reason:'Opened primary app manually'};
 const response=await request('POST',url+'/primary-usage',body,key);expect(response.statusCode,response.body).toBe(200);expect((await request('POST',url+'/primary-usage',body,key)).json()).toEqual(response.json());expect((await request('POST',url+'/primary-usage',body)).statusCode).toBe(409);
 expect((await request('POST',url+'/primary-usage',{...body,expected_version:2,used_at:new Date(Date.now()+86400000).toISOString()})).statusCode).toBe(400);
 expect((await request('PATCH',url+'/session',{expected_version:2,responsible_user_id:'other-workspace',reason:'bad scope'})).statusCode).toBe(400);
 const outside=await putRecord(pool,{workspaceId:'other-'+workspace,environment:'REAL',kind:'channel_account',body:{provider:'cloud'}});expect((await request('GET',`/v1/channel-accounts/${outside.id}/session`)).statusCode).toBe(404);
 const saved=await session(a);expect(saved.primary_usage_source).toBe('operator_confirmation');expect(saved.primary_usage_recorded_by).toBe(user);expect((await getRecord(pool,workspace,'channel_account',a.id))!.body.sending_enabled).toBe(false);
});
it('observations require identity, preserve expected identity and reject older or future observations',async()=>{
 const a=await account(),provider=new SimulatorProvider();provider.health=async()=>signals();await recordHealth(a,()=>provider);const s=await session(a);expect(s.observed_state).toBe('CONNECTED');expect(s.primary_last_used_at).toBeNull();const at=s.provider_observed_at;
 await withTransaction(c=>observeChannelSession(c,a,signals('STOPPED','x',new Date(at.getTime()-1000))));expect((await session(a)).observed_state).toBe('CONNECTED');
 await withTransaction(c=>observeChannelSession(c,a,signals('WORKING','other',new Date(at.getTime()+10))));expect((await session(a)).auth_state).toBe('IDENTITY_CONFLICT');
 const current=(await getRecord(pool,workspace,'channel_account',a.id))!;await putRecord(pool,{id:a.id,workspaceId:workspace,environment:'REAL',kind:'channel_account',version:current.version,body:{...current.body,identity_fingerprint:null}});expect((await session(a)).expected_identity_fingerprint).toBe('fixture-identity');
 await pool.query("UPDATE channel_sessions SET health_expires_at=now()-interval '1 second' WHERE account_id=$1",[a.id]);expect((await readChannelSession(pool,a))!.observed_state).toBe('UNKNOWN');
});
it('recovers only the owned health incident after a complete positive readback',async()=>{
 const a=await account(),provider=new SimulatorProvider();await acquireOwnership(a,'health-recovery-owner');await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[a.id]);
 let healthCalls=0,lifecycleCalls=0;
 const observed=(offset:number,status:'BLOCKED'|'UNKNOWN'|'OK',fingerprint='fixture-identity'):HealthSignal[]=>{const at=new Date(Date.now()+offset);return[...signals('WORKING',fingerprint,at),{dimension:'restriction',status,value:status==='OK'?{latest_read:{timelock:true,capping:true}}:status==='UNKNOWN'?{latest_read:{timelock:true,capping:false}}:{reachout_timelock:{isActive:true}},source:'provider_read',scope:'account',availability:'supported',observedAt:at.toISOString(),expiresAt:new Date(at.getTime()+60000).toISOString()}];};
 provider.lifecycle=async()=>{lifecycleCalls++;return{status:'WORKING'};};
 provider.health=async()=>{healthCalls++;return observed(-3000,'BLOCKED');};await recordHealth(a,()=>provider);expect((await getRecord(pool,workspace,'channel_account',a.id))!.body.health_status).toBe('BLOCKED');expect((await pool.query('SELECT frozen FROM session_ownership WHERE account_id=$1',[a.id])).rows[0].frozen).toBe(true);
 provider.health=async()=>{healthCalls++;return observed(-2000,'UNKNOWN');};await recordHealth(a,()=>provider);expect((await getRecord(pool,workspace,'channel_account',a.id))!.body.health_status).toBe('UNKNOWN');expect((await pool.query('SELECT frozen FROM session_ownership WHERE account_id=$1',[a.id])).rows[0].frozen).toBe(true);
 provider.health=async()=>{healthCalls++;return observed(-1000,'OK');};await recordHealth(a,()=>provider);expect((await getRecord(pool,workspace,'channel_account',a.id))!.body.health_status).toBe('OK');
 expect((await pool.query('SELECT frozen FROM session_ownership WHERE account_id=$1',[a.id])).rows[0].frozen).toBe(false);
 const incident=(await pool.query("SELECT body FROM records WHERE workspace_id=$1 AND kind='incident' AND body->>'account_id'=$2 AND body->>'reason'='CHANNEL_HEALTH_BLOCKED'",[workspace,a.id])).rows[0];expect(incident.body).toMatchObject({status:'RESOLVED',resolved_by:'channel-health-readback',resolution_reason:'CURRENT_HEALTH_READBACK_VERIFIED'});
 expect((await pool.query("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='channel.health_recovered'",[workspace,a.id])).rows[0].n).toBe(1);
 expect((await readEffectiveHealth(pool,{workspaceId:workspace,environment:'REAL',accountId:a.id})).by_dimension.ownership).toMatchObject({status:'OK',value:{frozen:false}});
 expect({healthCalls,lifecycleCalls}).toEqual({healthCalls:3,lifecycleCalls:0});
});
it('restores only a release-frozen account with a current grant and healthy identity',async()=>{
 const current=await readOperationalSettings(pool,workspace,'REAL');
 const policy=await withTransaction(c=>writeOperationalSettings(c,workspace,'REAL',current.version,{...current.body,dispatch_frozen:false,real_sends_enabled:true,allow_real_operations:true},'synthetic-release'));
 const provider=new SimulatorProvider();provider.health=async()=>{const at=new Date(Date.now()-1000);return[...signals('WORKING','fixture-identity',at),{dimension:'restriction',status:'OK',value:{latest_read:{timelock:true,capping:true}},source:'provider_read',scope:'account',availability:'supported',observedAt:at.toISOString(),expiresAt:new Date(at.getTime()+60000).toISOString()}];};
 const make=async(granted:boolean)=>{
  const created=await account();let a=await putRecord(pool,{id:created.id,workspaceId:workspace,environment:'REAL',kind:'channel_account',version:created.version,body:{...created.body,identity_fingerprint:'fixture-identity',sending_enabled:true}});
  if(granted){const auth=(await pool.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,configuration_version,expires_at) VALUES($1,'REAL','synthetic',$2,$3,$4,now()+interval '1 hour') RETURNING id",[workspace,{mode:'channel_setup',account_ids:[a.id],max_messages:1},'synthetic-release-grant',policy.version])).rows[0];a=await putRecord(pool,{id:a.id,workspaceId:workspace,environment:'REAL',kind:'channel_account',version:a.version,body:{...a.body,active_authorization_id:auth.id}});}
  const owner='release-health-'+randomUUID(),fence=await acquireOwnership(a,owner);expect(fence.acquired).toBe(true);
  await pool.query("UPDATE session_ownership SET frozen=true,release_frozen=true WHERE account_id=$1",[a.id]);
  if(granted){await recordHealth(a,()=>provider);expect((await pool.query('SELECT frozen FROM session_ownership WHERE account_id=$1',[a.id])).rows[0].frozen).toBe(true);await new Promise(resolve=>setTimeout(resolve,3));}
  await recordHealth(a,()=>provider,{owner_id:owner,generation:fence.generation!});
  return a;
 };
 const healthy=await make(true),unauthorized=await make(false);
 expect((await pool.query('SELECT frozen,release_frozen FROM session_ownership WHERE account_id=$1',[healthy.id])).rows[0]).toEqual({frozen:false,release_frozen:false});
 expect((await pool.query('SELECT frozen,release_frozen FROM session_ownership WHERE account_id=$1',[unauthorized.id])).rows[0]).toEqual({frozen:true,release_frozen:true});
 expect((await pool.query("SELECT count(*)::int n FROM domain_events WHERE aggregate_id=$1 AND event_type='channel.release_recovered'",[healthy.id])).rows[0].n).toBe(1);
 expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
});

it('fences a replacement check-health read with a verified isolation receipt before recovering the lease',async()=>{
 const a=await account(),oldOwner='prior-health-worker',newOwner='replacement-health-worker',provider=new SimulatorProvider();
 await acquireOwnership(a,oldOwner);await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[a.id]);
 let healthCalls=0,lifecycleCalls=0;
 const observed=(restriction:'BLOCKED'|'OK'):HealthSignal[]=>{const at=new Date(Date.now()-1000);return[
  ...signals('WORKING','fixture-identity',at),
  {dimension:'restriction',status:restriction,value:restriction==='OK'?{latest_read:{timelock:true,capping:true}}:{reachout_timelock:{isActive:true}},source:'provider_read',scope:'account',availability:'supported',observedAt:at.toISOString(),expiresAt:new Date(at.getTime()+60000).toISOString()},
 ];};
 provider.health=async()=>{healthCalls++;return observed('BLOCKED');};
 provider.lifecycle=async()=>{lifecycleCalls++;throw Error('LIFECYCLE_MUST_NOT_RUN');};
 await recordHealth(a,()=>provider);
 await pool.query("UPDATE session_ownership SET lease_expires_at=now()-interval '1 second' WHERE account_id=$1",[a.id]);
 const queueCheck=async()=>{const setup=(await request('GET',`/v1/numbers/${a.id}/setup`)).json().data;const queued=await request('POST',`/v1/numbers/${a.id}/setup/commands`,{action:'check_health',expected_version:setup.account_version,expected_session_version:setup.session_version,reason:'Verify current health after worker replacement'});expect(queued.statusCode,queued.body).toBe(202);return queued.json().data.command_id as string;};
 const first=await queueCheck();provider.health=async()=>{healthCalls++;return observed('OK');};
 await processChannelCommands(100,candidate=>candidate.id===a.id&&candidate.workspace_id===a.workspace_id?provider:new SimulatorProvider(),newOwner);
 expect((await pool.query('SELECT status,result FROM commands WHERE id=$1',[first])).rows[0]).toMatchObject({status:'FAILED',result:{error:'VERIFIED_ISOLATION_PROOF_REQUIRED',remote_outcome:'NOT_ATTEMPTED'}});
 expect(healthCalls).toBe(1);
 const previous=(await pool.query('SELECT owner_id,generation FROM session_ownership WHERE account_id=$1',[a.id])).rows[0];
 await pool.query("INSERT INTO ownership_isolation_receipts(workspace_id,account_id,previous_owner_id,generation,method,evidence_sha256,verified_at) VALUES($1,$2,$3,$4,'container_stopped_and_access_revoked',$5,now())",[workspace,a.id,previous.owner_id,previous.generation,'a'.repeat(64)]);
 const second=await queueCheck();await processChannelCommands(100,candidate=>candidate.id===a.id&&candidate.workspace_id===a.workspace_id?provider:new SimulatorProvider(),newOwner);
 expect((await pool.query('SELECT status,result FROM commands WHERE id=$1',[second])).rows[0]).toMatchObject({status:'APPLIED',result:{status:'CHECKED'}});
 expect((await pool.query('SELECT owner_id,frozen,lease_expires_at>now() AS live FROM session_ownership WHERE account_id=$1',[a.id])).rows[0]).toMatchObject({owner_id:newOwner,frozen:false,live:true});
 expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind='incident' AND body->>'account_id'=$2 AND body->>'reason'='CHANNEL_HEALTH_BLOCKED' AND body->>'status'='OPEN'",[workspace,a.id])).rows[0].n).toBe(0);
 expect((await pool.query("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='channel.health_recovered'",[workspace,a.id])).rows[0].n).toBe(1);
 expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
 expect({healthCalls,lifecycleCalls}).toEqual({healthCalls:2,lifecycleCalls:0});
});

it('recovers a Cloud health incident only after current transport and official quality are healthy',async()=>{
 const a=await account('cloud'),owner='cloud-health-recovery-owner',provider=new SimulatorProvider();await acquireOwnership(a,owner);await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[a.id]);
 const observed=(offset:number,quality:'BLOCKED'|'OK'):HealthSignal[]=>{const at=new Date(Date.now()+offset),expiresAt=new Date(at.getTime()+60000).toISOString();return[
  {dimension:'transport',status:'OK',value:'GRAPH_READ_SUCCEEDED',source:'provider_read',scope:'account',availability:'supported',observedAt:at.toISOString(),expiresAt},
  {dimension:'quality',status:quality,value:quality==='OK'?'GREEN':'RED',source:'provider_read',scope:'account',availability:'supported',observedAt:at.toISOString(),expiresAt},
 ];};
	 const missingAt=new Date(Date.now()-3000);provider.health=async()=>[{dimension:'transport',status:'OK',value:'GRAPH_READ_SUCCEEDED',source:'provider_read',scope:'account',availability:'supported',observedAt:missingAt.toISOString(),expiresAt:new Date(missingAt.getTime()+60000).toISOString()}];await recordHealth(a,()=>provider);expect((await getRecord(pool,workspace,'channel_account',a.id))!.body.health_status).toBe('UNKNOWN');expect((await pool.query('SELECT frozen FROM session_ownership WHERE account_id=$1',[a.id])).rows[0].frozen).toBe(true);
 provider.health=async()=>observed(-2000,'BLOCKED');await recordHealth(a,()=>provider);expect((await pool.query('SELECT frozen FROM session_ownership WHERE account_id=$1',[a.id])).rows[0].frozen).toBe(true);
 provider.health=async()=>observed(-1000,'OK');await recordHealth(a,()=>provider);
 expect((await getRecord(pool,workspace,'channel_account',a.id))!.body.health_status).toBe('OK');expect((await pool.query('SELECT frozen FROM session_ownership WHERE account_id=$1',[a.id])).rows[0].frozen).toBe(false);
 expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind='incident' AND body->>'account_id'=$2 AND body->>'reason'='CHANNEL_HEALTH_BLOCKED' AND body->>'status'='OPEN'",[workspace,a.id])).rows[0].n).toBe(0);
 expect((await pool.query("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='channel.health_recovered'",[workspace,a.id])).rows[0].n).toBe(1);
});

it.each(['fence','identity','restriction'] as const)('keeps recovery frozen when %s evidence is unsafe',async failure=>{
 const a=await account(),owner='health-negative-'+failure,provider=new SimulatorProvider();await acquireOwnership(a,owner);await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[a.id]);
 let healthCalls=0,lifecycleCalls=0;
 const observed=(offset:number,status:'BLOCKED'|'UNKNOWN'|'OK',fingerprint='fixture-identity'):HealthSignal[]=>{const at=new Date(Date.now()+offset);return[...signals('WORKING',fingerprint,at),{dimension:'restriction',status,value:status==='OK'?{latest_read:{timelock:true,capping:true}}:status==='UNKNOWN'?{latest_read:{timelock:true,capping:false}}:{reachout_timelock:{isActive:true}},source:'provider_read',scope:'account',availability:'supported',observedAt:at.toISOString(),expiresAt:new Date(at.getTime()+60000).toISOString()}];};
 provider.lifecycle=async()=>{lifecycleCalls++;return{status:'WORKING'};};provider.health=async()=>{healthCalls++;return observed(-3000,'BLOCKED');};await recordHealth(a,()=>provider);
 provider.health=async()=>{healthCalls++;if(failure==='fence')await pool.query('UPDATE session_ownership SET generation=generation+1 WHERE account_id=$1',[a.id]);return observed(-1000,failure==='restriction'?'UNKNOWN':'OK',failure==='identity'?'other-identity':'fixture-identity');};await recordHealth(a,()=>provider);
 expect((await pool.query('SELECT frozen FROM session_ownership WHERE account_id=$1',[a.id])).rows[0].frozen).toBe(true);
 expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind='incident' AND body->>'account_id'=$2 AND body->>'reason'='CHANNEL_HEALTH_BLOCKED' AND body->>'status'='OPEN'",[workspace,a.id])).rows[0].n).toBe(1);
 expect((await pool.query("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='channel.health_recovered'",[workspace,a.id])).rows[0].n).toBe(0);
 expect({healthCalls,lifecycleCalls}).toEqual({healthCalls:2,lifecycleCalls:0});
});
it('deduplicates per-account maintenance alerts and preserves unknown notification receipt',async()=>{
 const a=await account(),b=await account(),now=new Date();await pool.query("UPDATE channel_sessions SET primary_last_used_at=$2 WHERE account_id=ANY($1::uuid[])",[[a.id,b.id],new Date(now.getTime()-12*86400000)]);await collectSessionAlerts(now);await collectSessionAlerts(now);
 const rows=(await pool.query("SELECT * FROM operational_alerts WHERE account_id=ANY($1::uuid[]) AND kind='PRIMARY_DUE_12'",[[a.id,b.id]])).rows;expect(rows).toHaveLength(2);expect(rows.every(r=>r.status==='PENDING'&&!r.acknowledged_at)).toBe(true);
 await collectSessionAlerts(new Date(now.getTime()+86400000));expect((await pool.query("SELECT count(*)::int n FROM operational_alerts WHERE account_id=ANY($1::uuid[]) AND kind='PRIMARY_DUE_13'",[[a.id,b.id]])).rows[0].n).toBe(2);
});
it('polls 20 accounts fairly with bounded concurrency, including absent owners, without provider mutations',async()=>{
 // Existing fixtures are marked recently polled to isolate this synthetic scale sample.
 await pool.query('UPDATE channel_sessions SET last_health_at=now()');const accounts=[];for(let i=0;i<20;i++)accounts.push(await account());
 let active=0,peak=0;const seen=new Set<string>();const start=performance.now();
 await collectHealth(a=>{const p=new SimulatorProvider();p.health=async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,8));active--;seen.add(a.id);return signals();};p.lifecycle=async()=>{throw Error('NO_MUTATIONS_EXPECTED');};return p;});
 expect(accounts.every(a=>seen.has(a.id))).toBe(true);expect(peak).toBeLessThanOrEqual(4);expect(seen.size).toBe(20);expect(performance.now()-start).toBeLessThan(90000);
 expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
});
it('supervisor is disabled by default, respects pause and fences uncertain mutations without retry',async()=>{
 const a=await account();await superviseSessions();expect((await session(a)).last_attempt_id).toBeNull();
 await enableRecoveryPolicy();await configureRecovery(a);
 // No prior operational owner: fresh simulated fixture has no real remote side effect.
 await recoveryEvidence(a,'continuity-owner');await Promise.all([superviseSessions(),superviseSessions()]);let s=await session(a);expect(s.retry_count).toBe(1);
 const provider=new SimulatorProvider();let calls=0;provider.lifecycle=async()=>{calls++;throw Error('lost response');};await processChannelCommands(100,candidate=>candidate.id===a.id&&candidate.workspace_id===a.workspace_id?provider:new SimulatorProvider(),'continuity-owner');expect(calls).toBe(1);
 await pool.query("UPDATE channel_sessions SET next_retry_at=now()-interval '1 second' WHERE account_id=$1",[a.id]);await superviseSessions();s=await session(a);expect(s.retry_count).toBe(1);expect(s.recovery_blocker).toBe('OWNERSHIP_FROZEN');
 expect((await pool.query("SELECT result FROM commands WHERE id=$1",[s.last_attempt_id])).rows[0].result.remote_outcome).toBe('UNKNOWN');
});

it('database rejects cross-workspace session and history writes',async()=>{
 const a=await account(),s=await session(a);
 await expect(pool.query('UPDATE channel_sessions SET workspace_id=$2 WHERE id=$1',[s.id,'foreign'])).rejects.toThrow('CHANNEL_SESSION_SCOPE_INVALID');
 await expect(pool.query("INSERT INTO channel_session_events(session_id,account_id,workspace_id,environment,kind,actor_id,source,revision) VALUES($1,$2,'foreign','REAL','bad','test','fixture',1)",[s.id,a.id])).rejects.toThrow(/foreign key/);
});
it('a pause after queuing recovery cancels the mutation before contacting the provider',async()=>{
 const a=await account();await configureRecovery(a);await recoveryEvidence(a,'pause-owner');
 await superviseSessions();const queued=await session(a);expect(queued.last_attempt_id).toBeTruthy();
 const paused=await request('PATCH',`/v1/channel-accounts/${a.id}/session`,{expected_version:queued.revision,operational_pause:true,reason:'Pause wins before provider call'});expect(paused.statusCode,paused.body).toBe(200);
 let calls=0;const provider=new SimulatorProvider();provider.lifecycle=async()=>{calls++;return{status:'WORKING'};};await processChannelCommands(100,candidate=>candidate.id===a.id&&candidate.workspace_id===a.workspace_id?provider:new SimulatorProvider(),'pause-owner');expect(calls).toBe(0);
 expect((await pool.query('SELECT result FROM commands WHERE id=$1',[queued.last_attempt_id])).rows[0].result.remote_outcome).toBe('NOT_ATTEMPTED');
 const result=await request('GET',`/v1/commands/${queued.last_attempt_id}`);expect(result.statusCode,result.body).toBe(200);expect(result.json().data.status).toBe('FAILED');expect(result.json().data.result.remote_outcome).toBe('NOT_ATTEMPTED');
});

it('never queues or calls a provider while ownership, incidents or canonical health block recovery',async()=>{
 const a=await account();await enableRecoveryPolicy();await configureRecovery(a);await recoveryEvidence(a,'health-guard-owner',true);
 let calls=0;const provider=new SimulatorProvider();provider.lifecycle=async()=>{calls++;return{status:'WORKING'};};
 await superviseSessions();expect(await session(a)).toMatchObject({last_attempt_id:null,recovery_blocker:'OWNERSHIP_FROZEN'});await processChannelCommands(100,candidate=>candidate.id===a.id&&candidate.workspace_id===a.workspace_id?provider:new SimulatorProvider(),'health-guard-owner');expect(calls).toBe(0);

 await pool.query("UPDATE session_ownership SET frozen=false,lease_expires_at=now()+interval '1 minute' WHERE account_id=$1",[a.id]);
 const incident=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'incident',body:{account_id:a.id,status:'OPEN',reason:'CHANNEL_HEALTH_BLOCKED'}});
 await superviseSessions();expect(await session(a)).toMatchObject({last_attempt_id:null,recovery_blocker:'CHANNEL_HEALTH_INCIDENT_OPEN'});await processChannelCommands(100,candidate=>candidate.id===a.id&&candidate.workspace_id===a.workspace_id?provider:new SimulatorProvider(),'health-guard-owner');expect(calls).toBe(0);

 await putRecord(pool,{id:incident.id,workspaceId:workspace,environment:'REAL',kind:'incident',version:incident.version,body:{...incident.body,status:'RESOLVED'}});
 const now=Date.now();await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'health_signal',body:{account_id:a.id,dimension:'restriction',status:'BLOCKED',value:{reachout_timelock:{isActive:true}},source:'provider_read',scope:'account',availability:'supported',observed_at:new Date(now-500).toISOString(),expires_at:new Date(now+60000).toISOString()}});
 await superviseSessions();expect(await session(a)).toMatchObject({last_attempt_id:null,recovery_blocker:'RESTRICTION_CLEAR_READ_REQUIRED'});await processChannelCommands(100,candidate=>candidate.id===a.id&&candidate.workspace_id===a.workspace_id?provider:new SimulatorProvider(),'health-guard-owner');expect(calls).toBe(0);
 expect((await pool.query("SELECT count(*)::int n FROM commands WHERE resource_id=$1 AND payload->>'automatic_recovery'='true'",[a.id])).rows[0].n).toBe(0);
});

it('rejects health older than lifecycle and closes the QR stage only on verified identity without resuming',async()=>{
 const created=await account(),a=await putRecord(pool,{id:created.id,workspaceId:workspace,environment:'REAL',kind:'channel_account',version:created.version,body:{...created.body,last_lifecycle_at:new Date(Date.now()-1000).toISOString()}});
 await pool.query("UPDATE channel_sessions SET credential_generation=2,recovery_stage='AWAITING_NEW_QR',expected_identity_fingerprint='fixture-identity' WHERE account_id=$1",[a.id]);
 const provider=new SimulatorProvider();provider.health=async()=>signals('WORKING','fixture-identity',new Date(Date.now()-5000));await recordHealth(a,()=>provider);
 await appendEvent(pool,{workspace_id:workspace,environment:'REAL',event_type:'provider.session.observed',aggregate_id:a.id,payload:{status:'WORKING',provider_at:new Date(Date.now()-5000).toISOString(),envelope_id:randomUUID()}});await consumeProviderObservations(1000);
 expect((await session(a)).observed_state).toBe('UNKNOWN');expect((await getRecord(pool,workspace,'channel_account',a.id))!.body.status).toBe('STOPPED');
 provider.health=async()=>signals();await recordHealth(a,()=>provider);
 expect(await session(a)).toMatchObject({observed_state:'CONNECTED',auth_state:'VERIFIED',recovery_stage:'IDENTITY_VERIFIED_REVIEW_REQUIRED',desired_state:'STOPPED',operational_pause:true,recovery_enabled:false});
 expect((await getRecord(pool,workspace,'channel_account',a.id))!.body.sending_enabled).toBe(false);
 expect((await pool.query("SELECT count(*)::int n FROM channel_session_events WHERE account_id=$1 AND kind='recovery_identity_verified'",[a.id])).rows[0].n).toBe(1);
});
it('accepts a lifecycle-equal health read only when it carries the post-command ownership fence',async()=>{
 const lifecycleAt=new Date(Date.now()-1000),created=await account(),a=await putRecord(pool,{id:created.id,workspaceId:workspace,environment:'REAL',kind:'channel_account',version:created.version,body:{...created.body,last_lifecycle_at:lifecycleAt.toISOString()}}),owner='equal-health-owner';
 const acquired=await acquireOwnership(a,owner);expect(acquired).toMatchObject({acquired:true});
 const provider=new SimulatorProvider();provider.health=async()=>signals('WORKING','fixture-identity',lifecycleAt);
 await recordHealth(a,()=>provider);
 expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind='health_signal' AND body->>'account_id'=$2",[workspace,a.id])).rows[0].n).toBe(0);
 await recordHealth(a,()=>provider,{owner_id:owner,generation:acquired.generation!});
 expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind='health_signal' AND body->>'account_id'=$2 AND body->>'dimension'='session'",[workspace,a.id])).rows[0].n).toBe(1);
});
