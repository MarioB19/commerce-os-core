import {explicitFixtureEnvironment} from './explicit-fixture-environment.js';
import {afterAll,beforeAll,describe,expect,it,beforeEach} from 'vitest';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {disposeAllFixtureProfiles} from '../support/migrated-database.js';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {pool,putRecord,withTransaction,readOperationalSettings,writeOperationalSettings,bumpOperationalRevision,hash,stableJson} from '../../packages/db/src/index.js';
import {defaultOperationalSettings} from '../../packages/contracts/src/index.js';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {gateDispatch} from '../../apps/channel-worker/src/dispatch.js';
import {acquireOwnership,heartbeatOwnership,processChannelCommands} from '../../apps/channel-worker/src/lifecycle.js';
import {SimulatorProvider} from '../../packages/messaging/src/index.js';

const workspace='operations-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:FastifyInstance,cookie:string,viewerCookie:string;
const enabled={...defaultOperationalSettings,dispatch_frozen:false,real_sends_enabled:true,allow_real_operations:true,allow_channel_onboarding:true};
const headers=(key:string=randomUUID())=>({cookie,origin,'idempotency-key':key});
async function login(role:'owner'|'viewer'){const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');await provisionUser({name:'Synthetic policy test',email,password,workspace_id:workspace,role});const r=await app.inject(explicitFixtureEnvironment({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.37',payload:{email,password},headers:{origin}}));return(Array.isArray(r.headers['set-cookie'])?r.headers['set-cookie']:[r.headers['set-cookie']]).filter(Boolean).map(x=>String(x).split(';')[0]).join('; ');}
beforeAll(async()=>{app=await createApp();cookie=await login('owner');viewerCookie=await login('viewer');});
afterAll(async()=>{await app.close();await pool.end();});
const patch=(payload:Record<string,unknown>,key?:string)=>app.inject(explicitFixtureEnvironment({method:'PATCH',url:'/v1/settings/operations',headers:headers(key),payload}));
// V7 F2: in-case workspaces are adopted profiles; an installation admits three,
// so each case's own profiles are disposed before the next case.
beforeEach(()=>disposeAllFixtureProfiles(pool,[workspace]));
describe('Owner operational settings and approval revision',()=>{
 it('defaults closed despite process flags, isolates environments, and denies non-owner access',async()=>{
  process.env.REAL_SENDS_ENABLED='true';process.env.DISPATCH_FROZEN='false';process.env.ALLOW_REAL_OPERATIONS='true';
  const initial=await app.inject(explicitFixtureEnvironment({method:'GET',url:'/v1/settings/operations?environment=REAL',headers:{cookie}}));expect(initial.statusCode).toBe(200);expect(initial.json().data).toMatchObject({version:0,body:defaultOperationalSettings});
  expect((await app.inject(explicitFixtureEnvironment({method:'GET',url:'/v1/settings/operations',headers:{cookie:viewerCookie}}))).statusCode).toBe(403);
  const token=randomBytes(32).toString('base64url');await pool.query("INSERT INTO service_tokens(workspace_id,actor_id,name,token_hash,scopes,expires_at) VALUES($1,'synthetic','Synthetic operations denial',$2,$3,now()+interval '1 hour')",[workspace,hash(token),JSON.stringify(['catalog:read'])]);
  expect((await app.inject(explicitFixtureEnvironment({method:'GET',url:'/v1/settings/operations?environment=REAL',headers:{authorization:'Bearer '+token}}))).statusCode).toBe(403);
  const results=await Promise.all([patch({environment:'REAL',expected_version:0,reason:'Synthetic concurrent policy A',changes:{allow_channel_onboarding:true}}),patch({environment:'REAL',expected_version:0,reason:'Synthetic concurrent policy B',changes:{contact_messages_per_minute:8}})]);expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);
  expect((await readOperationalSettings(pool,workspace,'SIMULATION')).version).toBe(0);
 });
 it('replays idempotently, rejects unrecognized secret fields, and audits the revision',async()=>{
  const current=await readOperationalSettings(pool,workspace,'REAL'),key=randomUUID(),body={environment:'REAL',expected_version:current.version,reason:'Synthetic enable connection preparation',changes:{allow_channel_onboarding:true}};
  const first=await patch(body,key),replay=await patch(body,key);expect(first.statusCode).toBe(200);expect(replay.json()).toEqual(first.json());
  expect((await patch({...body,changes:{api_key:'not-a-secret-test'}})).statusCode).toBe(400);
  expect((await patch({...body,expected_version:first.json().data.version,changes:{contact_messages_per_minute:61}})).statusCode).toBe(400);
  const events=(await pool.query("SELECT payload FROM domain_events WHERE workspace_id=$1 AND event_type='operational_settings.updated'",[workspace])).rows;expect(events.at(-1)?.payload).toMatchObject({configuration_version:first.json().data.version,reason:body.reason});
 });
 it('integration changes increment the same revision and freeze dispatch without touching uncertain effects',async()=>{
  const current=await readOperationalSettings(pool,workspace,'REAL');await withTransaction(c=>writeOperationalSettings(c,workspace,'REAL',current.version,enabled,'synthetic'));
  const before=await readOperationalSettings(pool,workspace,'REAL'),next=await withTransaction(c=>bumpOperationalRevision(c,workspace,'REAL','synthetic-integration'));
  expect(next.version).toBe(before.version+1);expect(next.body).toMatchObject({dispatch_frozen:true,real_sends_enabled:false,allow_real_operations:false,allow_channel_onboarding:true});
 });
 it('deployment hold blocks dispatch without changing the commercial revision or grants',async()=>{
  const before=await readOperationalSettings(pool,workspace,'REAL');
  await pool.query("UPDATE operational_settings SET release_hold=true,release_hold_at=now() WHERE workspace_id=$1 AND environment='REAL'",[workspace]);
  try{
   const held=await readOperationalSettings(pool,workspace,'REAL');
   expect(held.version).toBe(before.version);expect(held.release_hold).toBe(true);expect(held.body.dispatch_frozen).toBe(true);
   expect((await patch({environment:'REAL',expected_version:before.version,reason:'Synthetic held policy change',changes:{allow_channel_onboarding:false}})).statusCode).toBe(409);
   const opened=await app.inject(explicitFixtureEnvironment({method:'POST',url:'/v1/settings/launch/switch?environment=REAL',headers:headers(),payload:{environment:'REAL',expected_version:before.version,action:'OPEN',reason:'Synthetic hold denial',confirmation:'CONFIRM_REAL_SWITCH'}}));
   expect(opened.statusCode).toBe(409);
   const paused=await app.inject(explicitFixtureEnvironment({method:'POST',url:'/v1/settings/launch/switch?environment=REAL',headers:headers(),payload:{environment:'REAL',expected_version:before.version,action:'PAUSE',reason:'Synthetic emergency pause during release',confirmation:'CONFIRM_REAL_SWITCH'}}));
   expect(paused.statusCode).toBe(200);expect(paused.json().data.readback.workspace_paused).toBe(true);
  }finally{await pool.query("UPDATE operational_settings SET release_hold=false WHERE workspace_id=$1 AND environment='REAL'",[workspace]);}
  expect((await readOperationalSettings(pool,workspace,'REAL')).version).toBe(before.version);
 });
 it('owner switch pauses and resumes without invalidating a current commercial revision',async()=>{
  const before=await readOperationalSettings(pool,workspace,'REAL');
  const switchAction=async(action:'OPEN'|'PAUSE')=>app.inject(explicitFixtureEnvironment({method:'POST',url:'/v1/settings/launch/switch?environment=REAL',headers:headers(),payload:{environment:'REAL',expected_version:(await readOperationalSettings(pool,workspace,'REAL')).version,action,reason:'Synthetic owner switch',confirmation:'CONFIRM_REAL_SWITCH'}}));
  const opened=await switchAction('OPEN');expect(opened.statusCode).toBe(200);
  const revision=opened.json().data.configuration_version;
  expect(revision).toBeGreaterThanOrEqual(before.version);
  const paused=await switchAction('PAUSE');expect(paused.statusCode).toBe(200);expect(paused.json().data.readback.workspace_paused).toBe(true);
  expect((await readOperationalSettings(pool,workspace,'REAL')).version).toBe(revision);
  const resumed=await switchAction('OPEN');expect(resumed.statusCode).toBe(200);expect(resumed.json().data.readback.workspace_paused).toBe(false);
  expect((await readOperationalSettings(pool,workspace,'REAL')).version).toBe(revision);
 });
 it('runtime DB roles cannot forge isolation proof or mutate policy',async()=>{
  for(const role of ['commerce_channel','commerce_automation','commerce_ingress'])await expect(withTransaction(async c=>{await c.query('SET LOCAL ROLE '+role);await c.query("UPDATE operational_settings SET version=version+1 WHERE workspace_id=$1",[workspace]);})).rejects.toThrow('permission denied');
  await expect(withTransaction(async c=>{await c.query('SET LOCAL ROLE commerce_api');await c.query("INSERT INTO ownership_isolation_receipts(workspace_id,account_id,previous_owner_id,generation,method,evidence_sha256,verified_at) VALUES($1,$2,'old',1,'container_stopped_and_access_revoked',$3,now())",[workspace,randomUUID(),'a'.repeat(64)]);})).rejects.toThrow('permission denied');
 });
 it('binds REAL authorization to current policy and account assignment, with an independent per-account send switch',async()=>{
  const ws='dispatch-policy-'+randomUUID();await fixtureProfiles(ws);const policy=await withTransaction(c=>writeOperationalSettings(c,ws,'REAL',0,enabled,'synthetic'));
  const account=await putRecord(pool,{workspaceId:ws,environment:'REAL',kind:'channel_account',body:{provider:'cloud',status:'WORKING',sending_enabled:true,assignment_revision:1}}),contact=await putRecord(pool,{workspaceId:ws,environment:'REAL',kind:'contact',body:{status:'LEAD'}}),offer=await putRecord(pool,{workspaceId:ws,environment:'REAL',kind:'offer',body:{status:'PUBLISHED'}});
  const conv=await putRecord(pool,{workspaceId:ws,environment:'REAL',kind:'conversation',body:{last_inbound_at:new Date().toISOString()}});
  const healthNow=Date.now(),health=(dimension:'transport'|'quality',status:'OK'|'BLOCKED',offset:number,value?:unknown)=>putRecord(pool,{workspaceId:ws,environment:'REAL',kind:'health_signal',body:{account_id:account.id,dimension,status,value,availability:'supported',source:'provider_read',scope:'account',observed_at:new Date(healthNow+offset).toISOString(),expires_at:new Date(healthNow+60_000).toISOString()}});
  await acquireOwnership(account,'policy-owner');await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[account.id]);await health('transport','OK',-4000,'GRAPH_READ_SUCCEEDED');
  const payload={kind:'text',actor_kind:'human',text:'Synthetic gate only',offer_version_id:offer.id},configHash=hash(stableJson({account_id:account.id,contact_id:contact.id,payload}));
  const auth=(await pool.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,configuration_version,expires_at) VALUES($1,'REAL','synthetic',$2,$3,$4,now()+interval '1 hour') RETURNING *",[ws,{mode:'channel_setup',assignment_revision:1,account_ids:[account.id],offer_version_ids:[offer.id],contact_ids:[contact.id],max_messages:1},configHash,policy.version])).rows[0];
  await pool.query("UPDATE records SET version=version+1,body=body||$2::jsonb WHERE id=$1",[account.id,{active_authorization_id:auth.id}]);
  const effect={id:randomUUID(),workspace_id:ws,environment:'REAL',account_id:account.id,contact_id:contact.id,conversation_id:conv.id,authorization_id:auth.id,config_hash:configHash,approval_hash:configHash,payload,expires_at:new Date(Date.now()+60_000),control_version:0};
  expect((await gateDispatch(pool,effect,'policy-owner')).reason).toBe('CHANNEL_HEALTH_BLOCKED');
  await health('quality','OK',-3000,'GREEN');const firstGate=await gateDispatch(pool,effect,'policy-owner');expect(firstGate.allowed,JSON.stringify(firstGate)).toBe(true);
  await health('quality','BLOCKED',-2000,'RED');expect((await gateDispatch(pool,effect,'policy-owner')).reason).toBe('CHANNEL_HEALTH_BLOCKED');await health('quality','OK',-1000,'GREEN');
  await withTransaction(async c=>{await c.query('SET LOCAL ROLE commerce_channel');expect((await gateDispatch(c,effect,'policy-owner')).allowed).toBe(true);});
  await pool.query("UPDATE records SET version=version+1,body=body||'{\"sending_enabled\":false}'::jsonb WHERE id=$1",[account.id]);expect((await gateDispatch(pool,effect,'policy-owner')).reason).toBe('ACCOUNT_SENDING_NOT_ENABLED');
  await pool.query("UPDATE records SET version=version+1,body=body||'{\"sending_enabled\":true,\"assignment_revision\":2}'::jsonb WHERE id=$1",[account.id]);expect((await gateDispatch(pool,effect,'policy-owner')).reason).toBe('CHANNEL_ASSIGNMENT_CHANGED');
  await pool.query("UPDATE records SET version=version+1,body=body||'{\"assignment_revision\":1}'::jsonb WHERE id=$1",[account.id]);await withTransaction(c=>writeOperationalSettings(c,ws,'REAL',policy.version,enabled,'synthetic-revision'));
  expect((await gateDispatch(pool,effect,'policy-owner')).reason).toBe('CONFIGURATION_CHANGED');
 });
});

