import {explicitFixtureEnvironment} from './explicit-fixture-environment.js';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,getRecord,putRecord,withTransaction,readOperationalSettings,writeOperationalSettings} from '../../packages/db/src/index.js';
import {acquireOwnership,processChannelCommands} from '../../apps/channel-worker/src/lifecycle.js';
import {gateDispatch} from '../../apps/channel-worker/src/dispatch.js';
import {buildIngress} from '../../apps/ingress/src/server.js';
import {SimulatorProvider,type MessagingProvider} from '../../packages/messaging/src/index.js';
import {proposeEffect} from '../../apps/automation-worker/src/shared.js';
import type {DomainRecord} from '../../packages/contracts/src/index.js';

const workspace='removal-'+randomUUID(),owner='removal-worker',origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
// V7 F2: fixture workspaces are adopted profiles (max three per installation).
beforeAll(()=>fixtureProfiles(workspace));
let app:FastifyInstance,cookie:string,viewerCookie:string;
async function login(role:'owner'|'viewer') {
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Synthetic channel removal',email,password,workspace_id:workspace,role});
 const response=await app.inject(explicitFixtureEnvironment({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.27',payload:{email,password},headers:{origin}}));
 expect(response.statusCode).toBe(200);
 return [response.headers['set-cookie']].flat().filter(Boolean).map(x=>String(x).split(';')[0]).join('; ');
}
const request=(method:'GET'|'POST'|'DELETE'|'PATCH',path:string,payload?:object,auth=cookie,key=randomUUID())=>app.inject(explicitFixtureEnvironment({method,url:path,payload,headers:{cookie:auth,origin,'idempotency-key':key}}));
const path=(account:DomainRecord,suffix='')=>`/v1/channel-accounts/${account.id}${suffix}?environment=${account.environment}`;
const remove=(account:DomainRecord,auth=cookie,key=randomUUID())=>request('DELETE',path(account),{expected_version:account.version,confirmation:'DELETE_CHANNEL_ACCOUNT',reason:'Remove synthetic fixture'},auth,key);
const fresh=(account:DomainRecord)=>getRecord(pool,workspace,'channel_account',account.id);
async function account(status='DISCONNECTED',environment:'REAL'|'SIMULATION'='REAL') {
 return putRecord(pool,{workspaceId:workspace,environment,kind:'channel_account',body:{name:'Synthetic removable account',provider:environment==='REAL'?'waha':'simulator',gateway_ref:'TEST_'+randomUUID().replaceAll('-',''),status,sending_enabled:false}});
}
async function runCommand(a:DomainRecord,type:string) {
 const response=await request('POST',path(a,'/commands'),{type});expect(response.statusCode,response.body).toBe(202);
 const actions:string[]=[];const provider:MessagingProvider=new SimulatorProvider();provider.lifecycle=async action=>{actions.push(action);return{status:'STOPPED'};};
 await processChannelCommands(100,candidate=>candidate.id===a.id&&candidate.workspace_id===a.workspace_id?provider:new SimulatorProvider(),owner);
 const command=(await pool.query('SELECT * FROM commands WHERE id=$1',[response.json().data.id])).rows[0];return{actions,command};
}
beforeAll(async()=>{
 app=await createApp();cookie=await login('owner');viewerCookie=await login('viewer');
 await withTransaction(async c=>{const current=await readOperationalSettings(c,workspace,'REAL',{lock:'update'});await writeOperationalSettings(c,workspace,'REAL',current.version,{...current.body,allow_channel_onboarding:false,dispatch_frozen:true,real_sends_enabled:false,allow_real_operations:false},'synthetic-removal-policy');});
});
afterAll(async()=>{await app.close();await pool.end();});

describe('Channel disconnect, unlink and removal',()=>{
 it.each(['connect','restart'])('keeps %s gated without changing the observed session or calling the provider',async type=>{
  const a=await account('WORKING');await acquireOwnership(a,owner);
  if(type==='restart')await pool.query("UPDATE channel_sessions SET observed_state='AUTH_FAILURE',raw_state='FAILED',disconnect_reason='PROVIDER_FAILED_UNCLASSIFIED',provider_observed_at=now(),last_health_at=now(),health_expires_at=now()+interval '1 minute',revision=revision+1 WHERE account_id=$1",[a.id]);
  const result=await runCommand(a,type);expect(result.actions).toEqual([]);expect(result.command.status).toBe('FAILED');
  expect(result.command.result).toMatchObject({error:'QR_OPERATION_NOT_AUTHORIZED',diagnostic:{action:expect.stringContaining('Permitir conexión y QR')}});
  expect((await fresh(a))!.body.status).toBe('WORKING');
 });
 it.each(['disconnect','logout'])('allows %s while onboarding and real sends remain disabled',async type=>{
  const a=await account('WORKING'),other=await account('WORKING');await acquireOwnership(a,owner);await acquireOwnership(other,owner);
  await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[other.id]);
  const result=await runCommand(a,type);expect(result.actions).toEqual([type==='disconnect'?'stop':'logout']);expect(result.command.status).toBe('APPLIED');
  expect((await fresh(a))!.body).toMatchObject({status:'STOPPED',identity_verified:false,sending_enabled:false});
  if(type==='logout')expect((await fresh(a))!.body.unlinked_at).toBeTruthy();
  expect((await pool.query('SELECT paused FROM manual_controls WHERE workspace_id=$1 AND scope_id=$2',[workspace,a.id])).rows[0].paused).toBe(true);
  expect((await pool.query('SELECT frozen FROM session_ownership WHERE account_id=$1',[a.id])).rows[0].frozen).toBe(true);
  expect((await pool.query('SELECT frozen FROM session_ownership WHERE account_id=$1',[other.id])).rows[0].frozen).toBe(false);
  expect((await readOperationalSettings(pool,workspace,'REAL')).body).toMatchObject({allow_channel_onboarding:false,real_sends_enabled:false,dispatch_frozen:true});
 });
 it('requires channel permission, the correct environment and explicit removal confirmation',async()=>{
  const a=await account();expect((await remove(a,viewerCookie)).statusCode).toBe(403);
  expect((await request('POST',path(a,'/commands'),{type:'logout'},viewerCookie)).statusCode).toBe(403);
  expect((await request('DELETE',path({...a,environment:'SIMULATION'}),{expected_version:a.version,confirmation:'DELETE_CHANNEL_ACCOUNT',reason:'Synthetic cross environment'})).statusCode).toBe(404);
  expect((await request('DELETE',path(a),{expected_version:a.version,reason:'Missing confirmation'})).statusCode).toBe(400);
  expect((await fresh(a))!.body.deleted_at).toBeUndefined();
 });
 it('removes an unused number idempotently, preserves its record and releases the isolated gateway',async()=>{
  const a=await account(),key=randomUUID();const response=await remove(a,cookie,key);expect(response.statusCode,response.body).toBe(200);
  expect(response.json().data).toMatchObject({deleted:true,history_preserved:true});expect((await remove(a,cookie,key)).json()).toEqual(response.json());
  const list=await request('GET','/v1/channel-accounts?environment=REAL');expect(list.json().data.some((r:{id:string})=>r.id===a.id)).toBe(false);
  expect((await request('GET',path(a))).json().data.deleted_at).toBeTruthy();
  const replacement=await request('POST','/v1/channel-accounts?environment=REAL',{name:'Synthetic replacement',provider:'waha',gateway_ref:a.body.gateway_ref});expect(replacement.statusCode,replacement.body).toBe(201);expect(replacement.json().data.id).not.toBe(a.id);
  for(const [method,suffix,payload] of [['POST','/commands',{type:'connect'}],['PATCH','',{expected_version:2,name:'Resurrection'}],['POST','/activate',{expected_version:2,configuration_version:(await readOperationalSettings(pool,workspace,'REAL')).version,reason:'Synthetic resurrection blocked',confirmation:'ENABLE_REAL_ACCOUNT'}],['GET','/qr',undefined]] as const){const r=await request(method,path(a,suffix),payload);expect(r.statusCode,r.body).toBe(410);expect(r.json().error.code).toBe('CHANNEL_ACCOUNT_DELETED');}
 });
 it('rejects stale versions, connected sessions, queued commands and stopped but still linked WAHA sessions',async()=>{
  const active=await account('WORKING');expect((await remove(active)).json().error.code).toBe('DISCONNECT_BEFORE_DELETE');
  const a=await account();expect((await remove({...a,version:99})).json().error.code).toBe('VERSION_CONFLICT');
  const queued=await request('POST',path(a,'/commands'),{type:'disconnect'});expect((await remove(a)).json().error.code).toBe('CHANNEL_COMMAND_PENDING');
  await processChannelCommands(100,()=>new SimulatorProvider(),owner);expect((await pool.query('SELECT status FROM commands WHERE id=$1',[queued.json().data.id])).rows[0].status).toBe('APPLIED');
  expect((await remove((await fresh(a))!)).json().error.code).toBe('UNLINK_BEFORE_DELETE');
 });
 it('preserves sales and conversations after unlinking, revokes scopes and rejects later dispatch and ingress',async()=>{
  const a=await account('WORKING');await acquireOwnership(a,owner);
  const contact=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'contact',body:{name:'Synthetic history'}});
  const conversation=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'conversation',body:{account_id:a.id,contact_id:contact.id,status:'OPEN'}});
  const order=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'order',body:{account_id:a.id,conversation_id:conversation.id,status:'WON',amount_minor:9700,currency:'MXN'}});
  const authorization=(await pool.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at) VALUES($1,'REAL','synthetic',$2,$3,now()+interval '1 hour') RETURNING id",[workspace,{account_ids:[a.id],max_messages:1},'a'.repeat(64)])).rows[0];
  expect((await runCommand(a,'logout')).command.status).toBe('APPLIED');expect((await remove((await fresh(a))!)).statusCode).toBe(200);
  expect((await getRecord(pool,workspace,'conversation',conversation.id))!.body.account_id).toBe(a.id);expect((await getRecord(pool,workspace,'order',order.id))!.body.amount_minor).toBe(9700);
  expect((await pool.query('SELECT revoked_at FROM operation_authorizations WHERE id=$1',[authorization.id])).rows[0].revoked_at).toBeTruthy();
  expect(await gateDispatch(pool,{workspace_id:workspace,environment:'REAL',account_id:a.id,contact_id:contact.id,conversation_id:conversation.id},owner)).toEqual({allowed:false,reason:'CHANNEL_ACCOUNT_DELETED'});
  const ingress=await buildIngress();try{expect((await ingress.inject(explicitFixtureEnvironment({method:'POST',url:`/webhooks/waha/${workspace}/${a.id}`,payload:{},headers:{'content-type':'application/json'}}))).statusCode).toBe(404);}finally{await ingress.close();}
  expect((await pool.query("SELECT count(*) FROM domain_events WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='channel.deleted'",[workspace,a.id])).rows[0].count).toBe('1');
 });
 it('keeps a number with uncertain outgoing effects available for reconciliation',async()=>{
  const a=await account('STOPPED','SIMULATION');
  const contact=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'contact',body:{name:'Synthetic uncertainty'}});
  const conversation=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'conversation',body:{account_id:a.id,contact_id:contact.id,status:'OPEN'}});
  const effect=await withTransaction(c=>proposeEffect(c,conversation,{kind:'text',text:'Synthetic unsent fixture'},randomUUID()));
  await pool.query("UPDATE outbox SET status='UNKNOWN' WHERE id=$1",[effect.id]);expect((await remove(a)).json().error.code).toBe('CHANNEL_EFFECTS_UNRESOLVED');expect((await fresh(a))!.body.deleted_at).toBeUndefined();
 });
 it('does not delete a number while the worker is waiting for its remote lifecycle result',async()=>{
  const a=await account('STOPPED','SIMULATION');await acquireOwnership(a,owner);
  await request('POST',path(a,'/commands'),{type:'disconnect'});
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;}),remote=new Promise<void>(resolve=>{release=resolve;});
  const provider:MessagingProvider=new SimulatorProvider();provider.lifecycle=async()=>{entered();await remote;return{status:'STOPPED'};};
  const worker=processChannelCommands(100,candidate=>candidate.id===a.id&&candidate.workspace_id===a.workspace_id?provider:new SimulatorProvider(),owner);
  try{await started;expect((await remove(a)).json().error.code).toBe('CHANNEL_COMMAND_PENDING');expect((await fresh(a))!.body.deleted_at).toBeUndefined();}
  finally{release();await worker;}
  expect((await remove((await fresh(a))!)).statusCode).toBe(200);
 });
});
