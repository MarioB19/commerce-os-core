import {bindProfileEnvironment} from '../../packages/db/src/profile-environment.js';
/** Real PostgreSQL tests over synthetic local records. No channel/QR/provider
 * observation is asserted by this fixture, and no production schema is changed. */
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import Fastify,{type FastifyInstance,type FastifyRequest} from 'fastify';
import {fromNodeHeaders} from 'better-auth/node';
import {hashPassword} from 'better-auth/crypto';
import {ZodError} from 'zod';
import {createAuth} from '../../apps/api/src/auth.js';
import {continuousAuthorizationRoutes} from '../../apps/api/src/continuous-authorization.js';
import {withPersonalProfileTransaction} from '../../packages/db/src/profile-personal-token.js';
import {sessionContinuity} from '../../packages/commerce-client/src/continuous-authorization.js';
import {createProfileMcp} from '../../apps/commerce-mcp/src/profile-server.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi,beforeEach} from 'vitest';
import {releaseFixtureNumbers} from '../support/profile-fixture.js';
import {asProfileOwner,requireMigratedProfileSchema,sealFixtureProfiles,selectFixtureSession} from '../support/migrated-database.js';
import {withProfileTransaction,type ProfileExecutor,type ProfilePool} from '../../packages/db/src/profile-context.js';
import {withProfileSessionTransaction} from '../../packages/db/src/profile-session-transaction.js';
import type {SessionProfile} from '../../packages/db/src/profile-session.js';
import * as store from '../../packages/db/src/continuous-authorization.js';
import {readContinuousEffectAuthority} from '../../packages/db/src/continuous-effect.js';
import {reconcileContinuousConnections} from '../../apps/channel-worker/src/continuous-connections.js';
import {withProfileQueryRouting} from '../../packages/db/src/profile-query-routing.js';
import {lockedContinuousWorkerProfile,readCommercialContinuity} from '../../packages/db/src/continuous-commercial.js';
import {readCurrentQrContinuity,continuousWarmupAuthorityBlock} from '../../packages/db/src/continuous-warmup.js';
import {proposeEffect,proposeEffectOutcome} from '../../apps/automation-worker/src/shared.js';
import {advanceWorkflow,processNewWorkflows,ensureOrder} from '../../apps/automation-worker/src/workflows.js';
import {processAgents} from '../../apps/automation-worker/src/agents.js';
import type {SalesAiProvider} from '../../packages/domain/src/sales/ai.js';
import type {SellerContext} from '../../packages/domain/src/sales/seller-context.js';
import {gateDispatch} from '../../apps/channel-worker/src/dispatch.js';
import {getRecord,hash,stableJson} from '../../packages/db/src/index.js';
import {channelIdentityHash} from '../../packages/db/src/commercial-assignments.js';
import {defaultOperationalSettings,type Body} from '../../packages/contracts/src/index.js';
import type {ContinuousAuthorization} from '../../packages/contracts/src/continuous-authorization.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';

const suffix=randomBytes(8).toString('hex'),workspace='continuous_'+suffix,foreign=workspace+'_foreign',actor='f3_owner_'+suffix;
const roles=['commerce_api','commerce_channel','commerce_automation'] as const;
type Role=typeof roles[number];
let admin:pg.Pool,app:FastifyInstance|undefined,address:string,cookie:string;
const origin='http://localhost:5173';
const pools=new Map<Role,pg.Pool>(),scoped=new Map<Role,ProfilePool>(),logins:string[]=[];
let session:{id:string;userId:string};
// V7 F2: environment-bound tables (custody, privileged readers, privacy guards)
// need the transaction's environment as production workers bind it (REAL here).
function tx<T>(role:Role,work:(db:ProfileExecutor)=>Promise<T>,scope=workspace,environment:'REAL'|'SIMULATION'='REAL'){return withProfileTransaction(scoped.get(role)!,scope,async db=>{await bindProfileEnvironment(db,environment);return work(db);});}
function human<T>(work:(db:ProfileExecutor,p:SessionProfile)=>Promise<T>){
 return withProfileSessionTransaction(scoped.get('commerce_api')!,session,{workspaceId:workspace,version:1},{scope:'assignments:write',mutation:true},work);
}
async function record(kind:string,body:object,scope=workspace,environment='REAL'){
 const id=randomUUID();await admin.query('INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,$3,$4,$5)',[id,scope,environment,kind,body]);return id;
}
async function commercial(scope=workspace,environment='REAL',existingAccount?:string,live=false){
 const account=existingAccount??await record('channel_account',{status:'PAUSED'},scope,environment),product=await record('product',{status:'DRAFT'},scope,environment);
 const binding=await record('binding',{account_id:account,product_id:product,...(live?{valid_from:'2000-01-01T00:00:00Z',valid_to:null}:{})},scope,environment),assignment=randomUUID();
 await admin.query('INSERT INTO commercial_assignments(id,workspace_id,environment,account_id,product_id,binding_id) VALUES($1,$2,$3,$4,$5,$6)',[assignment,scope,environment,account,product,binding]);
 return{account,product,binding,assignment};
}
async function issue(live=false){const origin=await commercial(workspace,'REAL',undefined,live),operationId=randomUUID();const state=await human((db,p)=>store.issueCommercialContinuity(db,'REAL',{operationId,assignmentId:origin.assignment,expectedRevision:1},p.authority));return{origin,state,operationId};}
async function saved(id:string){return(await admin.query('SELECT state FROM continuous_authorizations WHERE id=$1',[id])).rows[0]?.state as ContinuousAuthorization|undefined;}
async function count(table:string,id:string){if(!['continuous_authorization_events','continuous_authorizations'].includes(table))throw Error('TEST_TABLE');return Number((await admin.query('SELECT count(*)::int AS n FROM '+table+' WHERE '+(table==='continuous_authorizations'?'id':'authorization_id')+'=$1',[id])).rows[0].n);}
async function rawUpdate(role:Role,state:ContinuousAuthorization,patch:object){
 return tx(role,db=>db.query('UPDATE continuous_authorizations SET version=version+1,state=state||$2::jsonb WHERE id=$1',[state.id,{...patch,version:state.version+1}]));
}
async function qr(existingAccount?:string,scope=workspace){
 const account=existingAccount??await record('channel_account',{status:'PAUSED'},scope),connectionId=randomUUID(),fingerprint='a'.repeat(64);
 // Fixture owner prepares the existing durable schema. This is synthetic
 // source evidence for SQL validation, never a successful physical QR claim.
 await admin.query("INSERT INTO commands(id,workspace_id,environment,kind,resource_id,actor_id,payload,status,idempotency_key,created_at) VALUES($1::uuid,$2,'REAL','channel_command',$3,$4,'{\"type\":\"connect\"}','APPLIED',$1::uuid::text,clock_timestamp()-interval '1 second')",[connectionId,scope,account,actor]);
 await admin.query("UPDATE channel_sessions SET observed_state='CONNECTED',auth_state='VERIFIED',expected_identity_fingerprint=$2,provider_observed_at=clock_timestamp(),health_expires_at=clock_timestamp()+interval '5 minutes' WHERE account_id=$1",[account,fingerprint]);
 const revision=(await admin.query('SELECT revision FROM channel_sessions WHERE account_id=$1',[account])).rows[0].revision;
 return{operationId:randomUUID(),accountId:account,connectionId,expectedSessionRevision:revision,identityFingerprint:fingerprint};
}
async function humanCommand(state:ContinuousAuthorization,action:'pause'|'resume'|'revoke',operationId=randomUUID()){
 return human((db,p)=>store.applyContinuousHumanCommand(db,state.environment,state.id,state.source.kind,{operationId,expectedVersion:state.version,action},p.authority));
}
async function nextCommercial(f:Awaited<ReturnType<typeof issue>>){
 const revision=(await admin.query('UPDATE commercial_assignments SET revision=revision+1 WHERE id=$1 RETURNING revision',[f.origin.assignment])).rows[0].revision;
 return human((db,p)=>store.issueCommercialContinuity(db,'REAL',{operationId:randomUUID(),assignmentId:f.origin.assignment,expectedRevision:revision},p.authority));
}
async function effect(state:ContinuousAuthorization|null,patch:Partial<{account:string;scope:string;environment:string;kind:string;authorization:string;conversation:string;contact:string;payload:object;expired:boolean}>={}){
 return tx('commerce_automation',async db=>(await db.query(`INSERT INTO outbox(workspace_id,environment,account_id,conversation_id,contact_id,logical_key,kind,payload,config_hash,continuous_authorization_id,authorization_id,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp()+($12::int * interval '1 minute')) RETURNING id`,
 [patch.scope??workspace,patch.environment??'REAL',patch.account??state!.accountId,patch.conversation??randomUUID(),patch.contact??randomUUID(),randomUUID(),patch.kind??'message',patch.payload??{},'c'.repeat(64),state?.id??null,patch.authorization??null,patch.expired?-1:5])).rows[0].id as string,patch.scope??workspace);
}
async function warmupEffect(state:ContinuousAuthorization){
 // Minimal synthetic persisted turn; no sender, provider call or real QR.
 const peer=await record('channel_account',{status:'PAUSED'}),profile=randomUUID(),pool=randomUUID(),content=randomUUID(),conversation=randomUUID(),turn=randomUUID();
 await admin.query("INSERT INTO warmup_profiles(id,workspace_id,environment,config) VALUES($1,$2,'REAL','{}')",[profile,workspace]);
 await admin.query("INSERT INTO warmup_pools(id,workspace_id,environment,profile_id) VALUES($1,$2,'REAL',$3)",[pool,workspace,profile]);
 for(const account of [state.accountId,peer])await admin.query("INSERT INTO warmup_states(account_id,workspace_id,environment,pool_id,profile_id) VALUES($1,$2,'REAL',$3,$4)",[account,workspace,pool,profile]);
 await admin.query("INSERT INTO warmup_content(id,workspace_id,environment,content_hash,body,approved_by) VALUES($1,$2,'REAL',$3,'{}',$4)",[content,workspace,randomUUID(),actor]);
 await admin.query("INSERT INTO warmup_conversations(id,workspace_id,environment,initiator_id,peer_id,content_id,local_date) VALUES($1,$2,'REAL',$3,$4,$5,current_date)",[conversation,workspace,state.accountId,peer,content]);
 await admin.query("INSERT INTO warmup_turns(id,workspace_id,environment,conversation_id,sender_id,recipient_id,position,content,not_before,expires_at) VALUES($1,$2,'REAL',$3,$4,$5,1,'{}',clock_timestamp(),clock_timestamp()+interval '5 minutes')",[turn,workspace,conversation,state.accountId,peer]);
 return effect(state,{kind:'warmup',conversation,contact:peer,payload:{warmup_turn_id:turn}});
}

