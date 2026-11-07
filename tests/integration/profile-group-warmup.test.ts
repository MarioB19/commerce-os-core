import {bundledGroupLibrary} from '../../packages/domain/src/warmup/group-library.js';
import {openMigratedDatabase} from '../support/migrated-database.js';
import {migrate} from '../../packages/db/src/migrate.js';
import {gateWarmupDispatch} from '../../apps/channel-worker/src/warmup.js';
import {withProfileQueryRouting} from '../../packages/db/src/profile-query-routing.js';
import {bindProfileEnvironment} from '../../packages/db/src/profile-environment.js';
import {lockWarmupProfile,createGroupWarmup,previewGroupWarmup,commandGroupWarmup,readGroupProgram,groupWarmupOverview,listWarmupLibraries,importWarmupLibrary,libraryScripts} from '../../packages/db/src/group-warmup.js';
import {planQrGroupPool} from '../../apps/automation-worker/src/group-qr-planner.js';
import {observeGroup,classifyGroupEvent} from '../../packages/db/src/warmup-groups.js';
import {groupWarmupConfigSchema,type GroupWarmupConfig} from '../../packages/contracts/src/group-warmup.js';
import {getRecord} from '../../packages/db/src/index.js';
/** Restricted real PostgreSQL over explicitly synthetic connection observations.
 * No provider, physical QR, host or external message is invoked. */
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {requireMigratedProfileSchema,fixtureProfileRow} from '../support/migrated-database.js';
import {asProfileOwner} from '../support/migrated-database.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {withProfileTransaction,type ProfileExecutor,type ProfilePool} from '../../packages/db/src/profile-context.js';
import {issueVerifiedQrContinuity,applyContinuousProtection} from '../../packages/db/src/continuous-authorization.js';
import {enrollCurrentQrWarmup} from '../../packages/db/src/qr-warmup.js';
import {planWarmupPool,evaluateWarmupPool} from '../../apps/automation-worker/src/warmup.js';
import {hash,encrypt,decrypt,readOperationalSettings,writeOperationalSettings} from '../../packages/db/src/index.js';

function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}

const suffix=randomBytes(6).toString('hex'),roles=['commerce_api','commerce_channel','commerce_automation']as const;
type Role=typeof roles[number];let admin:pg.Pool;const pools=new Map<Role,pg.Pool>(),scoped=new Map<Role,ProfilePool>(),logins:string[]=[];
const actor='qr_owner_'+suffix;let serial=0;
function tx<T>(workspace:string,role:Role,work:(db:ProfileExecutor)=>Promise<T>){return withProfileTransaction(scoped.get(role)!,workspace,async db=>{await bindProfileEnvironment(db,'REAL');return work(db);});}
// V7 F2: an installation admits three profiles and 20 numbers; each case's fresh
// profile is sealed and the oldest fixture profiles are disposed to make room.
const createdProfiles:string[]=[];
async function profile(){return fixtureProfileRow(admin,createdProfiles,'qr_'+suffix+'_'+(++serial),{businessName:'Synthetic QR',numbers:10,products:100,daily:100});}
async function connection(workspace:string,existing?:string){
 const account=existing??randomUUID(),command=randomUUID(),raw='1555000'+String(++serial).padStart(4,'0')+'@c.us';
 if(!existing)await admin.query("INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,'REAL','channel_account',$3)",[account,workspace,{provider:'waha',status:'WORKING',identity_verified:true,identity_fingerprint:hash(raw),session_provider_at:new Date().toISOString(),health_checked_at:new Date().toISOString(),health_status:'OK'}]);
 const body=(await admin.query('SELECT body FROM records WHERE id=$1',[account])).rows[0].body;
 const observed=existing?decrypt((await admin.query('SELECT observed_identity_ciphertext FROM channel_sessions WHERE account_id=$1',[account])).rows[0].observed_identity_ciphertext):raw;
 await admin.query("INSERT INTO commands(id,workspace_id,environment,kind,resource_id,actor_id,payload,status,idempotency_key,created_at) VALUES($1,$2,'REAL','channel_command',$3,$4,'{\"type\":\"connect\"}','APPLIED',$1::uuid::text,clock_timestamp()-interval '2 seconds')",[command,workspace,account,actor]);
 await admin.query("UPDATE channel_sessions SET desired_state='RUNNING',operational_pause=false,observed_state='CONNECTED',auth_state='VERIFIED',expected_identity_fingerprint=$2,observed_identity_ciphertext=$3,provider_observed_at=clock_timestamp()-interval '1 second',health_expires_at=clock_timestamp()+interval '10 minutes' WHERE account_id=$1",[account,body.identity_fingerprint,encrypt(observed)]);
 const revision=(await admin.query('SELECT revision FROM channel_sessions WHERE account_id=$1',[account])).rows[0].revision;
 const grant=await tx(workspace,'commerce_channel',db=>issueVerifiedQrContinuity(db,'REAL',{operationId:randomUUID(),connectionId:command,accountId:account,expectedSessionRevision:revision,identityFingerprint:body.identity_fingerprint}));
 return{account,command,grant,raw:observed};
}
async function enrollment(workspace:string,account:string){return tx(workspace,'commerce_automation',db=>enrollCurrentQrWarmup(db,'REAL',account));}
async function state(account:string){return(await admin.query('SELECT * FROM warmup_states WHERE account_id=$1',[account])).rows[0];}
async function pool(workspace:string){return(await admin.query("SELECT * FROM warmup_pools WHERE workspace_id=$1 AND continuity_mode='QR_CONTINUOUS'",[workspace])).rows[0];}

