import {afterAll,beforeEach,expect,it} from 'vitest';
import {disposeAllFixtureProfiles} from '../support/migrated-database.js';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {randomUUID} from 'node:crypto';
import {pool,putRecord,withTransaction,writeOperationalSettings} from '../../packages/db/src/index.js';
import {defaultOperationalSettings} from '../../packages/contracts/src/index.js';
import {integrationPatchSchema,saveIntegrationSetting} from '../../packages/db/src/integration-settings.js';
import {warmupProfileSchema} from '../../packages/domain/src/warmup/policy.js';
import {collectOperationalAlerts,deliverOperationalAlerts} from '../../apps/automation-worker/src/operations-monitor.js';

afterAll(async()=>pool.end());
// REAL denotes an isolated database fixture. Every notification injects a fake fetch;
// no provider, public endpoint or production credential is used.
const endpoint='https://alerts.example.invalid/operations';
const token='synthetic-operational-alert-token-only';
// V7 F2: each case's workspaces are adopted profiles; an installation admits
// three, so the previous cases' profiles are disposed first.
const workspace=async()=>{const id=`operations-monitor-${randomUUID()}`;await fixtureProfiles(id);return id;};
beforeEach(()=>disposeAllFixtureProfiles(pool));

async function configureAlerts(scope:string){
 await withTransaction(c=>saveIntegrationSetting(c,scope,'REAL','alerts:default',integrationPatchSchema.parse({
  expected_version:0,label:'Synthetic incident receiver',enabled:true,config:{endpoint},
  secrets:{token},reason:'Isolated notification test with injected fake transport',
 }),'synthetic-owner'));
}
// V7.5 §6: one open episode per global cause, so each synthetic delivery
// fixture is a distinct cause; the delivery contract under test is unchanged.
async function insertAlert(scope:string,options:{status?:string;created_at?:string;updated_at?:string}={}){
 const kind='SYNTHETIC_INCIDENT_'+randomUUID().slice(0,8).toUpperCase();
 return (await pool.query(`INSERT INTO operational_alerts(workspace_id,environment,dedupe_key,kind,severity,summary_code,status,created_at,updated_at)
  VALUES($1,'REAL',$2,$6,'WARNING',$6,$3,$4,$5) RETURNING *`,
 [scope,randomUUID(),options.status??'PENDING',options.created_at??'2001-01-01T00:00:00Z',options.updated_at??new Date().toISOString(),kind])).rows[0];
}
async function alertState(id:string){return(await pool.query('SELECT status FROM operational_alerts WHERE id=$1',[id])).rows[0].status;}
function captureFetch(onRequest?:(body:Record<string,unknown>,init:RequestInit)=>Promise<Response>){
 const calls:{body:Record<string,unknown>;init:RequestInit;url:string}[]=[];
 const fetcher:typeof fetch=async(input,init)=>{
  const request=init??{},body=JSON.parse(String(request.body)) as Record<string,unknown>;
  calls.push({body,init:request,url:String(input)});
  return onRequest?onRequest(body,request):new Response(null,{status:204});
 };
 return{calls,fetcher};
}

it('does not starve a configured workspace behind more than ten unconfigured pending alerts',async()=>{
 const absent=await workspace(),ready=await workspace();
 const blocked=await Promise.all(Array.from({length:12},()=>insertAlert(absent,{created_at:'2000-01-01T00:00:00Z'})));
 await configureAlerts(ready);const eligible=await insertAlert(ready),transport=captureFetch();
 await deliverOperationalAlerts(transport.fetcher);
 const sent=transport.calls.filter(c=>c.body.id===eligible.id);expect(sent).toHaveLength(1);
 expect(sent[0]!.url).toBe(endpoint);expect(sent[0]!.init.method).toBe('POST');
 expect(new Headers(sent[0]!.init.headers).get('authorization')).toBe(`Bearer ${token}`);
 expect(new Headers(sent[0]!.init.headers).get('idempotency-key')).toBe(eligible.id);
 expect(await alertState(eligible.id)).toBe('ACCEPTED');
 expect(await Promise.all(blocked.map(row=>alertState(row.id)))).toEqual(Array(12).fill('PENDING'));
 expect(transport.calls.some(c=>c.body.workspace_id===absent)).toBe(false);
 const secret=(await pool.query("SELECT ciphertext FROM integration_secrets WHERE workspace_id=$1 AND key='alerts:default' AND field='token'",[ready])).rows[0];
 expect(secret.ciphertext).not.toContain(token);
 const events=(await pool.query("SELECT payload FROM domain_events WHERE workspace_id=$1 AND event_type='operations.alert.accepted'",[ready])).rows;
 expect(events).toHaveLength(1);expect(events[0]!.payload).toMatchObject({recipient_receipt:'NOT_OBSERVED'});
 expect(JSON.stringify(events)).not.toContain(token);
});

