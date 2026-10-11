import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord,hash,encrypt} from '../../packages/db/src/index.js';
import {warmupProfileSchema} from '../../packages/domain/src/warmup/policy.js';
import {commercialWarmupGuard} from '../../packages/db/src/warmup.js';
const workspace='backfill-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:FastifyInstance,cookie:string,profileId:string,poolId:string;
const call=(id:string,payload:Record<string,unknown>,key=randomUUID(),token?:string)=>app.inject({method:'POST',url:'/v1/warmup/accounts/'+id+'/backfill?environment=REAL',payload,headers:{origin,...(token?{authorization:'Bearer '+token}:{cookie}),'idempotency-key':key}});
const data=(r:any,status=200)=>{expect(r.statusCode,r.body).toBe(status);return r.json().data;};
beforeAll(async()=>{
 app=await createApp();const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');await provisionUser({name:'Synthetic backfill owner',email,password,workspace_id:workspace,role:'owner'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin},remoteAddress:'192.0.2.219'});expect(login.statusCode).toBe(200);cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');
 // Backfill applies only to a historical curve. Be explicit now that new
 // profiles default to the fully automatic standard-15d/v2 policy.
 profileId=(await pool.query("INSERT INTO warmup_profiles(workspace_id,environment,config) VALUES($1,'REAL',$2) RETURNING id",[workspace,warmupProfileSchema.parse({name:'Backfill standard fixture',policy_version:'standard-15d/v1',timezone:'UTC'})])).rows[0].id;
 poolId=(await pool.query("INSERT INTO warmup_pools(workspace_id,environment,profile_id) VALUES($1,'REAL',$2) RETURNING id",[workspace,profileId])).rows[0].id;
});
afterAll(async()=>{await app.close();await pool.end();});

