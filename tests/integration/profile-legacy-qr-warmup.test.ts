/** Restricted real PostgreSQL over explicitly synthetic connection observations.
 * No provider, physical QR, host or external message is invoked. */
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {withProfileTransaction,type ProfileExecutor,type ProfilePool} from '../../packages/db/src/profile-context.js';
import {issueVerifiedQrContinuity,applyContinuousProtection} from '../../packages/db/src/continuous-authorization.js';
import {reviewLegacyQrAdoption,adoptLegacyQrWarmup,currentLegacyQrAuthority,readLegacyWarmupEffectOrigins} from '../../packages/db/src/legacy-qr-warmup.js';
import type {ProfileAuthority} from '../../packages/domain/src/core/profile-authorization.js';
import {enrollCurrentQrWarmup} from '../../packages/db/src/qr-warmup.js';
import {planWarmupPool} from '../../apps/automation-worker/src/warmup.js';
import {hash,encrypt,decrypt,readOperationalSettings,writeOperationalSettings} from '../../packages/db/src/index.js';
import {gateGroupDispatch} from '../../apps/channel-worker/src/warmup-group-dispatch.js';
import {gateWarmupDispatch} from '../../apps/channel-worker/src/warmup.js';
import {withProfileQueryRouting} from '../../packages/db/src/profile-query-routing.js';
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
function authority(workspace:string):ProfileAuthority{return{profile:{id:workspace,state:'ACTIVE'},membership:{workspaceId:workspace,userId:actor,role:'owner',active:true,version:1},credential:{kind:'session',userId:actor,workspaceId:workspace,expiresAt:'2099-01-01T00:00:00Z',revoked:false,membershipVersion:1,scopes:[]}};}
async function legacy(policy='standard-15d/v2'){
 const w=await profile();await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[actor,w]);
 const q=await connection(w);await enrollment(w,q.account);const p=await pool(w);
 // Explicit synthetic historical participant. Production adoption never updates
 // the pool, profile, identity, episode or credit rows as this fixture does.
 await admin.query("UPDATE warmup_pools SET continuity_mode='LEGACY' WHERE id=$1",[p.id]);
 const replacement=(await admin.query("INSERT INTO warmup_profiles(workspace_id,environment,config) SELECT workspace_id,environment,jsonb_set(config,'{policy_version}',to_jsonb($2::text)) FROM warmup_profiles WHERE id=$1 RETURNING id",[p.profile_id,policy])).rows[0].id;
 await admin.query('UPDATE warmup_pools SET profile_id=$2 WHERE id=$1',[p.id,replacement]);
 await admin.query('UPDATE warmup_states SET profile_id=$2 WHERE pool_id=$1',[p.id,replacement]);p.profile_id=replacement;
 await admin.query('UPDATE warmup_episodes SET policy_version=$2 WHERE account_id=$1',[q.account,policy]);
 await admin.query("UPDATE warmup_identities SET profile_ciphertext=$2,profile_verified_at=clock_timestamp()-interval '2 days',qr_verified_at=NULL,qr_command_id=NULL,qr_identity_fingerprint=NULL WHERE account_id=$1",[q.account,encrypt({name:'Synthetic historical own profile'})]);
 const content={label:'Historical own check',turns:systemQrContents[0].body.turns,ownership_confirmed:true};
 const bodyHash=hash((await import('../../packages/db/src/index.js')).stableJson(content));
 const contentId=(await admin.query("INSERT INTO warmup_content(workspace_id,environment,content_hash,body,approved_by) VALUES($1,'REAL',$2,$3,$4) RETURNING id",[w,bodyHash,content,actor])).rows[0].id;
 const scope={mode:'warmup',pool_id:p.id,account_ids:[q.account],content_ids:[contentId],max_messages:1000};
 const auth=(await admin.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at) VALUES($1,'REAL',$2,$3,$4,clock_timestamp()-interval '1 day') RETURNING id",[w,actor,scope,hash(JSON.stringify(scope))])).rows[0].id;
 await admin.query('UPDATE warmup_pools SET authorization_id=$2 WHERE id=$1',[p.id,auth]);
 await admin.query('UPDATE warmup_states SET effective_days=4,paused=true WHERE account_id=$1',[q.account]);
 return{w,q,p,contentId,auth};
}
async function adopt(f:Awaited<ReturnType<typeof legacy>>){return tx(f.w,'commerce_api',async db=>{const review=await reviewLegacyQrAdoption(db,'REAL',f.q.account,authority(f.w));const command={operationId:randomUUID(),accountId:f.q.account,expectedStateVersion:review.snapshot.stateVersion,snapshotSha256:review.sha256};return{command,row:await adoptLegacyQrWarmup(db,'REAL',command,authority(f.w))};});}
async function peer(f:Awaited<ReturnType<typeof legacy>>){
 const q=await connection(f.w);await enrollment(f.w,q.account);
 await admin.query('UPDATE warmup_states SET pool_id=$2,profile_id=$3,effective_days=4 WHERE account_id=$1',[q.account,f.p.id,f.p.profile_id]);
 await admin.query("UPDATE warmup_episodes SET policy_version=(SELECT config->>'policy_version' FROM warmup_profiles WHERE id=$2) WHERE account_id=$1",[q.account,f.p.profile_id]);
 await admin.query("UPDATE warmup_identities SET profile_ciphertext=$2,profile_verified_at=clock_timestamp()-interval '2 days',qr_verified_at=NULL,qr_command_id=NULL,qr_identity_fingerprint=NULL WHERE account_id=$1",[q.account,encrypt({name:'Synthetic own historical peer'})]);
 await admin.query("UPDATE operation_authorizations SET scope=jsonb_set(scope,'{account_ids}',$2) WHERE id=$1",[f.auth,JSON.stringify([f.q.account,q.account])]);
 return{...f,q};
}
async function planned(f:Awaited<ReturnType<typeof legacy>>){
 const now=new Date();now.setUTCHours(10,0,0,0);if(now.getTime()<Date.now())now.setUTCDate(now.getUTCDate()+1);
 await admin.query("UPDATE warmup_states SET paused=false,status='WARMING',profile_ready_at=$2 WHERE pool_id=$1",[f.p.id,new Date(now.getTime()-1000)]);
 const settings=await readOperationalSettings(admin as any,f.w,'REAL');if(settings.body.dispatch_frozen||!settings.body.real_sends_enabled||!settings.body.allow_real_operations)await writeOperationalSettings(admin as any,f.w,'REAL',settings.version,{...settings.body,dispatch_frozen:false,allow_real_operations:true,real_sends_enabled:true},'synthetic-fixture');
 const config=(await readOperationalSettings(admin as any,f.w,'REAL')).version;
 await admin.query('UPDATE operation_authorizations SET configuration_version=$2 WHERE id=$1',[f.auth,config]);
 return tx(f.w,'commerce_automation',async db=>planWarmupPool(db,(await db.query('SELECT * FROM warmup_pools WHERE id=$1',[f.p.id])).rows[0],now));
}
async function groupFixture(topology:'group'|'direct'='group'){
 const f=await legacy(),other=await peer(f),clock=(await admin.query('SELECT clock_timestamp() AS now')).rows[0].now as Date,offset=12-clock.getUTCHours(),timezone=offset===0?'UTC':`Etc/GMT${offset>0?'-':'+'}${Math.abs(offset)}`;
 const replacement=(await admin.query("INSERT INTO warmup_profiles(workspace_id,environment,config) SELECT workspace_id,environment,jsonb_set(config,'{timezone}',to_jsonb($2::text)) FROM warmup_profiles WHERE id=$1 RETURNING id",[f.p.profile_id,timezone])).rows[0].id;
 await admin.query('UPDATE warmup_pools SET profile_id=$2 WHERE id=$1',[f.p.id,replacement]);await admin.query("UPDATE warmup_states SET profile_id=$2,effective_days=0,paused=false,status='WARMING',profile_ready_at=clock_timestamp()-interval '1 minute' WHERE pool_id=$1",[f.p.id,replacement]);f.p.profile_id=replacement;
 const content={label:'Synthetic six own group checks',ownership_confirmed:true,turns:Array.from({length:6},(_,i)=>({kind:'text',text:'Internal group verification '+i}))};
 const contentId=(await admin.query("INSERT INTO warmup_content(workspace_id,environment,content_hash,body,approved_by) VALUES($1,'REAL',$2,$3,$4) RETURNING id",[f.w,hash((await import('../../packages/db/src/index.js')).stableJson(content)),content,actor])).rows[0].id;
 // Group membership observations use the same host clock as numberNow(REAL).
 // PostgreSQL remains the authority clock for permission/lease expiry.
 const ids=[f.q.account,other.q.account],at=new Date();
 const group=(await admin.query("INSERT INTO warmup_groups(workspace_id,environment,provider,group_fingerprint,group_ciphertext,name,members,permissions,capabilities,observed_at,expires_at,source) VALUES($1,'REAL','waha',$2,$3,'Synthetic own group',$4,'{}',$5,$6,$7,'synthetic_fixture') RETURNING *",[f.w,hash('synthetic-group-'+f.w),encrypt('synthetic-own@g.us'),JSON.stringify(ids.map(id=>({account_id:id,admin:true}))),{all_members_resolved:true,observations:Object.fromEntries(ids.map(id=>[id,{observed_at:at.toISOString()}]))},at,new Date(at.getTime()+60000)])).rows[0];
 if(topology==='group')await admin.query("UPDATE warmup_pools SET topology='group',group_id=$2 WHERE id=$1",[f.p.id,group.id]);
 const settings=await readOperationalSettings(admin as any,f.w,'REAL');await writeOperationalSettings(admin as any,f.w,'REAL',settings.version,{...settings.body,dispatch_frozen:false,allow_real_operations:true,real_sends_enabled:true},'synthetic-fixture');
 const config=(await readOperationalSettings(admin as any,f.w,'REAL')).version;
 await admin.query("UPDATE operation_authorizations SET expires_at=clock_timestamp()+interval '1 hour',configuration_version=$2,scope=$3 WHERE id=$1",[f.auth,config,{mode:'warmup',pool_id:f.p.id,account_ids:ids,content_ids:[contentId],max_messages:1000,sender_limits:Object.fromEntries(ids.map(id=>[id,500])),...(topology==='group'?{group_id:group.id,membership_version:group.version}:{}),purpose:'preparation',policy_version:'standard-15d/v2'}]);
 await adopt(f);
 for(const q of [f.q,other.q]){
  await admin.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,frozen,lease_expires_at) VALUES($1,$2,'legacy-group',false,clock_timestamp()+interval '10 minutes')",[q.account,f.w]);
  for(const dimension of ['session','transport','restriction','quality'])await admin.query("INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,'REAL','health_signal',$3)",[randomUUID(),f.w,{account_id:q.account,dimension,status:'OK',source:'provider_read',scope:'account',availability:'supported',observed_at:new Date(at.getTime()-1000).toISOString(),expires_at:new Date(at.getTime()+600000).toISOString(),value:dimension==='restriction'?{latest_read:{timelock:true,capping:true}}:dimension==='transport'?{identity_fingerprint:hash(q.raw)}:{}}]);
 }
 expect((await tx(f.w,'commerce_automation',async db=>planWarmupPool(db,(await db.query('SELECT * FROM warmup_pools WHERE id=$1',[f.p.id])).rows[0],at))).planned).toBeGreaterThan(0);
 const effect=(await admin.query('SELECT * FROM outbox WHERE workspace_id=$1 AND predecessor_id IS NULL ORDER BY dispatch_sequence LIMIT 1',[f.w])).rows[0];
 await tx(f.w,'commerce_automation',async db=>{const time=(await db.query("SELECT clock_timestamp()-interval '1 second' AS before,clock_timestamp()+interval '5 minutes' AS expiry")).rows[0];await db.query('UPDATE warmup_turns SET not_before=$2,expires_at=$3 WHERE effect_id=$1',[effect.id,time.before,time.expiry]);await db.query('UPDATE outbox SET not_before=$2,expires_at=$3 WHERE id=$1',[effect.id,time.before,time.expiry]);});
 const gate=()=>tx(f.w,'commerce_channel',db=>withProfileQueryRouting(db,async()=>(topology==='group'?gateGroupDispatch:gateWarmupDispatch)(db,(await db.query('SELECT * FROM outbox WHERE id=$1',[effect.id])).rows[0],'legacy-group')));
 return{...f,other,group,effect,gate};
}
describe('legacy QR adoption and reconnect, isolated PostgreSQL',()=>{
 beforeAll(async()=>{
  vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:8,connectionTimeoutMillis:5000});
  if((await admin.query("SELECT to_regclass('public.profiles') present")).rows[0].present)throw Error('TRANSITION_SCHEMA_ALREADY_PRESENT');
  const setup=await admin.connect();try{await setup.query('BEGIN');for(const name of ['001_profile_identity.sql','010_continuous_authorization.sql','012_continuous_effects.sql','013_continuous_worker_profile.sql','015_auto_qr_warmup.sql','016_legacy_qr_warmup_adoption.sql'])await setup.query(await readFile(new URL('../../packages/db/profile-transition/'+name,import.meta.url),'utf8'));await setup.query('COMMIT');}catch(e){await setup.query('ROLLBACK');throw e;}finally{setup.release();}
  await admin.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$1||\'@example.invalid\',true)',[actor]);
  for(const role of roles){const login='qr_'+role.slice(9)+'_'+suffix,password=randomBytes(24).toString('hex');logins.push(login);
   await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT ${role} TO "${login}"`);
   const u=new URL(url);u.username=login;u.password=password;const p=new pg.Pool({connectionString:u.toString(),max:3});pools.set(role,p);
   scoped.set(role,{async connect(){const c=await p.connect();try{await c.query('SET ROLE '+role);return{query:c.query.bind(c),release:()=>c.release()};}catch(e){c.release();throw e;}}});
  }
 },60000);
 afterAll(async()=>{vi.unstubAllEnvs();for(const p of pools.values())await p.end();if(admin){for(const login of logins)await admin.query(`DROP ROLE IF EXISTS "${login}"`);await admin.end();}});
 it.each(['legacy-30d/v1','standard-15d/v1','standard-15d/v2'])('adopts %s without translating or changing credits, episode or pause',async policy=>{
 const f=await legacy(policy),before=await state(f.q.account),pBefore=(await admin.query('SELECT * FROM warmup_pools WHERE id=$1',[f.p.id])).rows[0],result=await adopt(f);
 expect(result.row.policy_version).toBe(policy);expect(result.row.origin).toBe('MIGRATION_QR');expect(await state(f.q.account)).toEqual(before);expect((await admin.query('SELECT * FROM warmup_pools WHERE id=$1',[f.p.id])).rows[0]).toEqual(pBefore);
 expect((await tx(f.w,'commerce_api',db=>adoptLegacyQrWarmup(db,'REAL',result.command,authority(f.w)))).id).toBe(result.row.id);
 });
 it('relinks once after same-identity reconnect, with no owner reactivation or credit reset',async()=>{
 const f=await legacy(),initial=await adopt(f),before=await state(f.q.account);const next=await connection(f.w,f.q.account);
 const read=()=>tx(f.w,'commerce_automation',db=>currentLegacyQrAuthority(db,'REAL',f.q.account));const result=await read();expect(result.kind).toBe('ADOPTED');if(result.kind!=='ADOPTED')throw Error('FIXTURE');expect(result.grant.id).toBe(next.grant.id);expect((await read())).toEqual(result);expect(await state(f.q.account)).toEqual(before);
 const history=(await admin.query('SELECT * FROM warmup_continuity_adoptions WHERE account_id=$1 ORDER BY version',[f.q.account])).rows;expect(history).toHaveLength(2);expect(history[1]).toMatchObject({previous_id:initial.row.id,origin:'QR_RELINK',actor_id:actor});
 });
 it('blocks identity or program changes without falling back to expired temporal authority',async()=>{
 const f=await legacy();await adopt(f);const changed=(await admin.query("INSERT INTO warmup_profiles(workspace_id,environment,config) SELECT workspace_id,environment,jsonb_set(config,'{rate_per_minute}','1') FROM warmup_profiles WHERE id=$1 RETURNING id",[f.p.profile_id])).rows[0].id;await admin.query('UPDATE warmup_pools SET profile_id=$2 WHERE id=$1',[f.p.id,changed]);await admin.query('UPDATE warmup_states SET profile_id=$2 WHERE pool_id=$1',[f.p.id,changed]);
 expect(await tx(f.w,'commerce_automation',db=>currentLegacyQrAuthority(db,'REAL',f.q.account))).toMatchObject({kind:'BLOCKED',reason:'QR_ADOPTION_PROGRAM_OR_IDENTITY_CHANGED'});
 });
 it('rejects runtime mutation of adoption history and a foreign profile',async()=>{
 const f=await legacy(),a=await adopt(f),other=await profile();
 await expect(tx(f.w,'commerce_automation',db=>db.query('UPDATE warmup_continuity_adoptions SET id=$1 WHERE id=$1',[a.row.id]))).rejects.toThrow('QR_ADOPTION_IMMUTABLE');
 expect((await tx(other,'commerce_automation',db=>db.query('SELECT * FROM warmup_continuity_adoptions WHERE id=$1',[a.row.id]))).rows).toHaveLength(0);
 });
 it('rejects review drift and a non-owner session before insertion',async()=>{
 const f=await legacy(),review=await tx(f.w,'commerce_api',db=>reviewLegacyQrAdoption(db,'REAL',f.q.account,authority(f.w)));
 await admin.query('UPDATE warmup_states SET version=version+1 WHERE account_id=$1',[f.q.account]);const command={operationId:randomUUID(),accountId:f.q.account,expectedStateVersion:review.snapshot.stateVersion,snapshotSha256:review.sha256};
 await expect(tx(f.w,'commerce_api',db=>adoptLegacyQrWarmup(db,'REAL',command,authority(f.w)))).rejects.toThrow('QR_ADOPTION_REVIEW_CHANGED');
 const a=authority(f.w);a.membership.role='operator';await expect(tx(f.w,'commerce_api',db=>reviewLegacyQrAdoption(db,'REAL',f.q.account,a))).rejects.toThrow();
 });
 it('keeps protection and the old grant after reconnect; only a current unblocked origin can relink',async()=>{
  const f=await legacy(),a=await adopt(f);await tx(f.w,'commerce_channel',db=>applyContinuousProtection(db,'REAL',f.q.grant.id,'assert',{operationId:randomUUID(),expectedVersion:1,reason:'CHANNEL_DOWN',incidentId:randomUUID(),observedAt:f.q.grant.createdAt,evidenceSha256:'d'.repeat(64)}));
  expect(await tx(f.w,'commerce_automation',db=>currentLegacyQrAuthority(db,'REAL',f.q.account))).toMatchObject({kind:'BLOCKED',reason:'QR_ADOPTION_AUTHORITY_BLOCKED'});
  expect((await admin.query('SELECT count(*)::int n FROM warmup_continuity_adoptions WHERE account_id=$1',[f.q.account])).rows[0].n).toBe(1);expect(a.row.grant_id).toBe(f.q.grant.id);
 });
 it('rejects an episode from a different policy without converting credits',async()=>{
  const f=await legacy();await admin.query("UPDATE warmup_episodes SET policy_version='standard-15d/v1' WHERE account_id=$1",[f.q.account]);
  await expect(adopt(f)).rejects.toThrow('QR_ADOPTION_EPISODE_CHANGED');
 });

 it('a mixed pair keeps a distinct origin per sender and cannot borrow a missing legacy permission',async()=>{
  const f=await legacy(),other=await peer(f);await adopt(f);
  expect((await planned(f)).planned).toBe(0);
  await admin.query("UPDATE operation_authorizations SET expires_at=clock_timestamp()+interval '3 days' WHERE id=$1",[f.auth]);
  expect((await planned(f)).planned).toBeGreaterThan(0);
  const rows=(await admin.query('SELECT account_id,authorization_id,continuous_authorization_id FROM outbox WHERE workspace_id=$1',[f.w])).rows;expect(rows.length).toBeGreaterThan(0);
  for(const row of rows)expect(row).toMatchObject(row.account_id===f.q.account?{authorization_id:null,continuous_authorization_id:f.q.grant.id}:{account_id:other.q.account,authorization_id:f.auth,continuous_authorization_id:null});
  const first=(await admin.query('SELECT id FROM outbox WHERE workspace_id=$1 ORDER BY dispatch_sequence LIMIT 1',[f.w])).rows[0];
  const origins=await tx(f.w,'commerce_channel',db=>readLegacyWarmupEffectOrigins(db,'REAL',first.id));expect(origins).toHaveLength(2);
  expect(origins.find(x=>x.participant_id===f.q.account)).toMatchObject({grant_id:f.q.grant.id,legacy_authorization_id:null});
  expect(origins.find(x=>x.participant_id===other.q.account)).toMatchObject({adoption_id:null,legacy_authorization_id:f.auth});
  await expect(tx(f.w,'commerce_automation',db=>db.query("UPDATE warmup_plans SET budget=jsonb_set(budget,'{max_messages}','999') WHERE account_id=$1",[f.q.account]))).rejects.toThrow('WARMUP_PLAN_ORIGIN_IMMUTABLE');

 });
 it('both adopted participants plan with expired TTL without converting their pool or credits',async()=>{
  const f=await legacy(),other=await peer(f);await adopt(f);await adopt(other);
  expect((await planned(f)).planned).toBeGreaterThan(0);
  expect((await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND (authorization_id IS NOT NULL OR continuous_authorization_id IS NULL)',[f.w])).rows[0].n).toBe(0);
  expect((await admin.query('SELECT continuity_mode FROM warmup_pools WHERE id=$1',[f.p.id])).rows[0].continuity_mode).toBe('LEGACY');
 });

 it.each(['legacy-30d/v1','standard-15d/v1'])('keeps %s planning under its own historical requirements after adoption',async policy=>{
  const f=await legacy(policy),other=await peer(f);await adopt(f);await adopt(other);
  const before=(await admin.query('SELECT account_id,episode_id,effective_days FROM warmup_states WHERE pool_id=$1 ORDER BY account_id',[f.p.id])).rows;
  if(policy==='standard-15d/v1'){
   expect((await planned(f)).planned).toBe(0);
   // Explicit synthetic historical declarations, never produced by adoption.
   for(const q of [f.q,other.q]){
    await admin.query("UPDATE warmup_episodes SET started_at=clock_timestamp()-interval '6 days' WHERE account_id=$1",[q.account]);
    for(const [index,task]of ['authentic_profile','responsible_device','consented_contacts','human_conversations'].entries())await admin.query("INSERT INTO warmup_manual_declarations(episode_id,task,status,actor,source,recorded_at,local_date,note) SELECT id,$2,'COMPLETED',$3,'operator_declaration',clock_timestamp()-$4::integer*interval '1 day',(clock_timestamp()-$4::integer*interval '1 day')::date,'SYNTHETIC HISTORICAL FIXTURE' FROM warmup_episodes WHERE account_id=$1",[q.account,task,actor,5-index]);
   }
  }
  expect((await planned(f)).planned).toBeGreaterThan(0);
  expect((await admin.query('SELECT account_id,episode_id,effective_days FROM warmup_states WHERE pool_id=$1 ORDER BY account_id',[f.p.id])).rows).toEqual(before);
  expect((await admin.query('SELECT DISTINCT policy_version FROM warmup_continuity_adoptions WHERE workspace_id=$1',[f.w])).rows).toEqual([{policy_version:policy}]);
  expect((await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND authorization_id IS NOT NULL',[f.w])).rows[0].n).toBe(0);
 });

 it('rolls back a newly copied adopted effect without the complete immutable participant origins',async()=>{
  const f=await legacy(),other=await peer(f);await adopt(f);await adopt(other);await planned(f);
  const original=(await admin.query('SELECT id FROM outbox WHERE workspace_id=$1 LIMIT 1',[f.w])).rows[0].id,newId=randomUUID();
  await expect(tx(f.w,'commerce_automation',db=>db.query(`INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,logical_key,kind,payload,config_hash,approval_hash,continuous_authorization_id,not_before,expires_at)
   SELECT $2,workspace_id,environment,account_id,conversation_id,contact_id,$2::uuid::text,kind,payload,config_hash,approval_hash,continuous_authorization_id,not_before,expires_at FROM outbox WHERE id=$1`,[original,newId]))).rejects.toThrow('QR_EFFECT_ORIGINS_INCOMPLETE');
  expect((await admin.query('SELECT 1 FROM outbox WHERE id=$1',[newId])).rowCount).toBe(0);
  await expect(tx(f.w,'commerce_automation',db=>db.query('DELETE FROM warmup_effect_origins WHERE effect_id=$1',[original]))).rejects.toThrow();
 });

 it('a mixed group retains participant sources and passes the native gate with synthetic provider observations',async()=>{
  const f=await groupFixture();expect(await f.gate()).toMatchObject({allowed:true});
  const rows=await tx(f.w,'commerce_channel',db=>readLegacyWarmupEffectOrigins(db,'REAL',f.effect.id));expect(rows).toHaveLength(2);expect(rows.filter(x=>x.grant_id)).toHaveLength(1);expect(rows.filter(x=>x.legacy_authorization_id)).toHaveLength(1);
  await admin.query('UPDATE warmup_groups SET version=version+1 WHERE id=$1',[f.group.id]);expect(await f.gate()).toMatchObject({allowed:false,reason:'GROUP_MEMBERSHIP_CHANGED'});
 });
 it('a mixed group cannot borrow authority or readiness from its adopted participant',async()=>{
  const f=await groupFixture();
  await admin.query("UPDATE operation_authorizations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.auth]);
  expect(await f.gate()).toMatchObject({allowed:false,reason:'QR_EFFECT_LEGACY_CHANGED'});
  await admin.query("UPDATE operation_authorizations SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[f.auth]);
  await admin.query("UPDATE warmup_states SET profile_ready_at=clock_timestamp()+interval '1 hour' WHERE account_id=$1",[f.other.q.account]);
  expect(await f.gate()).toMatchObject({allowed:false,reason:'WARMUP_MEMBER_NOT_READY'});
  await admin.query("UPDATE warmup_states SET profile_ready_at=clock_timestamp()-interval '1 hour',paused=true WHERE account_id=$1",[f.other.q.account]);
  expect(await f.gate()).toMatchObject({allowed:false,reason:'WARMUP_MEMBER_NOT_READY'});
  expect((await admin.query('SELECT count(*)::int n FROM warmup_effect_origins WHERE effect_id=$1',[f.effect.id])).rows[0].n).toBe(2);
 });
 it('a direct mixed conversation passes the native gate with each participant source intact',async()=>{
  const f=await groupFixture('direct');expect(await f.gate()).toMatchObject({allowed:true});
  const rows=await tx(f.w,'commerce_channel',db=>readLegacyWarmupEffectOrigins(db,'REAL',f.effect.id));expect(rows).toHaveLength(2);expect(rows.filter(x=>x.grant_id)).toHaveLength(1);expect(rows.filter(x=>x.legacy_authorization_id)).toHaveLength(1);
  await admin.query("UPDATE operation_authorizations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.auth]);
  expect(await f.gate()).toMatchObject({allowed:false,reason:'QR_EFFECT_LEGACY_CHANGED'});
 });
 it('a direct effect keeps its old source and is denied after a participant reconnects',async()=>{
  const f=await groupFixture('direct'),before=(await admin.query('SELECT * FROM warmup_effect_origins WHERE effect_id=$1 ORDER BY participant_id',[f.effect.id])).rows;
  await connection(f.w,f.q.account);expect(await f.gate()).toMatchObject({allowed:false,reason:'QR_EFFECT_ADOPTION_CHANGED'});
  expect((await admin.query('SELECT * FROM warmup_effect_origins WHERE effect_id=$1 ORDER BY participant_id',[f.effect.id])).rows).toEqual(before);
 });
 it('rechecks a temporal participant at the final database clock after its transaction crosses expiry',async()=>{
  const f=await groupFixture('direct');
  await admin.query("UPDATE operation_authorizations SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1",[f.auth]);
  const result=await tx(f.w,'commerce_channel',db=>withProfileQueryRouting(db,async()=>{
   expect((await db.query('SELECT * FROM read_locked_operation_authorization($1,$2,$3)',[f.auth,f.w,'REAL'])).rows).toHaveLength(1);
   await db.query('SELECT pg_sleep(0.7)');
   return gateWarmupDispatch(db,(await db.query('SELECT * FROM outbox WHERE id=$1',[f.effect.id])).rows[0],'legacy-group');
  }));
  expect(result).toMatchObject({allowed:false,reason:'QR_EFFECT_LEGACY_EXPIRED'});
 });
 it('reconnecting an adopted group participant never relinks an old effect or its source records',async()=>{
  const f=await groupFixture(),before=(await admin.query('SELECT * FROM warmup_effect_origins WHERE effect_id=$1 ORDER BY participant_id',[f.effect.id])).rows;
  await connection(f.w,f.q.account);expect(await f.gate()).toMatchObject({allowed:false,reason:'QR_EFFECT_ADOPTION_CHANGED'});
  expect((await admin.query('SELECT * FROM warmup_effect_origins WHERE effect_id=$1 ORDER BY participant_id',[f.effect.id])).rows).toEqual(before);
  expect((await admin.query('SELECT count(*)::int n FROM warmup_continuity_adoptions WHERE account_id=$1',[f.q.account])).rows[0].n).toBe(1);
 });

});