it('claims one pending alert once across two workers while the first POST is in flight',async()=>{
 const scope=await workspace();await configureAlerts(scope);const row=await insertAlert(scope);
 let release!:()=>void,started!:()=>void;
 const held=new Promise<void>(resolve=>release=resolve),observed=new Promise<void>(resolve=>started=resolve);
 const transport=captureFetch(async body=>{if(body.id===row.id){started();await held;}return new Response(null,{status:202});});
 const first=deliverOperationalAlerts(transport.fetcher),second=deliverOperationalAlerts(transport.fetcher);
 try{await observed;expect(await alertState(row.id)).toBe('SENDING');}
 finally{release();await Promise.all([first,second]);}
 expect(transport.calls.filter(c=>c.body.id===row.id)).toHaveLength(1);expect(await alertState(row.id)).toBe('ACCEPTED');
 expect((await pool.query("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND event_type='operations.alert.accepted'",[scope])).rows[0].n).toBe(1);
});

it('keeps a timed out notification UNKNOWN without retrying uncertain remote acceptance',async()=>{
 const scope=await workspace();await configureAlerts(scope);const row=await insertAlert(scope);
 const transport=captureFetch(async body=>{if(body.id===row.id)throw new DOMException('Synthetic response timeout','TimeoutError');return new Response(null,{status:204});});
 await deliverOperationalAlerts(transport.fetcher);expect(await alertState(row.id)).toBe('UNKNOWN');
 await deliverOperationalAlerts(transport.fetcher);expect(await alertState(row.id)).toBe('UNKNOWN');
 const own=transport.calls.filter(c=>c.body.id===row.id);expect(own).toHaveLength(1);expect(own[0]!.init.signal).toBeInstanceOf(AbortSignal);
 const events=(await pool.query("SELECT payload FROM domain_events WHERE workspace_id=$1 AND event_type='operations.alert.unknown'",[scope])).rows;
 expect(events).toHaveLength(1);expect(events[0]!.payload).toMatchObject({recipient_receipt:'NOT_OBSERVED'});
});

it('recovers abandoned SENDING as UNKNOWN without POST and leaves a fresh claim in flight',async()=>{
 const scope=await workspace();await configureAlerts(scope);
 const old=await insertAlert(scope,{status:'SENDING',updated_at:'2001-01-01T00:00:00Z'});
 const fresh=await insertAlert(scope,{status:'SENDING'}),transport=captureFetch();
 await deliverOperationalAlerts(transport.fetcher);await deliverOperationalAlerts(transport.fetcher);
 expect(await alertState(old.id)).toBe('UNKNOWN');expect(await alertState(fresh.id)).toBe('SENDING');
 expect(transport.calls.filter(c=>c.body.workspace_id===scope)).toEqual([]);
});

