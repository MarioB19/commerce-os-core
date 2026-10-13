import {afterAll,beforeAll,expect,it} from 'vitest';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,withTransaction,encrypt,readOperationalSettings,writeOperationalSettings} from '../../packages/db/src/index.js';
import {createProfileWorkerRuntime} from '../../packages/db/src/profile-worker-scope.js';
import {materializeMessage} from '../../apps/automation-worker/src/inbound.js';
import {ensureOrder,advanceWorkflow} from '../../apps/automation-worker/src/workflows.js';
import {applyCommand,processCommands} from '../../apps/automation-worker/src/commands.js';
import {processVariantReceipts,privateReceiptMedia} from '../../apps/automation-worker/src/variant-receipts.js';
import {saveAiPreferences,saveAiKey,verifyAiKey,aiCredentialKey} from '../../packages/ai-providers/src/profile-integrations.js';
import {withProfileTransaction} from '../../packages/db/src/profile-context.js';
import {readReceiptPolicy,writeReceiptPolicy} from '../../packages/db/src/receipt-policies.js';
import type {ProfileAuthority} from '../../packages/domain/src/core/profile-authorization.js';
import type {DomainRecord} from '../../packages/contracts/src/index.js';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {roleExecutor} from '../support/database-role.js';

// V7 F5 (RF-09.a/f/g, RF-08.a, RF-14.c, PAY-SPEI, PAY-CONFIDENCE): a sale of a
// published variant from the first message to the delivered material. The
// profile gets the default receipt policy (human approval) with its first
// product; each order captures the policy current at its creation; the
// variant's own `receipt.document` grant reads the receipt with the
// business's key (a contract fake: no real key or provider); the policy, not
// the model, decides. Without the owner's grant a person reviews the receipt.
const P='variant-sale-'+randomUUID();
const origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
const withRole=roleExecutor(pool),aiKey=aiCredentialKey();
let app:Awaited<ReturnType<typeof createApp>>,aiPool:pg.Pool,automation:pg.Pool,api:pg.Pool,root='',ownerId='';const cookies:Record<string,string>={};
const call=(who:string,method:string,path:string,body?:unknown)=>app.inject({method:method as 'GET',url:path+(path.includes('?')?'&':'?')+'environment=REAL',payload:body as object,headers:{origin,cookie:cookies[who]!,'idempotency-key':randomUUID()}});
const data=(r:{statusCode:number;body:string;json():any},status=200)=>{expect(r.statusCode,r.body).toBe(status);return r.json().data;};
async function inProfile<T>(work:(c:pg.PoolClient)=>Promise<T>){
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
function clabe(prefix17:string){const w=[3,7,1];let s=0;for(let i=0;i<17;i++)s+=(Number(prefix17[i])*w[i%3]!)%10;return prefix17+String((10-(s%10))%10);}
const ACCOUNT=clabe('01218000011835971'),HOLDER='Titular Sintético';
let providerCalls=0,extraction:Record<string,unknown>={};
const fakeAnthropic:typeof fetch=async(_input,init)=>{
 const body=JSON.parse(String(init?.body)),verification=body.system==='Return exactly OK. Do not call tools.';if(!verification)providerCalls++;
 return new Response(JSON.stringify({id:'msg_synthetic',type:'message',role:'assistant',model:'claude-haiku-5-5',content:[{type:'text',text:verification?'OK':JSON.stringify(extraction)}],stop_reason:'end_turn',
  usage:{input_tokens:1500,output_tokens:120,service_tier:'standard'}}),{status:200,headers:{'content-type':'application/json'}});
};
beforeAll(async()=>{
 root=await mkdtemp(join(tmpdir(),'v7-sale-'));await mkdir(join(root,'assets'));
 await fixtureProfiles({id:P,numbers:5});app=await createApp();ownerId=(await login('owner','owner')).id;await login('operator','operator');
 aiPool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3});aiPool.on('connect',c=>{void c.query('SET ROLE commerce_ai');});
 automation=new pg.Pool({connectionString:process.env.DATABASE_URL,max:3});automation.on('connect',c=>{void c.query('SET ROLE commerce_automation');});
 api=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2});api.on('connect',c=>{void c.query('SET ROLE commerce_api');});
 const authority:ProfileAuthority={profile:{id:P,state:'ACTIVE'},membership:{userId:ownerId,workspaceId:P,role:'owner',active:true,version:1},
  credential:{kind:'session',userId:ownerId,workspaceId:P,revoked:false,expiresAt:new Date(Date.now()+3600000).toISOString(),scopes:[],membershipVersion:1}};
 const owned=<T>(work:(db:import('../../packages/db/src/profile-context.js').ProfileExecutor)=>Promise<T>)=>withProfileTransaction(pool as never,P,async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");return work(db);});
 await owned(db=>saveAiPreferences(db,authority,{environment:'REAL',expectedVersion:0,defaultProvider:'anthropic',defaultModel:'claude-haiku-5-5',monthlyLimitMicrousd:5_000_000}));
 const saved=await owned(db=>saveAiKey(db,authority,{operationId:randomUUID(),environment:'REAL',provider:'anthropic',expectedRevision:0,key:'sk-ant-synthetic-key-0000'},aiKey));
 expect(await verifyAiKey({pool:aiPool as never,key:aiKey,fetcher:fakeAnthropic},saved.verification!)).toEqual({state:'VERIFIED'});
 // Real operation of the profile is on (the owner's standing setting); sends stay in the outbox.
 await withTransaction(async c=>{await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[P]);const s=await readOperationalSettings(c,P,'REAL');
  await writeOperationalSettings(c,P,'REAL',s.version,{...s.body,dispatch_frozen:false,real_sends_enabled:true,allow_real_operations:true},'synthetic-sale');});
 const {openAiBudgets,resetAiBudgetCadenceForTests}=await import('../../apps/automation-worker/src/ai-budgets.js');resetAiBudgetCadenceForTests();await withRole('commerce_automation',()=>openAiBudgets());
});
afterAll(async()=>{await aiPool.end();await automation.end();await api.end();await app.close();await pool.end();await rm(root,{recursive:true,force:true});});

