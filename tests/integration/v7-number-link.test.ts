import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,encrypt,hash,withTransaction,readOperationalSettings,writeOperationalSettings} from '../../packages/db/src/index.js';
import {saveIntegrationSetting} from '../../packages/db/src/integration-settings.js';
import {fixtureProfiles} from '../support/profile-fixture.js';

// V7 F3 number journey (RF-07.a/c, RF-17.f, wireframe D): register with a
// private phone, one QR, automatic confirmation of the observed line, neutral
// refusal of a line confirmed elsewhere, and removal with impact. The worker
// and gateway are simulated by writing their durable facts; nothing is sent.
const workspace='number-link-'+randomUUID(),outsider='number-link-other-'+randomUUID();
const origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:Awaited<ReturnType<typeof createApp>>,cookie:string;
const call=(method:string,path:string,body?:unknown)=>app.inject({method:method as 'GET',url:path+(path.includes('?')?'&':'?')+'environment=REAL',payload:body as object,headers:{origin,cookie,'idempotency-key':randomUUID()}});
const data=(r:{statusCode:number;body:string;json():any},status=200)=>{expect(r.statusCode,r.body).toBe(status);return r.json().data;};
async function inProfile<T>(scope:string,work:(c:import('pg').PoolClient)=>Promise<T>){
 const c=await pool.connect();
 try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[scope]);const r=await work(c);await c.query('COMMIT');return r;}
 catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
beforeAll(async()=>{
 await fixtureProfiles(workspace,outsider);
 app=await createApp();const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Dueña de prueba',email,password,workspace_id:workspace,role:'owner'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});
 cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');
 await withTransaction(async c=>{await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[workspace]);const p=await readOperationalSettings(c,workspace,'REAL');await writeOperationalSettings(c,workspace,'REAL',p.version,{...p.body,allow_channel_onboarding:true},'synthetic');});
});
afterAll(async()=>{await app.close();await pool.end();});
const account=async(id:string)=>(await inProfile(workspace,c=>c.query('SELECT * FROM records WHERE id=$1',[id]))).rows[0];
async function provisioned(id:string){const a=await account(id);await inProfile(workspace,c=>saveIntegrationSetting(c,workspace,'REAL','waha:'+a.body.gateway_ref,{expected_version:0,label:'Gateway sintético',enabled:true,config:{base_url:'http://'+a.body.gateway_ref+':3000'},secrets:{api_key:'synthetic-key',webhook_secret:'synthetic-hook'},clear_secrets:[],reason:'Synthetic provisioning'},'fixture'));}
async function scanned(id:string,raw:string){
 await inProfile(workspace,async c=>{
  await c.query("UPDATE commands SET status='APPLIED' WHERE resource_id=$1 AND kind='channel_command' AND status='PENDING'",[id]);
  await c.query("UPDATE channel_sessions SET observed_state='CONNECTED',auth_state='VERIFIED',expected_identity_fingerprint=$2,last_health_at=now(),provider_observed_at=now(),health_expires_at=now()+interval '1 minute' WHERE account_id=$1",[id,hash(raw)]);
 });
}
async function identityRead(id:string,raw:string){
 await inProfile(workspace,async c=>{
  await c.query("UPDATE number_operations SET state='SUCCEEDED' WHERE input->>'account_id'=$1 AND action='IDENTITY_OBSERVE'",[id]);
  await c.query("UPDATE records SET body=body||jsonb_build_object('identity_fingerprint',$2::text),version=version+1 WHERE id=$1",[id,hash(raw)]);
  await c.query('UPDATE channel_sessions SET observed_identity_ciphertext=$2,last_health_at=now() WHERE account_id=$1',[id,encrypt(raw)]);
 });
}