it('deduplicates deployment hold and per-number recovery alerts, then resolves them',async()=>{
 const scope=await workspace(),account=await putRecord(pool,{workspaceId:scope,environment:'REAL',kind:'channel_account',body:{name:'Synthetic release alert',provider:'cloud',sending_enabled:true}});
 await withTransaction(c=>writeOperationalSettings(c,scope,'REAL',0,{...defaultOperationalSettings,dispatch_frozen:false,real_sends_enabled:true,allow_real_operations:true},'fixture'));
 await pool.query("UPDATE operational_settings SET release_hold=true,release_hold_at=now()-interval '10 minutes' WHERE workspace_id=$1 AND environment='REAL'",[scope]);
 await pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,frozen,release_frozen,lease_expires_at) VALUES($1,$2,'synthetic-old-owner',1,true,true,now()-interval '1 minute')",[account.id,scope]);
 await collectOperationalAlerts();await collectOperationalAlerts();
 expect((await pool.query("SELECT count(*)::int n FROM operational_alerts WHERE workspace_id=$1 AND kind='RELEASE_HOLD_OVERDUE' AND resolved_at IS NULL",[scope])).rows[0].n).toBe(1);
 expect((await pool.query("SELECT count(*)::int n FROM operational_alerts WHERE workspace_id=$1 AND kind='RELEASE_RECOVERY_PENDING' AND resolved_at IS NULL",[scope])).rows[0].n).toBe(0);
 await pool.query("UPDATE operational_settings SET release_hold=false WHERE workspace_id=$1 AND environment='REAL'",[scope]);
 await collectOperationalAlerts();await collectOperationalAlerts();
 expect((await pool.query("SELECT count(*)::int n FROM operational_alerts WHERE workspace_id=$1 AND kind='RELEASE_HOLD_OVERDUE' AND resolved_at IS NOT NULL",[scope])).rows[0].n).toBe(1);
 expect((await pool.query("SELECT count(*)::int n FROM operational_alerts WHERE workspace_id=$1 AND kind='RELEASE_RECOVERY_PENDING' AND resolved_at IS NULL",[scope])).rows[0].n).toBe(1);
 await pool.query("UPDATE session_ownership SET release_frozen=false WHERE account_id=$1",[account.id]);
 await collectOperationalAlerts();
 expect((await pool.query("SELECT count(*)::int n FROM operational_alerts WHERE workspace_id=$1 AND kind='RELEASE_RECOVERY_PENDING' AND resolved_at IS NOT NULL",[scope])).rows[0].n).toBe(1);
});

async function warmupPlanFixture(acked:number){
 const scope=await workspace(),now=(await pool.query('SELECT now() now')).rows[0].now as Date;
 // These IANA zones guarantee a different calendar date from UTC at every hour.
 const timezone=now.getUTCHours()<12?'Etc/GMT+12':'Pacific/Kiritimati';
 const localToday=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 const previous=(date:string)=>new Date(Date.parse(date+'T00:00:00Z')-86400000).toISOString().slice(0,10);
 const localYesterday=previous(localToday),utcYesterday=previous(now.toISOString().slice(0,10));
 expect(localYesterday).not.toBe(utcYesterday);
 const config=warmupProfileSchema.parse({name:'Synthetic IANA plan',timezone});
 const profile=(await pool.query("INSERT INTO warmup_profiles(workspace_id,environment,config) VALUES($1,'REAL',$2) RETURNING id",[scope,config])).rows[0];
 const group=(await pool.query("INSERT INTO warmup_pools(workspace_id,environment,profile_id,enabled) VALUES($1,'REAL',$2,false) RETURNING id",[scope,profile.id])).rows[0];
 const accounts=[];
 for(let i=0;i<2;i++){
  const account=await putRecord(pool,{workspaceId:scope,environment:'REAL',kind:'channel_account',body:{name:'Synthetic owned account',provider:'simulator',status:'WORKING',sending_enabled:false}});
  await pool.query("INSERT INTO warmup_states(account_id,workspace_id,environment,pool_id,profile_id,status) VALUES($1,$2,'REAL',$3,$4,'WARMING')",[account.id,scope,group.id,profile.id]);accounts.push(account);
  await pool.query("INSERT INTO warmup_plans(workspace_id,environment,account_id,profile_id,local_date,effective_day,budget,planned_messages) VALUES($1,'REAL',$2,$3,$4,1,'{}',4),($1,'REAL',$2,$3,$5,1,'{}',100)",[scope,account.id,profile.id,localYesterday,utcYesterday]);
 }
 const content=(await pool.query("INSERT INTO warmup_content(workspace_id,environment,content_hash,body,approved_by) VALUES($1,'REAL',$2,$3,'synthetic-owner') RETURNING id",[scope,randomUUID(),{turns:Array.from({length:4},()=>({kind:'text',text:'Synthetic approved turn'}))}])).rows[0];
 const conversation=(await pool.query("INSERT INTO warmup_conversations(workspace_id,environment,initiator_id,peer_id,content_id,local_date) VALUES($1,'REAL',$2,$3,$4,$5) RETURNING id",[scope,accounts[0]!.id,accounts[1]!.id,content.id,localYesterday])).rows[0];
 let predecessor:string|null=null;
 for(let position=0;position<4;position++){
  const sender=accounts[position%2]!.id,recipient=accounts[(position+1)%2]!.id;
  const turn=(await pool.query("INSERT INTO warmup_turns(workspace_id,environment,conversation_id,sender_id,recipient_id,position,content,not_before,expires_at) VALUES($1,'REAL',$2,$3,$4,$5,$6,now()-interval '1 day',now()) RETURNING id",[scope,conversation.id,sender,recipient,position,{kind:'text',text:'Synthetic turn'}])).rows[0];
  const effect:{id:string}=(await pool.query("INSERT INTO outbox(workspace_id,environment,account_id,conversation_id,contact_id,logical_key,kind,payload,status,config_hash,predecessor_id) VALUES($1,'REAL',$2,$3,$4,$5,'warmup',$6,$7,'synthetic-config',$8) RETURNING id",[scope,sender,conversation.id,recipient,randomUUID(),{warmup_turn_id:turn.id},position<acked?(position%2?'READ':'DELIVERED'):'SENT',predecessor])).rows[0];
  await pool.query('UPDATE warmup_turns SET effect_id=$2 WHERE id=$1',[turn.id,effect.id]);predecessor=effect.id;
 }
 return scope;
}