// Historical rows are synthetic local proof fixtures. No provider, credentials or external transport is used.
async function fixture(options:{history?:boolean;gap?:boolean;changedIdentity?:boolean;sentOnly?:boolean;membershipDaysAgo?:number}={}){
 const now=Date.now(),cutoff=new Date(now-(options.membershipDaysAgo?options.membershipDaysAgo*86400000:5*60000)),identityDigits='1999555'+String(Math.floor(Math.random()*10000)).padStart(4,'0'),canonical='wa:'+identityDigits,fingerprint=hash(identityDigits+'@c.us');
 const account=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Synthetic prior operation',provider:'waha',status:'WORKING',identity_verified:true,identity_conflict:false,identity_fingerprint:fingerprint,sending_enabled:false}});
 const identity=(await pool.query("INSERT INTO warmup_identities(workspace_id,environment,account_id,address_fingerprint,address_ciphertext,profile_ciphertext,ownership_evidence) VALUES($1,'REAL',$2,$3,$4,$5,'Synthetic fixture only') RETURNING id",[workspace,account.id,hash(canonical),encrypt(canonical),encrypt({name:'Owned fixture',about:'No provider calls'})])).rows[0];
 await pool.query("INSERT INTO warmup_states(account_id,workspace_id,environment,pool_id,profile_id,identity_id,created_at) VALUES($1,$2,'REAL',$3,$4,$5,$6)",[account.id,workspace,poolId,profileId,identity.id,cutoff]);
 if(options.history!==false){
  await pool.query("INSERT INTO record_versions(record_id,workspace_id,environment,kind,version,body,created_at) VALUES($1,$2,'REAL','channel_account',999,$3,$4)",[account.id,workspace,{...account.body,identity_fingerprint:options.changedIdentity?hash('12025550176@c.us'):fingerprint},new Date(cutoff.getTime()-40*86400000)]);
  await pool.query(`INSERT INTO records(workspace_id,environment,kind,body,created_at,updated_at)
   SELECT $1,'REAL','health_signal',jsonb_build_object('account_id',$2::text,'dimension',dimension,'status','OK','source','provider_read','observed_at',observed,'expires_at',observed+interval '45 seconds','value',CASE WHEN dimension='transport' THEN jsonb_build_object('identity_fingerprint',$3::text) ELSE '"WORKING"'::jsonb END),observed,observed
   FROM generate_series($4::timestamptz-interval '7 days 30 minutes',$4::timestamptz,interval '30 minutes') observed CROSS JOIN unnest(ARRAY['session','transport']) dimension
   WHERE NOT($5::boolean AND observed BETWEEN $4::timestamptz-interval '2 days 2 hours' AND $4::timestamptz-interval '2 days')`,[workspace,account.id,fingerprint,cutoff,options.gap??false]);
  const contact=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'contact',body:{identity:'opaque:historical-fixture-'+randomUUID()}}),conversation=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'conversation',body:{account_id:account.id,contact_id:contact.id,stage:'NEW'}});
  for(let i=1;i<=31;i++){
   const when=new Date(cutoff.getTime()-i*86400000),messageId='fixture-'+randomUUID();
   const effect=(await pool.query("INSERT INTO outbox(workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,status,config_hash,attempts,provider_message_id,created_at) VALUES($1,'REAL',$2,$3,$4,$5,'{}',$6,$7,1,$8,$9) RETURNING id",[workspace,account.id,conversation.id,contact.id,randomUUID(),options.sentOnly?'SENT':'DELIVERED',hash('synthetic'),messageId,when])).rows[0];
   await pool.query("INSERT INTO effect_attempts(effect_id,claim_id,status,result,started_at,finished_at) VALUES($1,$2,'SENT',$3,$4,$5)",[effect.id,randomUUID(),{provider_message_id:messageId},when,new Date(when.getTime()+1000)]);
   if(!options.sentOnly){
    const envelope=(await pool.query("INSERT INTO inbound_envelopes(workspace_id,environment,account_id,provider,provider_event_id,payload_ciphertext,status,occurred_at,received_at,processed_at) VALUES($1,'REAL',$2,'waha',$3,$4,'PROCESSED',$5,$5,$5) RETURNING id",[workspace,account.id,randomUUID(),encrypt({synthetic:true}),new Date(when.getTime()+2000)])).rows[0];
    await pool.query("INSERT INTO domain_events(workspace_id,environment,event_type,aggregate_id,correlation_id,actor,payload,occurred_at,recorded_at) VALUES($1,'REAL','provider.ack.observed',$2,$3,$4,$5,$6,$6)",[workspace,account.id,randomUUID(),{type:'provider',id:'waha'},{provider_message_id:messageId,status:'DELIVERED',envelope_id:envelope.id},new Date(when.getTime()+2000)]);
   }
  }
 }
 for(const dimension of ['session','transport'])await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'health_signal',body:{account_id:account.id,dimension,status:'OK',source:'provider_read',value:dimension==='transport'?{identity_fingerprint:fingerprint}:'WORKING',observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+180000).toISOString()}});
 return{account,body:{expected_version:1,expected_account_version:account.version,reason:'Review historical synthetic evidence'}};
}