/** The receipt-policy API runs as commerce_api in production (the app here uses the owner). */
const asApi=<T>(work:(db:import('../../packages/db/src/profile-context.js').ProfileExecutor)=>Promise<T>)=>withProfileTransaction(api as never,P,async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");return work(db);});
const worker=<T>(work:(c:import('pg').PoolClient)=>Promise<T>)=>withRole('commerce_automation',()=>withTransaction(work));
const record=(id:string)=>inProfile(async c=>(await c.query('SELECT * FROM records WHERE workspace_id=$1 AND id=$2',[P,id])).rows[0] as DomainRecord);
/** The customer writes, the conversation-sale flow offers and asks for the
 * agreement, the customer accepts and gets the payment details; then sends a
 * receipt image (as the media worker does), stored encrypted. */
async function customerPays(number:DomainRecord,identity:string,image:Buffer){
 const say=(text:string)=>withRole('commerce_automation',()=>withTransaction(c=>materializeMessage(c,number,{key:randomUUID(),type:'message',providerAt:new Date().toISOString(),identity,kind:'text',text,payload:{}},randomUUID())));
 let conversation=(await say('Hola, quiero el curso'))!;
 await worker(c=>advanceWorkflow(c,conversation));
 expect((await record(conversation.id)).body.flow_state).toMatchObject({status:'WAITING',waiting_for:'commitment'});
 conversation=(await say('Sí, acepto'))!;
 const waiting=await record(conversation.id);expect(waiting.body.flow_state).toMatchObject({status:'WAITING',waiting_for:'receipt_approved'});
 const texts=await inProfile(async c=>(await c.query("SELECT payload->>'text' text FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 ORDER BY created_at",[P,conversation.id])).rows.map(r=>String(r.text)));
 expect(texts.some(t=>t.includes('97.00'))).toBe(true);expect(texts.some(t=>t.includes('CLABE '+ACCOUNT)&&t.includes(HOLDER))).toBe(true);
 const order=(await worker(c=>ensureOrder(c,waiting)))!;
 const sha=createHash('sha256').update(image).digest('hex'),key=`${randomUUID()}-${sha}`;
 await writeFile(join(root,'assets',`${key}.enc`),encrypt(image.toString('base64')));
 const asset=await inProfile(async c=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','asset',$2) RETURNING id",[P,{name:'Comprobante',kind:'file',status:'READY',storage_key:key,sha256:sha,mime_type:'image/png',size_bytes:image.length}])).rows[0].id as string);
 const result=await worker(c=>applyCommand(c,{id:randomUUID(),workspace_id:P,environment:'REAL',kind:'conversation_command',resource_id:conversation.id,payload:{type:'receipt_received',asset_id:asset}} as never)) as {receipt_id:string};
 return{conversation,order,receipt:result.receipt_id};
}
const analyze=()=>processVariantReceipts(3,{workers:createProfileWorkerRuntime(automation as never,'commerce_automation','REAL'),aiPool,custodyKey:aiKey,fetcher:fakeAnthropic,media:privateReceiptMedia(root)});

it('sells a variant from the first message to the delivered material',async()=>{
 const material=await inProfile(async c=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','asset',$2) RETURNING id",[P,{name:'Guía',kind:'link',url:'https://example.com/guia',status:'READY'}])).rows[0].id);
 // The first product gives the profile its default policy: human approval.
 let v=data(await call('operator','POST','/v2/products',{name:'Curso',variant:{name:'México',locale:{market:'México',country:'MX',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'}}}),201).variant;
 const policy=await asApi(db=>readReceiptPolicy(db,'REAL',null));
 expect(policy).toMatchObject({variantId:null,ref:{revision:1},body:{automaticApproval:false,failureDisposition:'REVIEW',destination:{mode:'EXACT'}}});
 v=data(await call('operator','PUT',`/v2/variants/${v.id}/offer`,{expected_version:v.version,value:{...v.document.offer,price_minor:9700,fulfillment:[{asset_id:material,release_on:'receipt_approved'}]}}));
 v=data(await call('operator','PUT',`/v2/variants/${v.id}/collection`,{expected_version:v.version,value:{spei:{bank:'Banco sintético',holder:HOLDER,clabe:ACCOUNT},links:[],instructions:''}}));
 data(await call('operator','POST',`/v2/variants/${v.id}/publish`,{expected_version:v.version,document_sha256:v.document_sha256}));
 const number=await inProfile(async c=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','channel_account',$2) RETURNING *",[P,{name:'Ventas',provider:'waha',gateway_ref:'sale-'+randomUUID(),status:'WORKING',sending_enabled:true,identity_verified:true}])).rows[0]);
 data(await call('owner','POST',`/v2/variants/${v.id}/numbers`,{account_id:number.id,sell:true}));
 const paid=async()=>{const at=new Date().toISOString();return{is_receipt:true,amount_minor:9700,currency:'MXN',destination_suffix:ACCOUNT.slice(-4),bank:'Banco sintético',reference:'REF-'+randomUUID().slice(0,8),status:'completed',confidence:0.97,contradictions:[],destination:ACCOUNT,beneficiary:HOLDER,paid_at:at,concept:null};};

 // 1. Published by an operator: no owner grant, so a person reviews the receipt.
 const first=await customerPays(number,'opaque:cliente-1',randomBytes(64));
 const firstOrder=await record(first.order.id);expect(firstOrder.body.receipt_policy_snapshot_sha256).toMatch(/^[a-f0-9]{64}$/);
 await analyze();
 expect((await record(first.receipt)).body).toMatchObject({analysis_status:'HUMAN_REQUIRED',analysis_dependency:'RECEIPT_AI_GRANT_REQUIRED'});expect(providerCalls).toBe(0);

 // 2. The owner confirms the variant's AI: the receipt is read, every rule passes,
 // and the default policy still leaves the approval to a person.
 const confirmed=data(await call('owner','POST',`/v2/variants/${v.id}/ai-authorization`,{}));
 expect(confirmed.minted.map((m:{task:string})=>m.task)).toContain('receipt.document');
 extraction=await paid();
 const second=await customerPays(number,'opaque:cliente-2',randomBytes(64));
 await analyze();expect(providerCalls).toBe(1);
 const reviewed=await record(second.receipt);
 expect(reviewed.body).toMatchObject({status:'HUMAN_REVIEW',analysis_status:'COMPLETED',assessment:{decision:'REVIEW'}});
 expect(JSON.stringify(reviewed.body)).not.toContain(ACCOUNT);expect(JSON.stringify(reviewed.body)).not.toContain(HOLDER);
 const attempt=await inProfile(async c=>(await c.query("SELECT variant_id,conversation_id,state FROM ai_attempts WHERE workspace_id=$1 AND task='receipt.document'",[P])).rows);
 expect(attempt).toEqual([{variant_id:v.id,conversation_id:second.conversation.id,state:'SUCCEEDED'}]);
 // One decision by the owner approves it and delivers the material.
 const decided=await call('owner','POST',`/v1/receipts/${second.receipt}/review`,{decision:'APPROVED',reason:'Comprobante revisado',expected_version:reviewed.version});
 expect(decided.statusCode,decided.body).toBe(202);
 await withRole('commerce_automation',()=>processCommands(10));
 expect((await record(second.receipt)).body.status).toBe('APPROVED');
 expect((await record(second.order.id)).body).toMatchObject({receipt_status:'APPROVED'});
 const delivered=async(conversation:string)=>inProfile(async c=>(await c.query("SELECT payload FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 AND payload->>'asset_id'=$3",[P,conversation,material])).rows.length);
 expect(await delivered(second.conversation.id)).toBe(1);

 // 3. The variant's own rule turns on automatic approval for new orders only.
 expect(await asApi(db=>writeReceiptPolicy(db,'REAL',v.id,{expectedRevision:0,override:{automaticApproval:true}},ownerId,randomUUID()))).toMatchObject({variantId:v.id,ref:{revision:1}});
 extraction=await paid();
 const third=await customerPays(number,'opaque:cliente-3',randomBytes(64));
 await analyze();expect(providerCalls).toBe(2);
 expect((await record(third.receipt)).body).toMatchObject({status:'APPROVED',assessment:{decision:'APPROVED'}});
 expect(await delivered(third.conversation.id)).toBe(1);
 // A wrong amount never approves: it goes to a person with the failed rule.
 extraction={...await paid(),amount_minor:970};
 const fourth=await customerPays(number,'opaque:cliente-4',randomBytes(64));
 await analyze();
 const wrong=await record(fourth.receipt);
 expect(wrong.body.status).toBe('HUMAN_REVIEW');expect(JSON.stringify(wrong.body.assessment.reasons)).toContain('AMOUNT');
 expect(await delivered(fourth.conversation.id)).toBe(0);
 // The second order keeps the policy it captured (human approval).
 const snapshots=await inProfile(async c=>(await c.query('SELECT order_id,body FROM receipt_order_policy_snapshots WHERE workspace_id=$1 ORDER BY created_at',[P])).rows);
 expect(snapshots.find(s=>s.order_id===second.order.id)!.body.policy.automaticApproval).toBe(false);
 expect(snapshots.find(s=>s.order_id===third.order.id)!.body.policy.automaticApproval).toBe(true);
},180000);