it.each([{acked:2,deviation:true},{acked:3,deviation:false},{acked:4,deviation:false}])('uses the previous IANA date and individual ACK evidence for deviation ($acked of 4)',async({acked,deviation})=>{
 const scope=await warmupPlanFixture(acked);
 await collectOperationalAlerts();await collectOperationalAlerts();
 const incidents=(await pool.query("SELECT severity,summary_code FROM operational_alerts WHERE workspace_id=$1 AND kind='WARMUP_PLAN_DEVIATION'",[scope])).rows;
 expect(incidents).toEqual(deviation?[{severity:'WARNING',summary_code:'WARMUP_PLAN_DEVIATION'}]:[]);
});


it('deduplicates a fresh but blocked worker incident and resolves only with valid progress',async()=>{
 const scope=await workspace();await putRecord(pool,{workspaceId:scope,environment:'REAL',kind:'channel_account',body:{name:'Synthetic worker progress',provider:'simulator'}});
 const body={service:'channel-worker',status:'BLOCKED',observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+60_000).toISOString()};
 let heartbeat=await putRecord(pool,{workspaceId:scope,environment:'REAL',kind:'service_heartbeat',body});
 const incidents=async()=>(await pool.query("SELECT severity,resolved_at FROM operational_alerts WHERE workspace_id=$1 AND kind='CHANNEL_WORKER_UNAVAILABLE'",[scope])).rows;
 await collectOperationalAlerts();await collectOperationalAlerts();
 expect(await incidents()).toEqual([{severity:'CRITICAL',resolved_at:null}]);
 heartbeat=await putRecord(pool,{id:heartbeat.id,version:heartbeat.version,workspaceId:scope,environment:'REAL',kind:'service_heartbeat',body:{...body,status:'OK',observed_at:'2001-01-01T00:00:00Z',expires_at:'2001-01-01T00:01:00Z'}});
 await collectOperationalAlerts();expect(await incidents()).toEqual([{severity:'CRITICAL',resolved_at:null}]);
 await putRecord(pool,{id:heartbeat.id,version:heartbeat.version,workspaceId:scope,environment:'REAL',kind:'service_heartbeat',body:{...body,status:'OK'}});
 await collectOperationalAlerts();expect((await incidents())[0].resolved_at).not.toBeNull();
});

// V7.5 audit: desired behavior, deliberately red until the release fixes land.
it('V7.5 audit: retains one open backup incident across hourly monitor ticks',async()=>{
 const scope=await workspace();await putRecord(pool,{workspaceId:scope,environment:'REAL',kind:'channel_account',body:{provider:'simulator'}});
 const kind='EXTERNAL_BACKUP_NOT_CURRENT';
 await pool.query("INSERT INTO operational_alerts(workspace_id,environment,dedupe_key,kind,severity,summary_code) VALUES($1,'REAL',$2,$3,'CRITICAL',$3)",[scope,kind+':2001-01-01T00',kind]);
 await collectOperationalAlerts();
 expect((await pool.query('SELECT count(*)::int n FROM operational_alerts WHERE workspace_id=$1 AND kind=$2 AND resolved_at IS NULL',[scope,kind])).rows[0].n).toBe(1);
});

