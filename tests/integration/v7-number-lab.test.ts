import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdtemp,mkdir,rm,realpath,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,withTransaction,readOperationalSettings,writeOperationalSettings} from '../../packages/db/src/index.js';
import {withProfileTransaction} from '../../packages/db/src/profile-context.js';
import {saveAiPreferences,saveAiKey,verifyAiKey,aiCredentialKey} from '../../packages/ai-providers/src/profile-integrations.js';
import {installNumberLabEngine,numberLabUrls} from '../../packages/db/src/number-lab-install.js';
import {numberLabRuntimeFromEnv,processNumberLabOperations,type NumberLabRuntime} from '../../apps/automation-worker/src/number-lab-runner.js';
import type {ProfileAuthority} from '../../packages/domain/src/core/profile-authorization.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {writeReceiptPolicy} from '../../packages/db/src/receipt-policies.js';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {roleExecutor} from '../support/database-role.js';

// V7 F6 (RF-19.a/b/e/k/l/m/n, EMU-SNAPSHOT, EMU-CLOCK, EMU-ZERO, EMU-AI-COST):
// «Probar número» end to end through the API and the laboratory worker, on an
// engine database installed by the production installer. The seller answers
// with the profile's own key (a contract fake: no real key or provider). The
// REAL tables of the profile do not change; only AI accounting does.
const P='number-lab-'+randomUUID();
const origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
const withRole=roleExecutor(pool),aiKey=aiCredentialKey(),suffix='t'+randomBytes(5).toString('hex');
let app:Awaited<ReturnType<typeof createApp>>,aiPool:pg.Pool,runtime:NumberLabRuntime|null=null,root='',ownerId='',engineDatabase='',installed=false;
const cookies:Record<string,string>={};const created:string[]=[];
const call=(who:string,method:string,path:string,body?:unknown,key=randomUUID())=>app.inject({method:method as 'GET',url:path,payload:body as object,headers:{origin,cookie:cookies[who]!,'idempotency-key':key}});
const data=(r:{statusCode:number;body:string;json():any},status=200)=>{expect(r.statusCode,r.body).toBe(status);return r.json().data;};
let sellerCalls=0,visionCalls=0;
// RF-19.d: what the (contract) model reads from the next example receipt.
let visionDocument:Record<string,unknown>={};
const fakeAnthropic:typeof fetch=async(_input,init)=>{
 const body=JSON.parse(String(init?.body)),verification=body.system==='Return exactly OK. Do not call tools.';
 const vision=JSON.stringify(body.messages??[]).includes('"type":"image"')||JSON.stringify(body.messages??[]).includes('"type":"document"');
 if(vision)visionCalls++;else if(!verification)sellerCalls++;
 const text=verification?'OK':vision?JSON.stringify(visionDocument):JSON.stringify({reply:'¡Hola! El curso cuesta 97 pesos. ¿Te interesa?',intent:'question',confidence:1,tool:'none',grounding:['offer_snapshot']});
 return new Response(JSON.stringify({id:'msg_synthetic',type:'message',role:'assistant',model:'claude-haiku-5-5',content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:900,output_tokens:60,service_tier:'standard'}}),{status:200,headers:{'content-type':'application/json'}});
};
async function login(who:string,role:'owner'|'operator'){
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 const user=await provisionUser({name:who,email,password,workspace_id:P,role});
 const r=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});
 cookies[who]=[r.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');return user;
}
function clabe(prefix17:string){const w=[3,7,1];let s=0;for(let i=0;i<17;i++)s+=(Number(prefix17[i])*w[i%3]!)%10;return prefix17+String((10-(s%10))%10);}
const MX={market:'México',country:'MX',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'};
/** REAL footprint of the profile: everything a test must never change. */
const footprint=()=>withTransaction(async c=>{await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[P]);
 const n=async(sql:string)=>Number((await c.query(sql,[P])).rows[0].n);
 return{records:await n("SELECT count(*) n FROM records WHERE workspace_id=$1"),outbox:await n("SELECT count(*) n FROM outbox WHERE workspace_id=$1"),timers:await n("SELECT count(*) n FROM timers WHERE workspace_id=$1"),
  commands:await n("SELECT count(*) n FROM commands WHERE workspace_id=$1"),events:await n("SELECT count(*) n FROM domain_events WHERE workspace_id=$1"),payments:await n("SELECT count(*) n FROM payment_contributions WHERE workspace_id=$1"),
  remarketing:await n("SELECT count(*) n FROM commercial_remarketing_cycles WHERE workspace_id=$1")};});
const tick=async()=>{for(let i=0;i<4;i++)if(!await processNumberLabOperations(runtime))break;};

