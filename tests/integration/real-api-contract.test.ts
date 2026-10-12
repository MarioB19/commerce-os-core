import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord,hash,encrypt} from '../../packages/db/src/index.js';
import {createDefaultRemarketingPolicy} from '../../packages/domain/src/sales/remarketing.js';
import {salesAgreementRecipeV1,salesAgreementWorkflowV1} from '../../packages/domain/src/sales/sales-recipe-v2.js';
import {CommerceClient} from '../../scripts/commerce-client.mjs';
const workspace='real-contract-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
// V7 F2: fixture workspaces are adopted profiles (max three per installation).
const anotherWorkspace='another-'+randomUUID();
beforeAll(()=>fixtureProfiles(workspace,anotherWorkspace));
let app:FastifyInstance,cookie:string,baseUrl:string;
const request=(method:any,url:string,payload?:any,token?:string,key=randomUUID())=>app.inject({method,url,payload,headers:{origin,...(token?{authorization:'Bearer '+token}:{cookie}),'idempotency-key':key}});
const data=(r:any,status=200)=>{expect(r.statusCode,r.body).toBe(status);return r.json().data;};
const token=async(scopes:string[],options:Record<string,any>={})=>data(await request('POST','/v1/service-tokens',{environment:'REAL',name:'Scoped fixture',scopes,expires_at:new Date(Date.now()+3600000).toISOString(),...options}),201);
beforeAll(async()=>{
 app=await createApp();const email='real-contract-'+randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Synthetic owner',email,password,workspace_id:workspace,role:'owner'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.221',headers:{origin},payload:{email,password}});expect(login.statusCode,login.body).toBe(200);
 cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');
 baseUrl=await app.listen({host:'127.0.0.1',port:0});
});
afterAll(async()=>{await app.close();await pool.end();});
describe('REAL API contract and scoped executable assistant client',()=>{
 it('defaults reads to REAL, requires explicit mutations, rejects contradictory context without effects',async()=>{
  const real=data(await request('POST','/v1/products',{environment:'REAL',name:'Normal actual metadata'}),201);
  data(await request('POST','/v1/products',{environment:'SIMULATION',name:'Isolated fixture'}),201);
  expect(data(await request('GET','/v1/me'))).toMatchObject({environment:'REAL',operation_mode:'REAL'});
  expect(data(await request('GET','/v1/products')).every((p:any)=>p.environment==='REAL')).toBe(true);
  expect(data(await request('GET','/v1/products/'+real.id)).id).toBe(real.id);
  expect((await request('POST','/v1/products',{name:'Ambiguous'})).json().error.code).toBe('ENVIRONMENT_REQUIRED');
  expect((await request('POST','/v1/conversations/'+randomUUID()+'/commands',{type:'send_message',text:'Must never be sent'})).json().error.code).toBe('ENVIRONMENT_REQUIRED');
  expect((await request('POST','/v1/products?environment=REAL',{environment:'SIMULATION',name:'Conflict'})).json().error.code).toBe('ENVIRONMENT_CONFLICT');
  expect((await request('GET','/v1/products?environment=unknown')).statusCode).toBe(400);
  expect((await pool.query('SELECT count(*)::int n FROM commands WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
 });
 it('enforces exact resources, private material capability, workspace, expiry, revocation and same-key concurrency',async()=>{
  const a=data(await request('POST','/v1/products',{environment:'REAL',name:'Allowed'}),201),b=data(await request('POST','/v1/products',{environment:'REAL',name:'Other'}),201);
  const grant=await token(['products:read','products:write'],{resource_ids:[a.id]});
  expect(data(await request('GET','/v1/products',undefined,grant.token)).map((r:any)=>r.id)).toEqual([a.id]);
  expect((await request('GET','/v1/products/'+b.id,undefined,grant.token)).statusCode).toBe(404);
  expect((await request('GET','/v1/products?environment=SIMULATION',undefined,grant.token)).statusCode).toBe(403);
  expect((await request('POST','/v1/products',{environment:'REAL',name:'Forbidden root'},grant.token)).statusCode).toBe(403);
  expect((await request('GET','/v1/assets/'+randomUUID()+'/content',undefined,grant.token)).statusCode).toBe(403);
  const other=await putRecord(pool,{workspaceId:anotherWorkspace,environment:'REAL',kind:'product',body:{name:'Foreign'}});
  expect((await request('GET','/v1/products/'+other.id,undefined,grant.token)).statusCode).toBe(404);
  const client=new CommerceClient({baseUrl,token:grant.token}),key=randomUUID();
  const patch={expected_version:1,name:'Concurrent'};const replies=await Promise.all([client.request('PATCH','/v1/products/'+a.id,{body:patch,key}),client.request('PATCH','/v1/products/'+a.id,{body:patch,key})]);expect(replies[0].data).toEqual(replies[1].data);
  await expect(client.request('PATCH','/v1/products/'+a.id,{body:{expected_version:1,name:'Obsolete'}})).rejects.toMatchObject({code:'VERSION_CONFLICT'});
  data(await request('DELETE','/v1/service-tokens/'+grant.id+'?environment=REAL'));
  await expect(client.request('GET','/v1/products')).rejects.toMatchObject({status:401});
  const expired=await token(['products:read']);await pool.query("UPDATE service_tokens SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.id]);
  expect((await request('GET','/v1/products',undefined,expired.token)).statusCode).toBe(401);
 });
 it('does not expand unauthorized conversation relations or version-family members',async()=>{
  const contact=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'contact',body:{name:'Restricted related customer'}}),offer=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'offer',body:{name:'Restricted offer metadata'}});
  const conversation=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'conversation',body:{stage:'NEW',contact_id:contact.id,offer_version_id:offer.id}});
  await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'message',body:{conversation_id:conversation.id,text:'Restricted message content'}});
  const grant=await token(['sales:read'],{resource_ids:[conversation.id]});
  const result=data(await request('GET','/v1/conversations/'+conversation.id,undefined,grant.token));
  expect(result.id).toBe(conversation.id);expect(result.messages).toBeUndefined();expect(result.contact).toBeUndefined();expect(result.offer).toBeUndefined();expect(result.outbox).toBeUndefined();
  const draft=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'workflow',body:{name:'Unlisted family draft',status:'DRAFT'}});
  const published=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'workflow',body:{name:'Allowed published version',status:'PUBLISHED',series_id:draft.id,parent_id:draft.id}});
  const familyGrant=await token(['workflows:read'],{resource_ids:[published.id]});
  const versions=data(await request('GET','/v1/workflows/'+published.id+'/versions',undefined,familyGrant.token));expect(versions.map((r:any)=>r.id)).toEqual([published.id]);
  const category=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'category',body:{name:'Restricted category'}}),agent=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'agent',body:{name:'Restricted seller',knowledge:'Private scoped seller knowledge'}});
  const product=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'product',body:{name:'Allowed source product',category_id:category.id,agent_version_id:agent.id}});
  const sourceOffer=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'offer',body:{name:'Allowed source offer',product_id:product.id}}),sourceFlow=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'workflow',body:{name:'Allowed source flow',offer_version_id:undefined}});
  const linkedFlow=await putRecord(pool,{id:sourceFlow.id,version:sourceFlow.version,workspaceId:workspace,environment:'REAL',kind:'workflow',body:{...sourceFlow.body,offer_version_id:sourceOffer.id}});
  const sourceIds=[linkedFlow.id,sourceOffer.id,product.id];
  const missingAgent=await token(['workflows:read'],{resource_ids:sourceIds});expect((await request('GET','/v1/workflows/'+linkedFlow.id+'/seller',undefined,missingAgent.token)).statusCode).toBe(404);
  const missingCategory=await token(['workflows:read'],{resource_ids:[...sourceIds,agent.id]});expect((await request('GET','/v1/workflows/'+linkedFlow.id+'/seller',undefined,missingCategory.token)).statusCode).toBe(404);
  const complete=await token(['workflows:read'],{resource_ids:[...sourceIds,agent.id,category.id]});expect(data(await request('GET','/v1/workflows/'+linkedFlow.id+'/seller',undefined,complete.token)).snapshot.agent_version_id).toBe(agent.id);

 });
 it('runs CLI over authenticated HTTP and leaves proposed messages inert',async()=>{
  const conversation=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'conversation',body:{stage:'NEW'}});
  const grant=await token(['sales:read','sales:propose','commands:read'],{resource_ids:[conversation.id]});
  const child=await promisify(execFile)(process.execPath,['scripts/commerce-client.mjs','request','GET','/v1/conversations/'+conversation.id],{env:{...process.env,COMMERCE_API_URL:baseUrl,COMMERCE_SERVICE_TOKEN:grant.token}});
  expect(JSON.parse(child.stdout).data.id).toBe(conversation.id);expect(child.stdout).not.toContain(grant.token);
  const client=new CommerceClient({baseUrl,token:grant.token}),key=randomUUID();const input={expected_version:conversation.version,kind:'text',text:'Approved copy candidate',reason:'Operator review'};
  const first=await client.request('POST',`/v1/conversations/${conversation.id}/proposals`,{key,body:input});const second=await client.request('POST',`/v1/conversations/${conversation.id}/proposals`,{key,body:input});expect(first.data.id).toBe(second.data.id);expect(first.data).toMatchObject({status:'DRAFT',external_effects:false});
  await expect(client.request('POST',`/v1/conversations/${conversation.id}/commands`,{body:{type:'send_message',text:'Forbidden'}})).rejects.toMatchObject({status:403});
  expect((await pool.query('SELECT count(*)::int n FROM commands WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
  expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
 });
 it('revalidates a credential after a concurrent revocation wins its row lock',async()=>{
  const grant=await token(['products:write']),locker=await pool.connect();
  await locker.query('BEGIN');await locker.query('SELECT id FROM service_tokens WHERE id=$1 FOR UPDATE',[grant.id]);
  const pending=request('POST','/v1/products',{environment:'REAL',name:'Revocation race forbidden'},grant.token);
  let waiting=false;
  try{for(let i=0;i<100;i++){const rows=await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%service_tokens%FOR SHARE%' AND pid<>pg_backend_pid()");if(rows.rowCount){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
   expect(waiting).toBe(true);await locker.query('UPDATE service_tokens SET revoked_at=now() WHERE id=$1',[grant.id]);await locker.query('COMMIT');
  }finally{await locker.query('ROLLBACK');locker.release();}
  expect((await pending).statusCode).toBe(401);
  expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND body->>'name'='Revocation race forbidden'",[workspace])).rows[0].n).toBe(0);
 });
 it('follows APPLIED through an actual delivery ACK and never calls SENT delivered',async()=>{
  const base={workspaceId:workspace,environment:'SIMULATION' as const};
  const account=await putRecord(pool,{...base,kind:'channel_account',body:{name:'Synthetic ACK fixture account',provider:'simulator'}}),contact=await putRecord(pool,{...base,kind:'contact',body:{identity:'opaque:ack-fixture-'+randomUUID()}});
  const conversation=await putRecord(pool,{...base,kind:'conversation',body:{stage:'NEW',account_id:account.id,contact_id:contact.id}}),commandId=randomUUID(),effectId=randomUUID();
  await pool.query("INSERT INTO commands(id,workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key,status,result) VALUES($1,$2,'SIMULATION','conversation_command',$3,'fixture','{}',$4,'APPLIED',$5)",[commandId,workspace,conversation.id,randomUUID(),{effect_id:effectId}]);
  await pool.query("INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,status,config_hash) VALUES($1,$2,'SIMULATION',$3,$4,$5,$6,$7,'SENT',$8)",[effectId,workspace,account.id,conversation.id,contact.id,'command:'+commandId,{kind:'text',text:'Synthetic acknowledged message'},hash('fixture')]);
  const grant=await token(['commands:read'],{allowed_environments:['SIMULATION'],resource_ids:[conversation.id]}),client=new CommerceClient({baseUrl,token:grant.token,lab:true});
  expect((await client.follow(commandId,{timeoutMs:40,intervalMs:5})).status).toBe('TIMEOUT');
  await pool.query("UPDATE outbox SET status='DELIVERED' WHERE id=$1",[effectId]);
  expect(await client.follow(commandId,{timeoutMs:1000})).toMatchObject({status:'DELIVERED',portal_access:'NOT_OBSERVED'});
  const {materializeEffectResults}=await import('../../apps/automation-worker/src/effect-results.js');await materializeEffectResults(1000);
  expect((await pool.query("SELECT body FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='message' AND body->>'effect_id'=$2",[workspace,effectId])).rows[0].body).toMatchObject({account_id:account.id,contact_id:contact.id,conversation_id:conversation.id,status:'DELIVERED'});
 });
 it('copies commercial versions and exact immutable file bytes into isolated simulation without real secrets',async()=>{
  const bytes=Buffer.from('%PDF-1.4\nSynthetic fixture\n%%EOF');
  const asset=data(await request('POST','/v1/assets/upload-intents',{environment:'REAL',name:'Fixture PDF',kind:'file',mime_type:'application/pdf',size_bytes:bytes.length,sha256:hash(bytes)}),201);
  data(await request('PUT',`/v1/assets/${asset.id}/content`,{environment:'REAL',base64:bytes.toString('base64')}));
  data(await request('POST',`/v1/assets/${asset.id}/complete`,{environment:'REAL'}));
  const product=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'product',body:{name:'Versioned product',asset_ids:[asset.id]}});
  const access=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'asset',body:{name:'Private portal',kind:'access',adapter:'link',status:'READY',delivery_ciphertext:encrypt({adapter:'link',delivery_reference:JSON.stringify({url:'https://example.invalid/real',code:'SECRET-REAL-CODE',instructions:'Private'})})}});
  const offer=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'offer',body:{product_id:product.id,currency:'MXN',base_amount_minor:9700,status:'PUBLISHED',fulfillment:[{asset_id:asset.id,release_on:'receipt_approved'},{asset_id:access.id,release_on:'commitment_accepted'}]}});
  const agent=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'agent',body:{name:'Seller snapshot',product_id:product.id,provider:'openai',model:'approved-source-model'}});
  const flow=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'workflow',body:{name:'Immutable selected flow',agent_version_id:agent.id,product_id:product.id,offer_version_id:offer.id,status:'PUBLISHED',entry_node_id:'start',nodes:[{id:'start',type:'entry',config:{},next:'end'},{id:'end',type:'end',config:{}}]}});
  const grant=await token(['workflows:read','simulations:run','assets:read','products:read'],{allowed_environments:['REAL','SIMULATION']});const client=new CommerceClient({baseUrl,token:grant.token,lab:true});
  const before=(await pool.query("SELECT id,version,body FROM records WHERE workspace_id=$1 AND environment='REAL' ORDER BY id",[workspace])).rows;
  const priorLabIds=new Set((await pool.query("SELECT id FROM records WHERE workspace_id=$1 AND environment='SIMULATION'",[workspace])).rows.map(r=>r.id));
  const key=randomUUID(),snapshot=await client.request<{environment:string;workflow_version_id:string;materials:Array<{id:string;kind:string}>}>('POST','/v1/simulation-snapshots',{key,body:{workflow_version_id:flow.id,expected_version:flow.version}});
  expect((await client.request('POST','/v1/simulation-snapshots',{key,body:{workflow_version_id:flow.id,expected_version:flow.version}})).data).toEqual(snapshot.data);
  expect(snapshot.data.environment).toBe('SIMULATION');expect(snapshot.data.workflow_version_id).not.toBe(flow.id);
  const clonedFile=snapshot.data.materials.find(a=>a.kind==='file')!;expect(clonedFile).toMatchObject({sha256:hash(bytes),size_bytes:bytes.length,content:'IMMUTABLE_FILE_REFERENCE'});
  const downloaded=await request('GET',`/v1/assets/${clonedFile.id}/content?environment=SIMULATION`,undefined,grant.token);expect(downloaded.statusCode,downloaded.body).toBe(200);expect(downloaded.rawPayload).toEqual(bytes);
  const lab=(await pool.query("SELECT id,kind,body FROM records WHERE workspace_id=$1 AND environment='SIMULATION'",[workspace])).rows.filter(r=>!priorLabIds.has(r.id));
  expect(lab.find(r=>r.kind==='channel_account').body).toMatchObject({provider:'simulator',sending_enabled:false});
  expect(lab.find(r=>r.kind==='agent').body).toMatchObject({provider:'deterministic',model:'deterministic-v1'});
  expect(lab.some(r=>['contact','order','receipt'].includes(r.kind))).toBe(false);
  const after=(await pool.query("SELECT id,version,body FROM records WHERE workspace_id=$1 AND environment='REAL' ORDER BY id",[workspace])).rows;expect(after).toEqual(before);
  expect(JSON.stringify(snapshot)).not.toContain('SECRET-REAL-CODE');expect(JSON.stringify(snapshot)).not.toContain('storage_key');
  await expect(new CommerceClient({baseUrl,token:grant.token}).request('POST','/v1/simulation-snapshots',{body:{workflow_version_id:flow.id,expected_version:flow.version}})).rejects.toMatchObject({code:'SIMULATION_ONLY'});
 });
 it('copies an explicitly selected published offer linked from the offer without changing REAL configuration',async()=>{
  const product=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'product',body:{name:'Approved independent product'}});
  const media:Awaited<ReturnType<typeof putRecord>>[]=[];for(const[name,mime_type]of [['Presentation audio','audio/mpeg'],['Pack image','image/png'],['Agreement audio','audio/mpeg'],['Collection audio','audio/mpeg']] as const)media.push(await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'asset',body:{name,kind:'link',mime_type,url:`https://example.invalid/${name.toLowerCase().replaceAll(' ','-')}`,status:'READY'}}));
  const definition=salesAgreementWorkflowV1({presentation_audio_id:media[0]!.id,pack_image_id:media[1]!.id,agreement_audio_id:media[2]!.id,collection_audio_id:media[3]!.id},{offer:'Snapshot offer',agreement:'Snapshot agreement',payment:'Snapshot payment',thanks:'Snapshot thanks'});
  const flow=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'workflow',body:{...definition,name:'Approved independent flow',product_id:product.id,status:'PUBLISHED'}});
  const stage=(asset_id:string,text:string)=>({medium:'audio' as const,asset_id,text}),remarketing=createDefaultRemarketingPolicy([
   {awaiting_agreement:stage(media[0]!.id,'Agreement reminder one'),awaiting_payment:stage(media[3]!.id,'Payment reminder one')},
   {awaiting_agreement:stage(media[0]!.id,'Agreement reminder two'),awaiting_payment:stage(media[3]!.id,'Payment reminder two')},
   {awaiting_agreement:stage(media[0]!.id,'Agreement reminder three'),awaiting_payment:stage(media[3]!.id,'Payment reminder three')},
  ]);
  const sales_flow={entry_aliases:['Approved independent product'],recipe:salesAgreementRecipeV1(),remarketing,content:{presentation:{audio_asset_id:media[0]!.id,pack_image_asset_id:media[1]!.id,offer_text:'Snapshot offer'},agreement:{audio_asset_id:media[2]!.id,prompt:'Snapshot agreement'},collection:{audio_asset_id:media[3]!.id,payment_instructions:'Snapshot payment'},closure:{receipt_thanks:'Snapshot thanks'}}};
  const offer=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'offer',body:{name:'Approved linked offer',product_id:product.id,workflow_version_id:flow.id,currency:'MXN',base_amount_minor:9700,status:'PUBLISHED',fulfillment:[],sales_flow}});
  const grant=await token(['workflows:read','simulations:run','offers:read'],{allowed_environments:['REAL','SIMULATION']}),client=new CommerceClient({baseUrl,token:grant.token,lab:true});
  const before=(await pool.query("SELECT id,version,body FROM records WHERE workspace_id=$1 AND environment='REAL' ORDER BY id",[workspace])).rows;
  const pendingBefore=(await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n;
  const key=randomUUID(),body={workflow_version_id:flow.id,expected_version:flow.version,offer_version_id:offer.id,expected_offer_version:offer.version};
  const first=(await client.request<any>('POST','/v1/simulation-snapshots',{key,body})).data;
  expect(first).toMatchObject({environment:'SIMULATION',external_effects:false,source:{workflow_version_id:flow.id,version:flow.version,offer_version_id:offer.id,offer_version:offer.version,offer_selection:'EXPLICIT'}});
  expect((await client.request('POST','/v1/simulation-snapshots',{key,body})).data).toEqual(first);
  const records=(await pool.query('SELECT id,kind,environment,body FROM records WHERE workspace_id=$1 AND id=ANY($2::uuid[])',[workspace,[first.workflow_version_id,first.offer_version_id,first.account_id,first.product_id]])).rows;
  expect(records).toHaveLength(4);expect(records.every(r=>r.environment==='SIMULATION')).toBe(true);
  expect(records.find(r=>r.kind==='workflow').body).toMatchObject({offer_version_id:first.offer_version_id,product_id:first.product_id});
  const clonedOffer=records.find(r=>r.kind==='offer').body,mediaMap=new Map(first.materials.map((item:any)=>[item.source_asset_id,item.id]));
  expect(clonedOffer).toMatchObject({workflow_version_id:first.workflow_version_id,product_id:first.product_id,base_amount_minor:9700});
  expect(clonedOffer.sales_flow.content).toMatchObject({presentation:{audio_asset_id:mediaMap.get(media[0]!.id),pack_image_asset_id:mediaMap.get(media[1]!.id)},agreement:{audio_asset_id:mediaMap.get(media[2]!.id)},collection:{audio_asset_id:mediaMap.get(media[3]!.id)}});
  const clonedMediaIds=[clonedOffer.sales_flow.content.presentation.audio_asset_id,clonedOffer.sales_flow.content.presentation.pack_image_asset_id,clonedOffer.sales_flow.content.agreement.audio_asset_id,clonedOffer.sales_flow.content.collection.audio_asset_id];
  expect(clonedMediaIds.every((value:string)=>!media.some(item=>item.id===value))).toBe(true);
  expect((await pool.query('SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND environment=\'SIMULATION\' AND kind=\'asset\' AND id=ANY($2::uuid[])',[workspace,clonedMediaIds])).rows[0].n).toBe(4);
  expect(records.find(r=>r.kind==='channel_account').body).toMatchObject({provider:'simulator',sending_enabled:false});
  expect((await pool.query("SELECT id,version,body FROM records WHERE workspace_id=$1 AND environment='REAL' ORDER BY id",[workspace])).rows).toEqual(before);
  expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(pendingBefore);
  const audit=(await pool.query("SELECT payload,environment FROM domain_events WHERE workspace_id=$1 AND event_type='simulation.snapshot_created' AND aggregate_id=$2",[workspace,first.workflow_version_id])).rows;
  expect(audit).toHaveLength(1);expect(audit[0]).toMatchObject({environment:'SIMULATION',payload:{source_offer_id:offer.id,source_offer_version:offer.version,offer_selection:'EXPLICIT'}});
 });
 it('rejects explicit offer conflicts, unpublished or foreign references, missing grants and stale revisions without lab writes',async()=>{
  const product=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'product',body:{name:'Snapshot boundaries'}});
  const flow=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'workflow',body:{name:'Snapshot source',product_id:product.id,status:'PUBLISHED',nodes:[],entry_node_id:'unused'}});
  const offer=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'offer',body:{name:'Explicit source',product_id:product.id,workflow_version_id:flow.id,status:'PUBLISHED'}});
  const otherProduct=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'product',body:{name:'Other product'}}),otherFlow=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'workflow',body:{name:'Other exact flow',product_id:product.id,status:'PUBLISHED'}});
  const draft=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'offer',body:{name:'Draft',product_id:product.id,workflow_version_id:flow.id,status:'DRAFT'}}),wrongProduct=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'offer',body:{name:'Other product offer',product_id:otherProduct.id,workflow_version_id:flow.id,status:'PUBLISHED'}}),wrongFlow=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'offer',body:{name:'Other exact workflow',product_id:product.id,workflow_version_id:otherFlow.id,status:'PUBLISHED'}});
  const foreign=await putRecord(pool,{workspaceId:'foreign-snapshot-'+randomUUID(),environment:'REAL',kind:'offer',body:{name:'Foreign private source',status:'PUBLISHED'}}),simulated=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'offer',body:{name:'Already simulated',status:'PUBLISHED'}});
  const grant=await token(['workflows:read','simulations:run','offers:read'],{allowed_environments:['REAL','SIMULATION']}),noOfferRead=await token(['workflows:read','simulations:run'],{allowed_environments:['REAL','SIMULATION']}),simOnly=await token(['workflows:read','simulations:run','offers:read'],{allowed_environments:['SIMULATION']});
  const base={environment:'SIMULATION',workflow_version_id:flow.id,expected_version:flow.version,offer_version_id:offer.id,expected_offer_version:offer.version};
  const before=(await pool.query("SELECT id,version,body FROM records WHERE workspace_id=$1 AND environment='SIMULATION' ORDER BY id",[workspace])).rows;
  for(const[selected,code]of [[draft,'OFFER_NOT_PUBLISHED'],[wrongProduct,'OFFER_PRODUCT_MISMATCH'],[wrongFlow,'OFFER_WORKFLOW_MISMATCH'],[foreign,'NOT_FOUND'],[simulated,'NOT_FOUND']] as const){const response=await request('POST','/v1/simulation-snapshots',{...base,offer_version_id:selected.id,expected_offer_version:selected.version},grant.token);expect(response.statusCode,response.body).toBe(code==='NOT_FOUND'?404:409);expect(response.json().error.code).toBe(code);}
  for(const[change,code]of [[{expected_version:999},'VERSION_CONFLICT'],[{expected_offer_version:999},'VERSION_CONFLICT'],[{environment:'REAL'},'SIMULATION_ONLY']] as const){expect((await request('POST','/v1/simulation-snapshots',{...base,...change},grant.token)).json().error.code).toBe(code);}
  expect((await request('POST','/v1/simulation-snapshots',base,noOfferRead.token)).statusCode).toBe(403);
  expect((await request('POST','/v1/simulation-snapshots',base,simOnly.token)).json().error.code).toBe('ENVIRONMENT_FORBIDDEN');
  const{expected_offer_version:_,...withoutRevision}=base;expect((await request('POST','/v1/simulation-snapshots',withoutRevision,grant.token)).statusCode).toBe(400);
  const{offer_version_id:__,...withoutOffer}=base;expect((await request('POST','/v1/simulation-snapshots',withoutOffer,grant.token)).statusCode).toBe(400);
  const pinned=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'workflow',body:{...flow.body,offer_version_id:wrongFlow.id}});
  expect((await request('POST','/v1/simulation-snapshots',{...base,workflow_version_id:pinned.id,expected_version:pinned.version},grant.token)).json().error.code).toBe('OFFER_CONFLICT');
  expect((await pool.query("SELECT id,version,body FROM records WHERE workspace_id=$1 AND environment='SIMULATION' ORDER BY id",[workspace])).rows).toEqual(before);
 });
 it.each(['workflow','offer'] as const)('revalidates the explicit source %s revision after a concurrent archive releases its lock',async kind=>{
  const product=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'product',body:{name:'Snapshot race product'}});
  const flow=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'workflow',body:{name:'Snapshot race flow',product_id:product.id,status:'PUBLISHED'}}),offer=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'offer',body:{name:'Race offer',product_id:product.id,workflow_version_id:flow.id,status:'PUBLISHED'}});
  const grant=await token(['workflows:read','simulations:run','offers:read'],{allowed_environments:['REAL','SIMULATION']}),locker=await pool.connect(),target=kind==='workflow'?flow:offer;
  await locker.query('BEGIN');await locker.query('SELECT id FROM records WHERE id=$1 FOR UPDATE',[target.id]);
  const lockerPid=(await locker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const pending=request('POST','/v1/simulation-snapshots',{environment:'SIMULATION',workflow_version_id:flow.id,expected_version:flow.version,offer_version_id:offer.id,expected_offer_version:offer.version},grant.token);
  try{let waiting=false;for(let i=0;i<100;i++){const result=await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%records%FOR SHARE%'",[lockerPid]);if(result.rowCount){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}expect(waiting).toBe(true);await putRecord(locker,{id:target.id,version:target.version,workspaceId:workspace,environment:'REAL',kind:target.kind,body:{...target.body,archived_at:new Date().toISOString(),archive_reason:'Concurrent archive regression'}});await locker.query('COMMIT');}finally{await locker.query('ROLLBACK');locker.release();}
  const response=await pending;expect(response.statusCode,response.body).toBe(409);expect(response.json().error.code).toBe('VERSION_CONFLICT');
  expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND body->'lab_source'->>'id'=$2",[workspace,flow.id])).rows[0].n).toBe(0);
 });
 it('reports scoped readiness from evidence without promoting configuration or human attestation to provider proof',async()=>{
  const a=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Scoped number',provider:'waha',status:'DISCONNECTED',sending_enabled:false}}),b=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Hidden number',provider:'waha',status:'DISCONNECTED'}});
  const grant=await token(['channels:read'],{resource_ids:[a.id]});
  const scoped=data(await request('GET','/v1/readiness',undefined,grant.token));expect(scoped.scope).toBe('RESOURCE');expect(scoped.accounts.map((r:any)=>r.id)).toEqual([a.id]);expect(scoped.checks).toEqual([]);expect(scoped.evidence).toEqual([]);expect(JSON.stringify(scoped)).not.toContain(b.id);expect(scoped.ready).toBe(false);
  const input={environment:'REAL',kind:'smtp_received',status:'VERIFIED',evidence_ref:'fixture/mail-reception',details:{summary:'Controlled synthetic evidence for readiness contract'},observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+3600000).toISOString()};
  expect((await request('POST','/v1/operational-evidence',input,grant.token)).statusCode).toBe(403);
  expect((await request('POST','/v1/operational-evidence',{...input,source:'SERVER_JOB'})).statusCode).toBe(400);
  const key=randomUUID(),evidence=data(await request('POST','/v1/operational-evidence',input,undefined,key),201);expect(evidence.source).toBe('HUMAN_ATTESTATION');expect(data(await request('POST','/v1/operational-evidence',input,undefined,key),201).id).toBe(evidence.id);
  const healthObservedAt=new Date(Date.now()-1000).toISOString(),healthExpiresAt=new Date(Date.now()+60000).toISOString();
  await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'health_signal',body:{account_id:a.id,dimension:'session',status:'OK',value:'WORKING',scope:'account',source:'provider_read',observed_at:healthObservedAt,expires_at:healthExpiresAt}});
  await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'health_signal',body:{account_id:a.id,dimension:'quality',status:'UNKNOWN',scope:'account',source:'provider_read',observed_at:healthObservedAt,expires_at:healthExpiresAt}});
	  await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'health_signal',body:{account_id:a.id,dimension:'restriction',status:'OK',value:{latest_read:{timelock:true,capping:true}},scope:'account',source:'provider_read',observed_at:healthObservedAt,expires_at:healthExpiresAt}});
	  await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'health_signal',body:{account_id:a.id,dimension:'session',status:'BLOCKED',scope:'account',source:'malformed_historical_fixture',observed_at:'not-a-timestamp',expires_at:healthExpiresAt}});
	  const healthHistory=await request('GET',`/v1/channel-accounts/${a.id}/health`);expect(healthHistory.statusCode,healthHistory.body).toBe(200);expect(JSON.stringify(healthHistory.json())).not.toContain('malformed_historical_fixture');
  const stale=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'service_heartbeat',body:{service:'channel-worker',instance:'prior-instance',status:'OK',observed_at:new Date(Date.now()-120000).toISOString(),expires_at:new Date(Date.now()-60000).toISOString()}});
  await pool.query("UPDATE records SET updated_at=now()-interval '2 minutes',version=version+1 WHERE id=$1",[stale.id]);
  const fresh=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'service_heartbeat',body:{service:'channel-worker',instance:'current-instance',status:'OK',observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+45000).toISOString()}});
  let disk=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'operational_metric',body:{key:'private_storage_disk',status:'OBSERVED',source:'MOUNTED_PRIVATE_STORAGE_STATFS',available_bytes:8*1024**3,total_bytes:20*1024**3,observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+180000).toISOString()}});
  const owner=data(await request('GET','/v1/readiness'));expect(owner.ready).toBe(false);
  expect(owner.checks.find((c:any)=>c.key==='private_storage_disk')).toMatchObject({status:'VERIFIED',source:'MOUNTED_PRIVATE_STORAGE_STATFS',details:{available_bytes:8*1024**3,total_bytes:20*1024**3}});
  const diskStatus=async()=>data(await request('GET','/v1/readiness')).checks.find((c:any)=>c.key==='private_storage_disk').status;
  disk=await putRecord(pool,{id:disk.id,version:disk.version,workspaceId:workspace,environment:'REAL',kind:'operational_metric',body:{...disk.body,available_bytes:1024**2}});expect(await diskStatus()).toBe('BLOCKED');
  disk=await putRecord(pool,{id:disk.id,version:disk.version,workspaceId:workspace,environment:'REAL',kind:'operational_metric',body:{...disk.body,expires_at:new Date(Date.now()-1000).toISOString()}});expect(await diskStatus()).toBe('STALE');
  await putRecord(pool,{id:disk.id,version:disk.version,workspaceId:workspace,environment:'REAL',kind:'operational_metric',body:{key:'private_storage_disk',status:'UNAVAILABLE',source:'MOUNTED_PRIVATE_STORAGE_STATFS',observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+180000).toISOString()}});expect(await diskStatus()).toBe('UNAVAILABLE');
  const hiddenMetrics=data(await request('GET','/v1/readiness',undefined,grant.token));expect(hiddenMetrics.checks).toEqual([]);expect(JSON.stringify(hiddenMetrics)).not.toContain('private_storage_disk');expect(JSON.stringify(hiddenMetrics)).not.toContain('available_bytes');

  expect(owner.accounts.find((r:any)=>r.id===a.id).checks.find((c:any)=>c.key==='health').status).toBe('VERIFIED');
  expect(owner.checks.find((c:any)=>c.key==='channel-worker').status).toBe('VERIFIED');
  await pool.query("UPDATE records SET body=jsonb_set(body,'{expires_at}',to_jsonb((now()-interval '1 second')::text)),version=version+1 WHERE id=$1",[fresh.id]);
  expect(data(await request('GET','/v1/readiness')).checks.find((c:any)=>c.key==='channel-worker').status).toBe('STALE');
  const pilot={...input,kind:'commercial_pilot',evidence_ref:'fixture/current-commercial',details:{summary:'Controlled pilot with explicit current account coverage',resource_ids:[a.id]}};
  data(await request('POST','/v1/operational-evidence',pilot),201);
  expect(data(await request('GET','/v1/readiness')).checks.find((c:any)=>c.key==='commercial_pilot').status).toBe('UNAVAILABLE');
  data(await request('POST','/v1/operational-evidence',{...pilot,details:{...pilot.details,resource_ids:[a.id,b.id]}}),201);
  expect(data(await request('GET','/v1/readiness')).checks.find((c:any)=>c.key==='commercial_pilot')).toMatchObject({status:'VERIFIED',source:'HUMAN_ATTESTATION'});
  expect(owner.checks.find((c:any)=>c.key==='smtp_received')).toMatchObject({status:'VERIFIED',source:'HUMAN_ATTESTATION'});expect(owner.checks.find((c:any)=>c.key==='backup_external').status).toBe('UNAVAILABLE');
 });
 it('does not show inherited graduation as ready after the connected number changes',async()=>{
  const fingerprint=hash('12025550174@c.us'),account=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Synthetic graduated identity',provider:'waha',status:'WORKING',sending_enabled:false,identity_verified:true,identity_fingerprint:fingerprint}});
  const profile=(await pool.query("INSERT INTO warmup_profiles(workspace_id,environment,config) VALUES($1,'REAL',$2) RETURNING id",[workspace,{name:'Identity readiness fixture',timezone:'UTC'}])).rows[0],group=(await pool.query("INSERT INTO warmup_pools(workspace_id,environment,profile_id) VALUES($1,'REAL',$2) RETURNING id",[workspace,profile.id])).rows[0];
  const identity=(await pool.query("INSERT INTO warmup_identities(workspace_id,environment,account_id,address_fingerprint,address_ciphertext,profile_ciphertext,ownership_evidence) VALUES($1,'REAL',$2,$3,$4,$5,'Synthetic fixture only') RETURNING id",[workspace,account.id,hash('wa:12025550174'),encrypt('wa:12025550174'),encrypt({name:'Owned fixture',about:'Synthetic'})])).rows[0];
  await pool.query("INSERT INTO warmup_states(account_id,workspace_id,environment,pool_id,profile_id,identity_id,status,reason,enrolled_at,graduated_at) VALUES($1,$2,'REAL',$3,$4,$5,'GRADUATED','BACKFILL',now()-interval '31 days',now())",[account.id,workspace,group.id,profile.id,identity.id]);
  const check=async()=>data(await request('GET','/v1/readiness')).accounts.find((a:any)=>a.id===account.id).checks.find((c:any)=>c.key==='warmup');
  expect(await check()).toMatchObject({status:'VERIFIED',source:'WARMUP_STATE'});
  const same=await putRecord(pool,{id:account.id,version:account.version,workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{...account.body,identity_fingerprint:hash('12025550174@s.whatsapp.net')}});expect((await check()).status).toBe('VERIFIED');
  await putRecord(pool,{id:account.id,version:same.version,workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{...same.body,identity_fingerprint:hash('12025550175@c.us')}});expect((await check()).status).toBe('BLOCKED');
  expect(data(await request('GET','/v1/warmup')).provider_verified).toBe(false);
 });
 it('documents defaults, scopes and idempotency on the actual route inventory',async()=>{
  const spec=(await app.inject({method:'GET',url:'/v1/openapi.json'})).json();
  expect(spec.paths['/v1/products'].get.parameters.find((p:any)=>p.name==='environment').schema.default).toBe('REAL');
  expect(spec.paths['/v1/simulation-snapshots'].post['x-required-service-scopes']).toEqual(['simulations:run','workflows:read']);
  expect(spec.paths['/v1/simulation-snapshots'].post.requestBody.content['application/json'].schema.properties).toMatchObject({offer_version_id:{type:'string',format:'uuid'},expected_offer_version:{type:'integer',minimum:1}});
  expect(spec.paths['/v1/simulation-snapshots'].post['x-conditional-service-scopes']).toEqual({offer_version_id:{any_of:['offers:read','products:read']}});
  expect(spec.paths['/v1/conversations/{id}/proposals'].post.requestBody.content['application/json'].schema.required).toContain('expected_version');
  expect(spec.paths['/v1/conversations/{id}/commands'].post.security).toEqual([{session:[]},{ownerPersonalToken:[]}]);
  expect(spec.paths['/v1/conversations/{id}/commands'].post['x-required-service-scopes']).toEqual(['human-only']);
 });
});