it('V7.5 audit: resolves the backup incident when current verified evidence arrives',async()=>{
 const scope=await workspace();await putRecord(pool,{workspaceId:scope,environment:'REAL',kind:'channel_account',body:{provider:'simulator'}});
 await collectOperationalAlerts();
 await pool.query("INSERT INTO operational_evidence(workspace_id,environment,kind,status,source,evidence_ref,details,observed_at,expires_at,actor_id) VALUES($1,'REAL','backup_external','VERIFIED','SERVER_JOB','synthetic-local-backup','{}',now(),now()+interval '1 day','synthetic')",[scope]);
 await collectOperationalAlerts();
 expect((await pool.query("SELECT count(*)::int n FROM operational_alerts WHERE workspace_id=$1 AND kind='EXTERNAL_BACKUP_NOT_CURRENT' AND resolved_at IS NULL",[scope])).rows[0].n).toBe(0);
});

it('V7.5 audit: does not require legacy schedules from an empty QR pool',async()=>{
 const scope=await workspace();await putRecord(pool,{workspaceId:scope,environment:'REAL',kind:'channel_account',body:{provider:'simulator'}});
 const profile=(await pool.query("INSERT INTO warmup_profiles(workspace_id,environment,config) VALUES($1,'REAL',$2) RETURNING id",[scope,warmupProfileSchema.parse({name:'Synthetic unused QR pool',timezone:'UTC'})])).rows[0];
 await pool.query("INSERT INTO warmup_pools(workspace_id,environment,profile_id,enabled,continuity_mode) VALUES($1,'REAL',$2,true,'QR_CONTINUOUS')",[scope,profile.id]);
 await collectOperationalAlerts();
 expect((await pool.query("SELECT kind FROM operational_alerts WHERE workspace_id=$1 AND kind IN('WARMUP_HEALTH_OVERDUE','WARMUP_RECONCILE_OVERDUE','WARMUP_DAILY_OVERDUE')",[scope])).rows).toEqual([]);
});

