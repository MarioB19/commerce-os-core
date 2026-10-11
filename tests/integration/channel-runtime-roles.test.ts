import {afterAll,beforeAll,expect,it} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pool as adminPool,putRecord,appendEvent} from '../../packages/db/src/index.js';
import {insertPersonalToken,newPersonalToken} from '../../packages/db/src/personal-access-tokens.js';

const execute=promisify(execFile),database='channel_roles_'+randomUUID().replaceAll('-','');
const connection=new URL(process.env.DATABASE_URL!);connection.pathname='/'+database;
const fixture={workspace:'channel-runtime-'+randomUUID(),user:randomUUID(),token:newPersonalToken(),gateway:'fixture-'+randomUUID(),account:'',command:randomUUID(),alert:randomUUID(),authorization:randomUUID()};
let pool:pg.Pool;const historyIds:string[]=[];
beforeAll(async()=>{
 await adminPool.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
 await execute(process.execPath,['--import','tsx','packages/db/src/migrate.ts'],{env:{...process.env,DATABASE_URL:connection.toString()},timeout:30000});
 pool=new pg.Pool({connectionString:connection.toString()});
 await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[fixture.user,'Synthetic owner',randomUUID()+'@example.invalid']);
 await pool.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[fixture.user,fixture.workspace]);
 await insertPersonalToken(pool,{workspace_id:fixture.workspace,user_id:fixture.user,name:'Synthetic owner API',allowed_environments:['REAL'],expires_at:new Date(Date.now()+3600000).toISOString()},fixture.token);
 await pool.query("INSERT INTO integration_settings(workspace_id,environment,key,type,reference,label,version,enabled,config,updated_by) VALUES($1,'REAL',$2,'waha',$3,'Isolated fixture gateway',1,true,$4,$5)",[fixture.workspace,'waha:'+fixture.gateway,fixture.gateway,{base_url:'https://gateway.example.invalid/'+fixture.gateway},fixture.user]);
 const a=await putRecord(pool,{workspaceId:fixture.workspace,environment:'REAL',kind:'channel_account',body:{name:'Old synthetic number',provider:'waha',gateway_ref:fixture.gateway,engine:'GOWS',status:'FAILED',sending_enabled:false}});fixture.account=a.id;
 await pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,frozen,lease_expires_at) VALUES($1,$2,'fixture-channel-worker',true,now()-interval '1 minute')",[a.id,fixture.workspace]);
 await pool.query("INSERT INTO commands(id,workspace_id,environment,kind,resource_id,actor_id,payload,status,result,idempotency_key,updated_at) VALUES($1,$2,'REAL','channel_command',$3,$4,'{\"type\":\"connect\"}','FAILED','{\"error\":\"QR_OPERATION_NOT_AUTHORIZED\"}',$5,now()-interval '1 minute')",[fixture.command,fixture.workspace,a.id,fixture.user,randomUUID()]);
 await pool.query("UPDATE channel_sessions SET last_health_at=now(),health_expires_at=now()+interval '1 hour' WHERE account_id=$1",[a.id]);
 await pool.query("INSERT INTO operational_alerts(id,workspace_id,environment,account_id,dedupe_key,kind,severity,summary_code) VALUES($1,$2,'REAL',$3,$4,'PRIMARY_DUE_12','WARNING','FIXTURE')",[fixture.alert,fixture.workspace,a.id,randomUUID()]);
 await pool.query("INSERT INTO operation_authorizations(id,workspace_id,environment,actor_id,scope,config_hash,expires_at) VALUES($1,$2,'REAL',$3,$4,'synthetic',now()+interval '1 hour')",[fixture.authorization,fixture.workspace,fixture.user,{account_ids:[a.id]}]);
 for(const kind of ['conversation','order','message']){const record=await putRecord(pool,{workspaceId:fixture.workspace,environment:'REAL',kind,body:{account_id:a.id,source:'isolated-fixture'}});historyIds.push(record.id);}
 await appendEvent(pool,{workspace_id:fixture.workspace,environment:'REAL',aggregate_id:a.id,event_type:'fixture.history',payload:{synthetic:true}});
});
afterAll(async()=>{await pool?.end();await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`);await adminPool.end();});

async function runtime(role:string,program:string){
 const url=new URL(connection);url.searchParams.set('options','-c role='+role);
 const {stdout}=await execute(process.execPath,['--import','tsx','--input-type=module','-e',program],{env:{...process.env,DATABASE_URL:url.toString(),CHANNEL_ROLE_FIXTURE:JSON.stringify(fixture)},timeout:30000,maxBuffer:1024*1024});
 return JSON.parse(stdout.trim());
}
const apiPrelude=`
 import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {createApp} from './apps/api/src/app.ts';import {pool} from './packages/db/src/index.ts';
 const f=JSON.parse(process.env.CHANNEL_ROLE_FIXTURE),app=await createApp();
 async function call(method,path,body,status=200,key=randomUUID()){
  const r=await app.inject({method,url:path+'?environment=REAL',payload:body,headers:{authorization:'Bearer '+f.token,'idempotency-key':key}});
  assert.equal(r.statusCode,status,'HTTP status: '+r.statusCode+' '+(r.json().error?.code??''));return r.json().data;
 }
 const me=await call('GET','/v1/me');assert.equal(me.role,'owner');assert.equal(me.authentication_method,'personal_access_token');assert.equal(me.service,false);
 assert.equal((await pool.query('SELECT current_user role')).rows[0].role,'commerce_api');
 const path='/v1/channel-accounts/'+f.account;
`;

it('runs channel recovery, logout, deletion and gateway reuse through real restricted API/worker roles',async()=>{
 const recovery=await runtime('commerce_api',apiPrelude+`
  let s=await call('GET',path+'/session');const key=randomUUID();
  const body={expected_version:s.revision,action:'reconcile_command',command_id:f.command,outcome:'confirmed_not_applied',reason:'Synthetic pre-provider gate failure and fresh health verified'};
  await call('POST',path+'/session/recovery',{...body,expected_version:s.revision+1},409);
  await pool.query("UPDATE channel_sessions SET health_expires_at=now()-interval '1 second' WHERE account_id=$1",[f.account]);
  await call('POST',path+'/session/recovery',body,409);
  await pool.query("UPDATE channel_sessions SET last_health_at=now(),health_expires_at=now()+interval '1 hour' WHERE account_id=$1",[f.account]);
  s=await call('POST',path+'/session/recovery',body,200,key);
  assert.equal(s.uncertain_commands.length,0);
  assert.deepEqual(await call('POST',path+'/session/recovery',body,200,key),s);
  const c=await call('GET','/v1/commands/'+f.command);assert.equal(c.status,'FAILED');assert.equal(c.result.error,'QR_OPERATION_NOT_AUTHORIZED');assert.equal(c.result.reconciliation,'confirmed_not_applied');assert.equal(c.payload.type,'connect');
  s=await call('POST',path+'/session/recovery',{expected_version:s.revision,action:'acknowledge_alert',alert_id:f.alert,reason:'Synthetic acknowledgment'});
  s=await call('POST',path+'/session/recovery',{expected_version:s.revision,action:'open_incident',reason:'Synthetic operator recovery incident'});
  const cmd=await call('POST',path+'/commands',{type:'logout',reason:'Retire synthetic isolated channel'},202);
  await app.close();await pool.end();console.log(JSON.stringify({logoutCommand:cmd.id,reconciled:true}));
 `);expect(recovery.reconciled).toBe(true);
 const worker=await runtime('commerce_channel',`
  import {pool} from './packages/db/src/index.ts';import {processChannelCommands} from './apps/channel-worker/src/lifecycle.ts';import {SimulatorProvider} from './packages/messaging/src/index.ts';
  const f=JSON.parse(process.env.CHANNEL_ROLE_FIXTURE),actions=[];
  await processChannelCommands(10,()=>{const p=new SimulatorProvider();p.lifecycle=async action=>{actions.push(action);return{status:'STOPPED'}};return p;},'fixture-channel-worker');
  const role=(await pool.query('SELECT current_user role')).rows[0].role;
  const result=(await pool.query("SELECT status,result FROM commands WHERE workspace_id=$1 AND payload->>'type'='logout'",[f.workspace])).rows[0];
  await pool.end();console.log(JSON.stringify({role,actions,result}));
 `);expect(worker).toMatchObject({role:'commerce_channel',actions:['logout'],result:{status:'APPLIED',result:{status:'STOPPED'}}});
 const deleted=await runtime('commerce_api',apiPrelude+`
  const a=await call('GET',path);assert.equal(a.status,'STOPPED');assert.ok(a.unlinked_at);
  const key=randomUUID(),body={expected_version:a.version,confirmation:'DELETE_CHANNEL_ACCOUNT',reason:'Replace synthetic channel and preserve history'};
  const deletion=await call('DELETE',path,body,200,key);assert.equal(deletion.history_preserved,true);
  assert.deepEqual(await call('DELETE',path,body,200,key),deletion);
  const tombstone=await call('GET',path);assert.ok(tombstone.deleted_at);assert.equal(tombstone.sending_enabled,false);
  const inventory=await call('GET','/v1/channel-accounts');assert.equal(inventory.some(a=>a.id===f.account),false);
  await call('POST',path+'/commands',{type:'connect',reason:'Synthetic tombstone guard test'},410);
  await call('GET',path+'/qr',undefined,410);
  const created=await call('POST','/v1/channel-accounts',{name:'New synthetic number',provider:'waha',gateway_ref:f.gateway,engine:'GOWS',purpose:'',sending_enabled:false},201);
  const saved=await call('GET','/v1/channel-accounts/'+created.id),s=await call('GET','/v1/channel-accounts/'+created.id+'/session');
  assert.equal(saved.sending_enabled,false);assert.equal(saved.purpose,'');assert.equal(saved.status,'DISCONNECTED');
  const health=await call('GET','/v1/channel-accounts/'+created.id+'/health');assert.equal(health.reception.messages.received,0);assert.equal(health.reception.envelopes.received,0);assert.equal(health.reception.sending_enabled,false);
  assert.equal(s.operational_pause,true);assert.equal(s.recovery_enabled,false);assert.equal(s.desired_state,'STOPPED');
  assert.equal((await pool.query('SELECT count(*)::int n FROM commands WHERE resource_id=$1',[created.id])).rows[0].n,0);
  assert.equal(s.gateway_id.startsWith('unconfigured:'),false);
  assert.equal((await call('GET','/v1/outbox')).length,0);
  await app.close();await pool.end();console.log(JSON.stringify({deleted:true,newAccount:created.id}));
 `);expect(deleted.deleted).toBe(true);
 expect((await pool.query('SELECT id FROM records WHERE id=ANY($1::uuid[])',[historyIds])).rows).toHaveLength(historyIds.length);
 expect((await pool.query("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND event_type='fixture.history'",[fixture.workspace])).rows[0].n).toBe(1);
 expect((await pool.query('SELECT revoked_at FROM operation_authorizations WHERE id=$1',[fixture.authorization])).rows[0].revoked_at).toBeTruthy();
 expect((await pool.query('SELECT archived_at FROM channel_sessions WHERE account_id=$1',[fixture.account])).rows[0].archived_at).toBeTruthy();
 expect((await pool.query('SELECT acknowledged_at FROM operational_alerts WHERE id=$1',[fixture.alert])).rows[0].acknowledged_at).toBeTruthy();
 expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind='incident'",[fixture.workspace])).rows[0].n).toBe(1);
},90000);

it('imports encrypted history with the existing channel and automation roles',async()=>{
 const capture=await runtime('commerce_channel',`
  import {pool,putRecord,appendEvent,encrypt} from './packages/db/src/index.ts';
  const f=JSON.parse(process.env.CHANNEL_ROLE_FIXTURE);
  const a=await putRecord(pool,{workspaceId:f.workspace,environment:'REAL',kind:'channel_account',body:{name:'Synthetic history role fixture',provider:'waha',identity_fingerprint:'synthetic-identity',sending_enabled:false}});
  await appendEvent(pool,{workspace_id:f.workspace,environment:'REAL',event_type:'channel.history.observed',aggregate_id:a.id,payload:{identity_fingerprint:'synthetic-identity',messages_ciphertext:encrypt([{id:'synthetic-history-role',from:'12025550173@c.us',fromMe:false,timestamp:Math.floor(Date.now()/1000),body:'Synthetic historical text'}]),truncated:false}});
  await pool.end();console.log(JSON.stringify({captured:true}));
 `);expect(capture.captured).toBe(true);
 const imported=await runtime('commerce_automation',`
  import {pool} from './packages/db/src/index.ts';import {processInbound} from './apps/automation-worker/src/inbound.ts';
  const f=JSON.parse(process.env.CHANNEL_ROLE_FIXTURE);await processInbound(100);await processInbound(100);
  const messages=(await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind='message' AND body->>'source'='provider_history'",[f.workspace])).rows[0].n;
  const outbox=(await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[f.workspace])).rows[0].n;
  await pool.end();console.log(JSON.stringify({messages,outbox}));
 `);expect(imported).toEqual({messages:1,outbox:0});
});

it('does not grant API execution status, payload, ownership transfer, leases or history deletion',async()=>{
 const rows=(await pool.query("SELECT t,c,has_column_privilege('commerce_api',t,c,'UPDATE') allowed FROM (VALUES ('commands','status'),('commands','payload'),('session_ownership','owner_id'),('session_ownership','generation'),('session_ownership','lease_expires_at'),('operational_alerts','status')) v(t,c)")).rows;
 expect(rows.every(r=>!r.allowed)).toBe(true);
 for(const table of ['records','record_versions','domain_events','commands','session_ownership'])expect((await pool.query("SELECT has_table_privilege('commerce_api',$1,'DELETE') allowed",[table])).rows[0].allowed).toBe(false);
 const c=await pool.connect();try{await c.query('BEGIN');await c.query('SET LOCAL ROLE commerce_api');await expect(c.query("UPDATE commands SET status='APPLIED' WHERE id=$1",[fixture.command])).rejects.toThrow('permission denied');}finally{await c.query('ROLLBACK');c.release();}
});

it('inserts a new installer receipt only for the unchanged isolated ownership and audits it once',async()=>{
 const a=await putRecord(pool,{workspaceId:fixture.workspace,environment:'REAL',kind:'channel_account',body:{name:'Historical isolation fixture',provider:'waha',sending_enabled:false}});
 const source=randomUUID();
 const {stdout}=await execute('python3',['-c',`
import datetime as dt, hashlib, importlib.util, json, os, tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('attestation','scripts/ownership-isolation-receipts.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
f=json.loads(os.environ['ISOLATION_FIXTURE']);verified=dt.datetime.now(m.UTC)-dt.timedelta(days=2)
old={'id':'a'*64,'running':True,'project':'commerce-os','service':'channel-worker','restart':'unless-stopped','networks':['fixture']}
candidate={**f,'previous_owner_id':'historical-fixture','generation':1,'verified_at':verified.isoformat(),'consumed_at':None}
snapshot={'captured_at':(verified-dt.timedelta(seconds=10)).isoformat(),'containers':[old],'owners':[candidate.copy()]}
proof={'snapshot':snapshot,'verified_containers':{old['id']:None},'replacement_ids':['b'*64]}
digest=hashlib.sha256(json.dumps(proof,sort_keys=True,separators=(',',':')).encode()).hexdigest();candidate['evidence_sha256']=digest
queries=[]
def database(env,sql):
 queries.append(sql)
 return json.dumps([candidate]) if len(queries)==1 else '0'
m.database=database;m.inspect=lambda container:None
with tempfile.TemporaryDirectory() as directory:
 m.private_write(Path(directory)/'original.attested.json',{'proof':proof,'evidence_sha256':digest})
 m.reverify_expired('fixture',directory,[{**old,'id':'c'*64}])
 prepared=list(Path(directory).glob('reverified-*.json'))
 assert len(prepared)==1 and prepared[0].stat().st_mode & 0o777==0o600
print(json.dumps({'candidate':candidate,'selection':queries[0],'sql':queries[1]}))
 `],{env:{...process.env,ISOLATION_FIXTURE:JSON.stringify({id:source,account_id:a.id,workspace_id:fixture.workspace})}});
 const generated=JSON.parse(stdout),c=generated.candidate;
 await pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,frozen,lease_expires_at) VALUES($1,$2,$3,1,true,now()-interval '1 day')",[a.id,fixture.workspace,c.previous_owner_id]);
 await pool.query("INSERT INTO ownership_isolation_receipts(id,account_id,workspace_id,previous_owner_id,generation,method,evidence_sha256,verified_at) VALUES($1,$2,$3,$4,1,'container_stopped_and_access_revoked',$5,$6)",[source,a.id,fixture.workspace,c.previous_owner_id,c.evidence_sha256,c.verified_at]);
 expect((await pool.query(generated.selection)).rows[0].coalesce.some((r:{id:string})=>r.id===source)).toBe(true);
 for(const mutation of [
  "UPDATE session_ownership SET generation=generation+1 WHERE account_id=$1",
  "UPDATE session_ownership SET frozen=false WHERE account_id=$1",
  "UPDATE records SET version=version+1,body=body||jsonb_build_object('deleted_at',now()) WHERE id=$1::uuid",
  "UPDATE ownership_isolation_receipts SET consumed_at=now() WHERE account_id=$1::uuid",
 ]){
  const client=await pool.connect();try{await client.query('BEGIN');await client.query(mutation,[a.id]);expect(Number((await client.query(generated.sql)).rows[0].count)).toBe(0);}finally{await client.query('ROLLBACK');client.release();}
 }
 expect(Number((await pool.query(generated.sql)).rows[0].count)).toBe(1);
 expect(Number((await pool.query(generated.sql)).rows[0].count)).toBe(0);
 expect((await pool.query('SELECT count(*)::int n FROM ownership_isolation_receipts WHERE account_id=$1',[a.id])).rows[0].n).toBe(2);
 expect((await pool.query('SELECT consumed_at,evidence_sha256 FROM ownership_isolation_receipts WHERE id=$1',[source])).rows[0]).toEqual({consumed_at:null,evidence_sha256:c.evidence_sha256});
 expect((await pool.query("SELECT count(*)::int n FROM domain_events WHERE aggregate_id=$1 AND event_type='channel.isolation_reverified'",[a.id])).rows[0].n).toBe(1);
 expect((await pool.query("SELECT has_table_privilege('commerce_api','ownership_isolation_receipts','INSERT') allowed")).rows[0].allowed).toBe(false);
});
