/** Dedicated logical database and restricted roles; synthetic configuration only. */
import {readFile,readdir} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {createNumberLabEngineRuntime,withNumberLabEngine} from '../../packages/db/src/number-lab-engine-runtime.js';
import {withProfileTransaction,type ProfilePool} from '../../packages/db/src/profile-context.js';
import {currentProfileExecutor} from '../../packages/db/src/profile-query-routing.js';
import {putRecord,getRecord} from '../../packages/db/src/index.js';
import {processNumberLabWorkflows} from '../../apps/automation-worker/src/workflows.js';
import {proposeEffectOutcome} from '../../apps/automation-worker/src/shared.js';

const suffix=randomBytes(6).toString('hex'),database='commerce_lab_engine_'+suffix,login='lab_engine_'+suffix,seedLogin='lab_seed_'+suffix;
const identity={database,installationId:randomUUID(),engineSha256:'a'.repeat(64)};
let parent:pg.Pool,admin:pg.Pool,worker:pg.Pool,seedWorker:pg.Pool,scoped:ProfilePool,seed:ProfilePool;
let runtime:ReturnType<typeof createNumberLabEngineRuntime>;
let setupComplete=false,engineDatabaseOid:string,roleBaseline:unknown[],ownedRoles:unknown[],memberships:unknown[];
const allRoleNames=[login,seedLogin,'commerce_lab_engine','commerce_lab_engine_seed','commerce_lab_engine_owner'];
const rolesSql=`SELECT oid::text,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig FROM pg_roles ORDER BY rolname`;
const membersSql=`SELECT roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member,grantor`;
async function applyCanonical(pool:pg.Pool){
 const migrations=new URL('../../packages/db/migrations/',import.meta.url),files=(await readdir(migrations)).filter(n=>n.endsWith('.sql')).sort();expect(files).toHaveLength(68);
 const c=await pool.connect();try{for(const name of files){await c.query('BEGIN');await c.query(await readFile(new URL(name,migrations),'utf8'));await c.query('COMMIT');}
 for(const name of ['001_profile_identity.sql','010_continuous_authorization.sql','012_continuous_effects.sql']){await c.query('BEGIN');await c.query(await readFile(new URL('../../packages/db/profile-transition/'+name,import.meta.url),'utf8'));await c.query('COMMIT');}}
 finally{c.release();}
}
function rolePool(pool:pg.Pool,role:'commerce_lab_engine'|'commerce_lab_engine_seed'):ProfilePool{return{async connect(){const c=await pool.connect();try{await c.query('SET ROLE '+role);return{query:c.query.bind(c),release:c.release.bind(c)};}catch(e){c.release();throw e;}}};}
async function fixture(lifetime='1 day',accountBody:Record<string,unknown>={}){
 const binding={runId:randomUUID(),operationId:randomUUID(),snapshotSha256:'b'.repeat(64)},workspace='number-lab:'+binding.runId;
 await admin.query("INSERT INTO commerce_number_lab_engine.executions(run_id,operation_id,workspace_id,snapshot_sha256,engine_sha256,state,expires_at) VALUES($1,$2,$3,$4,$5,'INTENT',clock_timestamp()+$6::interval)",[binding.runId,binding.operationId,workspace,binding.snapshotSha256,identity.engineSha256,lifetime]);
 const account=await withProfileTransaction(seed,workspace,c=>putRecord(c,{workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body:{name:'Synthetic lab',provider:'simulator',sending_enabled:false,...accountBody}}));
 return{binding,workspace,account,lease:()=>runtime.lease(binding)};
}