it('registers with a private phone, links by QR and confirms the line automatically',async()=>{
 const created=data(await call('POST','/v1/numbers/quick',{alias:'Ventas MX',country:'MX',phone:'+52 1 55 1234 5678'}),202);
 expect(created).toMatchObject({state:'PREPARING'});
 const stored=await account(created.id);
 expect(stored.body.masked_number).toBe('•••• 5678');expect(JSON.stringify(stored.body)).not.toContain('5512345678');
 expect(data(await call('GET',`/v1/numbers/${created.id}/link`))).toMatchObject({state:'PREPARING',qr_available:false});
 expect((await call('POST',`/v1/numbers/${created.id}/link`,{action:'link'})).json().error?.code??null).toBe('NUMBER_PREPARING');
 await provisioned(created.id);
 expect(data(await call('GET',`/v1/numbers/${created.id}/link`))).toMatchObject({state:'READY_TO_LINK',next_action:{code:'link'}});
 const linking=data(await call('POST',`/v1/numbers/${created.id}/link`,{action:'link'}),202);
 expect(linking).toMatchObject({state:'WAITING_SCAN'});
 expect((await inProfile(workspace,c=>c.query("SELECT desired_state FROM channel_sessions WHERE account_id=$1",[created.id]))).rows[0].desired_state).toBe('RUNNING');
 await inProfile(workspace,c=>c.query("UPDATE channel_sessions SET observed_state='QR_REQUIRED',auth_state='QR_REQUIRED',health_expires_at=now()+interval '1 minute' WHERE account_id=$1",[created.id]));
 expect(data(await call('GET',`/v1/numbers/${created.id}/link`))).toMatchObject({state:'WAITING_SCAN',qr_available:true});
 const raw='5215512345678@c.us';await scanned(created.id,raw);
 expect(data(await call('GET',`/v1/numbers/${created.id}/link`))).toMatchObject({state:'CONFIRMING'});
 expect((await inProfile(workspace,c=>c.query("SELECT count(*)::int n FROM number_operations WHERE input->>'account_id'=$1 AND action='IDENTITY_OBSERVE'",[created.id]))).rows[0].n).toBe(1);
 await identityRead(created.id,raw);
 const linked=data(await call('GET',`/v1/numbers/${created.id}/link`));
 expect(linked).toMatchObject({state:'CONNECTED',label:'Conectado',masked_number:'•••• 5678'});
 const confirmed=await account(created.id);
 expect(confirmed.body).toMatchObject({identity_verified:true,identity_fingerprint:hash(raw)});expect(confirmed.body.ownership_confirmed_at).toBeTruthy();
 expect((await inProfile(workspace,c=>c.query("SELECT count(*)::int n FROM domain_events WHERE aggregate_id=$1 AND event_type='number.link_confirmed'",[created.id]))).rows[0].n).toBe(1);
 const overview=data(await call('GET','/v1/numbers/overview'));
 expect(overview.numbers.find((n:{id:string})=>n.id===created.id)).toMatchObject({status:{code:'READY_TO_ASSIGN',label:'Listo para asignar'},products:[]});
 expect((await inProfile(workspace,c=>c.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace]))).rows[0].n).toBe(0);
});

