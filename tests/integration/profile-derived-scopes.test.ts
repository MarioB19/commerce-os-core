import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
const tag=randomBytes(6).toString('hex'),login='derived_'+tag,one='derived_one_'+tag,two='derived_two_'+tag;
const children=['effect_attempts','consumer_receipts','retention_plans','retention_files','warmup_rate_buckets','warmup_rate_reservations','warmup_schedule_runs','creative_attempts','creative_steps','creative_reviews','creative_voice_brief_versions','creative_batch_versions','commercial_assignment_history','warmup_simulated_events','warmup_manual_declarations','warmup_account_reservations','warmup_group_receipts','outbox_gate_schedule'];
let admin:pg.Pool,runtime:pg.Pool,component:string,assignment:string,binding:string;
const effects:Record<string,string>={},events:Record<string,string>={};let original:unknown,guards:unknown;
async function scope<T>(workspace:string,environment:string,work:(db:pg.PoolClient)=>Promise<T>){const c=await runtime.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE commerce_channel');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment',$2,true)",[workspace,environment]);const value=await work(c);expect((await c.query('COMMIT')).command).toBe('COMMIT');return value;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function cleanColumns(){return(await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1) AND column_name=ANY($2) ORDER BY 1,2",[children,['workspace_id','environment']])).rows;}
async function history(){return(await admin.query("SELECT to_jsonb(h)-ARRAY['workspace_id','environment'] original FROM commercial_assignment_history h ORDER BY assignment_id,revision")).rows;}
async function triggers(){return(await admin.query("SELECT c.relname,t.tgname,t.tgenabled,encode(sha256(convert_to(pg_get_triggerdef(t.oid,true),'UTF8')),'hex') sha256 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname=ANY($1) ORDER BY 1,2",[['immutable_assignment_history','creative_batch_version_immutable','creative_review_immutable','creative_voice_brief_version_immutable','immutable_manual_declarations']])).rows;}
describe('derived child scopes preserve history and close native tenant boundaries',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:4,connectionTimeoutMillis:5000});if((await admin.query("SELECT to_regclass('public.profiles') present")).rows[0].present)throw Error('TRANSITION_SCHEMA_ALREADY_PRESENT');
  await admin.query(await readFile(new URL('../../packages/db/profile-transition/001_profile_identity.sql',import.meta.url),'utf8'));
  component=await readFile(new URL('../../packages/db/profile-transition/components/020_derived_child_scopes.sql',import.meta.url),'utf8');
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic One','UTC',0,0,0),($2,'Synthetic Two','UTC',0,0,0)",[one,two]);
  for(const [key,workspace,environment]of [['one',one,'REAL'],['two',two,'REAL'],['simulation',one,'SIMULATION']]){
   const event=randomUUID(),effect=randomUUID();events[key!]=event;effects[key!]=effect;
   await admin.query("INSERT INTO domain_events(id,workspace_id,environment,event_type,aggregate_id,correlation_id) VALUES($1,$2,$3,'synthetic_child_scope','synthetic','synthetic')",[event,workspace,environment]);
   await admin.query("INSERT INTO consumer_receipts(consumer,event_id) VALUES('synthetic_scope',$1)",[event]);
   await admin.query("INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,config_hash) VALUES($1,$2,$3,'synthetic','synthetic','synthetic',$1::uuid::text,'{}','synthetic')",[effect,workspace,environment]);
   await admin.query("INSERT INTO effect_attempts(effect_id,claim_id,status) VALUES($1,'synthetic_old','NOT_SENT')",[effect]);
  }
  const ids=[randomUUID(),randomUUID(),randomUUID()];binding=ids[2]!;assignment=randomUUID();
  for(const id of ids)await admin.query("INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,'REAL','synthetic_scope','{}')",[id,one]);
  await admin.query("INSERT INTO commercial_assignments(id,workspace_id,environment,account_id,product_id,binding_id) VALUES($1,$2,'REAL',$3,$4,$5)",[assignment,one,...ids]);
  await admin.query("INSERT INTO commercial_assignment_history(assignment_id,revision,binding_id,state,actor_id,reason) VALUES($1,1,$2,'ACTIVE','synthetic','preserve original bytes')",[assignment,binding]);
  original=await history();guards=await triggers();
  const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT commerce_channel TO "${login}"`);
  url.username=login;url.password=secret;runtime=new pg.Pool({connectionString:url.toString(),max:2,connectionTimeoutMillis:5000});
 },60000);
 afterAll(async()=>{await runtime?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}});
 it('does not permit a restricted runtime to apply the data transition',async()=>{
  expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
  await expect(runtime.query(component)).rejects.toThrow('PROFILE_MIGRATION_OWNER_REQUIRED');expect(await cleanColumns()).toEqual([]);
 });
 it('rejects an orphan child atomically without adding columns or dropping history guards',async()=>{
  const missing=randomUUID();await admin.query("INSERT INTO consumer_receipts(consumer,event_id) VALUES('orphan',$1)",[missing]);
  try{await expect(admin.query(component)).rejects.toThrow('PROFILE_CHILD_PARENT_ADOPTION_REQUIRED');expect(await cleanColumns()).toEqual([]);expect(await triggers()).toEqual(guards);expect(await history()).toEqual(original);}
  finally{await admin.query("DELETE FROM consumer_receipts WHERE consumer='orphan' AND event_id=$1",[missing]);}
 });
 it('rejects a parent without an adopted profile rather than assigning it a default',async()=>{
  const id=randomUUID();await admin.query("INSERT INTO domain_events(id,workspace_id,environment,event_type,aggregate_id,correlation_id) VALUES($1,'unadopted_synthetic','REAL','synthetic','synthetic','synthetic')",[id]);await admin.query("INSERT INTO consumer_receipts(consumer,event_id) VALUES('unadopted',$1)",[id]);
  try{await expect(admin.query(component)).rejects.toThrow('PROFILE_CHILD_PARENT_ADOPTION_REQUIRED');expect(await cleanColumns()).toEqual([]);}
  finally{await admin.query("DELETE FROM consumer_receipts WHERE consumer='unadopted' AND event_id=$1",[id]);}
 });
 it('rejects drift in an immutable trigger and preserves the original rows',async()=>{
  await admin.query('ALTER TRIGGER immutable_assignment_history ON commercial_assignment_history RENAME TO synthetic_trigger_drift');
  try{await expect(admin.query(component)).rejects.toThrow('PROFILE_CHILD_HISTORY_GUARD_CHANGED');expect(await cleanColumns()).toEqual([]);expect(await history()).toEqual(original);}
  finally{await admin.query('ALTER TRIGGER synthetic_trigger_drift ON commercial_assignment_history RENAME TO immutable_assignment_history');}
 });
 it('backfills all eighteen tables with native parent scope and exact historical values',async()=>{
  await admin.query(component);expect(await cleanColumns()).toHaveLength(36);expect(await triggers()).toEqual(guards);expect(await history()).toEqual(original);
  const rows=(await admin.query('SELECT effect_id,workspace_id,environment FROM effect_attempts ORDER BY effect_id')).rows;
  expect(rows).toEqual(Object.entries(effects).map(([key,effect_id])=>({effect_id,workspace_id:key==='two'?two:one,environment:key==='simulation'?'SIMULATION':'REAL'})).sort((a,b)=>a.effect_id.localeCompare(b.effect_id)));
  const row=(await admin.query('SELECT workspace_id,environment FROM commercial_assignment_history WHERE assignment_id=$1',[assignment])).rows[0];expect(row).toEqual({workspace_id:one,environment:'REAL'});
  expect(createHash('sha256').update(JSON.stringify(await history())).digest('hex')).toBe(createHash('sha256').update(JSON.stringify(original)).digest('hex'));
 });
 it('forces RLS and a restrictive scope policy on all eighteen children',async()=>{
  const rows=(await admin.query('SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1)',[children])).rows;expect(rows).toHaveLength(18);expect(rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity)).toBe(true);
  expect((await admin.query("SELECT count(*)::int n FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relname=ANY($1) AND NOT p.polpermissive",[children])).rows[0].n).toBe(18);
  expect((await admin.query("SELECT count(*)::int n FROM pg_constraint WHERE conrelid=ANY(SELECT oid FROM pg_class WHERE relname=ANY($1)) AND conname='profile_child_parent' AND contype='f' AND convalidated",[children])).rows[0].n).toBe(18);
 });
 it('returns no child data without a bound profile and environment',async()=>{
  expect((await runtime.query('SELECT * FROM effect_attempts')).rows).toEqual([]);expect((await runtime.query('SELECT * FROM consumer_receipts')).rows).toEqual([]);
 });
 it('isolates both profile and REAL versus SIMULATION for native reads',async()=>{
  for(const [workspace,environment,key]of [[one,'REAL','one'],[one,'SIMULATION','simulation'],[two,'REAL','two']]){
   const rows=await scope(workspace!,environment!,async c=>(await c.query('SELECT effect_id FROM effect_attempts')).rows);expect(rows).toEqual([{effect_id:effects[key!]}]);
  }
 });
 it('derives new child scope from the exact parent without trusting supplied fields',async()=>{
  const row=await scope(one,'REAL',async c=>(await c.query("INSERT INTO effect_attempts(effect_id,claim_id,status) VALUES($1,'synthetic_new','NOT_SENT') RETURNING workspace_id,environment",[effects.one])).rows[0]);expect(row).toEqual({workspace_id:one,environment:'REAL'});
 });
 it('rejects a foreign parent even when its UUID is known',async()=>{
  await expect(scope(one,'REAL',c=>c.query("INSERT INTO effect_attempts(effect_id,claim_id,status) VALUES($1,'foreign','NOT_SENT')",[effects.two]))).rejects.toThrow('PROFILE_CHILD_CONTEXT_REQUIRED');
 });
 it('rejects explicitly spoofed scope and a mismatched environment',async()=>{
  await expect(scope(one,'REAL',c=>c.query("INSERT INTO effect_attempts(effect_id,claim_id,status,workspace_id,environment) VALUES($1,'spoof','NOT_SENT',$2,'REAL')",[effects.one,two]))).rejects.toThrow('PROFILE_CHILD_SCOPE_CHANGED');
  await expect(scope(one,'SIMULATION',c=>c.query("INSERT INTO effect_attempts(effect_id,claim_id,status) VALUES($1,'wrong_environment','NOT_SENT')",[effects.one]))).rejects.toThrow('PROFILE_CHILD_CONTEXT_REQUIRED');
 });
 it('does not permit reparenting or scope edits after a child is created',async()=>{
  await expect(scope(one,'REAL',c=>c.query("UPDATE effect_attempts SET effect_id=$1 WHERE claim_id='synthetic_new'",[effects.two]))).rejects.toThrow('PROFILE_CHILD_SCOPE_IMMUTABLE');
  await expect(scope(one,'REAL',c=>c.query("UPDATE effect_attempts SET environment='SIMULATION' WHERE claim_id='synthetic_new'"))).rejects.toThrow('PROFILE_CHILD_SCOPE_IMMUTABLE');
 });
 it('preserves legitimate child status updates within the same bound context',async()=>{
  const row=await scope(one,'REAL',async c=>(await c.query("UPDATE effect_attempts SET status='SUCCEEDED',finished_at=clock_timestamp() WHERE claim_id='synthetic_new' RETURNING status,workspace_id,environment")).rows[0]);expect(row).toEqual({status:'SUCCEEDED',workspace_id:one,environment:'REAL'});
 });
 it('restores immutable history protections and does not permit a second migration',async()=>{
  await expect(admin.query("UPDATE commercial_assignment_history SET reason='changed' WHERE assignment_id=$1",[assignment])).rejects.toThrow();expect(await history()).toEqual(original);expect(await triggers()).toEqual(guards);
  await expect(admin.query(component)).rejects.toThrow('PROFILE_CHILD_ALREADY_ALTERED');expect(await cleanColumns()).toHaveLength(36);expect(await history()).toEqual(original);
 });
});
