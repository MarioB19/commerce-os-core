/** Isolated PostgreSQL, synthetic records and no provider/production access. */
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {asProfileOwner,requireMigratedProfileSchema,sealFixtureProfiles} from '../support/migrated-database.js';
import {bindProfileEnvironment} from '../../packages/db/src/profile-environment.js';
import {cancelExpiredUnsentEffects} from '../../apps/channel-worker/src/expired-effects.js';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from '../../packages/db/src/profile-context.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';

const suffix=randomBytes(8).toString('hex'),workspace='expiry_'+suffix,foreign=workspace+'_foreign';
let admin:pg.Pool,worker:pg.Pool,scoped:ProfilePool;
const login='expiry_channel_'+suffix;
// V7 F2: derived child rows (gate schedule, attempts) are scoped by profile and
// environment; a profile-scoped worker transaction binds REAL like WorkerScope.
function tx<T>(work:(db:ProfileExecutor)=>Promise<T>,scope=workspace){return withProfileTransaction(scoped,scope,async db=>{await bindProfileEnvironment(db,'REAL');return work(db);});}
async function effect(options:{scope?:string;status?:string;environment?:string;attempts?:number;claim?:string;providerId?:string;future?:boolean;attemptStatus?:string;payload?:object}={}){
 const id=randomUUID();
 await admin.query(`INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,
  logical_key,kind,payload,config_hash,status,expires_at,attempts,claim_id,provider_message_id,result)
  VALUES($1,$2,$3,$4,$5,$6,$1::uuid::text,'message',$12,'synthetic',$7,
   clock_timestamp()+($8::int*interval '1 hour'),$9,$10,$11,'{"reason":"ACCOUNT_PAUSED","audit_marker":"retained"}')`,
 [id,options.scope??workspace,options.environment??'REAL',randomUUID(),randomUUID(),randomUUID(),options.status??'READY',options.future?1:-1,options.attempts??0,options.claim??null,options.providerId??null,options.payload??{}]);
 await admin.query("INSERT INTO outbox_gate_schedule(effect_id,next_check_at,last_reason) VALUES($1,clock_timestamp()+interval '1 day','ACCOUNT_PAUSED')",[id]);
 if(options.attemptStatus)await admin.query('INSERT INTO effect_attempts(effect_id,claim_id,status) VALUES($1,$2,$3)',[id,randomUUID(),options.attemptStatus]);
 return id;
}
async function state(id:string){return(await admin.query('SELECT * FROM outbox WHERE id=$1',[id])).rows[0];}
async function events(id:string){return(await admin.query("SELECT * FROM domain_events WHERE causation_id=$1 AND event_type='effect.cancelled'",[id])).rows;}
describe('V7 expired unsent effects with actual restricted PostgreSQL',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:5000});
  await requireMigratedProfileSchema(admin);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Expiry fixture','UTC',1,10,10),($2,'Foreign fixture','UTC',1,1,1)",[workspace,foreign]);await sealFixtureProfiles(admin,workspace,foreign);
  const password=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT commerce_channel TO "${login}"`);
  const native=new URL(url);native.username=login;native.password=password;worker=new pg.Pool({connectionString:native.toString(),max:5,connectionTimeoutMillis:5000});
  scoped={async connect(){const c=await worker.connect();try{await c.query('SET ROLE commerce_channel');return{query:c.query.bind(c),release:()=>c.release()};}catch(e){c.release();throw e;}}};
 },60000);
 afterAll(async()=>{await worker?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}});
 it('cancels and records once even with no account and preserves prior evidence',async()=>{
  const id=await effect();expect(await tx(db=>cancelExpiredUnsentEffects(db))).toBe(1);
  const row=await state(id);expect(row.status).toBe('CANCELLED');expect(row.result).toMatchObject({reason:'EFFECT_EXPIRED',prior_reason:'ACCOUNT_PAUSED',prior_status:'READY',audit_marker:'retained',external_attempt:false,superseded_before_send:true});
  expect((await admin.query('SELECT 1 FROM outbox_gate_schedule WHERE effect_id=$1',[id])).rowCount).toBe(0);
  expect((await events(id))[0].payload).toMatchObject({effect_id:id,reason:'EFFECT_EXPIRED',external_attempt:false});
  expect(await tx(db=>cancelExpiredUnsentEffects(db))).toBe(0);expect(await events(id)).toHaveLength(1);
 });
 it('cancels BLOCKED in a suspended profile without relaxing its suspension',async()=>{
  const id=await effect({status:'BLOCKED'});await asProfileOwner(admin,workspace,c=>c.query("UPDATE profiles SET state='SUSPENDED' WHERE id=$1",[workspace]));
  try{expect(await tx(db=>cancelExpiredUnsentEffects(db))).toBe(1);expect((await state(id)).status).toBe('CANCELLED');expect((await admin.query('SELECT state FROM profiles WHERE id=$1',[workspace])).rows[0].state).toBe('SUSPENDED');}finally{await asProfileOwner(admin,workspace,c=>c.query("UPDATE profiles SET state='ACTIVE' WHERE id=$1",[workspace]));}
 });
 it('preserves uncertain attempts, claimed rows, provider IDs, simulation and future effects',async()=>{
  const ids=await Promise.all([{status:'SENDING',attempts:1,claim:'current'},{status:'UNKNOWN',attempts:1},{attempts:1},{claim:'stale'},{providerId:'synthetic-provider'},{environment:'SIMULATION'},{future:true},{attemptStatus:'UNKNOWN'},{attemptStatus:'SENT'}].map(effect));
  const before=await Promise.all(ids.map(state));expect(await tx(db=>cancelExpiredUnsentEffects(db))).toBe(0);expect(await Promise.all(ids.map(state))).toEqual(before);
  for(const id of ids)expect(await events(id)).toHaveLength(0);
 });
 it('accepts a released claim only when its attempt is explicitly NOT_SENT',async()=>{
  const id=await effect({status:'BLOCKED',attemptStatus:'NOT_SENT'});expect(await tx(db=>cancelExpiredUnsentEffects(db))).toBe(1);expect((await state(id)).status).toBe('CANCELLED');
  expect((await admin.query('SELECT status FROM effect_attempts WHERE effect_id=$1',[id])).rows[0].status).toBe('NOT_SENT');
 });
 it('cannot cancel a foreign profile and rejects mismatched or missing context',async()=>{
  const id=await effect({scope:foreign});expect(await tx(db=>cancelExpiredUnsentEffects(db))).toBe(0);expect((await state(id)).status).toBe('READY');
  await expect(tx(db=>cancelExpiredUnsentEffects({...db,workspaceId:foreign}))).rejects.toThrow('EXPIRY_PROFILE_CONTEXT_REQUIRED');
  await expect(cancelExpiredUnsentEffects({workspaceId:workspace,query:admin.query.bind(admin)})).rejects.toThrow('EXPIRY_PROFILE_CONTEXT_REQUIRED');
  await expect(tx(db=>cancelExpiredUnsentEffects(db),workspace+'_missing')).rejects.toThrow('EXPIRY_PROFILE_REQUIRED');
 });
 it('rolls back cancellation and audit together after a transaction failure',async()=>{
  const id=await effect();await expect(tx(async db=>{expect(await cancelExpiredUnsentEffects(db)).toBe(1);throw Error('SYNTHETIC_ROLLBACK');})).rejects.toThrow('SYNTHETIC_ROLLBACK');
  expect((await state(id)).status).toBe('READY');expect(await events(id)).toHaveLength(0);expect((await admin.query('SELECT 1 FROM outbox_gate_schedule WHERE effect_id=$1',[id])).rowCount).toBe(1);
  expect(await tx(db=>cancelExpiredUnsentEffects(db))).toBe(1);
 });
 it('skips a competing claim lock without blocking and cancels after a released no-send lock',async()=>{
  const id=await effect(),c=await admin.connect();try{await c.query('BEGIN');await c.query('SELECT 1 FROM outbox WHERE id=$1 FOR UPDATE',[id]);expect(await tx(db=>cancelExpiredUnsentEffects(db))).toBe(0);await c.query('ROLLBACK');}finally{c.release();}
  expect(await tx(db=>cancelExpiredUnsentEffects(db))).toBe(1);expect(await events(id)).toHaveLength(1);
 });
 it('bounds work and excludes already terminal rows',async()=>{
  const ids=await Promise.all([effect(),effect(),effect({status:'CANCELLED'}),effect({status:'FAILED'})]);
  for(const invalid of [0,-1,501,1.5,NaN])await expect(tx(db=>cancelExpiredUnsentEffects(db,invalid))).rejects.toThrow('EXPIRY_LIMIT_INVALID');
  expect(await tx(db=>cancelExpiredUnsentEffects(db,1))).toBe(1);expect(await tx(db=>cancelExpiredUnsentEffects(db,1))).toBe(1);expect(await tx(db=>cancelExpiredUnsentEffects(db))).toBe(0);
  expect(await events(ids[2]!)).toHaveLength(0);expect(await events(ids[3]!)).toHaveLength(0);
 });
 it('projects remarketing atomically without refunding consumed slots or hiding a sibling send',async()=>{
  for(const siblingSent of [false,true]){
   const ids:Record<string,string>={};for(const kind of ['contact','conversation','offer']){ids[kind]=randomUUID();await admin.query("INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,'REAL',$3,'{}')",[ids[kind],workspace,kind]);}
   const cycle=randomUUID(),attempt=randomUUID();await admin.query(`INSERT INTO commercial_remarketing_cycles(id,workspace_id,environment,contact_id,source_conversation_id,source_offer_version_id,policy_snapshot,max_attempts,consumed_attempts,stage,anchor_at)
    VALUES($1,$2,'REAL',$3,$4,$5,'{}',3,1,'AGREEMENT',clock_timestamp())`,[cycle,workspace,ids.contact,ids.conversation,ids.offer]);
   await admin.query("INSERT INTO commercial_remarketing_attempts(id,cycle_id,workspace_id,environment,contact_id,slot_id,stage,conversation_id,status) VALUES($1,$2,$3,'REAL',$4,'first','AGREEMENT',$5,'PROPOSED')",[attempt,cycle,workspace,ids.contact,ids.conversation]);
   const payload={purpose:'remarketing',remarketing_attempt_id:attempt},id=await effect({payload});
   if(siblingSent)await effect({status:'SENT',attempts:1,providerId:'synthetic-sibling',payload});
   expect(await tx(db=>cancelExpiredUnsentEffects(db))).toBe(1);expect((await state(id)).status).toBe('CANCELLED');
   expect((await admin.query('SELECT status FROM commercial_remarketing_attempts WHERE id=$1',[attempt])).rows[0].status).toBe(siblingSent?'SENT':'CANCELLED');
   expect((await admin.query('SELECT consumed_attempts FROM commercial_remarketing_cycles WHERE id=$1',[cycle])).rows[0].consumed_attempts).toBe(1);
  }
 });
});
