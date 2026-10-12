/** Restricted real PostgreSQL over explicitly synthetic connection observations.
 * No provider, physical QR, host or external message is invoked. */
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {asProfileOwner,requireMigratedProfileSchema,fixtureProfileRow} from '../support/migrated-database.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {withProfileTransaction,type ProfileExecutor,type ProfilePool} from '../../packages/db/src/profile-context.js';
import {issueVerifiedQrContinuity,applyContinuousProtection} from '../../packages/db/src/continuous-authorization.js';
import {enrollCurrentQrWarmup} from '../../packages/db/src/qr-warmup.js';
import {reconcileWarmupPool,planWarmupPool} from '../../apps/automation-worker/src/warmup.js';
import {hash,encrypt,decrypt,readOperationalSettings,writeOperationalSettings} from '../../packages/db/src/index.js';
import {gateWarmupDispatch} from '../../apps/channel-worker/src/warmup.js';
import {commercialWarmupGuard,profileFor} from '../../packages/db/src/warmup.js';
import {withProfileQueryRouting} from '../../packages/db/src/profile-query-routing.js';
import {getRecord,stableJson} from '../../packages/db/src/index.js';
import {dailyBudget,localWindow} from '../../packages/domain/src/warmup/policy.js';

const suffix=randomBytes(6).toString('hex'),roles=['commerce_api','commerce_channel','commerce_automation']as const;
type Role=typeof roles[number];let admin:pg.Pool;const pools=new Map<Role,pg.Pool>(),scoped=new Map<Role,ProfilePool>(),logins:string[]=[];
const actor='qr_owner_'+suffix;let serial=0;
function tx<T>(workspace:string,role:Role,work:(db:ProfileExecutor)=>Promise<T>){return withProfileTransaction(scoped.get(role)!,workspace,work);}
// V7 F2: an installation admits three profiles and 20 numbers; each case's fresh
// profile is sealed and the oldest fixture profiles are disposed to make room.
const createdProfiles:string[]=[];
async function profile(){return fixtureProfileRow(admin,createdProfiles,'qr_'+suffix+'_'+(++serial),{businessName:'Synthetic QR',numbers:6,products:100,daily:100});}
async function connection(workspace:string,existing?:string){
 const account=existing??randomUUID(),command=randomUUID(),raw='1555000'+String(++serial).padStart(4,'0')+'@c.us';
 if(!existing)await admin.query("INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,'REAL','channel_account',$3)",[account,workspace,{provider:'waha',status:'WORKING',identity_verified:true,identity_fingerprint:hash(raw),session_provider_at:new Date().toISOString(),health_checked_at:new Date().toISOString(),health_status:'OK'}]);
 const body=(await admin.query('SELECT body FROM records WHERE id=$1',[account])).rows[0].body;
 const observed=existing?decrypt((await admin.query('SELECT observed_identity_ciphertext FROM channel_sessions WHERE account_id=$1',[account])).rows[0].observed_identity_ciphertext):raw;
 await admin.query("INSERT INTO commands(id,workspace_id,environment,kind,resource_id,actor_id,payload,status,idempotency_key,created_at) VALUES($1,$2,'REAL','channel_command',$3,$4,'{\"type\":\"connect\"}','APPLIED',$1::uuid::text,clock_timestamp()-interval '1 second')",[command,workspace,account,actor]);
 await admin.query("UPDATE channel_sessions SET desired_state='RUNNING',operational_pause=false,observed_state='CONNECTED',auth_state='VERIFIED',expected_identity_fingerprint=$2,observed_identity_ciphertext=$3,provider_observed_at=clock_timestamp(),health_expires_at=clock_timestamp()+interval '10 minutes' WHERE account_id=$1",[account,body.identity_fingerprint,encrypt(observed)]);
 const revision=(await admin.query('SELECT revision FROM channel_sessions WHERE account_id=$1',[account])).rows[0].revision;
 const grant=await tx(workspace,'commerce_channel',db=>issueVerifiedQrContinuity(db,'REAL',{operationId:randomUUID(),connectionId:command,accountId:account,expectedSessionRevision:revision,identityFingerprint:body.identity_fingerprint}));
 return{account,command,grant,raw:observed};
}
async function enrollment(workspace:string,account:string){return tx(workspace,'commerce_automation',db=>enrollCurrentQrWarmup(db,'REAL',account));}
async function state(account:string){return(await admin.query('SELECT * FROM warmup_states WHERE account_id=$1',[account])).rows[0];}
async function pool(workspace:string){return(await admin.query("SELECT * FROM warmup_pools WHERE workspace_id=$1 AND continuity_mode='QR_CONTINUOUS'",[workspace])).rows[0];}
async function fixture<T>(workspace:string,work:(c:pg.PoolClient)=>Promise<T>){const c=await admin.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true)",[workspace]);const r=await work(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function live(w:string,account:string){
 const body=(await admin.query('SELECT body FROM records WHERE id=$1',[account])).rows[0].body,now=(await admin.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
 await admin.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,frozen,lease_expires_at) VALUES($1,$2,'qr-gate',false,clock_timestamp()+interval '10 minutes') ON CONFLICT(account_id) DO UPDATE SET frozen=false,lease_expires_at=EXCLUDED.lease_expires_at",[account,w]);
 for(const dimension of ['session','transport','restriction','quality'])await admin.query("INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,'REAL','health_signal',$3)",[randomUUID(),w,{account_id:account,dimension,status:'OK',source:'provider_read',scope:'account',availability:'supported',observed_at:new Date(now.getTime()-1000).toISOString(),expires_at:new Date(now.getTime()+600000).toISOString(),value:dimension==='restriction'?{latest_read:{timelock:true,capping:true}}:dimension==='transport'?{identity_fingerprint:body.identity_fingerprint}:{}}]);
}
async function readyPair(){
 const w=await profile(),clock=(await admin.query('SELECT clock_timestamp() AS now')).rows[0].now as Date,offset=12-clock.getUTCHours(),timezone=offset===0?'UTC':`Etc/GMT${offset>0?'-':'+'}${Math.abs(offset)}`;
 await asProfileOwner(admin,w,c=>c.query('UPDATE profiles SET timezone=$2,version=version+1 WHERE id=$1',[w,timezone]));
 const a=await connection(w),b=await connection(w);for(const n of [a,b]){await enrollment(w,n.account);await live(w,n.account);}
 const p=await pool(w),now=(await admin.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
 const settings=await readOperationalSettings(admin as any,w,'REAL');await writeOperationalSettings(admin as any,w,'REAL',settings.version,{...settings.body,dispatch_frozen:false,allow_real_operations:true,real_sends_enabled:true},'synthetic-fixture');
 await tx(w,'commerce_automation',async db=>{await reconcileWarmupPool(db,p,now);expect((await planWarmupPool(db,p,now)).planned).toBeGreaterThan(0);});
 const row=(await admin.query("SELECT * FROM outbox WHERE workspace_id=$1 AND predecessor_id IS NULL ORDER BY dispatch_sequence LIMIT 1",[w])).rows[0];
 await fixture(w,async c=>{const time=(await c.query("SELECT clock_timestamp()-interval '1 second' AS before,clock_timestamp()+interval '5 minutes' AS expiry")).rows[0];await c.query('UPDATE warmup_turns SET not_before=$2,expires_at=$3 WHERE effect_id=$1',[row.id,time.before,time.expiry]);await c.query('UPDATE outbox SET not_before=$2,expires_at=$3 WHERE id=$1',[row.id,time.before,time.expiry]);});
 const effect=(await admin.query('SELECT * FROM outbox WHERE id=$1',[row.id])).rows[0];
 const gate=()=>tx(w,'commerce_channel',db=>withProfileQueryRouting(db,()=>gateWarmupDispatch(db,effect,'qr-gate')));
 return{w,a,b,p,effect,gate};
}
async function consumed(f:Awaited<ReturnType<typeof readyPair>>,messages:number,conversations:number){
 const content=(await admin.query('SELECT * FROM warmup_content WHERE workspace_id=$1 LIMIT 1',[f.w])).rows[0],profile=await profileFor(admin,f.p.profile_id),now=(await admin.query('SELECT clock_timestamp() AS now')).rows[0].now;
 await fixture(f.w,async c=>{
  for(let group=0;group<conversations;group++){
   const convo=randomUUID();await c.query("INSERT INTO warmup_conversations(id,workspace_id,environment,initiator_id,peer_id,content_id,local_date,pool_id) VALUES($1,$2,'REAL',$3,$4,$5,$6,$7)",[convo,f.w,f.a.account,f.b.account,content.id,localWindow(profile,now).date,f.p.id]);
   for(let i=group;i<messages;i+=conversations){const turn=randomUUID(),effect=randomUUID(),body=content.body.turns[0],payload={...body,warmup_turn_id:turn,warmup_pool_id:f.p.id,content_hash:content.content_hash},config=hash(stableJson({account_id:f.a.account,contact_id:f.b.account,payload}));
    await c.query("INSERT INTO warmup_turns(id,workspace_id,environment,conversation_id,sender_id,recipient_id,position,content,not_before,expires_at) VALUES($1,$2,'REAL',$3,$4,$5,$6,$7,clock_timestamp()-interval '2 minutes',clock_timestamp()+interval '1 hour')",[turn,f.w,convo,f.a.account,f.b.account,i,body]);
    await c.query("INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,logical_key,kind,payload,config_hash,approval_hash,continuous_authorization_id,status,attempts) VALUES($1,$2,'REAL',$3,$4,$5,$1::uuid::text,'warmup',$6,$7,$7,$8,'SENT',1)",[effect,f.w,f.a.account,convo,f.b.account,payload,config,f.a.grant.id]);
    await c.query('UPDATE warmup_turns SET effect_id=$2 WHERE id=$1',[turn,effect]);
   }
  }
 });
}
describe('QR dispatch gates and inbound without a peer, real PostgreSQL',()=>{
 beforeAll(async()=>{
  vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:8,connectionTimeoutMillis:5000});
  await requireMigratedProfileSchema(admin);
  await admin.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$1||\'@example.invalid\',true)',[actor]);
  for(const role of roles){const login='qr_'+role.slice(9)+'_'+suffix,password=randomBytes(24).toString('hex');logins.push(login);
   await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT ${role} TO "${login}"`);
   const u=new URL(url);u.username=login;u.password=password;const p=new pg.Pool({connectionString:u.toString(),max:3});pools.set(role,p);
   scoped.set(role,{async connect(){const c=await p.connect();try{await c.query('SET ROLE '+role);return{query:c.query.bind(c),release:()=>c.release()};}catch(e){c.release();throw e;}}});
  }
 },60000);
 afterAll(async()=>{vi.unstubAllEnvs();for(const p of pools.values())await p.end();if(admin){for(const login of logins)await admin.query(`DROP ROLE IF EXISTS "${login}"`);await admin.end();}});
 it('allows the exact current own-QR effect with all native gates and no TTL grant',async()=>{
  const f=await readyPair();expect(f.effect.authorization_id).toBeNull();expect(await f.gate()).toMatchObject({allowed:true});
  expect((await admin.query('SELECT profile_verified_at FROM warmup_identities WHERE account_id=$1',[f.a.account])).rows[0].profile_verified_at).toBeNull();
 });
 it('retains ownership, manual pause, frozen operation and identity gates',async()=>{
  const f=await readyPair();await admin.query('UPDATE session_ownership SET frozen=true WHERE account_id=$1',[f.a.account]);expect(await f.gate()).toMatchObject({allowed:false,reason:'OWNERSHIP_NOT_CONFIRMED'});await live(f.w,f.a.account);
  await admin.query('UPDATE warmup_states SET paused=true WHERE account_id=$1',[f.b.account]);expect(await f.gate()).toMatchObject({allowed:false,reason:'WARMUP_MEMBER_NOT_READY'});await admin.query('UPDATE warmup_states SET paused=false WHERE account_id=$1',[f.b.account]);
  const settings=await readOperationalSettings(admin as any,f.w,'REAL');await writeOperationalSettings(admin as any,f.w,'REAL',settings.version,{...settings.body,dispatch_frozen:true},'synthetic-fixture');expect(await f.gate()).toMatchObject({allowed:false,reason:'REAL_OPERATION_NOT_ENABLED'});
 });
 it('rejects a protected peer and an old effect after reconnect without remapping it',async()=>{
  const f=await readyPair();await tx(f.w,'commerce_channel',db=>applyContinuousProtection(db,'REAL',f.b.grant.id,'assert',{operationId:randomUUID(),expectedVersion:1,reason:'CHANNEL_DOWN',incidentId:randomUUID(),observedAt:f.b.grant.createdAt,evidenceSha256:'d'.repeat(64)}));expect(await f.gate()).toMatchObject({allowed:false});
  const g=await readyPair(),sender=g.effect.account_id;await connection(g.w,sender);await enrollment(g.w,sender);const original=g.effect.continuous_authorization_id;
  expect(await g.gate()).toMatchObject({allowed:false,reason:'CONTINUITY_QR_ORIGIN_CHANGED'});expect((await admin.query('SELECT continuous_authorization_id FROM outbox WHERE id=$1',[g.effect.id])).rows[0].continuous_authorization_id).toBe(original);
 });
 it('enforces the daily conversation ceiling even with a permanent authorization',async()=>{
  const f=await readyPair(),p=await profileFor(admin,f.p.profile_id),budget=dailyBudget(p,1,new Date());await consumed(f,budget.max_conversations,budget.max_conversations);expect(await f.gate()).toMatchObject({allowed:false,reason:'WARMUP_DAILY_LIMIT'});
 });
 it('enforces the daily message ceiling for both own endpoints',async()=>{
  const f=await readyPair(),p=await profileFor(admin,f.p.profile_id),budget=dailyBudget(p,1,new Date());await consumed(f,budget.max_messages,1);expect(await f.gate()).toMatchObject({allowed:false,reason:'WARMUP_DAILY_LIMIT'});
 });
 it('one own number can serve inbound while waiting without claiming warmup graduation',async()=>{
  const w=await profile(),a=await connection(w);await enrollment(w,a.account);const before=await state(a.account);
  expect(await tx(w,'commerce_automation',db=>withProfileQueryRouting(db,async()=>commercialWarmupGuard(db,(await getRecord(db,w,'channel_account',a.account))!)))).toBeNull();expect(await state(a.account)).toEqual(before);expect(before.status).toBe('AWAITING_PEER');
 });
 it('eligible peers preserve warming while unavailable peers cannot block inbound',async()=>{
  const f=await readyPair(),guard=()=>tx(f.w,'commerce_automation',db=>withProfileQueryRouting(db,async()=>commercialWarmupGuard(db,(await getRecord(db,f.w,'channel_account',f.a.account))!)));
  expect(await guard()).toBe('ACCOUNT_WARMING');await admin.query('UPDATE session_ownership SET frozen=true WHERE account_id=$1',[f.b.account]);expect(await guard()).toBeNull();
  await admin.query('UPDATE warmup_states SET paused=true WHERE account_id=$1',[f.a.account]);expect(await guard()).toBe('ACCOUNT_WARMING');
 });
 it('never advances a planned daily ceiling because the mutable effective day changes',async()=>{
  const f=await readyPair(),p=await profileFor(admin,f.p.profile_id),budget=dailyBudget(p,1,new Date());await consumed(f,budget.max_messages,1);
  await admin.query('UPDATE warmup_states SET effective_days=8 WHERE pool_id=$1',[f.p.id]);expect(await f.gate()).toMatchObject({allowed:false,reason:'WARMUP_DAILY_LIMIT'});
 });
 it('requires member readiness and the existing plan rather than constructing another budget',async()=>{
  const f=await readyPair();await admin.query("UPDATE warmup_states SET profile_ready_at=clock_timestamp()+interval '1 hour' WHERE account_id=$1",[f.b.account]);expect(await f.gate()).toMatchObject({allowed:false,reason:'WARMUP_MEMBER_NOT_READY'});
  await admin.query("UPDATE warmup_states SET profile_ready_at=clock_timestamp()-interval '1 minute' WHERE account_id=$1",[f.b.account]);await admin.query("UPDATE warmup_plans SET budget=jsonb_set(budget,'{max_messages}','999') WHERE account_id=$1",[f.b.account]);expect(await f.gate()).toMatchObject({allowed:false,reason:'WARMUP_PLAN_BUDGET_CHANGED'});
 });
 it('does not count a future-ready peer or an old QR registration as eligible',async()=>{
  const f=await readyPair(),guard=()=>tx(f.w,'commerce_automation',db=>withProfileQueryRouting(db,async()=>commercialWarmupGuard(db,(await getRecord(db,f.w,'channel_account',f.a.account))!)));
  await admin.query("UPDATE warmup_states SET profile_ready_at=clock_timestamp()+interval '1 hour' WHERE account_id=$1",[f.b.account]);expect(await guard()).toBeNull();
  await admin.query("UPDATE warmup_states SET profile_ready_at=clock_timestamp()-interval '1 minute' WHERE account_id=$1",[f.b.account]);await connection(f.w,f.b.account);expect(await guard()).toBeNull();
  await enrollment(f.w,f.b.account);expect(await guard()).toBe('ACCOUNT_WARMING');await connection(f.w,f.a.account);expect(await guard()).toBe('ACCOUNT_WARMING');
 });
 it('refuses unscoped dispatch and foreign profile authority',async()=>{
  const f=await readyPair();expect(await gateWarmupDispatch(admin,f.effect,'qr-gate')).toMatchObject({allowed:false,reason:'CONTINUITY_PROFILE_CONTEXT_REQUIRED'});
  const other=await profile();await expect(tx(other,'commerce_channel',db=>withProfileQueryRouting(db,()=>gateWarmupDispatch(db,f.effect,'qr-gate')))).rejects.toThrow('PROFILE_QUERY_CONTEXT_MISMATCH');
 });

});
