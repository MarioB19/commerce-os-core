import {explicitFixtureEnvironment} from './explicit-fixture-environment.js';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord,getRecord,withTransaction} from '../../packages/db/src/index.js';
import {writeOperationalSettings,readOperationalSettings} from '../../packages/db/src/operational-settings.js';
import {saveIntegrationSetting} from '../../packages/db/src/integration-settings.js';
import {defaultOperationalSettings,type DomainRecord} from '../../packages/contracts/src/index.js';
import {proposeEffect} from '../../apps/automation-worker/src/shared.js';
import {advanceWorkflow,acceptCustomerResponse,deliver,ensureOrder} from '../../apps/automation-worker/src/workflows.js';

const workspace='setup-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:FastifyInstance,cookie:string,operatorCookie:string;
const request=(method:any,url:string,payload?:any,auth=cookie,key=randomUUID())=>app.inject(explicitFixtureEnvironment({method,url,payload,headers:{origin,cookie:auth,'idempotency-key':key}}));
const data=(res:any,status=200)=>{expect(res.statusCode,res.body).toBe(status);return res.json().data;};
const base={workspaceId:workspace,environment:'REAL' as const};
async function fixture(){
 const product=await putRecord(pool,{...base,kind:'product',body:{name:'Synthetic preschool'}});
 const bank=await putRecord(pool,{...base,kind:'bank_profile',body:{name:'Fixture bank'}}),policy=await putRecord(pool,{...base,kind:'receipt_policy',body:{name:'Fixture review'}});
 const asset=await putRecord(pool,{...base,kind:'asset',body:{name:'Fixture material',kind:'link',url:'https://example.invalid/material',status:'READY'}});
 const offer=await putRecord(pool,{...base,kind:'offer',body:{product_id:product.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:9700,payment_profile_version_id:bank.id,receipt_policy_version_id:policy.id,fulfillment:[{asset_id:asset.id,release_on:'commitment_accepted'}]}});
 const workflow=await putRecord(pool,{...base,kind:'workflow',body:{name:'Fixture flow',product_id:product.id,status:'PUBLISHED',entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]}});
 const account=await putRecord(pool,{...base,kind:'channel_account',body:{name:'Fixture number',provider:'cloud',gateway_ref:'fixture',status:'WORKING',sending_enabled:false}});
 await pool.query("UPDATE channel_sessions SET desired_state='RUNNING',observed_state='CONNECTED',raw_state='WORKING',auth_state='VERIFIED',last_health_at=now(),provider_observed_at=now(),health_expires_at=now()+interval '1 hour',operational_pause=false,revision=revision+1 WHERE account_id=$1",[account.id]);
 await pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,lease_expires_at,frozen) VALUES($1,$2,'fixture-owner',1,now()+interval '1 hour',false)",[account.id,workspace]);
 const healthObservedAt=new Date().toISOString(),healthExpiresAt=new Date(Date.now()+3600000).toISOString();
 await putRecord(pool,{...base,kind:'health_signal',body:{account_id:account.id,dimension:'transport',scope:'account',status:'OK',source:'provider_read',observed_at:healthObservedAt,expires_at:healthExpiresAt}});
 await putRecord(pool,{...base,kind:'health_signal',body:{account_id:account.id,dimension:'quality',scope:'account',status:'OK',value:'GREEN',availability:'supported',source:'provider_read',observed_at:healthObservedAt,expires_at:healthExpiresAt}});
 const contact=await putRecord(pool,{...base,kind:'contact',body:{name:'Synthetic recipient',identity:'opaque:'+randomUUID()}});
 const conversation=await putRecord(pool,{...base,kind:'conversation',body:{account_id:account.id,contact_id:contact.id,offer_version_id:offer.id,workflow_version_id:workflow.id,last_inbound_at:new Date().toISOString()}});
 return{product,offer,workflow,account,contact,conversation};
}
const setup=(account:DomainRecord)=>dataPromise(request('GET',`/v1/channel-accounts/${account.id}/setup?environment=REAL`));
async function dataPromise(p:Promise<any>){return data(await p);}
async function assign(f:Awaited<ReturnType<typeof fixture>>){const result=data(await request('PATCH',`/v1/channel-accounts/${f.account.id}/setup`,{environment:'REAL',expected_version:1,product_id:f.product.id,offer_version_id:f.offer.id,workflow_version_id:f.workflow.id,reason:'Configure synthetic product'}));const a=result.assignment;f.conversation=await putRecord(pool,{...base,id:f.conversation.id,kind:'conversation',version:f.conversation.version,body:{...f.conversation.body,product_id:f.product.id,assignment_id:a.id,assignment_revision:a.revision,binding_id:a.binding_id}});return result.account;}
async function authorize(f:Awaited<ReturnType<typeof fixture>>,payload:any){const s=await setup(f.account),a=s.assignments[0];return request('POST',`/v1/assignments/${a.id}/authorize`,{recipient_mode:'selected_contacts',...payload,expected_version:a.revision});}
async function activateAndAuthorize(f:Awaited<ReturnType<typeof fixture>>){const current=await setup(f.account);data(await request('POST',`/v1/channel-accounts/${f.account.id}/activate`,{environment:'REAL',expected_version:current.account_version,configuration_version:current.configuration_version,reason:'Activate bounded fixture',confirmation:'ENABLE_REAL_ACCOUNT'}),202);const active=await setup(f.account);return data(await authorize(f,{environment:'REAL',configuration_version:active.configuration_version,contact_ids:[f.contact.id],max_messages:5,expires_at:new Date(Date.now()+3600000).toISOString(),allow_automation:true,reason:'Only synthetic fixture recipient',confirmation:'AUTHORIZE_REAL_SCOPE'}),201);}

