import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,withTransaction,readOperationalSettings,writeOperationalSettings} from '../../packages/db/src/index.js';
import {materializeMessage} from '../../apps/automation-worker/src/inbound.js';
import {advanceWorkflow,processTimers} from '../../apps/automation-worker/src/workflows.js';
import type {DomainRecord} from '../../packages/contracts/src/index.js';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {roleExecutor} from '../support/database-role.js';

// V7 F5 (RF-10.b/d/f, REM-SCHEDULE, REM-TIME, REM-STOP): a variant's text
// reminders are scheduled from the confirmed agreement message, only inside the
// variant's local hours, at most as many as are active, and stop when the
// customer replies. Nothing leaves the outbox (no provider is configured).
const P='remarketing-'+randomUUID();
const origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
const withRole=roleExecutor(pool);
let app:Awaited<ReturnType<typeof createApp>>;const cookies:Record<string,string>={};
const call=(method:string,path:string,body?:unknown)=>app.inject({method:method as 'GET',url:path+(path.includes('?')?'&':'?')+'environment=REAL',payload:body as object,headers:{origin,cookie:cookies.owner!,'idempotency-key':randomUUID()}});
const data=(r:{statusCode:number;body:string;json():any},status=200)=>{expect(r.statusCode,r.body).toBe(status);return r.json().data;};
async function inProfile<T>(work:(c:import('pg').PoolClient)=>Promise<T>){
 const c=await pool.connect();
 try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[P]);const r=await work(c);await c.query('COMMIT');return r;}
 catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
function clabe(prefix17:string){const w=[3,7,1];let s=0;for(let i=0;i<17;i++)s+=(Number(prefix17[i])*w[i%3]!)%10;return prefix17+String((10-(s%10))%10);}
const MX={market:'México',country:'MX',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'};
const localHour=()=>Number(new Intl.DateTimeFormat('en-US',{timeZone:MX.timezone,hourCycle:'h23',hour:'2-digit'}).format(new Date()))%24;
beforeAll(async()=>{
 await fixtureProfiles({id:P,numbers:5});app=await createApp();
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Dueña',email,password,workspace_id:P,role:'owner'});
 const r=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});
 cookies.owner=[r.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');
 await withTransaction(async c=>{await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[P]);const s=await readOperationalSettings(c,P,'REAL');
  await writeOperationalSettings(c,P,'REAL',s.version,{...s.body,dispatch_frozen:false,real_sends_enabled:true,allow_real_operations:true},'synthetic-remarketing');});
});
afterAll(async()=>{await app.close();await pool.end();});
const worker=<T>(work:(c:import('pg').PoolClient)=>Promise<T>)=>withRole('commerce_automation',()=>withTransaction(work));
const record=(id:string)=>inProfile(async c=>(await c.query('SELECT * FROM records WHERE workspace_id=$1 AND id=$2',[P,id])).rows[0] as DomainRecord);
const policy=(window:{start_hour:number;end_hour:number})=>({schema_version:1,policy_id:'remarketing-3-slot',policy_revision:1,window,slots:[1,2,3].map((position,i)=>({id:'slot-'+position,position,enabled:position<=2,
 ...(position>1?{warning_acknowledged:true}:{}),delay:{quantity:[2,8,24][i],unit:'hours'},stages:{awaiting_agreement:{medium:'text',text:`Recordatorio ${position}: ¿te interesa el curso?`},awaiting_payment:{medium:'text',text:`Pago ${position}:\n{{bank_instructions}}`}}}))});
/** The customer writes and the offer and agreement go out (confirmed by the provider). */
async function waitingForAgreement(number:DomainRecord,identity:string){
 const conversation=(await withRole('commerce_automation',()=>withTransaction(c=>materializeMessage(c,number,{key:randomUUID(),type:'message',providerAt:new Date().toISOString(),identity,kind:'text',text:'Hola',payload:{}},randomUUID()))))!;
 await worker(c=>advanceWorkflow(c,conversation));
 expect((await record(conversation.id)).body.flow_state).toMatchObject({status:'WAITING',waiting_for:'commitment'});
 await inProfile(c=>c.query("UPDATE outbox SET status='SENT',provider_message_id='accepted:'||id::text,result=jsonb_build_object('accepted_at',now()),updated_at=now() WHERE workspace_id=$1 AND conversation_id=$2",[P,conversation.id]));
 await withRole('commerce_automation',()=>processTimers(25));
 return conversation;
}
const timersOf=(conversation:string)=>inProfile(async c=>(await c.query("SELECT id,status,due_at,payload FROM timers WHERE workspace_id=$1 AND conversation_id=$2 AND kind='followup' ORDER BY due_at",[P,conversation])).rows);