async function httpRequest(path:string,headers:Record<string,string>={},body?:object){
 return fetch(address+path,{method:body?'POST':'GET',redirect:'error',headers:{origin,...headers,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
}
async function nativeTransaction<T>(work:(client:pg.PoolClient)=>Promise<T>){
 const c=await pools.get('commerce_api')!.connect();try{await c.query('SET ROLE commerce_api');await c.query('BEGIN');const result=await work(c);expect((await c.query('COMMIT')).command).toBe('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function nativeSession(req:FastifyRequest){return nativeTransaction(async c=>{
 const native=await createAuth(c).api.getSession({headers:fromNodeHeaders(req.headers),query:{disableRefresh:true}});
 return native&&native.session.userId===native.user.id?{id:native.session.id,userId:native.user.id}:null;
});}
async function startHttp(){
 if(app)return;
 vi.stubEnv('BETTER_AUTH_SECRET','synthetic-f3-'+randomBytes(32).toString('hex'));
 const password='synthetic-continuity-password123',passwordHash=await hashPassword(password);
 await admin.query('INSERT INTO account(id,"accountId","providerId","userId",password,issuer) VALUES($1,$2,\'credential\',$2,$3,\'local:credential\')',[randomUUID(),actor,passwordHash]);
 app=Fastify({logger:false,disableRequestLogging:true});app.setErrorHandler((e:any,_r,reply)=>reply.code(e instanceof ZodError?400:e.statusCode??500).send({error:{code:e.code??'INTERNAL_ERROR'}}));
 const apiPool={connect:scoped.get('commerce_api')!.connect,query:pools.get('commerce_api')!.query.bind(pools.get('commerce_api')!)};
 await continuousAuthorizationRoutes(app,{origins:[origin],nativeSession,
  session:(s,f,environment,action,work)=>withProfileSessionTransaction(apiPool,s,f,action,(db,profile)=>work({db,profile,environment})),
  personal:(token,environment,action,work)=>withPersonalProfileTransaction(apiPool,token,environment,action,(db,profile)=>work({db,profile,environment})),
 });
 app.post('/api/auth/sign-in/email',{bodyLimit:4096},async(req,reply)=>{
  if(req.headers.origin!==origin)return reply.code(403).send({error:'ORIGIN'});
  const response=await nativeTransaction(c=>createAuth(c).handler(new Request('http://localhost:3001'+req.url,{method:'POST',headers:fromNodeHeaders(req.headers),body:JSON.stringify(req.body)})));
  reply.code(response.status);if(response.ok)reply.header('set-cookie',response.headers.getSetCookie());return{signedIn:response.ok};
 });
 address=await app.listen({host:'127.0.0.1',port:0});
 const response=await httpRequest('/api/auth/sign-in/email',{}, {email:actor+'@example.invalid',password});expect(response.status).toBe(200);
 cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');expect(cookie).toContain('better-auth.session_token=');
 // Select the actual session obtained by native signed-cookie verification.
 const signed=await nativeTransaction(async c=>{const value=await createAuth(c).api.getSession({headers:new Headers({cookie}),query:{disableRefresh:true}});expect(value?.user.id).toBe(actor);return{id:value!.session.id,userId:value!.user.id};});
 await selectFixtureSession({connect:async()=>{const c=await scoped.get('commerce_api')!.connect();return c as any;}},signed,workspace,0);
}
async function personal(scopes:string[]){const token='cos_pat_'+randomBytes(32).toString('base64url'),id=randomUUID();
 await admin.query(`INSERT INTO personal_access_tokens(id,workspace_id,user_id,name,token_hash,allowed_environments,profile_scopes,expires_at)
 VALUES($1,$2,$3,'Synthetic F3 HTTP',$4,'["REAL"]',$5,clock_timestamp()+interval '1 hour')`,[id,workspace,actor,createHash('sha256').update(token).digest('hex'),JSON.stringify(scopes)]);
 return{id,token};
}

async function commercialReady(input:{workflow?:Body;offer?:Body}={}){
 const f=await issue(true);
 await admin.query("UPDATE records SET version=version+1,body=body||$2::jsonb WHERE id=$1",[f.origin.account,{provider:'cloud',status:'WORKING',sending_enabled:true}]);
 const offer=await record('offer',{status:'PUBLISHED',name:'Synthetic offer',base_amount_minor:9900,currency:'MXN',product_id:f.origin.product,...input.offer}),workflow=await record('workflow',{status:'PUBLISHED',...input.workflow}),contact=await record('contact',{status:'LEAD'});
 const now=(await admin.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
 const conversationId=await record('conversation',{sequence:1,stage:'NEW',status:'OPEN',account_id:f.origin.account,contact_id:contact,assignment_id:f.origin.assignment,assignment_revision:1,binding_id:f.origin.binding,product_id:f.origin.product,offer_version_id:offer,workflow_version_id:workflow,
  started_at:new Date(now.getTime()-86400000).toISOString(),last_inbound_at:new Date(now.getTime()-60000).toISOString()});
 await admin.query("INSERT INTO operational_settings(workspace_id,environment,version,body,updated_by) VALUES($1,'REAL',1,$2,$3) ON CONFLICT(workspace_id,environment) DO UPDATE SET body=EXCLUDED.body",[workspace,{...defaultOperationalSettings,dispatch_frozen:false,real_sends_enabled:true,allow_real_operations:true},actor]);
 await admin.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,frozen,lease_expires_at) VALUES($1,$2,'f3-gate',false,clock_timestamp()+interval '10 minutes')",[f.origin.account,workspace]);
 for(const dimension of ['transport','quality'])await record('health_signal',{account_id:f.origin.account,dimension,status:'OK',availability:'supported',source:'provider_read',scope:'account',observed_at:new Date(now.getTime()-1000).toISOString(),expires_at:new Date(now.getTime()+600000).toISOString()});
 const conversation=(await getRecord(admin,workspace,'conversation',conversationId))!;
 const propose=(options:Parameters<typeof proposeEffect>[4]={},key=randomUUID())=>tx('commerce_automation',db=>withProfileQueryRouting(db,()=>proposeEffect(db,conversation,{kind:'text',text:'Synthetic continuity gate only'},key,options)));
 const gate=(value:Body)=>tx('commerce_channel',db=>withProfileQueryRouting(db,()=>gateDispatch(db,value,'f3-gate')));
 return{...f,offer,workflow,contact,conversation,propose,gate};
}

const messageFlow={name:'Durable proposal fixture',entry_node_id:'message',max_steps:10,nodes:[{id:'message',type:'message',config:{text:'Synthetic durable message'},next:'end'},{id:'end',type:'end',config:{}}]};
async function awaitGrant(f:Awaited<ReturnType<typeof commercialReady>>){
 await admin.query('UPDATE commercial_assignments SET revision=2 WHERE id=$1',[f.origin.assignment]);
 await admin.query("UPDATE records SET body=body||'{\"assignment_revision\":2}'::jsonb,version=version+1 WHERE id=$1",[f.conversation.id]);
 const conversation=(await getRecord(admin,workspace,'conversation',f.conversation.id))!;
 return{...f,conversation,issue:()=>human((db,p)=>store.issueCommercialContinuity(db,'REAL',{operationId:randomUUID(),assignmentId:f.origin.assignment,expectedRevision:2},p.authority))};
}
async function clearWorkerCandidates(){await admin.query("UPDATE records SET body=body||'{\"historical_only\":true,\"ai_pending\":false}'::jsonb,version=version+1 WHERE workspace_id=$1 AND kind='conversation'",[workspace]);}
const work=<T>(fn:(db:ProfileExecutor)=>Promise<T>,environment:'REAL'|'SIMULATION'='REAL')=>tx('commerce_automation',db=>withProfileQueryRouting(db,()=>fn(db)),workspace,environment);
const effects=async(id:string)=>(await admin.query('SELECT * FROM outbox WHERE conversation_id=$1 ORDER BY dispatch_sequence',[id])).rows;
const conversation=async(id:string)=>(await getRecord(admin,workspace,'conversation',id))!;
const runFor=async(id:string)=>(await admin.query("SELECT * FROM records WHERE workspace_id=$1 AND kind='ai_run' AND body->>'conversation_id'=$2 ORDER BY created_at",[workspace,id])).rows;
async function prepareAgent(f:Awaited<ReturnType<typeof commercialReady>>){
 const agent=await record('agent',{status:'PUBLISHED',provider:'deterministic',model:'durable-fixture'});
 await admin.query("UPDATE records SET body=body||$2::jsonb,version=version+1 WHERE id=$1",[f.conversation.id,{agent_version_id:agent,ai_pending:true,last_customer_text:'Información de la oferta'}]);
}
function providerCounter(){let calls=0;const provider:SalesAiProvider={async propose(_config,raw){calls++;const context=raw as SellerContext;return{proposal:{reply:'Respuesta sintética basada en la oferta.',intent:'question',confidence:1,tool:'none',grounding:[context.sources[0]!.id]},usage:{input_tokens:7,output_tokens:11,cost_minor:3},provider:'deterministic',model:'durable-fixture'};},async receipt(){throw Error('UNUSED');}};return{provider,calls:()=>calls};}

// V7 F2: cases admit their own REAL numbers; earlier cases' reservations are
// retired (test-only) so the installation stays within 20 connected numbers.
beforeEach(()=>releaseFixtureNumbers(admin));
describe('F3 continuity persistence, real restricted PostgreSQL and synthetic source facts',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:6,connectionTimeoutMillis:5000});
  await requireMigratedProfileSchema(admin);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic F3','UTC',14,100,100),($2,'Synthetic foreign','UTC',6,100,100)",[workspace,foreign]);await sealFixtureProfiles(admin,workspace,foreign);// V7 F2: 20 numbers per installation
  await admin.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$1||\'@example.invalid\',true)',[actor]);
  await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[actor,workspace]);
  session={id:randomUUID(),userId:actor};await admin.query('INSERT INTO session(id,"userId",token,"expiresAt") VALUES($1,$2,$1,clock_timestamp()+interval \'1 hour\')',[session.id,actor]);
  for(const role of roles){
   const login='f3_'+role.slice(9)+'_'+suffix,password=randomBytes(32).toString('hex');logins.push(login);
   await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT ${role} TO "${login}"`);
   const native=new URL(url);native.username=login;native.password=password;const pool=new pg.Pool({connectionString:native.toString(),max:5,connectionTimeoutMillis:5000});pools.set(role,pool);
   scoped.set(role,{async connect(){const c=await pool.connect();try{await c.query('SET ROLE '+role);return{query:c.query.bind(c),release:()=>c.release()};}catch(e){c.release();throw e;}}});
  }
  await selectFixtureSession({connect:async()=>{const c=await scoped.get('commerce_api')!.connect();return c as any;}},session,workspace,0);
 },60000);
 afterAll(async()=>{await app?.close();vi.unstubAllEnvs();for(const pool of pools.values())await pool.end();if(admin){try{for(const login of logins)await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}});
 it('SQL state validator rejects absent, null, extra and malformed fields without throwing',async()=>{
  const source={kind:'COMMERCIAL_ASSIGNMENT',assignmentId:randomUUID(),assignmentRevision:1,bindingId:randomUUID()};
  const state={id:randomUUID(),workspaceId:workspace,environment:'REAL',accountId:randomUUID(),source,createdBy:actor,
   createdAt:'2026-10-12T00:00:00.000Z',version:1,humanPaused:false,revokedAt:null,protections:[]};
  const protection={reason:'CHANNEL_DOWN',incidentId:randomUUID(),observedAt:'2026-10-12T00:01:00.000Z',evidenceSha256:'a'.repeat(64)};
  const invalid:unknown[]=[null,[],{}, {...state,extra:true}];
  for(const field of Object.keys(state)){
   const missing:Record<string,unknown>={...state};delete missing[field];invalid.push(missing);
   if(field!=='revokedAt')invalid.push({...state,[field]:null});
  }
  for(const createdAt of ['not-a-date','2026-02-30T00:00:00Z','2026-13-12T00:00:00Z','2026-10-12','infinity'])invalid.push({...state,createdAt});
  for(const version of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'1',true])invalid.push({...state,version});
  invalid.push({...state,revokedAt:'2026-10-11T23:59:59Z'}, {...state,revokedAt:'bad'},
   {...state,source:{...source,extra:true}}, {...state,source:{...source,assignmentRevision:1.5}},
   {...state,source:{...source,assignmentRevision:Number.MAX_SAFE_INTEGER+1}},
   {...state,protections:[protection,protection]}, {...state,protections:[{...protection,extra:true}]},
   {...state,protections:[{...protection,observedAt:'2026-02-30T00:00:00Z'}]},
   {...state,protections:[{...protection,observedAt:'2026-10-11T23:59:59Z'}]},
   {...state,protections:[{...protection,evidenceSha256:null}]}, {...state,protections:[{...protection,reason:'UNRECOGNIZED'}]});
  const valid=[state,{...state,version:Number.MAX_SAFE_INTEGER},{...state,protections:[protection]},
   {...state,source:{kind:'VERIFIED_QR_CONNECTION',connectionId:randomUUID(),identityFingerprint:'a'.repeat(64)}}];
  const outcomes=await tx('commerce_api',db=>db.query('SELECT valid_continuous_state(value) AS valid FROM jsonb_array_elements($1::jsonb)',[JSON.stringify([...valid,...invalid])]));
  expect(outcomes.rows.map(row=>row.valid)).toEqual([...valid.map(()=>true),...invalid.map(()=>false)]);
 });
 it('connection reconciler discovers verified sources dynamically, skips other profiles and never revives revoked origins',async()=>{
  const first=await qr(),other=await qr(undefined,foreign);
  const run=()=>reconcileContinuousConnections(scoped.get('commerce_channel')!,workspace,'REAL',20);
  expect(await run()).toEqual({observed:1,registered:1,deferred:0,failures:[],externalEffects:0});
  expect(await run()).toEqual({observed:0,registered:0,deferred:0,failures:[],externalEffects:0});
  const state=(await admin.query('SELECT state FROM continuous_authorizations WHERE qr_command_id=$1',[first.connectionId])).rows[0].state as ContinuousAuthorization;
  const revoked=await humanCommand(state,'revoke');expect(await run()).toEqual({observed:0,registered:0,deferred:0,failures:[],externalEffects:0});expect(await saved(state.id)).toEqual(revoked);
  const hot=await qr();expect(await run()).toEqual({observed:1,registered:1,deferred:0,failures:[],externalEffects:0});
  expect((await admin.query('SELECT qr_command_id FROM continuous_authorizations WHERE qr_command_id=ANY($1)',[[hot.connectionId,other.connectionId]])).rows).toEqual([{qr_command_id:hot.connectionId}]);
 });
 it('connection reconciler rejects non-channel roles and excludes stale or unapplied source observations',async()=>{
  for(const role of ['commerce_api','commerce_automation']as const)await expect(reconcileContinuousConnections(scoped.get(role)!,workspace,'REAL',20)).rejects.toThrow('CONTINUITY_INTERNAL_ROLE_REQUIRED');
  const pending=await qr(),expired=await qr();
  await admin.query("UPDATE commands SET status='PENDING' WHERE id=$1",[pending.connectionId]);
  await admin.query("UPDATE channel_sessions SET health_expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1",[expired.accountId]);
  expect(await reconcileContinuousConnections(scoped.get('commerce_channel')!,workspace,'REAL',20)).toEqual({observed:0,registered:0,deferred:0,failures:[],externalEffects:0});
  expect((await admin.query('SELECT id FROM continuous_authorizations WHERE qr_command_id=ANY($1)',[[pending.connectionId,expired.connectionId]])).rows).toEqual([]);
 });
 it('uses restricted roles and FORCE RLS without leaking the pooled workspace',async()=>{
  await issue();
  for(const role of roles){
   const value=await tx(role,async db=>({role:(await db.query('SELECT current_user AS role')).rows[0].role,flags:(await db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]}));
   expect(value).toEqual({role,flags:{rolsuper:false,rolbypassrls:false}});
   expect((await pools.get(role)!.query('SELECT state FROM continuous_authorizations')).rows).toEqual([]);
   expect((await tx(role,db=>db.query('SELECT state FROM continuous_authorizations'),foreign)).rows).toEqual([]);
  }
  for(const table of ['continuous_authorizations','continuous_authorization_events','continuous_authorization_operations'])expect((await admin.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',[table])).rows[0]).toEqual({relrowsecurity:true,relforcerowsecurity:true});
 });
 it('commits one grant, event and operation; replay does not issue or revive another grant',async()=>{
  const f=await issue();expect(await count('continuous_authorization_events',f.state.id)).toBe(1);
  const replay=await human((db,p)=>store.issueCommercialContinuity(db,'REAL',{operationId:f.operationId,assignmentId:f.origin.assignment,expectedRevision:1},p.authority));expect(replay).toEqual(f.state);
  expect(await count('continuous_authorizations',f.state.id)).toBe(1);expect(await count('continuous_authorization_events',f.state.id)).toBe(1);
  await expect(human((db,p)=>store.issueCommercialContinuity(db,'REAL',{operationId:f.operationId,assignmentId:f.origin.assignment,expectedRevision:2},p.authority))).rejects.toThrow('CONTINUITY_OPERATION_CONFLICT');
 });
 it('rejects wrong assignment revision, environment and foreign profile before grant creation',async()=>{
  const f=await commercial(),other=await commercial(foreign),simulation=await commercial(workspace,'SIMULATION');
  for(const [assignmentId,expectedRevision]of [[f.assignment,2],[other.assignment,1],[simulation.assignment,1]]as const)await expect(human((db,p)=>store.issueCommercialContinuity(db,'REAL',{operationId:randomUUID(),assignmentId,expectedRevision},p.authority))).rejects.toThrow();
  expect((await admin.query('SELECT id FROM continuous_authorizations WHERE assignment_id=ANY($1)',[[f.assignment,other.assignment,simulation.assignment]])).rows).toHaveLength(0);
 });
 it('human role cannot manufacture internal protection and worker roles cannot change human pause or revoke',async()=>{
  const {state}=await issue();
  await expect(rawUpdate('commerce_api',state,{protections:[{reason:'CHANNEL_DOWN',incidentId:randomUUID(),observedAt:new Date().toISOString(),evidenceSha256:'a'.repeat(64)}]})).rejects.toThrow('CONTINUITY_INTERNAL_PROTECTION_REQUIRED');
  for(const role of ['commerce_channel','commerce_automation']as const)for(const patch of [{humanPaused:true},{revokedAt:new Date().toISOString()}])await expect(rawUpdate(role,state,patch)).rejects.toThrow('CONTINUITY_HUMAN_COMMAND_REQUIRED');
  expect(await saved(state.id)).toEqual(state);
 });
 it('missing event makes COMMIT fail and rolls back the state revision',async()=>{
  const {state}=await issue();await expect(rawUpdate('commerce_api',state,{humanPaused:true})).rejects.toThrow('CONTINUITY_ATOMIC_EVENT_REQUIRED');expect(await saved(state.id)).toEqual(state);
 });
 it('event write failure rolls back state and durable operation together',async()=>{
  const {state}=await issue(),operationId=randomUUID();
  await admin.query("CREATE FUNCTION f3_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_EVENT_FAILURE'; END $$;CREATE TRIGGER f3_fail_event BEFORE INSERT ON continuous_authorization_events FOR EACH ROW EXECUTE FUNCTION f3_fail_event()");
  try{await expect(human((db,p)=>store.applyContinuousHumanCommand(db,'REAL',state.id,'COMMERCIAL_ASSIGNMENT',{operationId,expectedVersion:1,action:'pause'},p.authority))).rejects.toThrow('SYNTHETIC_EVENT_FAILURE');expect(await saved(state.id)).toEqual(state);expect((await admin.query('SELECT operation_id FROM continuous_authorization_operations WHERE operation_id=$1',[operationId])).rows).toHaveLength(0);}finally{await admin.query('DROP TRIGGER f3_fail_event ON continuous_authorization_events;DROP FUNCTION f3_fail_event()');}
 });
 it('CAS admits one competing human change; stale command cannot overwrite its event',async()=>{
  const {state}=await issue();const results=await Promise.allSettled(['pause','revoke'].map(action=>human((db,p)=>store.applyContinuousHumanCommand(db,'REAL',state.id,'COMMERCIAL_ASSIGNMENT',{operationId:randomUUID(),expectedVersion:1,action},p.authority))));
  expect(results.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect(results.filter(v=>v.status==='rejected')).toHaveLength(1);expect((await saved(state.id))?.version).toBe(2);expect(await count('continuous_authorization_events',state.id)).toBe(2);
 });
 it('worker protection remains after human resume and uncertainty needs exact reconciliation',async()=>{
  const {state}=await issue(),incidentId=randomUUID();
  const held=await tx('commerce_channel',async db=>store.applyContinuousProtection(db,'REAL',state.id,'assert',{operationId:randomUUID(),expectedVersion:1,reason:'SEND_UNCERTAIN',incidentId,observedAt:(await db.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString(),evidenceSha256:'a'.repeat(64)}));
  const paused=await human((db,p)=>store.applyContinuousHumanCommand(db,'REAL',state.id,'COMMERCIAL_ASSIGNMENT',{operationId:randomUUID(),expectedVersion:held.version,action:'pause'},p.authority));
  const resumed=await human((db,p)=>store.applyContinuousHumanCommand(db,'REAL',state.id,'COMMERCIAL_ASSIGNMENT',{operationId:randomUUID(),expectedVersion:paused.version,action:'resume'},p.authority));expect(resumed.protections).toEqual(held.protections);
  await expect(tx('commerce_channel',async db=>store.applyContinuousProtection(db,'REAL',state.id,'clear',{operationId:randomUUID(),expectedVersion:resumed.version,reason:'SEND_UNCERTAIN',incidentId,observedAt:(await db.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString(),evidenceSha256:'b'.repeat(64),recovery:'HEALTH_OBSERVED'}))).rejects.toThrow('CONTINUITY_EFFECT_RECONCILIATION_REQUIRED');
  expect((await saved(state.id))?.protections).toEqual(held.protections);
 });
 it('permanent revocation survives new operation and a repeated source adoption',async()=>{
  const f=await issue();const revoked=await human((db,p)=>store.applyContinuousHumanCommand(db,'REAL',f.state.id,'COMMERCIAL_ASSIGNMENT',{operationId:randomUUID(),expectedVersion:1,action:'revoke'},p.authority));
  await expect(human((db,p)=>store.applyContinuousHumanCommand(db,'REAL',f.state.id,'COMMERCIAL_ASSIGNMENT',{operationId:randomUUID(),expectedVersion:2,action:'resume'},p.authority))).rejects.toThrow('CONTINUITY_REVOKED');
  expect(await human((db,p)=>store.issueCommercialContinuity(db,'REAL',{operationId:randomUUID(),assignmentId:f.origin.assignment,expectedRevision:1},p.authority))).toEqual(revoked);
 });
 it('session suspension revalidation rejects issuance and leaves no operation',async()=>{
  const f=await commercial(),operationId=randomUUID();await asProfileOwner(admin,workspace,c=>c.query("UPDATE profiles SET state='SUSPENDED' WHERE id=$1",[workspace]));
  try{await expect(human((db,p)=>store.issueCommercialContinuity(db,'REAL',{operationId,assignmentId:f.assignment,expectedRevision:1},p.authority))).rejects.toThrow('PROFILE_SUSPENDED');expect((await admin.query('SELECT operation_id FROM continuous_authorization_operations WHERE operation_id=$1',[operationId])).rows).toHaveLength(0);}finally{await asProfileOwner(admin,workspace,c=>c.query("UPDATE profiles SET state='ACTIVE' WHERE id=$1",[workspace]));}
 });
 it('QR-origin issue uses channel role and database creator; wrong fingerprint or revision fails',async()=>{
  const f=await qr();await expect(tx('commerce_api',db=>store.issueVerifiedQrContinuity(db,'REAL',f))).rejects.toThrow('CONTINUITY_INTERNAL_ROLE_REQUIRED');
  for(const change of [{identityFingerprint:'b'.repeat(64)},{expectedSessionRevision:f.expectedSessionRevision+1}])await expect(tx('commerce_channel',db=>store.issueVerifiedQrContinuity(db,'REAL',{...f,...change,operationId:randomUUID()}))).rejects.toThrow('CONTINUITY_CONNECTION_CHANGED');
  const issued=await tx('commerce_channel',db=>store.issueVerifiedQrContinuity(db,'REAL',f));expect(issued.createdBy).toBe(actor);expect(issued.accountId).toBe(f.accountId);expect(issued.source).toEqual({kind:'VERIFIED_QR_CONNECTION',connectionId:f.connectionId,identityFingerprint:f.identityFingerprint});
 });
 it('unapplied connect or expired synthetic health cannot become permanent QR-origin permission',async()=>{
  for(const mutation of ["UPDATE commands SET status='PENDING' WHERE id=$1","UPDATE channel_sessions SET health_expires_at=clock_timestamp()-interval '1 second' WHERE account_id=(SELECT resource_id::uuid FROM commands WHERE id=$1)"]){const f=await qr();await admin.query(mutation,[f.connectionId]);await expect(tx('commerce_channel',db=>store.issueVerifiedQrContinuity(db,'REAL',f))).rejects.toThrow('CONTINUITY_VERIFIED_CONNECTION_REQUIRED');expect((await admin.query('SELECT id FROM continuous_authorizations WHERE qr_command_id=$1',[f.connectionId])).rows).toHaveLength(0);}
 });
 it('human QR pause survives revoking the last grant and reconnecting without reviving old state',async()=>{
  const q=await qr(),first=await tx('commerce_channel',db=>store.issueVerifiedQrContinuity(db,'REAL',q));
  const paused=await humanCommand(first,'pause'),revoked=await humanCommand(paused,'revoke');
  const fresh=await qr(q.accountId),second=await tx('commerce_channel',db=>store.issueVerifiedQrContinuity(db,'REAL',fresh));
  expect(second.id).not.toBe(first.id);expect(second.humanPaused).toBe(true);expect(second.revokedAt).toBeNull();expect(await saved(first.id)).toEqual(revoked);
  const resumed=await humanCommand(second,'resume');expect(resumed.humanPaused).toBe(false);
  const again=await qr(q.accountId),third=await tx('commerce_channel',db=>store.issueVerifiedQrContinuity(db,'REAL',again));
  expect(third.humanPaused).toBe(false);expect(await saved(first.id)).toEqual(revoked);
 });
 it('new assignment revision inherits pause but another product, purpose, profile and environment do not',async()=>{
  const f=await issue();await humanCommand(f.state,'pause');const next=await nextCommercial(f);expect(next.humanPaused).toBe(true);
  const other=await commercial(workspace,'REAL',f.origin.account),otherGrant=await human((db,p)=>store.issueCommercialContinuity(db,'REAL',{operationId:randomUUID(),assignmentId:other.assignment,expectedRevision:1},p.authority));expect(otherGrant.humanPaused).toBe(false);
  const q=await qr(f.origin.account),warmup=await tx('commerce_channel',db=>store.issueVerifiedQrContinuity(db,'REAL',q));expect(warmup.humanPaused).toBe(false);
  const readPause=(scope:string,environment:string)=>tx('commerce_channel',db=>db.query('SELECT continuous_human_pause($1,$2,$3,$4) AS paused',[scope,environment,f.origin.account,next.source]),scope);
  expect((await readPause(foreign,'REAL')).rows[0].paused).toBe(false);expect((await readPause(workspace,'SIMULATION')).rows[0].paused).toBe(false);expect((await readPause(workspace,'REAL')).rows[0].paused).toBe(true);
 });
 it('resume changes all live origins in one group, preserves each protection and replays no events',async()=>{
  const f=await issue();const held=await tx('commerce_channel',async db=>store.applyContinuousProtection(db,'REAL',f.state.id,'assert',{operationId:randomUUID(),expectedVersion:1,reason:'CHANNEL_DOWN',incidentId:randomUUID(),observedAt:(await db.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString(),evidenceSha256:'a'.repeat(64)}));
  const first=await humanCommand(held,'pause'),second=await nextCommercial(f),operationId=randomUUID();
  const resumed=await humanCommand(second,'resume',operationId),one=(await saved(first.id))!;
  expect(one.version).toBe(first.version+1);expect(one.humanPaused).toBe(false);expect(one.protections).toEqual(held.protections);expect(resumed.humanPaused).toBe(false);expect(resumed.protections).toEqual([]);
  const counts=[await count('continuous_authorization_events',first.id),await count('continuous_authorization_events',second.id)];
  expect(await humanCommand(second,'resume',operationId)).toEqual(resumed);expect(await saved(first.id)).toEqual(one);expect([await count('continuous_authorization_events',first.id),await count('continuous_authorization_events',second.id)]).toEqual(counts);
 });
 it('worker cannot forge a human event or choose sequence; API cannot forge a worker event',async()=>{
  const {state}=await issue(),insert='INSERT INTO continuous_authorization_events(workspace_id,environment,authorization_id,version,operation_id,event,state) VALUES($1,$2,$3,$4,$5,$6,$7)';
  for(const role of ['commerce_channel','commerce_automation']as const)await expect(tx(role,db=>db.query(insert,[workspace,'REAL',state.id,state.version,randomUUID(),{type:'HUMAN_RESUMED'},state]))).rejects.toThrow('CONTINUITY_HUMAN_EVENT_REQUIRED');
  await expect(tx('commerce_api',db=>db.query(insert,[workspace,'REAL',state.id,state.version,randomUUID(),{type:'PROTECTION_ASSERTED'},state]))).rejects.toThrow('CONTINUITY_WORKER_EVENT_REQUIRED');
  for(const role of roles){
   await expect(tx(role,db=>db.query('INSERT INTO continuous_authorization_events(event_sequence,workspace_id,environment,authorization_id,version,operation_id,event,state) OVERRIDING SYSTEM VALUE VALUES(999999,$1,$2,$3,$4,$5,$6,$7)',[workspace,'REAL',state.id,state.version,randomUUID(),{type:'HUMAN_RESUMED'},state]))).rejects.toThrow(/permission denied/);
   await expect(tx(role,db=>db.query("SELECT setval('continuous_authorization_events_event_sequence_seq',1,false)"))).rejects.toThrow(/permission denied/);
  }
  expect(await saved(state.id)).toEqual(state);
 });
 it('all group states roll back if one propagated event cannot be recorded',async()=>{
  const f=await issue(),second=await nextCommercial(f),operationId=randomUUID();
  await admin.query(`CREATE FUNCTION f3_fail_propagated() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.authorization_id='${second.id}'::uuid AND NEW.version>1 THEN RAISE EXCEPTION 'SYNTHETIC_PROPAGATED_EVENT_FAILURE';END IF;RETURN NEW;END $$;CREATE TRIGGER f3_fail_propagated BEFORE INSERT ON continuous_authorization_events FOR EACH ROW EXECUTE FUNCTION f3_fail_propagated()`);
  try{await expect(humanCommand(f.state,'pause',operationId)).rejects.toThrow('SYNTHETIC_PROPAGATED_EVENT_FAILURE');expect(await saved(f.state.id)).toEqual(f.state);expect(await saved(second.id)).toEqual(second);expect((await admin.query('SELECT operation_id FROM continuous_authorization_operations WHERE operation_id=$1',[operationId])).rows).toHaveLength(0);}finally{await admin.query('DROP TRIGGER f3_fail_propagated ON continuous_authorization_events;DROP FUNCTION f3_fail_propagated()');}
 });
 it('group lock fences competing issue and direct SQL before a human pause commits',async()=>{
  const f=await issue();await admin.query('UPDATE commercial_assignments SET revision=2 WHERE id=$1',[f.origin.assignment]);
  const owner=await scoped.get('commerce_api')!.connect();
  try{
   await owner.query('BEGIN');await owner.query("SELECT set_config('app.workspace_id',$1,true)",[workspace]);await owner.query('SELECT lock_continuous_human_scope($1,$2,$3,$4)',[workspace,'REAL',f.origin.account,f.state.source]);
   await expect(human((db,p)=>store.issueCommercialContinuity(db,'REAL',{operationId:randomUUID(),assignmentId:f.origin.assignment,expectedRevision:2},p.authority))).rejects.toThrow('CONTINUITY_SCOPE_BUSY');
   await expect(rawUpdate('commerce_api',f.state,{humanPaused:true})).rejects.toThrow('CONTINUITY_SCOPE_BUSY');
   await owner.query('ROLLBACK');
  }finally{await owner.query('ROLLBACK');owner.release();}
  const paused=await humanCommand(f.state,'pause');expect(paused.humanPaused).toBe(true);
  const next=await human((db,p)=>store.issueCommercialContinuity(db,'REAL',{operationId:randomUUID(),assignmentId:f.origin.assignment,expectedRevision:2},p.authority));expect(next.humanPaused).toBe(true);
 });
 it('effect authority read returns the exact paused/protected commercial or QR state, never emission permission',async()=>{
  const f=await issue(),held=await tx('commerce_channel',async db=>store.applyContinuousProtection(db,'REAL',f.state.id,'assert',{operationId:randomUUID(),expectedVersion:1,reason:'CHANNEL_DOWN',incidentId:randomUUID(),observedAt:(await db.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString(),evidenceSha256:'a'.repeat(64)}));
  const paused=await humanCommand(held,'pause'),id=await effect(paused);
  expect(await tx('commerce_channel',db=>readContinuousEffectAuthority(db,'REAL',id))).toEqual({state:'AUTHORITY_READ',authorization:paused});
  const q=await qr(),grant=await tx('commerce_channel',db=>store.issueVerifiedQrContinuity(db,'REAL',q)),warmup=await warmupEffect(grant);
  expect(await tx('commerce_channel',db=>readContinuousEffectAuthority(db,'REAL',warmup))).toEqual({state:'AUTHORITY_READ',authorization:grant});
  expect((await admin.query('SELECT status,attempts,provider_message_id FROM outbox WHERE id=ANY($1)',[[id,warmup]])).rows).toEqual([{status:'READY',attempts:0,provider_message_id:null},{status:'READY',attempts:0,provider_message_id:null}]);
 });
 it('effect insertion rejects account, profile, environment and purpose drift without weakening legacy warmup guards',async()=>{
  const {state}=await issue();
  for(const patch of [{account:randomUUID()},{scope:foreign},{environment:'SIMULATION'},{kind:'warmup'}])await expect(effect(state,patch)).rejects.toThrow('CONTINUITY_EFFECT_SCOPE_CHANGED');
  const q=await qr(),grant=await tx('commerce_channel',db=>store.issueVerifiedQrContinuity(db,'REAL',q));
  await expect(effect(grant)).rejects.toThrow('CONTINUITY_EFFECT_SCOPE_CHANGED');
  await expect(effect(grant,{kind:'warmup'})).rejects.toThrow('WARMUP_EFFECT_SCOPE_INVALID');
  expect((await admin.query('SELECT id FROM outbox WHERE continuous_authorization_id=ANY($1)',[[state.id,grant.id]])).rows).toHaveLength(0);
 });
 it('effect has one immutable authority and cannot remap an old unbound effect after insertion',async()=>{
  const f=await issue(),other=await nextCommercial(f);
  await expect(effect(f.state,{authorization:randomUUID()})).rejects.toThrow('continuous_outbox_single_authority');
  const id=await effect(f.state),legacy=await effect(null,{account:f.state.accountId});
  for(const target of [null,other.id])await expect(tx('commerce_automation',db=>db.query('UPDATE outbox SET continuous_authorization_id=$2 WHERE id=$1',[id,target]))).rejects.toThrow('CONTINUITY_EFFECT_AUTHORITY_IMMUTABLE');
  await expect(tx('commerce_automation',db=>db.query('UPDATE outbox SET continuous_authorization_id=$2 WHERE id=$1',[legacy,f.state.id]))).rejects.toThrow('CONTINUITY_EFFECT_AUTHORITY_IMMUTABLE');
  await expect(tx('commerce_channel',db=>readContinuousEffectAuthority(db,'REAL',legacy))).rejects.toThrow('CONTINUITY_EFFECT_AUTHORITY_REQUIRED');
  expect((await admin.query('SELECT continuous_authorization_id FROM outbox WHERE id=$1',[id])).rows[0].continuous_authorization_id).toBe(f.state.id);
 });
 it('effect read is restricted to channel and exact profile/environment with expiry measured by PostgreSQL',async()=>{
  const {state}=await issue(),id=await effect(state),expired=await effect(state,{expired:true});
  for(const role of ['commerce_api','commerce_automation']as const)await expect(tx(role,db=>readContinuousEffectAuthority(db,'REAL',id))).rejects.toThrow('CONTINUITY_EMITTER_ROLE_REQUIRED');
  await expect(tx('commerce_channel',db=>readContinuousEffectAuthority(db,'REAL',id),foreign)).rejects.toThrow('CONTINUITY_EFFECT_NOT_FOUND');
  await expect(tx('commerce_channel',db=>readContinuousEffectAuthority(db,'SIMULATION',id))).rejects.toThrow('CONTINUITY_EFFECT_NOT_FOUND');
  expect(await tx('commerce_channel',db=>readContinuousEffectAuthority(db,'REAL',expired))).toEqual({state:'EXPIRED',reason:'EFFECT_EXPIRED'});
 });
 it('revocation prevents a new effect and remains visible when an old pending effect is read',async()=>{
  const {state}=await issue(),id=await effect(state),revoked=await humanCommand(state,'revoke');
  await expect(effect(revoked)).rejects.toThrow('CONTINUITY_REVOKED');
  expect(await tx('commerce_channel',db=>readContinuousEffectAuthority(db,'REAL',id))).toEqual({state:'AUTHORITY_READ',authorization:revoked});
 });
 it('effect read holds its row and authorization until the caller transaction releases them',async()=>{
  const {state}=await issue(),id=await effect(state),owner=await scoped.get('commerce_channel')!.connect();
  try{
   await owner.query('BEGIN');await owner.query("SELECT set_config('app.workspace_id',$1,true)",[workspace]);
   expect((await readContinuousEffectAuthority({workspaceId:workspace,query:owner.query.bind(owner)},'REAL',id)).state).toBe('AUTHORITY_READ');
   await expect(tx('commerce_channel',async db=>{await db.query("SET LOCAL lock_timeout='50ms'");return db.query("UPDATE outbox SET status='BLOCKED' WHERE id=$1",[id]);})).rejects.toThrow(/lock timeout/);
   await expect(tx('commerce_api',async db=>{await db.query("SET LOCAL lock_timeout='50ms'");return db.query('SELECT id FROM continuous_authorizations WHERE id=$1 FOR UPDATE',[state.id]);})).rejects.toThrow(/lock timeout/);
  }finally{await owner.query('ROLLBACK');owner.release();}
 });
 it('native signed-cookie HTTP commits before response and protects scope, origin and operation receipt',async()=>{
  await startHttp();const source=await commercial(),operationId=randomUUID(),headers={cookie,'x-commerce-profile-id':workspace,'x-commerce-profile-version':'1'};
  const issueResponse=await httpRequest('/v2/continuity/commercial',headers,{operationId,assignmentId:source.assignment.toUpperCase(),expectedRevision:1});expect(issueResponse.status).toBe(200);
  const issued=(await issueResponse.json()).data as ContinuousAuthorization;expect(await saved(issued.id)).toEqual(issued);expect(await count('continuous_authorization_events',issued.id)).toBe(1);
  expect((await httpRequest('/v2/continuity/commercial/'+issued.id,headers)).status).toBe(200);
  expect((await(await httpRequest('/v2/continuity/commercial/operations/'+operationId,headers)).json()).data).toEqual(issued);
  expect((await httpRequest('/v2/continuity/warmup/'+issued.id,headers)).status).toBe(404);
  expect((await httpRequest('/v2/continuity/warmup/operations/'+operationId,headers)).status).toBe(404);
  expect((await httpRequest('/v2/continuity/warmup',headers)).status).toBe(200);
  expect((await httpRequest('/v2/continuity/warmup',headers,{})).status).toBe(404);
  expect((await httpRequest('/v2/continuity/commercial/'+issued.id+'/commands',{...headers,origin:'https://foreign.invalid'},{operationId:randomUUID(),expectedVersion:1,action:'pause'})).status).toBe(403);
  expect((await httpRequest('/v2/continuity/commercial',{...headers,'x-commerce-profile-id':foreign})).status).toBe(409);
  expect((await httpRequest('/v2/continuity/commercial',headers,{operationId:randomUUID(),assignmentId:source.assignment,expectedRevision:1,workspaceId:foreign})).status).toBe(400);
 });
 it('shared client and MCP reach native HTTP/PG while a fixed PAT cannot select another profile or purpose',async()=>{
  await startHttp();const source=await commercial(),operationId=randomUUID();
  const browserFetch:typeof fetch=(url,init)=>fetch(address+url,{...init,headers:{...init?.headers,origin,cookie}});
  const client=sessionContinuity({workspaceId:workspace,version:1},browserFetch);
  const created=await client({operation:'issue',purpose:'commercial',assignmentId:source.assignment,expectedRevision:1,operationId});const issued=created.data[0]!;
  const token=await personal(['assignments:read','assignments:write']);const server=createProfileMcp(address,token.token);
  const sdk=new Client({name:'native-f3-continuity',version:'1'}),[ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await sdk.connect(ct);
  const call=(action:string,args:Record<string,unknown>)=>sdk.callTool({name:'number_assignments_manage',arguments:{action,...args}});
  try{
   const operation=randomUUID();const result=await call('pausar',{purpose:'commercial',id:issued.id,operationId:operation,expectedVersion:1});
   expect(result.isError).not.toBe(true);expect((await saved(issued.id))?.humanPaused).toBe(true);
   const receipt=await call('consultar_operacion',{purpose:'commercial',operationId:operation});expect(receipt.isError).not.toBe(true);
   for(const args of [{purpose:'warmup'},{purpose:'commercial',environment:'SIMULATION'},{purpose:'commercial',workspaceId:foreign}])expect((await call('autorizaciones',args)).isError).toBe(true);
   const before=await count('continuous_authorization_events',issued.id);await call('pausar',{purpose:'commercial',id:issued.id,operationId:operation,expectedVersion:1});expect(await count('continuous_authorization_events',issued.id)).toBe(before);
   await admin.query('UPDATE personal_access_tokens SET revoked_at=clock_timestamp() WHERE id=$1',[token.id]);expect((await call('autorizaciones',{purpose:'commercial'})).isError).toBe(true);
  }finally{await sdk.close();await server.close();}
 });
 it('013 exposes only the selected locked profile to exact worker roles without global profiles SELECT',async()=>{
  for(const role of ['commerce_automation','commerce_channel'] as const){
   // V7 RF-01.5: state changes are versioned (0100); compare with the native row.
   const versions=Object.fromEntries((await admin.query('SELECT id,version FROM profiles WHERE id=ANY($1)',[[workspace,foreign]])).rows.map(r=>[r.id,r.version]));
   expect(await tx(role,db=>lockedContinuousWorkerProfile(db))).toMatchObject({id:workspace,state:'ACTIVE',version:versions[workspace],timezone:'UTC'});
   expect(await tx(role,db=>lockedContinuousWorkerProfile(db),foreign)).toMatchObject({id:foreign,state:'ACTIVE',version:versions[foreign],timezone:'UTC'});
   await expect(tx(role,db=>db.query('SELECT * FROM profiles'))).rejects.toThrow(/permission denied/);
  }
  await expect(tx('commerce_api',db=>db.query('SELECT * FROM read_locked_continuous_worker_profile()'))).rejects.toThrow(/permission denied/);
  await expect(scoped.get('commerce_channel')!.connect().then(async c=>{try{return await c.query('SELECT * FROM read_locked_continuous_worker_profile()');}finally{c.release();}})).rejects.toThrow('CONTINUITY_PROFILE_CONTEXT_REQUIRED');
  await tx('commerce_channel',async db=>{await lockedContinuousWorkerProfile(db);const c=await admin.connect();try{await c.query('BEGIN');await expect(c.query('SELECT * FROM profiles WHERE id=$1 FOR UPDATE NOWAIT',[workspace])).rejects.toMatchObject({code:'55P03'});}finally{await c.query('ROLLBACK');c.release();}});
 });
 it('proposes one durable REAL effect under ALS with exact permanent authority and duplicate key no replay',async()=>{
  const f=await commercialReady(),key=randomUUID(),value=await f.propose({},key);
  expect(value).toMatchObject({continuous_authorization_id:f.state.id,authorization_id:null,approval_hash:value.config_hash});
  expect((await f.propose({},key)).id).toBe(value.id);
  expect((await admin.query('SELECT count(*)::int AS n FROM outbox WHERE workspace_id=$1 AND logical_key=$2',[workspace,key])).rows[0].n).toBe(1);
  expect((await f.gate(value)).allowed).toBe(true);
 });
 it('new REAL proposals reject absent or foreign ALS and suspended profiles while retaining paused intent',async()=>{
  const f=await commercialReady();
  // V7 F2: without ALS the producer binds the explicit conversation's own profile; it never selects another.
  expect(await tx('commerce_automation',db=>proposeEffect(db,f.conversation,{kind:'text'},randomUUID()))).toMatchObject({continuous_authorization_id:f.state.id});
  await expect(tx('commerce_automation',db=>withProfileQueryRouting(db,()=>proposeEffect(db,f.conversation,{kind:'text'},randomUUID())),foreign)).rejects.toThrow(/PROFILE_QUERY_CONTEXT_MISMATCH/);
  await asProfileOwner(admin,workspace,c=>c.query("UPDATE profiles SET state='SUSPENDED' WHERE id=$1",[workspace]));try{await expect(f.propose()).rejects.toThrow('CONTINUITY_PROFILE_SUSPENDED');}finally{await asProfileOwner(admin,workspace,c=>c.query("UPDATE profiles SET state='ACTIVE' WHERE id=$1",[workspace]));}
  await humanCommand(f.state,'pause');expect(await f.propose()).toMatchObject({status:'BLOCKED',continuous_authorization_id:f.state.id,result:{reason:'CONTINUITY_HUMAN_PAUSED'}});
 });
 it('dispatch re-reads pause, resume, protection and terminal revoke on the original immutable grant',async()=>{
  const f=await commercialReady(),value=await f.propose();expect((await f.gate(value)).allowed).toBe(true);
  const paused=await humanCommand(f.state,'pause');expect(await f.gate(value)).toMatchObject({allowed:false,reason:'CONTINUITY_HUMAN_PAUSED'});
  const resumed=await humanCommand(paused,'resume');expect((await f.gate(value)).allowed).toBe(true);
  const now=(await admin.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
  const protectedState=await tx('commerce_channel',db=>store.applyContinuousProtection(db,'REAL',resumed.id,'assert',{operationId:randomUUID(),expectedVersion:resumed.version,reason:'SEND_UNCERTAIN',incidentId:randomUUID(),observedAt:now,evidenceSha256:'e'.repeat(64)}));
  expect(await f.gate(value)).toMatchObject({allowed:false,reason:'CONTINUITY_PROTECTED'});
  await humanCommand(protectedState,'revoke');expect(await f.gate(value)).toMatchObject({allowed:false,reason:'CONTINUITY_REVOKED'});
 });
 it('continuous authority preserves native ownership, transport, suppression, inbound and frequency gates',async()=>{
  const f=await commercialReady(),value=await f.propose();
  expect((await f.gate(value)).allowed).toBe(true);
  await admin.query('UPDATE session_ownership SET frozen=true WHERE account_id=$1',[f.origin.account]);expect(await f.gate(value)).toMatchObject({reason:'OWNERSHIP_NOT_CONFIRMED'});await admin.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[f.origin.account]);
  await admin.query("UPDATE records SET version=version+1,body=body||$2::jsonb WHERE id=$1",[f.origin.account,{sending_enabled:false}]);expect(await f.gate(value)).toMatchObject({reason:'ACCOUNT_SENDING_NOT_ENABLED'});await admin.query("UPDATE records SET version=version+1,body=body||$2::jsonb WHERE id=$1",[f.origin.account,{sending_enabled:true}]);
  await admin.query("UPDATE records SET version=version+1,body=body||$2::jsonb WHERE id=$1",[f.contact,{status:"SUPPRESSED"}]);expect(await f.gate(value)).toMatchObject({reason:'CONTACT_SUPPRESSED'});await admin.query("UPDATE records SET version=version+1,body=body||$2::jsonb WHERE id=$1",[f.contact,{status:"LEAD"}]);
  await admin.query("UPDATE records SET version=version+1,body=jsonb_set(body,'{last_inbound_at}',to_jsonb((clock_timestamp()+interval '1 hour')::text)) WHERE id=$1",[f.conversation.id]);expect(await f.gate(value)).toMatchObject({reason:'CONTINUITY_INBOUND_CONSENT_REQUIRED'});
  await admin.query("UPDATE records SET version=version+1,body=jsonb_set(body,'{last_inbound_at}',to_jsonb((clock_timestamp()-interval '1 minute')::text)) WHERE id=$1",[f.conversation.id]);
  expect(await f.gate({...value,config_hash:'0'.repeat(64)})).toMatchObject({reason:'EFFECT_CONFIG_CHANGED'});
  const history=await f.propose();await tx('commerce_channel',db=>db.query("UPDATE outbox SET status='SENT',claimed_at=clock_timestamp() WHERE id=$1",[history.id]));
  await admin.query("UPDATE operational_settings SET body=jsonb_set(body,'{contact_messages_per_minute}','1') WHERE workspace_id=$1 AND environment='REAL'",[workspace]);
  expect(await f.gate(value)).toMatchObject({reason:'CONTACT_FREQUENCY_LIMIT'});
 });
 it('campaigns and historical unapproved effects cannot acquire continuous authority at dispatch',async()=>{
  const f=await commercialReady(),value=await f.propose();
  const payload={...value.payload,campaign_id:randomUUID()},config_hash=hash(stableJson({account_id:value.account_id,contact_id:value.contact_id,payload}));
  expect(await f.gate({...value,payload,config_hash,approval_hash:config_hash})).toMatchObject({reason:'CAMPAIGN_AUTHORIZATION_REQUIRED'});
  const old=await effect(null,{account:f.origin.account,conversation:f.conversation.id,contact:f.contact,payload:value.payload});
  const row=(await admin.query('SELECT * FROM outbox WHERE id=$1',[old])).rows[0];row.config_hash=hash(stableJson({account_id:row.account_id,contact_id:row.contact_id,payload:row.payload}));
  expect(await f.gate(row)).toMatchObject({reason:'AUTHORIZATION_MISSING_OR_EXPIRED'});
  expect((await admin.query('SELECT continuous_authorization_id FROM outbox WHERE id=$1',[old])).rows[0].continuous_authorization_id).toBeNull();
 });
 it('explicit valid temporal authority retains its historical gate and never substitutes continuity',async()=>{
  const f=await commercialReady(),account=(await getRecord(admin,workspace,'channel_account',f.origin.account))!,config='f'.repeat(64);
  const scope={mode:'product_assignment',channel_identity_hash:channelIdentityHash(account),assignment_id:f.origin.assignment,assignment_revision:1,binding_id:f.origin.binding,product_id:f.origin.product,
   account_ids:[f.origin.account],offer_version_ids:[f.offer],workflow_version_ids:[f.workflow],contact_ids:[f.contact],allow_automation:true,max_messages:2};
  const auth=(await admin.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,configuration_version,expires_at) VALUES($1,'REAL',$2,$3,$4,1,clock_timestamp()+interval '1 hour') RETURNING id",[workspace,actor,scope,config])).rows[0].id;
  await admin.query('UPDATE commercial_assignments SET authorization_id=$2 WHERE id=$1',[f.origin.assignment,auth]);
  const value=await f.propose({authorizationId:auth});expect(value).toMatchObject({authorization_id:auth,continuous_authorization_id:null,approval_hash:value.config_hash});expect((await f.gate(value)).allowed).toBe(true);
  await admin.query("UPDATE operation_authorizations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[auth]);expect(await f.gate(value)).toMatchObject({reason:'AUTHORIZATION_MISSING_OR_EXPIRED'});
 });
 it('commercial reader requires the exact live product/revision/binding and never substitutes another source',async()=>{
  const f=await commercialReady(),origin={assignmentId:f.origin.assignment,assignmentRevision:1,bindingId:f.origin.binding,accountId:f.origin.account,productId:f.origin.product};
  const read=(change:object={})=>tx('commerce_automation',db=>readCommercialContinuity(db,'REAL',{...origin,...change}));
  expect(await read()).toMatchObject({id:f.state.id});
  for(const change of [{productId:randomUUID()},{assignmentRevision:2},{bindingId:randomUUID()},{accountId:randomUUID()}])expect(await read(change)).toBeUndefined();
  await admin.query("UPDATE commercial_assignments SET state='RETIRED' WHERE id=$1",[f.origin.assignment]);expect(await read()).toBeUndefined();
 });

 it('current QR query returns exactly one origin and locks session plus grant with restricted workers',async()=>{
  const q=await qr(),state=await tx('commerce_channel',db=>store.issueVerifiedQrContinuity(db,'REAL',q));
  for(const role of ['commerce_channel','commerce_automation']as const){
   expect(await tx(role,db=>readCurrentQrContinuity(db,'REAL',q.accountId))).toEqual(state);
   await expect(tx(role,db=>db.query('SELECT * FROM profiles'))).rejects.toThrow(/permission denied/);
  }
  await tx('commerce_channel',async db=>{
   expect(await readCurrentQrContinuity(db,'REAL',q.accountId)).toEqual(state);
   for(const [table,column,value]of [['channel_sessions','account_id',q.accountId],['continuous_authorizations','id',state.id]]){
    const c=await admin.connect();try{await c.query('BEGIN');await expect(c.query(`SELECT * FROM ${table} WHERE ${column}=$1 FOR UPDATE NOWAIT`,[value])).rejects.toMatchObject({code:'55P03'});}finally{await c.query('ROLLBACK');c.release();}
   }
  });
  await expect(tx('commerce_api',db=>readCurrentQrContinuity(db,'REAL',q.accountId))).rejects.toThrow('CONTINUITY_WORKER_CONTEXT_REQUIRED');
 });
 it('latest revoked QR is returned as revoked and never falls back to the prior live origin',async()=>{
  const first=await qr(),old=await tx('commerce_channel',db=>store.issueVerifiedQrContinuity(db,'REAL',first));
  const latest=await qr(first.accountId),current=await tx('commerce_channel',db=>store.issueVerifiedQrContinuity(db,'REAL',latest));
  const revoked=await humanCommand(current,'revoke');
  const read=await tx('commerce_channel',db=>readCurrentQrContinuity(db,'REAL',first.accountId));
  expect(read).toEqual(revoked);expect((await saved(old.id))?.revokedAt).toBeNull();
  expect(continuousWarmupAuthorityBlock(read!,old,{workspaceId:workspace,environment:'REAL',senderId:first.accountId,peerId:old.accountId})).toBe('CONTINUITY_REVOKED');
 });
 it('new applied command without its own grant makes the old QR source stale until exact registration',async()=>{
  const first=await qr(),old=await tx('commerce_channel',db=>store.issueVerifiedQrContinuity(db,'REAL',first));
  const latest=await qr(first.accountId);
  expect(await tx('commerce_channel',db=>readCurrentQrContinuity(db,'REAL',first.accountId))).toBeUndefined();
  const current=await tx('commerce_channel',db=>store.issueVerifiedQrContinuity(db,'REAL',latest));
  expect(await tx('commerce_channel',db=>readCurrentQrContinuity(db,'REAL',first.accountId))).toEqual(current);expect(current.id).not.toBe(old.id);
  const pending=await qr(first.accountId);await admin.query("UPDATE commands SET status='PENDING' WHERE id=$1",[pending.connectionId]);
  expect(await tx('commerce_channel',db=>readCurrentQrContinuity(db,'REAL',first.accountId))).toEqual(current);
 });
 it('QR reader cannot cross profiles or environments and rejects changed identity and archived sessions',async()=>{
  const q=await qr(),state=await tx('commerce_channel',db=>store.issueVerifiedQrContinuity(db,'REAL',q));
  expect(await tx('commerce_channel',db=>readCurrentQrContinuity(db,'REAL',q.accountId),foreign)).toBeUndefined();
  expect(await tx('commerce_channel',db=>readCurrentQrContinuity(db,'SIMULATION',q.accountId))).toBeUndefined();
  await admin.query('UPDATE channel_sessions SET expected_identity_fingerprint=$2 WHERE account_id=$1',[q.accountId,'b'.repeat(64)]);
  expect(await tx('commerce_channel',db=>readCurrentQrContinuity(db,'REAL',q.accountId))).toBeUndefined();
  await admin.query('UPDATE channel_sessions SET expected_identity_fingerprint=$2,archived_at=clock_timestamp() WHERE account_id=$1',[q.accountId,q.identityFingerprint]);
  expect(await tx('commerce_channel',db=>readCurrentQrContinuity(db,'REAL',q.accountId))).toBeUndefined();expect(await saved(state.id)).toEqual(state);
 });
 it('two native current QR grants retain separate peer, pause, protection and revoke checks',async()=>{
  const qa=await qr(),qb=await qr(),a=await tx('commerce_channel',db=>store.issueVerifiedQrContinuity(db,'REAL',qa)),b=await tx('commerce_channel',db=>store.issueVerifiedQrContinuity(db,'REAL',qb));
  const scope={workspaceId:workspace,environment:'REAL' as const,senderId:a.accountId,peerId:b.accountId};
  const check=()=>tx('commerce_channel',async db=>continuousWarmupAuthorityBlock((await readCurrentQrContinuity(db,'REAL',a.accountId))!,await readCurrentQrContinuity(db,'REAL',b.accountId),scope));
  expect(await check()).toBeUndefined();
  const paused=await humanCommand(b,'pause');expect(await check()).toBe('CONTINUITY_OWN_PEER_REQUIRED');
  const resumed=await humanCommand(paused,'resume');expect(await check()).toBeUndefined();
  const held=await tx('commerce_channel',async db=>store.applyContinuousProtection(db,'REAL',b.id,'assert',{operationId:randomUUID(),expectedVersion:resumed.version,reason:'CHANNEL_DOWN',incidentId:randomUUID(),observedAt:(await db.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString(),evidenceSha256:'d'.repeat(64)}));
  expect(await check()).toBe('CONTINUITY_OWN_PEER_REQUIRED');await humanCommand(held,'revoke');expect(await check()).toBe('CONTINUITY_OWN_PEER_REQUIRED');
  const ownPaused=await humanCommand(a,'pause');expect(await check()).toBe('CONTINUITY_HUMAN_PAUSED');await humanCommand(ownPaused,'revoke');expect(await check()).toBe('CONTINUITY_REVOKED');
 });
 it('013 returns validated profile timezone and never lets an invalid IANA fact reach QR workers',async()=>{
  await asProfileOwner(admin,workspace,c=>c.query("UPDATE profiles SET timezone='America/Los_Angeles' WHERE id=$1",[workspace]));
  try{expect(await tx('commerce_channel',db=>lockedContinuousWorkerProfile(db))).toMatchObject({timezone:'America/Los_Angeles'});
   // V7 F2: the quota calendar (014) refuses storing an invalid IANA zone, so the
   // invalid fact cannot reach a worker; the validated zone is still returned.
   await expect(asProfileOwner(admin,workspace,c=>c.query("UPDATE profiles SET timezone='Not/A_Zone' WHERE id=$1",[workspace]))).rejects.toThrow('PROFILE_QUOTA_TIMEZONE_INVALID');
   expect(await tx('commerce_channel',db=>lockedContinuousWorkerProfile(db))).toMatchObject({timezone:'America/Los_Angeles'});
  }finally{await asProfileOwner(admin,workspace,c=>c.query("UPDATE profiles SET timezone='UTC' WHERE id=$1",[workspace]));}
 });

 it('paused workflow persists its intent before advancing and final dispatch stays blocked until resume',async()=>{
  const f=await commercialReady({workflow:messageFlow});const paused=await humanCommand(f.state,'pause');
  const completed=await work(db=>advanceWorkflow(db,f.conversation));expect(completed.body.flow_state.status).toBe('FINISHED');
  const [row]=await effects(f.conversation.id);expect(row).toMatchObject({status:'BLOCKED',continuous_authorization_id:f.state.id});expect(await f.gate(row)).toMatchObject({allowed:false,reason:'CONTINUITY_HUMAN_PAUSED'});
  await humanCommand(paused,'resume');expect((await f.gate(row)).allowed).toBe(true);await work(db=>advanceWorkflow(db,completed));expect((await effects(f.conversation.id)).map(x=>x.id)).toEqual([row.id]);
 });
 it('protected proposal is durable and its original grant remains blocked without renewal',async()=>{
  const f=await commercialReady(),at=(await admin.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
  const protectedState=await tx('commerce_channel',db=>store.applyContinuousProtection(db,'REAL',f.state.id,'assert',{operationId:randomUUID(),expectedVersion:1,reason:'SEND_UNCERTAIN',incidentId:randomUUID(),observedAt:at,evidenceSha256:'e'.repeat(64)}));
  const key=randomUUID(),payload={kind:'text',text:'Immutable pending intent'};
  const first=await work(db=>proposeEffectOutcome(db,f.conversation,payload,key));expect(first.state).toBe('CREATED');if(first.state==='BLOCKED')throw Error('FIXTURE');
  expect(first.effect).toMatchObject({status:'BLOCKED',result:{reason:'CONTINUITY_PROTECTED'}});await humanCommand(protectedState,'revoke');
  const again=await work(db=>proposeEffectOutcome(db,f.conversation,payload,key));expect(again).toEqual({state:'EXISTING_MATCH',effect:first.effect});expect(await f.gate(first.effect)).toMatchObject({reason:'CONTINUITY_REVOKED'});
  await expect(work(db=>proposeEffectOutcome(db,f.conversation,{...payload,text:'different'},key))).rejects.toThrow('EFFECT_PROPOSAL_CONFLICT');
  await expect(work(db=>proposeEffectOutcome(db,f.conversation,payload,key,{expiresAt:new Date(Date.now()+7200000).toISOString()}))).rejects.toThrow('EFFECT_PROPOSAL_CONFLICT');
 });
 it('missing authority preserves workflow cursor and retry creates exactly one effect after registration',async()=>{
  const f=await awaitGrant(await commercialReady({workflow:messageFlow}));
  for(let i=0;i<2;i++){const pending=await work(db=>advanceWorkflow(db,f.conversation));expect(pending.body.flow_state).toMatchObject({status:'RUNNING',node_id:'message',steps:0});expect(pending.body.effect_proposal_block.reason).toBe('CONTINUITY_AUTHORITY_UNAVAILABLE');}
  expect(await effects(f.conversation.id)).toHaveLength(0);
  expect((await admin.query("SELECT count(*)::int n FROM domain_events WHERE aggregate_id=$1 AND event_type='workflow.node_executed'",[f.conversation.id])).rows[0].n).toBe(0);
  const registered=await f.issue();const done=await work(db=>advanceWorkflow(db,f.conversation));expect(done.body.flow_state.status).toBe('FINISHED');expect(await effects(f.conversation.id)).toMatchObject([{continuous_authorization_id:registered.id}]);
 });
 it('one blocked oldest workflow does not starve the next conversation with batch limit one',async()=>{
  await clearWorkerCandidates();const first=await awaitGrant(await commercialReady({workflow:messageFlow})),second=await commercialReady({workflow:messageFlow});
  expect(await work(()=>processNewWorkflows(1))).toBe(1);expect((await conversation(first.conversation.id)).body.flow_state.node_id).toBe('message');
  expect(await work(()=>processNewWorkflows(1))).toBe(1);expect((await conversation(second.conversation.id)).body.flow_state.status).toBe('FINISHED');expect(await effects(first.conversation.id)).toHaveLength(0);expect(await effects(second.conversation.id)).toHaveLength(1);
 });
 it('revoked authority retains the bank node and never announces it as executed',async()=>{
  const bank=await record('bank_profile',{status:'PUBLISHED'}),flow={...messageFlow,entry_node_id:'bank',nodes:[{id:'bank',type:'bank_instructions',config:{},next:'end'},{id:'end',type:'end',config:{}}]};
  const f=await commercialReady({workflow:flow,offer:{payment_profile_version_id:bank}});await humanCommand(f.state,'revoke');
  const pending=await work(db=>advanceWorkflow(db,f.conversation));expect(pending.body.flow_state).toMatchObject({node_id:'bank',steps:0,status:'RUNNING'});expect(await effects(f.conversation.id)).toHaveLength(0);
 });
 it('fulfillment resumes the original pending row instead of losing delivery or creating a duplicate',async()=>{
  const asset=await record('asset',{kind:'file',mime_type:'application/pdf',name:'Synthetic PDF'}),flow={...messageFlow,entry_node_id:'deliver',nodes:[{id:'deliver',type:'fulfillment',config:{release_on:'commitment_accepted'},next:'end'},{id:'end',type:'end',config:{}}]};
  const f=await awaitGrant(await commercialReady({workflow:flow,offer:{fulfillment:[{asset_id:asset,release_on:'commitment_accepted'}]}}));const order=await work(db=>ensureOrder(db,f.conversation));
  await admin.query("UPDATE records SET body=body||'{\"status\":\"COMMITTED\"}'::jsonb,version=version+1 WHERE id=$1",[order!.id]);
  const pending=await work(db=>advanceWorkflow(db,f.conversation));expect(pending.body.flow_state).toMatchObject({node_id:'deliver',steps:0});
  const before=(await admin.query("SELECT * FROM records WHERE kind='fulfillment' AND body->>'conversation_id'=$1",[f.conversation.id])).rows;expect(before).toHaveLength(1);expect(before[0].body.effect_id).toBeUndefined();
  await f.issue();expect((await work(db=>advanceWorkflow(db,f.conversation))).body.flow_state.status).toBe('FINISHED');
  const after=(await admin.query("SELECT * FROM records WHERE kind='fulfillment' AND body->>'conversation_id'=$1",[f.conversation.id])).rows;expect(after).toHaveLength(1);expect(after[0].id).toBe(before[0].id);expect(after[0].body.effect_id).toBe((await effects(f.conversation.id))[0].id);
 });
 it('AI waits for durable intent without completing or repeating the provider, then reuses the same run',async()=>{
  await clearWorkerCandidates();const flow={...messageFlow,entry_node_id:'ai',nodes:[{id:'ai',type:'ai',config:{},next:'end'},{id:'end',type:'end',config:{}}]};const f=await awaitGrant(await commercialReady({workflow:flow}));await prepareAgent(f);await work(db=>advanceWorkflow(db,f.conversation));const p=providerCounter();
  await work(()=>processAgents(10,p.provider));const [pending]=await runFor(f.conversation.id);expect(p.calls()).toBe(1);expect(pending.body).toMatchObject({status:'AWAITING_EFFECT',usage:{input_tokens:7,output_tokens:11,cost_minor:3}});
  expect((await conversation(f.conversation.id)).body).toMatchObject({ai_pending:true,ai_status:'AWAITING_EFFECT',active_ai_run_id:pending.id});expect(await effects(f.conversation.id)).toHaveLength(0);expect((await conversation(f.conversation.id)).body.flow_state).toMatchObject({status:'WAITING',waiting_for:'ai_accepted'});
  expect((await admin.query("SELECT count(*)::int n FROM domain_events WHERE aggregate_id=$1 AND event_type='ai.proposal_accepted'",[f.conversation.id])).rows[0].n).toBe(0);
  await work(()=>processAgents(10,p.provider));expect(p.calls()).toBe(1);expect(await runFor(f.conversation.id)).toHaveLength(1);
  await f.issue();await work(()=>processAgents(10,p.provider));expect(p.calls()).toBe(1);const [done]=await runFor(f.conversation.id);expect(done.id).toBe(pending.id);expect(done.body.status).toBe('COMPLETED');expect(done.body.usage).toEqual(pending.body.usage);expect(await effects(f.conversation.id)).toHaveLength(1);expect((await conversation(f.conversation.id)).body.ai_pending).toBe(false);expect((await conversation(f.conversation.id)).body.flow_state.status).toBe('FINISHED');
 });
 it.each(['conversation','contact','channel_account'] as const)('cached AI survives a reversible %s pause and still gives the next conversation a turn',async scope=>{
  await clearWorkerCandidates();const first=await awaitGrant(await commercialReady());await prepareAgent(first);const p=providerCounter();await work(()=>processAgents(1,p.provider));
  const [pending]=await runFor(first.conversation.id),second=await commercialReady();await prepareAgent(second);
  const scopeId=scope==='conversation'?first.conversation.id:scope==='contact'?first.conversation.body.contact_id:first.conversation.body.account_id;
  await admin.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,actor_id,reason) VALUES($1,$2,$3,true,'synthetic-owner','SYNTHETIC_PAUSE')",[workspace,scope,scopeId]);
  await work(()=>processAgents(1,p.provider));expect(p.calls()).toBe(1);expect((await conversation(first.conversation.id)).body).toMatchObject({ai_pending:true,active_ai_run_id:pending.id,ai_status:'AWAITING_EFFECT'});expect((await runFor(first.conversation.id))[0].body).toEqual(pending.body);
  await work(()=>processAgents(1,p.provider));expect(p.calls()).toBe(2);expect((await runFor(second.conversation.id))[0].body.status).toBe('COMPLETED');
  await admin.query("UPDATE manual_controls SET paused=false,version=version+1 WHERE workspace_id=$1 AND scope_type=$2 AND scope_id=$3",[workspace,scope,scopeId]);await first.issue();
  await work(()=>processAgents(10,p.provider));const [done]=await runFor(first.conversation.id);expect(p.calls()).toBe(2);expect(done.id).toBe(pending.id);expect(done.body).toMatchObject({status:'COMPLETED',usage:pending.body.usage,proposal:pending.body.proposal});expect(await effects(first.conversation.id)).toHaveLength(1);
 });
 it('a pause observed after the provider stores the response for reuse instead of spending a second request',async()=>{
  await clearWorkerCandidates();const f=await commercialReady();await prepareAgent(f);const p=providerCounter();
  await work(db=>processAgents(1,{...p.provider,async propose(config,context){const result=await p.provider.propose(config,context);await db.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,actor_id,reason) VALUES($1,'conversation',$2,true,'synthetic-owner','SYNTHETIC_PAUSE')",[workspace,f.conversation.id]);return result;}}));
  const [pending]=await runFor(f.conversation.id);expect(p.calls()).toBe(1);expect(pending.body).toMatchObject({status:'AWAITING_EFFECT',effect_proposal_block:'CONTROLS_BLOCKED'});expect(await effects(f.conversation.id)).toHaveLength(0);expect((await conversation(f.conversation.id)).body.ai_pending).toBe(true);
  await admin.query("UPDATE manual_controls SET paused=false,version=version+1 WHERE workspace_id=$1 AND scope_type='conversation' AND scope_id=$2",[workspace,f.conversation.id]);await work(()=>processAgents(1,p.provider));
  expect(p.calls()).toBe(1);expect((await runFor(f.conversation.id))[0].id).toBe(pending.id);expect((await runFor(f.conversation.id))[0].body.status).toBe('COMPLETED');expect(await effects(f.conversation.id)).toHaveLength(1);
 });
 it('opt-out observed with a new pause immediately suppresses and cancels pending effects without sending',async()=>{
  await clearWorkerCandidates();const f=await commercialReady();await prepareAgent(f);const original=await f.propose();expect(original.status).toBe('READY');const p=providerCounter();
  await work(db=>processAgents(1,{...p.provider,async propose(config,context){const result=await p.provider.propose(config,context);await db.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,actor_id,reason) VALUES($1,'conversation',$2,true,'synthetic-owner','SYNTHETIC_PAUSE')",[workspace,f.conversation.id]);return{...result,proposal:{...result.proposal,intent:'opt_out'}};}}));
  expect(p.calls()).toBe(1);expect((await admin.query("SELECT suppressed FROM manual_controls WHERE workspace_id=$1 AND scope_type='contact' AND scope_id=$2",[workspace,f.conversation.body.contact_id])).rows[0].suppressed).toBe(true);expect(await effects(f.conversation.id)).toMatchObject([{id:original.id,status:'CANCELLED'}]);expect((await runFor(f.conversation.id))[0].body.status).toBe('COMPLETED');expect((await conversation(f.conversation.id)).body.ai_pending).toBe(false);
 });
 it('cached AI output is discarded on context drift without a second model request',async()=>{
  await clearWorkerCandidates();const f=await awaitGrant(await commercialReady());await prepareAgent(f);const p=providerCounter();await work(()=>processAgents(10,p.provider));
  await admin.query("UPDATE records SET body=body||'{\"sequence\":2,\"last_customer_text\":\"Nuevo contexto\"}'::jsonb,version=version+1 WHERE id=$1",[f.conversation.id]);
  await work(()=>processAgents(10,p.provider));expect(p.calls()).toBe(1);expect((await runFor(f.conversation.id))[0].body.status).toBe('DISCARDED');expect(await effects(f.conversation.id)).toHaveLength(0);
 });
 it('a blocked AI conversation does not prevent another from obtaining a durable effect',async()=>{
  await clearWorkerCandidates();const first=await awaitGrant(await commercialReady()),second=await commercialReady();await prepareAgent(first);await prepareAgent(second);const p=providerCounter();
  await work(()=>processAgents(1,p.provider));await work(()=>processAgents(1,p.provider));expect(p.calls()).toBe(2);expect((await runFor(first.conversation.id))[0].body.status).toBe('AWAITING_EFFECT');expect((await runFor(second.conversation.id))[0].body.status).toBe('COMPLETED');expect(await effects(second.conversation.id)).toHaveLength(1);
 });

 it('SIMULATION recognizes the exact original without inventing permanent authority',async()=>{
  const account=await record('channel_account',{provider:'simulator',status:'WORKING'},workspace,'SIMULATION'),contact=await record('contact',{status:'LEAD'},workspace,'SIMULATION');
  const id=await record('conversation',{account_id:account,contact_id:contact},workspace,'SIMULATION'),conv=(await getRecord(admin,workspace,'conversation',id))!,key=randomUUID();
  const create=()=>work(db=>proposeEffectOutcome(db,conv,{kind:'text',text:'Simulation only'},key),'SIMULATION');const first=await create();expect(first.state).toBe('CREATED');if(first.state==='BLOCKED')throw Error('FIXTURE');
  expect(first.effect).toMatchObject({environment:'SIMULATION',continuous_authorization_id:null,authorization_id:null,approval_hash:first.effect.config_hash});expect(await create()).toEqual({state:'EXISTING_MATCH',effect:first.effect});
 });
 it('AI discards output when the live assignment changes during its one provider request',async()=>{
  await clearWorkerCandidates();const f=await commercialReady();await prepareAgent(f);const p=providerCounter();
  await work(db=>processAgents(10,{...p.provider,async propose(config,context){
   // Synthetic callback changes durable state in the same restricted fixture
   // transaction. This proves the reread, not external concurrent DB access.
   const result=await p.provider.propose(config,context);await db.query("UPDATE records SET body=body||'{\"assignment_revision\":2}'::jsonb,version=version+1 WHERE id=$1",[f.conversation.id]);return result;
  }}));expect(p.calls()).toBe(1);expect((await runFor(f.conversation.id))[0].body.status).toBe('DISCARDED');expect(await effects(f.conversation.id)).toHaveLength(0);
 });

});