async function workflowFixture(withOrigin=true){
 const f=await fixture('1 day',{lab_snapshot:true,flow_test_transport:'ISOLATED_SIMULATOR'});
 const graph=await withProfileTransaction(seed,f.workspace,async db=>{
  const put=(kind:string,body:Record<string,unknown>,id?:string)=>putRecord(db,{workspaceId:f.workspace,environment:'SIMULATION',kind,body,...(id?{id}:{})});
  const product=await put('product',{name:'Synthetic workflow product'});
  const workflow=await put('workflow',{name:'Synthetic workflow',status:'PUBLISHED',product_id:product.id,entry_node_id:'hello',nodes:[
   {id:'hello',type:'message',config:{text:'Synthetic greeting'},next:'wait'},
   {id:'wait',type:'wait',config:{seconds:3600},next:'follow'},
   {id:'follow',type:'message',config:{text:'Synthetic later message'},next:'done'},
   {id:'done',type:'end',config:{}},
  ]});
  const offer=await put('offer',{name:'Synthetic offer',product_id:product.id,workflow_version_id:workflow.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:12000,fulfillment:[]});
  const assignment=randomUUID(),validFrom=new Date(Date.now()-60000).toISOString(),binding=await put('binding',{account_id:f.account.id,product_id:product.id,offer_version_id:offer.id,workflow_version_id:workflow.id,assignment_id:assignment,valid_from:validFrom});
  await db.query("INSERT INTO commercial_assignments(id,workspace_id,environment,account_id,product_id,binding_id,revision,state) VALUES($1,$2,'SIMULATION',$3,$4,$5,1,'ACTIVE')",[assignment,f.workspace,f.account.id,product.id,binding.id]);
  const sim=await put('simulation',{mode:'NUMBER_FLOW_TEST_V1',status:'RUNNING',account_id:f.account.id,virtual_now:new Date().toISOString(),assignments:[{assignment_id:assignment,product_id:product.id,offer_version_id:offer.id,workflow_version_id:workflow.id}],source:{account:{id:f.account.id}},isolation:{transport:'simulator',external_network:false,real_mutation:false,bank:'LAB_PLACEHOLDER',access:'LAB_ONLY'},external_effects:false});
  const contact=await put('contact',{name:'Synthetic customer',identity:'opaque:sim-'+sim.id});
  const conversation=await put('conversation',{account_id:f.account.id,contact_id:contact.id,simulation_id:sim.id,assignment_id:assignment,assignment_revision:1,binding_id:binding.id,product_id:product.id,offer_version_id:offer.id,workflow_version_id:workflow.id,sequence:1});
  return{product,workflow,offer,sim,contact,conversation};
 });
 // This is a synthetic fixture-origin event, not a claim of native UI/API start.
 if(withOrigin)await admin.query("INSERT INTO domain_events(workspace_id,environment,event_type,aggregate_id,correlation_id,payload) VALUES($1,'SIMULATION','number.flow_test_started',$2,$2,$3)",[f.workspace,graph.sim.id,{external_effects:false,source_account_id:f.account.id}]);
 return{...f,...graph};
}
describe('native dedicated number laboratory engine capability',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_DATABASE_REQUIRED');
  parent=new pg.Pool({connectionString:url.toString(),max:3});roleBaseline=(await parent.query(rolesSql)).rows;await parent.query('CREATE DATABASE "'+database+'"');engineDatabaseOid=(await parent.query('SELECT oid::text FROM pg_database WHERE datname=$1',[database])).rows[0]?.oid;expect(typeof engineDatabaseOid).toBe('string');const engineUrl=new URL(url);engineUrl.pathname='/'+database;admin=new pg.Pool({connectionString:engineUrl.toString(),max:5});
  // Execute exact canonical migration sources in the new empty database. No
  // copied production rows, synthetic engine columns or schema bypasses.
  await applyCanonical(admin);await admin.query(await readFile(new URL('../../packages/db/profile-transition/components/021_number_lab_engine.sql',import.meta.url),'utf8'));
  await admin.query('INSERT INTO commerce_number_lab_engine.installation(installation_id,database_name,engine_sha256) VALUES($1,$2,$3)',[identity.installationId,database,identity.engineSha256]);
  for(const[name,role]of [[login,'commerce_lab_engine'],[seedLogin,'commerce_lab_engine_seed']] as const){const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${secret}' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;GRANT ${role} TO "${name}"`);const u=new URL(engineUrl);u.username=name;u.password=secret;const p=new pg.Pool({connectionString:u.toString(),max:4});if(name===login)worker=p;else seedWorker=p;}
  scoped=rolePool(worker,'commerce_lab_engine');seed=rolePool(seedWorker,'commerce_lab_engine_seed');runtime=createNumberLabEngineRuntime(scoped,identity);
  ownedRoles=(await parent.query(rolesSql)).rows.filter(r=>allRoleNames.includes(r.rolname));expect(ownedRoles).toHaveLength(5);memberships=(await parent.query(membersSql)).rows;setupComplete=true;
 },60000);
 // Vitest requires an object pattern for its unused fixture context; suite is argument two.
 // eslint-disable-next-line no-empty-pattern
 afterAll(async({},suite)=>{await worker?.end();await seedWorker?.end();await admin?.end();
  try{if(setupComplete&&suite.tasks.length>0&&suite.tasks.every(t=>t.type==='test'&&t.result?.state==='pass')){
   const current=(await parent.query(rolesSql)).rows;expect(current.filter(r=>allRoleNames.includes(r.rolname))).toEqual(ownedRoles);expect(current.filter(r=>!allRoleNames.includes(r.rolname))).toEqual(roleBaseline);expect((await parent.query(membersSql)).rows).toEqual(memberships);
   const oid=(await parent.query('SELECT oid::text FROM pg_database WHERE datname=$1',[database])).rows[0]?.oid;expect(oid).toBe(engineDatabaseOid);
   const deps=(await parent.query("SELECT dbid::text FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=ANY($1::oid[])",[ownedRoles.map((r:any)=>r.oid)])).rows;expect(deps.every(d=>d.dbid===oid)).toBe(true);
   await parent.query('DROP DATABASE "'+database+'"');expect((await parent.query("SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=ANY($1::oid[])",[ownedRoles.map((r:any)=>r.oid)])).rows).toEqual([]);
   expect((await parent.query(rolesSql)).rows.filter(r=>allRoleNames.includes(r.rolname))).toEqual(ownedRoles);await parent.query('DROP ROLE '+allRoleNames.map(n=>'"'+n+'"').join(','));expect((await parent.query(rolesSql)).rows).toEqual(roleBaseline);
  }}finally{await parent?.end();}/* Any failure preserves DB/roles for the harness dump. */
 });
 it('authenticates the native role and marker before handing out a phase',async()=>{const f=await fixture(),lease=await f.lease();await withNumberLabEngine(lease,async p=>{const r=await p.query("SELECT current_user AS role,current_database() AS db,current_setting('app.environment') env");expect(r.rows[0]).toEqual({role:'commerce_lab_engine',db:database,env:'SIMULATION'});});});
 it('commits a canonical record and version before IO, then uses a new transaction',async()=>{const f=await fixture();let id='',xid='';await withNumberLabEngine(await f.lease(),async p=>{await p.transaction(async db=>{expect(currentProfileExecutor()).toBe(db);xid=String((await db.query('SELECT txid_current() xid')).rows[0].xid);id=(await putRecord(db,{workspaceId:f.workspace,environment:'SIMULATION',kind:'contact',body:{identity:'opaque:lab-'+f.binding.runId}})).id;});expect(currentProfileExecutor()).toBeUndefined();expect((await admin.query('SELECT count(*)::int n FROM record_versions WHERE record_id=$1',[id])).rows[0].n).toBe(1);await p.transaction(async db=>{expect(String((await db.query('SELECT txid_current() xid')).rows[0].xid)).not.toBe(xid);expect((await getRecord(db,f.workspace,'contact',id))!.id).toBe(id);});});});
 it('executes the canonical effect proposer with continuity schema and no REAL authority',async()=>{const f=await fixture();await withNumberLabEngine(await f.lease(),p=>p.transaction(async db=>{const contact=await putRecord(db,{workspaceId:f.workspace,environment:'SIMULATION',kind:'contact',body:{identity:'opaque:lab-'+f.binding.runId}}),conv=await putRecord(db,{workspaceId:f.workspace,environment:'SIMULATION',kind:'conversation',body:{account_id:f.account.id,contact_id:contact.id}});const one=await proposeEffectOutcome(db,conv,{kind:'text',text:'Synthetic canonical proposal'},'lab:'+conv.id);expect(one.state).toBe('CREATED');expect(await proposeEffectOutcome(db,conv,{kind:'text',text:'Synthetic canonical proposal'},'lab:'+conv.id)).toMatchObject({state:'EXISTING_MATCH'});if(one.state==='CREATED')expect(one.effect).toMatchObject({environment:'SIMULATION',authorization_id:null,continuous_authorization_id:null,status:'READY'});}));});
 it('rejects a REAL record and rolls back its snapshot',async()=>{const f=await fixture();await expect(withNumberLabEngine(await f.lease(),p=>p.transaction(db=>putRecord(db,{workspaceId:f.workspace,environment:'REAL',kind:'contact',body:{identity:'opaque:blocked'}})))).rejects.toThrow();expect((await admin.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind='contact'",[f.workspace])).rows[0].n).toBe(0);});
 it('hides another run under native RLS and rejects a foreign write',async()=>{const a=await fixture(),b=await fixture();await withNumberLabEngine(await a.lease(),async p=>{expect((await p.query('SELECT * FROM records WHERE id=$1',[b.account.id])).rows).toEqual([]);await expect(p.transaction(db=>putRecord(db,{workspaceId:b.workspace,environment:'SIMULATION',kind:'contact',body:{identity:'opaque:blocked'}}))).rejects.toThrow();}).catch(e=>expect(e.message).toBe('LAB_ENGINE_REJECTED'));});
 it('cannot change snapshot configuration or the protected native installation',async()=>{const f=await fixture();for(const sql of ["UPDATE records SET body=body||'{\"name\":\"Changed\"}',version=version+1 WHERE id='"+f.account.id+"'","UPDATE commerce_number_lab_engine.installation SET engine_sha256=repeat('f',64)","UPDATE commerce_number_lab_engine.executions SET snapshot_sha256=repeat('f',64)"]){await expect(withNumberLabEngine(await f.lease(),p=>p.query(sql))).rejects.toThrow();}});
 it('cannot access provider secrets, sessions, control profiles or mutate preparation/authority',async()=>{const f=await fixture();for(const sql of ['SELECT * FROM integration_secrets','SELECT * FROM session','SELECT * FROM profiles','INSERT INTO warmup_pools(workspace_id) VALUES(\'x\')','INSERT INTO operation_authorizations(workspace_id) VALUES(\'x\')','SELECT * FROM continuous_authorizations','SELECT * FROM read_locked_operation_authorization(gen_random_uuid(),\'x\',\'REAL\')'])await expect(withNumberLabEngine(await f.lease(),p=>p.query(sql))).rejects.toMatchObject({code:'42501'});});
 it('keeps the canonical legacy joins as empty read projections',async()=>{const f=await fixture();await withNumberLabEngine(await f.lease(),async p=>{for(const name of ['operation_authorizations','warmup_states','warmup_pools','warmup_identities'])expect((await p.query('SELECT * FROM '+name)).rows).toEqual([]);});});
 it('rejects wrong native database/marker and caller-forged binding',async()=>{const f=await fixture();await expect(createNumberLabEngineRuntime(scoped,{...identity,database:'commerce_lab_engine_other'}).lease(f.binding)).rejects.toThrow('LAB_ENGINE_IDENTITY_REQUIRED');await expect(runtime.lease({...f.binding,snapshotSha256:'c'.repeat(64)})).rejects.toThrow('LAB_ENGINE_BINDING_REQUIRED');await expect(withNumberLabEngine({...f.binding},async()=>undefined)).rejects.toThrow('LAB_ENGINE_LEASE_REQUIRED');});
 it('rechecks database-clock expiry after work and rolls back before any result escapes',async()=>{const f=await fixture('700 milliseconds');await expect(withNumberLabEngine(await f.lease(),p=>p.transaction(async db=>{await putRecord(db,{workspaceId:f.workspace,environment:'SIMULATION',kind:'contact',body:{identity:'opaque:late'}});await db.query('SELECT pg_sleep(0.8)');return 'never';}))).rejects.toThrow('LAB_ENGINE_BINDING_REQUIRED');expect((await admin.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind='contact'",[f.workspace])).rows[0].n).toBe(0);});
 it('does not reopen a native terminal execution or allow a replayed local lease',async()=>{const f=await fixture(),lease=await f.lease();await withNumberLabEngine(lease,async()=>undefined);await expect(withNumberLabEngine(lease,async()=>undefined)).rejects.toThrow('LAB_ENGINE_LEASE_REQUIRED');await admin.query("UPDATE commerce_number_lab_engine.executions SET state='UNKNOWN' WHERE run_id=$1",[f.binding.runId]);await expect(f.lease()).rejects.toThrow('LAB_ENGINE_BINDING_REQUIRED');await expect(admin.query("UPDATE commerce_number_lab_engine.executions SET state='INTENT' WHERE run_id=$1",[f.binding.runId])).rejects.toThrow('LAB_ENGINE_EXECUTION_IMMUTABLE');});
 it('cannot construct REAL transport configuration even with the seed role',async()=>{const f=await fixture();await expect(withProfileTransaction(seed,f.workspace,db=>putRecord(db,{workspaceId:f.workspace,environment:'SIMULATION',kind:'channel_account',body:{provider:'waha'}}))).rejects.toThrow('LAB_ENGINE_SIMULATOR_REQUIRED');});
 it('refuses residual commands and events even when records and outbox are empty',async()=>{
  const dirtyName='commerce_lab_engine_residual_'+suffix,u=new URL(localInventoryTarget(process.env.DATABASE_URL));u.pathname='/'+dirtyName;await parent.query('CREATE DATABASE "'+dirtyName+'"');const dirtyOid=(await parent.query('SELECT oid::text FROM pg_database WHERE datname=$1',[dirtyName])).rows[0]?.oid;expect(typeof dirtyOid).toBe('string');const dirty=new pg.Pool({connectionString:u.toString(),max:2});let passed=false;
  try{await applyCanonical(dirty);for(const sql of ["INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,idempotency_key) VALUES('old','SIMULATION','old','old','old','old')","INSERT INTO domain_events(workspace_id,environment,event_type,aggregate_id,correlation_id) VALUES('old','SIMULATION','old','old','old')"]){const c=await dirty.connect();try{await c.query('BEGIN');await c.query(sql);await expect(c.query(await readFile(new URL('../../packages/db/profile-transition/components/021_number_lab_engine.sql',import.meta.url),'utf8'))).rejects.toThrow('LAB_ENGINE_EMPTY_DATABASE_REQUIRED');}finally{await c.query('ROLLBACK');c.release();}}passed=true;}finally{await dirty.end();if(passed){expect((await parent.query('SELECT oid::text FROM pg_database WHERE datname=$1',[dirtyName])).rows[0]?.oid).toBe(dirtyOid);await parent.query('DROP DATABASE "'+dirtyName+'"');}}
 });

 it('runs the canonical published workflow and creates a TEST order and one durable effect',async()=>{
  const f=await workflowFixture();expect(await processNumberLabWorkflows(await f.lease())).toEqual({workflows:1,timers:0});
  const order=(await admin.query("SELECT body FROM records WHERE workspace_id=$1 AND kind='order'",[f.workspace])).rows[0].body;
  expect(order).toMatchObject({commercial_classification:'TEST',simulation_id:f.sim.id,analytics_excluded_from_creation:true,amount_minor:12000,currency:'MXN'});
  const effects=(await admin.query('SELECT environment,payload,status,authorization_id,continuous_authorization_id FROM outbox WHERE workspace_id=$1',[f.workspace])).rows;
  expect(effects).toHaveLength(1);expect(effects[0]).toMatchObject({environment:'SIMULATION',payload:{text:'Synthetic greeting',workflow_node_id:'hello'},status:'READY',authorization_id:null,continuous_authorization_id:null});
  expect((await admin.query('SELECT status,payload FROM timers WHERE workspace_id=$1',[f.workspace])).rows).toMatchObject([{status:'PENDING',payload:{node_id:'wait'}}]);
  expect(await processNumberLabWorkflows(await f.lease())).toEqual({workflows:0,timers:0});expect((await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[f.workspace])).rows[0].n).toBe(1);
 });
 it('uses the canonical virtual timer without waiting in REAL time or duplicating its effect',async()=>{
  const f=await workflowFixture();await processNumberLabWorkflows(await f.lease());
  await withNumberLabEngine(await f.lease(),p=>p.transaction(async db=>{const sim=(await getRecord(db,f.workspace,'simulation',f.sim.id))!;await putRecord(db,{id:sim.id,workspaceId:f.workspace,environment:'SIMULATION',kind:'simulation',version:sim.version,body:{...sim.body,virtual_now:new Date(Date.now()+2*3600_000).toISOString()}});}));
  expect(await processNumberLabWorkflows(await f.lease())).toEqual({workflows:0,timers:1});expect((await admin.query('SELECT payload FROM outbox WHERE workspace_id=$1 ORDER BY dispatch_sequence',[f.workspace])).rows.map(r=>r.payload.text)).toEqual(['Synthetic greeting','Synthetic later message']);
  expect((await admin.query('SELECT status FROM timers WHERE workspace_id=$1',[f.workspace])).rows).toEqual([{status:'FIRED'}]);
  expect((await admin.query('SELECT body FROM records WHERE id=$1',[f.conversation.id])).rows[0].body.flow_state.status).toBe('FINISHED');await processNumberLabWorkflows(await f.lease());expect((await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[f.workspace])).rows[0].n).toBe(2);
 });
 it('keeps another run and a paused conversation out of canonical execution',async()=>{
  const one=await workflowFixture(),two=await workflowFixture();await processNumberLabWorkflows(await one.lease());expect((await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[two.workspace])).rows[0].n).toBe(0);
  await admin.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'conversation',$2,true,'Synthetic pause','synthetic-fixture')",[two.workspace,two.conversation.id]);await processNumberLabWorkflows(await two.lease());expect((await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[two.workspace])).rows[0].n).toBe(0);expect((await admin.query('SELECT version FROM records WHERE id=$1',[two.conversation.id])).rows[0].version).toBe(1);
 });
 it('does not fall back to old simulation classification when the canonical origin is missing',async()=>{
  const f=await workflowFixture(false);await expect(processNumberLabWorkflows(await f.lease())).rejects.toThrow('NUMBER_FLOW_TEST_SCOPE_INVALID');expect((await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[f.workspace])).rows[0].n).toBe(0);expect((await admin.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind='order'",[f.workspace])).rows[0].n).toBe(0);
 });

 it('allows only the canonical retention boolean and never maintenance execution',async()=>{const f=await fixture();await withNumberLabEngine(await f.lease(),async p=>{expect((await p.query('SELECT retention_context_valid() allowed')).rows).toEqual([{allowed:false}]);});await expect(withNumberLabEngine(await f.lease(),p=>p.query('SELECT apply_retention_plan($1,$2,false)',[randomUUID(),'a'.repeat(64)]))).rejects.toMatchObject({code:'42501'});});

});
