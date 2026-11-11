import {beforeAll,afterAll,it,expect,describe} from 'vitest';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {randomUUID,randomBytes} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,getRecord} from '../../packages/db/src/index.js';
import {commercialWarmupGuard} from '../../packages/db/src/warmup.js';
import {roleExecutor} from '../support/database-role.js';
import {numberLinkState,preparationPhase,PREPARATION_EXPECTED_MS} from '../../packages/db/src/number-link.js';

/** V7.4 A/D/E over the real API, with the API database role. No provider,
 * gateway or message is involved: these are the states the operator reads. */
const withRole=roleExecutor(pool),workspace='v74-journey-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
beforeAll(()=>fixtureProfiles(workspace));
let app:Awaited<ReturnType<typeof createApp>>,cookie:string;
const call=(method:any,path:string,body?:any,key=randomUUID())=>withRole('commerce_api',()=>app.inject({method,url:path+'?environment=REAL',payload:body,headers:{origin,cookie,'idempotency-key':key}}));
const data=(r:any,status=200)=>{expect(r.statusCode,r.body).toBe(status);return r.json().data;};
beforeAll(async()=>{app=await createApp();const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');await provisionUser({name:'V7.4 journey fixture',email,password,workspace_id:workspace,role:'owner'});const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');});
afterAll(async()=>{await app.close();await pool.end();});
const account=async(id:string)=>(await getRecord(pool,workspace,'channel_account',id))!;
const row=async(id:string)=>data(await call('GET','/v1/numbers/overview')).numbers.find((n:any)=>n.id===id);
const provision=async(id:string)=>(await pool.query("SELECT * FROM number_operations WHERE workspace_id=$1 AND action='PROVISION' AND input->>'account_id'=$2",[workspace,id])).rows[0];

