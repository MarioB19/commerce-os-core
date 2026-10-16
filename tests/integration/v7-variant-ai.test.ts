import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,withTransaction} from '../../packages/db/src/index.js';
import {materializeMessage} from '../../apps/automation-worker/src/inbound.js';
import {processAgents,setProfileSellerForTests} from '../../apps/automation-worker/src/agents.js';
import {openAiBudgets,resetAiBudgetCadenceForTests} from '../../apps/automation-worker/src/ai-budgets.js';
import {ProfileSellerAi} from '../../packages/ai-providers/src/variant-ai.js';
import {saveAiPreferences,saveAiKey,verifyAiKey} from '../../packages/ai-providers/src/profile-integrations.js';
import {withProfileTransaction} from '../../packages/db/src/profile-context.js';
import type {ProfileAuthority} from '../../packages/domain/src/core/profile-authorization.js';
import {reviewedModelCatalog,PRICE_VERSION} from '../../packages/ai-providers/src/price-catalog.js';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {aiCredentialKey} from '../../packages/ai-providers/src/profile-integrations.js';
const aiKey=aiCredentialKey();
import {roleExecutor} from '../support/database-role.js';
import {collectOperationalAlerts} from '../../apps/automation-worker/src/operations-monitor.js';

// V7 F4 (RF-14.a/c/d, D-09): a variant answers with its own model through the
// profile's key, admitted against the owner's monthly budget and accounted per
// variant and conversation with the reviewed dated price. The provider is a
// contract fake: no business key is consumed. An operator's publication cannot
// authorize AI; the conversation then goes to a person instead of guessing.
const P='variant-ai-'+randomUUID();
const origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
const withRole=roleExecutor(pool);
let app:Awaited<ReturnType<typeof createApp>>,aiPool:pg.Pool,ownerId='';const cookies:Record<string,string>={};
const call=(who:string,method:string,path:string,body?:unknown)=>app.inject({method:method as 'GET',url:path+(path.includes('?')?'&':'?')+'environment=REAL',payload:body as object,headers:{origin,cookie:cookies[who]!,'idempotency-key':randomUUID()}});
const data=(r:{statusCode:number;body:string;json():any},status=200)=>{expect(r.statusCode,r.body).toBe(status);return r.json().data;};
async function inProfile<T>(work:(c:import('pg').PoolClient)=>Promise<T>){
 const c=await pool.connect();
 try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[P]);const r=await work(c);await c.query('COMMIT');return r;}
 catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function login(who:string,role:'owner'|'operator'){
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 const user=await provisionUser({name:who,email,password,workspace_id:P,role});
 const r=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});
 cookies[who]=[r.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');return user;
}
const providerCalls:{url:string;body:any}[]=[];
const fakeAnthropic:typeof fetch=async(input,init)=>{
 const body=JSON.parse(String(init?.body)),verification=body.system==='Return exactly OK. Do not call tools.';if(!verification)providerCalls.push({url:String(input),body});
 const proposal={reply:'¡Claro! El curso cuesta 97 MXN.',intent:'question',confidence:0.95,tool:'none',grounding:[]};
 return new Response(JSON.stringify({id:'msg_synthetic',type:'message',role:'assistant',model:'claude-haiku-5-5',content:[{type:'text',text:verification?'OK':JSON.stringify(proposal)}],stop_reason:'end_turn',
  usage:{input_tokens:1200,output_tokens:80,service_tier:'standard'}}),{status:200,headers:{'content-type':'application/json'}});
};
beforeAll(async()=>{
 await fixtureProfiles({id:P,numbers:5});app=await createApp();ownerId=(await login('owner','owner')).id;await login('operator','operator');
 aiPool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3});aiPool.on('connect',c=>{void c.query('SET ROLE commerce_ai');});
 setProfileSellerForTests(new ProfileSellerAi({aiPool,custodyKey:aiKey,fetcher:fakeAnthropic}));
 // The business saves its own Anthropic key and monthly limit; the minimal
 // verification runs against the contract fake (never a real business key).
 const authority:ProfileAuthority={profile:{id:P,state:'ACTIVE'},membership:{userId:ownerId,workspaceId:P,role:'owner',active:true,version:1},
  credential:{kind:'session',userId:ownerId,workspaceId:P,revoked:false,expiresAt:new Date(Date.now()+3600000).toISOString(),scopes:[],membershipVersion:1}};
 const owned=<T>(work:(db:import('../../packages/db/src/profile-context.js').ProfileExecutor)=>Promise<T>)=>withProfileTransaction(pool as never,P,async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");return work(db);});
 await owned(db=>saveAiPreferences(db,authority,{environment:'REAL',expectedVersion:0,defaultProvider:'anthropic',defaultModel:'claude-haiku-5-5',monthlyLimitMicrousd:5_000_000}));
 const saved=await owned(db=>saveAiKey(db,authority,{operationId:randomUUID(),environment:'REAL',provider:'anthropic',expectedRevision:0,key:'sk-ant-synthetic-key-0000'},aiKey));
 expect(saved.verification).not.toBeNull();
 expect(await verifyAiKey({pool:aiPool as never,key:aiKey,fetcher:fakeAnthropic},saved.verification!)).toEqual({state:'VERIFIED'});
});
afterAll(async()=>{setProfileSellerForTests(null);await aiPool.end();await app.close();await pool.end();});

