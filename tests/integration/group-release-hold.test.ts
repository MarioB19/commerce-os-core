import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';
import {setTimeout as pause} from 'node:timers/promises';
import type {DomainRecord} from '../../packages/contracts/src/index.js';
import type {ProviderFactory} from '../../apps/channel-worker/src/providers.js';
const original=process.env.DATABASE_URL!,control=new pg.Pool({connectionString:original});
const database='group_hold_'+randomUUID().replaceAll('-',''),ownerUrl=new URL(original);ownerUrl.pathname='/'+database;
const workerUrl=new URL(ownerUrl);workerUrl.searchParams.set('options','-c role=commerce_channel -c application_name=group-hold-worker');
const root=fileURLToPath(new URL('../../',import.meta.url));
let created=false,admin:pg.Pool,pool:pg.Pool;
let putRecord:typeof import('../../packages/db/src/index.js').putRecord,encrypt:typeof import('../../packages/db/src/index.js').encrypt,hash:typeof import('../../packages/db/src/index.js').hash;
let active:typeof import('../../apps/channel-worker/src/number-group-observation.js').refreshActiveNumberGroups,effectRefresh:typeof import('../../apps/channel-worker/src/warmup-group-dispatch.js').refreshEffectGroup,dispatch:typeof import('../../apps/channel-worker/src/dispatch.js').dispatchOutbox;
beforeAll(async()=>{
 await control.query(`CREATE DATABASE "${database}" TEMPLATE template0`);created=true;
 await promisify(execFile)(process.execPath,['--import','tsx',realpathSync(fileURLToPath(new URL('../../packages/db/src/migrate.ts',import.meta.url)))],{cwd:root,env:{...process.env,DATABASE_URL:ownerUrl.toString()},timeout:30000});
 admin=new pg.Pool({connectionString:ownerUrl.toString()});process.env.DATABASE_URL=workerUrl.toString();vi.resetModules();
 ({pool,putRecord,encrypt,hash}=await import('../../packages/db/src/index.js'));({refreshActiveNumberGroups:active}=await import('../../apps/channel-worker/src/number-group-observation.js'));({refreshEffectGroup:effectRefresh}=await import('../../apps/channel-worker/src/warmup-group-dispatch.js'));({dispatchOutbox:dispatch}=await import('../../apps/channel-worker/src/dispatch.js'));
 expect((await pool.query('SELECT current_user role')).rows[0].role).toBe('commerce_channel');
});
beforeEach(async()=>{await admin.query('UPDATE warmup_pools SET enabled=false');await admin.query("UPDATE outbox SET status='CANCELLED'");});
afterAll(async()=>{await pool?.end();await admin?.end();process.env.DATABASE_URL=original;try{if(created)await control.query(`DROP DATABASE "${database}"`);}finally{await control.end();}});
async function fixture(environment:'REAL'|'SIMULATION'='REAL',workspace='groups-'+randomUUID(),held=false){
 const account=await putRecord(admin,{workspaceId:workspace,environment,kind:'channel_account',body:{provider:'waha',gateway_ref:'synthetic-'+randomUUID(),engine:environment==='REAL'?'GOWS':'SIMULATOR',status:'WORKING',sending_enabled:false}});
 const groupId=randomUUID(),groupAddress='synthetic-group-'+groupId+'@g.us',profile=randomUUID(),poolId=randomUUID();
 await admin.query("INSERT INTO warmup_profiles(id,workspace_id,environment,config) VALUES($1,$2,$3,'{}')",[profile,workspace,environment]);
 await admin.query("INSERT INTO warmup_groups(id,workspace_id,environment,provider,group_fingerprint,group_ciphertext,name,members,observed_at,expires_at,source) VALUES($1,$2,$3,$4,$5,$6,'Synthetic group',$7,now()-interval '5 minutes',now()+interval '1 hour','fixture')",[groupId,workspace,environment,account.body.provider,hash(groupAddress),encrypt(groupAddress),JSON.stringify([{account_id:account.id}])]);
 await admin.query("INSERT INTO warmup_pools(id,workspace_id,environment,profile_id,enabled,group_id) VALUES($1,$2,$3,$4,true,$5)",[poolId,workspace,environment,profile,groupId]);
 if(environment==='REAL')await admin.query("INSERT INTO operational_settings(workspace_id,environment,version,body,updated_by,release_hold) VALUES($1,'REAL',1,$2,'synthetic',$3) ON CONFLICT DO NOTHING",[workspace,{dispatch_frozen:true,real_sends_enabled:false,allow_real_operations:false,allow_channel_onboarding:false,contact_messages_per_minute:1,channel_account_concurrency:1},held]);
 const peer=await putRecord(admin,{workspaceId:workspace,environment,kind:'channel_account',body:{provider:'waha',engine:String(account.body.engine),status:'STOPPED',sending_enabled:false}});
 for(const member of [account,peer])await admin.query('INSERT INTO warmup_states(account_id,workspace_id,environment,pool_id,profile_id) VALUES($1,$2,$3,$4,$5)',[member.id,workspace,environment,poolId,profile]);
 const content=randomUUID(),conversation=randomUUID(),turn=randomUUID(),effect=randomUUID();
 await admin.query("INSERT INTO warmup_content(id,workspace_id,environment,content_hash,body,approved_by) VALUES($1,$2,$3,$4,'{}','synthetic')",[content,workspace,environment,randomUUID()]);
 await admin.query('INSERT INTO warmup_conversations(id,workspace_id,environment,initiator_id,peer_id,content_id,local_date,pool_id,group_id,membership_version,member_ids) VALUES($1,$2,$3,$4,$5,$6,current_date,$7,$8,1,$9)',[conversation,workspace,environment,account.id,peer.id,content,poolId,groupId,[account.id,peer.id]]);
 await admin.query("INSERT INTO warmup_turns(id,workspace_id,environment,conversation_id,sender_id,recipient_id,position,content,not_before,expires_at,recipient_ids) VALUES($1,$2,$3,$4,$5,$6,0,'{}',now(),now()+interval '1 hour',$7)",[turn,workspace,environment,conversation,account.id,peer.id,[peer.id]]);
 await admin.query("INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,status,config_hash,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'READY','fixture','warmup')",[effect,workspace,environment,account.id,conversation,peer.id,randomUUID(),{group_protocol:'v1',group_id:groupId,warmup_turn_id:turn,warmup_pool_id:poolId}]);
 return{account,groupId,groupAddress,workspace,effect,environment};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function provider(f:Fixture,reads:string[],gate?:()=>Promise<void>):ProviderFactory{return async(a:DomainRecord)=>({group:async()=>{reads.push(a.id);await gate?.();return{id:f.groupAddress,name:'Observed synthetic group',members:[],adminOnly:false,observedAt:new Date().toISOString(),runtime:{version:'synthetic',engine:String(a.body.engine)},complete:true};}} as any);}
async function state(f:Fixture){return(await admin.query("SELECT json_build_object('group',(SELECT row_to_json(g) FROM warmup_groups g WHERE id=$1),'pool',(SELECT row_to_json(p) FROM warmup_pools p WHERE group_id=$1),'events',(SELECT coalesce(json_agg(e ORDER BY e.id),'[]') FROM domain_events e WHERE workspace_id=$2),'effect',(SELECT row_to_json(o) FROM outbox o WHERE id=$3)) value",[f.groupId,f.workspace,f.effect])).rows[0].value;}
async function waitFor(check:()=>Promise<boolean>){const deadline=Date.now()+5000;while(Date.now()<deadline){if(await check())return;await pause(10);}throw Error('CANONICAL_LOCK_NOT_OBSERVED');}
async function hold(c:pg.PoolClient,workspace:string){await c.query("UPDATE operational_settings SET release_hold=true,release_hold_at=clock_timestamp() WHERE workspace_id=$1 AND environment='REAL'",[workspace]);await c.query('COMMIT');}
it('does not claim held groups or consume the global five-group quota',async()=>{
 const held:Fixture[]=[];for(let i=0;i<6;i++)held.push(await fixture('REAL','a-held-'+i+'-'+randomUUID(),true));
 const eligible=await fixture(),before=await Promise.all(held.map(state)),reads:string[]=[];
 expect(await active('synthetic-eligible',provider(eligible,reads))).toEqual({groups:1,failed:0});expect(reads).toEqual([eligible.account.id]);expect(await Promise.all(held.map(state))).toEqual(before);
});
it('keeps missing REAL profiles and SIMULATION with a disabled profile polling compatible',async()=>{
 const real=await fixture(),sim=await fixture('SIMULATION');await admin.query('DELETE FROM operational_settings WHERE workspace_id=$1',[real.workspace]);await admin.query("INSERT INTO integration_settings(workspace_id,environment,key,type,reference,label,version,enabled,updated_by,config) VALUES($1,'SIMULATION',$2,'waha',$3,'Synthetic disabled',1,false,'synthetic','{}')",[sim.workspace,'waha:'+sim.account.body.gateway_ref,sim.account.body.gateway_ref]);
 const reads:string[]=[];const factory:ProviderFactory=async a=>provider(a.id===real.account.id?real:sim,reads)(a);
 expect(await active('synthetic-compatible',factory)).toEqual({groups:2,failed:0});expect(new Set(reads)).toEqual(new Set([real.account.id,sim.account.id]));
 for(const f of [real,sim])expect((await state(f)).group).toMatchObject({probe_until:null,probe_owner:null,name:'Observed synthetic group'});
});
it('waits for operations before locking claim rows and sees committed hold without touching a group',async()=>{
 const f=await fixture(),before=await state(f),reads:string[]=[],c=await admin.connect();let pending:Promise<any>|undefined;
 try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['operations:'+f.workspace+':REAL']);const pid=(await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  pending=active('synthetic-queued',provider(f,reads));void pending.catch(()=>{});
  await waitFor(async()=>Number((await admin.query("SELECT count(*) n FROM pg_stat_activity WHERE datname=$1 AND application_name='group-hold-worker' AND $2=ANY(pg_blocking_pids(pid))",[database,pid])).rows[0].n)>0);
  await c.query("SET LOCAL lock_timeout='1s'");await c.query('SELECT id FROM warmup_groups WHERE id=$1 FOR UPDATE',[f.groupId]);await hold(c,f.workspace);
  expect(await pending).toEqual({groups:0,failed:0});pending=undefined;expect(reads).toEqual([]);const after=await state(f);expect(after).toEqual(before);
 }finally{await c.query('ROLLBACK');await pending?.catch(()=>{});c.release();}
});
it('does not refresh an effect or persist observations when REAL is already held',async()=>{
 const f=await fixture('REAL',undefined,true),reads:string[]=[],before=await state(f);await expect(effectRefresh(f.effect,provider(f,reads))).rejects.toThrow('RELEASE_HOLD_ACTIVE');expect(reads).toEqual([]);expect(await state(f)).toEqual(before);
});
async function race(kind:'active'|'effect'){
 const f=await fixture(),reads:string[]=[],c=await admin.connect();let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>{entered=r}),gate=new Promise<void>(r=>{release=r});
 const factory=provider(f,reads,async()=>{entered();await gate});const pending=kind==='active'?active('synthetic-inflight',factory):effectRefresh(f.effect,factory);void pending.catch(()=>{});
 try{await started;await c.query('BEGIN');const pid=(await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  const authority=c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['operations:'+f.workspace+':REAL']);
  await waitFor(async()=>Number((await admin.query("SELECT count(*) n FROM pg_stat_activity WHERE datname=$1 AND application_name='group-hold-worker' AND pid=ANY(pg_blocking_pids($2))",[database,pid])).rows[0].n)>0);
  release();await authority;const before=await state(f);await hold(c,f.workspace);
  if(kind==='active')expect(await pending).toEqual({groups:1,failed:1});else await expect(pending).rejects.toThrow('RELEASE_HOLD_ACTIVE');
  expect(reads).toEqual([f.account.id]);expect(await state(f)).toEqual(before);expect((await state(f)).group.name).toBe('Synthetic group');
  const blockedReads:string[]=[];expect(await active('synthetic-later',provider(f,blockedReads))).toEqual({groups:0,failed:0});expect(blockedReads).toEqual([]);
 }finally{release();await c.query('ROLLBACK');await pending.catch(()=>{});c.release();}
}
it('rechecks hold after effect SDK read before any observeGroup write',async()=>{await race('effect');});
it('rechecks hold after active SDK read and preserves its prior claim until lease expiry',async()=>{await race('active');});

it('defers held group dispatch without outbox/gate schedule churn or provider factory',async()=>{const f=await fixture('REAL',undefined,true),reads:string[]=[],before=await state(f),schedule=(await admin.query('SELECT * FROM outbox_gate_schedule WHERE effect_id=$1',[f.effect])).rows;expect(await dispatch(20,provider(f,reads))).toBe(0);expect(reads).toEqual([]);expect(await state(f)).toEqual(before);expect((await admin.query('SELECT * FROM outbox_gate_schedule WHERE effect_id=$1',[f.effect])).rows).toEqual(schedule);});