beforeAll(async()=>{
 const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_DATABASE_REQUIRED');
 root=await mkdtemp(join(await realpath(tmpdir()),'v7-lab-'));await mkdir(join(root,'source'),{mode:0o700});await mkdir(join(root,'source','assets'),{mode:0o700});await mkdir(join(root,'lab'),{mode:0o700});
 process.env.PRIVATE_STORAGE_DIR=join(root,'source');process.env.LAB_PRIVATE_STORAGE_DIR=join(root,'lab');
 // The production installer, on this isolated cluster.
 const installation=await installNumberLabEngine(url.toString(),{suffix});installed=true;engineDatabase=installation.database;
 expect(installation.created).toBe(true);
 Object.assign(process.env,numberLabUrls(url.toString(),installation));
 created.push(...Object.values(installation.logins!).map(l=>l.user));
 // Idempotent: a second run verifies and never rebuilds or issues logins.
 const again=await installNumberLabEngine(url.toString());expect(again).toEqual({database:installation.database,installationId:installation.installationId,engineSha256:installation.engineSha256,created:false});
 await fixtureProfiles({id:P,numbers:8});app=await createApp();ownerId=(await login('owner','owner')).id;await login('operator','operator');
 aiPool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3});aiPool.on('connect',c=>{void c.query('SET ROLE commerce_ai');});
 const authority:ProfileAuthority={profile:{id:P,state:'ACTIVE'},membership:{userId:ownerId,workspaceId:P,role:'owner',active:true,version:1},
  credential:{kind:'session',userId:ownerId,workspaceId:P,revoked:false,expiresAt:new Date(Date.now()+3600000).toISOString(),scopes:[],membershipVersion:1}};
 const owned=<T>(work:(db:import('../../packages/db/src/profile-context.js').ProfileExecutor)=>Promise<T>)=>withProfileTransaction(pool as never,P,async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");return work(db);});
 await owned(db=>saveAiPreferences(db,authority,{environment:'REAL',expectedVersion:0,defaultProvider:'anthropic',defaultModel:'claude-haiku-5-5',monthlyLimitMicrousd:5_000_000}));
 const saved=await owned(db=>saveAiKey(db,authority,{operationId:randomUUID(),environment:'REAL',provider:'anthropic',expectedRevision:0,key:'sk-ant-synthetic-key-0000'},aiKey));
 expect(await verifyAiKey({pool:aiPool as never,key:aiKey,fetcher:fakeAnthropic},saved.verification!)).toEqual({state:'VERIFIED'});
 await withTransaction(async c=>{await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[P]);const s=await readOperationalSettings(c,P,'REAL');
  await writeOperationalSettings(c,P,'REAL',s.version,{...s.body,dispatch_frozen:false,real_sends_enabled:true,allow_real_operations:true},'synthetic-lab');});
 const {openAiBudgets,resetAiBudgetCadenceForTests}=await import('../../apps/automation-worker/src/ai-budgets.js');resetAiBudgetCadenceForTests();await withRole('commerce_automation',()=>openAiBudgets());
 runtime=numberLabRuntimeFromEnv();expect(runtime).not.toBeNull();runtime!.ai={pool:aiPool,custodyKey:aiKey};runtime!.fetcher=fakeAnthropic;
},120000);
afterAll(async()=>{
 await runtime?.close();await aiPool?.end();await app?.close();
 // Only a fully installed engine is removed (one engine per cluster).
 if(installed){const admin=new pg.Client({connectionString:process.env.DATABASE_URL});await admin.connect();
  try{await admin.query(`DROP DATABASE IF EXISTS "${engineDatabase}" WITH (FORCE)`);await admin.query('DROP ROLE IF EXISTS '+[...created,'commerce_lab_engine','commerce_lab_engine_seed','commerce_lab_engine_owner'].map(n=>'"'+n+'"').join(','));}
  finally{await admin.end();}}
 await pool.end();await rm(root,{recursive:true,force:true});
});

