import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {pool,withTransaction,readOperationalSettings,writeOperationalSettings} from '../../packages/db/src/index.js';
import {planContinuityAdoption,applyContinuityAdoption,adoptionPlanDigest} from '../../packages/db/src/continuity-adoption.js';
import {recordHealth,acquireOwnership} from '../../apps/channel-worker/src/lifecycle.js';
import {cancelExpiredUnsentEffects} from '../../apps/channel-worker/src/expired-effects.js';
import {SimulatorProvider,type HealthSignal} from '../../packages/messaging/src/index.js';
import {fixtureProfiles} from '../support/profile-fixture.js';

// V7 CONT (F3, «Suites transversales»): a conversation with a pending reply, a
// follow-up timer and a human pause on another number go through three
// release/restart cycles (the installer's hold and release, then the worker's
// fenced health read). Measured: the same permanent grant, identical human
// pauses, no commercial pause written by the release, fresh work kept, the
// account resumed every time, and expired work cancelled with a record and no send.
const P='cont-'+randomUUID();
const fingerprint='e'.repeat(64);
beforeAll(()=>fixtureProfiles({id:P,numbers:5}));
afterAll(async()=>{await pool.end();});
async function inProfile<T>(work:(c:import('pg').PoolClient)=>Promise<T>,role?:string){
 const c=await pool.connect();
 try{await c.query('BEGIN');if(role)await c.query('SET LOCAL ROLE '+role);await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[P]);const r=await work(c);await c.query('COMMIT');return r;}
 catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
const provider=()=>{const p=new SimulatorProvider();p.health=async():Promise<HealthSignal[]>=>{const at=new Date(Date.now()-500),until=new Date(at.getTime()+60000).toISOString();
 return[{dimension:'session',status:'OK',value:'WORKING',source:'provider_read',scope:'account',availability:'supported',observedAt:at.toISOString(),expiresAt:until},
  {dimension:'transport',status:'OK',value:{identity_fingerprint:fingerprint},source:'provider_read',scope:'account',availability:'supported',observedAt:at.toISOString(),expiresAt:until},
  {dimension:'restriction',status:'OK',value:{latest_read:{timelock:true,capping:true}},source:'provider_read',scope:'account',availability:'supported',observedAt:at.toISOString(),expiresAt:until}];};return p;};
async function hold(){await inProfile(async c=>{
 await c.query("UPDATE operational_settings SET release_hold=true,release_hold_at=now() WHERE workspace_id=$1 AND environment='REAL'",[P]);
 await c.query("UPDATE session_ownership o SET release_frozen=o.release_frozen OR NOT o.frozen,frozen=true,updated_at=now() WHERE o.workspace_id=$1",[P]);});}
async function release(){await inProfile(c=>c.query("UPDATE operational_settings SET release_hold=false WHERE workspace_id=$1 AND environment='REAL'",[P]));}