it('never confirms another phone and refuses a line confirmed on another live number, without naming it',async()=>{
 const other=data(await call('POST','/v1/numbers/quick',{alias:'Soporte',country:'MX',phone:'55 0000 1111'}),202);
 await provisioned(other.id);data(await call('POST',`/v1/numbers/${other.id}/link`,{action:'link'}),202);
 const wrong='5215599998888@c.us';await scanned(other.id,wrong);data(await call('GET',`/v1/numbers/${other.id}/link`));await identityRead(other.id,wrong);
 const mismatch=data(await call('GET',`/v1/numbers/${other.id}/link`));
 expect(mismatch).toMatchObject({state:'PHONE_MISMATCH',next_action:{code:'unlink'}});
 expect((await account(other.id)).body.ownership_confirmed_at).toBeUndefined();
 // The same line, already confirmed in another profile.
 const shared='5215577776666@c.us';
 await inProfile(outsider,c=>c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','channel_account',$2)",[outsider,{name:'Ajeno',provider:'waha',status:'STOPPED',identity_fingerprint:hash(shared),ownership_confirmed_at:new Date().toISOString(),sending_enabled:false}]));
 const third=data(await call('POST','/v1/numbers/quick',{alias:'Tercero',country:'MX'}),202);
 await provisioned(third.id);data(await call('POST',`/v1/numbers/${third.id}/link`,{action:'link'}),202);
 await scanned(third.id,shared);data(await call('GET',`/v1/numbers/${third.id}/link`));await identityRead(third.id,shared);
 const refused=await call('GET',`/v1/numbers/${third.id}/link`),body=refused.body;
 expect(refused.json().data).toMatchObject({state:'NUMBER_UNAVAILABLE',label:'Este número no está disponible'});
 expect(body).not.toContain(outsider);expect(body).not.toContain('Ajeno');
 // Unlink is the only way forward; it clears the problem and closes the session.
 const unlinked=data(await call('POST',`/v1/numbers/${third.id}/link`,{action:'unlink'}),202);
 expect(unlinked.command_id).toBeTruthy();
 expect((await inProfile(workspace,c=>c.query("SELECT payload->>'type' t FROM commands WHERE id=$1",[unlinked.command_id]))).rows[0].t).toBe('logout');
});

it('removes a number after showing its impact; history stays and nothing is sent',async()=>{
 const fresh=data(await call('POST','/v1/numbers/quick',{alias:'Temporal',country:'MX',phone:'55 2222 3333'}),202);
 const impact=data(await call('GET',`/v1/numbers/${fresh.id}/removal`));
 expect(impact).toMatchObject({products:[],open_conversations:0,pending_followups:0,history_preserved:true,customer_data_deleted:false});
 const version=(await account(fresh.id)).version;
 expect((await call('POST',`/v1/numbers/${fresh.id}/removal`,{expected_version:version,confirmation:'BORRAR'})).statusCode).toBe(400);
 const removed=data(await call('POST',`/v1/numbers/${fresh.id}/removal`,{expected_version:version,confirmation:'REMOVE_NUMBER'}),202);
 expect(removed).toMatchObject({state:'REMOVED'});
 expect((await account(fresh.id)).body.deleted_at).toBeTruthy();
 // A connected number closes its session first; it is deleted once unlinked.
 const live=data(await call('POST','/v1/numbers/quick',{alias:'Conectado',country:'MX',phone:'55 4444 5555'}),202);
 await provisioned(live.id);data(await call('POST',`/v1/numbers/${live.id}/link`,{action:'link'}),202);
 await inProfile(workspace,c=>c.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,frozen,lease_expires_at) VALUES($1,$2,'synthetic-worker',1,false,now()+interval '1 minute') ON CONFLICT(account_id) DO NOTHING",[live.id,workspace]));
 await inProfile(workspace,c=>c.query("UPDATE commands SET status='APPLIED' WHERE resource_id=$1 AND status='PENDING'",[live.id]));
 const pending=data(await call('POST',`/v1/numbers/${live.id}/removal`,{expected_version:(await account(live.id)).version,confirmation:'REMOVE_NUMBER'}),202);
 expect(pending).toMatchObject({state:'REMOVING'});expect(pending.command_id).toBeTruthy();
 expect(data(await call('GET',`/v1/numbers/${live.id}/link`))).toMatchObject({state:'REMOVING'});
 await inProfile(workspace,async c=>{
  await c.query("UPDATE commands SET status='APPLIED' WHERE id=$1",[pending.command_id]);
  await c.query("UPDATE records SET body=body||jsonb_build_object('status','STOPPED','unlinked_at',now()::text),version=version+1 WHERE id=$1",[live.id]);
  await c.query('UPDATE session_ownership SET frozen=true WHERE account_id=$1',[live.id]);
 });
 expect(data(await call('GET',`/v1/numbers/${live.id}/link`))).toMatchObject({state:'REMOVED'});
 expect((await inProfile(workspace,c=>c.query("SELECT count(*)::int n FROM domain_events WHERE aggregate_id=$1 AND event_type IN('number.removal_requested','channel.deleted')",[live.id]))).rows[0].n).toBe(2);
 expect((await inProfile(workspace,c=>c.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace]))).rows[0].n).toBe(0);
});
