import type {DomainRecord} from '../../packages/contracts/src/index.js';
import {afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {pool,putRecord,getRecord,withTransaction,hash,encrypt,stableJson,readOperationalSettings} from '../../packages/db/src/index.js';
import {warmupProfileSchema,localWindow} from '../../packages/domain/src/warmup/policy.js';
import {reserveWarmupRate,commercialWarmupGuard} from '../../packages/db/src/warmup.js';
import {planWarmupPool,reconcileWarmupPool,evaluateWarmupPool,processWarmup} from '../../apps/automation-worker/src/warmup.js';
import {gateWarmupDispatch} from '../../apps/channel-worker/src/warmup.js';
import {dispatchOutbox,acquireOwnership,recordHealth} from '../../apps/channel-worker/src/runtime.js';
import {SimulatorProvider} from '../../packages/messaging/src/index.js';
import {materializeMessage} from '../../apps/automation-worker/src/inbound.js';
import {materializeEffectResults} from '../../apps/automation-worker/src/effect-results.js';
import {proposeEffect} from '../../apps/automation-worker/src/shared.js';
afterAll(async()=>pool.end());
const owner='warmup-fixture-owner';
async function fixture(count=2,contentCount=2){
 const workspace='warmup-runtime-'+randomUUID(),now=new Date(),offset=now.getUTCHours()-12,zone=`Etc/GMT${offset>=0?'+':''}${offset}`;
 const profile=warmupProfileSchema.parse({policy_version:'legacy-30d/v1',name:'Synthetic own-pool profile',timezone:zone,start_hour:0,end_hour:23,profile_wait_hours:12,weekend_factor:1});
 const p=(await pool.query("INSERT INTO warmup_profiles(workspace_id,environment,config) VALUES($1,'SIMULATION',$2) RETURNING *",[workspace,profile])).rows[0];
 const group=(await pool.query("INSERT INTO warmup_pools(workspace_id,environment,profile_id,enabled,allow_small_pool_concentration) VALUES($1,'SIMULATION',$2,true,true) RETURNING *",[workspace,p.id])).rows[0];
 const accounts:Array<DomainRecord&{identity:string}>=[];
 for(let i=0;i<count;i++){
  const account=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body:{name:'Synthetic owned number',provider:'simulator',status:'WORKING',identity_verified:true,sending_enabled:false,session_provider_at:new Date(now.getTime()-86400000).toISOString(),health_checked_at:now.toISOString(),health_status:'OK'}});
  const identity='opaque:'+randomUUID(),identityRow=(await pool.query("INSERT INTO warmup_identities(workspace_id,environment,account_id,address_fingerprint,address_ciphertext,profile_ciphertext,ownership_evidence,profile_verified_at) VALUES($1,'SIMULATION',$2,$3,$4,$5,'Synthetic own-number evidence',$6) RETURNING id",[workspace,account.id,hash(identity),encrypt(identity),encrypt({name:'Synthetic owner',about:'Local fixture'}),new Date(now.getTime()-25*3600000)])).rows[0];
  await pool.query("INSERT INTO warmup_states(account_id,workspace_id,environment,pool_id,profile_id,identity_id,status,enrolled_at,profile_ready_at,stable_since,last_observed_at) VALUES($1,$2,'SIMULATION',$3,$4,$5,'WARMING',$6,$6,$7,$8)",[account.id,workspace,group.id,p.id,identityRow.id,new Date(now.getTime()-13*3600000),new Date(now.getTime()-7*86400000),now]);
  await acquireOwnership(account,owner);await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[account.id]);await recordHealth(account,()=>new SimulatorProvider());accounts.push({...account,identity});
 }
 const contents=[];
 for(let n=0;n<contentCount;n++){const body={label:'Synthetic approved exchange '+n,turns:Array.from({length:6},(_,i)=>({kind:'text',text:`Owned content fixture ${n} turn ${i}`}))};contents.push((await pool.query("INSERT INTO warmup_content(workspace_id,environment,content_hash,body,approved_by) VALUES($1,'SIMULATION',$2,$3,'fixture-operator') RETURNING *",[workspace,hash(stableJson(body)),body])).rows[0]);}
 const settings=await readOperationalSettings(pool,workspace,'SIMULATION'),scope={mode:'warmup',pool_id:group.id,account_ids:accounts.map(a=>a.id),content_ids:contents.map(c=>c.id),max_messages:2000,allow_profile_updates:false};
 const auth=(await pool.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at,configuration_version) VALUES($1,'SIMULATION','fixture-operator',$2,$3,now()+interval '1 day',$4) RETURNING id",[workspace,scope,hash(stableJson(scope)),settings.version])).rows[0];
 await pool.query('UPDATE warmup_pools SET authorization_id=$2 WHERE id=$1',[group.id,auth.id]);group.authorization_id=auth.id;
 const plan=()=>withTransaction(async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`warmup-pool:${group.id}`]);return planWarmupPool(c,group,new Date());});
 const effects=async()=>(await pool.query('SELECT * FROM outbox WHERE workspace_id=$1 ORDER BY dispatch_sequence',[workspace])).rows;
 const refresh=async()=>(await pool.query('SELECT * FROM warmup_pools WHERE id=$1',[group.id])).rows[0];
 const state=async(id=accounts[0]!.id)=>(await pool.query('SELECT * FROM warmup_states WHERE account_id=$1',[id])).rows[0];
 return{workspace,now,profile,group,accounts,contents,plan,effects,refresh,state};
}
it('reserves whole alternating conversations once for both endpoints and excludes all sales projections',async()=>{
 const f=await fixture();await f.plan();const all=await f.effects();expect(all).toHaveLength(6);expect(new Set(all.map(e=>e.account_id))).toEqual(new Set(f.accounts.map(a=>a.id)));
 // Account sort is chosen by the planner; alternation is independent of insertion order.
 for(let i=1;i<all.length;i++){expect(all[i].account_id).toBe(all[i-1].contact_id);expect(all[i].predecessor_id).toBe(all[i-1].id);}
 await Promise.all([f.plan(),f.plan()]);expect(await f.effects()).toHaveLength(6);
 const plans=(await pool.query('SELECT planned_messages,planned_conversations FROM warmup_plans WHERE workspace_id=$1',[f.workspace])).rows;expect(plans).toEqual([{planned_messages:6,planned_conversations:1},{planned_messages:6,planned_conversations:1}]);
 const from=f.accounts.find(a=>a.id===all[0].account_id)!,to=f.accounts.find(a=>a.id===all[0].contact_id)!;
 expect(await withTransaction(c=>materializeMessage(c,to,{key:randomUUID(),type:'message',providerAt:new Date().toISOString(),identity:from.identity,text:'Owned exchange',kind:'text',payload:{}},randomUUID()))).toBeUndefined();
 await pool.query("UPDATE outbox SET status='SENT' WHERE workspace_id=$1",[f.workspace]);await materializeEffectResults(1000);
 expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind IN('contact','conversation','order','message')",[f.workspace])).rows[0].n).toBe(0);
});
it('awaits peer, identity, profile wait and approved content without losing initial connection evidence',async()=>{
 const f=await fixture(1);await withTransaction(c=>reconcileWarmupPool(c,f.group,f.now));expect((await f.state()).status).toBe('AWAITING_PEER');expect((await f.state()).effective_days).toBe(0);
 const two=await fixture(2,0);await two.plan();expect((await two.state()).status).toBe('AWAITING_CONTENT');expect(await two.effects()).toHaveLength(0);
 await pool.query('UPDATE warmup_states SET identity_id=NULL WHERE account_id=$1',[two.accounts[0]!.id]);
 await pool.query('UPDATE warmup_identities SET profile_verified_at=NULL WHERE account_id=$1',[two.accounts[0]!.id]);
 await withTransaction(c=>reconcileWarmupPool(c,two.group,new Date()));expect((await two.state()).status).toBe('AWAITING_PROFILE');
 await pool.query('UPDATE warmup_identities SET profile_verified_at=now() WHERE account_id=$1',[two.accounts[0]!.id]);await withTransaction(c=>reconcileWarmupPool(c,two.group,new Date()));expect((await two.state()).status).toBe('PROFILE_WAIT');
});
it('gates ACK-ordered turns, stays UNKNOWN after timeout and respects pause at final dispatch',async()=>{
 const f=await fixture();await f.plan();await pool.query('UPDATE warmup_turns SET not_before=now()-interval \'1 second\' WHERE workspace_id=$1',[f.workspace]);await pool.query('UPDATE outbox o SET not_before=t.not_before FROM warmup_turns t WHERE o.id=t.effect_id AND o.workspace_id=$1',[f.workspace]);
 const first=(await f.effects())[0];
 expect((await withTransaction(c=>gateWarmupDispatch(c,first,owner))).allowed).toBe(true);
 let calls=0;const simulator=Object.assign(new SimulatorProvider(),{send:async()=>{calls++;return{status:'UNKNOWN' as const,reason:'SYNTHETIC_RESPONSE_LOST'};}});
 await dispatchOutbox(100,account=>account.workspace_id===f.workspace?simulator:new SimulatorProvider(),owner);expect(calls).toBe(1);await dispatchOutbox(100,account=>account.workspace_id===f.workspace?simulator:new SimulatorProvider(),owner);expect(calls).toBe(1);
 expect((await f.effects()).slice(0,2).map(e=>e.status)).toEqual(['UNKNOWN','BLOCKED']);
 await pool.query('UPDATE warmup_pools SET paused=true WHERE id=$1',[f.group.id]);expect((await withTransaction(c=>gateWarmupDispatch(c,first,owner))).reason).toBe('WARMUP_POOL_PAUSED');
});
it('atomically limits simultaneous warmup reservations for both endpoints under channel role',async()=>{
 const f=await fixture();await f.plan();const all=await f.effects(),rateAt=new Date();
 const results=await Promise.all(all.slice(0,3).map(effect=>withTransaction(async c=>{await c.query('SET LOCAL ROLE commerce_channel');return reserveWarmupRate(c,effect,f.accounts.map(a=>a.id),2,rateAt);})));
 expect(results.filter(Boolean)).toHaveLength(2);
 const buckets=(await pool.query('SELECT used FROM warmup_rate_buckets WHERE account_id=ANY($1::uuid[])',[f.accounts.map(a=>a.id)])).rows;expect(buckets.map(b=>b.used)).toEqual([2,2]);
 const acceptedEffect=all[results.findIndex(Boolean)];expect(await withTransaction(c=>reserveWarmupRate(c,acceptedEffect,f.accounts.map(a=>a.id),2,rateAt))).toBe(true);
});
it('re-reserves both endpoints across minute boundaries without erasing earlier consumption or bypassing quota',async()=>{
 const f=await fixture();await f.plan();const all=await f.effects(),ids=f.accounts.map(a=>a.id),start=new Date('2026-09-01T12:00:59Z');
 const reserve=(effect:typeof all[number],minutes:number)=>withTransaction(async c=>{await c.query('SET LOCAL ROLE commerce_channel');return reserveWarmupRate(c,effect,ids,1,new Date(start.getTime()+minutes*60000));});
 expect(await reserve(all[0],0)).toBe(true);expect(await reserve(all[1],1)).toBe(true);
 expect(await reserve(all[0],1)).toBe(false);
 expect((await pool.query('SELECT DISTINCT window_start FROM warmup_rate_reservations WHERE effect_id=$1',[all[0].id])).rows.map(r=>new Date(r.window_start).toISOString())).toEqual(['2026-09-01T12:00:00.000Z']);
 expect(await reserve(all[0],2)).toBe(true);expect(await reserve(all[0],2)).toBe(true);
 const buckets=(await pool.query('SELECT account_id,window_start,used FROM warmup_rate_buckets WHERE account_id=ANY($1::uuid[])',[ids])).rows;
 expect(buckets).toHaveLength(6);expect(buckets.every(b=>b.used===1)).toBe(true);
 expect((await pool.query('SELECT DISTINCT window_start FROM warmup_rate_reservations WHERE effect_id=$1',[all[0].id])).rows.map(r=>new Date(r.window_start).toISOString())).toEqual(['2026-09-01T12:02:00.000Z']);
});
it.each([{tail:'SENT',days:0,plan:'MISSED'},{tail:'DELIVERED',days:1,plan:'COMPLETED'}])('requires fully ACKed conversation ($tail) and never advances while paused',async expected=>{
 const f=await fixture();await f.plan();const all=await f.effects(),today=localWindow(f.profile,new Date()).date;
 await pool.query("UPDATE warmup_plans SET local_date=($2::date-1) WHERE workspace_id=$1",[f.workspace,today]);await pool.query("UPDATE warmup_conversations SET local_date=($2::date-1) WHERE workspace_id=$1",[f.workspace,today]);
 await pool.query("UPDATE outbox SET status='DELIVERED' WHERE workspace_id=$1",[f.workspace]);await pool.query("UPDATE outbox SET status=$2 WHERE id=$1",[all.at(-1)!.id,expected.tail]);
 await withTransaction(c=>evaluateWarmupPool(c,{...f.group,paused:true},new Date()));expect((await f.state()).effective_days).toBe(0);
 await withTransaction(c=>evaluateWarmupPool(c,f.group,new Date()));expect((await f.state()).effective_days).toBe(expected.days);
 expect((await pool.query('SELECT status FROM warmup_plans WHERE account_id=$1',[f.accounts[0]!.id])).rows[0].status).toBe(expected.plan);
});
it('opens breaker from two distinct failures of ten, and a restart cannot clear it',async()=>{
 const f=await fixture(10,0),evaluatedAt=new Date(),failedAt=new Date(evaluatedAt.getTime()-1000);
 // One explicit observation clock avoids Docker PostgreSQL/host clock skew;
 // future observations remain rejected by the production breaker.
 for(const a of f.accounts.slice(0,2))for(let i=0;i<3;i++)await pool.query("INSERT INTO warmup_observations(workspace_id,environment,account_id,kind,evidence_ref,observed_at) VALUES($1,'SIMULATION',$2,'FAILED',$3,$4)",[f.workspace,a.id,randomUUID(),failedAt]);
 await withTransaction(c=>evaluateWarmupPool(c,f.group,evaluatedAt));expect((await f.refresh()).breaker_open).toBe(true);
 await withTransaction(c=>reconcileWarmupPool(c,{...f.group,breaker_open:true},new Date()));expect((await f.refresh()).breaker_open).toBe(true);
 await processWarmup(new Date());const runs=(await pool.query('SELECT kind,status FROM warmup_schedule_runs WHERE pool_id=$1',[f.group.id])).rows;expect(runs).toHaveLength(3);await processWarmup(new Date());expect((await pool.query('SELECT count(*)::int n FROM warmup_schedule_runs WHERE pool_id=$1',[f.group.id])).rows[0].n).toBe(3);
});
it.each([60,120])('resets stability after a %i-minute gap before deciding graduation in that same tick',async gapMinutes=>{
 const f=await fixture(2,10),now=new Date(),oldStable=new Date(now.getTime()-8*86400000);
 // Real planner output supplies 30 mature sent/ACKed effects per number, above the minimum sample.
 await pool.query('UPDATE warmup_states SET effective_days=8 WHERE pool_id=$1',[f.group.id]);await f.plan();
 await pool.query("UPDATE outbox SET status='READ',attempts=1,claimed_at=$2 WHERE workspace_id=$1",[f.workspace,new Date(now.getTime()-2*3600000)]);
 const samples=(await pool.query('SELECT account_id,count(*)::int n FROM outbox WHERE workspace_id=$1 GROUP BY account_id',[f.workspace])).rows;
 expect(samples).toHaveLength(2);expect(samples.every(s=>s.n>=20)).toBe(true);
 const reset=f.accounts[0]!,continuous=f.accounts[1]!;
 await pool.query('UPDATE warmup_states SET effective_days=30,stable_since=$2,last_observed_at=$3 WHERE pool_id=$1',[f.group.id,oldStable,new Date(now.getTime()-15*60000)]);
 await pool.query('UPDATE warmup_states SET last_observed_at=$2 WHERE account_id=$1',[reset.id,new Date(now.getTime()-gapMinutes*60000)]);
 await pool.query("UPDATE records SET body=body||jsonb_build_object('health_checked_at',$2::text,'health_status','OK','status','WORKING'),version=version+1 WHERE id=ANY($1::uuid[])",[f.accounts.map(a=>a.id),now.toISOString()]);
 await withTransaction(c=>evaluateWarmupPool(c,f.group,now));
 const restarted=await f.state(reset.id),uninterrupted=await f.state(continuous.id);
 expect(restarted).toMatchObject({status:'WARMING',effective_days:30,extensions:1,reason:'STABILITY_NOT_DEMONSTRATED',graduated_at:null});
 expect(new Date(restarted.stable_since).toISOString()).toBe(now.toISOString());expect(new Date(restarted.last_observed_at).toISOString()).toBe(now.toISOString());
 expect(uninterrupted).toMatchObject({status:'GRADUATED',effective_days:30,extensions:0});expect(new Date(uninterrupted.stable_since).toISOString()).toBe(oldStable.toISOString());
 expect((await pool.query("SELECT count(*)::int n FROM domain_events WHERE aggregate_id=$1 AND event_type='warmup.state_changed' AND payload->>'status'='GRADUATED'",[reset.id])).rows[0].n).toBe(0);
});
it('blocks commercial intents from enrolled accounts even after disabling their pool',async()=>{
 const f=await fixture();await pool.query('UPDATE warmup_pools SET enabled=false WHERE id=$1',[f.group.id]);
 const contact=await putRecord(pool,{workspaceId:f.workspace,environment:'SIMULATION',kind:'contact',body:{identity:'opaque:synthetic-customer'}});
 const conv=await putRecord(pool,{workspaceId:f.workspace,environment:'SIMULATION',kind:'conversation',body:{account_id:f.accounts[0]!.id,contact_id:contact.id}});
 expect(await withTransaction(c=>proposeEffect(c,conv,{kind:'text',text:'Must not become a commercial send'},randomUUID()))).toBeUndefined();
 expect(await f.effects()).toHaveLength(0);
});
it('blocks a live pool member before enrollment and leaves an unactivated draft inert',async()=>{
 const f=await fixture();await pool.query('UPDATE warmup_states SET enrolled_at=NULL WHERE account_id=$1',[f.accounts[0]!.id]);
 expect(await commercialWarmupGuard(pool,f.accounts[0]!)).toBe('ACCOUNT_WARMING');
 await pool.query('UPDATE warmup_pools SET enabled=false WHERE id=$1',[f.group.id]);expect(await commercialWarmupGuard(pool,f.accounts[0]!)).toBeNull();
 await pool.query("UPDATE warmup_states SET status='GRADUATED' WHERE account_id=$1",[f.accounts[0]!.id]);await pool.query('UPDATE warmup_pools SET enabled=true WHERE id=$1',[f.group.id]);
 expect(await commercialWarmupGuard(pool,f.accounts[0]!)).toBeNull();
});
it('runs planner with automation write ownership and preserves scope on alternating predecessors',async()=>{
 const f=await fixture();await withTransaction(async c=>{await c.query('SET LOCAL ROLE commerce_automation');await planWarmupPool(c,f.group,new Date());});expect(await f.effects()).toHaveLength(6);
 const all=await f.effects();await expect(pool.query('UPDATE outbox SET contact_id=$2 WHERE id=$1',[all[0].id,all[0].account_id])).rejects.toThrow('IMMUTABLE_EFFECT_CAUSALITY');
 expect((await getRecord(pool,f.workspace,'channel_account',f.accounts[0]!.id))!.body.sending_enabled).toBe(false);
});
