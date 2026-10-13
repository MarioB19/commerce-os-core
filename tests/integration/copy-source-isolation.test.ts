import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {fixtureProfilesIn} from '../support/profile-fixture.js';
import {fixtureProfiles} from '../support/profile-fixture.js';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import type {FastifyInstance} from 'fastify';

const originalDatabaseUrl=process.env.DATABASE_URL!,control=new pg.Pool({connectionString:originalDatabaseUrl});
const database='source_isolation_'+randomUUID().replaceAll('-',''),ownerUrl=new URL(originalDatabaseUrl);ownerUrl.pathname='/'+database;
const apiUrl=new URL(ownerUrl);apiUrl.searchParams.set('options','-c role=commerce_api');
const root=fileURLToPath(new URL('../../',import.meta.url)),execute=promisify(execFile);
const workspace='source-isolation-'+randomUUID(),user=randomUUID();
// V7 F2: fixture workspaces are adopted profiles (max three per installation).
beforeAll(()=>fixtureProfiles(workspace));
let app:FastifyInstance,admin:pg.Pool,pool:pg.Pool,token:string,created=false;
let putRecord:typeof import('../../packages/db/src/index.js').putRecord;
beforeAll(async()=>{
 await control.query(`CREATE DATABASE "${database}" TEMPLATE template0`);created=true;
 await execute(process.execPath,['--import','tsx',fileURLToPath(new URL('../../packages/db/src/migrate.ts',import.meta.url))],{cwd:root,env:{...process.env,DATABASE_URL:ownerUrl.toString()},timeout:30000});
 admin=new pg.Pool({connectionString:ownerUrl.toString()});process.env.DATABASE_URL=apiUrl.toString();vi.resetModules();
 const db=await import('../../packages/db/src/index.js');pool=db.pool;putRecord=db.putRecord;
 expect((await pool.query('SELECT current_user role')).rows[0].role).toBe('commerce_api');
 await admin.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[user,'Synthetic isolation owner',user+'@example.invalid']);
 await fixtureProfilesIn(admin,workspace);// V7 F2: memberships belong to an adopted profile.
 await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[user,workspace]);
 const pat=await import('../../packages/db/src/personal-access-tokens.js');token=pat.newPersonalToken();
 await pat.insertPersonalToken(admin,{workspace_id:workspace,user_id:user,name:'Synthetic declaration tests',allowed_environments:['REAL','SIMULATION'],expires_at:new Date(Date.now()+3600000).toISOString()},token);
 app=await(await import('../../apps/api/src/app.js')).createApp();
});
afterAll(async()=>{try{await app?.close();}finally{try{await pool?.end();await admin?.end();}finally{process.env.DATABASE_URL=originalDatabaseUrl;try{if(created)await control.query(`DROP DATABASE "${database}"`);}finally{await control.end();}}}});
async function fixture(expired=false){
 const a=await putRecord(admin,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Synthetic isolation line',provider:'waha',gateway_ref:'source-'+randomUUID(),status:'UNKNOWN',sending_enabled:false}});
 const s=(await admin.query("UPDATE channel_sessions SET primary_device_id='synthetic-primary',responsible_user_id=$2 WHERE account_id=$1 RETURNING *",[a.id,user])).rows[0];
 await admin.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,frozen,lease_expires_at) VALUES($1,$2,'synthetic-old-owner',3,true,now()-interval '1 hour')",[a.id,workspace]);
 const c=(await admin.query(`INSERT INTO copy_source_isolation_challenges(workspace_id,environment,account_id,account_version,session_revision,previous_owner_id,generation,credential_generation,primary_device_id,responsible_user_id,source_project,billing_enabled,technical_evidence_sha256,technical_observed_at,issued_at,expires_at)
 VALUES($1,'REAL',$2,$3,$4,'synthetic-old-owner',3,$5,$6,$7,'vibe-conversa-prod',false,$8,now()-interval '2 hours',now()-$9::interval,now()+$10::interval) RETURNING *`,[workspace,a.id,a.version,s.revision,s.credential_generation,s.primary_device_id,user,'a'.repeat(64),expired?'1 hour':'1 second',expired?'-1 minute':'1 hour'])).rows[0];
 const body={challenge_id:c.id,expected_account_version:a.version,expected_session_version:s.revision,previous_commerce_devices_revoked:true as const,confirmation:'REVOKED_PREVIOUS_COMMERCE_DEVICES_AFTER_CHALLENGE' as const,reason:'Synthetic human declaration after a synthetic Root challenge'};
 return{a,s,c,body};
}
const call=(f:Awaited<ReturnType<typeof fixture>>,body:Record<string,unknown>=f.body,key=randomUUID(),environment='REAL')=>app.inject({method:'POST',url:`/v1/channel-accounts/${f.a.id}/source-isolation/confirm?environment=${environment}`,payload:body,headers:{authorization:'Bearer '+token,'idempotency-key':key}});
async function apiInProfile<T>(work:(c:any)=>Promise<T>){const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[workspace]);return await work(c);}finally{await c.query('ROLLBACK');c.release();}}
async function receiptRead(f:Awaited<ReturnType<typeof fixture>>,id:string|null=null){const c=await admin.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE commerce_channel');const r=await c.query('SELECT id FROM public.read_copy_source_isolation_receipt($1,$2,$3,3,$4)',[f.a.id,workspace,'synthetic-old-owner',id]);await c.query('ROLLBACK');return r.rows;}finally{c.release();}}
describe('Root technical observation and human declaration remain separate',()=>{
 it('records a personal-owner report once without minting isolation or modifying the session',async()=>{
  const f=await fixture(),key=randomUUID(),result=await call(f,f.body,key);
  expect(result.statusCode,result.body).toBe(200);expect(result.json().data).toMatchObject({status:'PRIMARY_REVOCATION_DECLARED',source:'personal_owner_report',root_verification:'PENDING',authorizes_operations:false});
  expect((await call(f,f.body,key)).json()).toEqual(result.json());expect((await call(f,{...f.body,reason:'Different request'},key)).statusCode).toBe(409);
  expect((await admin.query('SELECT * FROM channel_sessions WHERE account_id=$1',[f.a.id])).rows[0]).toEqual(f.s);
  expect((await admin.query('SELECT count(*)::int n FROM ownership_isolation_receipts WHERE account_id=$1',[f.a.id])).rows[0].n).toBe(0);expect(await receiptRead(f)).toEqual([]);
  expect((await admin.query("SELECT count(*)::int n FROM domain_events WHERE aggregate_id=$1 AND event_type='channel.source_isolation.primary_reported'",[f.a.id])).rows[0].n).toBe(1);
 });
 it('rejects partial SQL declarations and keeps Root fields inaccessible to the API',async()=>{
  const f=await fixture();
  // V7 F2: the API writes only inside its profile context (forced RLS).
  await expect(apiInProfile(c=>c.query('UPDATE copy_source_isolation_challenges SET primary_revocation_reported_at=clock_timestamp() WHERE id=$1',[f.c.id]))).rejects.toMatchObject({code:'23514'});
  await expect(pool.query("UPDATE copy_source_isolation_challenges SET billing_enabled=true WHERE id=$1",[f.c.id])).rejects.toMatchObject({code:'42501'});
  await expect(pool.query('UPDATE copy_source_isolation_challenges SET completed_receipt_id=$2 WHERE id=$1',[f.c.id,randomUUID()])).rejects.toMatchObject({code:'42501'});
  await expect(pool.query('INSERT INTO ownership_isolation_receipts(account_id,workspace_id,previous_owner_id,generation,method,evidence_sha256,verified_at) VALUES($1,$2,$3,3,$4,$5,now())',[f.a.id,workspace,'synthetic-old-owner','source_billing_disabled_and_primary_device_revoked','b'.repeat(64)])).rejects.toMatchObject({code:'42501'});
 });
 it('rejects expiry, changed ownership, pending commands, SIM and unconfirmed devices without reports',async()=>{
  const expired=await fixture(true);expect((await call(expired)).statusCode).toBe(409);
  const changed=await fixture();await admin.query('UPDATE session_ownership SET generation=4 WHERE account_id=$1',[changed.a.id]);expect((await call(changed)).statusCode).toBe(409);
  const pending=await fixture();await admin.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key) VALUES($1,'REAL','channel_command',$2,$3,'{\"type\":\"logout\"}',$4)",[workspace,pending.a.id,user,randomUUID()]);expect((await call(pending)).statusCode).toBe(409);
  const plain=await fixture();expect((await call(plain,{...plain.body,previous_commerce_devices_revoked:false})).statusCode).toBe(400);expect((await call(plain,plain.body,undefined,'SIMULATION')).statusCode).toBe(400);
  for(const f of [expired,changed,pending,plain])expect((await admin.query('SELECT primary_revocation_reported_at FROM copy_source_isolation_challenges WHERE id=$1',[f.c.id])).rows[0].primary_revocation_reported_at).toBeNull();
 });
 it('rejects an expired receipt when a transaction began before its expiry',async()=>{
  const f=await fixture();expect((await call(f)).statusCode).toBe(200);
  const r=(await admin.query('INSERT INTO ownership_isolation_receipts(account_id,workspace_id,previous_owner_id,generation,method,evidence_sha256,verified_at) VALUES($1,$2,$3,3,$4,$5,clock_timestamp()) RETURNING id',[f.a.id,workspace,'synthetic-old-owner','source_billing_disabled_and_primary_device_revoked','d'.repeat(64)])).rows[0];
  // A fresh short-lived Root challenge is installed before completing the proof.
  await admin.query('DELETE FROM copy_source_isolation_challenges WHERE id=$1',[f.c.id]);
  const short=(await admin.query(`INSERT INTO copy_source_isolation_challenges(workspace_id,environment,account_id,account_version,session_revision,previous_owner_id,generation,credential_generation,primary_device_id,responsible_user_id,source_project,billing_enabled,technical_evidence_sha256,technical_observed_at,issued_at,expires_at,primary_revocation_reported_at,primary_revocation_reported_by,primary_report_source,completed_receipt_id)
   VALUES($1,'REAL',$2,$3,$4,'synthetic-old-owner',3,$5,$6,$7,'vibe-conversa-prod',false,$8,clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 second',clock_timestamp()+interval '2 seconds',clock_timestamp()-interval '500 milliseconds',$7,'owner_confirmation',$9) RETURNING id`,[workspace,f.a.id,f.a.version,f.s.revision,f.s.credential_generation,f.s.primary_device_id,user,'a'.repeat(64),r.id])).rows[0];
  const client=await admin.connect();try{await client.query('BEGIN');await client.query('SET LOCAL ROLE commerce_channel');
   expect((await client.query('SELECT id FROM public.read_copy_source_isolation_receipt($1,$2,$3,3,$4)',[f.a.id,workspace,'synthetic-old-owner',r.id])).rows).toEqual([{id:r.id}]);
   await client.query('SELECT pg_sleep(2.1)');
   expect((await client.query('SELECT id FROM public.read_copy_source_isolation_receipt($1,$2,$3,3,$4)',[f.a.id,workspace,'synthetic-old-owner',r.id])).rows).toEqual([]);
   await client.query('ROLLBACK');
  }finally{client.release();}
  expect((await admin.query('SELECT expires_at<clock_timestamp() expired FROM copy_source_isolation_challenges WHERE id=$1',[short.id])).rows[0].expired).toBe(true);
 });
 it('rejects a completed challenge linked to another account even with the same old owner and generation',async()=>{
  const target=await fixture(),other=await fixture();expect((await call(other)).statusCode).toBe(200);
  const r=(await admin.query('INSERT INTO ownership_isolation_receipts(account_id,workspace_id,previous_owner_id,generation,method,evidence_sha256,verified_at) VALUES($1,$2,$3,3,$4,$5,clock_timestamp()) RETURNING id',[target.a.id,workspace,'synthetic-old-owner','source_billing_disabled_and_primary_device_revoked','e'.repeat(64)])).rows[0];
  // Root-only malformed fixture: another account's declaration must never prove target isolation.
  await admin.query('UPDATE copy_source_isolation_challenges SET completed_receipt_id=$2 WHERE id=$1',[other.c.id,r.id]);
  expect(await receiptRead(target,r.id)).toEqual([]);
 });
 it('rejects a receipt whose workspace differs from the bound account and challenge',async()=>{
  const f=await fixture();expect((await call(f)).statusCode).toBe(200);const foreign='synthetic-foreign-'+randomUUID();
  // V7 F2: the ownership scope (020) refuses a receipt outside its account's
  // profile in the database itself, so no such receipt can be read.
  await expect(admin.query('INSERT INTO ownership_isolation_receipts(account_id,workspace_id,previous_owner_id,generation,method,evidence_sha256,verified_at) VALUES($1,$2,$3,3,$4,$5,clock_timestamp()) RETURNING id',[f.a.id,foreign,'synthetic-old-owner','source_billing_disabled_and_primary_device_revoked','f'.repeat(64)])).rejects.toThrow(/PROFILE_OWNERSHIP_/);
  expect(await receiptRead(f)).toEqual([]);
 });
 it('rechecks expiry after actually waiting for the receipt row lock',async()=>{
  const f=await fixture();expect((await call(f)).statusCode).toBe(200);
  const r=(await admin.query('INSERT INTO ownership_isolation_receipts(account_id,workspace_id,previous_owner_id,generation,method,evidence_sha256,verified_at) VALUES($1,$2,$3,3,$4,$5,clock_timestamp()) RETURNING id',[f.a.id,workspace,'synthetic-old-owner','source_billing_disabled_and_primary_device_revoked','1'.repeat(64)])).rows[0];
  await admin.query('DELETE FROM copy_source_isolation_challenges WHERE id=$1',[f.c.id]);
  const short=(await admin.query(`INSERT INTO copy_source_isolation_challenges(workspace_id,environment,account_id,account_version,session_revision,previous_owner_id,generation,credential_generation,primary_device_id,responsible_user_id,source_project,billing_enabled,technical_evidence_sha256,technical_observed_at,issued_at,expires_at,primary_revocation_reported_at,primary_revocation_reported_by,primary_report_source,completed_receipt_id)
   VALUES($1,'REAL',$2,$3,$4,'synthetic-old-owner',3,$5,$6,$7,'vibe-conversa-prod',false,$8,clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 second',clock_timestamp()+interval '2 seconds',clock_timestamp()-interval '500 milliseconds',$7,'owner_confirmation',$9) RETURNING id`,[workspace,f.a.id,f.a.version,f.s.revision,f.s.credential_generation,f.s.primary_device_id,user,'a'.repeat(64),r.id])).rows[0];
  const locker=await admin.connect(),reader=await admin.connect();let pending:Promise<pg.QueryResult>|undefined;
  try{
   await locker.query('BEGIN');await locker.query('SELECT id FROM ownership_isolation_receipts WHERE id=$1 FOR UPDATE',[r.id]);
   const lockerPid=(await locker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   await reader.query('BEGIN');await reader.query('SET LOCAL ROLE commerce_channel');const readerPid=(await reader.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   pending=reader.query('SELECT id FROM public.read_copy_source_isolation_receipt($1,$2,$3,3,$4)',[f.a.id,workspace,'synthetic-old-owner',r.id]);
   const deadline=performance.now()+5000;let observed=false;
   while(performance.now()<deadline){
    const blockers=(await admin.query('SELECT pg_blocking_pids($1) blockers',[readerPid])).rows[0].blockers;
    if(blockers.includes(lockerPid)){observed=true;break;}
    await admin.query('SELECT pg_sleep(0.01)');
   }
   expect(observed,'actual receipt row-lock blocker').toBe(true);
   await admin.query('SELECT pg_sleep(2.1)');
   expect((await admin.query('SELECT expires_at<clock_timestamp() expired FROM copy_source_isolation_challenges WHERE id=$1',[short.id])).rows[0].expired).toBe(true);
   await locker.query('COMMIT');expect((await pending).rows).toEqual([]);pending=undefined;
   await reader.query('ROLLBACK');
  }finally{await locker.query('ROLLBACK').catch(()=>{});await pending?.catch(()=>{});await reader.query('ROLLBACK').catch(()=>{});locker.release();reader.release();}
 });
 it('accepts only a completed Root receipt for the same credential and primary tuple',async()=>{
  const f=await fixture();expect((await call(f)).statusCode).toBe(200);
  const r=(await admin.query('INSERT INTO ownership_isolation_receipts(account_id,workspace_id,previous_owner_id,generation,method,evidence_sha256,verified_at) VALUES($1,$2,$3,3,$4,$5,clock_timestamp()) RETURNING id',[f.a.id,workspace,'synthetic-old-owner','source_billing_disabled_and_primary_device_revoked','c'.repeat(64)])).rows[0];
  expect(await receiptRead(f,r.id)).toEqual([]);
  await admin.query('UPDATE copy_source_isolation_challenges SET completed_receipt_id=$2 WHERE id=$1',[f.c.id,r.id]);expect(await receiptRead(f,r.id)).toEqual([{id:r.id}]);
  await admin.query('UPDATE channel_sessions SET credential_generation=credential_generation+1 WHERE account_id=$1',[f.a.id]);expect(await receiptRead(f,r.id)).toEqual([]);
  const client=await admin.connect();try{await client.query('BEGIN');await client.query('SET LOCAL ROLE commerce_channel');await expect(client.query('SELECT * FROM copy_source_isolation_challenges')).rejects.toMatchObject({code:'42501'});await client.query('ROLLBACK');}finally{client.release();}
 });
});
