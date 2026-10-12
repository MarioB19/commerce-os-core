/** Restricted real PostgreSQL over explicitly synthetic connection observations.
 * No provider, physical QR, host or external message is invoked. */
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {withProfileTransaction,type ProfileExecutor,type ProfilePool} from '../../packages/db/src/profile-context.js';
import {issueVerifiedQrContinuity,applyContinuousProtection} from '../../packages/db/src/continuous-authorization.js';
import {enrollCurrentQrWarmup} from '../../packages/db/src/qr-warmup.js';
import {readCurrentQrContinuity} from '../../packages/db/src/continuous-warmup.js';
import {reconcileWarmupPool,planWarmupPool} from '../../apps/automation-worker/src/warmup.js';
import {hash,encrypt,decrypt,readOperationalSettings,writeOperationalSettings} from '../../packages/db/src/index.js';
import {systemQrContents} from '../../packages/domain/src/warmup/qr-policy.js';

const suffix=randomBytes(6).toString('hex'),roles=['commerce_api','commerce_channel','commerce_automation']as const;
type Role=typeof roles[number];let admin:pg.Pool;const pools=new Map<Role,pg.Pool>(),scoped=new Map<Role,ProfilePool>(),logins:string[]=[];
const actor='qr_owner_'+suffix;let serial=0;
function tx<T>(workspace:string,role:Role,work:(db:ProfileExecutor)=>Promise<T>){return withProfileTransaction(scoped.get(role)!,workspace,work);}
async function profile(){const workspace='qr_'+suffix+'_'+(++serial);await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic QR','UTC',20,100,100)",[workspace]);return workspace;}
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
async function plan(workspace:string){
 const now=new Date();now.setUTCHours(10,0,0,0);if(now.getTime()<Date.now())now.setUTCDate(now.getUTCDate()+1);
 await admin.query('UPDATE warmup_states SET profile_ready_at=$2 WHERE workspace_id=$1',[workspace,new Date(now.getTime()-1000)]);
 const settings=await readOperationalSettings(admin as any,workspace,'REAL');await writeOperationalSettings(admin as any,workspace,'REAL',settings.version,{...settings.body,dispatch_frozen:false,allow_real_operations:true,real_sends_enabled:true},'synthetic-fixture');
 return tx(workspace,'commerce_automation',async db=>{const p=await pool(workspace);await reconcileWarmupPool(db,p,now);return planWarmupPool(db,p,now);});
}
describe('auto QR enrollment and planner, isolated PostgreSQL',()=>{
 beforeAll(async()=>{
  vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:8,connectionTimeoutMillis:5000});
  if((await admin.query("SELECT to_regclass('public.profiles') present")).rows[0].present)throw Error('TRANSITION_SCHEMA_ALREADY_PRESENT');
  const setup=await admin.connect();try{await setup.query('BEGIN');for(const name of ['001_profile_identity.sql','010_continuous_authorization.sql','012_continuous_effects.sql','013_continuous_worker_profile.sql','015_auto_qr_warmup.sql'])await setup.query(await readFile(new URL('../../packages/db/profile-transition/'+name,import.meta.url),'utf8'));await setup.query('COMMIT');}catch(e){await setup.query('ROLLBACK');throw e;}finally{setup.release();}
  await admin.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$1||\'@example.invalid\',true)',[actor]);
  for(const role of roles){const login='qr_'+role.slice(9)+'_'+suffix,password=randomBytes(24).toString('hex');logins.push(login);
   await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT ${role} TO "${login}"`);
   const u=new URL(url);u.username=login;u.password=password;const p=new pg.Pool({connectionString:u.toString(),max:3});pools.set(role,p);
   scoped.set(role,{async connect(){const c=await p.connect();try{await c.query('SET ROLE '+role);return{query:c.query.bind(c),release:()=>c.release()};}catch(e){c.release();throw e;}}});
  }
 },60000);
 afterAll(async()=>{vi.unstubAllEnvs();for(const p of pools.values())await p.end();if(admin){for(const login of logins)await admin.query(`DROP ROLE IF EXISTS "${login}"`);await admin.end();}});
 it('creates a profile-local v2 pool, encrypted identity and episode without profile metadata',async()=>{
  const w=await profile(),q=await connection(w),result=await enrollment(w,q.account);expect(result.state).toBe('ENROLLED');
  const i=(await admin.query('SELECT * FROM warmup_identities WHERE account_id=$1',[q.account])).rows[0];
  expect(i.profile_verified_at).toBeNull();expect(i.profile_ciphertext).toBeNull();expect(i.qr_command_id).toBe(q.command);expect(i.qr_identity_fingerprint).toBe(q.grant.source.kind==='VERIFIED_QR_CONNECTION'?q.grant.source.identityFingerprint:'invalid');
  expect(decrypt(i.address_ciphertext)).toBe('wa:'+q.raw.split('@')[0]);expect(i.address_ciphertext).not.toContain(q.raw);
  const p=await pool(w);expect(p).toMatchObject({continuity_mode:'QR_CONTINUOUS',enabled:true,allow_small_pool_concentration:true,authorization_id:null});
  expect((await admin.query('SELECT content_hash FROM warmup_content WHERE workspace_id=$1',[w])).rows.map(r=>r.content_hash).sort()).toEqual(systemQrContents.map(c=>c.content_hash).sort());
 });
 it('repeated enrollment preserves episode, dates and existing credits',async()=>{
  const w=await profile(),q=await connection(w);await enrollment(w,q.account);await admin.query('UPDATE warmup_states SET effective_days=3,paused=true WHERE account_id=$1',[q.account]);const before=await state(q.account);
  expect((await enrollment(w,q.account)).state).toBe('ALREADY_ENROLLED');expect(await state(q.account)).toEqual(before);
 });
 it('same-identity reconnect rebinds only observation and preserves paused state/history',async()=>{
  const w=await profile(),q=await connection(w);await enrollment(w,q.account);await admin.query('UPDATE warmup_states SET effective_days=3,paused=true WHERE account_id=$1',[q.account]);const before=await state(q.account);
  const next=await connection(w,q.account);expect((await enrollment(w,q.account)).state).toBe('ENROLLED');expect(await state(q.account)).toEqual(before);
  expect((await admin.query('SELECT qr_command_id FROM warmup_identities WHERE account_id=$1',[q.account])).rows[0].qr_command_id).toBe(next.command);
 });
 it('one own number waits for peer without changing channel or inbound settings',async()=>{
  const w=await profile(),q=await connection(w);await enrollment(w,q.account);const before=(await admin.query('SELECT * FROM channel_sessions WHERE account_id=$1',[q.account])).rows[0];
  expect(await plan(w)).toMatchObject({planned:0,reason:'OWN_PEER_REQUIRED'});expect((await state(q.account)).status).toBe('AWAITING_PEER');
  expect((await admin.query('SELECT * FROM channel_sessions WHERE account_id=$1',[q.account])).rows[0]).toEqual(before);
 });
 it('plans only own-profile effects with permanent sender grants and causal predecessors',async()=>{
  const w=await profile(),a=await connection(w),b=await connection(w),foreign=await connection(await profile());await enrollment(w,a.account);await enrollment(w,b.account);
  expect((await plan(w)).planned).toBeGreaterThan(0);
  const effects=(await admin.query('SELECT * FROM outbox WHERE workspace_id=$1 ORDER BY not_before',[w])).rows;
  expect(effects.length).toBeGreaterThan(0);for(const e of effects){expect(e.authorization_id).toBeNull();expect(e.continuous_authorization_id).toBe(e.account_id===a.account?a.grant.id:b.grant.id);expect([a.account,b.account]).toContain(e.contact_id);expect(e.contact_id).not.toBe(foreign.account);}
  expect(effects[0].predecessor_id).toBeNull();expect(effects.slice(1).some(e=>e.predecessor_id)).toBe(true);
  const count=effects.length;await plan(w);expect((await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[w])).rows[0].n).toBe(count);
 });
 it('protection blocks enrollment and never creates a pool',async()=>{
  const w=await profile(),q=await connection(w);await tx(w,'commerce_channel',db=>applyContinuousProtection(db,'REAL',q.grant.id,'assert',{operationId:randomUUID(),expectedVersion:1,reason:'CHANNEL_DOWN',incidentId:randomUUID(),observedAt:q.grant.createdAt,evidenceSha256:'a'.repeat(64)}));
  expect(await enrollment(w,q.account)).toEqual({state:'AUTHORITY_BLOCKED'});expect(await pool(w)).toBeUndefined();
 });
 it('preserves a stopped pool across subsequent enrollments',async()=>{
  const w=await profile(),a=await connection(w);await enrollment(w,a.account);await admin.query('UPDATE warmup_pools SET paused=true WHERE workspace_id=$1',[w]);const b=await connection(w);
  expect(await enrollment(w,b.account)).toEqual({state:'POOL_STOP_PRESERVED'});expect(await state(b.account)).toBeUndefined();
 });
 it('refuses changed ciphertext, foreign profile and suspended profile',async()=>{
  const w=await profile(),q=await connection(w);await admin.query('UPDATE channel_sessions SET observed_identity_ciphertext=$2 WHERE account_id=$1',[q.account,encrypt('15559999999@c.us')]);
  await expect(enrollment(w,q.account)).rejects.toThrow('QR_OBSERVED_IDENTITY_CHANGED');await expect(enrollment(await profile(),q.account)).rejects.toThrow('QR_CURRENT_CONNECTION_REQUIRED');
  await admin.query("UPDATE profiles SET state='SUSPENDED' WHERE id=$1",[w]);await expect(enrollment(w,q.account)).rejects.toThrow();expect(await pool(w)).toBeUndefined();
 });
 it('does not let the API forge system content, QR pool mode or observation',async()=>{
  const w=await profile(),q=await connection(w);await enrollment(w,q.account);const p=await pool(w);
  await expect(tx(w,'commerce_api',db=>db.query("UPDATE warmup_pools SET continuity_mode='LEGACY' WHERE id=$1",[p.id]))).rejects.toThrow('QR_ORIGIN_IMMUTABLE');
  await expect(tx(w,'commerce_api',db=>db.query('UPDATE warmup_identities SET qr_verified_at=clock_timestamp() WHERE account_id=$1',[q.account]))).rejects.toThrow('QR_ORIGIN_IMMUTABLE');
  await expect(tx(w,'commerce_api',db=>db.query("INSERT INTO warmup_content(workspace_id,environment,content_hash,body,approved_by,origin,policy_version) VALUES($1,'REAL',$2,'{}','system','SYSTEM_QR_POLICY','system-qr-checks/v1')",[w,'f'.repeat(64)]))).rejects.toThrow('QR_ORIGIN_IMMUTABLE');
  await expect(tx(w,'commerce_api',db=>enrollCurrentQrWarmup(db,'REAL',q.account))).rejects.toThrow();
 });
 it('rolls back bootstrap if its audit cannot persist',async()=>{
  const w=await profile(),q=await connection(w);await admin.query("CREATE FUNCTION fail_qr_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='warmup.qr_enrollment_observed' THEN RAISE EXCEPTION 'SYNTHETIC_AUDIT_FAILURE'; END IF;RETURN NEW;END $$;CREATE TRIGGER fail_qr_audit BEFORE INSERT ON domain_events FOR EACH ROW EXECUTE FUNCTION fail_qr_audit()");
  try{await expect(enrollment(w,q.account)).rejects.toThrow('SYNTHETIC_AUDIT_FAILURE');expect(await pool(w)).toBeUndefined();expect(await state(q.account)).toBeUndefined();}finally{await admin.query('DROP TRIGGER fail_qr_audit ON domain_events;DROP FUNCTION fail_qr_audit()');}
 });
 it('preserves legacy membership instead of silently moving it',async()=>{
  const w=await profile(),q=await connection(w),p=randomUUID(),profileId=randomUUID();await admin.query("INSERT INTO warmup_profiles(id,workspace_id,environment,config) VALUES($1,$2,'REAL','{}')",[profileId,w]);await admin.query("INSERT INTO warmup_pools(id,workspace_id,environment,profile_id) VALUES($1,$2,'REAL',$3)",[p,w,profileId]);await admin.query("INSERT INTO warmup_states(account_id,workspace_id,environment,pool_id,profile_id,effective_days,paused) VALUES($1,$2,'REAL',$3,$4,4,true)",[q.account,w,p,profileId]);const before=await state(q.account);
  expect(await enrollment(w,q.account)).toEqual({state:'LEGACY_ADOPTION_REQUIRED'});expect(await state(q.account)).toEqual(before);expect(await pool(w)).toBeUndefined();
 });
 it('uses the latest applied connection even when it lacks a grant',async()=>{
  const w=await profile(),q=await connection(w);const id=randomUUID();await admin.query("INSERT INTO commands(id,workspace_id,environment,kind,resource_id,actor_id,payload,status,idempotency_key) VALUES($1,$2,'REAL','channel_command',$3,$4,'{\"type\":\"connect\"}','APPLIED',$1::uuid::text)",[id,w,q.account,actor]);
  expect(await tx(w,'commerce_automation',db=>readCurrentQrContinuity(db,'REAL',q.account))).toBeUndefined();await expect(enrollment(w,q.account)).rejects.toThrow('QR_CURRENT_CONNECTION_REQUIRED');
 });
 it('rejects expired or operationally paused sessions without partial enrollment',async()=>{
  for(const paused of [true,false]){const w=await profile(),q=await connection(w);
   await admin.query(`UPDATE channel_sessions SET operational_pause=$2,health_expires_at=CASE WHEN $2 THEN health_expires_at ELSE clock_timestamp()-interval '1 second' END WHERE account_id=$1`,[q.account,paused]);
   await expect(enrollment(w,q.account)).rejects.toThrow('QR_CONNECTION_CHANGED');expect(await state(q.account)).toBeUndefined();expect(await pool(w)).toBeUndefined();
  }
 });
 it('does not schedule a protected peer even though its recorded state is ready',async()=>{
  const w=await profile(),a=await connection(w),b=await connection(w);await enrollment(w,a.account);await enrollment(w,b.account);
  await tx(w,'commerce_channel',db=>applyContinuousProtection(db,'REAL',b.grant.id,'assert',{operationId:randomUUID(),expectedVersion:1,reason:'CHANNEL_DOWN',incidentId:randomUUID(),observedAt:b.grant.createdAt,evidenceSha256:'c'.repeat(64)}));
  expect(await plan(w)).toMatchObject({planned:0,reason:'OWN_PEER_REQUIRED'});expect((await admin.query('SELECT 1 FROM outbox WHERE workspace_id=$1',[w])).rows).toEqual([]);
 });
 it('keeps an incompatible open episode untouched and creates no partial pool',async()=>{
  const w=await profile(),q=await connection(w),episode=randomUUID();await admin.query("INSERT INTO warmup_episodes(id,account_id,workspace_id,environment,policy_version,identity_fingerprint,timezone,started_at,created_by) VALUES($1,$2,$3,'REAL','standard-15d/v1',$4,'UTC',clock_timestamp(),'fixture')",[episode,q.account,w,hash(q.raw)]);
  expect(await enrollment(w,q.account)).toEqual({state:'EPISODE_ADOPTION_REQUIRED'});expect(await pool(w)).toBeUndefined();expect((await admin.query('SELECT 1 FROM warmup_identities WHERE account_id=$1',[q.account])).rows).toEqual([]);
 });
 it('uses public record guards even when the session owns a shadow temporary relation',async()=>{
  const w=await profile(),q=await connection(w);
  const result=await tx(w,'commerce_automation',async db=>{await db.query('CREATE TEMP TABLE records (wrong text) ON COMMIT DROP');return enrollCurrentQrWarmup(db,'REAL',q.account);});
  expect(result.state).toBe('ENROLLED');
 });
 it('serializes competing bootstrap without duplicate identity, pool, episode or audit',async()=>{
  const w=await profile(),q=await connection(w);
  const result=await Promise.allSettled([enrollment(w,q.account),enrollment(w,q.account)]);
  expect(result.some(r=>r.status==='fulfilled'&&r.value.state==='ENROLLED')).toBe(true);
  for(const r of result)if(r.status==='rejected')expect(r.reason.message).toBe('QR_ENROLLMENT_BUSY');
  expect((await enrollment(w,q.account)).state).toBe('ALREADY_ENROLLED');
  expect((await admin.query("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND event_type='warmup.qr_enrollment_observed'",[w])).rows[0].n).toBe(1);
  expect((await admin.query('SELECT count(*)::int n FROM warmup_episodes WHERE account_id=$1',[q.account])).rows[0].n).toBe(1);
 });

});