it('schedules text reminders inside the variant hours and stops them when the customer replies',async()=>{
 const material=await inProfile(async c=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','asset',$2) RETURNING id",[P,{name:'Guía',kind:'link',url:'https://example.com/g',status:'READY'}])).rows[0].id);
 let v=data(await call('POST','/v2/products',{name:'Curso',variant:{name:'México',locale:MX}}),201).variant;
 v=data(await call('PUT',`/v2/variants/${v.id}/offer`,{expected_version:v.version,value:{...v.document.offer,price_minor:9700,fulfillment:[{asset_id:material,release_on:'receipt_approved'}]}}));
 v=data(await call('PUT',`/v2/variants/${v.id}/collection`,{expected_version:v.version,value:{spei:{bank:'Banco sintético',holder:'Titular sintético',clabe:clabe('01218000011835971')},links:[],instructions:''}}));
 // A window that excludes the current local hour.
 const h=localHour(),closed=h<23?{start_hour:h+1,end_hour:24}:{start_hour:0,end_hour:23};
 v=data(await call('PUT',`/v2/variants/${v.id}/remarketing`,{expected_version:v.version,value:policy(closed)}));
 expect(v.document.remarketing.window).toEqual(closed);
 const released=data(await call('POST',`/v2/variants/${v.id}/publish`,{expected_version:v.version,document_sha256:v.document_sha256}));
 const offer=await inProfile(async c=>(await c.query("SELECT body FROM market_releases WHERE id=$1",[released.release.id])).rows[0].body.configuration.offer.id);
 const sales=(await record(offer)).body.sales_flow.remarketing;
 expect(sales.window).toEqual({...closed,timezone:'America/Mexico_City'});
 const number=await inProfile(async c=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','channel_account',$2) RETURNING *",[P,{name:'Ventas',provider:'waha',gateway_ref:'rem-'+randomUUID(),status:'WORKING',sending_enabled:true,identity_verified:true}])).rows[0]);
 data(await call('POST',`/v2/variants/${v.id}/numbers`,{account_id:number.id,sell:true}));

 // Two active reminders (the shared maximum), each due inside the window.
 const first=await waitingForAgreement(number,'opaque:rem-1');
 const scheduled=await timersOf(first.id);
 expect(scheduled).toHaveLength(2);
 for(const t of scheduled){
  expect(t.payload).toMatchObject({medium:'text',stage:'AGREEMENT',window:{...closed,timezone:'America/Mexico_City'}});
  const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:MX.timezone,hourCycle:'h23',hour:'2-digit'}).format(new Date(t.due_at)))%24;
  expect(hour>=closed.start_hour&&hour<closed.end_hour).toBe(true);
 }
 const cycle=await inProfile(async c=>(await c.query('SELECT max_attempts FROM commercial_remarketing_cycles WHERE workspace_id=$1 AND source_conversation_id=$2',[P,first.id])).rows[0]);
 expect(cycle.max_attempts).toBe(2);
 // Due now but outside the hours: it waits for the next allowed moment, unsent.
 await inProfile(c=>c.query("UPDATE timers SET due_at=now()-interval '1 second' WHERE id=$1",[scheduled[0].id]));
 await withRole('commerce_automation',()=>processTimers(25));
 const moved=(await timersOf(first.id)).find(t=>t.id===scheduled[0].id);
 expect(moved.status).toBe('PENDING');expect(new Date(moved.due_at).getTime()).toBeGreaterThan(Date.now());
 expect(await inProfile(async c=>(await c.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 AND payload->>'purpose'='remarketing'",[P,first.id])).rows[0].n)).toBe(0);

 // A variant open at this hour sends the text reminder (one message, no media).
 const draft=data(await call('GET',`/v2/variants/${v.id}`));
 const open=data(await call('PUT',`/v2/variants/${v.id}/remarketing`,{expected_version:draft.version,value:policy({start_hour:0,end_hour:24})}));
 data(await call('POST',`/v2/variants/${v.id}/publish`,{expected_version:open.version,document_sha256:open.document_sha256}));
 const second=await waitingForAgreement(number,'opaque:rem-2');
 const due=await timersOf(second.id);expect(due).toHaveLength(2);
 await inProfile(c=>c.query("UPDATE timers SET due_at=now()-interval '1 second' WHERE id=$1",[due[0].id]));
 await withRole('commerce_automation',()=>processTimers(25));
 const sent=await inProfile(async c=>(await c.query("SELECT kind,payload FROM outbox WHERE workspace_id=$1 AND conversation_id=$2 AND payload->>'purpose'='remarketing'",[P,second.id])).rows);
 expect(sent).toHaveLength(1);expect(sent[0].payload.kind).toBe('text');expect(sent[0].payload.asset_id).toBeUndefined();expect(sent[0].payload.text).toBe('Recordatorio 1: ¿te interesa el curso?');
 expect(await inProfile(async c=>(await c.query("SELECT status FROM commercial_remarketing_attempts WHERE workspace_id=$1 AND conversation_id=$2",[P,second.id])).rows.map(r=>r.status))).toEqual(['PROPOSED']);

 // The provider accepts the reminder (as the dispatcher records it).
 await inProfile(c=>c.query("UPDATE outbox SET status='SENT',provider_message_id='accepted:'||id::text,result=jsonb_build_object('accepted_at',now()),updated_at=now() WHERE workspace_id=$1 AND conversation_id=$2 AND payload->>'purpose'='remarketing'",[P,second.id]));
 // The customer replies: the pending reminder is cancelled with its reason.
 await withRole('commerce_automation',()=>withTransaction(c=>materializeMessage(c,number,{key:randomUUID(),type:'message',providerAt:new Date().toISOString(),identity:'opaque:rem-2',kind:'text',text:'Lo pienso',payload:{}},randomUUID())));
 const after=await timersOf(second.id);
 expect(after.find(t=>t.id===due[1].id).status).toBe('CANCELLED');
 // RF-10.e: the variant's follow-up results for the day.
 const today=new Date().toISOString().slice(0,10);
 const results=data(await call('GET',`/v2/variants/${v.id}/remarketing/results?from=${today}&to=${today}`));
 expect(results).toMatchObject({entered:2,reached:1,messages:{sent:1,uncertain:0},replied:1,opted_out:0,recovered_sales:0,recovered_revenue:[]});
 expect(results.entered_by_stage).toEqual({AGREEMENT:2,COLLECTION:0});
 // An earlier period is empty.
 expect(data(await call('GET',`/v2/variants/${v.id}/remarketing/results?from=2020-01-01&to=2020-01-31`))).toMatchObject({entered:0,reached:0,replied:0});
},180000);
