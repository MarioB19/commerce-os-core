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
import {proposeEffect,proposeEffectOutcome} from '../../apps/automation-worker/src/shared.js';
import {roleExecutor} from '../support/database-role.js';
import {advanceWorkflow,acceptCustomerResponse,deliver,ensureOrder} from '../../apps/automation-worker/src/workflows.js';

// V7 F2: automation steps run as the production worker role; REAL continuity
// (013) accepts only commerce_automation/commerce_channel as the acting role.
const withRole=roleExecutor(pool);
const asAutomation=<T>(work:(c:any)=>Promise<T>)=>withRole('commerce_automation',()=>withTransaction(work));
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
async function realOutcome(conversation:DomainRecord,text:string){return asAutomation(c=>proposeEffectOutcome(c,conversation,{kind:'text',text},randomUUID()));}
async function pin(f:Awaited<ReturnType<typeof fixture>>){const a=(await setup(f.account)).assignments[0];const current=(await getRecord(pool,workspace,'conversation',f.conversation.id))!;
 return putRecord(pool,{...base,id:current.id,kind:'conversation',version:current.version,body:{...current.body,product_id:f.product.id,assignment_id:a.id,assignment_revision:a.revision,binding_id:a.binding_id}});}
async function continuity(f:Awaited<ReturnType<typeof fixture>>){const a=(await setup(f.account)).assignments[0];
 const r=await app.inject({method:'POST',url:'/v2/continuity/commercial',headers:{origin,cookie,'idempotency-key':randomUUID()},payload:{environment:'REAL',operationId:randomUUID(),assignmentId:a.id,expectedRevision:a.revision}});expect(r.statusCode,r.body).toBeLessThan(300);return r.json().data;}
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
 // V7 F2: REAL effects are authorized by commercial continuity issued per
 // assignment (POST /v2/continuity/commercial, reviewed transitions 010/012).
 // The owner temporal-grant API keeps its own contract below, but a temporal
 // grant alone no longer authorizes a REAL proposal; these cases replace the
 // historical inheritance assertions with their V7 equivalents.
 it('approves only effects of a pinned assignment with commercial continuity; reassignment revokes',async()=>{
  const f=await fixture();await assign(f);const launched=await activateAndAuthorize(f);
  expect(await realOutcome(f.conversation,'Unpinned conversation')).toMatchObject({state:'BLOCKED',reason:'CONTINUITY_ASSIGNMENT_UNAVAILABLE'});
  const pinned=await pin(f);
  expect(await realOutcome(pinned,'Temporal grant only')).toMatchObject({state:'BLOCKED',reason:'CONTINUITY_AUTHORITY_UNAVAILABLE'});
  await continuity(f);
  const approved=await realOutcome(pinned,'Continuity authorized fixture') as {state:string;effect:any};expect(approved.state).toBe('CREATED');
  expect(approved.effect.authorization_id).toBeNull();expect(approved.effect.continuous_authorization_id).toBeTruthy();expect(approved.effect.approval_hash).toBe(approved.effect.config_hash);
  const s=await setup(f.account);data(await request('PATCH',`/v1/channel-accounts/${f.account.id}/setup`,{environment:'REAL',expected_version:s.account_version,product_id:f.product.id,offer_version_id:f.offer.id,workflow_version_id:f.workflow.id,reason:'New assignment revision'}));
  expect((await pool.query('SELECT revoked_at FROM operation_authorizations WHERE id=$1',[launched.authorization.id])).rows[0].revoked_at).toBeTruthy();expect((await setup(f.account)).authorization).toBeNull();
  expect((await realOutcome(pinned,'Old assignment revision')).state).toBe('BLOCKED');
  expect((await getRecord(pool,workspace,'conversation',f.conversation.id))?.body.offer_version_id).toBe(f.offer.id);
 });
 it('commercial continuity of assignment A never authorizes B on the same number',async()=>{
  const f=await fixture();await assign(f);await activateAndAuthorize(f);const second=await fixture();
  const binding=data(await request('POST','/v1/assignments',{environment:'REAL',account_id:f.account.id,product_id:second.product.id,offer_version_id:second.offer.id,workflow_version_id:second.workflow.id,expected_version:0,entry_rules:[{kind:'keyword',value:'second product'}],reason:'Add independently approved B configuration'}),201);
  const pinned=await pin(f);await continuity(f);
  const conversationB=await putRecord(pool,{...base,kind:'conversation',body:{...pinned.body,product_id:second.product.id,offer_version_id:second.offer.id,workflow_version_id:second.workflow.id,assignment_id:binding.id,assignment_revision:binding.revision,binding_id:binding.binding_id}});
  expect((await realOutcome(pinned,'Scoped A')).state).toBe('CREATED');
  expect(await realOutcome(conversationB,'Unapproved B')).toMatchObject({state:'BLOCKED',reason:'CONTINUITY_AUTHORITY_UNAVAILABLE'});
 });
 it('a settings revision leaves the old temporal grant stale and REAL proposals behind continuity',async()=>{
  const f=await fixture();await assign(f);const launched=await activateAndAuthorize(f);
  await withTransaction(async c=>{const s=await readOperationalSettings(c,workspace,'REAL');await writeOperationalSettings(c,workspace,'REAL',s.version,{...s.body,contact_messages_per_minute:3},'test');});
  const current=await withTransaction(c=>readOperationalSettings(c,workspace,'REAL'));expect(launched.authorization.configuration_version).not.toBe(current.version);
  expect(await realOutcome(await pin(f),'Stale policy fixture')).toMatchObject({state:'BLOCKED',reason:'CONTINUITY_AUTHORITY_UNAVAILABLE'});
 });
 it('records a future-inbound temporal grant while REAL proposals stay behind continuity',async()=>{
  const f=await fixture();await assign(f);const s=await setup(f.account);data(await request('POST',`/v1/channel-accounts/${f.account.id}/activate`,{environment:'REAL',expected_version:s.account_version,configuration_version:s.configuration_version,reason:'New inbound fixture only',confirmation:'ENABLE_REAL_ACCOUNT'}),202);
  const fresh=await setup(f.account),launched=data(await authorize(f,{environment:'REAL',expected_version:fresh.account_version,configuration_version:fresh.configuration_version,recipient_mode:'new_inbound',contact_ids:[],max_messages:5,expires_at:new Date(Date.now()+3600000).toISOString(),allow_automation:true,reason:'Only future incoming conversations',confirmation:'AUTHORIZE_REAL_SCOPE'}),201);
  expect(launched.authorization.scope.recipient_mode).toBe('new_inbound');
  expect((await realOutcome(f.conversation,'Historical conversation')).state).toBe('BLOCKED');
  const contact=await putRecord(pool,{...base,kind:'contact',body:{name:'Future inbound fixture',identity:'opaque:'+randomUUID()}}),at=new Date().toISOString();
  const conversation=await putRecord(pool,{...base,kind:'conversation',body:{...f.conversation.body,contact_id:contact.id,started_at:at,last_inbound_at:at}});
  expect((await realOutcome(conversation,'Future incoming conversation')).state).toBe('BLOCKED');
 });
 it('renews an annual owner grant and revokes the prior grant',async()=>{
  const f=await fixture();await assign(f);const s=await setup(f.account);data(await request('POST',`/v1/channel-accounts/${f.account.id}/activate`,{environment:'REAL',expected_version:s.account_version,configuration_version:s.configuration_version,reason:'Annual renewal fixture',confirmation:'ENABLE_REAL_ACCOUNT'}),202);
  const active=await setup(f.account),authPayload={environment:'REAL',configuration_version:active.configuration_version,recipient_mode:'new_inbound',contact_ids:[],max_messages:5,allow_automation:true,reason:'Annual inbound fixture',confirmation:'AUTHORIZE_REAL_SCOPE'};
  expect((await request('POST',`/v1/assignments/${active.assignments[0].id}/authorize`,{...authPayload,expected_version:active.assignments[0].revision,expires_at:new Date(Date.now()+120*86400000).toISOString()},operatorCookie)).statusCode).toBe(400);
  const first=data(await authorize(f,{...authPayload,expires_at:new Date(Date.now()+3600000).toISOString()}),201);
  const renewed=data(await authorize(f,{...authPayload,max_messages:250,expires_at:new Date(Date.now()+120*86400000).toISOString()}),201);
  expect(new Date(renewed.authorization.expires_at).getTime()).toBeGreaterThan(Date.now()+100*86400000);
  expect(renewed.authorization.scope.new_inbound_since).toBe(new Date(first.authorization.created_at).toISOString());
  expect((await pool.query('SELECT revoked_at FROM operation_authorizations WHERE id=$1',[first.authorization.id])).rows[0].revoked_at).toBeTruthy();
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
 await asAutomation(c=>advanceWorkflow(c,conversation));let waiting=(await getRecord(pool,workspace,'conversation',conversation.id))!;expect(waiting.body.flow_state.waiting_for).toBe('customer_reply');await asAutomation(c=>advanceWorkflow(c,waiting,'timer'));expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE conversation_id=$1',[conversation.id])).rows[0].n).toBe(1);expect((await pool.query('SELECT 1 FROM timers WHERE conversation_id=$1',[conversation.id])).rowCount).toBe(0);
 waiting=await putRecord(pool,{id:waiting.id,...base,kind:'conversation',version:waiting.version,body:{...waiting.body,last_customer_text:'Second grade'}});await asAutomation(c=>acceptCustomerResponse(c,waiting,'synthetic-inbound'));const finished=(await getRecord(pool,workspace,'conversation',waiting.id))!;expect(finished.body.flow_state.variables.grado).toBe('Second grade');expect(finished.body.flow_state.status).toBe('FINISHED');expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE conversation_id=$1',[conversation.id])).rows[0].n).toBe(2);
 });
});
