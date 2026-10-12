import {explicitFixtureEnvironment} from './explicit-fixture-environment.js';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,getRecord,putRecord,withTransaction,readOperationalSettings,hash,stableJson,decrypt,appendEvent} from '../../packages/db/src/index.js';
import {readIntegrationSettings,saveIntegrationSetting,integrationReadiness} from '../../packages/db/src/integration-settings.js';
import {providerFor,assertGatewayIsolation,fulfillmentProviderFor} from '../../apps/channel-worker/src/providers.js';
const workspace='integrations-'+randomUUID(),other='integration-other-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
// V7 F2: fixture workspaces are adopted profiles (max three per installation).
beforeAll(()=>fixtureProfiles(workspace,other));
const secret='synthetic-access-token-fixture-only',replacement='synthetic-rotated-credential-only';
let app:FastifyInstance,cookie='',viewerCookie='',actor='';
let gatewayFixtureAccountId:string|undefined;
let quarantineFixtureAccountId:string|undefined,quarantineFixtureCommandId:string|undefined;
const call=(method:any,url:string,payload?:any,key=randomUUID(),useCookie=cookie)=>app.inject(explicitFixtureEnvironment({method,url,payload,headers:{cookie:useCookie,origin,'idempotency-key':key}}));
const patch=(expected_version:number,extra:Record<string,unknown>={})=>({expected_version,label:'Synthetic profile',enabled:true,config:{},secrets:{access_token:secret},reason:'Synthetic configuration review',...extra});
async function login(role:'owner'|'viewer'){const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');const user=await provisionUser({name:'Synthetic integration owner',email,password,workspace_id:workspace,role});if(role==='owner')actor=user.id;const result=await app.inject(explicitFixtureEnvironment({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.35',payload:{email,password},headers:{origin}}));return(Array.isArray(result.headers['set-cookie'])?result.headers['set-cookie']:[result.headers['set-cookie']]).filter(Boolean).map(x=>String(x).split(';')[0]).join('; ');}
beforeAll(async()=>{app=await createApp();cookie=await login('owner');viewerCookie=await login('viewer');});
afterAll(async()=>{
 try {
  // The quarantine assertion deliberately preserves a queued logout. Retire
  // only this synthetic fixture before another file runs the global worker.
  if(quarantineFixtureAccountId){
   const accountId=quarantineFixtureAccountId;
   await withTransaction(async c=>{
   if(quarantineFixtureCommandId){
    const removed=await c.query("DELETE FROM commands WHERE id=$1 AND workspace_id=$2 AND resource_id=$3 AND environment='REAL' AND kind='channel_command' RETURNING id",[quarantineFixtureCommandId,workspace,accountId]);
    expect(removed.rows).toEqual([{id:quarantineFixtureCommandId}]);
   }
   const account=await getRecord(c,workspace,'channel_account',accountId);
   expect(account?.environment).toBe('REAL');
   await putRecord(c,{id:account!.id,workspaceId:workspace,environment:'REAL',kind:'channel_account',version:account!.version,body:{...account!.body,deleted_at:new Date().toISOString(),sending_enabled:false}});
   expect((await c.query('SELECT archived_at IS NOT NULL AS archived FROM channel_sessions WHERE account_id=$1 AND workspace_id=$2',[accountId,workspace])).rows).toEqual([{archived:true}]);
  });
  }
  if(gatewayFixtureAccountId){
   const path='/v1/channel-accounts/'+gatewayFixtureAccountId+'?environment=REAL',account=await call('GET',path);
   expect(account.statusCode,account.body).toBe(200);
   const removed=await call('DELETE',path,{expected_version:account.json().data.version,confirmation:'DELETE_CHANNEL_ACCOUNT',reason:'Retire isolated integration gateway fixture'});
   expect(removed.statusCode,removed.body).toBe(200);
  }
 } finally {vi.unstubAllEnvs();await app.close();await pool.end();}
});
describe('Private owner integration settings, field-scoped DB runtime reads',()=>{
 it('denies viewer/service and ignores any process credential fallback',async()=>{
  expect((await call('GET','/v1/settings/integrations?environment=REAL',undefined,undefined,viewerCookie)).statusCode).toBe(403);
  const token=randomBytes(24).toString('hex');await pool.query("INSERT INTO service_tokens(workspace_id,actor_id,name,token_hash,scopes,expires_at) VALUES($1,$2,'Synthetic settings forbidden',$3,$4,now()+interval '1 hour')",[workspace,actor,hash(token),JSON.stringify(['catalog:read','catalog:write'])]);expect((await app.inject(explicitFixtureEnvironment({method:'GET',url:'/v1/settings/integrations?environment=REAL',headers:{authorization:'Bearer '+token}}))).statusCode).toBe(403);
  vi.stubEnv('WAHA_API_KEY',secret);vi.stubEnv('WAHA_URL','http://waha-01:3000');vi.stubEnv('FULFILLMENT_GRANT_TOKEN',secret);vi.stubEnv('FULFILLMENT_GRANT_URL','https://portal.example/grants');const a=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{provider:'waha',status:'DISCONNECTED',sending_enabled:false}});await expect(providerFor(a)).rejects.toThrow('PROVIDER_CONFIGURATION_REQUIRED_PROFILE');await expect(fulfillmentProviderFor(workspace,'REAL')).rejects.toThrow('FULFILLMENT_CONFIGURATION_REQUIRED');expect(await integrationReadiness(pool,workspace,'REAL','meta:fixture')).toMatchObject({configured:false,version:0});
 });
 it('encrypts, HMAC-deduplicates, masks and versions an owner edit, without persisting private input',async()=>{
  const key=randomUUID(),body=patch(0),result=await call('PUT','/v1/settings/integrations/meta:fixture?environment=REAL',body,key);expect(result.statusCode,result.body).toBe(200);expect(result.headers['cache-control']).toBe('no-store');expect(result.json().data).toMatchObject({version:1,secrets:{access_token:{configured:true}},operation_review_required:true});expect(result.body).not.toContain(secret);
  expect((await call('PUT','/v1/settings/integrations/meta:fixture?environment=REAL',body,key)).json()).toEqual(result.json());expect((await call('PUT','/v1/settings/integrations/meta:fixture?environment=REAL',patch(0,{label:'Different'}),key)).statusCode).toBe(409);
  expect((await readIntegrationSettings(pool,workspace,'REAL','meta:fixture'))?.secrets.access_token).toBe(secret);expect(await readIntegrationSettings(pool,other,'REAL','meta:fixture')).toBeUndefined();expect(await readIntegrationSettings(pool,workspace,'SIMULATION','meta:fixture')).toBeUndefined();
  const settings=await readOperationalSettings(pool,workspace,'REAL');expect(settings.version).toBe(1);expect(settings.body).toMatchObject({dispatch_frozen:true,real_sends_enabled:false,allow_real_operations:false});
  const idempotency=(await pool.query('SELECT request_hash,response FROM idempotency WHERE workspace_id=$1 AND key=$2',[workspace,key])).rows[0];expect(idempotency.request_hash).not.toBe(hash(stableJson({environment:'REAL',key:'meta:fixture',patch:{...body,clear_secrets:[]}})));
  for(const table of ['integration_settings','integration_setting_versions','idempotency','domain_events']){const rows=(await pool.query(`SELECT * FROM ${table} WHERE workspace_id=$1`,[workspace])).rows;expect(JSON.stringify(rows)).not.toContain(secret);}
  const ciphertext=(await pool.query('SELECT ciphertext FROM integration_secrets WHERE workspace_id=$1',[workspace])).rows[0].ciphertext;expect(ciphertext).not.toContain(secret);expect(JSON.parse(decrypt(ciphertext))).toMatchObject({workspace,environment:'REAL',key:'meta:fixture',field:'access_token',revision:1,value:secret});
  const visible=await call('GET','/v1/settings/integrations?environment=REAL');expect(visible.body).not.toContain(secret);expect(visible.body).not.toContain(ciphertext);expect(visible.headers['cache-control']).toBe('no-store');
 });
 it('retains omitted secrets, rejects stale edits/public secret fields, and explicitly clears only when disabled',async()=>{
  expect((await call('PUT','/v1/settings/integrations/meta:fixture?environment=REAL',patch(1,{secrets:{}}))).statusCode).toBe(200);expect((await readIntegrationSettings(pool,workspace,'REAL','meta:fixture'))?.secrets.access_token).toBe(secret);
  expect((await call('PUT','/v1/settings/integrations/meta:fixture?environment=REAL',patch(1))).statusCode).toBe(409);
  expect((await call('PUT','/v1/settings/integrations/meta:fixture?environment=REAL',patch(2,{label:secret}))).statusCode).toBe(400);
  expect((await call('PUT','/v1/settings/integrations/meta:fixture?environment=REAL',patch(2,{secrets:{},clear_secrets:['access_token']}))).statusCode).toBe(400);
  expect((await call('PUT','/v1/settings/integrations/meta:fixture?environment=REAL',patch(2,{secrets:{access_token:replacement}}))).statusCode).toBe(200);expect((await readIntegrationSettings(pool,workspace,'REAL','meta:fixture'))?.secrets.access_token).toBe(replacement);
  expect((await call('PUT','/v1/settings/integrations/meta:fixture?environment=REAL',patch(3,{enabled:false,secrets:{},clear_secrets:['access_token']}))).statusCode).toBe(200);expect(await integrationReadiness(pool,workspace,'REAL','meta:fixture')).toMatchObject({configured:false,enabled:false,version:4,missing:['access_token']});
  await expect(pool.query("UPDATE integration_setting_versions SET reason='overwrite' WHERE workspace_id=$1",[workspace])).rejects.toThrow('IMMUTABLE_INTEGRATION_SETTINGS_HISTORY');
 });
 it('blocks hot gateway rotation, then reads the new disconnected revision without restarting',async()=>{
  const initial={expected_version:0,label:'Synthetic gateway',enabled:true,config:{base_url:'http://waha-01:3000'},secrets:{api_key:secret,webhook_secret:'synthetic-hmac-callback-secret'},reason:'Synthetic initial gateway'};
  expect((await call('PUT','/v1/settings/integrations/waha:GW?environment=REAL',initial)).statusCode).toBe(200);
  const account=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{provider:'waha',gateway_ref:'GW',status:'SCAN_QR_CODE',sending_enabled:false}});
  gatewayFixtureAccountId=account.id;
  expect((await call('PUT','/v1/settings/integrations/waha:GW?environment=REAL',{...initial,expected_version:1,secrets:{api_key:replacement}})).statusCode).toBe(409);
  await pool.query("UPDATE records SET body=body||'{\"status\":\"DISCONNECTED\"}'::jsonb,version=version+1 WHERE id=$1",[account.id]);expect((await call('PUT','/v1/settings/integrations/waha:GW?environment=REAL',{...initial,expected_version:1,secrets:{api_key:replacement}})).statusCode).toBe(200);
  expect((await providerFor(account)).capabilities).toBeDefined();expect((await readIntegrationSettings(pool,workspace,'REAL','waha:GW'))?.secrets.api_key).toBe(replacement);
  await expect(providerFor({...account,environment:'SIMULATION'})).rejects.toThrow('SIMULATION_EXTERNAL_PROVIDER_DENIED');
  await withTransaction(c=>saveIntegrationSetting(c,other,'REAL','waha:OTHER',{...initial,clear_secrets:[]},actor));await expect(putRecord(pool,{workspaceId:other,environment:'REAL',kind:'channel_account',body:{provider:'waha',gateway_ref:'OTHER',session:'default'}})).rejects.toMatchObject({code:'23505',constraint:'channel_sessions_gateway_exclusive'});await expect(assertGatewayIsolation(account)).resolves.toBeUndefined();
 });
 it('quarantines UNKNOWN gateways without touching pending commands or remote state',async()=>{
  const profileKey='waha:QUARANTINE',url=`/v1/settings/integrations/${profileKey}/disable?environment=REAL`;
  const initial={expected_version:0,label:'Synthetic quarantine gateway',enabled:true,config:{base_url:'http://waha-02:3000'},secrets:{api_key:secret,webhook_secret:'synthetic-quarantine-callback-secret'},reason:'Synthetic initial quarantine profile'};
  expect((await call('PUT',`/v1/settings/integrations/${profileKey}?environment=REAL`,initial)).statusCode).toBe(200);
  const a=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{provider:'waha',gateway_ref:'QUARANTINE',status:'UNKNOWN',sending_enabled:false}});
  quarantineFixtureAccountId=a.id;
  const cmd=(await pool.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,status,result,idempotency_key) VALUES($1,'REAL','channel_command',$2,$3,$4,'PENDING','{}',$5) RETURNING *",[workspace,a.id,actor,{type:'logout'},randomUUID()])).rows[0];
  quarantineFixtureCommandId=cmd.id;
  const beforeSession=(await pool.query('SELECT * FROM channel_sessions WHERE account_id=$1',[a.id])).rows[0],beforePolicy=await readOperationalSettings(pool,workspace,'REAL'),beforeProfile=await readIntegrationSettings(pool,workspace,'REAL',profileKey);
  expect((await call('PUT',`/v1/settings/integrations/${profileKey}?environment=REAL`,{...initial,expected_version:1,enabled:false,secrets:{}})).statusCode).toBe(409);
  const key=randomUUID(),input={expected_version:1,reason:'Quarantine while the previous host and pending command are reconciled'};
  const disabled=await call('POST',url,input,key);expect(disabled.statusCode,disabled.body).toBe(200);expect(disabled.headers['cache-control']).toBe('no-store');expect(disabled.json().data).toMatchObject({version:2,enabled:false,changed:true,remote_state:'UNOBSERVED',operation_review_required:true,operational_revision:beforePolicy.version+1});
  expect(disabled.body).not.toContain(secret);expect((await call('POST',url,input,key)).json()).toEqual(disabled.json());expect((await call('POST',url,{...input,reason:'Different request'},key)).statusCode).toBe(409);
  const afterProfile=await readIntegrationSettings(pool,workspace,'REAL',profileKey);expect(afterProfile).toMatchObject({label:beforeProfile!.label,config:beforeProfile!.config,secrets:beforeProfile!.secrets,secret_fields:beforeProfile!.secret_fields,enabled:false,version:2});
  expect((await pool.query('SELECT * FROM commands WHERE id=$1',[cmd.id])).rows[0]).toEqual(cmd);expect((await pool.query('SELECT * FROM channel_sessions WHERE account_id=$1',[a.id])).rows[0]).toEqual(beforeSession);expect((await pool.query('SELECT body,version FROM records WHERE id=$1',[a.id])).rows[0]).toEqual({body:a.body,version:a.version});
  expect((await readOperationalSettings(pool,workspace,'REAL')).body).toMatchObject({dispatch_frozen:true,real_sends_enabled:false,allow_real_operations:false});
  expect((await call('POST',url,input)).statusCode).toBe(409);expect((await call('POST',url,{...input,expected_version:2,enabled:true})).statusCode).toBe(400);expect((await call('POST',url,{...input,expected_version:2,secrets:{api_key:replacement}})).statusCode).toBe(400);
  expect((await call('POST',url,{...input,expected_version:2},undefined,viewerCookie)).statusCode).toBe(403);
  expect((await call('POST','/v1/settings/integrations/meta:fixture/disable?environment=REAL',{...input,expected_version:2})).statusCode).toBe(400);
  expect((await call('POST',url,{...input,expected_version:2})).json().data).toMatchObject({version:2,changed:false,operational_revision:beforePolicy.version+1});
  expect((await call('PUT',`/v1/settings/integrations/${profileKey}?environment=REAL`,{...initial,expected_version:2,secrets:{}})).statusCode).toBe(409);
  expect((await pool.query("SELECT payload FROM domain_events WHERE workspace_id=$1 AND event_type='integration.settings_disabled' AND aggregate_id=$2 ORDER BY occurred_at LIMIT 1",[workspace,profileKey])).rows[0].payload).toMatchObject({changed:true,remote_state:'UNOBSERVED',profile_revision:2});
 });

 let frozenFixtureIndex=30;
 async function frozenProfile(test:(f:any)=>Promise<void>,provider:'waha'|'cloud'='waha'){
  const reference='FROZEN_'+randomUUID().replaceAll('-',''),key=provider+':'+reference;
  const remoteAddress='198.51.100.'+(++frozenFixtureIndex);
  const request=(method:any,url:string,payload?:any,key=randomUUID())=>app.inject(explicitFixtureEnvironment({method,url,payload,remoteAddress,headers:{cookie,origin,'idempotency-key':key}}));
  const initial={expected_version:0,label:'Retained synthetic gateway',enabled:false,config:provider==='waha'?{base_url:'http://waha-19:3000'}:{phone_number_id:'123456789012345',graph_version:'v26.0'},secrets:provider==='waha'?{api_key:secret,webhook_secret:'synthetic-retained-webhook-secret'}:{token:secret,app_secret:secret,verify_token:secret},clear_secrets:[],reason:'Prepare a frozen retained gateway'};
  expect((await request('PUT',`/v1/settings/integrations/${key}?environment=REAL`,initial)).statusCode).toBe(200);
  const account=await putRecord(pool,{...(provider==='cloud'?{id:'00000000-'+randomUUID().slice(9)}:{}),workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{provider,gateway_ref:reference,session:reference,status:'WORKING',sending_enabled:false}});
  await pool.query("UPDATE channel_sessions SET desired_state='STOPPED',operational_pause=true,recovery_enabled=false WHERE account_id=$1",[account.id]);
  await pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,frozen,lease_expires_at) VALUES($1,$2,'preserved-foreign-owner',7,true,now()-interval '1 minute')",[account.id,workspace]);
  const input={...initial,expected_version:1,enabled:true,secrets:{}};
  const snapshot=async()=>({account:(await pool.query('SELECT * FROM records WHERE id=$1',[account.id])).rows[0],session:(await pool.query('SELECT * FROM channel_sessions WHERE account_id=$1',[account.id])).rows[0],ownership:(await pool.query('SELECT * FROM session_ownership WHERE account_id=$1',[account.id])).rows[0]});
  const originalPolicyBody=(await readOperationalSettings(pool,workspace,'REAL')).body,mediaTerminals:{id:string;event_type:string}[]=[];
  try{await test({account,key,input,snapshot,request,mediaTerminals});}finally{
   await pool.query("UPDATE operational_settings SET body=$2 WHERE workspace_id=$1 AND environment='REAL'",[workspace,originalPolicyBody]);
   await pool.query("DELETE FROM commands WHERE workspace_id=$1 AND environment='REAL' AND resource_id=$2",[workspace,account.id]);
   await pool.query("DELETE FROM outbox WHERE workspace_id=$1 AND environment='REAL' AND account_id=$2",[workspace,account.id]);
   await pool.query("INSERT INTO consumer_receipts(consumer,event_id) SELECT 'media-v1',id FROM domain_events WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='provider.media.observed' ON CONFLICT DO NOTHING",[workspace,account.id]);
   for(const event of mediaTerminals)await pool.query("INSERT INTO consumer_receipts(consumer,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[event.event_type==='channel.media.stored'?'media-sales-v1':'media-sales-failure-v1',event.id]);
   await pool.query("UPDATE warmup_pools SET enabled=false,paused=true WHERE group_id IN(SELECT id FROM warmup_groups WHERE workspace_id=$1 AND members @> jsonb_build_array(jsonb_build_object('account_id',$2::text)))",[workspace,account.id]);
   await pool.query("UPDATE number_operations SET state='CANCELLED' WHERE workspace_id=$1 AND input->>'account_id'=$2",[workspace,account.id]);
   const current=(await getRecord(pool,workspace,'channel_account',account.id))!;
   await putRecord(pool,{id:current.id,workspaceId:workspace,environment:'REAL',kind:'channel_account',version:current.version,body:{...current.body,deleted_at:new Date().toISOString()}});
   // Retire only this isolated test profile; no global worker fixture survives.
   await pool.query("UPDATE integration_settings SET enabled=false WHERE workspace_id=$1 AND environment='REAL' AND key=$2",[workspace,key]);
  }
 }
 it('enables unchanged retained credentials with a historical WORKING status while preserving the frozen account and ownership',async()=>frozenProfile(async({key,input,snapshot,request}:any)=>{
  const before=await snapshot(),profile=await readIntegrationSettings(pool,workspace,'REAL',key),policy=await readOperationalSettings(pool,workspace,'REAL'),idem=randomUUID();
  const result=await request('PUT',`/v1/settings/integrations/${key}?environment=REAL`,input,idem);
  expect(result.statusCode,result.body).toBe(200);expect(result.json().data).toMatchObject({enabled:true,version:2,operational_revision:policy.version+1});
  expect(await snapshot()).toEqual(before);expect(before.account.body.status).toBe('WORKING');
  const after=await readIntegrationSettings(pool,workspace,'REAL',key);expect(after).toMatchObject({enabled:true,version:2,label:profile!.label,config:profile!.config,secrets:profile!.secrets,secret_fields:profile!.secret_fields});
  expect((await request('PUT',`/v1/settings/integrations/${key}?environment=REAL`,input,idem)).json()).toEqual(result.json());
  expect((await readOperationalSettings(pool,workspace,'REAL')).version).toBe(policy.version+1);expect(await snapshot()).toEqual(before);
  expect(result.body).not.toContain(secret);
 }));
 it('ignores a deleted archived account sharing the profile with a frozen WORKING account',async()=>frozenProfile(async({account,key,input,snapshot,request}:any)=>{
  const retired=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{...account.body,status:'STOPPED',deleted_at:new Date().toISOString()}});
  const retiredSnapshot=async()=>({record:(await pool.query('SELECT * FROM records WHERE id=$1',[retired.id])).rows[0],session:(await pool.query('SELECT * FROM channel_sessions WHERE account_id=$1',[retired.id])).rows[0]});
  const before=await snapshot(),history=await retiredSnapshot(),profile=await readIntegrationSettings(pool,workspace,'REAL',key),policy=await readOperationalSettings(pool,workspace,'REAL'),idem=randomUUID();
  expect(history.record.body.deleted_at).toBeTruthy();expect(history.session.archived_at).toBeTruthy();expect(before.account.body.status).toBe('WORKING');expect(before.session.archived_at).toBeNull();
  const result=await request('PUT',`/v1/settings/integrations/${key}?environment=REAL`,input,idem);
  expect(result.statusCode,result.body).toBe(200);expect(result.json().data).toMatchObject({enabled:true,version:2,operational_revision:policy.version+1});
  expect(await snapshot()).toEqual(before);expect(await retiredSnapshot()).toEqual(history);
  expect(await readIntegrationSettings(pool,workspace,'REAL',key)).toMatchObject({enabled:true,version:2,label:profile!.label,config:profile!.config,secrets:profile!.secrets,secret_fields:profile!.secret_fields});
  expect((await request('PUT',`/v1/settings/integrations/${key}?environment=REAL`,input,idem)).json()).toEqual(result.json());
  expect((await readOperationalSettings(pool,workspace,'REAL')).version).toBe(policy.version+1);expect(await snapshot()).toEqual(before);expect(await retiredSnapshot()).toEqual(history);expect(result.body).not.toContain(secret);
 }));
 it.each(['empty','pending','nonterminal','stored','terminal failure','unrelated terminal'])('checks frozen enablement under commerce_api with %s media',async mode=>frozenProfile(async({account,key,input,snapshot,mediaTerminals}:any)=>{
  if(mode!=='empty'){
   const source=await appendEvent(pool,{workspace_id:workspace,environment:'REAL',event_type:'provider.media.observed',aggregate_id:account.id,payload:{}});
   if(['nonterminal','terminal failure','stored'].includes(mode))await withTransaction(async c=>{
    if(mode!=='nonterminal')await c.query("INSERT INTO consumer_receipts(consumer,event_id) VALUES('media-v1',$1)",[source.id]);
    mediaTerminals.push(await appendEvent(c,{workspace_id:workspace,environment:'REAL',event_type:mode==='stored'?'channel.media.stored':'channel.media.download_failed',aggregate_id:account.id,causation_id:source.id,payload:{terminal:mode==='terminal failure'}}));
   });
   if(mode==='unrelated terminal')for(const change of [{workspace_id:other},{environment:'SIMULATION' as const},{aggregate_id:randomUUID()},{causation_id:randomUUID()}])mediaTerminals.push(await appendEvent(pool,{workspace_id:workspace,environment:'REAL',event_type:'channel.media.stored',aggregate_id:account.id,causation_id:source.id,payload:{},...change}));
  }
  const before=await snapshot(),profile=await readIntegrationSettings(pool,workspace,'REAL',key),policy=await readOperationalSettings(pool,workspace,'REAL');
  const connection=new URL(process.env.DATABASE_URL!);connection.searchParams.set('options','-c role=commerce_api');
  const program=`
   import assert from 'node:assert/strict';import {createApp} from './apps/api/src/app.ts';import {pool} from './packages/db/src/index.ts';
   const f=JSON.parse(process.env.FROZEN_PROFILE_FIXTURE),app=await createApp();
   try{
    assert.equal((await pool.query('SELECT current_user role')).rows[0].role,'commerce_api');
    assert.equal((await pool.query("SELECT has_table_privilege(current_user,'consumer_receipts','SELECT') allowed")).rows[0].allowed,false);
    const result=await app.inject({method:'PUT',url:f.url,payload:f.input,headers:{cookie:f.cookie,origin:f.origin,'idempotency-key':f.idempotency}});
    console.log(JSON.stringify({status:result.statusCode,body:result.json()}));
   }finally{await app.close();await pool.end();}
  `;
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',program],{env:{...process.env,DATABASE_URL:connection.toString(),FROZEN_PROFILE_FIXTURE:JSON.stringify({url:`/v1/settings/integrations/${key}?environment=REAL`,input,cookie,origin,idempotency:randomUUID()})},timeout:30000,maxBuffer:1024*1024});
  const result=JSON.parse(stdout.trim()),allowed=['empty','stored','terminal failure'].includes(mode);
  expect(result.status,JSON.stringify(result.body)).toBe(allowed?200:409);expect(await snapshot()).toEqual(before);
  if(allowed){expect(result.body.data).toMatchObject({enabled:true,version:2,operational_revision:policy.version+1});expect(await readIntegrationSettings(pool,workspace,'REAL',key)).toMatchObject({secrets:profile!.secrets,secret_fields:profile!.secret_fields});}
  else{expect(result.body.error.code).toBe('INTEGRATION_DISCONNECT_REQUIRED');expect(await readIntegrationSettings(pool,workspace,'REAL',key)).toEqual(profile);expect(await readOperationalSettings(pool,workspace,'REAL')).toEqual(policy);}
 }));
 it.each([
  ['configuration',{config:{base_url:'http://waha-18:3000'}}],['label',{label:'Changed gateway label'}],['secret rotation',{secrets:{api_key:replacement}}],['secret clearing',{clear_secrets:['webhook_secret']}],['stale revision',{expected_version:0}],
 ])('still requires disconnection for a frozen profile %s change',async(_name,change)=>frozenProfile(async({key,input,snapshot,request}:any)=>{
  const before=await snapshot(),profile=await readIntegrationSettings(pool,workspace,'REAL',key),policy=await readOperationalSettings(pool,workspace,'REAL');
  const result=await request('PUT',`/v1/settings/integrations/${key}?environment=REAL`,{...input,...change});
  expect(result.statusCode,result.body).toBe(409);expect(await snapshot()).toEqual(before);expect(await readIntegrationSettings(pool,workspace,'REAL',key)).toEqual(profile);expect(await readOperationalSettings(pool,workspace,'REAL')).toEqual(policy);
 }));
 it.each(['live owner','unfrozen owner','running session','unpaused session','recovery enabled','health in flight','pending command','unknown command','unknown effect','pending media','active group','pending number operation','missing owner','sending enabled','unfrozen policy','active archived session'])('does not enable a frozen profile with %s',async state=>frozenProfile(async({account,key,input,snapshot,request}:any)=>{
  if(state==='active archived session')await pool.query('UPDATE channel_sessions SET archived_at=now() WHERE account_id=$1',[account.id]);
  if(state==='live owner')await pool.query("UPDATE session_ownership SET lease_expires_at=now()+interval '1 minute' WHERE account_id=$1",[account.id]);
  if(state==='unfrozen owner')await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[account.id]);
  if(state==='running session')await pool.query("UPDATE channel_sessions SET desired_state='RUNNING' WHERE account_id=$1",[account.id]);
  if(state==='unpaused session')await pool.query('UPDATE channel_sessions SET operational_pause=false WHERE account_id=$1',[account.id]);
  if(state==='recovery enabled')await pool.query('UPDATE channel_sessions SET recovery_enabled=true WHERE account_id=$1',[account.id]);
  if(state==='health in flight')await pool.query("UPDATE channel_sessions SET health_probe_until=now()+interval '1 minute' WHERE account_id=$1",[account.id]);
  if(state==='pending command'||state==='unknown command')await pool.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,status,result,idempotency_key) VALUES($1,'REAL','channel_command',$2,$3,$4,$5,$6,$7)",[workspace,account.id,actor,{type:'disconnect'},state==='pending command'?'PENDING':'FAILED',state==='pending command'?{}:{remote_outcome:'UNKNOWN'},randomUUID()]);
  if(state==='unknown effect')await pool.query("INSERT INTO outbox(workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,status,config_hash) VALUES($1,'REAL',$2,'synthetic','synthetic',$3,'{}','UNKNOWN','synthetic')",[workspace,account.id,randomUUID()]);
  if(state==='pending media')await appendEvent(pool,{workspace_id:workspace,environment:'REAL',event_type:'provider.media.observed',aggregate_id:account.id,payload:{}});
  if(state==='active group'){
   const profile=(await pool.query("INSERT INTO warmup_profiles(workspace_id,environment,config) VALUES($1,'REAL','{}') RETURNING id",[workspace])).rows[0].id;
   const group=(await pool.query("INSERT INTO warmup_groups(workspace_id,environment,provider,group_fingerprint,group_ciphertext,name,members,observed_at,expires_at,source) VALUES($1,'REAL','waha',$2,'synthetic','Synthetic blocked group',$3,now(),now()+interval '1 hour','synthetic') RETURNING id",[workspace,randomUUID(),JSON.stringify([{account_id:account.id}])])).rows[0].id;
   await pool.query("INSERT INTO warmup_pools(workspace_id,environment,profile_id,group_id,enabled,paused) VALUES($1,'REAL',$2,$3,true,false)",[workspace,profile,group]);
  }
  if(state==='pending number operation')await pool.query("INSERT INTO number_operations(workspace_id,environment,actor_id,action,state,input) VALUES($1,'REAL',$2,'GROUP_REFRESH','REQUESTED',$3)",[workspace,actor,{account_id:account.id,account_ids:[account.id]}]);
  if(state==='missing owner')await pool.query('DELETE FROM session_ownership WHERE account_id=$1',[account.id]);
  if(state==='sending enabled')await putRecord(pool,{id:account.id,workspaceId:workspace,environment:'REAL',kind:'channel_account',version:account.version,body:{...account.body,sending_enabled:true}});
  if(state==='unfrozen policy')await pool.query("UPDATE operational_settings SET body=body||'{\"dispatch_frozen\":false}'::jsonb WHERE workspace_id=$1 AND environment='REAL'",[workspace]);
  const before=await snapshot(),profile=await readIntegrationSettings(pool,workspace,'REAL',key),policy=await readOperationalSettings(pool,workspace,'REAL');
  const result=await request('PUT',`/v1/settings/integrations/${key}?environment=REAL`,input);
  expect(result.statusCode,result.body).toBe(409);expect(await snapshot()).toEqual(before);expect(await readIntegrationSettings(pool,workspace,'REAL',key)).toEqual(profile);expect(await readOperationalSettings(pool,workspace,'REAL')).toEqual(policy);
 }));

 it('blocks a shared Cloud profile when another associated account still has an active lease',async()=>frozenProfile(async({account,key,input,snapshot,request}:any)=>{
  const otherAccount=await putRecord(pool,{id:'ffffffff-'+randomUUID().slice(9),workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{...account.body,session:'other-'+randomUUID()}});
  await pool.query("UPDATE channel_sessions SET desired_state='STOPPED',operational_pause=true,recovery_enabled=false WHERE account_id=$1",[otherAccount.id]);
  await pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,frozen,lease_expires_at) VALUES($1,$2,'other-current-owner',4,true,now()+interval '1 minute')",[otherAccount.id,workspace]);
  try{
   const before=await snapshot(),otherBefore=await getRecord(pool,workspace,'channel_account',otherAccount.id),ownership=(await pool.query('SELECT * FROM session_ownership WHERE account_id=$1',[otherAccount.id])).rows[0],profile=await readIntegrationSettings(pool,workspace,'REAL',key),policy=await readOperationalSettings(pool,workspace,'REAL');
   const result=await request('PUT',`/v1/settings/integrations/${key}?environment=REAL`,input);
   expect(result.statusCode,result.body).toBe(409);expect(await snapshot()).toEqual(before);expect(await getRecord(pool,workspace,'channel_account',otherAccount.id)).toEqual(otherBefore);expect((await pool.query('SELECT * FROM session_ownership WHERE account_id=$1',[otherAccount.id])).rows[0]).toEqual(ownership);expect(await readIntegrationSettings(pool,workspace,'REAL',key)).toEqual(profile);expect(await readOperationalSettings(pool,workspace,'REAL')).toEqual(policy);
  }finally{const current=(await getRecord(pool,workspace,'channel_account',otherAccount.id))!;await putRecord(pool,{id:current.id,workspaceId:workspace,environment:'REAL',kind:'channel_account',version:current.version,body:{...current.body,deleted_at:new Date().toISOString()}});}
 },'cloud'));

 it('restricts decrypted field visibility to the role responsible for each provider operation',async()=>{
  for(const[key,config,secrets]of [['meta:rls',{}, {access_token:secret}],['openai:default',{base_url:'https://api.openai.com/v1',input_cost_per_million_minor:1,output_cost_per_million_minor:1},{api_key:secret}],['cloud:CLOUD',{phone_number_id:'123456789012345',graph_version:'v26.0'},{token:secret,app_secret:secret,verify_token:secret}],['fulfillment:default',{endpoint:'https://portal.example/grants'},{token:secret}]] as const)await withTransaction(c=>saveIntegrationSetting(c,workspace,'REAL',key,{expected_version:0,label:'Synthetic scoped profile',enabled:true,config,secrets,clear_secrets:[],reason:'Synthetic field role fixture'},actor));
  const expected:Record<string,string[]>={commerce_automation:['meta:access_token','openai:api_key'],commerce_ingress:['cloud:app_secret','cloud:verify_token','waha:webhook_secret'],commerce_channel:['cloud:token','fulfillment:token','waha:api_key','waha:webhook_secret']};
  for(const[role,fields]of Object.entries(expected)){const rows=await withTransaction(async c=>{await c.query('SET LOCAL ROLE '+role);return(await c.query('SELECT DISTINCT type,field FROM integration_secrets WHERE workspace_id=$1',[workspace])).rows;});expect(rows.map(r=>`${r.type}:${r.field}`).sort()).toEqual(fields.sort());await expect(withTransaction(async c=>{await c.query('SET LOCAL ROLE '+role);await c.query("UPDATE integration_settings SET enabled=true WHERE workspace_id=$1",[workspace]);})).rejects.toThrow('permission denied');}
  await withTransaction(async c=>{await c.query('SET LOCAL ROLE commerce_ingress');const cloud=await readIntegrationSettings(c,workspace,'REAL','cloud:CLOUD');expect(Object.keys(cloud!.secrets).sort()).toEqual(['app_secret','verify_token']);});
 });
 it('protects static portal access in catalog, history, idempotency and API metadata',async()=>{
  const code='synthetic-preescolar-private-code',reference=JSON.stringify({url:'https://portal.example/access',code,instructions:'Synthetic approved static access'}),payload={name:'Synthetic portal access',kind:'access',adapter:'link',delivery_reference:reference};
  const key=randomUUID(),result=await call('POST','/v1/assets?environment=REAL',payload,key);expect(result.statusCode,result.body).toBe(201);expect(result.body).not.toContain(code);expect((await call('POST','/v1/assets?environment=REAL',payload,key)).json()).toEqual(result.json());
  for(const table of ['records','record_versions','idempotency','domain_events']){const rows=(await pool.query(`SELECT * FROM ${table} WHERE workspace_id=$1`,[workspace])).rows;expect(JSON.stringify(rows)).not.toContain(code);}
  const asset=(await pool.query('SELECT body FROM records WHERE id=$1',[result.json().data.id])).rows[0].body;expect(JSON.parse(decrypt(asset.delivery_ciphertext)).delivery_reference).toBe(reference);expect((await call('POST','/v1/assets?environment=REAL',{...payload,name:code})).statusCode).toBe(400);expect((await call('POST','/v1/assets?environment=REAL',{...payload,delivery_reference:'invalid'})).statusCode).toBe(400);
 });
});