// V7.5 §6 (H11): episodes, recurrence, escalation and the installed backup producer.
const open=async(scope:string,kind:string)=>(await pool.query('SELECT * FROM operational_alerts WHERE workspace_id=$1 AND kind=$2 AND resolved_at IS NULL AND superseded_by IS NULL',[scope,kind])).rows;
it('V7.5: a repeated observation keeps one episode and its acknowledgement; recovery resolves it and a recurrence opens a new one',async()=>{
 const scope=await workspace();await putRecord(pool,{workspaceId:scope,environment:'REAL',kind:'channel_account',body:{provider:'simulator',status:'FAILED'}});
 await collectOperationalAlerts();await collectOperationalAlerts();
 const [first]=await open(scope,'CHANNEL_PROVIDER_UNAVAILABLE');expect(first.observations).toBe(2);expect(await open(scope,'CHANNEL_PROVIDER_UNAVAILABLE')).toHaveLength(1);
 await pool.query('UPDATE operational_alerts SET acknowledged_at=now(),acknowledged_by=$2 WHERE id=$1',[first.id,'synthetic-owner']);
 await collectOperationalAlerts();expect((await open(scope,'CHANNEL_PROVIDER_UNAVAILABLE'))[0]).toMatchObject({id:first.id,observations:3,acknowledged_by:'synthetic-owner'});
 await pool.query("UPDATE records SET body=body||'{\"status\":\"WORKING\"}'::jsonb,version=version+1 WHERE workspace_id=$1 AND kind='channel_account'",[scope]);
 await collectOperationalAlerts();expect(await open(scope,'CHANNEL_PROVIDER_UNAVAILABLE')).toEqual([]);
 expect((await pool.query('SELECT evidence->>$2 AS r FROM operational_alerts WHERE id=$1',[first.id,'resolution'])).rows[0].r).toBe('CONDITION_CLEARED');
 await pool.query("UPDATE records SET body=body||'{\"status\":\"FAILED\"}'::jsonb,version=version+1 WHERE workspace_id=$1 AND kind='channel_account'",[scope]);
 await collectOperationalAlerts();const [again]=await open(scope,'CHANNEL_PROVIDER_UNAVAILABLE');expect(again.id).not.toBe(first.id);expect(again.acknowledged_at).toBeNull();
});
it('V7.5: escalation to CRITICAL is a new notice for the person; the backup producer that runs resolves the backup episode',async()=>{
 const scope=await workspace();await putRecord(pool,{workspaceId:scope,environment:'REAL',kind:'channel_account',body:{provider:'simulator'}});
 const {episodeAlert}=await import('../../apps/automation-worker/src/operations-monitor.js');
 await withTransaction(c=>episodeAlert(c,{workspace:scope,environment:'REAL',kind:'SYNTHETIC_ESCALATION',severity:'WARNING',active:true,now:new Date()}));
 await pool.query("UPDATE operational_alerts SET acknowledged_at=now() WHERE workspace_id=$1 AND kind='SYNTHETIC_ESCALATION'",[scope]);
 await withTransaction(c=>episodeAlert(c,{workspace:scope,environment:'REAL',kind:'SYNTHETIC_ESCALATION',severity:'CRITICAL',active:true,now:new Date()}));
 expect((await open(scope,'SYNTHETIC_ESCALATION'))[0]).toMatchObject({severity:'CRITICAL',acknowledged_at:null,observations:2});
 await collectOperationalAlerts();expect((await open(scope,'EXTERNAL_BACKUP_NOT_CURRENT'))[0].evidence.source).toBe('NO_VERIFIED_BACKUP_OBSERVED');
 await pool.query("INSERT INTO platform_backup_runs(kind,status,label,started_at,finished_at,database_bytes,repository_bytes) VALUES('PITR_FULL','SUCCEEDED','20001111-000000F',now()-interval '20 minutes',now()-interval '10 minutes',1,1)");
 try{
  await collectOperationalAlerts();expect(await open(scope,'EXTERNAL_BACKUP_NOT_CURRENT')).toEqual([]);
  await pool.query("INSERT INTO platform_backup_runs(kind,status,label,started_at,finished_at,database_bytes,repository_bytes,error) VALUES('PITR_INCR','FAILED',NULL,now()-interval '2 minutes',now()-interval '1 minute',NULL,NULL,'SYNTHETIC_FAILURE')");
  await collectOperationalAlerts();expect((await open(scope,'EXTERNAL_BACKUP_NOT_CURRENT'))[0].evidence.source).toBe('LAST_BACKUP_RUN_FAILED');
 }finally{await pool.query("DELETE FROM platform_backup_runs WHERE label='20001111-000000F' OR error='SYNTHETIC_FAILURE'");}
});
it('V7.5: an active LEGACY pool with members still alerts on overdue schedule windows',async()=>{
 const scope=await workspace();const account=await putRecord(pool,{workspaceId:scope,environment:'REAL',kind:'channel_account',body:{provider:'simulator'}});
 const profile=(await pool.query("INSERT INTO warmup_profiles(workspace_id,environment,config) VALUES($1,'REAL',$2) RETURNING id",[scope,warmupProfileSchema.parse({name:'Synthetic legacy pool',timezone:'UTC'})])).rows[0];
 const created=(await pool.query("INSERT INTO warmup_pools(workspace_id,environment,profile_id,enabled,continuity_mode) VALUES($1,'REAL',$2,true,'LEGACY') RETURNING id",[scope,profile.id])).rows[0];
 await pool.query("INSERT INTO warmup_states(account_id,workspace_id,environment,pool_id,profile_id) VALUES($1,$2,'REAL',$3,$4)",[account.id,scope,created.id,profile.id]);
 await collectOperationalAlerts();
 expect((await pool.query("SELECT kind FROM operational_alerts WHERE workspace_id=$1 AND kind LIKE 'WARMUP_%_OVERDUE' AND resolved_at IS NULL ORDER BY kind",[scope])).rows.map(r=>r.kind)).toEqual(['WARMUP_DAILY_OVERDUE','WARMUP_HEALTH_OVERDUE','WARMUP_RECONCILE_OVERDUE']);
});