async function ownershipFixture(body:Record<string,unknown>={}){const account=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{provider:'waha',status:'SCAN_QR_CODE',gateway_ref:'SYNTHETIC_'+randomUUID().replaceAll('-',''),sending_enabled:false,...body}});await acquireOwnership(account,'old-worker');await pool.query("UPDATE session_ownership SET lease_expires_at=now()-interval '1 second' WHERE account_id=$1",[account.id]);return account;}
async function receipt(accountId:string,overrides:Record<string,unknown>={}){const v={workspace,accountId,owner:'old-worker',generation:1,verified:null,...overrides};return(await pool.query("INSERT INTO ownership_isolation_receipts(workspace_id,account_id,previous_owner_id,generation,method,evidence_sha256,verified_at) VALUES($1,$2,$3,$4,'container_stopped_and_access_revoked',$5,COALESCE($6::timestamptz,now())) RETURNING id",[v.workspace,v.accountId,v.owner,v.generation,'a'.repeat(64),v.verified])).rows[0].id as string;}
describe('Exclusive ownership after recreation',()=>{
 it('recovers a frozen unlinked pilot with no effects and fences the old heartbeat',async()=>{const a=await ownershipFixture();expect(await acquireOwnership(a,'new-worker')).toMatchObject({acquired:true,generation:2});await heartbeatOwnership('old-worker');const state=(await pool.query('SELECT * FROM session_ownership WHERE account_id=$1',[a.id])).rows[0];expect(state).toMatchObject({owner_id:'new-worker',generation:2,frozen:true});});
 it('does not renew a generation this process never acquired even if its owner identifier is reused',async()=>{const a=await ownershipFixture();await acquireOwnership(a,'same-owner');await pool.query("UPDATE session_ownership SET generation=generation+1,lease_expires_at=now()+interval '10 seconds' WHERE account_id=$1",[a.id]);const before=(await pool.query('SELECT lease_expires_at FROM session_ownership WHERE account_id=$1',[a.id])).rows[0].lease_expires_at;await heartbeatOwnership('same-owner');expect((await pool.query('SELECT lease_expires_at FROM session_ownership WHERE account_id=$1',[a.id])).rows[0].lease_expires_at).toEqual(before);});
 it('requires receipt for linked accounts and consumes a generation-matched receipt atomically',async()=>{const a=await ownershipFixture({identity_fingerprint:'synthetic-linked'});expect((await acquireOwnership(a,'new-worker')).acquired).toBe(false);const id=await receipt(a.id);const results=await Promise.all([acquireOwnership(a,'new-worker-a'),acquireOwnership(a,'new-worker-b')]);expect(results.filter(r=>r.acquired),JSON.stringify(results)).toHaveLength(1);expect((await pool.query('SELECT consumed_at FROM ownership_isolation_receipts WHERE id=$1',[id])).rows[0].consumed_at).toBeTruthy();});
 it.each(['stale','wrong-generation','wrong-workspace'] as const)('rejects a %s receipt',async variant=>{const a=await ownershipFixture({identity_fingerprint:'synthetic-linked'});const id=await receipt(a.id,variant==='stale'?{verified:new Date(Date.now()-25*3600_000).toISOString()}:variant==='wrong-generation'?{generation:2}:{workspace:'another-workspace'}).catch((error:Error)=>{
  // V7 F2: the ownership scope (020) refuses a receipt outside its account's profile.
  if(variant==='wrong-workspace'&&/PROFILE_OWNERSHIP_/.test(error.message))return undefined;throw error;});
  if(variant==='wrong-workspace'){expect(id).toBeUndefined();expect((await acquireOwnership(a,'new-worker')).acquired).toBe(false);return;}
  expect((await acquireOwnership(a,'new-worker',id)).acquired).toBe(false);});
 it.each(['SENDING','UNKNOWN'] as const)('never transfers with %s effects even after installer isolation',async status=>{
  const a=await ownershipFixture(),id=await receipt(a.id);
  // Global worker scans in later tests must never see fabricated foreign references.
  const contact=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'contact',body:{identity:'lid:ownership-'+randomUUID(),status:'LEAD'}});
  const conversation=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'conversation',body:{account_id:a.id,contact_id:contact.id}});
  const effect=(await pool.query('INSERT INTO outbox(workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,config_hash,status) VALUES($1,\'REAL\',$2,$3,$4,$5,$6,\'synthetic\',$7) RETURNING id',[workspace,a.id,conversation.id,contact.id,randomUUID(),{kind:'text',text:'Synthetic ownership isolation'},status])).rows[0];
  try{expect((await acquireOwnership(a,'new-worker',id)).acquired).toBe(false);}
  finally{await pool.query('DELETE FROM outbox WHERE id=$1 AND workspace_id=$2',[effect.id,workspace]);}
 });
 it.each(['PENDING','FAILED'] as const)('does not infer isolation from an ambiguous %s lifecycle',async status=>{const a=await ownershipFixture();await pool.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,status,result,idempotency_key) VALUES($1,'REAL','channel_command',$2,'synthetic',$3,$4,$5,gen_random_uuid()::text)",[workspace,a.id,{type:'connect'},status,{processing_owner:'old-worker',error:'CHANNEL_COMMAND_INTERRUPTED_REQUIRES_REVIEW'}]);expect((await acquireOwnership(a,'new-worker')).acquired).toBe(false);});
 it('records a late lifecycle outcome without overwriting a newer generation',async()=>{
  // A global worker can reach a different account before this race fixture.
  // Only the target account may open its controlled provider-completion gate.
  const foreignWorkspace='foreign-lifecycle-'+randomUUID();await fixtureProfiles(foreignWorkspace);
  const foreign=await putRecord(pool,{workspaceId:foreignWorkspace,environment:'SIMULATION',kind:'channel_account',body:{provider:'simulator',status:'NEW',sending_enabled:false}});
  const foreignCommand=(await pool.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key) VALUES($1,'SIMULATION','channel_command',$2,'synthetic',$3,gen_random_uuid()::text) RETURNING id",[foreignWorkspace,foreign.id,{type:'connect'}])).rows[0];
  const ws='late-lifecycle-'+randomUUID();await fixtureProfiles(ws);await withTransaction(c=>writeOperationalSettings(c,ws,'REAL',0,{...defaultOperationalSettings,allow_channel_onboarding:true},'synthetic'));
  const account=await putRecord(pool,{workspaceId:ws,environment:'REAL',kind:'channel_account',body:{provider:'waha',status:'SCAN_QR_CODE',gateway_ref:'SYNTHETIC_'+randomUUID().replaceAll('-',''),sending_enabled:false}});
  const command=(await pool.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key) VALUES($1,'REAL','channel_command',$2,'synthetic',$3,gen_random_uuid()::text) RETURNING id",[ws,account.id,{type:'connect'}])).rows[0];let entered!:()=>void,finish!:(value:{status:'WORKING'})=>void;const start=new Promise<void>(resolve=>{entered=resolve}),remote=new Promise<{status:'WORKING'}>(resolve=>{finish=resolve});
  const provider=new SimulatorProvider();provider.lifecycle=async()=>{entered();return remote;};const running=processChannelCommands(100,candidate=>candidate.id===account.id?provider:new SimulatorProvider(),'late-owner');await start;
  // Simulates a trusted isolation transfer while an earlier HTTP completion is still locally pending.
  try{expect((await pool.query("UPDATE session_ownership SET owner_id='replacement-owner',generation=generation+1,frozen=true WHERE account_id=$1 AND owner_id='late-owner' RETURNING generation",[account.id])).rows).toEqual([{generation:2}]);}
  finally{finish({status:'WORKING'});await running;}
  expect((await pool.query('SELECT status FROM commands WHERE id=$1',[foreignCommand.id])).rows[0].status).toBe('APPLIED');
  await pool.query("UPDATE records SET version=version+1,body=body||jsonb_build_object('deleted_at',now()::text) WHERE id=$1 AND workspace_id=$2 AND environment='SIMULATION'",[foreign.id,foreignWorkspace]);
  expect((await pool.query('SELECT body FROM records WHERE id=$1',[account.id])).rows[0].body.status).toBe('SCAN_QR_CODE');expect((await pool.query('SELECT result FROM commands WHERE id=$1',[command.id])).rows[0].result.error).toBe('OWNERSHIP_GENERATION_CHANGED');
 });
});
