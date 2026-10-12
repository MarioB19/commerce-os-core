import {afterAll,expect,it,beforeAll} from 'vitest';
import {fixtureProfiles,retireRealAccount} from '../support/profile-fixture.js';
import {randomUUID} from 'node:crypto';
import {pool,putRecord} from '../../packages/db/src/index.js';
import {acquireOwnership,heartbeatOwnership,discoverSessionOwnership} from '../../apps/channel-worker/src/lifecycle.js';
import {buildChannelServer} from '../../apps/channel-worker/src/server.js';
import {ChannelLoopMonitor} from '../../apps/channel-worker/src/loop-monitor.js';
import {persistChannelHeartbeat} from '../../apps/channel-worker/src/heartbeat.js';
import {roleExecutor} from '../support/database-role.js';

afterAll(()=>pool.end());
const owner='lease-progress-'+randomUUID(),workspace='lease-progress-'+randomUUID();
// V7 F2: fixture workspaces are adopted profiles (max three per installation).
beforeAll(()=>fixtureProfiles(workspace));
const withRole=roleExecutor(pool);
async function fixture(){
 const account=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Synthetic ownership progress',provider:'waha',gateway_ref:'fixture-'+randomUUID(),status:'WORKING',sending_enabled:false}});
 await acquireOwnership(account,owner);
 await pool.query("UPDATE channel_sessions SET recovery_enabled=false,desired_state='RUNNING',operational_pause=false WHERE account_id=$1",[account.id]);
 await pool.query("UPDATE session_ownership SET frozen=false,lease_expires_at=now()-interval '2 minutes' WHERE account_id=$1",[account.id]);
 return account;
}
const state=async(id:string)=>(await pool.query('SELECT owner_id,generation,frozen,lease_expires_at,lease_expires_at>now() live FROM session_ownership WHERE account_id=$1',[id])).rows[0];

it('recovers its acquired generation after a missed heartbeat with recovery disabled and does not enable sending or grants',async()=>{
 const account=await fixture(),before=await state(account.id);
 await pool.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,configuration_version,expires_at) VALUES($1,'REAL','fixture',$2,'synthetic',1,now()+interval '1 hour')",[workspace,{mode:'product_assignment',account_ids:[account.id],max_messages:1}]);
 const grants=(await pool.query('SELECT * FROM operation_authorizations WHERE workspace_id=$1',[workspace])).rows;
 expect(await discoverSessionOwnership(owner)).toBe(0);
 await withRole('commerce_channel',()=>Promise.all([heartbeatOwnership(owner),heartbeatOwnership(owner)]));
 expect(await state(account.id)).toMatchObject({owner_id:owner,generation:before.generation,frozen:false,live:true});
 expect((await pool.query('SELECT * FROM operation_authorizations WHERE workspace_id=$1',[workspace])).rows).toEqual(grants);
 expect((await pool.query('SELECT recovery_enabled,operational_pause,desired_state FROM channel_sessions WHERE account_id=$1',[account.id])).rows[0]).toEqual({recovery_enabled:false,operational_pause:false,desired_state:'RUNNING'});
 expect((await pool.query('SELECT body FROM records WHERE id=$1',[account.id])).rows[0].body.sending_enabled).toBe(false);
 expect((await pool.query("SELECT count(*)::int n FROM domain_events WHERE aggregate_id=$1 AND event_type='channel.ownership_lease_recovered'",[account.id])).rows[0].n).toBe(1);
 expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
});

it.each(['frozen','paused','stopped','archived','deleted','foreign-owner','new-generation'])('does not revive an expired %s lease or bypass the fence through discovery',async boundary=>{
 const account=await fixture();
 await pool.query('UPDATE channel_sessions SET recovery_enabled=true WHERE account_id=$1',[account.id]);
 if(boundary==='frozen')await pool.query('UPDATE session_ownership SET frozen=true WHERE account_id=$1',[account.id]);
 if(boundary==='paused')await pool.query('UPDATE channel_sessions SET operational_pause=true WHERE account_id=$1',[account.id]);
 if(boundary==='stopped')await pool.query("UPDATE channel_sessions SET desired_state='STOPPED' WHERE account_id=$1",[account.id]);
 if(boundary==='archived')await pool.query('UPDATE channel_sessions SET archived_at=now() WHERE account_id=$1',[account.id]);
 // V7 F2: a REAL number is retired only through the quota path (frozen, paused,
 // stopped); the expired lease is then reopened to prove discovery still refuses it.
 if(boundary==='deleted'){await retireRealAccount(workspace,account.id);await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[account.id]);}
 if(boundary==='foreign-owner')await pool.query("UPDATE session_ownership SET owner_id='foreign-fixture-owner' WHERE account_id=$1",[account.id]);
 if(boundary==='new-generation')await pool.query('UPDATE session_ownership SET generation=generation+1 WHERE account_id=$1',[account.id]);
 const before=await state(account.id);
 await discoverSessionOwnership(owner);await heartbeatOwnership(owner);
 expect(await state(account.id)).toEqual(before);
});

it('skips a locked generation so one account cannot prevent renewal of other owned accounts',async()=>{
 const locked=await fixture(),available=await fixture(),client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SELECT account_id FROM session_ownership WHERE account_id=$1 FOR UPDATE',[locked.id]);
  await heartbeatOwnership(owner);
  expect((await state(available.id)).live).toBe(true);expect((await state(locked.id)).live).toBe(false);
 }finally{await client.query('ROLLBACK');client.release();}
 await heartbeatOwnership(owner);expect((await state(locked.id)).live).toBe(true);
});

it('returns 503 for missing or stale loop progress despite a healthy database and persists degraded evidence',async()=>{
 let now=Date.now();const monitor=new ChannelLoopMonitor(()=>now),app=await buildChannelServer(undefined,monitor),instance='fixture-monitor-'+randomUUID();
 try{
  expect((await app.inject({method:'GET',url:'/readyz'})).statusCode).toBe(503);
  const dispatch=monitor.add('dispatch',async()=>{}, {deadlineMs:100});await dispatch.run();
  const ready=await app.inject({method:'GET',url:'/readyz'});expect(ready.statusCode).toBe(200);expect(ready.json()).toMatchObject({ok:true,code:'READY'});
  now+=101;
  const stale=await app.inject({method:'GET',url:'/readyz'});expect(stale.statusCode).toBe(503);expect(stale.json()).toMatchObject({ok:false,code:'CHANNEL_LOOPS_NOT_READY',loops:[{name:'dispatch',status:'STALE'}]});
  await withRole('commerce_channel',()=>persistChannelHeartbeat(instance,monitor.snapshot()));
  const beat=(await pool.query("SELECT body FROM records WHERE workspace_id=$1 AND kind='service_heartbeat' AND body->>'instance'=$2",[workspace,instance])).rows[0].body;
  expect(beat).toMatchObject({status:'BLOCKED',source:'CHANNEL_LOOP_PROGRESS',code:'CHANNEL_LOOPS_NOT_READY',loops:[{name:'dispatch',status:'STALE'}]});
  await dispatch.run();await withRole('commerce_channel',()=>persistChannelHeartbeat(instance,monitor.snapshot()));
  const rows=(await pool.query("SELECT body FROM records WHERE workspace_id=$1 AND kind='service_heartbeat' AND body->>'instance'=$2",[workspace,instance])).rows;
  expect(rows).toHaveLength(1);expect(rows[0].body.status).toBe('OK');
 }finally{await app.close();}
});