it('keeps the permanent grant, human pauses and fresh work through three releases; expired work is cancelled unsent',async()=>{
 await withTransaction(async c=>{await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[P]);const s=await readOperationalSettings(c,P,'REAL');
  await writeOperationalSettings(c,P,'REAL',s.version,{...s.body,dispatch_frozen:false,real_sends_enabled:true,allow_real_operations:true,allow_channel_onboarding:true},'synthetic-cont');});
 // Number with an authorized assignment, adopted as a permanent grant.
 const ids=await inProfile(async c=>{
  const rec=async(kind:string,body:object)=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL',$2,$3) RETURNING id",[P,kind,body])).rows[0].id as string;
  const account=await rec('channel_account',{name:'Ventas',provider:'waha',gateway_ref:'cont-'+randomUUID(),status:'WORKING',sending_enabled:true,identity_fingerprint:fingerprint,identity_verified:true});
  const paused=await rec('channel_account',{name:'Pausado',provider:'waha',gateway_ref:'cont-'+randomUUID(),status:'WORKING',sending_enabled:true});
  const product=await rec('product',{name:'Producto'}),binding=await rec('binding',{account_id:account,product_id:product,valid_from:'2026-01-01T00:00:00Z'});
  const assignment=(await c.query("INSERT INTO commercial_assignments(workspace_id,environment,account_id,product_id,binding_id) VALUES($1,'REAL',$2,$3,$4) RETURNING id",[P,account,product,binding])).rows[0].id;
  const auth=(await c.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at) VALUES($1,'REAL','owner-human',$2,'synthetic',now()-interval '1 day') RETURNING id",[P,{mode:'product_assignment',assignment_id:assignment,assignment_revision:1,binding_id:binding,product_id:product,account_ids:[account]}])).rows[0].id;
  await c.query('UPDATE commercial_assignments SET authorization_id=$2 WHERE id=$1',[assignment,auth]);
  await c.query("UPDATE channel_sessions SET observed_state='CONNECTED',auth_state='VERIFIED',expected_identity_fingerprint=$2,provider_observed_at=now()-interval '90 seconds',health_expires_at=now()+interval '1 minute' WHERE account_id=$1",[account,fingerprint]);
  await c.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'channel_account',$2,true,'Pausado por ti','owner-human')",[P,paused]);
  const contact=await rec('contact',{name:'Cliente sintético',status:'ACTIVE'});
  const conversation=await rec('conversation',{account_id:account,contact_id:contact,status:'OPEN'});
  const effect=async(minutes:number)=>{const id=randomUUID();await c.query(`INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,logical_key,kind,payload,config_hash,status,expires_at)
   VALUES($1,$2,'REAL',$3,$4,$5,$1::uuid::text,'message','{"text":"synthetic"}','synthetic','READY',clock_timestamp()+($6::int*interval '1 minute'))`,[id,P,account,conversation,contact,minutes]);return id;};
  const fresh=await effect(60),expired=await effect(-1);
  const timer=(await c.query("INSERT INTO timers(workspace_id,environment,conversation_id,kind,due_at,logical_key) VALUES($1,'REAL',$2,'followup',now()+interval '2 hours','cont:'||$2) RETURNING id",[P,conversation])).rows[0].id;
  return{account,paused,fresh,expired,timer};
 });
 {const c=await pool.connect();try{await c.query('BEGIN');const plan=await planContinuityAdoption(c);expect((await applyContinuityAdoption(c,adoptionPlanDigest(plan))).adopted).toBe(1);await c.query('COMMIT');}finally{c.release();}}
 const account=(await inProfile(c=>c.query('SELECT * FROM records WHERE id=$1',[ids.account]))).rows[0];
 const pausedAccount=(await inProfile(c=>c.query('SELECT * FROM records WHERE id=$1',[ids.paused]))).rows[0];
 const owner='cont-worker-'+randomUUID();
 const fence=await acquireOwnership(account,owner);expect(fence.acquired).toBe(true);await acquireOwnership(pausedAccount,owner);
 await inProfile(c=>c.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[ids.account]));
 const snapshot=async()=>inProfile(async c=>({
  grants:(await c.query('SELECT id,version,state FROM continuous_authorizations WHERE workspace_id=$1 ORDER BY id',[P])).rows,
  controls:(await c.query("SELECT scope_id,paused,version FROM manual_controls WHERE workspace_id=$1 ORDER BY scope_id",[P])).rows,
  settings:(await c.query("SELECT version,body FROM operational_settings WHERE workspace_id=$1 AND environment='REAL'",[P])).rows[0],
 }));
 const before=await snapshot();expect(before.grants).toHaveLength(1);
 for(let cycle=1;cycle<=3;cycle++){
  await hold();
  expect((await inProfile(c=>c.query('SELECT frozen,release_frozen FROM session_ownership WHERE account_id=$1',[ids.account]))).rows[0]).toEqual({frozen:true,release_frozen:true});
  await release();
  await new Promise(r=>setTimeout(r,5));
  await recordHealth(account,provider,{owner_id:owner,generation:fence.generation!});
  const state=await inProfile(async c=>({
   live:(await c.query('SELECT frozen,release_frozen FROM session_ownership WHERE account_id=$1',[ids.account])).rows[0],
   paused:(await c.query('SELECT frozen FROM session_ownership WHERE account_id=$1',[ids.paused])).rows[0],
   fresh:(await c.query('SELECT status FROM outbox WHERE id=$1',[ids.fresh])).rows[0].status,
   timer:(await c.query('SELECT status FROM timers WHERE id=$1',[ids.timer])).rows[0].status,
   recovered:(await c.query("SELECT count(*)::int n FROM domain_events WHERE aggregate_id=$1 AND event_type='channel.release_recovered'",[ids.account])).rows[0].n,
  }));
  expect(state,`cycle ${cycle}`).toEqual({live:{frozen:false,release_frozen:false},paused:{frozen:true},fresh:'READY',timer:'PENDING',recovered:cycle});
  expect(await snapshot(),`cycle ${cycle}`).toEqual(before);
 }
 // Expired work is cancelled with a record by the channel maintenance, never sent.
 const cancelled=await inProfile(c=>cancelExpiredUnsentEffects({workspaceId:P,query:c.query.bind(c)} as never,100),'commerce_channel');
 expect(cancelled).toBe(1);
 const rows=await inProfile(c=>c.query('SELECT id,status,attempts,result FROM outbox WHERE id=ANY($1::uuid[])',[[ids.fresh,ids.expired]]));
 const byId=Object.fromEntries(rows.rows.map(r=>[r.id,r]));
 expect(byId[ids.expired]).toMatchObject({status:'CANCELLED',attempts:0,result:{reason:'EFFECT_EXPIRED',external_attempt:false}});
 expect(byId[ids.fresh].status).toBe('READY');
},120000);
