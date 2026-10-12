/** Real restricted login against the reviewed 42-source composition and its
 * generated RLS plan. No native adoption or HTTP mounting is implied. */
import {readFile,readdir} from 'node:fs/promises';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {readProfileCatalog} from '../../packages/db/src/profile-inventory.js';
import {commerceProfileRowPolicy} from '../../packages/db/src/commerce-profile-row-policy.js';
import {planProfileRowIsolation} from '../../packages/db/src/profile-row-isolation-plan.js';
import {listProfileChoicesFromSession,selectProfileFromSession} from '../../packages/db/src/profile-identity-bootstrap.js';
import {withProfileSessionTransaction} from '../../packages/db/src/profile-session-transaction.js';
import {withPersonalProfileTransaction} from '../../packages/db/src/profile-personal-token.js';
import {bindProfileEnvironment} from '../../packages/db/src/profile-environment.js';
import type {InteractiveSession,ProfileFence} from '../../packages/db/src/profile-session.js';

const suffix=randomBytes(6).toString('hex'),login='composed_identity_'+suffix,user='user_'+suffix,outsider='other_'+suffix;
const one='composed_one_'+suffix,two='composed_two_'+suffix,foreign='composed_foreign_'+suffix;
let admin:pg.Pool,runtime:pg.Pool,loginOid:number;
async function session(owner=user,life='1 hour'){
 const id='session_'+randomBytes(8).toString('hex');await admin.query('INSERT INTO session(id,"userId",token,"expiresAt") VALUES($1,$2,$1,clock_timestamp()+$3::interval)',[id,owner,life]);return{id,userId:owner};
}
async function identity<T>(work:(c:pg.PoolClient)=>Promise<T>){const c=await runtime.connect();try{await c.query('BEGIN');const result=await work(c);expect((await c.query('COMMIT')).command).toBe('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function selected(workspace=one){const s=await session();return {s,fence:await identity(c=>selectProfileFromSession(c,s,workspace,0))};}
async function pat(workspace=one,scopes:string[]|null=['products:read','products:write'],life='1 hour'){
 const id=randomUUID(),secret='cos_pat_'+randomBytes(32).toString('base64url');await admin.query(`INSERT INTO personal_access_tokens(id,workspace_id,user_id,name,token_hash,allowed_environments,profile_scopes,expires_at) VALUES($1,$2,$3,'Synthetic',$4,'["SIMULATION"]',$5,clock_timestamp()+$6::interval)`,[id,workspace,user,createHash('sha256').update(secret).digest('hex'),scopes===null?null:JSON.stringify(scopes),life]);return{id,secret};
}
async function readSession(s:InteractiveSession,fence:ProfileFence,environment:'REAL'|'SIMULATION'='REAL'){
 return withProfileSessionTransaction(runtime,s,fence,{scope:'products:read',mutation:false},async(db,profile)=>{await bindProfileEnvironment(db,environment);return{profile:profile.profile.id,rows:(await db.query('SELECT workspace_id,environment FROM records ORDER BY environment')).rows};});
}
async function readPat(secret:string,environment:'REAL'|'SIMULATION'='SIMULATION'){
 return withPersonalProfileTransaction(runtime,secret,environment,{scope:'products:read',mutation:false},async(db,p)=>{await bindProfileEnvironment(db,environment);return{profile:p.profile.id,role:p.membership.role,rows:(await db.query('SELECT workspace_id,environment FROM records')).rows};});
}
describe('identity bootstrap and session/PAT authority under composed global RLS',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');admin=new pg.Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:5000});
  expect((await admin.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n).toBe(68);
  const dir=new URL('../../packages/db/profile-transition/',import.meta.url),files=(await readdir(dir)).filter(p=>/^0(?:0[1-9]|1[0-9])_.*\.sql$/.test(p)).sort();expect(files).toHaveLength(19);
  files.push('components/020_profile_identity_bootstrap.sql','components/020_derived_child_scopes.sql','components/020_ownership_scopes.sql','components/020_privileged_read_scopes.sql','components/020_meta_inventory_scopes.sql','components/020_idempotency_scopes.sql','components/020_manual_control_scopes.sql','components/020_global_quota_authority.sql','components/020_global_creative_budget_reader.sql','components/020_retired_creative_custody.sql','021_number_laboratory.sql','components/021_number_lab_ai_bridge.sql','components/021_number_lab_driver_control.sql','022_result_projections.sql','components/022_result_source_reader.sql','023_receipt_policies.sql','components/023_receipt_worker.sql','024_result_financial_context.sql','025_privacy_closure_proof.sql','026_result_rebuild_receipts.sql','027_result_latency_histograms.sql','029_commercial_resolution_receipts.sql','030_privacy_writer_fences.sql');expect(files).toHaveLength(42);
  const c=await admin.connect();try{await c.query('BEGIN');for(const name of files){if(name==='components/020_idempotency_scopes.sql')await c.query('CREATE TEMP TABLE profile_idempotency_scope_adoptions(workspace_id text,actor_id text,operation text,key text,row_sha256 text,environment text,evidence_sha256 text) ON COMMIT DROP');await c.query(await readFile(new URL(name,dir),'utf8'));}await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  const catalog=await readProfileCatalog(admin,['commerce_api','commerce_ingress','commerce_automation','commerce_channel','commerce_maintenance','commerce_ai','commerce_mail_dispatch','commerce_number_lab','commerce_results']);const plan=planProfileRowIsolation(catalog,commerceProfileRowPolicy(catalog));await admin.query('BEGIN;'+plan.sql+'COMMIT;');
  await admin.query("INSERT INTO profile_quota_policy(singleton,max_profiles,max_numbers,daily_conversations,calendar_timezone,adoption_sha256) VALUES(true,3,20,300,'UTC',repeat('a',64))");
  await admin.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$1||\'@example.test\'),($2,$2,$2||\'@example.test\')',[user,outsider]);
  for(const p of [one,two,foreign]){await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic profile','UTC',0,0,0)",[p]);for(const e of ['REAL','SIMULATION'])await admin.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,$2,'asset','{\"name\":\"Synthetic\"}')",[p,e]);}
  await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'operator'),($1,$3,'operator'),($4,$5,'owner')",[user,one,two,outsider,foreign]);
  const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT commerce_api TO "${login}"`);loginOid=(await admin.query('SELECT oid FROM pg_roles WHERE rolname=$1',[login])).rows[0].oid;
  url.username=login;url.password=secret;runtime=new pg.Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:5000});
 },60000);
 afterAll(async()=>{await runtime?.end();if(admin){try{if(loginOid){expect((await admin.query('SELECT oid FROM pg_roles WHERE rolname=$1',[login])).rows[0]?.oid).toBe(loginOid);await admin.query(`DROP ROLE "${login}"`);}}finally{await admin.end();}}});
 it('starts without a profile and cannot directly enumerate scoped identity or commercial rows',async()=>{
  expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
  for(const table of ['profiles','memberships','profile_session_context','personal_access_tokens','records'])expect((await runtime.query('SELECT * FROM '+table)).rows).toEqual([]);
  await expect(runtime.query('SET ROLE commerce_profile_bootstrap_owner')).rejects.toMatchObject({code:'42501'});await expect(runtime.query('SELECT * FROM profile_personal_token_routes')).rejects.toMatchObject({code:'42501'});
 });
 it('lists only memberships of the authenticated native session before selection',async()=>{
  const s=await session(),choices=await listProfileChoicesFromSession(runtime,s);expect(choices.map(p=>p.id).sort()).toEqual([one,two].sort());expect(choices.every(p=>!p.selected&&p.selection_version===null)).toBe(true);
  await expect(listProfileChoicesFromSession(runtime,{...s,userId:outsider})).rejects.toThrow('PROFILE_SESSION_EXPIRED');await expect(listProfileChoicesFromSession(runtime,await session(user,'-1 second'))).rejects.toThrow('PROFILE_SESSION_EXPIRED');
 });
 it('selects exact CAS independently per session and never falls back to first membership',async()=>{
  const a=await selected(one),b=await selected(two);expect((await listProfileChoicesFromSession(runtime,a.s)).find(p=>p.selected)?.id).toBe(one);expect((await listProfileChoicesFromSession(runtime,b.s)).find(p=>p.selected)?.id).toBe(two);
  await expect(identity(c=>selectProfileFromSession(c,a.s,two,0))).rejects.toThrow('PROFILE_SELECTION_CHANGED');await expect(identity(c=>selectProfileFromSession(c,a.s,foreign,1))).rejects.toThrow('PROFILE_MEMBERSHIP_REQUIRED');
  await expect(readSession(await session(),{workspaceId:one,version:1})).rejects.toThrow('PROFILE_SELECTION_REQUIRED');
 });
 it('carries a selected session into both explicit environment scopes without data leakage',async()=>{
  const a=await selected(one);for(const e of ['REAL','SIMULATION'] as const)expect(await readSession(a.s,a.fence,e)).toEqual({profile:one,rows:[{workspace_id:one,environment:e}]});
  await expect(readSession(a.s,{workspaceId:two,version:a.fence.version})).rejects.toThrow('PROFILE_SELECTION_REQUIRED');
 });
 it('rejects stale session authority after a membership version change',async()=>{
  const a=await selected();await admin.query("UPDATE memberships SET role='viewer' WHERE user_id=$1 AND workspace_id=$2",[user,one]);try{await expect(readSession(a.s,a.fence)).rejects.toThrow('PROFILE_SESSION_ACCESS_CHANGED');}finally{await admin.query("UPDATE memberships SET role='operator' WHERE user_id=$1 AND workspace_id=$2",[user,one]);}
 });
 it('preserves suspended profile metadata while denying mutation before its callback',async()=>{
  const scoped=await admin.connect();try{await scoped.query("SELECT set_config('app.workspace_id',$1,false)",[one]);await scoped.query("UPDATE profiles SET state='SUSPENDED',version=version+1 WHERE id=$1",[one]);try{const a=await selected();expect((await listProfileChoicesFromSession(runtime,a.s)).find(p=>p.id===one)?.state).toBe('SUSPENDED');let called=false;await expect(withProfileSessionTransaction(runtime,a.s,a.fence,{scope:'products:write',mutation:true},async()=>{called=true;})).rejects.toThrow('PROFILE_SUSPENDED');expect(called).toBe(false);}finally{await scoped.query("UPDATE profiles SET state='ACTIVE',version=version+1 WHERE id=$1",[one]);}}finally{await scoped.query("RESET app.workspace_id");scoped.release();}
 });
 it('routes a PAT to its fixed profile without any session selection or implicit Owner role',async()=>{
  const a=await pat(),b=await pat(two);expect(await readPat(a.secret)).toEqual({profile:one,role:'operator',rows:[{workspace_id:one,environment:'SIMULATION'}]});expect((await readPat(b.secret)).profile).toBe(two);
 });
 it('denies PAT environment, missing adopted scopes and unauthorized actions without fallback',async()=>{
  const a=await pat(),legacy=await pat(one,null);await expect(readPat(a.secret,'REAL')).rejects.toThrow('PROFILE_TOKEN_ENVIRONMENT_DENIED');await expect(readPat(legacy.secret)).rejects.toThrow('PROFILE_TOKEN_SCOPE_ADOPTION_REQUIRED');
  await expect(withPersonalProfileTransaction(runtime,a.secret,'SIMULATION',{scope:'employees:write',mutation:true},async()=>true)).rejects.toThrow('PROFILE_ACTION_FORBIDDEN');
 });
 it('rejects profile and environment crossed inserts even after authenticated PAT entry',async()=>{
  const a=await pat();for(const [p,e]of [[two,'SIMULATION'],[one,'REAL']])await expect(withPersonalProfileTransaction(runtime,a.secret,'SIMULATION',{scope:'products:write',mutation:true},async db=>{await bindProfileEnvironment(db,'SIMULATION');await db.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,$2,'asset','{\"name\":\"Crossed\"}')",[p,e]);})).rejects.toMatchObject({code:'42501'});
  expect((await admin.query('SELECT count(*)::int n FROM records')).rows[0].n).toBe(6);
 });
 it('applies membership revocation to the next PAT transaction without widening its scopes',async()=>{
  const a=await pat();await admin.query('UPDATE memberships SET active=false WHERE user_id=$1 AND workspace_id=$2',[user,one]);try{await expect(readPat(a.secret)).rejects.toThrow('PROFILE_TOKEN_MEMBERSHIP_REQUIRED');}finally{await admin.query('UPDATE memberships SET active=true WHERE user_id=$1 AND workspace_id=$2',[user,one]);}
 });
 it('rolls back scoped writes if token expiry is crossed during work',async()=>{
  const a=await pat(one,undefined,'1 second');await expect(withPersonalProfileTransaction(runtime,a.secret,'SIMULATION',{scope:'products:write',mutation:true},async db=>{await bindProfileEnvironment(db,'SIMULATION');await db.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'SIMULATION','asset','{\"name\":\"Expired\"}')",[one]);await db.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.02) FROM personal_access_tokens WHERE id=$1',[a.id]);})).rejects.toThrow('PROFILE_PERSONAL_TOKEN_INVALID');expect((await admin.query('SELECT count(*)::int n FROM records')).rows[0].n).toBe(6);
 });
 it('leaves no profile or environment selection in pooled connections after successful and failed calls',async()=>{
  const a=await selected();await readSession(a.s,a.fence);await expect(readPat('cos_pat_'+randomBytes(32).toString('base64url'))).rejects.toThrow('PROFILE_PERSONAL_TOKEN_INVALID');
  const connections=await Promise.all(Array.from({length:5},()=>runtime.connect()));try{for(const c of connections){expect((await c.query("SELECT NULLIF(current_setting('app.workspace_id',true),'') w,NULLIF(current_setting('app.environment',true),'') e")).rows[0]).toEqual({w:null,e:null});expect((await c.query('SELECT id FROM records')).rows).toEqual([]);}}finally{connections.forEach(c=>c.release());}
 });
});