describe('V7.4 number journey',()=>{
 it('stores the warm-up choice with the number, before any worker can act, and keeps earlier clients compatible',async()=>{
  const ready=data(await call('POST','/v1/numbers/quick',{alias:'Línea ya preparada',country:'MX',warmup:'ready'}),202);
  expect(ready).toMatchObject({state:'PREPARING',warmup_mode:'DECLARED_READY',warmup_mode_source:'owner_choice'});
  expect((await account(ready.id)).body).toMatchObject({warmup_mode:'DECLARED_READY',warmup_mode_source:'owner_choice',status:'NEW',sending_enabled:false});
  expect((await account(ready.id)).version).toBe(1);
  const warm=data(await call('POST','/v1/numbers/quick',{alias:'Línea por calentar',country:'MX',warmup:'required'}),202);
  expect((await account(warm.id)).body).toMatchObject({warmup_mode:'REQUIRED',warmup_mode_source:'owner_choice'});
  // A client that predates the choice omits it: earlier behaviour, marked as a compatibility default.
  const legacy=data(await call('POST','/v1/numbers/quick',{alias:'Cliente anterior',country:'MX'}),202);
  expect((await account(legacy.id)).body).toMatchObject({warmup_mode:'REQUIRED',warmup_mode_source:'compatibility_default'});
  expect((await call('POST','/v1/numbers/quick',{alias:'Valor inválido',country:'MX',warmup:'maybe'})).statusCode).toBe(400);
  // A replay of the same request neither duplicates the number nor changes the choice.
  const key=randomUUID(),first=data(await call('POST','/v1/numbers/quick',{alias:'Reintento',country:'MX',warmup:'ready'},key),202),again=data(await call('POST','/v1/numbers/quick',{alias:'Reintento',country:'MX',warmup:'ready'},key),202);
  expect(again.id).toBe(first.id);expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind='channel_account' AND body->>'name'='Reintento'",[workspace])).rows[0].n).toBe(1);
  const numbers=data(await call('GET','/v1/numbers/overview')).numbers;
  expect(numbers.find((n:any)=>n.id===ready.id).warmup).toMatchObject({mode:'DECLARED_READY',state:'NOT_REQUESTED',label:'Ya preparado: sin calentamiento automático',effective_days:0,target_days:14,program:null});
  expect(numbers.find((n:any)=>n.id===warm.id).warmup).toMatchObject({mode:'REQUIRED',state:'WAITING_CONNECTION',effective_days:0});
  // Registering reserves capacity only: no session started, no message, no assignment, no program.
  for(const table of ['commands','outbox','warmup_states','warmup_account_reservations','commercial_assignments'])expect((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE workspace_id=$1`,[workspace]).catch(()=>pool.query(`SELECT count(*)::int n FROM ${table} t JOIN records r ON r.id=t.account_id WHERE r.workspace_id=$1`,[workspace]))).rows[0].n,table).toBe(0);
 },60000);

 it('shows a truthful preparation state: in progress, late with automatic retry, failed with a safe retry',async()=>{
  const created=data(await call('POST','/v1/numbers/quick',{alias:'Preparación observada',country:'MX',warmup:'required'}),202),op=await provision(created.id);
  let link=data(await call('GET','/v1/numbers/'+created.id+'/link'));
  expect(link).toMatchObject({state:'PREPARING',qr_available:false,next_action:null,preparation:{automatic_retry:true,retryable:false,expected_seconds:PREPARATION_EXPECTED_MS/1000}});expect(link.detail).toMatch(/uno y cinco minutos/);
  // «Mostrar QR» while preparing answers with the reason, not with a spinner.
  const early=await call('POST','/v1/numbers/'+created.id+'/link',{action:'link'});expect(early.statusCode).toBe(409);expect(early.json().error.code).toBe('NUMBER_PREPARING');
  await pool.query("UPDATE number_operations SET created_at=now()-interval '11 minutes',state='UNKNOWN' WHERE id=$1",[op.id]);
  link=data(await call('GET','/v1/numbers/'+created.id+'/link'));
  expect(link).toMatchObject({state:'PREPARATION_DELAYED',label:'La preparación está tardando más de lo normal',next_action:null,preparation:{automatic_retry:true,retryable:false}});expect(link.detail).toMatch(/Seguimos intentándolo automáticamente/);
  expect((await row(created.id)).status).toMatchObject({code:'PREPARATION_DELAYED'});
  // Retry is not offered while the same operation is still being reconciled.
  expect(data(await call('POST','/v1/numbers/'+created.id+'/link',{action:'retry_preparation'}))).toMatchObject({state:'PREPARATION_DELAYED'});expect((await provision(created.id)).state).toBe('UNKNOWN');
  await pool.query("UPDATE number_operations SET state='FAILED',result='{\"outcome\":\"FAILED\",\"reason\":\"Synthetic rollback\"}' WHERE id=$1",[op.id]);
  link=data(await call('GET','/v1/numbers/'+created.id+'/link'));
  expect(link).toMatchObject({state:'PREPARATION_FAILED',next_action:{code:'retry_preparation',label:'Reintentar la preparación'},preparation:{automatic_retry:false,retryable:true}});
  const retried=data(await call('POST','/v1/numbers/'+created.id+'/link',{action:'retry_preparation'}),202),after=await provision(created.id);
  // The same operation, the same number and the same slot: nothing is duplicated.
  expect(after).toMatchObject({id:op.id,state:'RESERVED',lease_owner:null});expect(after.result).toMatchObject({retries:1,previous_state:'FAILED'});expect(retried.state).toBe('PREPARING');
  expect((await pool.query("SELECT count(*)::int n FROM number_operations WHERE workspace_id=$1 AND action='PROVISION' AND input->>'account_id'=$2",[workspace,created.id])).rows[0].n).toBe(1);
  expect((await pool.query('SELECT count(*)::int n FROM number_capacity_slots WHERE account_id=$1',[created.id])).rows[0].n).toBe(1);
  expect((await pool.query("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND event_type='number.preparation_retry_requested' AND aggregate_id=$2",[workspace,created.id])).rows[0].n).toBe(1);
  // A double click on retry does not queue it twice.
  expect(data(await call('POST','/v1/numbers/'+created.id+'/link',{action:'retry_preparation'}))).toMatchObject({state:'PREPARING'});expect((await provision(created.id)).result.retries).toBe(1);
 },60000);

 it('derives the preparation phase from the operation, not from a calendar',()=>{
  const now=new Date('2026-11-11T12:00:00Z'),base={account:{id:'a',created_at:now,body:{}} as any,now,profileReady:false,connectPending:false};
  expect(preparationPhase({...base,provision:{state:'RESERVED',created_at:new Date(+now-60_000)}})).toBe('PREPARING');
  expect(preparationPhase({...base,provision:{state:'HUMAN_ACTION_REQUIRED',created_at:new Date(+now-PREPARATION_EXPECTED_MS-1)}})).toBe('PREPARATION_DELAYED');
  expect(preparationPhase({...base,provision:{state:'CANCELLED',created_at:now}})).toBe('PREPARATION_FAILED');
  // Once the gateway is ready the alta leaves preparation whatever health read arrived first or last.
  expect(numberLinkState({...base,profileReady:true,provision:{state:'SUCCEEDED'}})).toEqual({state:'READY_TO_LINK',qr:false});
  expect(numberLinkState({...base,profileReady:true,provision:{state:'SUCCEEDED'},session:{observed_state:'QR_REQUIRED',health_expires_at:new Date(+now+1000)}})).toEqual({state:'WAITING_SCAN',qr:true});
  // A QR whose observation expired is not shown as scannable.
  expect(numberLinkState({...base,profileReady:true,connectPending:true,session:{observed_state:'QR_REQUIRED',health_expires_at:new Date(+now-1)}})).toEqual({state:'WAITING_SCAN',qr:false});
 });

 it('changes the choice explicitly, with audit, and never by omission; a declared number is not gated by warm-up',async()=>{
  const created=data(await call('POST','/v1/numbers/quick',{alias:'Cambio de modo',country:'MX',warmup:'ready'}),202),before=await account(created.id);
  expect(await withRole('commerce_channel',()=>commercialWarmupGuard(pool,before))).toBeNull();
  const stale=await call('POST','/v1/numbers/'+created.id+'/warmup',{mode:'required',expected_version:before.version+5});expect(stale.statusCode).toBe(409);expect(stale.json().error.code).toBe('VERSION_CONFLICT');
  const changed=data(await call('POST','/v1/numbers/'+created.id+'/warmup',{mode:'required',expected_version:before.version}));
  expect(changed).toMatchObject({warmup_mode:'REQUIRED',changed:true});
  const required=await account(created.id);expect(required.body).toMatchObject({warmup_mode:'REQUIRED',warmup_mode_source:'owner_choice'});
  // Needs warm-up and has none yet: commercial sends wait for its preparation, as before V7.4.
  expect(await withRole('commerce_channel',()=>commercialWarmupGuard(pool,required))).toBe('ACCOUNT_PREPARATION_REQUIRED');
  // Repeating the same choice is a no-op and writes nothing.
  expect(data(await call('POST','/v1/numbers/'+created.id+'/warmup',{mode:'required',expected_version:required.version}))).toMatchObject({changed:false});expect((await account(created.id)).version).toBe(required.version);
  const back=data(await call('POST','/v1/numbers/'+created.id+'/warmup',{mode:'ready',expected_version:required.version}));expect(back).toMatchObject({warmup_mode:'DECLARED_READY',changed:true,cancelled_unsent:0,programs_paused:0});
  expect((await pool.query("SELECT payload FROM domain_events WHERE workspace_id=$1 AND event_type='number.warmup_mode_changed' AND aggregate_id=$2 ORDER BY occurred_at",[workspace,created.id])).rows.map(r=>[r.payload.from,r.payload.to])).toEqual([['DECLARED_READY','REQUIRED'],['REQUIRED','DECLARED_READY']]);
  // Declared ready does not create an assignment, open sending or fabricate a graduation.
  const final=await account(created.id);expect(final.body.sending_enabled).toBe(false);expect(final.body.active_authorization_id??null).toBeNull();
  expect((await pool.query('SELECT count(*)::int n FROM warmup_states WHERE account_id=$1',[created.id])).rows[0].n).toBe(0);
  expect((await pool.query('SELECT count(*)::int n FROM warmup_episodes WHERE account_id=$1',[created.id])).rows[0].n).toBe(0);
  expect((await row(created.id)).warmup).toMatchObject({mode:'DECLARED_READY',state:'NOT_REQUESTED',effective_days:0});
  // A declaration made for one phone does not vouch for another identity.
  await pool.query("UPDATE records SET body=body||$2::jsonb,version=version+1 WHERE id=$1",[created.id,{warmup_declared_identity:'a'.repeat(64),identity_fingerprint:'b'.repeat(64)}]);
  expect(await withRole('commerce_channel',async()=>commercialWarmupGuard(pool,await account(created.id)))).toBe('WARMUP_DECLARATION_IDENTITY_CHANGED');
  expect((await row(created.id)).warmup).toMatchObject({state:'CHOICE_REQUIRED'});
  const rebound=data(await call('POST','/v1/numbers/'+created.id+'/warmup',{mode:'ready',expected_version:(await account(created.id)).version}));expect(rebound.changed).toBe(true);
  expect((await account(created.id)).body.warmup_declared_identity).toBe('b'.repeat(64));
  expect(await withRole('commerce_channel',async()=>commercialWarmupGuard(pool,await account(created.id)))).toBeNull();
 },60000);
});