beforeAll(async()=>{app=await createApp();for(const role of ['owner','operator'] as const){const email=`${role}-${randomUUID()}@example.invalid`,password=randomBytes(24).toString('base64url');await provisionUser({name:'Synthetic '+role,email,password,workspace_id:workspace,role});const login=await app.inject(explicitFixtureEnvironment({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.28',payload:{email,password},headers:{origin}}));expect(login.statusCode).toBe(200);const value=[login.headers['set-cookie']].flat().filter(Boolean).map(x=>String(x).split(';')[0]).join('; ');if(role==='owner')cookie=value;else operatorCookie=value;}
 await withTransaction(async c=>{await saveIntegrationSetting(c,workspace,'REAL','cloud:fixture',{expected_version:0,label:'Fixture official connection',enabled:true,config:{phone_number_id:'123456789',graph_version:'v26.0'},secrets:{token:'synthetic-token-opaque',app_secret:'synthetic-app-opaque',verify_token:'synthetic-verify-opaque'},clear_secrets:[],reason:'Isolated fixture'},'test');await writeOperationalSettings(c,workspace,'REAL',0,{...defaultOperationalSettings,dispatch_frozen:false,real_sends_enabled:true,allow_real_operations:true},'test');});});
afterAll(async()=>{await app.close();await pool.end();});
describe('Guided number configuration and bounded real scope, with no provider calls',()=>{
 it('validates compatibility, owner permissions, environment and compare-and-set',async()=>{const f=await fixture(),other=await fixture();const payload={environment:'REAL',expected_version:1,product_id:f.product.id,offer_version_id:other.offer.id,workflow_version_id:f.workflow.id,reason:'Incompatible fixture'};
 expect((await request('PATCH',`/v1/channel-accounts/${f.account.id}/setup`,payload)).statusCode).toBe(400);
 expect((await request('PATCH',`/v1/channel-accounts/${f.account.id}/setup`,{...payload,offer_version_id:f.offer.id},operatorCookie)).statusCode).toBe(403);
 expect((await request('GET',`/v1/channel-accounts/${f.account.id}/setup?environment=SIMULATION`)).statusCode).toBe(404);
 await assign(f);expect((await setup(f.account)).ready).toBe(true);
 expect((await request('PATCH',`/v1/channel-accounts/${f.account.id}/setup`,{...payload,offer_version_id:f.offer.id})).statusCode).toBe(409);
 });
 it('lets a newer explicit clear restriction supersede history and blocks a newly active restriction',async()=>{const f=await fixture(),now=Date.now(),health=(status:'OK'|'BLOCKED',offset:number)=>putRecord(pool,{...base,kind:'health_signal',body:{account_id:f.account.id,dimension:'restriction',scope:'account',status,source:'provider_read',...(status==='OK'?{value:{latest_read:{timelock:true,capping:true}}}:{}),observed_at:new Date(now+offset).toISOString(),expires_at:new Date(now+3600000).toISOString()}});await health('BLOCKED',-3000);await health('OK',-2000);await assign(f);let current=await setup(f.account);expect(current.checks.find((check:any)=>check.key==='health')?.ok).toBe(true);expect((await request('POST',`/v1/channel-accounts/${f.account.id}/activate`,{environment:'REAL',expected_version:current.account_version,configuration_version:current.configuration_version,reason:'Explicit clear fixture',confirmation:'ENABLE_REAL_ACCOUNT'})).statusCode).toBe(202);await health('BLOCKED',-1000);current=await setup(f.account);expect(current.checks.find((check:any)=>check.key==='health')?.ok).toBe(false);expect((await request('POST',`/v1/channel-accounts/${f.account.id}/activate`,{environment:'REAL',expected_version:current.account_version,configuration_version:current.configuration_version,reason:'Active restriction fixture',confirmation:'ENABLE_REAL_ACCOUNT'})).statusCode).toBe(409);});
 it('requires current validation and an observed recipient; enabling never sends or authorizes',async()=>{const f=await fixture();await assign(f);const s=await setup(f.account);
 expect((await request('POST',`/v1/channel-accounts/${f.account.id}/activate`,{environment:'REAL',expected_version:s.account_version,configuration_version:s.configuration_version+1,reason:'Stale fixture',confirmation:'ENABLE_REAL_ACCOUNT'})).statusCode).toBe(409);
 const scope=await activateAndAuthorize(f);expect(scope.authorization.scope.contact_ids).toEqual([f.contact.id]);expect(scope.authorization.scope.mode).toBe('product_assignment');
 expect((await pool.query('SELECT 1 FROM outbox WHERE account_id=$1',[f.account.id])).rowCount).toBe(0);
 const stranger=await putRecord(pool,{...base,kind:'contact',body:{name:'Unobserved fixture',identity:'opaque:'+randomUUID()}}),fresh=await setup(f.account);
 expect((await authorize(f,{environment:'REAL',expected_version:fresh.account_version,configuration_version:fresh.configuration_version,contact_ids:[stranger.id],max_messages:1,expires_at:new Date(Date.now()+3600000).toISOString(),allow_automation:true,reason:'Unobserved recipient',confirmation:'AUTHORIZE_REAL_SCOPE'})).statusCode).toBe(400);
 });
 it('approves only new effects matching the contact and pinned assignment; reassignment revokes',async()=>{const f=await fixture();await assign(f);const before=await withTransaction(c=>proposeEffect(c,f.conversation,{kind:'text',text:'Before authorization'},randomUUID()));expect(before.approval_hash).toBeNull();const launched=await activateAndAuthorize(f);
 const approved=await withTransaction(c=>proposeEffect(c,f.conversation,{kind:'text',text:'Authorized fixture'},randomUUID()));expect(approved.authorization_id).toBe(launched.authorization.id);expect(approved.approval_hash).toBe(approved.config_hash);
 const historical=(await pool.query('SELECT approval_hash FROM outbox WHERE id=$1',[before.id])).rows[0];expect(historical.approval_hash).toBeNull();
 const other=await fixture();const otherConversation=await putRecord(pool,{...base,kind:'conversation',body:{...f.conversation.body,contact_id:other.contact.id}});const denied=await withTransaction(c=>proposeEffect(c,otherConversation,{kind:'text',text:'Wrong recipient fixture'},randomUUID()));expect(denied.approval_hash).toBeNull();
 const s=await setup(f.account);data(await request('PATCH',`/v1/channel-accounts/${f.account.id}/setup`,{environment:'REAL',expected_version:s.account_version,product_id:f.product.id,offer_version_id:f.offer.id,workflow_version_id:f.workflow.id,reason:'New assignment revision'}));
 expect((await pool.query('SELECT revoked_at FROM operation_authorizations WHERE id=$1',[launched.authorization.id])).rows[0].revoked_at).toBeTruthy();expect((await setup(f.account)).authorization).toBeNull();expect((await setup(f.account)).sending_enabled).toBe(true);
 expect((await getRecord(pool,workspace,'conversation',f.conversation.id))?.body.offer_version_id).toBe(f.offer.id);
 });
 it('authorizing A never authorizes B on the same number, and changing channel identity invalidates A',async()=>{
  const f=await fixture();await assign(f);const authorization=await activateAndAuthorize(f),second=await fixture();
  const binding=data(await request('POST','/v1/assignments',{environment:'REAL',account_id:f.account.id,product_id:second.product.id,offer_version_id:second.offer.id,workflow_version_id:second.workflow.id,expected_version:0,entry_rules:[{kind:'keyword',value:'second product'}],reason:'Add independently approved B configuration'}),201);
  const conversationB=await putRecord(pool,{...base,kind:'conversation',body:{...f.conversation.body,product_id:second.product.id,offer_version_id:second.offer.id,workflow_version_id:second.workflow.id,assignment_id:binding.id,assignment_revision:binding.revision,binding_id:binding.binding_id}});
  const a=await withTransaction(c=>proposeEffect(c,f.conversation,{kind:'text',text:'Scoped A'},randomUUID())),b=await withTransaction(c=>proposeEffect(c,conversationB,{kind:'text',text:'Unapproved B'},randomUUID()));expect(a.authorization_id).toBe(authorization.authorization.id);expect(b.authorization_id).toBeNull();expect(b.approval_hash).toBeNull();
  const account=(await getRecord(pool,workspace,'channel_account',f.account.id))!;await putRecord(pool,{...base,id:account.id,kind:'channel_account',version:account.version,body:{...account.body,identity_fingerprint:'replacement-identity'}});
  const invalid=await withTransaction(c=>proposeEffect(c,f.conversation,{kind:'text',text:'Invalid after identity change'},randomUUID()));expect(invalid.approval_hash).toBeNull();
 });
 it('a settings revision prevents inheritance of an old authorization',async()=>{const f=await fixture();await assign(f);await activateAndAuthorize(f);await withTransaction(async c=>{const s=await readOperationalSettings(c,workspace,'REAL');await writeOperationalSettings(c,workspace,'REAL',s.version,{...s.body,contact_messages_per_minute:3},'test');});const effect=await withTransaction(c=>proposeEffect(c,f.conversation,{kind:'text',text:'Stale policy fixture'},randomUUID()));expect(effect.approval_hash).toBeNull();});
 it('can authorize future inbound conversations while excluding the historical base',async()=>{
  const f=await fixture();await assign(f);const s=await setup(f.account);data(await request('POST',`/v1/channel-accounts/${f.account.id}/activate`,{environment:'REAL',expected_version:s.account_version,configuration_version:s.configuration_version,reason:'New inbound fixture only',confirmation:'ENABLE_REAL_ACCOUNT'}),202);
  const fresh=await setup(f.account),launched=data(await authorize(f,{environment:'REAL',expected_version:fresh.account_version,configuration_version:fresh.configuration_version,recipient_mode:'new_inbound',contact_ids:[],max_messages:5,expires_at:new Date(Date.now()+3600000).toISOString(),allow_automation:true,reason:'Only future incoming conversations',confirmation:'AUTHORIZE_REAL_SCOPE'}),201);
  const old=await withTransaction(c=>proposeEffect(c,f.conversation,{kind:'text',text:'Historical conversation'},randomUUID()));expect(old.approval_hash).toBeNull();
  const contact=await putRecord(pool,{...base,kind:'contact',body:{name:'Future inbound fixture',identity:'opaque:'+randomUUID()}}),at=new Date().toISOString();
  const conversation=await putRecord(pool,{...base,kind:'conversation',body:{...f.conversation.body,contact_id:contact.id,started_at:at,last_inbound_at:at}});
  const effect=await withTransaction(c=>proposeEffect(c,conversation,{kind:'text',text:'Future incoming conversation'},randomUUID()));expect(effect.authorization_id).toBe(launched.authorization.id);expect(effect.approval_hash).toBe(effect.config_hash);
 });
 it('renews an annual owner grant without losing conversations that entered under the prior grant',async()=>{
  const f=await fixture();await assign(f);const s=await setup(f.account);data(await request('POST',`/v1/channel-accounts/${f.account.id}/activate`,{environment:'REAL',expected_version:s.account_version,configuration_version:s.configuration_version,reason:'Annual renewal fixture',confirmation:'ENABLE_REAL_ACCOUNT'}),202);
  const active=await setup(f.account),authPayload={environment:'REAL',configuration_version:active.configuration_version,recipient_mode:'new_inbound',contact_ids:[],max_messages:5,allow_automation:true,reason:'Annual inbound fixture',confirmation:'AUTHORIZE_REAL_SCOPE'};
  expect((await request('POST',`/v1/assignments/${active.assignments[0].id}/authorize`,{...authPayload,expected_version:active.assignments[0].revision,expires_at:new Date(Date.now()+120*86400000).toISOString()},operatorCookie)).statusCode).toBe(400);
  const first=data(await authorize(f,{...authPayload,expires_at:new Date(Date.now()+3600000).toISOString()}),201);
  const contact=await putRecord(pool,{...base,kind:'contact',body:{name:'Renewal fixture',identity:'opaque:'+randomUUID()}});
  const started=new Date().toISOString();const conversation=await putRecord(pool,{...base,kind:'conversation',body:{...f.conversation.body,contact_id:contact.id,started_at:started,last_inbound_at:started}});
  const renewed=data(await authorize(f,{...authPayload,max_messages:250,expires_at:new Date(Date.now()+120*86400000).toISOString()}),201);
  expect(new Date(renewed.authorization.expires_at).getTime()).toBeGreaterThan(Date.now()+100*86400000);
  expect(renewed.authorization.scope.new_inbound_since).toBe(new Date(first.authorization.created_at).toISOString());
  expect((await pool.query('SELECT revoked_at FROM operation_authorizations WHERE id=$1',[first.authorization.id])).rows[0].revoked_at).toBeTruthy();
  const effect=await withTransaction(c=>proposeEffect(c,conversation,{kind:'text',text:'Continued after renewal'},randomUUID()));
  expect(effect.authorization_id).toBe(renewed.authorization.id);expect(effect.approval_hash).toBe(effect.config_hash);
  expect((await authorize(f,{...authPayload,expires_at:new Date(Date.now()+367*86400000).toISOString()})).statusCode).toBe(400);
 });
 it('releases the Kit using reconciled money, never a conflicting receipt estimate',async()=>{
  for(const amount of [9700,10700]){const f=await fixture(),kit=await putRecord(pool,{...base,kind:'asset',body:{name:'Kit fixture',kind:'link',url:'https://example.invalid/kit',status:'READY'}});
   const offer=await putRecord(pool,{...base,kind:'offer',body:{...f.offer.body,fulfillment:[{asset_id:kit.id,release_on:'reconciled',min_amount_minor:10700}]}});
   const conversation=await putRecord(pool,{...base,id:f.conversation.id,kind:'conversation',version:f.conversation.version,body:{...f.conversation.body,offer_version_id:offer.id}});
   await withTransaction(async c=>{const order=(await ensureOrder(c,conversation))!;await putRecord(c,{...base,id:order.id,kind:'order',version:order.version,body:{...order.body,observed_amount_minor:amount===9700?10700:9700,reconciled_amount_minor:amount,reconciliation_status:'RECONCILED'}});await deliver(c,conversation,'reconciled','synthetic-financial-proof');});
   const delivered=(await pool.query("SELECT 1 FROM records WHERE workspace_id=$1 AND kind='fulfillment' AND body->>'conversation_id'=$2",[workspace,conversation.id])).rowCount;expect(delivered).toBe(amount===10700?1:0);
  }
 });
 it('waits indefinitely for a customer reply before the next pitch, without follow-up timers',async()=>{const f=await fixture();const workflow=await putRecord(pool,{...base,kind:'workflow',body:{name:'Reply-gated fixture',status:'PUBLISHED',entry_node_id:'hello',nodes:[{id:'hello',type:'message',config:{text:'Which grade?'},next:'reply'},{id:'reply',type:'reply',config:{variable:'grade'},next:'pitch'},{id:'pitch',type:'message',config:{text:'Fixture pitch'},next:'end'},{id:'end',type:'end',config:{}}]}});const conversation=await putRecord(pool,{id:f.conversation.id,...base,kind:'conversation',version:1,body:{...f.conversation.body,workflow_version_id:workflow.id}});
 await withTransaction(c=>advanceWorkflow(c,conversation));let waiting=(await getRecord(pool,workspace,'conversation',conversation.id))!;expect(waiting.body.flow_state.waiting_for).toBe('customer_reply');await withTransaction(c=>advanceWorkflow(c,waiting,'timer'));expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE conversation_id=$1',[conversation.id])).rows[0].n).toBe(1);expect((await pool.query('SELECT 1 FROM timers WHERE conversation_id=$1',[conversation.id])).rowCount).toBe(0);
 waiting=await putRecord(pool,{id:waiting.id,...base,kind:'conversation',version:waiting.version,body:{...waiting.body,last_customer_text:'Second grade'}});await withTransaction(c=>acceptCustomerResponse(c,waiting,'synthetic-inbound'));const finished=(await getRecord(pool,workspace,'conversation',waiting.id))!;expect(finished.body.flow_state.variables.grado).toBe('Second grade');expect(finished.body.flow_state.status).toBe('FINISHED');expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE conversation_id=$1',[conversation.id])).rows[0].n).toBe(2);
 });
});
