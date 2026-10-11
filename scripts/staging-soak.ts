// Isolated real-clock job observation. Production DBs and all external fetches are rejected.
import {setTimeout as delay} from 'node:timers/promises';
import {pool,withTransaction,putRecord,hash,encrypt,stableJson,readOperationalSettings} from '../packages/db/src/index.js';
import {migrate} from '../packages/db/src/migrate.js';
import {processWarmup} from '../apps/automation-worker/src/warmup.js';
import {warmupProfileSchema} from '../packages/domain/src/warmup/policy.js';
import {acquireOwnership,recordHealth} from '../apps/channel-worker/src/runtime.js';
import {SimulatorProvider} from '../packages/messaging/src/index.js';

const target=new URL(process.env.DATABASE_URL??'');
if(!/^\/commerce_staging_[a-z0-9_]+$/.test(target.pathname)||process.env.STAGING_SOAK_ISOLATED!=='true'||process.env.DISPATCH_FROZEN!=='true')throw Error('ISOLATED_STAGING_REQUIRED');
// This runner has no gateway, AI, email, alert or asset-download transport.
globalThis.fetch=async()=>{throw Error('STAGING_NETWORK_DENIED');};
const workspace='staging-job-soak',owner='staging-soak-exclusive';
// One persistent session lock prevents two observers from counting the same wall-clock interval.
const exclusive=await pool.connect();if(!(await exclusive.query('SELECT pg_try_advisory_lock(7842705) acquired')).rows[0].acquired){exclusive.release();await pool.end();throw Error('STAGING_OBSERVER_ALREADY_RUNNING');}
await migrate();
await pool.query("CREATE TABLE IF NOT EXISTS staging_soak_state(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),started_at timestamptz NOT NULL DEFAULT now(),last_sample_at timestamptz,observed_seconds double precision NOT NULL DEFAULT 0,samples integer NOT NULL DEFAULT 0,max_gap_seconds double precision NOT NULL DEFAULT 0,failures integer NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'RUNNING')");
await pool.query("INSERT INTO staging_soak_state(singleton) VALUES(true) ON CONFLICT DO NOTHING");
await withTransaction(async c=>{
 await c.query('SELECT pg_advisory_xact_lock(7842704)');
 if((await c.query('SELECT 1 FROM warmup_pools WHERE workspace_id=$1',[workspace])).rowCount)return;
 const profile=warmupProfileSchema.parse({name:'Isolated actual-clock fixture',timezone:'UTC',start_hour:0,end_hour:23,profile_wait_hours:12,weekend_factor:1});
 const p=(await c.query("INSERT INTO warmup_profiles(workspace_id,environment,config) VALUES($1,'SIMULATION',$2) RETURNING id",[workspace,profile])).rows[0];
 const group=(await c.query("INSERT INTO warmup_pools(workspace_id,environment,profile_id,enabled,allow_small_pool_concentration) VALUES($1,'SIMULATION',$2,true,true) RETURNING id",[workspace,p.id])).rows[0];
 const accounts:string[]=[];
 for(let i=0;i<2;i++){
  const account=await putRecord(c,{workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body:{name:'Staging synthetic own account '+i,provider:'simulator',status:'WORKING',identity_verified:true,sending_enabled:false,session_provider_at:new Date().toISOString()}});accounts.push(account.id);
  const identity='opaque:staging-'+account.id;
  const id=(await c.query("INSERT INTO warmup_identities(workspace_id,environment,account_id,address_fingerprint,address_ciphertext,profile_ciphertext,ownership_evidence,profile_verified_at,profile_operation_status) VALUES($1,'SIMULATION',$2,$3,$4,$5,'Synthetic staging only',now(),'VERIFIED') RETURNING id",[workspace,account.id,hash(identity),encrypt(identity),encrypt({name:'Synthetic own account',about:'Isolated fixture'})])).rows[0];
  await c.query("INSERT INTO warmup_states(account_id,workspace_id,environment,pool_id,profile_id,identity_id) VALUES($1,$2,'SIMULATION',$3,$4,$5)",[account.id,workspace,group.id,p.id,id.id]);
 }
 const ids:string[]=[];
 for(let n=0;n<10;n++){const body={label:'Staging fixture '+n,ownership_confirmed:true,turns:Array.from({length:6},(_,i)=>({kind:'text',text:`Synthetic staging exchange ${n}, turn ${i}`}))};ids.push((await c.query("INSERT INTO warmup_content(workspace_id,environment,content_hash,body,approved_by) VALUES($1,'SIMULATION',$2,$3,'staging-fixture') RETURNING id",[workspace,hash(stableJson(body)),body])).rows[0].id);}
 const policy=await readOperationalSettings(c,workspace,'SIMULATION'),scope={mode:'warmup',pool_id:group.id,account_ids:accounts,content_ids:ids,max_messages:1000,allow_profile_updates:false,max_cost_minor:0};
 const auth=(await c.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at,configuration_version) VALUES($1,'SIMULATION','staging-fixture',$2,$3,now()+interval '3 days',$4) RETURNING id",[workspace,scope,hash(stableJson(scope)),policy.version])).rows[0];
 await c.query('UPDATE warmup_pools SET authorization_id=$2 WHERE id=$1',[group.id,auth.id]);
});
let stop=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stop=true;});
try{do{
 try{
  // A completed finite observation remains evidence after its authorization expires.
  // Keep the process restartable on the server without dispatching more fixture work.
  const previous=(await pool.query('SELECT status FROM staging_soak_state')).rows[0];
  if(previous.status==='COMPLETED'){
   if(process.argv.includes('--once'))break;
   await delay(60000);continue;
  }
  const accounts=(await pool.query("SELECT * FROM records WHERE kind='channel_account' AND workspace_id=$1",[workspace])).rows;
  if((await pool.query("SELECT 1 FROM records WHERE environment<>'SIMULATION' OR (kind='channel_account' AND body->>'provider'<>'simulator') LIMIT 1")).rowCount)throw Error('STAGING_DATA_ISOLATION_VIOLATED');
  for(const account of accounts){const ownership=await acquireOwnership(account,owner);if(!ownership.acquired)throw Error('STAGING_OWNERSHIP_NOT_ACQUIRED');await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1 AND owner_id=$2',[account.id,owner]);await recordHealth(account,()=>new SimulatorProvider());}
  await processWarmup();
  const state=(await pool.query("UPDATE staging_soak_state SET observed_seconds=observed_seconds+CASE WHEN last_sample_at IS NOT NULL AND extract(epoch FROM(now()-last_sample_at)) BETWEEN 0 AND 120 THEN extract(epoch FROM(now()-last_sample_at)) ELSE 0 END,max_gap_seconds=greatest(max_gap_seconds,COALESCE(extract(epoch FROM(now()-last_sample_at)),0)),last_sample_at=now(),samples=samples+1 RETURNING *")).rows[0];
  const jobs=(await pool.query("SELECT kind,count(*) FILTER(WHERE status='COMPLETED')::int completed,count(*) FILTER(WHERE status='FAILED')::int failed FROM warmup_schedule_runs GROUP BY kind")).rows;
  const complete=state.observed_seconds>=86400&&state.failures===0&&state.max_gap_seconds<=120&&jobs.every(j=>j.failed===0)&&jobs.some(j=>j.kind==='health'&&j.completed>=96)&&jobs.some(j=>j.kind==='reconcile'&&j.completed>=24)&&jobs.some(j=>j.kind==='daily'&&j.completed>=2);
  if(complete)await pool.query("UPDATE staging_soak_state SET status='COMPLETED'");
  console.log(JSON.stringify({measured_at:new Date().toISOString(),...state,status:complete?'COMPLETED':state.status,jobs,external_calls:0,transport_dispatch_tested:false,scope:'actual-clock persisted coordinator jobs; separate transport/recovery suites required'}));
 }catch{await pool.query("UPDATE staging_soak_state SET failures=failures+1,status='FAILED'");console.error('STAGING_SAMPLE_FAILED; inspect isolated state; no provider calls');if(process.argv.includes('--once'))throw Error('STAGING_SAMPLE_FAILED');}
 if(process.argv.includes('--once'))break;
 if(!stop)await delay(60000);
 }while(!stop);
}finally{await exclusive.query('SELECT pg_advisory_unlock(7842705)');exclusive.release();await pool.end();}
