import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {requireMigratedProfileSchema,sealFixtureProfiles} from '../support/migrated-database.js';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from '../../packages/db/src/profile-context.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {createResultGoal,updateResultGoal,readResultGoal,listResultGoals,resultGoalOperation,readResultGoalOperation} from '../../packages/db/src/result-goals.js';
const suffix=randomBytes(8).toString('hex'),workspace='goals_'+suffix,foreign=workspace+'_foreign',actor='synthetic-owner-'+suffix;
const fields={from:'2026-10-01',to:'2026-10-31',currency:'MXN',family_id:null,variant_id:null,metric:'REVENUE',target:'100000'};
let admin:pg.Pool,api:pg.Pool,scoped:ProfilePool;const login='goals_api_'+suffix;
function tx<T>(work:(db:ProfileExecutor)=>Promise<T>,scope=workspace){return withProfileTransaction(scoped,scope,work);}
function create(){return tx(db=>createResultGoal(db,actor,{fields}));}
describe('V7 goals actual PostgreSQL isolation and audit',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:5000});
  await requireMigratedProfileSchema(admin);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Goal fixture','America/Mexico_City',1,5,100),($2,'Foreign fixture','UTC',1,5,100)",[workspace,foreign]);await sealFixtureProfiles(admin,workspace,foreign);
  const password=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT commerce_api TO "${login}"`);
  const native=new URL(url);native.username=login;native.password=password;api=new pg.Pool({connectionString:native.toString(),max:5,connectionTimeoutMillis:5000});scoped={async connect(){const c=await api.connect();try{await c.query('SET ROLE commerce_api');return{query:c.query.bind(c),release:()=>c.release()};}catch(e){c.release();throw e;}}};
 },60000);
 afterAll(async()=>{await api?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}});
 it('creates exact typed fields and audit and revises by CAS without deleting history',async()=>{
  const goal=await create();expect(goal).toMatchObject({version:1,active:true,fields});
  const updated=await tx(db=>updateResultGoal(db,actor,goal.id,{expected_version:1,fields:{...fields,target:'125000'},active:false}));expect(updated).toMatchObject({version:2,active:false,fields:{target:'125000'}});
  const rows=(await admin.query('SELECT version,event,before_state,after_state FROM result_goal_events WHERE workspace_id=$1 AND goal_id=$2 ORDER BY version',[workspace,goal.id])).rows;
  expect(rows).toHaveLength(2);expect(rows[1].before_state.fields.target).toBe('100000');expect(rows[1].after_state.fields.target).toBe('125000');
  await expect(tx(db=>updateResultGoal(db,actor,goal.id,{expected_version:1,fields,active:true}))).rejects.toThrow('GOAL_VERSION_CONFLICT');
 });
 it('cannot read or mutate a foreign goal and RLS enforces even a raw query',async()=>{
  const goal=await tx(db=>createResultGoal(db,actor,{fields}),foreign);
  await expect(tx(db=>readResultGoal(db,goal.id))).rejects.toThrow('GOAL_NOT_FOUND');
  expect(await tx(async db=>(await db.query('SELECT * FROM result_goals WHERE id=$1',[goal.id])).rows)).toEqual([]);
  expect(await tx(async db=>(await db.query("UPDATE result_goals SET active=false,version=version+1 WHERE id=$1 RETURNING id",[goal.id])).rows)).toEqual([]);
  await expect(tx(db=>createResultGoal({...db,workspaceId:foreign},actor,{fields}))).rejects.toThrow('GOAL_PROFILE_CONTEXT_REQUIRED');
 });
 it('rolls back the goal, event and receipt together',async()=>{
  const op=randomUUID(),before=await tx(db=>listResultGoals(db));
  await expect(tx(db=>resultGoalOperation(db,actor,op,{fields},async()=>{await createResultGoal(db,actor,{fields});throw Error('SYNTHETIC_FAILURE');}))).rejects.toThrow('SYNTHETIC_FAILURE');
  expect(await tx(db=>readResultGoalOperation(db,actor,op))).toBeNull();expect(await tx(db=>listResultGoals(db))).toEqual(before);
 });
 it('reconciles a lost response from one immutable operation and rejects changed requests',async()=>{
  const op=randomUUID(),request={fields},a=await tx(db=>resultGoalOperation(db,actor,op,request,()=>createResultGoal(db,actor,request)));
  const b=await tx(db=>resultGoalOperation(db,actor,op,request,()=>{throw Error('MUST_NOT_REPLAY');}));expect(b).toEqual(a);expect(await tx(db=>readResultGoalOperation(db,actor,op))).toEqual(a);expect(await tx(db=>readResultGoalOperation(db,'different-owner',op))).toBeNull();
  await expect(tx(db=>resultGoalOperation(db,actor,op,{fields:{...fields,target:'200'}},()=>createResultGoal(db,actor,{fields})))).rejects.toThrow('GOAL_OPERATION_CONFLICT');
 });
 it('serializes duplicate operations and competing revisions',async()=>{
  const op=randomUUID(),request={fields},results=await Promise.all([1,2].map(()=>tx(db=>resultGoalOperation(db,actor,op,request,()=>createResultGoal(db,actor,request)))));expect(results[0]).toEqual(results[1]);
  const writes=await Promise.allSettled([1,2].map(i=>tx(db=>updateResultGoal(db,actor,results[0]!.id,{expected_version:1,fields:{...fields,target:String(i*100)},active:true}))));expect(writes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(writes.filter(r=>r.status==='rejected')).toHaveLength(1);
 });
 it('uses exact scoped family and variant foreign keys including environment',async()=>{
  const family=randomUUID(),variant=randomUUID();await admin.query("INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,'REAL','product','{}')",[family,foreign]);await admin.query("INSERT INTO market_families(id,workspace_id,environment) VALUES($1,$2,'REAL')",[family,foreign]);await admin.query("INSERT INTO market_variants(id,workspace_id,environment,family_id,draft) VALUES($1,$2,'REAL',$3,'{}')",[variant,foreign,family]);
  await expect(tx(db=>createResultGoal(db,actor,{fields:{...fields,family_id:family,variant_id:variant}}))).rejects.toThrow('GOAL_FAMILY_NOT_FOUND');
  const goal=await tx(db=>createResultGoal(db,actor,{fields:{...fields,family_id:family,variant_id:variant}}),foreign);expect(goal.fields.variant_id).toBe(variant);
  await expect(tx(db=>db.query('UPDATE result_goals SET family_id=$2,variant_id=$3,version=version+1 WHERE workspace_id=$1',[workspace,family,variant]))).rejects.toThrow();
 });
 it('preserves immutable identity, events and operation receipts at SQL level',async()=>{
  const goal=await create(),op=randomUUID();await tx(db=>resultGoalOperation(db,actor,op,{goal:goal.id},()=>Promise.resolve(goal)));
  await expect(tx(db=>db.query('UPDATE result_goals SET created_by=$2,version=version+1 WHERE id=$1',[goal.id,'forged']))).rejects.toThrow('GOAL_IDENTITY_IMMUTABLE');
  await expect(tx(db=>db.query('UPDATE result_goal_events SET actor_id=$2 WHERE goal_id=$1',[goal.id,'forged']))).rejects.toThrow();
  await expect(tx(db=>db.query('DELETE FROM result_goal_operations WHERE operation_id=$1',[op]))).rejects.toThrow();
 });
 it('paginates without overlap and preserves fixed precision ROAS targets',async()=>{
  const goal=await tx(db=>createResultGoal(db,actor,{fields:{...fields,metric:'ROAS',target:'2.500001'}}));expect(goal.fields.target).toBe('2.500001');
  const first=await tx(db=>listResultGoals(db,undefined,2));expect(first.data).toHaveLength(2);expect(first.next).not.toBeNull();const second=await tx(db=>listResultGoals(db,first.next!,2));expect(second.data.every(row=>!first.data.some(prior=>prior.id===row.id))).toBe(true);
  await expect(tx(db=>listResultGoals(db,undefined,101))).rejects.toThrow('GOAL_LIMIT_INVALID');
 });
});
