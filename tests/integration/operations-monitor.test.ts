import {afterAll,expect,it} from 'vitest';
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
const workspace=()=>`operations-monitor-${randomUUID()}`;

async function configureAlerts(scope:string){
 await withTransaction(c=>saveIntegrationSetting(c,scope,'REAL','alerts:default',integrationPatchSchema.parse({
  expected_version:0,label:'Synthetic incident receiver',enabled:true,config:{endpoint},
  secrets:{token},reason:'Isolated notification test with injected fake transport',
 }),'synthetic-owner'));
}
async function insertAlert(scope:string,options:{status?:string;created_at?:string;updated_at?:string}={}){
 return (await pool.query(`INSERT INTO operational_alerts(workspace_id,environment,dedupe_key,kind,severity,summary_code,status,created_at,updated_at)
  VALUES($1,'REAL',$2,'SYNTHETIC_INCIDENT','WARNING','SYNTHETIC_INCIDENT',$3,$4,$5) RETURNING *`,
 [scope,randomUUID(),options.status??'PENDING',options.created_at??'2001-01-01T00:00:00Z',options.updated_at??new Date().toISOString()])).rows[0];
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
 const absent=workspace(),ready=workspace();
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
 const scope=workspace();await configureAlerts(scope);const row=await insertAlert(scope);
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
 const scope=workspace();await configureAlerts(scope);const row=await insertAlert(scope);
 const transport=captureFetch(async body=>{if(body.id===row.id)throw new DOMException('Synthetic response timeout','TimeoutError');return new Response(null,{status:204});});
 await deliverOperationalAlerts(transport.fetcher);expect(await alertState(row.id)).toBe('UNKNOWN');
 await deliverOperationalAlerts(transport.fetcher);expect(await alertState(row.id)).toBe('UNKNOWN');
 const own=transport.calls.filter(c=>c.body.id===row.id);expect(own).toHaveLength(1);expect(own[0]!.init.signal).toBeInstanceOf(AbortSignal);
 const events=(await pool.query("SELECT payload FROM domain_events WHERE workspace_id=$1 AND event_type='operations.alert.unknown'",[scope])).rows;
 expect(events).toHaveLength(1);expect(events[0]!.payload).toMatchObject({recipient_receipt:'NOT_OBSERVED'});
});

it('recovers abandoned SENDING as UNKNOWN without POST and leaves a fresh claim in flight',async()=>{
 const scope=workspace();await configureAlerts(scope);
 const old=await insertAlert(scope,{status:'SENDING',updated_at:'2001-01-01T00:00:00Z'});
 const fresh=await insertAlert(scope,{status:'SENDING'}),transport=captureFetch();
 await deliverOperationalAlerts(transport.fetcher);await deliverOperationalAlerts(transport.fetcher);
 expect(await alertState(old.id)).toBe('UNKNOWN');expect(await alertState(fresh.id)).toBe('SENDING');
 expect(transport.calls.filter(c=>c.body.workspace_id===scope)).toEqual([]);
});

it('deduplicates deployment hold and per-number recovery alerts, then resolves them',async()=>{
 const scope=workspace(),account=await putRecord(pool,{workspaceId:scope,environment:'REAL',kind:'channel_account',body:{name:'Synthetic release alert',provider:'cloud',sending_enabled:true}});
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
 const scope=workspace(),now=(await pool.query('SELECT now() now')).rows[0].now as Date;
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
 const scope=workspace();await putRecord(pool,{workspaceId:scope,environment:'REAL',kind:'channel_account',body:{name:'Synthetic worker progress',provider:'simulator'}});
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