it('tests a number through the API and the laboratory worker without touching REAL',async()=>{
 // A published variant sold on a number (as the owner does in the application).
 const material=data(await call('owner','POST','/v2/materials?environment=REAL',{name:'Guía',kind:'link',url:'https://example.com/guia'}),201).id as string;
 let v=data(await call('owner','POST','/v2/products',{name:'Curso',variant:{name:'México',locale:MX}}),201).variant;
 v=data(await call('owner','PUT',`/v2/variants/${v.id}/offer`,{expected_version:v.version,value:{...v.document.offer,price_minor:9700,fulfillment:[{asset_id:material,release_on:'receipt_approved'}]}}));
 v=data(await call('owner','PUT',`/v2/variants/${v.id}/collection`,{expected_version:v.version,value:{spei:{bank:'Banco sintético',holder:'Titular sintético',clabe:clabe('01218000011835971')},links:[],instructions:''}}));
 // Remarketing at any hour: «si aún no paga» after 2 h (text only).
 v=data(await call('owner','PUT',`/v2/variants/${v.id}/remarketing`,{expected_version:v.version,value:{schema_version:1,policy_id:'remarketing-3-slot',policy_revision:1,window:{start_hour:0,end_hour:24},
  slots:[1,2,3].map((position,i)=>({id:'slot-'+position,position,enabled:position===1,delay:{quantity:[2,8,24][i],unit:'hours'},stages:{awaiting_agreement:{medium:'text',text:`¿Sigues interesado? (${position})`},awaiting_payment:{medium:'text',text:`Te recuerdo el pago (${position})`}}}))}}));
 const published=data(await call('owner','POST',`/v2/variants/${v.id}/publish`,{expected_version:v.version,document_sha256:v.document_sha256}));
 expect(published.ai.find((t:{task:string})=>t.task==='laboratory.chat')).toMatchObject({state:'READY'});
 const number=await withTransaction(async c=>{await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[P]);
  return(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','channel_account',$2) RETURNING id",[P,{name:'Ventas',provider:'waha',gateway_ref:'lab-'+randomUUID(),status:'WORKING',sending_enabled:true,identity_verified:true}])).rows[0].id as string;});
 data(await call('owner','POST',`/v2/variants/${v.id}/numbers`,{account_id:number,sell:true}));
 const before=await footprint();

 // Estimate first (RF-19.l): a ceiling paid by the profile's key, nothing sent.
 const estimate=data(await call('operator','POST','/v2/number-tests/estimate',{account_id:number,mode:'CHAT'}));
 expect(estimate).toMatchObject({mode:'CHAT',currency:'USD',paid_by:'PROFILE_KEY',variants:[{variant_id:v.id,name:'Curso · México',provider:'anthropic',model:'claude-haiku-5-5'}]});
 expect(estimate.maximum_microusd).toBeGreaterThan(0);
 // A ceiling below the fresh estimate is refused; the automatic buyer is not offered yet.
 expect((await call('operator','POST','/v2/number-tests',{account_id:number,mode:'CHAT',accepted_maximum_microusd:1})).json().code??'').toBeDefined();
 expect((await call('operator','POST','/v2/number-tests',{account_id:number,mode:'CHAT',accepted_maximum_microusd:1})).statusCode).toBe(409);
 const startKey=randomUUID();
 const run=data(await call('operator','POST','/v2/number-tests',{account_id:number,mode:'CHAT',accepted_maximum_microusd:estimate.maximum_microusd},startKey),201);
 expect(run).toMatchObject({account_id:number,mode:'CHAT',state:'READY',version:1,execution_environment:'SIMULATION',operation_class:'TEST'});
 // A lost response returns the same run.
 expect(data(await call('operator','POST','/v2/number-tests',{account_id:number,mode:'CHAT',accepted_maximum_microusd:estimate.maximum_microusd},startKey)).run_id).toBe(run.run_id);

 // The customer writes; the worker answers in the laboratory.
 data(await call('operator','POST',`/v2/number-tests/${run.run_id}/actions`,{expected_version:1,action:{type:'message',text:'Hola, quiero el curso'}}),202);
 // One action at a time.
 expect((await call('operator','POST',`/v2/number-tests/${run.run_id}/actions`,{expected_version:1,action:{type:'continue'}})).statusCode).toBe(409);
 await tick();
 let view=data(await call('operator','GET',`/v2/number-tests/${run.run_id}`));
 expect(view.pending).toBe(false);
 expect(view.operations[0]).toMatchObject({state:'APPLIED',action:{type:'message'}});
 expect(view.variants).toEqual([expect.objectContaining({variant_id:v.id,name:'Curso · México'})]);
 expect(view.selected_variant_id).toBe(v.id);
 const transcript=view.conversation.transcript as {from:string;text:string|null}[];
 expect(transcript[0]).toMatchObject({from:'customer',text:'Hola, quiero el curso'});
 expect(transcript.some(e=>e.from==='business')).toBe(true);
 expect(view.isolation).toMatchObject({environment:'SIMULATION',whatsapp:false,real_records:false});

 // Single step (NUMBER_FLOW_TEST_V1): the next business message waits for «Continuar».
 expect(view.conversation).toMatchObject({waiting_for:'simulation_continue',next_step:{action:'continue'}});
 data(await call('operator','POST',`/v2/number-tests/${run.run_id}/actions`,{expected_version:view.run.version,action:{type:'continue'}}),202);
 await tick();
 view=data(await call('operator','GET',`/v2/number-tests/${run.run_id}`));
 expect(view.conversation.transcript.at(-1)).toMatchObject({from:'business',text:'¿Te gustaría continuar? Responde «Sí, acepto» para seguir.'});
 expect(view.conversation).toMatchObject({waiting_for:'commitment',next_step:{action:'message'}});
 expect(view.conversation.timers).toHaveLength(1);
 // The customer is silent: 2 virtual hours later the variant's reminder goes out (RF-19.e).
 const virtual=Date.parse(view.run.virtual_now);
 data(await call('operator','POST',`/v2/number-tests/${run.run_id}/actions`,{expected_version:view.run.version,action:{type:'advance',hours:2}}),202);
 await tick();
 view=data(await call('operator','GET',`/v2/number-tests/${run.run_id}`));
 expect(view.operations[2]).toMatchObject({state:'APPLIED',action:{type:'advance',hours:2}});
 expect(Date.parse(view.run.virtual_now)-virtual).toBe(2*3600000);
 expect(view.conversation.transcript.at(-1)).toMatchObject({from:'business',purpose:'remarketing',text:'¿Sigues interesado? (1)',variant_name:'Curso · México',explanation:expect.stringContaining('Seguimiento 1 de la variante')});
 // The customer accepts: the payment instructions of the variant (RF-19.b).
 data(await call('operator','POST',`/v2/number-tests/${run.run_id}/actions`,{expected_version:view.run.version,action:{type:'message',text:'Sí, acepto'}}),202);
 await tick();
 view=data(await call('operator','GET',`/v2/number-tests/${run.run_id}`));
 const accepted=view.conversation.transcript as {from:string;text:string|null;purpose:string|null}[];
 expect(accepted.at(-2)).toMatchObject({from:'customer',text:'Sí, acepto'});
 // Payment details are laboratory placeholders: a test never shows or uses the real account.
 expect(accepted.at(-1)).toMatchObject({from:'business',purpose:'collection',explanation:expect.stringContaining('nunca tu cuenta')});expect(accepted.at(-1)!.text).toContain('SIMULACIÓN');expect(accepted.at(-1)!.text).not.toContain('01218000011835971');
 expect(view.conversation).toMatchObject({waiting_for:'receipt_approved',next_step:{action:'receipt'}});
 expect(sellerCalls).toBe(0);
 // A free question goes to the variant's seller with the profile's own key; the
 // call is accounted as a laboratory attempt in the profile's budget (RF-19.l).
 data(await call('operator','POST',`/v2/number-tests/${run.run_id}/actions`,{expected_version:view.run.version,action:{type:'message',text:'¿Aceptan tarjeta?'}}),202);
 await tick();
 view=data(await call('operator','GET',`/v2/number-tests/${run.run_id}`));
 expect(sellerCalls).toBe(1);
 expect(view.conversation.transcript.at(-1)).toMatchObject({from:'business',purpose:'seller_reply',text:'¡Hola! El curso cuesta 97 pesos. ¿Te interesa?',
  // RF-19.g: which part of the variant answered, and with what.
  explanation:'Vendedor IA (claude-haiku-5-5): respondió una pregunta con la oferta publicada.',variant_name:'Curso · México'});
 expect(view.conversation.transcript.filter((e:{from:string;explanation?:string|null})=>e.from==='business'&&!e.explanation)).toEqual([]);
 const attempts=await withTransaction(async c=>(await c.query("SELECT environment,state,lab_binding_id IS NOT NULL AS lab,charged_microusd FROM ai_attempts WHERE workspace_id=$1 AND lab_binding_id IS NOT NULL",[P])).rows);
 expect(attempts).toEqual([expect.objectContaining({environment:'REAL',lab:true,state:'SUCCEEDED'})]);
 // The month's AI shows the test apart from sales (RF-14.d, RF-19.l).
 const usage=data(await call('owner','GET','/v2/usage'));
 expect(usage.aiCost.breakdown).toEqual(expect.arrayContaining([expect.objectContaining({task:'laboratory.chat',category:'NUMBER_TEST',attempts:1,provider:'anthropic'}),expect.objectContaining({task:'credential.verify',category:'KEY_CHECK'})]));

 // «Última prueba» of the number (RF-19.n) and nothing REAL changed (RF-19.k).
 expect(data(await call('operator','GET',`/v2/number-tests/latest?account_id=${number}`)).run.run_id).toBe(run.run_id);
 expect(await footprint()).toEqual(before);
 // Another profile's run is not visible.
 expect((await call('operator','GET',`/v2/number-tests/${randomUUID()}`)).statusCode).toBe(404);
},240000);

it('asks which variant when a number sells several and keeps the chosen one for the whole chat (RF-19.f)',async()=>{
 const make=async(name:string,price:number)=>{let v=data(await call('owner','POST','/v2/products',{name,variant:{name:'México',locale:MX}}),201).variant;
  const material=data(await call('owner','POST','/v2/materials?environment=REAL',{name:'Acceso '+name,kind:'link',url:'https://example.com/'+price}),201).id as string;
  v=data(await call('owner','PUT',`/v2/variants/${v.id}/offer`,{expected_version:v.version,value:{...v.document.offer,price_minor:price,fulfillment:[{asset_id:material,release_on:'receipt_approved'}]}}));
  v=data(await call('owner','PUT',`/v2/variants/${v.id}/collection`,{expected_version:v.version,value:{spei:{bank:'Banco sintético',holder:'Titular sintético',clabe:clabe('01218000011835971')},links:[],instructions:''}}));
  data(await call('owner','POST',`/v2/variants/${v.id}/publish`,{expected_version:v.version,document_sha256:v.document_sha256}));return v;};
 const a=await make('Taller de pan',15000),b=await make('Recetario',4900);
 const number=await withTransaction(async c=>{await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[P]);
  return(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','channel_account',$2) RETURNING id",[P,{name:'Ventas 2',provider:'waha',gateway_ref:'lab-'+randomUUID(),status:'WORKING',sending_enabled:true,identity_verified:true}])).rows[0].id as string;});
 for(const v of [a,b])data(await call('owner','POST',`/v2/variants/${v.id}/numbers`,{account_id:number,sell:true}));
 const estimate=data(await call('owner','POST','/v2/number-tests/estimate',{account_id:number,mode:'CHAT'}));
 expect(estimate.variants.map((v:{name:string})=>v.name).sort()).toEqual(['Recetario · México','Taller de pan · México']);
 const run=data(await call('owner','POST','/v2/number-tests',{account_id:number,mode:'CHAT',accepted_maximum_microusd:estimate.maximum_microusd}),201);
 const step=async(action:unknown)=>{const before=data(await call('owner','GET',`/v2/number-tests/${run.run_id}`));
  data(await call('owner','POST',`/v2/number-tests/${run.run_id}/actions`,{expected_version:before.run.version,action}),202);await tick();
  const after=data(await call('owner','GET',`/v2/number-tests/${run.run_id}`));expect(after.pending).toBe(false);return after;};
 // A generic greeting does not pick a product silently.
 let view=await step({type:'message',text:'Hola'});
 expect(view.operations.at(-1).result).toMatchObject({state:'SELECTION_REQUIRED'});expect(view.conversation.next_step.action).toBe('select');
 // The tester says where the customer comes from; the pending greeting is answered by that variant.
 view=await step({type:'select_variant',variant_id:b.id,origin:'ADVERTISEMENT'});
 expect(view.selected_variant_id).toBe(b.id);
 expect(view.conversation.transcript.map((e:{text:string|null})=>e.text)).toEqual(['Hola',expect.stringContaining('Recetario')]);
 view=await step({type:'continue'});
 expect(view.conversation.transcript.at(-1).text).toContain('Sí, acepto');
 // A generic reply stays in the same journey (no new selection, no route change).
 view=await step({type:'message',text:'Sí, acepto'});
 expect(view.operations.every((o:{state:string})=>o.state==='APPLIED')).toBe(true);
 expect(view.conversation.transcript.at(-1)).toMatchObject({from:'business',purpose:'collection'});
 expect(view.selected_variant_id).toBe(b.id);
},240000);

it('previews a file the business sent inside the test chat, privately and only while it is the captured one (RF-19.c)',async()=>{
 // A voice note as the first reminder: OGG bytes uploaded like any material.
 const bytes=Buffer.concat([Buffer.from('OggS'),randomBytes(70_000)]),sha=createHash('sha256').update(bytes).digest('hex');
 const audio=data(await call('owner','POST','/v2/materials?environment=REAL',{kind:'file',name:'Nota de voz',mime_type:'audio/ogg',size_bytes:bytes.length,sha256:sha}),201);
 data(await call('owner','PUT',`/v2/materials/${audio.id}/parts/1?environment=REAL`,{base64:bytes.toString('base64')}));
 expect(data(await call('owner','POST',`/v2/materials/${audio.id}/complete?environment=REAL`,{})).status).toBe('READY');
 const link=data(await call('owner','POST','/v2/materials?environment=REAL',{name:'Acceso audio',kind:'link',url:'https://example.com/audio'}),201).id as string;
 let v=data(await call('owner','POST','/v2/products',{name:'Audiolibro',variant:{name:'México',locale:MX}}),201).variant;
 v=data(await call('owner','PUT',`/v2/variants/${v.id}/offer`,{expected_version:v.version,value:{...v.document.offer,price_minor:5900,fulfillment:[{asset_id:link,release_on:'receipt_approved'}]}}));
 v=data(await call('owner','PUT',`/v2/variants/${v.id}/collection`,{expected_version:v.version,value:{spei:{bank:'Banco sintético',holder:'Titular sintético',clabe:clabe('01218000011835971')},links:[],instructions:''}}));
 v=data(await call('owner','PUT',`/v2/variants/${v.id}/remarketing`,{expected_version:v.version,value:{schema_version:1,policy_id:'remarketing-3-slot',policy_revision:1,window:{start_hour:0,end_hour:24},
  slots:[1,2,3].map((position,i)=>({id:'slot-'+position,position,enabled:position===1,delay:{quantity:[2,8,24][i],unit:'hours'},
   stages:{awaiting_agreement:position===1?{medium:'audio',asset_id:audio.id,text:'Te dejo una nota de voz'}:{medium:'text',text:'Hola ('+position+')'},awaiting_payment:{medium:'text',text:'Pago ('+position+')'}}}))}}));
 data(await call('owner','POST',`/v2/variants/${v.id}/publish`,{expected_version:v.version,document_sha256:v.document_sha256}));
 const number=await withTransaction(async c=>{await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[P]);
  return(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','channel_account',$2) RETURNING id",[P,{name:'Ventas audio',provider:'waha',gateway_ref:'lab-'+randomUUID(),status:'WORKING',sending_enabled:true,identity_verified:true}])).rows[0].id as string;});
 data(await call('owner','POST',`/v2/variants/${v.id}/numbers`,{account_id:number,sell:true}));
 const estimate=data(await call('owner','POST','/v2/number-tests/estimate',{account_id:number,mode:'CHAT'}));
 const run=data(await call('owner','POST','/v2/number-tests',{account_id:number,mode:'CHAT',accepted_maximum_microusd:estimate.maximum_microusd}),201);
 const step=async(action:unknown)=>{const before=data(await call('owner','GET',`/v2/number-tests/${run.run_id}`));
  data(await call('owner','POST',`/v2/number-tests/${run.run_id}/actions`,{expected_version:before.run.version,action}),202);await tick();
  const after=data(await call('owner','GET',`/v2/number-tests/${run.run_id}`));expect(after.pending).toBe(false);return after;};
 await step({type:'message',text:'Hola, quiero el audiolibro'});await step({type:'continue'});
 const view=await step({type:'advance',hours:2});
 const sent=view.conversation.transcript.at(-1);
 expect(sent).toMatchObject({from:'business',purpose:'remarketing',material:'Nota de voz',mime:'audio/ogg'});
 // The chat names the laboratory copy, never the REAL asset id.
 expect(sent.material_id).toMatch(/^[a-f0-9-]{36}$/);expect(sent.material_id).not.toBe(audio.id);
 // Text and link entries carry no preview handle.
 expect(view.conversation.transcript.filter((e:{material_id?:string})=>e.material_id)).toHaveLength(1);

 const url=`/v2/number-tests/${run.run_id}/materials/${sent.material_id}?environment=REAL`;
 const whole=await call('operator','GET',url);
 expect(whole.statusCode,whole.body).toBe(200);
 expect(whole.headers['content-type']).toContain('audio/ogg');
 expect(whole.headers['cache-control']).toBe('no-store');
 expect(String(whole.headers['content-disposition'])).toMatch(/^inline;/);
 expect(String(whole.headers['content-security-policy'])).toContain("default-src 'none'");
 expect(createHash('sha256').update(whole.rawPayload).digest('hex')).toBe(sha);
 // Seeking in the player uses one byte range.
 const part=await app.inject({method:'GET',url,headers:{origin,cookie:cookies.operator!,range:'bytes=0-3'}});
 expect(part.statusCode).toBe(206);expect(part.rawPayload.toString()).toBe('OggS');
 // Only materials this run captured: not another of the profile's files, not an unknown id, not another run.
 expect((await call('operator','GET',`/v2/number-tests/${run.run_id}/materials/${link}?environment=REAL`)).statusCode).toBe(404);
 expect((await call('operator','GET',`/v2/number-tests/${run.run_id}/materials/${audio.id}?environment=REAL`)).statusCode).toBe(404);
 expect((await call('operator','GET',`/v2/number-tests/${run.run_id}/materials/${randomUUID()}?environment=REAL`)).statusCode).toBe(404);
 expect((await call('operator','GET',`/v2/number-tests/${randomUUID()}/materials/${sent.material_id}?environment=REAL`)).statusCode).toBe(404);
 // Without a session nothing is served (no public links).
 expect((await app.inject({method:'GET',url,headers:{origin}})).statusCode).toBe(401);
 // If the stored bytes stop matching the capture, the preview is refused (409), never other content.
 const key=await withTransaction(async c=>{await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[P]);
  return String((await c.query("SELECT body->>'storage_key' k FROM records WHERE workspace_id=$1 AND environment='REAL' AND id=$2",[P,audio.id])).rows[0].k);});
 const stored=join(process.env.PRIVATE_STORAGE_DIR!,'assets',key+'.enc'),aside=stored+'.aside';
 await rename(stored,aside);
 try{const refused=await call('operator','GET',url);expect(refused.statusCode).toBe(409);expect(refused.json().error?.code??refused.json().code).toBe('LAB_MATERIAL_CHANGED');}
 finally{await rename(aside,stored);}
 expect((await call('operator','GET',url)).statusCode).toBe(200);
},240000);

it('reads an example receipt with the profile key and decides it with the rules captured at start (RF-19.d)',async()=>{
 const link=data(await call('owner','POST','/v2/materials?environment=REAL',{name:'Acceso taller',kind:'link',url:'https://example.com/taller'}),201).id as string;
 let v=data(await call('owner','POST','/v2/products',{name:'Taller de recibos',variant:{name:'México',locale:MX}}),201).variant;
 v=data(await call('owner','PUT',`/v2/variants/${v.id}/offer`,{expected_version:v.version,value:{...v.document.offer,price_minor:9700,fulfillment:[{asset_id:link,release_on:'receipt_approved'}]}}));
 v=data(await call('owner','PUT',`/v2/variants/${v.id}/collection`,{expected_version:v.version,value:{spei:{bank:'Banco sintético',holder:'Titular sintético',clabe:clabe('01218000011835971')},links:[],instructions:''}}));
 data(await call('owner','POST',`/v2/variants/${v.id}/publish`,{expected_version:v.version,document_sha256:v.document_sha256}));
 // The variant approves on its own when every documentary check passes.
 // (The application role writes rules; this verification app runs as the schema owner.)
 const rules=(revision:number,automaticApproval:boolean)=>withProfileTransaction(pool as never,P,async db=>{await db.query('SET LOCAL ROLE commerce_api');await db.query("SELECT set_config('app.environment','REAL',true)");
  return writeReceiptPolicy(db,'REAL',v.id,{expectedRevision:revision,override:{automaticApproval}},ownerId,randomUUID());});
 await rules(0,true);
 const number=await withTransaction(async c=>{await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[P]);
  return(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','channel_account',$2) RETURNING id",[P,{name:'Ventas recibos',provider:'waha',gateway_ref:'lab-'+randomUUID(),status:'WORKING',sending_enabled:true,identity_verified:true}])).rows[0].id as string;});
 data(await call('owner','POST',`/v2/variants/${v.id}/numbers`,{account_id:number,sell:true}));
 const estimate=data(await call('owner','POST','/v2/number-tests/estimate',{account_id:number,mode:'CHAT'}));
 const run=data(await call('owner','POST','/v2/number-tests',{account_id:number,mode:'CHAT',accepted_maximum_microusd:estimate.maximum_microusd}),201);
 // Rules changed after the start do not apply to this test (RF-19.b/m).
 await rules(1,false);
 const step=async(action:unknown)=>{const before=data(await call('owner','GET',`/v2/number-tests/${run.run_id}`));
  data(await call('owner','POST',`/v2/number-tests/${run.run_id}/actions`,{expected_version:before.run.version,action}),202);await tick();
  const after=data(await call('owner','GET',`/v2/number-tests/${run.run_id}`));expect(after.pending).toBe(false);return after;};
 await step({type:'message',text:'Hola, quiero el taller'});await step({type:'continue'});
 let view=await step({type:'message',text:'Sí, acepto'});
 expect(view.conversation.waiting_for).toBe('receipt_approved');

 // Upload: images or PDF only, checked by signature; the same bytes twice are one attachment.
 const png=(seed:string)=>Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from(seed.padEnd(64,'.'))]);
 expect((await call('owner','POST',`/v2/number-tests/${run.run_id}/attachments`,{mime_type:'image/png',base64:Buffer.from('not an image').toString('base64')})).statusCode).toBe(400);
 const wrong=data(await call('owner','POST',`/v2/number-tests/${run.run_id}/attachments`,{mime_type:'image/png',base64:png('wrong amount').toString('base64')}),201);
 expect(data(await call('owner','POST',`/v2/number-tests/${run.run_id}/attachments`,{mime_type:'image/png',base64:png('wrong amount').toString('base64')})).attachment_id).toBe(wrong.attachment_id);
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:MX.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(view.run.virtual_now));
 const document=(amount:number)=>({is_receipt:true,amount_minor:amount,currency:'MXN',destination_suffix:'5971',bank:'Banco sintético',reference:'REF-0001',status:'completed',confidence:0.97,contradictions:[],
  destination:'012180000118359716',beneficiary:'Titular sintético',paid_on:today,concept:null});

 // 1) A receipt for less than the price: read with the profile's key and left
 // to a person, with the same reason production would give.
 visionDocument=document(5000);const callsBefore=visionCalls;
 view=await step({type:'receipt',attachment_id:wrong.attachment_id});
 expect(visionCalls).toBe(callsBefore+1);
 const first=view.conversation.transcript.findLast((e:{kind:string})=>e.kind==='receipt');
 expect(first).toMatchObject({from:'customer',kind:'receipt',status:'HUMAN_REVIEW',attachment_id:wrong.attachment_id,mime:'image/png'});
 expect(first.explanation).toContain('El monto no coincide con el precio');
 expect(first.explanation).toContain('una prueba no usa tu cuenta real');
 // The tester sees the receipt privately and decides it as a person would.
 const preview=await call('owner','GET',`/v2/number-tests/${run.run_id}/attachments/${wrong.attachment_id}?environment=REAL`);
 expect(preview.statusCode).toBe(200);expect(preview.headers['content-type']).toContain('image/png');expect(preview.rawPayload.equals(png('wrong amount'))).toBe(true);
 view=await step({type:'review_receipt',receipt_id:first.receipt_id,decision:'REJECTED',reason:'El monto no corresponde'});
 expect(view.conversation.transcript.findLast((e:{kind:string})=>e.kind==='receipt')).toMatchObject({status:'REJECTED'});

 // 2) The right receipt: approved by the captured rules (automatic approval was
 // on at start) and the purchase is delivered, simulated only.
 const right=data(await call('owner','POST',`/v2/number-tests/${run.run_id}/attachments`,{mime_type:'image/png',base64:png('right amount').toString('base64')}),201);
 visionDocument=document(9700);
 view=await step({type:'receipt',attachment_id:right.attachment_id});
 const second=view.conversation.transcript.findLast((e:{kind:string})=>e.kind==='receipt');
 expect(second).toMatchObject({status:'APPROVED',attachment_id:right.attachment_id});
 expect(second.explanation).toContain('Aprobado');
 expect(view.conversation.transcript.at(-1)).toMatchObject({from:'business',text:expect.stringContaining('Recibimos tu pago')});
 // The purchase is delivered in the next visible step (simulated, never sent).
 view=await step({type:'continue'});
 expect(view.conversation.transcript.some((e:{from:string;material:string|null})=>e.from==='business'&&e.material==='Acceso taller')).toBe(true);
 expect(data(await call('owner','GET',`/v2/number-tests/${run.run_id}/attachments`)).map((a:{attachment_id:string})=>a.attachment_id)).toEqual([wrong.attachment_id,right.attachment_id]);
 // The reading is a laboratory attempt in the profile's budget (RF-19.l).
 const attempts=await withTransaction(async c=>(await c.query("SELECT task,state FROM ai_attempts WHERE workspace_id=$1 AND task='laboratory.vision'",[P])).rows);
 expect(attempts).toEqual([{task:'laboratory.vision',state:'SUCCEEDED'},{task:'laboratory.vision',state:'SUCCEEDED'}]);
 // Another run's attachment is not served.
 expect((await call('owner','GET',`/v2/number-tests/${randomUUID()}/attachments/${right.attachment_id}?environment=REAL`)).statusCode).toBe(404);

 // RF-19.o: the whole test exports as JSON while it is kept (no receipt bytes,
 // no payment data, no secrets).
 const exported=await call('operator','GET',`/v2/number-tests/${run.run_id}/export?environment=REAL`);
 expect(exported.statusCode,exported.body).toBe(200);expect(String(exported.headers['content-disposition'])).toContain(`prueba-${run.run_id}.json`);
 const doc=JSON.parse(exported.body);
 expect(doc).toMatchObject({schema_version:1,kind:'commerce-os.number-test',retention:{days:30},run:{run_id:run.run_id}});
 expect(doc.conversation.transcript.filter((e:{kind:string})=>e.kind==='receipt')).toHaveLength(2);
 expect(doc.attachments.map((a:{attachment_id:string})=>a.attachment_id)).toEqual([wrong.attachment_id,right.attachment_id]);
 expect(exported.body).not.toContain('01218000011835971');expect(exported.body).not.toContain('base64');expect(exported.body).not.toContain('sk-ant');
 // After 30 days the platform maintenance (cluster owner) shreds the content:
 // the engine rows and receipts go, AI accounting stays.
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});await admin.connect();
 const engineUrl=new URL(process.env.DATABASE_URL!);engineUrl.pathname='/'+engineDatabase;const engine=new pg.Client({connectionString:engineUrl.toString()});await engine.connect();
 try{
  await admin.query('BEGIN');await admin.query("SET LOCAL session_replication_role=replica");
  await admin.query("UPDATE commerce_number_lab.runs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[run.run_id]);await admin.query('COMMIT');
  await engine.query('BEGIN');await engine.query("SET LOCAL session_replication_role=replica");
  await engine.query("UPDATE commerce_number_lab_engine.executions SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE run_id=$1",[run.run_id]);await engine.query('COMMIT');
  const shredded=(await admin.query('SELECT run_id::text,operations,attachment_keys FROM commerce_number_lab.purge_expired_runs(10)')).rows;
  expect(shredded).toEqual([{run_id:run.run_id,operations:expect.any(Number),attachment_keys:[wrong.attachment_id+'-'+wrong.sha256,right.attachment_id+'-'+right.sha256].sort()}]);
  expect((await admin.query('SELECT count(*)::int n FROM commerce_number_lab.purge_expired_runs(10)')).rows[0].n).toBe(0);
  const removed=(await engine.query('SELECT commerce_number_lab_engine.purge_run($1::uuid) n',[run.run_id])).rows[0].n;expect(removed).toBeGreaterThan(10);
  expect((await engine.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1",['number-lab:'+run.run_id])).rows[0].n).toBe(0);
  expect((await admin.query('SELECT count(*)::int n FROM commerce_number_lab.attachments WHERE run_id=$1',[run.run_id])).rows[0].n).toBe(0);
  // An application role cannot run the purge.
  await admin.query('BEGIN');await admin.query('SET LOCAL ROLE commerce_api');
  await expect(admin.query('SELECT * FROM commerce_number_lab.purge_expired_runs(1)')).rejects.toThrow(/permission denied/);await admin.query('ROLLBACK');
  expect((await withTransaction(async c=>(await c.query("SELECT count(*)::int n FROM ai_attempts WHERE workspace_id=$1 AND task='laboratory.vision'",[P])).rows[0].n))).toBe(2);
 }finally{await admin.end();await engine.end();}
 const gone=data(await call('operator','GET',`/v2/number-tests/${run.run_id}`));
 expect(gone).toMatchObject({expired:true,run:{state_label:'Vencida'},conversation:{transcript:[],next_step:{action:'restart'}}});
 expect((await call('operator','GET',`/v2/number-tests/${run.run_id}/export?environment=REAL`)).statusCode).toBe(410);
 expect((await call('operator','GET',`/v2/number-tests/${run.run_id}/attachments/${right.attachment_id}?environment=REAL`)).statusCode).toBe(410);
 expect(data(await call('operator','GET',`/v2/number-tests/latest?account_id=${number}`))).toBeNull();
},240000);

it('explains before starting what blocks a test or leaves part of it out, with the screen that fixes it (RF-19.i)',async()=>{
 const account=(name:string)=>withTransaction(async c=>{await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[P]);
  return(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','channel_account',$2) RETURNING id",[P,{name,provider:'waha',gateway_ref:'lab-'+randomUUID(),status:'WORKING',sending_enabled:true,identity_verified:true}])).rows[0].id as string;});
 // A number that sells nothing cannot be tested; the link goes to Products.
 const idle=await account('Sin venta');
 const empty=data(await call('operator','GET',`/v2/number-tests/diagnose?account_id=${idle}`));
 expect(empty.ready).toBe(false);
 expect(empty.problems).toEqual(expect.arrayContaining([expect.objectContaining({code:'LAB_ASSIGNMENT_COVERAGE',severity:'BLOCKING',fix:{label:expect.any(String),href:'/products'}})]));
 // A variant with changes not yet published can be tested, with a warning
 // that points to the variant (the test uses what is published).
 const link=data(await call('owner','POST','/v2/materials?environment=REAL',{name:'Acceso diagnóstico',kind:'link',url:'https://example.com/diag'}),201).id as string;
 let v=data(await call('owner','POST','/v2/products',{name:'Diagnóstico',variant:{name:'México',locale:MX}}),201).variant;
 v=data(await call('owner','PUT',`/v2/variants/${v.id}/offer`,{expected_version:v.version,value:{...v.document.offer,price_minor:12300,fulfillment:[{asset_id:link,release_on:'receipt_approved'}]}}));
 v=data(await call('owner','PUT',`/v2/variants/${v.id}/collection`,{expected_version:v.version,value:{spei:{bank:'Banco sintético',holder:'Titular sintético',clabe:clabe('01218000011835971')},links:[],instructions:''}}));
 data(await call('owner','POST',`/v2/variants/${v.id}/publish`,{expected_version:v.version,document_sha256:v.document_sha256}));
 const selling=await account('Con venta');data(await call('owner','POST',`/v2/variants/${v.id}/numbers`,{account_id:selling,sell:true}));
 v=data(await call('owner','GET',`/v2/variants/${v.id}`));
 data(await call('owner','PUT',`/v2/variants/${v.id}/offer`,{expected_version:v.version,value:{...v.document.offer,price_minor:12900}}));
 const warned=data(await call('operator','GET',`/v2/number-tests/diagnose?account_id=${selling}`));
 expect(warned.ready).toBe(true);
 expect(warned.problems).toEqual([expect.objectContaining({code:'LAB_UNPUBLISHED_CHANGES',severity:'WARNING',variant_name:'Diagnóstico · México',fix:{label:'Publicar los cambios',href:`/products/${v.product.id}/variants/${v.id}/sale`}})]);
 expect((await call('operator','GET',`/v2/number-tests/diagnose?account_id=${randomUUID()}`)).statusCode).toBe(404);
},120000);

it('runs the automatic buyer over every variant of a number and reports one verdict per variant (RF-19.p/h)',async()=>{
 const link=data(await call('owner','POST','/v2/materials?environment=REAL',{name:'Acceso suite',kind:'link',url:'https://example.com/suite'}),201).id as string;
 let v=data(await call('owner','POST','/v2/products',{name:'Suite',variant:{name:'México',locale:MX}}),201).variant;
 v=data(await call('owner','PUT',`/v2/variants/${v.id}/offer`,{expected_version:v.version,value:{...v.document.offer,price_minor:4500,fulfillment:[{asset_id:link,release_on:'receipt_approved'}]}}));
 v=data(await call('owner','PUT',`/v2/variants/${v.id}/collection`,{expected_version:v.version,value:{spei:{bank:'Banco sintético',holder:'Titular sintético',clabe:clabe('01218000011835971')},links:[],instructions:''}}));
 v=data(await call('owner','PUT',`/v2/variants/${v.id}/remarketing`,{expected_version:v.version,value:{schema_version:1,policy_id:'remarketing-3-slot',policy_revision:1,window:{start_hour:0,end_hour:24},
  slots:[1,2,3].map((position,i)=>({id:'slot-'+position,position,enabled:position===1,delay:{quantity:[2,8,24][i],unit:'hours'},stages:{awaiting_agreement:{medium:'text',text:`¿Seguimos? (${position})`},awaiting_payment:{medium:'text',text:`¿Pagas? (${position})`}}}))}}));
 data(await call('owner','POST',`/v2/variants/${v.id}/publish`,{expected_version:v.version,document_sha256:v.document_sha256}));
 await withProfileTransaction(pool as never,P,async db=>{await db.query('SET LOCAL ROLE commerce_api');await db.query("SELECT set_config('app.environment','REAL',true)");
  return writeReceiptPolicy(db,'REAL',v.id,{expectedRevision:0,override:{automaticApproval:true}},ownerId,randomUUID());});
 const number=await withTransaction(async c=>{await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[P]);
  return(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','channel_account',$2) RETURNING id",[P,{name:'Ventas suite',provider:'waha',gateway_ref:'lab-'+randomUUID(),status:'WORKING',sending_enabled:true,identity_verified:true}])).rows[0].id as string;});
 data(await call('owner','POST',`/v2/variants/${v.id}/numbers`,{account_id:number,sell:true}));
 const before=await footprint();
 // Estimate first: two journeys per variant, each with its own ceiling, paid by the profile's key.
 const estimate=data(await call('owner','POST','/v2/number-tests/suites/estimate',{account_id:number}));
 expect(estimate).toMatchObject({currency:'USD',paid_by:'PROFILE_KEY'});
 expect(estimate.cases.map((c:{journey:string;name:string})=>[c.name,c.journey])).toEqual([['Suite · México','PURCHASE'],['Suite · México','FOLLOWUP']]);
 expect((await call('owner','POST','/v2/number-tests/suites',{account_id:number,accepted_maximum_microusd:1})).statusCode).toBe(409);
 const key=randomUUID();
 const started=data(await call('owner','POST','/v2/number-tests/suites',{account_id:number,accepted_maximum_microusd:estimate.maximum_microusd},key),201);
 expect(data(await call('owner','POST','/v2/number-tests/suites',{account_id:number,accepted_maximum_microusd:estimate.maximum_microusd},key)).suite_id).toBe(started.suite_id);
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:MX.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 visionDocument={is_receipt:true,amount_minor:4500,currency:'MXN',destination_suffix:'0000',bank:'Banco de prueba',reference:'LAB-0001',status:'completed',confidence:0.97,contradictions:[],destination:'012180000000000000',beneficiary:'Negocio de prueba',paid_on:today,concept:'Compra de prueba'};
 const reads=visionCalls;
 let report:any;
 for(let i=0;i<40;i++){await processNumberLabOperations(runtime);report=data(await call('owner','GET',`/v2/number-tests/suites/${started.suite_id}`));if(report.suite.state==='COMPLETED')break;}
 expect(report.suite.state,JSON.stringify(report.variants)).toBe('COMPLETED');
 expect(report.variants).toEqual([expect.objectContaining({variant_id:v.id,name:'Suite · México',verdict:'RESPONDE_BIEN',verdict_label:'Responde bien'})]);
 const [purchase,followup]=[report.variants[0].cases.find((c:{journey:string})=>c.journey==='PURCHASE'),report.variants[0].cases.find((c:{journey:string})=>c.journey==='FOLLOWUP')];
 expect(purchase.checks.map((c:{name:string;state:string})=>[c.name,c.state]).sort()).toEqual([['collection','PASSED'],['delivery','PASSED'],['exclusion','PASSED'],['offer','PASSED'],['receipt','PASSED'],['route','PASSED']]);
 expect(followup.checks.find((c:{name:string})=>c.name==='followup')).toMatchObject({state:'PASSED',label:'Da seguimiento si el cliente no responde'});
 // The synthetic receipt was read once with the profile's key.
 expect(visionCalls).toBe(reads+1);
 // Each journey is a normal isolated run: its conversation can be read, not driven by hand.
 const transcript=data(await call('owner','GET',`/v2/number-tests/${purchase.run_id}`)).conversation.transcript;
 expect(transcript.some((e:{kind:string;status:string})=>e.kind==='receipt'&&e.status==='APPROVED')).toBe(true);
 expect((await call('owner','POST',`/v2/number-tests/${purchase.run_id}/actions`,{expected_version:1,action:{type:'continue'}})).statusCode).toBe(409);
 expect(data(await call('owner','GET',`/v2/number-tests/suites/latest?account_id=${number}`)).suite.suite_id).toBe(started.suite_id);
 expect(await footprint()).toEqual(before);
},240000);
