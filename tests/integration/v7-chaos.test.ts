import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {pool,withTransaction,readOperationalSettings,writeOperationalSettings} from '../../packages/db/src/index.js';
import {planContinuityAdoption,applyContinuityAdoption,adoptionPlanDigest} from '../../packages/db/src/continuity-adoption.js';
import {recordHealth,acquireOwnership} from '../../apps/channel-worker/src/lifecycle.js';
import {recoverSending} from '../../apps/channel-worker/src/dispatch.js';
import {SimulatorProvider,type HealthSignal} from '../../packages/messaging/src/index.js';
import {fixtureProfiles} from '../support/profile-fixture.js';

// V7 CHAOS (F3, «Suites transversales», DB level): the channel worker dies in
// the middle of a send. Measured: the abandoned send becomes «entrega por
// confirmar» and is never repeated; no new worker takes the number while that
// result is uncertain or without proof that the old instance is gone; after the
// readback reconciles it and the isolation receipt exists, the replacement takes
// over and the permanent grant resumes the number by itself. A second profile is
// unaffected throughout.
const P='chaos-'+randomUUID(),Q='chaos-other-'+randomUUID(),fingerprint='f'.repeat(64);
beforeAll(()=>fixtureProfiles({id:P,numbers:5},{id:Q,numbers:5}));
afterAll(async()=>{await pool.end();});
async function inProfile<T>(scope:string,work:(c:import('pg').PoolClient)=>Promise<T>){
 const c=await pool.connect();
 try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[scope]);const r=await work(c);await c.query('COMMIT');return r;}
 catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
const provider=()=>{const p=new SimulatorProvider();p.lifecycle=async()=>{throw Error('LIFECYCLE_MUST_NOT_RUN');};p.health=async():Promise<HealthSignal[]>=>{const at=new Date(Date.now()-500),until=new Date(at.getTime()+60000).toISOString();
 return[{dimension:'session',status:'OK',value:'WORKING',source:'provider_read',scope:'account',availability:'supported',observedAt:at.toISOString(),expiresAt:until},
  {dimension:'transport',status:'OK',value:{identity_fingerprint:fingerprint},source:'provider_read',scope:'account',availability:'supported',observedAt:at.toISOString(),expiresAt:until},
  {dimension:'restriction',status:'OK',value:{latest_read:{timelock:true,capping:true}},source:'provider_read',scope:'account',availability:'supported',observedAt:at.toISOString(),expiresAt:until}];};return p;};

