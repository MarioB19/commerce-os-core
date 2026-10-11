import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID,randomBytes,createHmac} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {pool,putRecord,withTransaction} from '../../packages/db/src/index.js';
import {saveIntegrationSetting} from '../../packages/db/src/integration-settings.js';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {buildIngress} from '../../apps/ingress/src/server.js';
import {processInbound} from '../../apps/automation-worker/src/inbound.js';
import {channelReception} from '../../apps/api/src/channel-reception.js';
import type {DomainRecord} from '../../packages/contracts/src/index.js';
const workspace='reception-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!,secret='synthetic-webhook-'+randomUUID();
let app:FastifyInstance,ingress:FastifyInstance,cookie:string,account:DomainRecord,old:DomainRecord;
beforeAll(async()=>{
 app=await createApp();ingress=await buildIngress();
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Synthetic reception owner',email,password,workspace_id:workspace,role:'owner'});
 const r=await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin},payload:{email,password}});
 cookie=([r.headers['set-cookie']].flat().filter(Boolean) as string[]).map(v=>v.split(';')[0]).join('; ');
 const ref='RX_'+randomUUID().replaceAll('-','');
 await withTransaction(c=>saveIntegrationSetting(c,workspace,'REAL','waha:'+ref,{expected_version:0,label:'Synthetic gateway',enabled:true,config:{base_url:'http://waha-10:3000'},secrets:{api_key:'synthetic-api-key',webhook_secret:secret},clear_secrets:[],reason:'Synthetic reception test'},'fixture'));
 old=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Retired fixture',provider:'waha',gateway_ref:ref,status:'STOPPED',deleted_at:new Date().toISOString(),sending_enabled:false}});
 account=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'New fixture',provider:'waha',gateway_ref:ref,status:'WORKING',purpose:'',sending_enabled:false}});
});
afterAll(async()=>{await app.close();await ingress.close();await pool.end();});
const get=(path:string)=>app.inject({method:'GET',url:'/v1'+path+'?environment=REAL',headers:{cookie}});
it('materializes signed WAHA inbound into the exact new account while paused, without a product or sending permission',async()=>{
 const before=await channelReception(pool,account);expect(before.messages.received).toBe(0);
 const event={id:'evt-'+randomUUID(),event:'message',session:'default',payload:{id:'msg-'+randomUUID(),from:'12025550171@c.us',fromMe:false,body:'Synthetic reception check',timestamp:Math.floor(Date.now()/1000)}};
 const body=JSON.stringify(event),headers={'content-type':'application/json','x-webhook-hmac-algorithm':'sha512','x-webhook-hmac':createHmac('sha512',secret).update(body).digest('hex')};
 const post=(id:string,override={})=>ingress.inject({method:'POST',url:`/webhooks/waha/${workspace}/${id}`,payload:body,headers:{...headers,...override}});
 expect((await post(old.id)).statusCode).toBe(404);
 expect((await post(account.id,{'x-webhook-hmac':'invalid'})).statusCode).toBe(401);
 expect((await post(account.id)).json()).toEqual({ok:true,duplicate:false});
 expect((await post(account.id)).json()).toEqual({ok:true,duplicate:true});
 await processInbound(100);
 const list=await get('/conversations');expect(list.statusCode).toBe(200);
 const conversations=list.json().data;expect(conversations).toHaveLength(1);expect(conversations[0].account_id).toBe(account.id);
 const detail=await get('/conversations/'+conversations[0].id);expect(detail.json().data.messages).toHaveLength(1);
 expect(detail.json().data.messages[0]).toMatchObject({direction:'INBOUND',text:'Synthetic reception check',status:'RECEIVED'});
 const health=await get('/channel-accounts/'+account.id+'/health');expect(health.statusCode,health.body).toBe(200);
 expect(health.json().data.reception).toMatchObject({state:'RECEIVED',messages:{received:1},envelopes:{received:1,processed:1,pending:0,failed:0},sending_enabled:false});
 expect(JSON.stringify(health.json().data.reception)).not.toContain(secret);expect(JSON.stringify(health.json().data.reception)).not.toContain(event.payload.body);
 expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
 expect((await pool.query('SELECT operational_pause,recovery_enabled FROM channel_sessions WHERE account_id=$1',[account.id])).rows[0]).toEqual({operational_pause:true,recovery_enabled:false});
});
it('does not treat an expired or mismatched webhook as current healthy reception',async()=>{
 const signal=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'health_signal',body:{account_id:account.id,dimension:'infrastructure',status:'BLOCKED',value:{kind:'webhook',matches:false},observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+60000).toISOString()}});
 expect((await channelReception(pool,account)).state).toBe('CONFIGURATION_BLOCKED');
 await putRecord(pool,{id:signal.id,workspaceId:workspace,environment:'REAL',kind:'health_signal',version:signal.version,body:{...signal.body,expires_at:new Date(Date.now()-1000).toISOString()}});
 expect((await channelReception(pool,account)).webhook.state).toBe('UNKNOWN');
});
it('rejects a stale lifecycle version before creating a command',async()=>{
 const r=await app.inject({method:'POST',url:`/v1/channel-accounts/${account.id}/commands?environment=REAL`,headers:{cookie,origin,'idempotency-key':randomUUID()},payload:{type:'restart',expected_version:account.version+100,reason:'Synthetic stale request'}});
 expect(r.statusCode).toBe(409);expect(r.json().error.code).toBe('VERSION_CONFLICT');
 expect((await pool.query('SELECT count(*)::int n FROM commands WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
});

it('selects the manual reply authorization by product and rejects another contact, stale version or revoked permission',async()=>{
 const {channelIdentityHash}=await import('../../packages/db/src/commercial-assignments.js');
 const base={workspaceId:workspace,environment:'REAL' as const};
 const product=await putRecord(pool,{...base,kind:'product',body:{name:'Manual reply fixture',status:'PUBLISHED'}});
 const workflow=await putRecord(pool,{...base,kind:'workflow',body:{product_id:product.id,name:'Manual fixture flow',status:'PUBLISHED',entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]}});
 const offer=await putRecord(pool,{...base,kind:'offer',body:{name:'Manual fixture offer',product_id:product.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:9700,workflow_version_id:workflow.id,fulfillment:[]}});
 const target=await putRecord(pool,{...base,kind:'channel_account',body:{name:'Manual fixture channel',provider:'waha',status:'WORKING',sending_enabled:false}});
 const assigned=await app.inject({method:'POST',url:'/v1/assignments?environment=REAL',headers:{cookie,origin,'idempotency-key':randomUUID()},payload:{account_id:target.id,product_id:product.id,offer_version_id:offer.id,workflow_version_id:workflow.id,expected_version:0,entry_rules:[],reason:'Synthetic product assignment'}});expect(assigned.statusCode,assigned.body).toBe(201);const assignment=assigned.json().data;
 const contact=await putRecord(pool,{...base,kind:'contact',body:{name:'Synthetic authorized contact',identity:'opaque:manual-fixture'}});
 const conv=await putRecord(pool,{...base,kind:'conversation',body:{account_id:target.id,contact_id:contact.id,product_id:product.id,assignment_id:assignment.id,assignment_revision:assignment.revision,binding_id:assignment.binding_id,offer_version_id:offer.id,workflow_version_id:workflow.id,routing_state:'RESOLVED',status:'OPEN'}});
 const scope={mode:'product_assignment',assignment_id:assignment.id,assignment_revision:assignment.revision,binding_id:assignment.binding_id,product_id:product.id,channel_identity_hash:channelIdentityHash(target),recipient_mode:'selected_contacts',contact_ids:[contact.id],max_messages:1,allow_automation:false};
 const authorization=(await pool.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at) VALUES($1,'REAL','synthetic-owner',$2,'synthetic',now()+interval '1 hour') RETURNING id",[workspace,scope])).rows[0];
 await pool.query('UPDATE commercial_assignments SET authorization_id=$2 WHERE id=$1',[assignment.id,authorization.id]);
 const send=(conversation=conv,version=conversation.version)=>app.inject({method:'POST',url:`/v1/conversations/${conversation.id}/commands?environment=REAL`,headers:{cookie,origin,'idempotency-key':randomUUID()},payload:{type:'send_message',expected_version:version,text:'Synthetic manual reply'}});
 const accepted=await send();expect(accepted.statusCode,accepted.body).toBe(202);expect(accepted.json().data.payload.authorization_id).toBe(authorization.id);
 await pool.query("UPDATE commands SET status='FAILED',result='{\"error\":\"SYNTHETIC_API_ONLY_TEST\"}' WHERE id=$1",[accepted.json().data.id]);
 expect((await send(conv,conv.version+100)).statusCode).toBe(409);
 const otherContact=await putRecord(pool,{...base,kind:'contact',body:{name:'Synthetic unauthorized contact',identity:'opaque:other-manual-fixture'}});
 const other=await putRecord(pool,{...base,kind:'conversation',body:{...conv.body,contact_id:otherContact.id}});expect((await send(other)).statusCode).toBe(409);
 const otherProduct=await putRecord(pool,{...base,kind:'product',body:{name:'Synthetic other product'}});
 const otherJourney=await putRecord(pool,{...base,kind:'conversation',body:{...conv.body,product_id:otherProduct.id}});expect((await send(otherJourney)).statusCode).toBe(409);
 await pool.query('UPDATE operation_authorizations SET revoked_at=now() WHERE id=$1',[authorization.id]);expect((await send()).statusCode).toBe(409);
 expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE account_id=$1',[target.id])).rows[0].n).toBe(0);

});

it('captures provider history through an owner command and imports it once without replaying sales actions',async()=>{
 const {createHash}=await import('node:crypto');const fingerprint=createHash('sha256').update('synthetic-history-identity').digest('hex');
 const {WahaProvider}=await import('../../packages/messaging/src/providers.js');
 const {SimulatorProvider}=await import('../../packages/messaging/src/index.js');
 const {processChannelCommands}=await import('../../apps/channel-worker/src/lifecycle.js');
 const {advanceWorkflow}=await import('../../apps/automation-worker/src/workflows.js');
 // The worker scans every workspace. An unrelated pending simulator command
 // must never use this account's instrumented history transport.
 const foreignWorkspace='foreign-history-'+randomUUID();
 const foreign=await putRecord(pool,{workspaceId:foreignWorkspace,environment:'SIMULATION',kind:'channel_account',body:{provider:'simulator',status:'NEW',sending_enabled:false}});
 const foreignCommand=(await pool.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key) VALUES($1,'SIMULATION','channel_command',$2,'synthetic',$3,gen_random_uuid()::text) RETURNING id",[foreignWorkspace,foreign.id,{type:'restart'}])).rows[0];
 const product=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'product',body:{name:'Synthetic history product'}});
 const workflow=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'workflow',body:{status:'PUBLISHED',entry_node_id:'message',nodes:[{id:'message',type:'message',config:{text:'Must not replay'},next:'end'},{id:'end',type:'end',config:{}}]}});
 const offer=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'offer',body:{status:'PUBLISHED',product_id:product.id,workflow_version_id:workflow.id}});
 const target=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'History fixture',offer_version_id:offer.id,workflow_version_id:workflow.id,provider:'waha',gateway_ref:'HIST_'+randomUUID().replaceAll('-',''),status:'WORKING',identity_verified:true,identity_fingerprint:fingerprint,sending_enabled:false}});
 await pool.query("UPDATE records SET version=version+1,created_at=now()-interval '10 minutes' WHERE id=$1",[target.id]);target.version++;
 const since=new Date(Date.now()-300000).toISOString(),until=new Date().toISOString(),message={id:'historical-'+randomUUID(),from:'12025550172@c.us',fromMe:false,timestamp:Math.floor(Date.now()/1000)-10,body:'Previously received synthetic message'};
 const actions:string[]=[];const provider=new WahaProvider({baseUrl:'http://fixture.invalid',apiKey:'synthetic',session:'default',engine:'GOWS'},async(u,i)=>{actions.push(i?.method??'GET');return Response.json(new URL(String(u)).pathname.endsWith('/messages')?[message]:{status:'WORKING',me:{id:'synthetic-history-identity'}});});
 const key=randomUUID(),body={expected_version:target.version,since,until,limit:10,reason:'Recover synthetic missing inbox message',confirmation:'IMPORT_RECENT_INBOUND'};
 const request=()=>app.inject({method:'POST',url:`/v1/channel-accounts/${target.id}/sync-inbox?environment=REAL`,headers:{cookie,origin,'idempotency-key':key},payload:body});
 for(const [override,expectedStatus] of [[{expected_version:target.version+100},409],[{since:new Date(Date.now()-90000000).toISOString()},400]] as const){const invalid=await app.inject({method:'POST',url:`/v1/channel-accounts/${target.id}/sync-inbox?environment=REAL`,headers:{cookie,origin,'idempotency-key':randomUUID()},payload:{...body,...override}});expect(invalid.statusCode).toBe(expectedStatus);}
 const unauthenticated=await app.inject({method:'POST',url:`/v1/channel-accounts/${target.id}/sync-inbox?environment=REAL`,headers:{origin,'idempotency-key':randomUUID()},payload:body});expect(unauthenticated.statusCode).toBe(401);
 const r=await request();expect(r.statusCode,r.body).toBe(202);expect((await request()).json().data.id).toBe(r.json().data.id);
 await processChannelCommands(100,candidate=>candidate.id===target.id?provider:new SimulatorProvider(),'synthetic-history-worker');
 expect((await pool.query('SELECT status FROM commands WHERE id=$1',[foreignCommand.id])).rows[0].status).toBe('APPLIED');
 await pool.query("UPDATE records SET version=version+1,body=body||jsonb_build_object('deleted_at',now()::text) WHERE id=$1 AND workspace_id=$2 AND environment='SIMULATION'",[foreign.id,foreignWorkspace]);
 expect((await pool.query('SELECT status,result FROM commands WHERE id=$1',[r.json().data.id])).rows[0]).toMatchObject({status:'APPLIED',result:{status:'CAPTURED',count:1,external_mutations:0}});
 expect(actions.every(a=>a==='GET')).toBe(true);
 await processInbound(100);await processInbound(100);
 const historical=(await pool.query("SELECT * FROM records WHERE workspace_id=$1 AND kind='conversation' AND body->>'account_id'=$2",[workspace,target.id])).rows[0];
 await withTransaction(c=>advanceWorkflow(c,historical));
 let rows=(await pool.query("SELECT body FROM records WHERE workspace_id=$1 AND kind='message' AND body->>'account_id'=$2",[workspace,target.id])).rows;
 expect(rows).toHaveLength(1);expect(rows[0].body).toMatchObject({source:'provider_history',text:message.body,direction:'INBOUND'});
 const conversations=(await pool.query("SELECT body FROM records WHERE workspace_id=$1 AND kind='conversation' AND body->>'account_id'=$2",[workspace,target.id])).rows;
 expect(conversations).toHaveLength(1);expect(conversations[0].body.historical_only).toBe(true);expect(conversations[0].body.ai_pending).not.toBe(true);expect(conversations[0].body.offer_version_id).toBe(offer.id);expect(conversations[0].body.flow_state).toBeUndefined();
 expect((await channelReception(pool,target)).state).toBe('RECOVERED');
 const capture=(await pool.query("SELECT payload FROM domain_events WHERE workspace_id=$1 AND event_type='channel.history.observed'",[workspace])).rows;
 expect(JSON.stringify(capture)).not.toContain(message.body);expect(JSON.stringify(capture)).not.toContain(message.from);
 // A later real callback for the same provider message does not duplicate the historical record.
 const {encrypt}=await import('../../packages/db/src/index.js');await pool.query("INSERT INTO inbound_envelopes(workspace_id,environment,account_id,provider,provider_event_id,payload_ciphertext) VALUES($1,'REAL',$2,'waha',$3,$4)",[workspace,target.id,'live-'+message.id,encrypt({event:'message',session:'default',payload:message})]);
 await processInbound(100);rows=(await pool.query("SELECT body FROM records WHERE workspace_id=$1 AND kind='message' AND body->>'account_id'=$2",[workspace,target.id])).rows;expect(rows).toHaveLength(1);
 expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
 const live={...message,id:'new-live-'+randomUUID(),timestamp:Math.floor(Date.now()/1000),body:'A new live customer message'};
 await pool.query("INSERT INTO inbound_envelopes(workspace_id,environment,account_id,provider,provider_event_id,payload_ciphertext) VALUES($1,'REAL',$2,'waha',$3,$4)",[workspace,target.id,live.id,encrypt({event:'message',session:'default',payload:live})]);
 await processInbound(100);
 const current=(await pool.query("SELECT body FROM records WHERE workspace_id=$1 AND kind='conversation' AND body->>'account_id'=$2",[workspace,target.id])).rows;
 expect(current).toHaveLength(1);expect(current[0].body.historical_only).toBe(false);expect(current[0].body.last_customer_text).toBe(live.body);
 expect((await channelReception(pool,target)).state).toBe('RECEIVED');
 // Keep this live fixture from becoming work for subsequent global-worker suites.
 await pool.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'channel_account',$2,true,'Synthetic fixture complete','fixture') ON CONFLICT(workspace_id,scope_type,scope_id) DO UPDATE SET paused=true",[workspace,target.id]);
});
