import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {requireMigratedProfileSchema,sealFixtureProfiles,asProfileOwner} from '../support/migrated-database.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {createPlatformProfile,invitePlatformOwner,isPlatformAdmin,listPlatformProfiles,readPlatformCapacity,updatePlatformProfile} from '../../packages/db/src/platform-profiles.js';
import {acceptExistingProfileInvitation,generateInvitationLink} from '../../packages/db/src/profile-invitation-acceptance.js';

// V7 RF-01.5/RF-02 against the migrated schema with a real non-superuser API login.
const suffix=randomBytes(8).toString('hex'),login='platform_api_'+suffix,adminUser='platform_admin_'+suffix,plainUser='platform_plain_'+suffix,existing='platform_existing_'+suffix;
let admin:pg.Pool,api:pg.Pool;
async function session(user:string,life='1 hour'){const id='session_'+randomUUID();await admin.query('INSERT INTO session(id,"userId",token,"expiresAt") VALUES($1,$2,$1,clock_timestamp()+$3::interval)',[id,user,life]);return{id,userId:user};}
function limits(numbers=2,products=10,dailyConversations=50){return{numbers,products,dailyConversations};}
describe('platform administration outside every profile',()=>{
 beforeAll(async()=>{
  vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));vi.stubEnv('BETTER_AUTH_SECRET','synthetic-platform-'+randomBytes(32).toString('hex'));
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:4,connectionTimeoutMillis:5000});await requireMigratedProfileSchema(admin);
  const password=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT commerce_api TO "${login}"`);
  for(const user of [adminUser,plainUser])await admin.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$1||\'@example.invalid\',true)',[user]);
  // Synthetic installer grant; production adopts the principal owner at cutover.
  await admin.query("INSERT INTO platform_admins(user_id,source) VALUES($1,'INSTALLER')",[adminUser]);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Existing synthetic','UTC',4,10,10)",[existing]);await sealFixtureProfiles(admin,existing);
  await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[plainUser,existing]);
  await asProfileOwner(admin,existing,async c=>{
   await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','product','{\"name\":\"Synthetic product\"}'),($1,'REAL','contact','{\"phone_masked\":\"555-0000\",\"private_note\":\"PRIVATE_SENTINEL\"}')",[existing]);
  });
  url.username=login;url.password=password;api=new pg.Pool({connectionString:url.toString(),max:4,connectionTimeoutMillis:5000});
 },60000);
 afterAll(async()=>{await api?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}vi.unstubAllEnvs();});
 it('admits only an active platform admin with a live native session',async()=>{
  expect(await isPlatformAdmin(api,await session(adminUser))).toBe(true);expect(await isPlatformAdmin(api,await session(plainUser))).toBe(false);
  await expect(listPlatformProfiles(api,await session(plainUser))).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED',statusCode:403});
  await expect(listPlatformProfiles(api,await session(adminUser,'-1 second'))).rejects.toMatchObject({code:'PROFILE_SESSION_EXPIRED',statusCode:401});
  await expect(listPlatformProfiles(api,{id:'missing',userId:adminUser})).rejects.toMatchObject({code:'PROFILE_SESSION_EXPIRED'});
 });
 it('lists aggregate counts and signals without any profile content',async()=>{
  const rows=await listPlatformProfiles(api,await session(adminUser)),row=rows.find(r=>r.id===existing)!;
  expect(row).toMatchObject({businessName:'Existing synthetic',state:'ACTIVE',owners:1,products:1,numbers:{registered:0,connected:0,disconnected:0},limits:{numbers:4,products:10,dailyConversations:10}});
  expect(JSON.stringify(rows)).not.toContain('PRIVATE_SENTINEL');expect(JSON.stringify(rows)).not.toContain('555-0000');
  const capacity=await readPlatformCapacity(api,await session(adminUser));expect(capacity.profiles.max).toBe(3);expect(capacity.numbers.max).toBe(20);expect(capacity.numbers.allocated).toBe(4);
 });
 it('never exposes platform tables or internal ports to the API role directly',async()=>{
  for(const sql of ['SELECT * FROM platform_admins','SELECT * FROM platform_operations',"SELECT platform_operation_replay(gen_random_uuid(),'x','CREATE_PROFILE',repeat('a',64))"])await expect(api.query(sql)).rejects.toMatchObject({code:'42501'});
  const c=await api.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true)",[existing]);await expect(c.query('SELECT * FROM platform_profile_summaries($1,$2)',['x',adminUser])).rejects.toThrow('PLATFORM_OUTSIDE_PROFILE_REQUIRED');}finally{await c.query('ROLLBACK');c.release();}
 });
 it('creates a sealed profile idempotently within installation quotas',async()=>{
  const s=await session(adminUser),operationId=randomUUID(),input={operationId,businessName:'Nuevo negocio',timezone:'America/Mexico_City',limits:limits()};
  const created=await createPlatformProfile(api,s,input);expect(created).toMatchObject({status:'CREATED',version:1,replayed:false});
  expect(await createPlatformProfile(api,s,input)).toEqual({...created,replayed:true});
  await expect(createPlatformProfile(api,s,{...input,businessName:'Otro nombre'})).rejects.toMatchObject({code:'PLATFORM_OPERATION_CONTENT_CHANGED'});
  expect((await admin.query('SELECT count(*)::int n FROM profile_quota_coverage WHERE workspace_id=$1',[created.profileId])).rows[0].n).toBe(1);
  expect((await admin.query('SELECT count(*)::int n FROM memberships WHERE workspace_id=$1',[created.profileId])).rows[0].n).toBe(0);
  await createPlatformProfile(api,s,{operationId:randomUUID(),businessName:'Tercer negocio',timezone:'UTC',limits:limits(1)});
  await expect(createPlatformProfile(api,s,{operationId:randomUUID(),businessName:'Cuarto negocio',timezone:'UTC',limits:limits(0)})).rejects.toMatchObject({code:'PROFILE_QUOTA_ALLOCATION_EXCEEDED'});
  await expect(createPlatformProfile(api,s,{operationId:randomUUID(),businessName:'x',timezone:'Not/AZone',limits:limits()})).rejects.toMatchObject({code:'PLATFORM_PROFILE_INVALID'});
  expect((await admin.query("SELECT kind,count(*)::int n FROM platform_operations GROUP BY kind")).rows).toEqual([{kind:'CREATE_PROFILE',n:2}]);
 });
 it('suspends, reactivates and adjusts limits by exact version, never below consumption',async()=>{
  const s=await session(adminUser),target=(await listPlatformProfiles(api,s)).find(r=>r.id===existing)!;
  const suspended=await updatePlatformProfile(api,s,existing,{operationId:randomUUID(),expectedVersion:target.version,state:'SUSPENDED'});expect(suspended.version).toBe(target.version+1);
  expect((await admin.query('SELECT state FROM profiles WHERE id=$1',[existing])).rows[0].state).toBe('SUSPENDED');
  await expect(updatePlatformProfile(api,s,existing,{operationId:randomUUID(),expectedVersion:target.version,state:'ACTIVE'})).rejects.toMatchObject({code:'PLATFORM_PROFILE_CHANGED'});
  const active=await updatePlatformProfile(api,s,existing,{operationId:randomUUID(),expectedVersion:suspended.version!,state:'ACTIVE'});
  await expect(updatePlatformProfile(api,s,existing,{operationId:randomUUID(),expectedVersion:active.version!,limits:limits(4,0,10)})).rejects.toMatchObject({code:'PROFILE_QUOTA_BELOW_CONSUMED'});
  const changed=await updatePlatformProfile(api,s,existing,{operationId:randomUUID(),expectedVersion:active.version!,limits:limits(3,5,20)});
  expect((await admin.query('SELECT number_limit,product_limit,daily_conversation_limit,version FROM profiles WHERE id=$1',[existing])).rows[0]).toEqual({number_limit:3,product_limit:5,daily_conversation_limit:20,version:changed.version});
  await expect(updatePlatformProfile(api,await session(plainUser),existing,{operationId:randomUUID(),expectedVersion:changed.version!,state:'SUSPENDED'})).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
 });
 it('invites the first owner of an ownerless profile through the custodial mail queue and acceptance',async()=>{
  const s=await session(adminUser),target=(await listPlatformProfiles(api,s)).find(r=>r.businessName==='Nuevo negocio')!;
  const email='first-owner-'+suffix+'@example.invalid',operationId=randomUUID();
  const queued=await invitePlatformOwner(api,s,target.id,{operationId,email});expect(queued.status).toBe('QUEUED');
  expect(await invitePlatformOwner(api,s,target.id,{operationId,email})).toMatchObject({invitationId:queued.invitationId,replayed:true});
  await expect(invitePlatformOwner(api,s,target.id,{operationId:randomUUID(),email})).rejects.toMatchObject({code:'INVITATION_ALREADY_PENDING'});
  await expect(invitePlatformOwner(api,s,existing,{operationId:randomUUID(),email:'other-'+suffix+'@example.invalid'})).rejects.toMatchObject({code:'PLATFORM_PROFILE_HAS_OWNER'});
  const row=(await admin.query('SELECT role,requested_by,platform_requested_by,recipient_ciphertext FROM profile_invitations WHERE id=$1',[queued.invitationId])).rows[0];
  expect(row).toMatchObject({role:'owner',requested_by:null,platform_requested_by:adminUser});expect(row.recipient_ciphertext).not.toContain(email);
  expect((await admin.query('SELECT count(*)::int n FROM profile_invitation_mail_jobs WHERE invitation_id=$1',[queued.invitationId])).rows[0].n).toBe(1);
  // Synthetic delivery preparation (no Mail API), then the recipient accepts.
  const link=generateInvitationLink(),recipient='first_owner_'+suffix;
  await admin.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true)',[recipient,email]);
  await asProfileOwner(admin,target.id,c=>c.query("UPDATE profile_invitations SET delivery='UNCERTAIN',attempt_id=$2,link_digest=$3,dispatched_at=statement_timestamp(),expires_at=statement_timestamp()+interval '24 hours' WHERE id=$1",[queued.invitationId,randomUUID(),link.digest]));
  await acceptExistingProfileInvitation(api,await session(recipient),link.token,'synthetic-correlation');
  expect((await admin.query('SELECT role,active FROM memberships WHERE user_id=$1 AND workspace_id=$2',[recipient,target.id])).rows).toEqual([{role:'owner',active:true}]);
  expect((await admin.query('SELECT count(*)::int n FROM memberships WHERE user_id=$1',[adminUser])).rows[0].n).toBe(0);
 });
 it('stops a platform invitation once its issuer is no longer a platform admin',async()=>{
  const s=await session(adminUser),target=(await listPlatformProfiles(api,s)).find(r=>r.businessName==='Tercer negocio')!;
  const email='late-owner-'+suffix+'@example.invalid',queued=await invitePlatformOwner(api,s,target.id,{operationId:randomUUID(),email}),link=generateInvitationLink(),recipient='late_owner_'+suffix;
  await admin.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true)',[recipient,email]);
  await asProfileOwner(admin,target.id,c=>c.query("UPDATE profile_invitations SET delivery='UNCERTAIN',attempt_id=$2,link_digest=$3,dispatched_at=statement_timestamp(),expires_at=statement_timestamp()+interval '24 hours' WHERE id=$1",[queued.invitationId,randomUUID(),link.digest]));
  await admin.query('UPDATE platform_admins SET active=false,version=version+1 WHERE user_id=$1',[adminUser]);
  try{await expect(acceptExistingProfileInvitation(api,await session(recipient),link.token,'synthetic-correlation')).rejects.toMatchObject({code:'INVITATION_ISSUER_NO_LONGER_AUTHORIZED'});}
  finally{await admin.query('UPDATE platform_admins SET active=true,version=version+1 WHERE user_id=$1',[adminUser]);}
 });
});
