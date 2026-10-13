import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {requireMigratedProfileSchema,sealFixtureProfiles,asProfileOwner} from '../support/migrated-database.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {cancelPlatformProfileDeletion,platformProfileDeletionState,requestPlatformProfileDeletion,updatePlatformProfile} from '../../packages/db/src/platform-profiles.js';
import {exportProfileData} from '../../packages/db/src/profile-export.js';
import {withProfileTransaction} from '../../packages/db/src/profile-context.js';
import type {ProfileAuthority} from '../../packages/domain/src/core/profile-authorization.js';
import type {ProfileRole} from '../../packages/contracts/src/profiles.js';

// V7 RF-01.5: the owner exports the profile's own data (readable, without
// secrets) and only then may the platform admin request its deletion, typing
// the exact name of a suspended profile. The request erases nothing; it keeps
// the profile suspended until the D-18 erasure window or a cancellation.
const suffix=randomBytes(8).toString('hex'),login='deletion_api_'+suffix,adminUser='deletion_admin_'+suffix,owner='deletion_owner_'+suffix,
 plainUser='deletion_plain_'+suffix,P='deletion_profile_'+suffix,NAME='Negocio borrable sintético';
let admin:pg.Pool,api:pg.Pool;
async function session(user:string){const id='session_'+randomUUID();await admin.query('INSERT INTO session(id,"userId",token,"expiresAt") VALUES($1,$2,$1,clock_timestamp()+interval \'1 hour\')',[id,user]);return{id,userId:user};}
function authority(role:ProfileRole,state:'ACTIVE'|'SUSPENDED'='ACTIVE'):ProfileAuthority{
 return{profile:{id:P,state},membership:{userId:owner,workspaceId:P,role,active:true,version:1},
  credential:{kind:'session',userId:owner,workspaceId:P,revoked:false,expiresAt:new Date(Date.now()+3600000).toISOString(),scopes:[],membershipVersion:1}};
}
const exportAs=(a:ProfileAuthority)=>withProfileTransaction(api as never,P,async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");return exportProfileData(db,a);});
const version=async()=>(await admin.query('SELECT version FROM profiles WHERE id=$1',[P])).rows[0].version as number;
describe('profile export and deletion request (RF-01.5)',()=>{
 beforeAll(async()=>{
  vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));vi.stubEnv('BETTER_AUTH_SECRET','synthetic-deletion-'+randomBytes(32).toString('hex'));
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:4,connectionTimeoutMillis:5000});await requireMigratedProfileSchema(admin);
  const password=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT commerce_api TO "${login}"`);
  for(const user of [adminUser,owner,plainUser])await admin.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$1||\'@example.invalid\',true)',[user]);
  await admin.query("INSERT INTO platform_admins(user_id,source) VALUES($1,'INSTALLER')",[adminUser]);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,$2,'UTC',1,10,10)",[P,NAME]);await sealFixtureProfiles(admin,P);
  await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[owner,P]);
  await asProfileOwner(admin,P,async c=>{
   await c.query(`INSERT INTO records(workspace_id,environment,kind,body) VALUES
    ($1,'REAL','product','{"name":"Curso sintético","price":"499"}'),
    ($1,'REAL','contact','{"display_name":"Cliente sintético","private_note":"OWN_DATA_SENTINEL","access_token":"SECRET_SENTINEL","nested":{"webhook_secret":"SECRET_SENTINEL","kept":"yes"}}')`,[P]);
  });
  url.username=login;url.password=password;api=new pg.Pool({connectionString:url.toString(),max:4,connectionTimeoutMillis:5000});
 },60000);
 afterAll(async()=>{await api?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}vi.unstubAllEnvs();});

 let exportId='',exportSha='';
 it('exports the profile own data as readable gzip NDJSON without secrets and keeps only a receipt',async()=>{
  await expect(exportAs(authority('operator'))).rejects.toMatchObject({code:'PROFILE_ACTION_FORBIDDEN'});
  const result=await exportAs(authority('owner'));exportId=result.id;exportSha=result.sha256;
  expect(createHash('sha256').update(result.gzip).digest('hex')).toBe(result.sha256);
  const lines=gunzipSync(result.gzip).toString('utf8').trim().split('\n').map(l=>JSON.parse(l) as {section:string;row:Record<string,unknown>});
  expect(lines[0]).toMatchObject({section:'export',row:{profile_id:P,environment:'REAL',export_id:result.id}});
  expect(lines.at(-1)).toMatchObject({section:'manifest',row:{rows:lines.length}});
  expect(lines.find(l=>l.section==='profile')?.row).toMatchObject({id:P,business_name:NAME});
  expect(lines.filter(l=>l.section==='records').map(l=>l.row.kind).sort()).toEqual(['contact','product']);
  const text=JSON.stringify(lines);expect(text).toContain('OWN_DATA_SENTINEL');expect(text).not.toContain('SECRET_SENTINEL');expect(text).toContain('"kept":"yes"');
  expect(result.rows).toBe(lines.length);expect(result.sections).toMatchObject({export:1,profile:1,memberships:1,records:2});
  const receipt=(await admin.query('SELECT workspace_id,actor_id,sha256,row_count::int rows,byte_count::int bytes FROM profile_data_exports WHERE id=$1',[result.id])).rows[0];
  expect(receipt).toEqual({workspace_id:P,actor_id:owner,sha256:result.sha256,rows:result.rows,bytes:result.gzip.length});
  await expect(admin.query('UPDATE profile_data_exports SET row_count=0 WHERE id=$1',[result.id])).rejects.toThrow();
 });

 it('keeps receipts profile-scoped and the deletion table closed to the API role',async()=>{
  expect((await api.query('SELECT count(*)::int n FROM profile_data_exports')).rows[0].n).toBe(0);
  await expect(api.query('SELECT * FROM platform_profile_deletions')).rejects.toMatchObject({code:'42501'});
 });

 it('requests deletion only for a suspended profile with its exact name and a recent export, idempotently',async()=>{
  const s=await session(adminUser);
  const state=await platformProfileDeletionState(api,s,P);
  expect(state).toMatchObject({profileId:P,state:'ACTIVE',lastExport:{id:exportId,sha256:exportSha,usable:true},deletion:null});
  expect(JSON.stringify(state)).not.toContain('OWN_DATA_SENTINEL');
  const base={expectedVersion:await version(),confirmation:NAME,exportId,reason:'Baja solicitada por el negocio sintético'};
  await expect(requestPlatformProfileDeletion(api,s,P,{...base,operationId:randomUUID()})).rejects.toMatchObject({code:'PLATFORM_DELETION_REQUIRES_SUSPENDED',statusCode:409});
  await updatePlatformProfile(api,s,P,{operationId:randomUUID(),expectedVersion:await version(),state:'SUSPENDED'});
  const ready={...base,expectedVersion:await version()};
  await expect(requestPlatformProfileDeletion(api,s,P,{...ready,operationId:randomUUID(),confirmation:'Otro negocio'})).rejects.toMatchObject({code:'PLATFORM_DELETION_CONFIRMATION_MISMATCH'});
  await expect(requestPlatformProfileDeletion(api,s,P,{...ready,operationId:randomUUID(),exportId:randomUUID()})).rejects.toMatchObject({code:'PLATFORM_DELETION_EXPORT_REQUIRED'});
  const stale=randomUUID();
  await admin.query("INSERT INTO profile_data_exports(id,workspace_id,actor_id,sha256,row_count,byte_count,created_at) VALUES($1,$2,$3,repeat('b',64),1,1,clock_timestamp()-interval '8 days')",[stale,P,owner]);
  await expect(requestPlatformProfileDeletion(api,s,P,{...ready,operationId:randomUUID(),exportId:stale})).rejects.toMatchObject({code:'PLATFORM_DELETION_EXPORT_REQUIRED'});
  await expect(requestPlatformProfileDeletion(api,await session(plainUser),P,{...ready,operationId:randomUUID()})).rejects.toMatchObject({code:'PLATFORM_ADMIN_REQUIRED'});
  const operationId=randomUUID(),requested=await requestPlatformProfileDeletion(api,s,P,{...ready,operationId});
  expect(requested).toMatchObject({status:'DELETION_REQUESTED',profileId:P,exportSha256:exportSha,erased:false,replayed:false});
  expect(await requestPlatformProfileDeletion(api,s,P,{...ready,operationId})).toEqual({...requested,replayed:true});
  await expect(requestPlatformProfileDeletion(api,s,P,{...ready,operationId:randomUUID()})).rejects.toMatchObject({code:'PROFILE_DELETION_PENDING'});
  // Nothing was erased: the profile, its records and its membership remain.
  expect((await admin.query('SELECT (SELECT count(*)::int FROM records WHERE workspace_id=$1) records,(SELECT count(*)::int FROM memberships WHERE workspace_id=$1) members,(SELECT state FROM profiles WHERE id=$1) state',[P])).rows[0]).toEqual({records:2,members:1,state:'SUSPENDED'});
  await expect(updatePlatformProfile(api,s,P,{operationId:randomUUID(),expectedVersion:await version(),state:'ACTIVE'})).rejects.toMatchObject({code:'PROFILE_DELETION_PENDING',statusCode:409});
  // The owner may still export while the request is pending (export is not a profile change).
  expect((await exportAs(authority('owner','SUSPENDED'))).rows).toBeGreaterThan(3);
  expect((await platformProfileDeletionState(api,s,P)).deletion).toMatchObject({id:requested.deletionId,status:'PENDING_ERASURE',exportId});
 });

 it('cancels a pending request with a reason and then allows reactivation',async()=>{
  const s=await session(adminUser),pending=(await platformProfileDeletionState(api,s,P)).deletion!;
  await expect(cancelPlatformProfileDeletion(api,s,P,{operationId:randomUUID(),deletionId:pending.id,reason:'corto'})).rejects.toThrow();
  const operationId=randomUUID(),cancel={operationId,deletionId:pending.id,reason:'El negocio decidió continuar operando'};
  const cancelled=await cancelPlatformProfileDeletion(api,s,P,cancel);expect(cancelled).toMatchObject({status:'DELETION_CANCELLED',deletionId:pending.id,replayed:false});
  expect(await cancelPlatformProfileDeletion(api,s,P,cancel)).toEqual({...cancelled,replayed:true});
  await expect(cancelPlatformProfileDeletion(api,s,P,{...cancel,operationId:randomUUID()})).rejects.toMatchObject({code:'PLATFORM_DELETION_NOT_PENDING'});
  await updatePlatformProfile(api,s,P,{operationId:randomUUID(),expectedVersion:await version(),state:'ACTIVE'});
  expect((await admin.query('SELECT state FROM profiles WHERE id=$1',[P])).rows[0].state).toBe('ACTIVE');
  expect((await admin.query("SELECT kind,count(*)::int n FROM platform_operations WHERE profile_id=$1 AND kind LIKE '%DELETION' GROUP BY kind ORDER BY kind",[P])).rows).toEqual([{kind:'CANCEL_DELETION',n:1},{kind:'REQUEST_DELETION',n:1}]);
 });
});