it('answers with the variant model, admitted and accounted per variant and conversation',async()=>{
 // The reviewed catalogue is installed with dated official prices.
 const prices=await inProfile(async c=>(await c.query('SELECT provider,model,price_version FROM ai_model_prices WHERE price_version=$1 ORDER BY provider,model',[PRICE_VERSION])).rows);
 expect(prices).toHaveLength(reviewedModelCatalog.length);
 // Budget periods open from the owner's standing monthly limit.
 resetAiBudgetCadenceForTests();await withRole('commerce_automation',()=>openAiBudgets());
 expect((await inProfile(async c=>(await c.query("SELECT count(*)::int n FROM ai_budget_periods WHERE workspace_id=$1 AND starts_at<=now() AND ends_at>now()",[P])).rows[0].n))).toBe(1);
 // A variant sold by a number; the operator publishes first: AI stays pending.
 const asset=await inProfile(async c=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','asset',$2) RETURNING id",[P,{name:'Guía',kind:'link',url:'https://example.com/g',status:'READY'}])).rows[0].id);
 let v=data(await call('operator','POST','/v2/products',{name:'Curso IA',variant:{name:'México',locale:{market:'México',country:'MX',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'}}}),201).variant;
 v=data(await call('operator','PUT',`/v2/variants/${v.id}/offer`,{expected_version:v.version,value:{...v.document.offer,price_minor:9700,fulfillment:[{asset_id:asset,release_on:'receipt_approved'}]}}));
 v=data(await call('operator','PUT',`/v2/variants/${v.id}/collection`,{expected_version:v.version,value:{spei:null,links:[{label:'Pagar',provider:'stripe',url:'https://pay.example.com/c'}],instructions:''}}));
 const byOperator=data(await call('operator','POST',`/v2/variants/${v.id}/publish`,{expected_version:v.version,document_sha256:v.document_sha256}));
 expect(byOperator.ai.find((t:{task:string})=>t.task==='sales.chat')).toMatchObject({state:'NEEDS_OWNER',code:'GRANT_REQUIRED',provider:'anthropic',model:'claude-haiku-5-5'});
 expect(byOperator.ai.find((t:{task:string})=>t.task==='audio.transcribe')).toMatchObject({state:'HUMAN_REQUIRED',code:'CAPABILITY_NOT_CONFIGURED'});
 expect((await call('operator','POST',`/v2/variants/${v.id}/ai-authorization`,{})).statusCode).toBe(403);
 const number=await inProfile(async c=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','channel_account',$2) RETURNING *",[P,{name:'Ventas',provider:'simulator',status:'WORKING'}])).rows[0]);
 data(await call('owner','POST',`/v2/variants/${v.id}/numbers`,{account_id:number.id,sell:true}));
 const inbound=(identity:string)=>withRole('commerce_automation',()=>withTransaction(c=>materializeMessage(c,number,{key:randomUUID(),type:'message',providerAt:new Date().toISOString(),identity,kind:'text',text:'¿Cuánto cuesta?',payload:{}},randomUUID())));
 const pending=(await inbound('opaque:sin-ia'))!;
 await withRole('commerce_automation',()=>processAgents(20));
 const blocked=await inProfile(async c=>(await c.query("SELECT body FROM records WHERE kind='ai_run' AND body->>'conversation_id'=$1",[pending.id])).rows[0].body);
 expect(blocked).toMatchObject({status:'FAILED',reason:'AI_AUTHORITY'});expect(providerCalls).toHaveLength(0);
 // The owner confirms (here by the explicit action; publishing as owner does the same).
 const confirmed=data(await call('owner','POST',`/v2/variants/${v.id}/ai-authorization`,{}));
 expect(confirmed.minted.map((m:{task:string})=>m.task).sort()).toEqual(['laboratory.chat','laboratory.vision','receipt.document','sales.chat']);
 expect(data(await call('owner','GET',`/v2/variants/${v.id}/ai-status`)).find((t:{task:string})=>t.task==='sales.chat').state).toBe('READY');
 const chat=(await inbound('opaque:con-ia'))!;
 await withRole('commerce_automation',()=>processAgents(20));
 expect(providerCalls).toHaveLength(1);expect(providerCalls[0]!.url).toBe('https://api.anthropic.com/v1/messages');expect(providerCalls[0]!.body.model).toBe('claude-haiku-5-5');
 const run=await inProfile(async c=>(await c.query("SELECT body FROM records WHERE kind='ai_run' AND body->>'conversation_id'=$1",[chat.id])).rows[0].body);
 expect(run.proposal.reply).toContain('97');expect(run.usage).toMatchObject({provider:'anthropic',model:'claude-haiku-5-5'});
 // Accounting with the dated price: 1200 in × 0.10 + 80 out × 0.50 per million.
 const attempt=await inProfile(async c=>(await c.query('SELECT variant_id,conversation_id,task,provider,model,price_version,state,charged_microusd,measured_cost_microusd,input_tokens,output_tokens FROM ai_attempts WHERE workspace_id=$1 AND conversation_id=$2',[P,chat.id])).rows[0]);
 expect(attempt).toMatchObject({variant_id:v.id,conversation_id:chat.id,task:'sales.chat',provider:'anthropic',model:'claude-haiku-5-5',price_version:PRICE_VERSION,state:'SUCCEEDED'});expect([Number(attempt.input_tokens),Number(attempt.output_tokens)]).toEqual([1200,80]);
 expect(Number(attempt.charged_microusd)).toBe(Math.ceil((1200*100_000+80*500_000)/1_000_000));
},120000);

// CHAOS-PROVIDER (RF-13.d): the provider fails (server error, then no balance).
// No chat is left in silence: it goes to a person and the owner sees an alert.
// When the provider answers again the next chat uses AI with no new
// authorization, the alert resolves and a chat already with a person stays there.
it('hands chats to a person while the provider fails and recovers without reauthorizing (CHAOS-PROVIDER)',async()=>{
 let mode:'server_error'|'no_balance'|'ok'='server_error';const calls:string[]=[];
 const chaos:typeof fetch=async(input,init)=>{
  const body=JSON.parse(String(init?.body));if(body.system!=='Return exactly OK. Do not call tools.')calls.push(mode);
  if(mode==='server_error')return new Response(JSON.stringify({type:'error',error:{type:'api_error',message:'Internal server error'}}),{status:500,headers:{'content-type':'application/json'}});
  if(mode==='no_balance')return new Response(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'Your credit balance is too low'}}),{status:400,headers:{'content-type':'application/json'}});
  return fakeAnthropic(input,init);
 };
 setProfileSellerForTests(new ProfileSellerAi({aiPool,custodyKey:aiKey,fetcher:chaos}));
 try{
  const asset=await inProfile(async c=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','asset',$2) RETURNING id",[P,{name:'Guía caos',kind:'link',url:'https://example.com/caos',status:'READY'}])).rows[0].id);
  let v=data(await call('owner','POST','/v2/products',{name:'Curso caos',variant:{name:'México',locale:{market:'México',country:'MX',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'}}}),201).variant;
  v=data(await call('owner','PUT',`/v2/variants/${v.id}/offer`,{expected_version:v.version,value:{...v.document.offer,price_minor:9700,fulfillment:[{asset_id:asset,release_on:'receipt_approved'}]}}));
  v=data(await call('owner','PUT',`/v2/variants/${v.id}/collection`,{expected_version:v.version,value:{spei:null,links:[{label:'Pagar',provider:'stripe',url:'https://pay.example.com/caos'}],instructions:''}}));
  // Published by the owner: AI is authorized once, here and only here.
  const published=data(await call('owner','POST',`/v2/variants/${v.id}/publish`,{expected_version:v.version,document_sha256:v.document_sha256}));
  expect(published.ai.find((t:{task:string})=>t.task==='sales.chat')).toMatchObject({state:'READY'});
  const number=await inProfile(async c=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','channel_account',$2) RETURNING *",[P,{name:'Ventas caos',provider:'simulator',status:'WORKING'}])).rows[0]);
  data(await call('owner','POST',`/v2/variants/${v.id}/numbers`,{account_id:number.id,sell:true}));
  const inbound=(identity:string,text='¿Cuánto cuesta?')=>withRole('commerce_automation',()=>withTransaction(c=>materializeMessage(c,number,{key:randomUUID(),type:'message',providerAt:new Date().toISOString(),identity,kind:'text',text,payload:{}},randomUUID())));
  const conversation=(id:string)=>inProfile(async c=>(await c.query("SELECT body FROM records WHERE kind='conversation' AND id=$1",[id])).rows[0].body);
  const runs=(id:string)=>inProfile(async c=>(await c.query("SELECT body FROM records WHERE kind='ai_run' AND body->>'conversation_id'=$1 ORDER BY created_at",[id])).rows.map(r=>r.body));
  const alerts=async()=>(data(await app.inject({method:'GET',url:'/v2/alerts?include=all',headers:{origin,cookie:cookies.owner!}})).alerts as {kind:string;label:string;resolvedAt:string|null}[]).filter(a=>a.kind==='AI_UNAVAILABLE');
  const monitor=()=>withRole('commerce_automation',()=>collectOperationalAlerts());
  // 1) Server error: the chat goes to a person, never silent.
  const a=(await inbound('opaque:caos-a'))!;
  await withRole('commerce_automation',()=>processAgents(20));
  expect(calls).toEqual(['server_error']);
  expect((await runs(a.id)).at(-1)).toMatchObject({status:'FAILED',reason:expect.stringMatching(/^AI_/)});
  expect((await conversation(a.id)).ai_status).toBe('HUMAN_REVIEW');
  await monitor();
  const opened=await alerts();expect(opened).toHaveLength(1);expect(opened[0]).toMatchObject({label:expect.stringContaining('IA no está respondiendo')});
  // 2) No balance at the provider: same handling, still one open alert.
  mode='no_balance';
  const b=(await inbound('opaque:caos-b'))!;
  await withRole('commerce_automation',()=>processAgents(20));
  expect(calls).toEqual(['server_error','no_balance']);
  expect((await runs(b.id)).at(-1)).toMatchObject({status:'FAILED'});expect((await conversation(b.id)).ai_status).toBe('HUMAN_REVIEW');
  await monitor();expect((await alerts()).filter(x=>!x.resolvedAt)).toHaveLength(1);
  // 3) The provider answers again: the next chat uses AI with no reauthorization.
  mode='ok';
  const c=(await inbound('opaque:caos-c'))!;
  await withRole('commerce_automation',()=>processAgents(20));
  expect(calls).toEqual(['server_error','no_balance','ok']);
  expect((await runs(c.id)).at(-1)!.status).not.toBe('FAILED');
  await monitor();expect((await alerts()).filter(x=>!x.resolvedAt)).toHaveLength(0);
  expect(data(await call('owner','GET',`/v2/variants/${v.id}/ai-status`)).find((t:{task:string})=>t.task==='sales.chat').state).toBe('READY');
  // 4) The chat already with a person stays with the person when the customer writes again.
  await inbound('opaque:caos-a','¿Siguen ahí?');
  await withRole('commerce_automation',()=>processAgents(20));
  expect(calls).toEqual(['server_error','no_balance','ok']);
  expect((await conversation(a.id)).ai_status).toBe('HUMAN_REVIEW');
 }finally{setProfileSellerForTests(new ProfileSellerAi({aiPool,custodyKey:aiKey,fetcher:fakeAnthropic}));}
},120000);