it('a worker killed mid-send never duplicates it and the number resumes only after readback and isolation proof',async()=>{
 for(const scope of [P,Q])await withTransaction(async c=>{await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[scope]);const s=await readOperationalSettings(c,scope,'REAL');
  await writeOperationalSettings(c,scope,'REAL',s.version,{...s.body,dispatch_frozen:false,real_sends_enabled:true,allow_real_operations:true},'synthetic-chaos');});
 const ids=await inProfile(P,async c=>{
  const rec=async(kind:string,body:object)=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL',$2,$3) RETURNING id",[P,kind,body])).rows[0].id as string;
  const account=await rec('channel_account',{name:'Ventas',provider:'waha',gateway_ref:'chaos-'+randomUUID(),status:'WORKING',sending_enabled:true,identity_fingerprint:fingerprint,identity_verified:true});
  const product=await rec('product',{name:'Producto'}),binding=await rec('binding',{account_id:account,product_id:product,valid_from:'2026-01-01T00:00:00Z'});
  const assignment=(await c.query("INSERT INTO commercial_assignments(workspace_id,environment,account_id,product_id,binding_id) VALUES($1,'REAL',$2,$3,$4) RETURNING id",[P,account,product,binding])).rows[0].id;
  const auth=(await c.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at) VALUES($1,'REAL','owner-human',$2,'synthetic',now()+interval '1 day') RETURNING id",[P,{mode:'product_assignment',assignment_id:assignment,assignment_revision:1,binding_id:binding,product_id:product,account_ids:[account]}])).rows[0].id;
  await c.query('UPDATE commercial_assignments SET authorization_id=$2 WHERE id=$1',[assignment,auth]);
  await c.query("UPDATE channel_sessions SET observed_state='CONNECTED',auth_state='VERIFIED',expected_identity_fingerprint=$2,provider_observed_at=now()-interval '90 seconds',health_expires_at=now()+interval '1 minute' WHERE account_id=$1",[account,fingerprint]);
  const contact=await rec('contact',{name:'Cliente sintético',status:'ACTIVE'}),conversation=await rec('conversation',{account_id:account,contact_id:contact,status:'OPEN'});
  const effect=randomUUID();
  await c.query(`INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,logical_key,kind,payload,config_hash,status,expires_at,claim_id,claimed_at,attempts)
   VALUES($1,$2,'REAL',$3,$4,$5,$6,'message','{"text":"synthetic"}','synthetic','SENDING',now()+interval '1 hour','dead-claim',now()-interval '10 minutes',1)`,[effect,P,account,conversation,contact,'chaos:'+effect]);
  return{account,effect};
 });
 const other=await inProfile(Q,async c=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','channel_account',$2) RETURNING id,version,body",[Q,{name:'Otro perfil',provider:'waha',status:'WORKING'}])).rows[0]);
 {const c=await pool.connect();try{await c.query('BEGIN');const plan=await planContinuityAdoption(c);expect((await applyContinuityAdoption(c,adoptionPlanDigest(plan))).adopted).toBe(1);await c.query('COMMIT');}finally{c.release();}}
 const account=(await inProfile(P,c=>c.query('SELECT * FROM records WHERE id=$1',[ids.account]))).rows[0];
 const oldOwner='chaos-dead-'+randomUUID(),newOwner='chaos-replacement-'+randomUUID();
 expect((await acquireOwnership(account,oldOwner)).acquired).toBe(true);
 await inProfile(P,c=>c.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[ids.account]));
 const grantsBefore=(await inProfile(P,c=>c.query('SELECT id,version,state FROM continuous_authorizations WHERE workspace_id=$1',[P]))).rows;
 // The old worker dies: its lease lapses with a send in flight.
 await inProfile(P,c=>c.query("UPDATE session_ownership SET lease_expires_at=now()-interval '1 second' WHERE account_id=$1",[ids.account]));
 await recoverSending(60);
 expect((await inProfile(P,c=>c.query('SELECT status,attempts FROM outbox WHERE id=$1',[ids.effect]))).rows[0]).toEqual({status:'UNKNOWN',attempts:1});
 // No takeover while the result is uncertain, even with an isolation receipt.
 const previous=(await inProfile(P,c=>c.query('SELECT owner_id,generation FROM session_ownership WHERE account_id=$1',[ids.account]))).rows[0];
 await inProfile(P,c=>c.query("UPDATE session_ownership SET frozen=true WHERE account_id=$1",[ids.account]));
 await inProfile(P,c=>c.query("INSERT INTO ownership_isolation_receipts(workspace_id,account_id,previous_owner_id,generation,method,evidence_sha256,verified_at) VALUES($1,$2,$3,$4,'container_stopped_and_access_revoked',$5,now())",[P,ids.account,previous.owner_id,previous.generation,'b'.repeat(64)]));
 expect(await acquireOwnership(account,newOwner)).toMatchObject({acquired:false,reason:'OLD_OWNER_ISOLATION_AND_RECONCILIATION_REQUIRED'});
 // The readback proves the provider accepted it: delivered once, never resent.
 await inProfile(P,c=>c.query("UPDATE outbox SET status='SENT',provider_message_id='wamid.synthetic',result=result||'{\"reconciled_by\":\"provider_readback\"}'::jsonb WHERE id=$1",[ids.effect]));
 const taken=await acquireOwnership(account,newOwner);expect(taken.acquired).toBe(true);
 expect((await inProfile(P,c=>c.query('SELECT owner_id,frozen FROM session_ownership WHERE account_id=$1',[ids.account]))).rows[0]).toEqual({owner_id:newOwner,frozen:true});
 await recordHealth(account,provider,{owner_id:newOwner,generation:taken.generation!});
 expect((await inProfile(P,c=>c.query('SELECT owner_id,frozen FROM session_ownership WHERE account_id=$1',[ids.account]))).rows[0]).toEqual({owner_id:newOwner,frozen:false});
 expect((await inProfile(P,c=>c.query("SELECT payload->>'authority' a FROM domain_events WHERE aggregate_id=$1 AND event_type='channel.continuity_resumed'",[ids.account]))).rows).toEqual([{a:'V7_CONTINUITY'}]);
 // Exactly one effect for the logical send; the permanent grant and the other profile unchanged.
 expect((await inProfile(P,c=>c.query("SELECT count(*)::int n,max(attempts) attempts FROM outbox WHERE workspace_id=$1 AND logical_key LIKE 'chaos:%'",[P]))).rows[0]).toEqual({n:1,attempts:1});
 expect((await inProfile(P,c=>c.query('SELECT id,version,state FROM continuous_authorizations WHERE workspace_id=$1',[P]))).rows).toEqual(grantsBefore);
 expect((await inProfile(Q,c=>c.query('SELECT id,version,body FROM records WHERE id=$1',[other.id]))).rows[0]).toEqual(other);
},120000);
