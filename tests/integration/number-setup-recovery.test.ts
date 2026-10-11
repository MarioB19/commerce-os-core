import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {hash,pool,putRecord} from '../../packages/db/src/index.js';
import type {DomainRecord} from '../../packages/contracts/src/index.js';
import {processNumberOperations} from '../../apps/channel-worker/src/number-operations.js';

const workspace='number-setup-recovery-'+randomUUID();
const origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:FastifyInstance,cookie='';

const request=(method:any,path:string,body?:any)=>app.inject({method,url:path+(path.includes('?')?'&':'?')+'environment=REAL',payload:body,headers:{cookie,origin,'idempotency-key':randomUUID()}});
async function account(){return putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Synthetic setup recovery',provider:'waha',gateway_ref:'fixture-'+randomUUID(),status:'STOPPED',sending_enabled:false}});}
async function session(a:DomainRecord){return(await pool.query('SELECT * FROM channel_sessions WHERE account_id=$1',[a.id])).rows[0];}
async function setup(a:DomainRecord){const response=await request('GET',`/v1/numbers/${a.id}/setup`);expect(response.statusCode,response.body).toBe(200);return response.json().data;}
async function observed(a:DomainRecord,state:'AUTH_FAILURE'|'QR_REQUIRED'){
 const raw=state==='AUTH_FAILURE'?'FAILED':'SCAN_QR_CODE',auth=state==='QR_REQUIRED'?'QR_REQUIRED':'UNKNOWN',reason=state==='AUTH_FAILURE'?'PROVIDER_FAILED_UNCLASSIFIED':'QR_REQUIRED';
 const saved=(await pool.query("UPDATE channel_sessions SET observed_state=$2,auth_state=$3,raw_state=$4,disconnect_reason=$5,last_health_at=clock_timestamp(),provider_observed_at=clock_timestamp(),health_expires_at=clock_timestamp()+interval '5 minutes',revision=revision+1,updated_at=clock_timestamp() WHERE account_id=$1 RETURNING *",[a.id,state,auth,raw,reason])).rows[0];
 await pool.query("INSERT INTO channel_session_events(session_id,workspace_id,environment,account_id,kind,actor_id,source,evidence,revision,observed_at) VALUES($1,$2,'REAL',$3,'state_observed','fixture','provider_read',$4,$5,clock_timestamp())",[saved.id,workspace,a.id,{observed_state:state,raw_state:raw,reason},saved.revision]);
 return saved;
}
async function uncertain(a:DomainRecord,type:'connect'|'disconnect'){
 return(await pool.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,status,result,idempotency_key,created_at,updated_at) VALUES($1,'REAL','channel_command',$2,'fixture',$3,'FAILED',$4,$5,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '2 minutes') RETURNING *",[workspace,a.id,{type},{remote_outcome:'UNKNOWN',error:'CHANNEL_TIMEOUT'},randomUUID()])).rows[0];
}

beforeAll(async()=>{
 app=await createApp();
 const email=`setup-recovery-${randomUUID()}@example.invalid`,password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Synthetic setup owner',email,password,workspace_id:workspace,role:'owner'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.88',payload:{email,password},headers:{origin}});
 expect(login.statusCode).toBe(200);cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(value=>String(value).split(';')[0]).join('; ');
});
afterAll(async()=>{await app.close();await pool.end();});

