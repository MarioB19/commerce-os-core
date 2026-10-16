import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {pool,putRecord,hash,encrypt,withTransaction,readOperationalSettings,writeOperationalSettings} from '../../packages/db/src/index.js';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {disposeAllFixtureProfiles} from '../support/migrated-database.js';
import {canonicalIdentity,SimulatorProvider} from '../../packages/messaging/src/index.js';
import {warmupProfileSchema} from '../../packages/domain/src/warmup/policy.js';
import {prepareWarmupProfiles} from '../../apps/channel-worker/src/warmup-profile.js';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';

// REAL is a synthetic DB context here. The injected provider has no HTTP transport.
let app:FastifyInstance;
const origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
beforeAll(async()=>{app=await createApp();});
afterAll(async()=>{await app.close();await pool.end();});
async function fixture(){
 const workspace='warm-profile-'+randomUUID(),owner='fixture-'+randomUUID(),providerIdentity='19995550123@c.us',name='Owned fixture profile';
 // V7 F2: each case owns a fresh adopted profile; earlier cases' fixtures are disposed.
 await disposeAllFixtureProfiles(pool);await fixtureProfiles(workspace);
 const account=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Synthetic own account',provider:'waha',gateway_ref:'fixture',session:randomUUID(),status:'WORKING',sending_enabled:false,identity_verified:true,identity_fingerprint:hash(providerIdentity)}});
 const profile=(await pool.query("INSERT INTO warmup_profiles(workspace_id,environment,config) VALUES($1,'REAL',$2) RETURNING *",[workspace,warmupProfileSchema.parse({policy_version:'legacy-30d/v1',name:'Local fixture curve',timezone:'America/Mexico_City'})])).rows[0];
 const group=(await pool.query("INSERT INTO warmup_pools(workspace_id,environment,profile_id,enabled) VALUES($1,'REAL',$2,true) RETURNING *",[workspace,profile.id])).rows[0];
 const identity=(await pool.query("INSERT INTO warmup_identities(workspace_id,environment,account_id,address_fingerprint,address_ciphertext,profile_ciphertext,ownership_evidence) VALUES($1,'REAL',$2,$3,$4,$5,'Synthetic own account, no remote operation') RETURNING *",[workspace,account.id,hash(canonicalIdentity(providerIdentity)),encrypt(canonicalIdentity(providerIdentity)),encrypt({name,about:'Synthetic fixture'})])).rows[0];
 await pool.query("INSERT INTO warmup_states(account_id,workspace_id,environment,pool_id,identity_id,profile_id,status,enrolled_at) VALUES($1,$2,'REAL',$3,$4,$5,'AWAITING_PROFILE',now())",[account.id,workspace,group.id,identity.id,profile.id]);
 const settings=await withTransaction(async c=>{const initial=await readOperationalSettings(c,workspace,'REAL');return writeOperationalSettings(c,workspace,'REAL',initial.version,{...initial.body,dispatch_frozen:false,allow_real_operations:true,real_sends_enabled:true},'synthetic-fixture');});
 const scope={mode:'warmup',pool_id:group.id,account_ids:[account.id],content_ids:[],max_messages:1,allow_profile_updates:true};
 const auth=(await pool.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at,configuration_version) VALUES($1,'REAL','synthetic-fixture',$2,$3,now()+interval '1 hour',$4) RETURNING *",[workspace,scope,hash(JSON.stringify(scope)),settings.version])).rows[0];
 await pool.query('UPDATE warmup_pools SET authorization_id=$2 WHERE id=$1',[group.id,auth.id]);
 await pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,frozen,lease_expires_at) VALUES($1,$2,$3,1,false,now()+interval '1 hour')",[account.id,workspace,owner]);
 const row=async()=>(await pool.query('SELECT * FROM warmup_identities WHERE id=$1',[identity.id])).rows[0];
 return{workspace,owner,account,group,identity,auth,providerIdentity,name,row};
}
it.each(['pool_pause','revoke','lease_expiry','manual_stop','policy_freeze','quarantine','confirmed_block'] as const)('revalidates %s after GET and prevents the first profile PUT',async kind=>{
 const f=await fixture();let reads=0,writes=0,changed=false;
 const provider=Object.assign(new SimulatorProvider(),{
  profile:async()=>{reads++;
   if(kind==='pool_pause')await pool.query('UPDATE warmup_pools SET paused=true WHERE id=$1',[f.group.id]);
   if(kind==='quarantine')await pool.query("UPDATE warmup_states SET status='QUARANTINED',version=version+1 WHERE account_id=$1",[f.account.id]);
   if(kind==='confirmed_block')await pool.query('UPDATE warmup_states SET confirmed_block=true,version=version+1 WHERE account_id=$1',[f.account.id]);
   if(kind==='revoke')await pool.query('UPDATE operation_authorizations SET revoked_at=now() WHERE id=$1',[f.auth.id]);
   if(kind==='lease_expiry')await pool.query("UPDATE session_ownership SET lease_expires_at=now()-interval '1 second' WHERE account_id=$1",[f.account.id]);
   if(kind==='manual_stop')await pool.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'channel_account',$2,true,'Synthetic stop','synthetic-owner')",[f.workspace,f.account.id]);
   if(kind==='policy_freeze')await withTransaction(async c=>{const current=await readOperationalSettings(c,f.workspace,'REAL');await writeOperationalSettings(c,f.workspace,'REAL',current.version,{...current.body,dispatch_frozen:true},'synthetic-stop');});
   changed=true;return{identity:f.providerIdentity,name:'Previous profile'};
  },
  updateProfile:async()=>{writes++;},
 });
 await prepareWarmupProfiles(()=>provider,f.owner);expect(reads).toBe(1);expect(changed).toBe(true);expect(writes).toBe(0);
 expect(await f.row()).toMatchObject({profile_operation_status:'UNKNOWN',profile_verified_at:null});
 await prepareWarmupProfiles(()=>provider,f.owner);expect(reads).toBe(1);expect(writes).toBe(0);
});
it('rechecks authorization before every profile PUT and never retries an uncertain partial update',async()=>{
 const f=await fixture();let writes=0,reads=0;
 const provider=Object.assign(new SimulatorProvider(),{
  profile:async()=>{reads++;return{identity:f.providerIdentity,name:'Previous profile'};},
  updateProfile:async(_input:unknown,beforeMutation?:()=>Promise<void>)=>{
   await beforeMutation!();writes++;
   await pool.query('UPDATE operation_authorizations SET revoked_at=now() WHERE id=$1',[f.auth.id]);
   await beforeMutation!();writes++;
  },
 });
 await prepareWarmupProfiles(()=>provider,f.owner);expect({reads,writes}).toEqual({reads:1,writes:1});
 expect(await f.row()).toMatchObject({profile_operation_status:'UNKNOWN',profile_verified_at:null});
 await prepareWarmupProfiles(()=>provider,f.owner);expect({reads,writes}).toEqual({reads:1,writes:1});
});
it('keeps UNKNOWN inert until an owner requests read-only review, with no repeated PUT',async()=>{
 const f=await fixture();let reads=0,writes=0,remoteName='Previous profile';
 const provider=Object.assign(new SimulatorProvider(),{
  profile:async()=>{reads++;return{identity:f.providerIdentity,name:remoteName};},
  updateProfile:async(_input:unknown,beforeMutation?:()=>Promise<void>)=>{await beforeMutation!();writes++;remoteName=f.name;throw Error('Synthetic response lost after accepted update');},
 });
 await prepareWarmupProfiles(()=>provider,f.owner);expect(await f.row()).toMatchObject({profile_operation_status:'UNKNOWN',profile_verified_at:null});
 await prepareWarmupProfiles(()=>provider,f.owner);expect({reads,writes}).toEqual({reads:1,writes:1});
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Synthetic review owner',email,password,workspace_id:f.workspace,role:'owner'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.229',headers:{origin},payload:{email,password}});expect(login.statusCode,login.body).toBe(200);
 const cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; '),key=randomUUID();
 const request=()=>app.inject({method:'POST',url:`/v1/warmup/accounts/${f.account.id}/profile-review?environment=REAL`,headers:{origin,cookie,'idempotency-key':key},payload:{expected_version:1,reason:'Observe the uncertain profile without repeating any mutation'}});
 const review=await request();expect(review.statusCode,review.body).toBe(200);expect(review.json().data).toMatchObject({review_requested:true,external_mutations:false,version:2});
 expect((await request()).json().data).toEqual(review.json().data);
 expect(await f.row()).toMatchObject({profile_operation_status:'UNKNOWN'});expect((await f.row()).profile_review_requested_at).not.toBeNull();
 await prepareWarmupProfiles(()=>provider,f.owner);expect({reads,writes}).toEqual({reads:3,writes:1});
 expect(await f.row()).toMatchObject({profile_operation_status:'VERIFIED',profile_review_requested_at:null});expect((await f.row()).profile_verified_at).not.toBeNull();
 const event=(await pool.query("SELECT payload FROM domain_events WHERE workspace_id=$1 AND event_type='warmup.profile.verified'",[f.workspace])).rows[0];
 expect(event.payload).toMatchObject({read_only_review:true,about_observation:'NOT_OBSERVABLE',verification:'PROVIDER_NAME_AND_IDENTITY'});
 expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[f.workspace])).rows[0].n).toBe(0);
});
it('recovers abandoned APPLYING as UNKNOWN without factory calls or implicit retry',async()=>{
 const f=await fixture();let factories=0;
 await pool.query("UPDATE warmup_identities SET profile_operation_status='APPLYING',profile_attempt_at=now()-interval '6 minutes' WHERE id=$1",[f.identity.id]);
 await prepareWarmupProfiles(()=>{factories++;return new SimulatorProvider();},f.owner);
 expect(factories).toBe(0);expect(await f.row()).toMatchObject({profile_operation_status:'UNKNOWN',profile_verified_at:null,profile_review_requested_at:null});
});