async function live(w:string,account:string){
 const body=(await admin.query('SELECT body FROM records WHERE id=$1',[account])).rows[0].body,now=(await admin.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
 await admin.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,frozen,lease_expires_at) VALUES($1,$2,'qr-gate',false,clock_timestamp()+interval '10 minutes') ON CONFLICT(account_id) DO UPDATE SET frozen=false,lease_expires_at=EXCLUDED.lease_expires_at",[account,w]);
 for(const dimension of ['session','transport','restriction','quality'])await admin.query("INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,'REAL','health_signal',$3)",[randomUUID(),w,{account_id:account,dimension,status:'OK',source:'provider_read',scope:'account',availability:'supported',observed_at:new Date(now.getTime()-1000).toISOString(),expires_at:new Date(now.getTime()+600000).toISOString(),value:dimension==='restriction'?{latest_read:{timelock:true,capping:true}}:dimension==='transport'?{identity_fingerprint:body.identity_fingerprint}:{}}]);
}

async function groupFixture(n=3){
 const w=await profile(),lines:Awaited<ReturnType<typeof connection>>[]=[];
 for(let i=0;i<n;i++){const q=await connection(w);await enrollment(w,q.account);lines.push(q);}
 const now=new Date(),offset=now.getUTCHours()-10,timezone=offset===0?'UTC':`Etc/GMT${offset<0?'-':'+'}${Math.abs(offset)}`;
 let group:any;
 const refresh=async()=>{for(const q of lines){group=await tx(w,'commerce_channel',async db=>observeGroup(db,(await getRecord(db,w,'channel_account',q.account))!,{id:'synthetic-'+w+'@g.us',name:'Equipo de prueba',complete:true,adminOnly:false,runtime:{engine:'SIMULATOR',version:'fixture'},observedAt:new Date().toISOString(),members:lines.map(q=>({identity:q.raw,verifiedIdentity:q.raw,admin:true,mappingSource:'provider'}))}));}return group;};
 await refresh();
 const config=groupWarmupConfigSchema.parse({name:'Grupo de prueba',groupId:group.id,senderIds:lines.map(q=>q.account),libraryVersion:'operacion-interna-es/v1',timezone,startHour:0,endHour:23});
 const start=async(c:GroupWarmupConfig=config)=>{
  const created=await tx(w,'commerce_api',db=>createGroupWarmup(db,'REAL',randomUUID(),c,actor));
  const preview=await tx(w,'commerce_api',db=>previewGroupWarmup(db,'REAL',c,created.id));expect(preview.blockers).toEqual([]);
  const result=await tx(w,'commerce_api',db=>commandGroupWarmup(db,'REAL',created.id,{environment:'REAL',operationId:randomUUID(),action:'start',expectedVersion:created.version,previewHash:preview.previewHash},actor));
  return {...result,config:c};
 };
 const schedule=async(id:string)=>{
  const settings=await readOperationalSettings(admin as any,w,'REAL');await writeOperationalSettings(admin as any,w,'REAL',settings.version,{...settings.body,dispatch_frozen:false,allow_real_operations:true,real_sends_enabled:true},'synthetic-fixture');
  await refresh();return tx(w,'commerce_automation',async db=>{const p=await readGroupProgram(db,'REAL',id);const ppool=(await db.query('SELECT * FROM warmup_pools WHERE id=$1',[p.pool_id])).rows[0];return planQrGroupPool(db,ppool,new Date());});
 };
 return{w,lines,config,start,schedule,refresh};
}
describe('V7.2 own group programs under restricted PostgreSQL',()=>{
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

 it.each([2,3,10])('creates and starts a %i-line group via the same API role used by tokens',async n=>{
  const f=await groupFixture(n),p=await f.start(),planned=await f.schedule(p.id);expect(planned.planned).toBeGreaterThan(0);
  const effects=(await admin.query('SELECT * FROM outbox WHERE workspace_id=$1 ORDER BY not_before',[f.w])).rows;
  expect(effects.length).toBeGreaterThan(0);expect(effects.every(e=>e.payload.group_id===f.config.groupId&&e.authorization_id===null&&e.continuous_authorization_id&&e.payload.program_revision===p.version)).toBe(true);
  const again=await f.schedule(p.id);expect(again.planned).toBe(0);expect((await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[f.w])).rows[0].n).toBe(effects.length);
  expect((await tx(f.w,'commerce_api',db=>groupWarmupOverview(db,'REAL'))).programs[0].history.length).toBe(n);
 });
 it('reserves all recipients while sending only from the selected subset',async()=>{
  const f=await groupFixture(3),selected={...f.config,senderIds:f.config.senderIds.slice(0,2)},p=await f.start(selected);await f.schedule(p.id);
  const effects=(await admin.query('SELECT account_id,payload FROM outbox WHERE workspace_id=$1',[f.w])).rows;expect(effects.every(e=>selected.senderIds.includes(e.account_id))).toBe(true);
  const recipients=(await admin.query('SELECT recipient_ids FROM warmup_turns WHERE workspace_id=$1',[f.w])).rows;expect(recipients.every(t=>t.recipient_ids.includes(f.lines[2]!.account))).toBe(true);
  expect((await admin.query('SELECT count(*)::int n FROM warmup_account_reservations WHERE program_id=$1',[p.id])).rows[0].n).toBe(3);
 });
 it.each([false,true])('credits only delivered outgoing evidence once across the next local day (complete=%s)',async complete=>{
  const f=await groupFixture(3),config=complete?{...f.config,senderIds:f.config.senderIds.slice(0,2)}:f.config,p=await f.start(config);await f.schedule(p.id);
  const first=(await admin.query('SELECT id FROM outbox WHERE workspace_id=$1 ORDER BY not_before LIMIT 1',[f.w])).rows[0].id;
  await asProfileOwner(admin,f.w,async db=>{
   // One entire conversation can meet the lower weekend minimum. Deliver just
   // one outgoing turn so this negative fixture stays insufficient every day.
   await db.query("UPDATE outbox SET status=CASE WHEN $2 OR id=$3 THEN 'DELIVERED' ELSE 'CANCELLED' END,attempts=CASE WHEN $2 OR id=$3 THEN 1 ELSE 0 END,claimed_at=clock_timestamp() WHERE workspace_id=$1",[f.w,complete,first]);
  });
  if(!complete){
   expect((await admin.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND status='DELIVERED'",[f.w])).rows[0].n).toBe(1);
   expect((await admin.query("SELECT min((budget->>'min_messages')::int) n FROM warmup_plans WHERE workspace_id=$1",[f.w])).rows[0].n).toBeGreaterThan(1);
  }
  const tomorrow=new Date(Date.now()+86400000);
  await admin.query("UPDATE records SET body=body||jsonb_build_object('health_checked_at',$2::text),version=version+1 WHERE workspace_id=$1 AND kind='channel_account'",[f.w,new Date(tomorrow.getTime()-1000).toISOString()]);
  const evaluate=()=>tx(f.w,'commerce_automation',async db=>{
   const program=await readGroupProgram(db,'REAL',p.id),pool=(await db.query('SELECT * FROM warmup_pools WHERE id=$1',[program.pool_id])).rows[0];
   return withProfileQueryRouting(db,()=>evaluateWarmupPool(db,pool,tomorrow));
  });
  await evaluate();await evaluate();
  const rows=(await admin.query('SELECT account_id,effective_days FROM warmup_states WHERE workspace_id=$1',[f.w])).rows;
  for(const row of rows)expect(row.effective_days).toBe(complete&&config.senderIds.includes(row.account_id)?1:0);
  const credits=(await admin.query('SELECT account_id,evidence FROM warmup_day_credits WHERE workspace_id=$1',[f.w])).rows;
  expect(credits).toHaveLength(complete?2:0);
  for(const credit of credits){const outgoing=(await admin.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND account_id=$2 AND status='DELIVERED'",[f.w,credit.account_id])).rows[0].n;expect(credit.evidence.messages).toBe(outgoing);}
 });
 it('cancels pending on pause, replays operation once and does not create a second copy',async()=>{
  const f=await groupFixture(),p=await f.start();await f.schedule(p.id);const input={environment:'REAL' as const,operationId:randomUUID(),action:'pause' as const,expectedVersion:p.version};
  const paused=await tx(f.w,'commerce_api',db=>commandGroupWarmup(db,'REAL',p.id,input,actor));expect(await tx(f.w,'commerce_api',db=>commandGroupWarmup(db,'REAL',p.id,input,actor))).toEqual(paused);
  expect((await admin.query("SELECT 1 FROM outbox WHERE workspace_id=$1 AND status<>'CANCELLED'",[f.w])).rows).toEqual([]);
  const preview=await tx(f.w,'commerce_api',db=>previewGroupWarmup(db,'REAL',f.config,p.id));expect(preview.ready).toBe(true);
  const resumed=await tx(f.w,'commerce_api',db=>commandGroupWarmup(db,'REAL',p.id,{environment:'REAL',operationId:randomUUID(),action:'resume',expectedVersion:paused.version,previewHash:preview.previewHash},actor));expect(resumed.status).toBe('ACTIVE');expect((await f.schedule(p.id)).planned).toBeGreaterThan(0);
 });
 it('rejects conflicting reservations and foreign-profile group references',async()=>{
  const f=await groupFixture(),p=await f.start();const preview=await tx(f.w,'commerce_api',db=>previewGroupWarmup(db,'REAL',f.config));expect(preview.blockers).toContain('NUMBER_ALREADY_RESERVED');
  const other=await profile();await expect(tx(other,'commerce_api',db=>readGroupProgram(db,'REAL',p.id))).rejects.toThrow('WARMUP_PROGRAM_NOT_FOUND');
  expect((await tx(other,'commerce_api',db=>previewGroupWarmup(db,'REAL',f.config))).blockers).toContain('GROUP_NOT_FOUND');
 });
 it('waits for explicit group selection on new QR enrollment',async()=>{
  const f=await groupFixture(2),qr=await pool(f.w);expect((await state(f.lines[0]!.account)).group_required).toBe(true);
  const before=await tx(f.w,'commerce_automation',db=>planWarmupPool(db,qr,new Date()));expect(before.planned).toBe(0);
 });
 it('keeps library versions immutable, validates import and exposes the bundled corpus',async()=>{
  const f=await groupFixture(2),libs=await tx(f.w,'commerce_api',db=>listWarmupLibraries(db,'REAL'));expect(libs[0].manifest.messages).toBe(5000);
  const input={environment:'REAL' as const,operationId:randomUUID(),version:'equipo/v1',name:'Guion propio',ownershipConfirmed:true as const,scripts:[{label:'Revisión propia',topic:'Operación',ownership_confirmed:true as const,turns:[{kind:'text' as const,text:'Propongo revisar las instrucciones de la actividad de mañana.'},{kind:'text' as const,text:'Podemos empezar por confirmar el orden de los pasos y sus materiales.'}]}]};
  await tx(f.w,'commerce_api',db=>importWarmupLibrary(db,input,actor));await expect(tx(f.w,'commerce_api',db=>importWarmupLibrary(db,{...input,operationId:randomUUID(),scripts:[{...input.scripts[0]!,label:'Cambio del guion'}]},actor))).rejects.toThrow('LIBRARY_VERSION_IMMUTABLE');
  const preview=await tx(f.w,'commerce_api',db=>previewGroupWarmup(db,'REAL',{...f.config,libraryVersion:'equipo/v1'}));expect(preview.blockers).toContain('LIBRARY_COVERAGE_INSUFFICIENT');
 });

 async function readyGroup(){
  const f=await groupFixture(),p=await f.start();await f.schedule(p.id);for(const q of f.lines)await live(f.w,q.account);
  const effect=(await admin.query('SELECT * FROM outbox WHERE workspace_id=$1 ORDER BY not_before LIMIT 1',[f.w])).rows[0];
  await asProfileOwner(admin,f.w,async db=>{const at=new Date(Date.now()-1000);await db.query('UPDATE warmup_turns SET not_before=$2 WHERE effect_id=$1',[effect.id,at]);await db.query('UPDATE outbox SET not_before=$2 WHERE id=$1',[effect.id,at]);effect.not_before=at;});
  const gate=async()=>{await f.refresh();return tx(f.w,'commerce_channel',db=>withProfileQueryRouting(db,()=>gateWarmupDispatch(db,effect,'qr-gate')));};return{...f,p,effect,gate};
 }
 it('passes the final group gate with QR authority and individual recipient scope',async()=>{const f=await readyGroup();expect(await f.gate()).toMatchObject({allowed:true});});
 it('defers a locked group without waiting while the sender owns an outbox row',async()=>{
  const f=await readyGroup(),held=deferred<void>(),release=deferred<void>();
  const holder=tx(f.w,'commerce_api',async db=>{await lockWarmupProfile(db,'REAL');held.resolve();await release.promise;});
  await held.promise;
  try{const result=await tx(f.w,'commerce_channel',async db=>{
   await db.query("SET LOCAL lock_timeout='1000ms'");
   await db.query('SELECT id FROM outbox WHERE id=$1 FOR UPDATE',[f.effect.id]);
   return gateWarmupDispatch(db,f.effect,'qr-gate');
  });expect(result).toMatchObject({allowed:false,reason:'GROUP_WARMUP_BUSY'});
  }finally{release.resolve();await holder;}
  expect(await f.gate()).toMatchObject({allowed:true});
 });
 it('denies final emission after the current QR grant is protected',async()=>{const f=await readyGroup();const peer=f.lines.find(q=>q.account!==f.effect.account_id)!;
  await tx(f.w,'commerce_channel',db=>applyContinuousProtection(db,'REAL',peer.grant.id,'assert',{operationId:randomUUID(),expectedVersion:1,reason:'CHANNEL_DOWN',incidentId:randomUUID(),observedAt:peer.grant.createdAt,evidenceSha256:'c'.repeat(64)}));
  expect(await f.gate()).toMatchObject({allowed:false,reason:'QR_AUTHORITY_PAUSED_OR_PROTECTED'});
 });
 it('blocks unknown sends and preserves them across pause without a retry',async()=>{const f=await readyGroup();const other=(await admin.query('SELECT id FROM outbox WHERE workspace_id=$1 AND id<>$2 LIMIT 1',[f.w,f.effect.id])).rows[0];
  await asProfileOwner(admin,f.w,db=>db.query("UPDATE outbox SET status='UNKNOWN',attempts=1 WHERE id=$1",[other.id]));expect(await f.gate()).toMatchObject({allowed:false,reason:'GROUP_RECONCILIATION_REQUIRED'});
  await tx(f.w,'commerce_api',db=>commandGroupWarmup(db,'REAL',f.p.id,{environment:'REAL',operationId:randomUUID(),expectedVersion:f.p.version,action:'pause'},actor));
  expect((await admin.query('SELECT status,attempts FROM outbox WHERE id=$1',[other.id])).rows[0]).toEqual({status:'UNKNOWN',attempts:1});
  expect((await tx(f.w,'commerce_api',db=>previewGroupWarmup(db,'REAL',f.config,f.p.id))).blockers).toContain('WARMUP_RECONCILIATION_REQUIRED');
 });
 it('preserves the selected group after same-identity QR reconnect, but denies stale queued origins',async()=>{const f=await readyGroup();await connection(f.w,f.lines[0]!.account);expect(await f.gate()).toMatchObject({allowed:false,reason:'CONTINUITY_QR_ORIGIN_CHANGED'});expect((await tx(f.w,'commerce_api',db=>readGroupProgram(db,'REAL',f.p.id))).group_id).toBe(f.config.groupId);});

 it('serializes concurrent planners without duplicate effects or excess daily outgoing quota',async()=>{
  const f=await groupFixture(3),p=await f.start();await admin.query('UPDATE warmup_states SET effective_days=11 WHERE workspace_id=$1',[f.w]);await f.schedule(p.id);
  const before=(await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[f.w])).rows[0].n;
  const results=await Promise.all([f.schedule(p.id),f.schedule(p.id)]);expect(results.every(r=>r.planned===0)).toBe(true);
  const counts=(await admin.query('SELECT account_id,count(*)::int n FROM outbox WHERE workspace_id=$1 GROUP BY account_id',[f.w])).rows;
  expect(counts.reduce((sum,r)=>sum+r.n,0)).toBe(before);expect(before).toBeLessThanOrEqual(300);expect(counts.every(r=>r.n<=100)).toBe(true);
 });
 it('preserves a paused direct pool instead of silently moving its lines',async()=>{const f=await groupFixture(2),direct=await pool(f.w);await admin.query('UPDATE warmup_pools SET paused=true WHERE id=$1',[direct.id]);const preview=await tx(f.w,'commerce_api',db=>previewGroupWarmup(db,'REAL',f.config));expect(preview.blockers).toContain('MEMBER_PAUSED_OR_PROTECTED');});
 it('blocks a newly observed foreign or unresolved member and pauses the existing program',async()=>{
  const f=await groupFixture(),p=await f.start();await f.schedule(p.id);
  const q=f.lines[0]!;await tx(f.w,'commerce_channel',async db=>observeGroup(db,(await getRecord(db,f.w,'channel_account',q.account))!,{id:'synthetic-'+f.w+'@g.us',name:'Equipo de prueba',complete:true,adminOnly:false,runtime:{engine:'SIMULATOR',version:'fixture'},observedAt:new Date().toISOString(),members:[...f.lines.map(q=>({identity:q.raw,verifiedIdentity:q.raw,admin:true,mappingSource:'provider'})),{identity:'unresolved@lid',verifiedIdentity:null,admin:false,mappingSource:'unresolved'}]}));
  const current=await tx(f.w,'commerce_api',db=>readGroupProgram(db,'REAL',p.id));expect(current.status).toBe('PAUSED');expect(current.version).toBeGreaterThan(p.version);
  expect((await tx(f.w,'commerce_api',db=>previewGroupWarmup(db,'REAL',f.config,p.id))).blockers).toContain('GROUP_MEMBER_UNRESOLVED');
 });

 it('starts an imported library with stable content order and rejects invalid text with a client error',async()=>{
  const f=await groupFixture(2),scripts=structuredClone([...bundledGroupLibrary].slice(0,170));
  await tx(f.w,'commerce_api',db=>importWarmupLibrary(db,{environment:'REAL',operationId:randomUUID(),version:'propia-es/v1',name:'Biblioteca propia',scripts,ownershipConfirmed:true},actor));
  expect(await tx(f.w,'commerce_api',db=>libraryScripts(db,'REAL','propia-es/v1'))).toEqual(scripts);
  const p=await f.start({...f.config,libraryVersion:'propia-es/v1'});expect((await f.schedule(p.id)).planned).toBeGreaterThan(0);
  const bad=structuredClone(scripts[0]!);bad.turns[1]!.text=bad.turns[0]!.text;
  await expect(tx(f.w,'commerce_api',db=>importWarmupLibrary(db,{environment:'REAL',operationId:randomUUID(),version:'invalid/v1',name:'Texto inválido',scripts:[bad],ownershipConfirmed:true},actor))).rejects.toMatchObject({code:'LIBRARY_DUPLICATE_MESSAGE',statusCode:400});
 });
 it('replans only unsent effects after same-identity reconnect and uses the new origin',async()=>{
  const f=await groupFixture(),p=await f.start();await f.schedule(p.id);const next=await connection(f.w,f.lines[0]!.account);
  const plan=await f.schedule(p.id);expect(plan.planned).toBeGreaterThan(0);
  const rows=(await admin.query("SELECT payload FROM outbox WHERE workspace_id=$1 AND status='READY'",[f.w])).rows;
  expect(rows.length).toBeGreaterThan(0);expect(rows.every(r=>r.payload.qr_origins[next.account]===next.grant.id)).toBe(true);
 });

 it('upgrades 0117 additively and restarts without altering old pauses, episodes or daily credit',async()=>{
  const old=await openMigratedDatabase('0117');try{
   const w=await fixtureProfileRow(old.pool,[],'upgrade_'+suffix,{numbers:2,products:10,daily:10}),account=randomUUID(),profileId=randomUUID(),poolId=randomUUID();
   await old.pool.query("INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,'REAL','channel_account','{\"provider\":\"waha\",\"status\":\"STOPPED\"}')",[account,w]);
   await old.pool.query("INSERT INTO warmup_profiles(id,workspace_id,environment,config) VALUES($1,$2,'REAL','{}')",[profileId,w]);
   await old.pool.query("INSERT INTO warmup_pools(id,workspace_id,environment,profile_id,continuity_mode,paused) VALUES($1,$2,'REAL',$3,'QR_CONTINUOUS',true)",[poolId,w,profileId]);
   await old.pool.query("INSERT INTO warmup_states(account_id,workspace_id,environment,pool_id,profile_id,effective_days,paused) VALUES($1,$2,'REAL',$3,$4,3,true)",[account,w,poolId,profileId]);
   const before=(await old.pool.query('SELECT * FROM warmup_states WHERE account_id=$1',[account])).rows[0];
   await migrate({pool:old.pool,log:()=>{}});await migrate({pool:old.pool,log:()=>{}});
   const {group_required,...after}=(await old.pool.query('SELECT * FROM warmup_states WHERE account_id=$1',[account])).rows[0];expect(after).toEqual(before);expect(group_required).toBe(false);
   expect((await old.pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n).toBe(118);expect((await old.pool.query('SELECT count(*)::int n FROM outbox')).rows[0].n).toBe(0);
  }finally{await old.close();}
 });

 it.each(['provider','membership'] as const)('serializes %s membership observation before program/group row locks',async source=>{
  const f=await groupFixture(),p=await f.start();await f.schedule(p.id);const line=f.lines[0]!;
  const held=deferred<void>(),release=deferred<void>(),started=deferred<number>();
  const holder=tx(f.w,'commerce_api',async db=>{await lockWarmupProfile(db,'REAL');await db.query('SELECT id FROM warmup_programs WHERE id=$1 FOR SHARE',[p.id]);held.resolve();await release.promise;});
  await held.promise;
  const observer=tx(f.w,'commerce_channel',async db=>{
   started.resolve((await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
   const account=(await getRecord(db,f.w,'channel_account',line.account))!;
   if(source==='membership')return classifyGroupEvent(db,account,{key:randomUUID(),type:'group_membership',providerAt:new Date().toISOString(),groupId:'synthetic-'+f.w+'@g.us',payload:{}},randomUUID());
   return observeGroup(db,account,{id:'synthetic-'+f.w+'@g.us',name:'Equipo de prueba',complete:true,adminOnly:false,runtime:{engine:'SIMULATOR',version:'fixture'},observedAt:new Date().toISOString(),members:[...f.lines.map(q=>({identity:q.raw,verifiedIdentity:q.raw,admin:true,mappingSource:'provider'})),{identity:'unresolved@lid',verifiedIdentity:null,admin:false,mappingSource:'unresolved'}]});
  });observer.catch(()=>{});
  try{
   const pid=await started.promise,deadline=performance.now()+2000;let waiting=false;
   while(performance.now()<deadline){waiting=(await admin.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted) AS waiting",[pid])).rows[0].waiting;if(waiting)break;await admin.query('SELECT pg_sleep(0.01)');}
   expect(waiting).toBe(true);
   expect((await admin.query('SELECT version,status FROM warmup_programs WHERE id=$1',[p.id])).rows[0]).toEqual({version:p.version,status:'ACTIVE'});
  }finally{release.resolve();await Promise.all([holder,observer]);}
  expect((await admin.query('SELECT status FROM warmup_programs WHERE id=$1',[p.id])).rows[0].status).toBe('PAUSED');
 });
});
