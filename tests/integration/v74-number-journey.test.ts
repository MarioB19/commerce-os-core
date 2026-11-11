import {beforeAll,afterAll,it,expect,describe} from 'vitest';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {randomUUID,randomBytes} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,getRecord,hash} from '../../packages/db/src/index.js';
import {processChannelCommands} from '../../apps/channel-worker/src/lifecycle.js';
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

 it('finishes the removal of a migrated number through an accredited unlink, without SQL, a fabricated logout or a blind ownership transfer',async()=>{
  const created=data(await call('POST','/v1/numbers/quick',{alias:'Línea migrada',country:'MX',warmup:'required'}),202),id=created.id;
  // A number linked before a migration: its technical owner and generation are
  // from another worker, it has history, and no isolation receipt exists.
  const fingerprint=hash('synthetic-migrated-identity');
  await pool.query("UPDATE records SET body=body||$2::jsonb,version=version+1 WHERE id=$1",[id,{status:'WORKING',identity_fingerprint:fingerprint,identity_verified:true,ownership_confirmed_at:new Date().toISOString(),last_lifecycle_at:new Date(Date.now()-86400000).toISOString()}]);
  await pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,frozen,lease_expires_at) VALUES($1,$2,'channel-worker:before-migration',7,true,now()-interval '40 days')",[id,workspace]);
  await pool.query("UPDATE channel_sessions SET desired_state='RUNNING',operational_pause=false,expected_identity_fingerprint=$2,last_connected_at=now()-interval '40 days' WHERE account_id=$1",[id,fingerprint]);
  const conversation=(await pool.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','conversation',$2) RETURNING id",[workspace,{account_id:id,status:'OPEN'}])).rows[0].id;
  const other=data(await call('POST','/v1/numbers/quick',{alias:'Otra línea intacta',country:'MX',warmup:'required'}),202),otherBefore=(await pool.query('SELECT s.*,r.body,r.version FROM channel_sessions s JOIN records r ON r.id=s.account_id WHERE s.account_id=$1',[other.id])).rows[0];
  const version=(await account(id)).version,requested=data(await call('POST','/v1/numbers/'+id+'/removal',{expected_version:version,confirmation:'REMOVE_NUMBER'}),202);
  expect(requested.state).toBe('REMOVING');expect(requested.command_id).toBeTruthy();
  // The real worker refuses to close a session it cannot prove isolated, and never calls the provider.
  let providerCalls=0;await withRole('commerce_channel',()=>processChannelCommands(10,async()=>{providerCalls++;throw new Error('PROVIDER_MUST_NOT_BE_CALLED');},'channel-worker:after-migration'));
  const command=(await pool.query('SELECT status,result FROM commands WHERE id=$1',[requested.command_id])).rows[0];
  expect(command.status).toBe('FAILED');expect(command.result).toMatchObject({error:'VERIFIED_ISOLATION_PROOF_REQUIRED',remote_outcome:'NOT_ATTEMPTED'});expect(providerCalls).toBe(0);
  // The operator is led to the action instead of an endless «Eliminación en curso».
  const link=data(await call('GET','/v1/numbers/'+id+'/link'));
  expect(link).toMatchObject({state:'REMOVING',removal:{phase:'UNLINK_CONFIRMATION_REQUIRED'},next_action:{code:'confirm_unlinked',label:'Ya lo desvinculé en mi teléfono'}});expect(link.detail).toMatch(/Dispositivos vinculados/);
  expect((await row(id)).removal).toMatchObject({phase:'UNLINK_CONFIRMATION_REQUIRED'});
  const confirm=(v:number)=>call('POST','/v1/numbers/'+id+'/removal/unlink-confirmation',{expected_version:v,confirmation:'DEVICE_UNLINKED_ON_PHONE'});
  const current=(await account(id)).version;
  // The statement alone is not enough: fresh evidence of this number's gateway is required…
  let refused=await confirm(current);expect(refused.statusCode).toBe(409);expect(refused.json().error.code).toBe('FRESH_GATEWAY_EVIDENCE_REQUIRED');
  const slot=(await pool.query('SELECT slot FROM number_capacity_slots WHERE account_id=$1',[id])).rows[0].slot;
  const observe=(sessions:number,source='bounded_administrator',age=0)=>pool.query('UPDATE number_capacity_slots SET readback=$2,version=version+1 WHERE account_id=$1',[id,{slot,running:true,verified:true,session_count:sessions,connected_sessions:sessions,network_present:true,volumes_preserved:true,observed_at:new Date(Date.now()-age).toISOString(),source}]);
  // …and it must show no session, be recent and come from the bounded administrator.
  await observe(1);refused=await confirm(current);expect(refused.json().error.code).toBe('GATEWAY_SESSION_STILL_PRESENT');
  await observe(0,'bounded_administrator',120_000);refused=await confirm(current);expect(refused.json().error.code).toBe('FRESH_GATEWAY_EVIDENCE_REQUIRED');
  await observe(0,'operator_claim');refused=await confirm(current);expect(refused.json().error.code).toBe('FRESH_GATEWAY_EVIDENCE_REQUIRED');
  await observe(0);
  expect((await call('POST','/v1/numbers/'+id+'/removal/unlink-confirmation',{expected_version:current,confirmation:'YES'})).statusCode).toBe(400);
  expect((await confirm(current+3)).json().error.code).toBe('VERSION_CONFLICT');
  // Pending or uncertain work blocks the confirmation.
  const uncertain=(await pool.query("INSERT INTO outbox(workspace_id,environment,account_id,conversation_id,contact_id,logical_key,kind,payload,status,config_hash,approval_hash,not_before,expires_at) VALUES($1,'REAL',$2,$3,$3,$4,'text','{}','UNKNOWN','x','x',now(),now()+interval '1 hour') RETURNING id",[workspace,id,conversation,'v74:'+randomUUID()]).catch(()=>({rows:[]}))).rows[0]?.id;
  if(uncertain){expect((await confirm(current)).json().error.code).toBe('RECONCILIATION_REQUIRED');await pool.query("UPDATE outbox SET status='CANCELLED' WHERE id=$1",[uncertain]);}
  const done=data(await confirm(current));expect(done).toMatchObject({state:'REMOVED',unlink_reconciled:true});
  const removed=(await pool.query('SELECT body FROM records WHERE id=$1',[id])).rows[0].body;
  expect(removed).toMatchObject({status:'STOPPED',sending_enabled:false,identity_verified:false,unlink_method:'primary_device_revocation_confirmed_and_current_gateway_empty'});expect(removed.deleted_at).toBeTruthy();expect(removed.unlinked_at).toBeTruthy();
  // The old technical owner stays frozen and untransferred; no isolation receipt was fabricated.
  expect((await pool.query('SELECT owner_id,generation,frozen FROM session_ownership WHERE account_id=$1',[id])).rows[0]).toEqual({owner_id:'channel-worker:before-migration',generation:7,frozen:true});
  expect((await pool.query('SELECT count(*)::int n FROM ownership_isolation_receipts WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
  const event=(await pool.query("SELECT payload FROM domain_events WHERE workspace_id=$1 AND event_type='channel.unlink_reconciled' AND aggregate_id=$2",[workspace,id])).rows;
  expect(event).toHaveLength(1);expect(event[0].payload).toMatchObject({remote_logout_executed:false,isolation_proof_fabricated:false,previous_owner_preserved_frozen:true,owner_confirmation:'DEVICE_UNLINKED_ON_PHONE',blocked_reason:'VERIFIED_ISOLATION_PROOF_REQUIRED',gateway:{slot,session_count:0,source:'bounded_administrator'}});
  // The failed command is kept as it happened: it is not rewritten as a logout that ran.
  expect((await pool.query('SELECT status,result FROM commands WHERE id=$1',[requested.command_id])).rows[0].result.remote_outcome).toBe('NOT_ATTEMPTED');
  // History and the profile's quota: the conversation stays, the slot returns to the same profile.
  expect((await pool.query('SELECT body FROM records WHERE id=$1',[conversation])).rows[0].body).toMatchObject({account_id:id,status:'OPEN'});
  expect((await pool.query('SELECT state,account_id,workspace_id FROM number_capacity_slots WHERE slot=$1 AND workspace_id=$2',[slot,workspace])).rows[0]).toMatchObject({account_id:null,workspace_id:workspace});
  expect((await pool.query("SELECT retired_at IS NOT NULL AS retired FROM profile_quota_entries WHERE record_id=$1",[id])).rows[0]?.retired).toBe(true);
  expect(data(await call('GET','/v1/numbers/overview')).numbers.some((n:any)=>n.id===id)).toBe(false);
  // Another number's session and record are untouched.
  expect((await pool.query('SELECT s.*,r.body,r.version FROM channel_sessions s JOIN records r ON r.id=s.account_id WHERE s.account_id=$1',[other.id])).rows[0]).toEqual(otherBefore);
  // Confirming again changes nothing: the number is already gone, its history kept.
  expect((await confirm(current)).statusCode).toBe(410);expect((await pool.query("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND event_type='channel.unlink_reconciled'",[workspace])).rows[0].n).toBe(1);
 },60000);

 it('accepts the unlink confirmation only from a person in the application, and only when it is actually needed',async()=>{
  const created=data(await call('POST','/v1/numbers/quick',{alias:'Sin confirmación necesaria',country:'MX',warmup:'required'}),202),v=(await account(created.id)).version;
  expect((await call('POST','/v1/numbers/'+created.id+'/removal/unlink-confirmation',{expected_version:v,confirmation:'DEVICE_UNLINKED_ON_PHONE'})).json().error.code).toBe('NUMBER_REMOVAL_NOT_REQUESTED');
  const token=randomBytes(24).toString('hex');await pool.query("INSERT INTO service_tokens(workspace_id,actor_id,name,token_hash,scopes,allowed_environments,expires_at) VALUES($1,'v74-fixture','Agente',$2,$3,'[\"REAL\"]',now()+interval '1 hour')",[workspace,hash(token),JSON.stringify(['channels:read','channels:manage'])]);
  const agent=await withRole('commerce_api',()=>app.inject({method:'POST',url:'/v1/numbers/'+created.id+'/removal/unlink-confirmation?environment=REAL',payload:{expected_version:v,confirmation:'DEVICE_UNLINKED_ON_PHONE'},headers:{origin,authorization:'Bearer '+token,'idempotency-key':randomUUID()}}));
  expect(agent.statusCode).toBe(403);expect(agent.json().error.code).toBe('HUMAN_CONFIRMATION_REQUIRED');
  // A number that was never linked is removed directly, as before.
  expect(data(await call('POST','/v1/numbers/'+created.id+'/removal',{expected_version:v,confirmation:'REMOVE_NUMBER'}),202).state).toBe('REMOVED');
 },60000);
});
