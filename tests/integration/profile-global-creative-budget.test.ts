import pg from 'pg';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {openMigratedDatabase,promotedSource} from '../support/migrated-database.js';
import {withProfileQueryRouting} from '../../packages/db/src/profile-query-routing.js';
import type {ProfileQuery} from '../../packages/db/src/profile-context.js';
import {readGlobalBudget,assertGlobalBudgetCapacity} from '../../packages/provider-broker/src/global-budget.js';
let admin:pg.Pool,closeDatabase:(()=>Promise<void>)|undefined;
const budgetA='30000000-0000-4000-8000-000000000001',budgetB='30000000-0000-4000-8000-000000000002';
async function scoped<T>(workspace:string|null,environment:string|null,work:(c:pg.PoolClient)=>Promise<T>,role='commerce_api'){
 const c=await admin.connect();try{await c.query('BEGIN');await c.query(`SET LOCAL ROLE ${role}`);if(workspace!==null)await c.query("SELECT set_config('app.workspace_id',$1,true)",[workspace]);if(environment!==null)await c.query("SELECT set_config('app.environment',$1,true)",[environment]);const r=await work(c);await c.query('ROLLBACK');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
const reader=(env='REAL')=>scoped('global-budget-a',env,c=>withProfileQueryRouting({workspaceId:'global-budget-a',query:c.query.bind(c) as ProfileQuery},()=>readGlobalBudget(c,'global-budget-a')));
describe('closed creative aggregate under forced environment RLS',()=>{
 beforeAll(async()=>{
  // V7 F2: a database migrated through 0082 is the exact state the promoted
  // component sees; the installed component text is exercised there.
  const database=await openMigratedDatabase('0082');admin=database.pool;closeDatabase=database.close;
  const sql=await promotedSource('components/020_global_creative_budget_reader.sql');
  // The reviewed owner already exists in this cluster: an unsafe variant of it
  // (inheriting, member of the API role) must be refused, never adopted.
  const c=await admin.connect();try{await c.query('BEGIN');await c.query('ALTER ROLE commerce_global_budget_reader INHERIT; GRANT commerce_api TO commerce_global_budget_reader');await expect(c.query(sql)).rejects.toThrow(/V7_ROLE_EXISTING/);await c.query('ROLLBACK');}finally{c.release();}
  await admin.query(sql);
  for(const name of ['creative_budgets','creative_provider_operations','integration_diagnostics'])await admin.query(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY;ALTER TABLE ${name} FORCE ROW LEVEL SECURITY;CREATE POLICY fixture_runtime ON ${name} TO commerce_api USING(workspace_id=current_setting('app.workspace_id',true) AND environment=current_setting('app.environment',true));`);
  await admin.query("ALTER TABLE creative_global_budgets ENABLE ROW LEVEL SECURITY;ALTER TABLE creative_global_budgets FORCE ROW LEVEL SECURITY;CREATE POLICY fixture_runtime ON creative_global_budgets TO commerce_api USING(workspace_id=current_setting('app.workspace_id',true));");
 },60000);
 beforeEach(async()=>{
  await admin.query("DELETE FROM creative_provider_operations WHERE workspace_id LIKE 'global-budget-%';DELETE FROM integration_diagnostics WHERE workspace_id LIKE 'global-budget-%';DELETE FROM creative_budgets WHERE workspace_id LIKE 'global-budget-%';DELETE FROM creative_global_budgets WHERE workspace_id LIKE 'global-budget-%';");
  await admin.query(`INSERT INTO creative_budgets(id,workspace_id,environment,provider,limit_usd,max_units,reserved_usd,spent_usd,authorization_source,actor_id,expires_at) VALUES($1,'global-budget-a','REAL','openai',5,100,1,2,'Synthetic local test only','fixture',clock_timestamp()+interval '1 hour'),($2,'global-budget-a','SIMULATION','openai',7,100,3,1,'Synthetic local test only','fixture',clock_timestamp()+interval '1 hour'),('30000000-0000-4000-8000-000000000003','global-budget-b','REAL','openai',999,100,900,90,'Synthetic other profile','fixture',clock_timestamp()+interval '1 hour')`,[budgetA,budgetB]);
 });
 afterAll(async()=>{await closeDatabase?.();});
 it('uses a non-inheriting, non-bypass owner with no memberships and no runtime SET ROLE',async()=>{
  expect((await admin.query("SELECT rolcanlogin,rolsuper,rolbypassrls,rolinherit,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname='commerce_global_budget_reader'")).rows[0]).toEqual({rolcanlogin:false,rolsuper:false,rolbypassrls:false,rolinherit:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false});
  expect((await admin.query("SELECT count(*)::int n FROM pg_auth_members WHERE roleid='commerce_global_budget_reader'::regrole OR member='commerce_global_budget_reader'::regrole")).rows[0].n).toBe(0);
  expect((await admin.query("SELECT pg_has_role('commerce_api','commerce_global_budget_reader','SET') allowed")).rows[0].allowed).toBe(false);
 });
 it('returns aggregate REAL+SIMULATION while the runtime reads only its environment',async()=>{
  expect(await scoped('global-budget-a','REAL',async c=>(await c.query("SELECT sum(reserved_usd)::text n FROM creative_budgets WHERE workspace_id='global-budget-a'")).rows[0].n)).toBe('1.000000');
  expect(await reader()).toMatchObject({mode:'MIGRATED_PROVIDER_LIMITS',limit_usd:12,spent_usd:3,reserved_usd:4,available_usd:5});
  expect(await reader('SIMULATION')).toEqual(await reader('REAL'));
 });
 it('does not include another profile and rejects argument/context mismatch',async()=>{
  expect((await reader()).limit_usd).toBe(12);
  await expect(scoped('global-budget-a','REAL',c=>c.query("SELECT * FROM read_profile_global_budget('global-budget-b')"))).rejects.toThrow('PROFILE_GLOBAL_BUDGET_SCOPE_REQUIRED');
 });
 it('rejects absent or invalid context instead of treating it as a global default',async()=>{
  for(const [w,e]of [[null,null],['global-budget-a',null],[null,'REAL'],['global-budget-a','OTHER']] as const)await expect(scoped(w,e,c=>c.query("SELECT * FROM read_profile_global_budget('global-budget-a')"))).rejects.toThrow('PROFILE_GLOBAL_BUDGET_SCOPE_REQUIRED');
 });
 it('does not expose request bodies or authorization sources through owner column grants',async()=>{
  await expect(scoped('global-budget-a','REAL',c=>c.query('SELECT request FROM creative_provider_operations'),'commerce_global_budget_reader')).rejects.toThrow(/permission denied/);
  await expect(scoped('global-budget-a','REAL',c=>c.query('SELECT authorization_source FROM creative_budgets'),'commerce_global_budget_reader')).rejects.toThrow(/permission denied/);
 });
 it('denies callers that have no aggregate capability',async()=>{
  await expect(scoped('global-budget-a','REAL',c=>c.query("SELECT * FROM read_profile_global_budget('global-budget-a')"),'commerce_channel')).rejects.toThrow(/permission denied/);
 });
 it('counts UNKNOWN and unpriced confirmed operations from both environments without refunding',async()=>{
  await admin.query(`INSERT INTO creative_provider_operations(id,workspace_id,environment,actor_id,provider,kind,operation_key,request_hash,request,budget_id,status,estimated_cost,units) VALUES('31000000-0000-4000-8000-000000000001','global-budget-a','REAL','fixture','openai','synthetic','one','hash','{}',$1,'UNKNOWN',1,1),('31000000-0000-4000-8000-000000000002','global-budget-a','SIMULATION','fixture','openai','synthetic','two','hash','{}',$2,'CONFIRMED',1,1)`,[budgetA,budgetB]);
  await admin.query("INSERT INTO integration_diagnostics(id,workspace_id,environment,profile_key,profile_version,actor_id,operation_key,request_hash,capability,status) VALUES('32000000-0000-4000-8000-000000000001','global-budget-a','SIMULATION','synthetic',1,'fixture','three','hash','test','PARTIAL')");
  expect(await reader()).toMatchObject({unknown_cost_operations:3,reserved_usd:4,available_usd:5});
 });
 it('preserves explicit limits and externally reserved capacity',async()=>{
  await admin.query("INSERT INTO creative_global_budgets(workspace_id,limit_usd,external_status,external_reserved_usd,external_source,external_expires_at,authorization_source,actor_id,expires_at) VALUES('global-budget-a',10,'KNOWN',2,'Synthetic external snapshot',clock_timestamp()+interval '1 hour','Synthetic explicit authorization','fixture',clock_timestamp()+interval '1 hour')");
  expect(await reader()).toMatchObject({mode:'EXPLICIT',limit_usd:10,spent_usd:3,reserved_usd:4,external_reserved_usd:2,available_usd:1,version:1,blocked_reason:null});
 });
 it('keeps expiry and external uncertainty blocking semantics',async()=>{
  await admin.query("INSERT INTO creative_global_budgets(workspace_id,limit_usd,external_status,authorization_source,actor_id,expires_at) VALUES('global-budget-a',10,'UNKNOWN','Synthetic authorization','fixture',clock_timestamp()+interval '1 hour')");
  expect(await reader()).toMatchObject({blocked_reason:'GLOBAL_EXTERNAL_COST_UNKNOWN'});await admin.query("UPDATE creative_global_budgets SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id='global-budget-a'");expect(await reader()).toMatchObject({blocked_reason:'GLOBAL_BUDGET_EXPIRED'});
 });
 it('uses the same existing per-profile mutex, with no alternate lock domain',async()=>{
  const lock=await admin.connect();try{await lock.query('BEGIN');await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('creative-provider:global-budget-a',0))");await expect(scoped('global-budget-a','REAL',async c=>{await c.query("SET LOCAL lock_timeout='30ms'");return c.query("SELECT * FROM read_profile_global_budget('global-budget-a')");})).rejects.toThrow(/lock timeout/);}finally{await lock.query('ROLLBACK');lock.release();}
 });
 it('admits against the total and rejects excess before a reservation update',async()=>{
  const capacity=(n:number)=>scoped('global-budget-a','REAL',c=>withProfileQueryRouting({workspaceId:'global-budget-a',query:c.query.bind(c) as ProfileQuery},()=>assertGlobalBudgetCapacity(c,'global-budget-a',n)));
  expect(await capacity(5)).toMatchObject({available_usd:5});await expect(capacity(5.000001)).rejects.toMatchObject({code:'GLOBAL_BUDGET_EXCEEDED'});expect((await reader()).reserved_usd).toBe(4);
 });
 it('never grants mutation authority to the aggregate owner',async()=>{
  await expect(scoped('global-budget-a','REAL',c=>c.query("UPDATE creative_budgets SET reserved_usd=0 WHERE workspace_id='global-budget-a'"),'commerce_global_budget_reader')).rejects.toThrow(/permission denied/);
 });
});
