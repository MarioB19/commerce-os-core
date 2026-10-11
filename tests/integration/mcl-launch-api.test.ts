import {beforeAll,afterAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord,withTransaction,getRecord} from '../../packages/db/src/index.js';
import {ensureOrder} from '../../apps/automation-worker/src/workflows.js';
import {materializeMessage} from '../../apps/automation-worker/src/inbound.js';
import {gated} from '../../apps/automation-worker/src/shared.js';
import {normalizeSimulator} from '../../packages/messaging/src/index.js';
import {summary} from '../../apps/api/src/reports.js';
import {applyCommand} from '../../apps/automation-worker/src/commands.js';
import type {Body} from '../../packages/contracts/src/index.js';
import {lockLaunchTestOrderCreation,launchTestOrderFields} from '../../packages/db/src/launch-test-scope.js';
import {mclImportIdempotencyKey,type MclIdempotencyBinding} from '../../scripts/import-mi-ciclo-listo.js';
const workspace='mcl-api-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
const importerBinding:MclIdempotencyBinding={release_sha256:'a'.repeat(64),private_configuration_sha256:'b'.repeat(64),source_sha:'c'.repeat(40),compiler_sha256:'d'.repeat(64),compiled_plan_sha256:'e'.repeat(64),audio_review_sha256:'f'.repeat(64),approval_sha256:'1'.repeat(64)};
let app:FastifyInstance,cookie:string,viewer:string;
const record=(kind:string,body:Body)=>putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind,body});
beforeAll(async()=>{app=await createApp();for(const role of ['owner','viewer'] as const){const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');await provisionUser({name:'Synthetic '+role,email,password,workspace_id:workspace,role});const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:role==='owner'?'192.0.2.51':'192.0.2.52',payload:{email,password},headers:{origin}});expect(login.statusCode).toBe(200);const cookies=login.cookies.map(c=>`${c.name}=${c.value}`).join('; ');if(role==='owner')cookie=cookies;else viewer=cookies;}});
afterAll(async()=>{await app.close();await pool.end();});
const call=(method:any,url:string,payload?:Body,who=cookie)=>app.inject({method,url:url+(url.includes('?')?'&':'?')+'environment=SIMULATION',payload,headers:{origin,cookie:who,'idempotency-key':randomUUID()}});
async function waitForBlockedTransaction(pid:number){
 await expect.poll(async()=>(await pool.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) blocked',[pid])).rows[0].blocked,{timeout:3000,interval:10}).toBe(true);
}
async function fixture(){
 const product=await record('product',{name:'Synthetic nine grades'}),offer=await record('offer',{name:'Synthetic offer',product_id:product.id,currency:'MXN',base_amount_minor:9700,status:'PUBLISHED'});
 const account=await record('channel_account',{name:'N01 synthetic',provider:'simulator',status:'WORKING',offer_version_id:offer.id,sending_enabled:false});
 const buyer=await record('contact',{name:'Own buyer',identity:'opaque:'+randomUUID()}),beneficiary=await record('contact',{name:'Own beneficiary',identity:'opaque:'+randomUUID()});
 const payload={account_id:account.id,offer_version_id:offer.id,participants:[{contact_id:buyer.id,role:'buyer',own_phone_confirmed:true}],purpose:'Synthetic own phone rehearsal',expires_at:new Date(Date.now()+3600000).toISOString()};
 return{product,offer,account,buyer,beneficiary,payload};
}
it('predeclares own recipient roles, never authorizes sends and enforces API role/environment',async()=>{
 const f=await fixture();expect((await call('POST','/v1/launch-tests',f.payload,viewer)).statusCode).toBe(403);
 const created=await call('POST','/v1/launch-tests',f.payload);expect(created.statusCode,created.body).toBe(201);const scope=created.json().data;
 expect(scope).toMatchObject({authorizes_sends:false,analytics_excluded_from_creation:true});
 expect((await call('POST','/v1/launch-tests',f.payload)).statusCode).toBe(409);
 expect((await call('GET','/v1/launch-tests',undefined,viewer)).statusCode).toBe(403);
 expect((await pool.query('SELECT count(*)::int n FROM operation_authorizations WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
 const conversation=await record('conversation',{account_id:f.account.id,offer_version_id:f.offer.id,contact_id:f.buyer.id,status:'OPEN'});
 const order=(await withTransaction(c=>ensureOrder(c,conversation)))!;expect(order.body.commercial_classification).toBe('TEST');
 const revoked=await call('POST',`/v1/launch-tests/${scope.id}/revoke`,{reason:'Synthetic test concluded'});expect(revoked.statusCode).toBe(200);expect(revoked.json().data.revoked_at).toBeTruthy();
 const foreign=await app.inject({method:'GET',url:'/v1/launch-tests?environment=REAL',headers:{cookie,origin}});expect(foreign.json().data.some((x:Body)=>x.id===scope.id)).toBe(false);
});
it('accepts the importer key and returns the same asset intent on retry',async()=>{
 const payload={name:'Synthetic importer pitch',kind:'file',adapter:'private_file',mime_type:'audio/mpeg',size_bytes:20,sha256:randomBytes(32).toString('hex')};
	 const headers={origin,cookie,'idempotency-key':mclImportIdempotencyKey(importerBinding,'SIMULATION','asset:pitch')};
 const request=()=>app.inject({method:'POST',url:'/v1/assets/upload-intents?environment=SIMULATION',payload,headers});
 const first=await request(),retry=await request();
 expect(first.statusCode,first.body).toBe(201);expect(retry.statusCode,retry.body).toBe(201);expect(retry.json().data.id).toBe(first.json().data.id);
 expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='asset' AND body->>'sha256'=$2",[workspace,payload.sha256])).rows[0].n).toBe(1);
});
it('does not retroclassify a prior conversation when its first order waits for a new scope',async()=>{
 const f=await fixture(),conversation=await record('conversation',{account_id:f.account.id,offer_version_id:f.offer.id,contact_id:f.buyer.id,status:'OPEN'});
 const declaration=await pool.connect();let creation:Promise<Awaited<ReturnType<typeof ensureOrder>>>|undefined;
 try{
  await declaration.query('BEGIN');const pid=(await declaration.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await lockLaunchTestOrderCreation(declaration,workspace,f.account.id);
  const scope=(await declaration.query("INSERT INTO mcl_test_scopes(workspace_id,environment,account_id,offer_version_id,participants,purpose,actor_id,expires_at) VALUES($1,'SIMULATION',$2,$3,$4,$5,'synthetic-owner',$6) RETURNING id",[workspace,f.account.id,f.offer.id,JSON.stringify(f.payload.participants),f.payload.purpose,f.payload.expires_at])).rows[0];
  creation=withTransaction(async worker=>{await worker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[conversation.id]);return ensureOrder(worker,conversation);});
  await waitForBlockedTransaction(pid);await declaration.query('COMMIT');
  expect(scope.id).toBeTruthy();expect((await creation)!.body.commercial_classification).toBeUndefined();
  expect((await summary(workspace,'SIMULATION',{account_id:f.account.id})).cohort.conversation_ids).toContain(conversation.id);
 }finally{await declaration.query('ROLLBACK');declaration.release();await creation?.catch(()=>undefined);}
});
it('rejects a concurrent declaration when the first commercial order commits before it',async()=>{
 const f=await fixture(),conversation=await record('conversation',{account_id:f.account.id,offer_version_id:f.offer.id,contact_id:f.buyer.id,status:'OPEN'});
 const worker=await pool.connect();let declaration:ReturnType<typeof call>|undefined;
 try{
  await worker.query('BEGIN');const pid=(await worker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await worker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[conversation.id]);
  const order=(await ensureOrder(worker,conversation))!;expect(order.body.launch_test_scope_id).toBeUndefined();
  declaration=call('POST','/v1/launch-tests',f.payload);const pending=Promise.resolve(declaration);
  await waitForBlockedTransaction(pid);await worker.query('COMMIT');
  const response=await pending;expect(response.statusCode,response.body).toBe(409);expect(response.json().error.code).toBe('TEST_REQUIRES_NEW_CONVERSATION');
  expect((await pool.query('SELECT count(*)::int n FROM mcl_test_scopes WHERE workspace_id=$1 AND account_id=$2',[workspace,f.account.id])).rows[0].n).toBe(0);
 }finally{await worker.query('ROLLBACK');worker.release();await declaration?.catch(()=>undefined);}
});
it('rejects roles reuse, missing own-phone attestation and late classification after order creation',async()=>{
 const f=await fixture();
 expect((await call('POST','/v1/launch-tests',{...f.payload,participants:[f.payload.participants[0],f.payload.participants[0]]})).statusCode).toBe(400);
 expect((await call('POST','/v1/launch-tests',{...f.payload,participants:f.payload.participants.map(x=>({...x,own_phone_confirmed:false}))})).statusCode).toBe(400);
 const conversation=await record('conversation',{account_id:f.account.id,offer_version_id:f.offer.id,contact_id:f.buyer.id,status:'OPEN'});await withTransaction(c=>ensureOrder(c,conversation));
 const response=await call('POST','/v1/launch-tests',f.payload);expect(response.statusCode,response.body).toBe(409);
 expect(response.json().error.code).toBe('TEST_REQUIRES_NEW_CONVERSATION');
});
it('closes an uncommitted test preparation through a durable command without deleting history',async()=>{
 const f=await fixture(),conversation=await record('conversation',{account_id:f.account.id,offer_version_id:f.offer.id,contact_id:f.buyer.id,status:'OPEN',ai_pending:true});
 const pending=await call('POST',`/v1/conversations/${conversation.id}/commands`,{type:'close_conversation',reason:'Prepare separate own phone rehearsal'});expect(pending.statusCode).toBe(202);
 const cmd=(await pool.query('SELECT * FROM commands WHERE id=$1',[pending.json().data.id])).rows[0];await withTransaction(c=>applyCommand(c,cmd));
 expect((await getRecord(pool,workspace,'conversation',conversation.id))!.body).toMatchObject({status:'CLOSED',ai_pending:false});
 expect((await call('POST','/v1/launch-tests',f.payload)).statusCode).toBe(201);
});
it('shows actual seller precedence and pinned conversations without performing provider evaluation',async()=>{
 const f=await fixture(),numberAgent=await record('agent',{name:'Synthetic number seller',provider:'deterministic',model:'deterministic-v1'}),offerAgent=await record('agent',{name:'Synthetic offer seller',provider:'deterministic',model:'deterministic-v1'});
 await putRecord(pool,{id:f.account.id,version:f.account.version,workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body:{...f.account.body,agent_version_id:numberAgent.id}});
 // A new immutable offer version carries its seller; old conversations keep their IDs.
 const offer=await record('offer',{...f.offer.body,agent_version_id:offerAgent.id});
 const account=(await getRecord(pool,workspace,'channel_account',f.account.id))!;
 await putRecord(pool,{id:account.id,version:account.version,workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body:{...account.body,offer_version_id:offer.id}});
 await record('conversation',{account_id:account.id,contact_id:f.buyer.id,offer_version_id:f.offer.id,agent_version_id:numberAgent.id,agent_assignment_origin:'account',status:'CLOSED'});
 const response=await call('GET',`/v1/channel-accounts/${account.id}/effective-seller`);expect(response.statusCode,response.body).toBe(200);
 expect(response.json().data).toMatchObject({assignment:{origin:'offer',agent_version_id:offerAgent.id},provider_profile:{configured:true},real_provider_evaluated:false});
 expect(response.json().data.recent_conversations[0].agent_version_id).toBe(numberAgent.id);
 expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind='ai_run'",[workspace])).rows[0].n).toBe(0);
});
it('protects sponsorship reads and command IDs across roles and environments',async()=>{
 expect((await call('GET','/v1/sponsorships',undefined,viewer)).statusCode).toBe(403);
 expect((await call('POST',`/v1/sponsorships/${randomUUID()}/commands`,{action:'deliver',expected_version:1,reason:'Synthetic test'})).statusCode).toBe(410);
});

// Only synthetic records in the isolated integration database; no provider or worker loop.
async function firstInbound(f:Awaited<ReturnType<typeof fixture>>,overrides:{account?:typeof f.account;offerId?:string|null;identity?:string}={}){
 const account=overrides.account??f.account,offerId=overrides.offerId===null?undefined:overrides.offerId??f.offer.id;
 const normalized=normalizeSimulator({id:'early-test-'+randomUUID(),identity:overrides.identity??f.buyer.body.identity,text:'Synthetic first inbound'},new Date().toISOString())[0]!;
 return withTransaction(c=>materializeMessage(c,account,normalized,randomUUID(),offerId));
}
it('excludes the first TEST inbound from reports while paused, before any order or workflow tick',async()=>{
 const f=await fixture(),declared=await call('POST','/v1/launch-tests',f.payload);expect(declared.statusCode,declared.body).toBe(201);
 await pool.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'workspace',$1,true,'Synthetic early TEST pause','fixture')",[workspace]);
 const conversation=(await firstInbound(f))!;
 expect(await gated(pool,conversation)).toBe(true);
 expect(conversation.body).toMatchObject({commercial_classification:'TEST',launch_test_scope_id:declared.json().data.id,launch_test_role:'buyer',analytics_excluded_from_creation:true});
 expect(conversation.body.flow_state).toBeUndefined();
 expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind='order' AND body->>'conversation_id'=$2",[workspace,conversation.id])).rows[0].n).toBe(0);
 expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND conversation_id=$2',[workspace,conversation.id])).rows[0].n).toBe(0);
 const report=await summary(workspace,'SIMULATION',{account_id:f.account.id});expect(report.counts).toMatchObject({conversations:0,contacts:0,orders:0,receipts:0,sales:0});expect(report.cohort.size).toBe(0);
});
it.each(['expired','revoked'] as const)('keeps the first TEST classification after its scope is %s without authorizing effects',async status=>{
 const f=await fixture(),declared=await call('POST','/v1/launch-tests',f.payload);expect(declared.statusCode,declared.body).toBe(201);
 const conversation=(await firstInbound(f))!,scope=declared.json().data.id;
 await pool.query(status==='expired'?"UPDATE mcl_test_scopes SET expires_at=now()-interval '1 second' WHERE id=$1":"UPDATE mcl_test_scopes SET revoked_at=now() WHERE id=$1",[scope]);
 const order=(await withTransaction(c=>ensureOrder(c,conversation)))!;
 expect(order.body).toMatchObject({commercial_classification:'TEST',launch_test_scope_id:scope,analytics_excluded_from_creation:true});
 const {activeLaunchTest}=await import('../../packages/db/src/launch-test-scope.js');expect(await activeLaunchTest(pool,order)).toBe(false);
 expect((await summary(workspace,'SIMULATION',{account_id:f.account.id})).cohort.size).toBe(0);
});
it('rolls back the first inbound when exact active TEST scopes are ambiguous',async()=>{
 const f=await fixture(),declared=await call('POST','/v1/launch-tests',f.payload);expect(declared.statusCode,declared.body).toBe(201);
 await pool.query("INSERT INTO mcl_test_scopes(workspace_id,environment,account_id,offer_version_id,participants,purpose,actor_id,expires_at) VALUES($1,'SIMULATION',$2,$3,$4,'Synthetic duplicate corruption','fixture',$5)",[workspace,f.account.id,f.offer.id,JSON.stringify(f.payload.participants),f.payload.expires_at]);
 await expect(firstInbound(f)).rejects.toThrow('AMBIGUOUS_LAUNCH_TEST_SCOPE');
 expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind=ANY($2::text[]) AND body->>'account_id'=$3",[workspace,['conversation','message','touchpoint','order'],f.account.id])).rows[0].n).toBe(0);
});
it.each(['account','offer','contact'] as const)('does not mark a first inbound TEST with a different %s',async mismatch=>{
 const f=await fixture(),declared=await call('POST','/v1/launch-tests',f.payload);expect(declared.statusCode,declared.body).toBe(201);
 const otherAccount=mismatch==='account'?await record('channel_account',{...f.account.body}):f.account;
 const otherOffer=mismatch==='offer'?await record('offer',{...f.offer.body}):f.offer;
 const conversation=(await firstInbound(f,{account:otherAccount,offerId:otherOffer.id,identity:mismatch==='contact'?f.beneficiary.body.identity:f.buyer.body.identity}))!;
 expect(conversation.body.commercial_classification).toBeUndefined();expect(conversation.body.launch_test_scope_id).toBeUndefined();
 expect((await summary(workspace,'SIMULATION',{account_id:otherAccount.id})).cohort.conversation_ids).toContain(conversation.id);
});
it('does not mark an unresolved first inbound TEST without an exact offer',async()=>{
 const f=await fixture(),declared=await call('POST','/v1/launch-tests',f.payload);expect(declared.statusCode,declared.body).toBe(201);
 const {offer_version_id:unusedOffer,...body}=f.account.body;void unusedOffer;
 const account=await putRecord(pool,{id:f.account.id,version:f.account.version,workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body});
 const conversation=(await firstInbound(f,{account,offerId:null}))!;
 expect(conversation.body.routing_state).toBe('PRODUCT_SELECTION_REQUIRED');expect(conversation.body.commercial_classification).toBeUndefined();expect(conversation.body.offer_version_id).toBeUndefined();
});
it('never classifies a REAL entry with a SIMULATION scope even with the same tuple',async()=>{
 const f=await fixture(),declared=await call('POST','/v1/launch-tests',f.payload);expect(declared.statusCode,declared.body).toBe(201);
 const fields=await withTransaction(c=>launchTestOrderFields(c,{...f.account,environment:'REAL',kind:'conversation',body:{account_id:f.account.id,offer_version_id:f.offer.id,contact_id:f.buyer.id}}));expect(fields).toEqual({});
});
it('rejects scope declaration after an OPEN conversation even before its first order',async()=>{
 const f=await fixture(),conversation=(await firstInbound(f))!;
 expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind='order' AND body->>'conversation_id'=$2",[workspace,conversation.id])).rows[0].n).toBe(0);
 const declared=await call('POST','/v1/launch-tests',f.payload);expect(declared.statusCode,declared.body).toBe(409);expect(declared.json().error.code).toBe('TEST_REQUIRES_NEW_CONVERSATION');
 expect((await getRecord(pool,workspace,'conversation',conversation.id))!.body.commercial_classification).toBeUndefined();
});
it('keeps a CLOSED journey created before a scope commercial when routing reuses it',async()=>{
 const f=await fixture(),prior=await record('conversation',{account_id:f.account.id,offer_version_id:f.offer.id,product_id:f.product.id,contact_id:f.buyer.id,status:'CLOSED'});
 const declared=await call('POST','/v1/launch-tests',f.payload);expect(declared.statusCode,declared.body).toBe(201);
 const conversation=(await firstInbound(f))!;expect(conversation.id).toBe(prior.id);expect(conversation.body.commercial_classification).toBeUndefined();
 const order=(await withTransaction(c=>ensureOrder(c,conversation)))!;expect(order.body.commercial_classification).toBeUndefined();expect(order.body.launch_test_scope_id).toBeUndefined();
 expect((await summary(workspace,'SIMULATION',{account_id:f.account.id})).cohort.conversation_ids).toContain(prior.id);
});
it('waits for a concurrent scope declaration before the first conversation INSERT',async()=>{
 const f=await fixture(),declaration=await pool.connect();let creation:ReturnType<typeof firstInbound>|undefined;
 try{
  await declaration.query('BEGIN');const pid=(await declaration.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  await lockLaunchTestOrderCreation(declaration,workspace,f.account.id);
  const scope=(await declaration.query("INSERT INTO mcl_test_scopes(workspace_id,environment,account_id,offer_version_id,participants,purpose,actor_id,expires_at) VALUES($1,'SIMULATION',$2,$3,$4,'Synthetic first-persistence race','fixture',$5) RETURNING id",[workspace,f.account.id,f.offer.id,JSON.stringify(f.payload.participants),f.payload.expires_at])).rows[0];
  creation=firstInbound(f);await waitForBlockedTransaction(pid);await declaration.query('COMMIT');
  expect((await creation)!.body).toMatchObject({commercial_classification:'TEST',launch_test_scope_id:scope.id,analytics_excluded_from_creation:true});
 }finally{await declaration.query('ROLLBACK');declaration.release();await creation?.catch(()=>undefined);}
});