describe('resumable number setup recovery',()=>{
 it('cancels an unclaimed logout while the service is unavailable, preserving the record and remote evidence',async()=>{
  const a=await account(),s=await session(a);
  const cmd=(await pool.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,status,result,idempotency_key) VALUES($1,'REAL','channel_command',$2,'fixture',$3,'PENDING','{}',$4) RETURNING *",[workspace,a.id,{type:'logout'},randomUUID()])).rows[0];
  let projection=await setup(a),connect=projection.steps.find((item:any)=>item.key==='CONNECT');
  expect(connect).toMatchObject({status:'BLOCKED',cause:'CHANNEL_WORKER_UNAVAILABLE',next_action:{type:'CANCEL_PENDING',command_id:cmd.id},evidence:{cancellable_command_ids:[cmd.id]}});
  expect(projection.available_commands).toEqual(['cancel_pending']);
  const duplicate=await request('POST',`/v1/numbers/${a.id}/setup/commands`,{action:'connect',expected_version:a.version,expected_session_version:s.revision,reason:'Must not enqueue another connection while logout is pending'});
  expect(duplicate.statusCode).toBe(409);expect(duplicate.json().error.message).toContain('servicio de conexión no está disponible');
  const cancel=await request('POST',`/v1/numbers/${a.id}/setup/commands`,{action:'cancel_pending',command_id:cmd.id,expected_version:a.version,expected_session_version:s.revision,reason:'Preserve the number and cancel only the logout that never started'});
  expect(cancel.statusCode,cancel.body).toBe(200);expect(cancel.json().data).toMatchObject({command_id:cmd.id,remote_outcome:'NOT_ATTEMPTED'});
  const saved=(await pool.query('SELECT * FROM commands WHERE id=$1',[cmd.id])).rows[0];
  expect(saved).toMatchObject({status:'FAILED',result:{error:'CHANNEL_COMMAND_CANCELLED_BEFORE_EXECUTION',remote_outcome:'NOT_ATTEMPTED'}});
  expect((await pool.query("SELECT payload FROM domain_events WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='number.setup.pending_cancelled'",[workspace,a.id])).rows[0].payload).toMatchObject({command_id:cmd.id,remote_outcome:'NOT_ATTEMPTED'});
  expect((await pool.query('SELECT version,body FROM records WHERE id=$1',[a.id])).rows[0]).toEqual({version:a.version,body:a.body});
  expect(await session(a)).toMatchObject({desired_state:'STOPPED',operational_pause:true,revision:s.revision+1,raw_state:s.raw_state,auth_state:s.auth_state,credential_generation:s.credential_generation});
  expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE account_id=$1',[a.id])).rows[0].n).toBe(0);
  projection=await setup(a);connect=projection.steps.find((item:any)=>item.key==='CONNECT');
  expect(connect.evidence.pending_command_ids).toEqual([]);expect(connect.evidence.uncertain_command_ids).toEqual([]);
  expect(projection.available_commands).toContain('connect');
  expect((await request('POST',`/v1/numbers/${a.id}/setup/commands`,{action:'cancel_pending',command_id:cmd.id,expected_version:a.version,expected_session_version:s.revision,reason:'Stale session revision must fail'})).statusCode).toBe(409);
 });

 it.each([{status:'PENDING',result:{processing_owner:'worker',started_at:new Date().toISOString()}},{status:'APPLIED',result:{status:'STOPPED'}},{status:'FAILED',result:{remote_outcome:'UNKNOWN'}}])('never cancels a claimed, completed or uncertain command: $status',async({status,result})=>{
  const a=await account(),s=await session(a);
  const cmd=(await pool.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,status,result,idempotency_key) VALUES($1,'REAL','channel_command',$2,'fixture',$3,$4,$5,$6) RETURNING *",[workspace,a.id,{type:'logout'},status,result,randomUUID()])).rows[0];
  const response=await request('POST',`/v1/numbers/${a.id}/setup/commands`,{action:'cancel_pending',command_id:cmd.id,expected_version:a.version,expected_session_version:s.revision,reason:'Cancellation must lose to an already claimed command'});
  expect(response.statusCode,response.body).toBe(409);expect(response.json().error.code).toBe('CHANNEL_COMMAND_NOT_CANCELLABLE');
  expect((await pool.query('SELECT status,result FROM commands WHERE id=$1',[cmd.id])).rows[0]).toEqual({status,result});
  expect((await session(a)).revision).toBe(s.revision);
  expect((await setup(a)).available_commands).not.toContain('cancel_pending');
 });

 it('scopes pending cancellation to the exact account and environment',async()=>{
  const a=await account(),other=await account(),s=await session(a);
  for(const [resource,environment]of [[other.id,'REAL'],[a.id,'SIMULATION']]){
   const cmd=(await pool.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,status,result,idempotency_key) VALUES($1,$2,'channel_command',$3,'fixture',$4,'PENDING','{}',$5) RETURNING id",[workspace,environment,resource,{type:'logout'},randomUUID()])).rows[0];
   const response=await request('POST',`/v1/numbers/${a.id}/setup/commands`,{action:'cancel_pending',command_id:cmd.id,expected_version:a.version,expected_session_version:s.revision,reason:'Never cancel another account or environment'});
   expect(response.statusCode).toBe(409);expect((await pool.query('SELECT status FROM commands WHERE id=$1',[cmd.id])).rows[0].status).toBe('PENDING');
  }
 });

 it('distinguishes a healthy worker from a stale heartbeat without changing the queued command',async()=>{
  const a=await account(),s=await session(a),now=Date.now();
  const cmd=(await pool.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,status,result,idempotency_key) VALUES($1,'REAL','channel_command',$2,'fixture',$3,'PENDING','{}',$4) RETURNING id",[workspace,a.id,{type:'connect'},randomUUID()])).rows[0];
  const heartbeat=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'service_heartbeat',body:{service:'channel-worker',status:'OK',observed_at:new Date(now).toISOString(),expires_at:new Date(now+60_000).toISOString()}});
  let connect=(await setup(a)).steps.find((item:any)=>item.key==='CONNECT');
  expect(connect).toMatchObject({status:'IN_PROGRESS',cause:'LIFECYCLE_COMMAND_PENDING',evidence:{worker:{ready:true,code:'READY'}}});
  const duplicate=await request('POST',`/v1/numbers/${a.id}/setup/commands`,{action:'connect',expected_version:a.version,expected_session_version:s.revision,reason:'Read the current pending command'});
  expect(duplicate.statusCode).toBe(409);expect(duplicate.json().error.message).toContain('Hay una orden pendiente');
  await putRecord(pool,{id:heartbeat.id,workspaceId:workspace,environment:'REAL',kind:heartbeat.kind,version:heartbeat.version,body:{...heartbeat.body,observed_at:new Date(now-120_000).toISOString(),expires_at:new Date(now-60_000).toISOString()}});
  connect=(await setup(a)).steps.find((item:any)=>item.key==='CONNECT');
  expect(connect).toMatchObject({status:'BLOCKED',cause:'CHANNEL_WORKER_STALE'});
  expect((await pool.query('SELECT status,result FROM commands WHERE id=$1',[cmd.id])).rows[0]).toEqual({status:'PENDING',result:{}});
 });

 it('keeps UNKNOWN from clearing a restriction and converges a later explicit clear to HEALTH READY and PREPARE without side effects',async()=>{
  const created=await account(),a=await putRecord(pool,{id:created.id,workspaceId:workspace,environment:'REAL',kind:'channel_account',version:created.version,body:{...created.body,status:'WORKING',identity_verified:true,identity_fingerprint:'fixture-health-identity',number_policy_version:'standard-15d/v2'}}),now=Date.now();
  await pool.query("UPDATE channel_sessions SET desired_state='RUNNING',observed_state='CONNECTED',auth_state='VERIFIED',raw_state='WORKING',last_health_at=clock_timestamp(),provider_observed_at=clock_timestamp(),health_expires_at=clock_timestamp()+interval '5 minutes',revision=revision+1 WHERE account_id=$1",[a.id]);
  await pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,frozen,lease_expires_at) VALUES($1,$2,'health-fixture',1,true,clock_timestamp()+interval '5 minutes') ON CONFLICT(account_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,frozen=true,lease_expires_at=EXCLUDED.lease_expires_at",[a.id,workspace]);
  const signal=(dimension:string,status:string,offset:number,value:unknown=null)=>putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'health_signal',body:{account_id:a.id,dimension,status,scope:'account',source:'provider_read',value,observed_at:new Date(now+offset).toISOString(),expires_at:new Date(now+300000).toISOString()}});
  await signal('session','OK',-4000,'WORKING');await signal('transport','OK',-4000,{identity_fingerprint:'fixture-health-identity'});await signal('restriction','BLOCKED',-3000,{reachout_timelock:{isActive:true}});
  let projection=await setup(a);expect(projection.steps.find((item:any)=>item.key==='HEALTH')).toMatchObject({status:'BLOCKED',cause:'HEALTH_BLOCKED'});
  await signal('restriction','UNKNOWN',-2000,{latest_read:{timelock:true,capping:false}});
  projection=await setup(a);expect(projection.steps.find((item:any)=>item.key==='HEALTH')).toMatchObject({status:'BLOCKED',cause:'HEALTH_BLOCKED'});
  const before=(await pool.query("SELECT (SELECT count(*) FROM commands WHERE resource_id=$1)::int commands,(SELECT count(*) FROM outbox WHERE account_id=$1)::int effects",[a.id])).rows[0];
  await signal('restriction','OK',-1000,{latest_read:{timelock:true,capping:true}});
  projection=await setup(a);expect(projection.steps.find((item:any)=>item.key==='HEALTH')).toMatchObject({status:'READY',cause:'HEALTH_CURRENT'});
  const number=await request('GET',`/v1/numbers/${a.id}`);expect(number.statusCode,number.body).toBe(200);expect(number.json().data.primary_state).toBe('ATTENTION');
  expect((await pool.query("SELECT (SELECT count(*) FROM commands WHERE resource_id=$1)::int commands,(SELECT count(*) FROM outbox WHERE account_id=$1)::int effects",[a.id])).rows[0]).toEqual(before);
  expect((await pool.query('SELECT frozen FROM session_ownership WHERE account_id=$1',[a.id])).rows[0].frozen).toBe(true);
 });

 it.each(['DRAINING','ERROR','UNKNOWN'] as const)('does not project a %s capacity slot as ready',async state=>{
  const a=await account();
  await pool.query('INSERT INTO number_capacity_slots(workspace_id,environment,host_ref,slot,state,account_id,readback) VALUES($1,\'REAL\',$2,1,$3,$4,\'{}\')',[workspace,'fixture-host-'+randomUUID(),state,a.id]);
  const projection=await setup(a),createStep=projection.steps.find((item:any)=>item.key==='CREATE');
  expect(createStep).toMatchObject({status:state==='UNKNOWN'?'UNKNOWN':'BLOCKED',cause:`CAPACITY_SLOT_${state}`,evidence:{slot_state:state}});
  expect(projection.status).not.toBe('READY');
 });

 it('resumes an expired identity read on the same versioned operation without a blind retry',async()=>{
  const a=await account(),identity='19995550123@c.us',now=new Date();
  await pool.query("INSERT INTO number_capacity_slots(workspace_id,environment,host_ref,slot,state,account_id,readback) VALUES($1,'REAL',$2,1,'CONNECTED',$3,'{}')",[workspace,'fixture-host-'+randomUUID(),a.id]);
  const current=await session(a);
  await pool.query("UPDATE channel_sessions SET desired_state='RUNNING',observed_state='CONNECTED',auth_state='UNKNOWN',raw_state='WORKING',last_health_at=clock_timestamp(),provider_observed_at=clock_timestamp(),health_expires_at=clock_timestamp()+interval '5 minutes',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1",[current.id]);
  const operation=(await pool.query("INSERT INTO number_operations(workspace_id,environment,actor_id,action,state,input,lease_owner,lease_until) VALUES($1,'REAL','fixture','IDENTITY_OBSERVE','PREPARING',$2,'expired-fixture',clock_timestamp()-interval '1 minute') RETURNING *",[workspace,{account_id:a.id}])).rows[0];
  let providerReads=0;
  const provider=async()=>({
   profile:async()=>{providerReads++;return{identity,name:'Synthetic identity'};},
   health:async()=>{providerReads++;return[{dimension:'transport',status:'OK',value:{identity_fingerprint:hash(identity)},source:'provider_read',scope:'account',availability:'supported',observedAt:now.toISOString(),expiresAt:new Date(now.getTime()+60_000).toISOString()}];},
  } as any);

  await processNumberOperations('expire-identity-read',provider);
  const expired=(await pool.query('SELECT * FROM number_operations WHERE id=$1',[operation.id])).rows[0];
  expect(expired).toMatchObject({state:'UNKNOWN',version:operation.version+1});
  expect(providerReads).toBe(0);

  let projection=await setup(a),identityStep=projection.steps.find((item:any)=>item.key==='IDENTITY');
  expect(identityStep).toMatchObject({status:'UNKNOWN',cause:'IDENTITY_OBSERVATION_UNKNOWN',evidence:{operation_id:operation.id,operation_state:'UNKNOWN',operation_version:expired.version},next_action:{type:'RESUME_IDENTITY_READ',operation_id:operation.id,expected_version:expired.version,command:{action:'resume_read'}}});
  expect(projection.available_commands).toContain('resume_read');
  expect(projection.available_commands).not.toContain('observe_identity');

  const blind=await request('POST',`/v1/numbers/${a.id}/setup/commands`,{action:'observe_identity',expected_version:a.version,expected_session_version:projection.session_version,reason:'A new identity read must not replace the uncertain operation'});
  expect(blind.statusCode,blind.body).toBe(409);expect(blind.json().error.code).toBe('IDENTITY_READ_RESUME_REQUIRED');
  expect((await pool.query("SELECT count(*)::int n FROM number_operations WHERE input->>'account_id'=$1 AND action='IDENTITY_OBSERVE'",[a.id])).rows[0].n).toBe(1);

  const resumed=await request('POST',`/v1/number-operations/${operation.id}/commands`,{action:'resume_read',expected_version:expired.version,reason:'Continue the same expired identity read'});
  expect(resumed.statusCode,resumed.body).toBe(202);
  expect(resumed.json().data).toMatchObject({operation_id:operation.id,state:'REQUESTED',version:expired.version+1});
  expect(providerReads).toBe(0);
  const stale=await request('POST',`/v1/number-operations/${operation.id}/commands`,{action:'resume_read',expected_version:expired.version,reason:'A stale resume must be rejected'});
  expect(stale.statusCode).toBe(409);expect(stale.json().error.code).toBe('VERSION_CONFLICT');

  projection=await setup(a);identityStep=projection.steps.find((item:any)=>item.key==='IDENTITY');
  expect(identityStep).toMatchObject({status:'IN_PROGRESS',cause:'IDENTITY_OBSERVATION_IN_PROGRESS',evidence:{operation_id:operation.id,operation_state:'REQUESTED'}});
  expect(projection.available_commands).not.toContain('observe_identity');
  expect(projection.available_commands).not.toContain('resume_read');

  await processNumberOperations('resume-identity-read',provider);
  expect(providerReads).toBe(2);
  expect((await pool.query('SELECT state FROM number_operations WHERE id=$1',[operation.id])).rows[0].state).toBe('SUCCEEDED');
  expect((await pool.query("SELECT count(*)::int n FROM number_operations WHERE input->>'account_id'=$1 AND action='IDENTITY_OBSERVE'",[a.id])).rows[0].n).toBe(1);
 });

 it('spends one restart for the whole failed episode and connect cannot bypass it',async()=>{
  const a=await account();await observed(a,'AUTH_FAILURE');let projection=await setup(a);
  expect(projection.restart.remaining).toBe(1);expect(projection.available_commands).toContain('restart');
  const first=await request('POST',`/v1/numbers/${a.id}/setup/commands`,{action:'restart',expected_version:a.version,expected_session_version:projection.session_version,reason:'Single bounded restart for synthetic failed episode'});
  expect(first.statusCode,first.body).toBe(202);const commandId=first.json().data.command_id;
  await pool.query("UPDATE commands SET status='APPLIED',result=$2,updated_at=clock_timestamp() WHERE id=$1",[commandId,{status:'RESTART_ACCEPTED'}]);
  // A later FAILED observation belongs to the same episode and must not create
  // a second restart budget.
  const current=await session(a);await pool.query("UPDATE channel_sessions SET provider_observed_at=clock_timestamp(),last_health_at=clock_timestamp(),health_expires_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp() WHERE id=$1",[current.id]);
  await pool.query("INSERT INTO channel_session_events(session_id,workspace_id,environment,account_id,kind,actor_id,source,evidence,revision,observed_at) VALUES($1,$2,'REAL',$3,'state_observed','fixture','provider_read',$4,$5,clock_timestamp())",[current.id,workspace,a.id,{observed_state:'AUTH_FAILURE',raw_state:'FAILED',reason:'PROVIDER_FAILED_UNCLASSIFIED'},current.revision]);
  projection=await setup(a);expect(projection.restart).toMatchObject({remaining:0,last_command_id:commandId});expect(projection.available_commands).not.toContain('restart');
  const retry=await request('POST',`/v1/numbers/${a.id}/setup/commands`,{action:'restart',expected_version:a.version,expected_session_version:projection.session_version,reason:'A second restart must remain blocked'});
  expect(retry.statusCode).toBe(409);expect(retry.json().error.code).toBe('SETUP_RESTART_LIMIT_REACHED');
  const connect=await request('POST',`/v1/numbers/${a.id}/setup/commands`,{action:'connect',expected_version:a.version,expected_session_version:projection.session_version,reason:'Connect must not bypass restart budget'});
  expect(connect.statusCode).toBe(409);expect(connect.json().error.code).toBe('CONNECT_REQUIRES_RESTART_PATH');
  expect((await pool.query("SELECT count(*)::int n FROM commands WHERE resource_id=$1 AND payload->>'type'='restart'",[a.id])).rows[0].n).toBe(1);
 });

 it('projects QR_REQUIRED after a completed connect step without offering connect again',async()=>{
  const a=await account();await pool.query("INSERT INTO number_capacity_slots(workspace_id,environment,host_ref,slot,state,account_id,readback) VALUES($1,'REAL',$2,1,'QR_PENDING',$3,'{}')",[workspace,'fixture-host-'+randomUUID(),a.id]);await observed(a,'QR_REQUIRED');
  const projection=await setup(a),connectStep=projection.steps.find((item:any)=>item.key==='CONNECT'),qrStep=projection.steps.find((item:any)=>item.key==='QR');
  expect(connectStep).toMatchObject({status:'READY',cause:'CONNECTION_READY_FOR_QR',next_action:null});
  expect(qrStep).toMatchObject({status:'REQUIRES_ATTENTION',cause:'QR_SCAN_REQUIRED',next_action:{type:'OPEN_QR'}});
  expect(projection.current_step).toBe('QR');expect(projection.available_commands).toEqual(['check_health']);
  const repeated=await request('POST',`/v1/numbers/${a.id}/setup/commands`,{action:'connect',expected_version:a.version,expected_session_version:projection.session_version,reason:'Do not reconnect while a fresh QR is ready'});
  expect(repeated.statusCode).toBe(409);expect(repeated.json().error.code).toBe('CONNECT_NOT_AVAILABLE_WHILE_QR_REQUIRED');
 });

 it('accepts UNKNOWN reconciliation only when outcome matches command direction and fresh observed state',async()=>{
  const connectAccount=await account(),connectCommand=await uncertain(connectAccount,'connect');await observed(connectAccount,'QR_REQUIRED');let projection=await setup(connectAccount);
  const directContradiction=await request('POST',`/v1/channel-accounts/${connectAccount.id}/session/recovery`,{action:'reconcile_command',command_id:connectCommand.id,outcome:'confirmed_not_applied',expected_version:projection.session_version,reason:'Synthetic contradiction through the legacy recovery surface'});
  expect(directContradiction.statusCode).toBe(409);expect(directContradiction.json().error.code).toBe('RECONCILIATION_OUTCOME_CONTRADICTS_OBSERVED_STATE');
  const contradicted=await request('POST',`/v1/numbers/${connectAccount.id}/setup/commands`,{action:'reconcile_unknown',command_id:connectCommand.id,outcome:'confirmed_not_applied',expected_version:connectAccount.version,expected_session_version:projection.session_version,reason:'Synthetic contradictory connect reconciliation'});
  expect(contradicted.statusCode).toBe(409);expect(contradicted.json().error.code).toBe('RECONCILIATION_OUTCOME_CONTRADICTS_OBSERVED_STATE');
  const applied=await request('POST',`/v1/numbers/${connectAccount.id}/setup/commands`,{action:'reconcile_unknown',command_id:connectCommand.id,outcome:'confirmed_applied',expected_version:connectAccount.version,expected_session_version:projection.session_version,reason:'Fresh QR proves the connect reached the provider'});
  expect(applied.statusCode,applied.body).toBe(202);expect((await pool.query('SELECT result FROM commands WHERE id=$1',[connectCommand.id])).rows[0].result).toMatchObject({reconciliation:'confirmed_applied',reconciliation_observation:{command_type:'connect',observed_state:'QR_REQUIRED'}});

  const disconnectAccount=await account(),disconnectCommand=await uncertain(disconnectAccount,'disconnect');await observed(disconnectAccount,'QR_REQUIRED');projection=await setup(disconnectAccount);
  const wrongDirection=await request('POST',`/v1/numbers/${disconnectAccount.id}/setup/commands`,{action:'reconcile_unknown',command_id:disconnectCommand.id,outcome:'confirmed_applied',expected_version:disconnectAccount.version,expected_session_version:projection.session_version,reason:'QR contradicts an applied disconnect'});
  expect(wrongDirection.statusCode).toBe(409);expect(wrongDirection.json().error.code).toBe('RECONCILIATION_OUTCOME_CONTRADICTS_OBSERVED_STATE');
  const notApplied=await request('POST',`/v1/numbers/${disconnectAccount.id}/setup/commands`,{action:'reconcile_unknown',command_id:disconnectCommand.id,outcome:'confirmed_not_applied',expected_version:disconnectAccount.version,expected_session_version:projection.session_version,reason:'Fresh QR proves disconnect was not applied'});
  expect(notApplied.statusCode,notApplied.body).toBe(202);expect((await pool.query('SELECT result FROM commands WHERE id=$1',[disconnectCommand.id])).rows[0].result.reconciliation).toBe('confirmed_not_applied');
 });
});