describe('owner historical backfill with current identity and immutable evidence',()=>{
 it('previews and applies verified history once without fabricated effective days or enabling permissions',async()=>{
  const f=await fixture(),preview=data(await call(f.account.id,f.body));expect(preview).toMatchObject({eligible:true,dry_run:true,summary:{observed_activity_days:31,verified_deliveries:31,delivery_ratio:1}});
  expect((await pool.query('SELECT status,version,enrolled_at FROM warmup_states WHERE account_id=$1',[f.account.id])).rows[0]).toEqual({status:'AWAITING_CONNECTION',version:1,enrolled_at:null});
  const key=randomUUID(),body={...f.body,dry_run:false,evidence_hash:preview.evidence_hash};const applied=data(await call(f.account.id,body,key));expect(applied).toMatchObject({status:'GRADUATED',reason:'BACKFILL',effective_days:0,warmup_started_at:null,version:2,commercial_permissions_changed:false,external_effects:0});expect(applied.enrolled_at).toBe(preview.summary.first_verified_activity_at);expect(data(await call(f.account.id,body,key))).toEqual(applied);
  expect((await pool.query('SELECT body FROM records WHERE id=$1',[f.account.id])).rows[0].body).toEqual(f.account.body);expect((await pool.query('SELECT enabled,authorization_id FROM warmup_pools WHERE id=$1',[poolId])).rows[0]).toEqual({enabled:false,authorization_id:null});
  expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE account_id=$1',[f.account.id])).rows[0].n).toBe(31);
  expect(await commercialWarmupGuard(pool,{...f.account,body:{...f.account.body,identity_fingerprint:hash('12025550177@c.us')}})).toBe('WARMUP_REGISTERED_IDENTITY_CHANGED');
 });
 it.each([{history:false,expected:'BACKFILL_ACTIVITY_NOT_DEMONSTRATED'},{gap:true,expected:'BACKFILL_STABILITY_NOT_DEMONSTRATED'},{changedIdentity:true,expected:'BACKFILL_IDENTITY_HISTORY_INSUFFICIENT'},{sentOnly:true,expected:'BACKFILL_ACTIVITY_NOT_DEMONSTRATED'},{membershipDaysAgo:10,expected:'BACKFILL_STABILITY_NOT_DEMONSTRATED'}])('rejects unknown, interrupted, replaced and SENT-only history: $expected',async options=>{
  const f=await fixture(options),preview=data(await call(f.account.id,f.body));expect(preview.eligible).toBe(false);expect(preview.reasons).toContain(options.expected);
  expect((await call(f.account.id,{...f.body,dry_run:false,evidence_hash:preview.evidence_hash})).json().error.code).toBe('BACKFILL_EVIDENCE_INSUFFICIENT');expect((await pool.query('SELECT status,version FROM warmup_states WHERE account_id=$1',[f.account.id])).rows[0]).toEqual({status:'AWAITING_CONNECTION',version:1});
 });
 it('rechecks current health and refuses a stale evidence hash, started curve or concurrent revision',async()=>{
  const f=await fixture(),preview=data(await call(f.account.id,f.body));expect(preview.eligible).toBe(true);
  expect((await call(f.account.id,{...f.body,dry_run:false,evidence_hash:'0'.repeat(64)})).json().error.code).toBe('BACKFILL_EVIDENCE_CHANGED');
  await pool.query("UPDATE records SET body=jsonb_set(body,'{expires_at}',to_jsonb((now()-interval '1 second')::text)),version=version+1 WHERE workspace_id=$1 AND kind='health_signal' AND body->>'account_id'=$2 AND created_at>now()-interval '1 minute'",[workspace,f.account.id]);
  expect((await call(f.account.id,{...f.body,dry_run:false,evidence_hash:preview.evidence_hash})).json().error.details).toContain('BACKFILL_CURRENT_HEALTH_UNAVAILABLE');
  const started=await fixture();await pool.query('UPDATE warmup_states SET enrolled_at=now(),warmup_started_at=now() WHERE account_id=$1',[started.account.id]);expect(data(await call(started.account.id,started.body)).reasons).toContain('BACKFILL_CURVE_ALREADY_STARTED');
  const race=await fixture(),proposal=data(await call(race.account.id,race.body)),payload={...race.body,dry_run:false,evidence_hash:proposal.evidence_hash};const results=await Promise.all([call(race.account.id,payload),call(race.account.id,payload)]);expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);
 });
 it('requires owner and keeps workspace and explicit environment boundaries',async()=>{
  const f=await fixture({history:false});const grant=await app.inject({method:'POST',url:'/v1/service-tokens?environment=REAL',payload:{name:'Backfill forbidden service',scopes:['warmup:manage'],resource_ids:[f.account.id],expires_at:new Date(Date.now()+3600000).toISOString()},headers:{origin,cookie,'idempotency-key':randomUUID()}});
  expect((await call(f.account.id,f.body,randomUUID(),data(grant,201).token)).statusCode).toBe(403);
  expect((await call(randomUUID(),f.body)).statusCode).toBe(404);
  expect((await app.inject({method:'POST',url:'/v1/warmup/accounts/'+f.account.id+'/backfill',payload:f.body,headers:{origin,cookie,'idempotency-key':randomUUID()}})).json().error.code).toBe('ENVIRONMENT_REQUIRED');
 });
});
