import {beforeAll,afterAll,it,expect} from 'vitest';
import {fixtureProfiles,retireRealAccountOn} from '../support/profile-fixture.js';
import {randomUUID,randomBytes} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord,withTransaction} from '../../packages/db/src/index.js';
import {saveIntegrationSetting} from '../../packages/db/src/integration-settings.js';
import {processNumberOperations} from '../../apps/channel-worker/src/number-operations.js';
import {retireLegacyNumber,issueServiceToken} from '../support/channel-commands.js';
import {attachCapacityOperationSlots} from '../../apps/api/src/number-capacity-lifecycle.js';
import {roleExecutor} from '../support/database-role.js';
const withRole=roleExecutor(pool),workspace='capacity-lifecycle-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
// V7 F2: fixture workspaces are adopted profiles (max three per installation).
beforeAll(()=>fixtureProfiles(workspace));
let app:Awaited<ReturnType<typeof createApp>>,cookie:string,agent:string;
const call=(method:any,path:string,body?:any,token?:string,key=randomUUID(),environment='REAL')=>withRole('commerce_api',()=>app.inject({method,url:path+'?environment='+environment,payload:body,headers:{origin,...(token?{authorization:'Bearer '+token}:{cookie}),'idempotency-key':key}}));
const data=(r:any,status=200)=>{expect(r.statusCode,r.body).toBe(status);return r.json().data;};
beforeAll(async()=>{app=await createApp();const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');await provisionUser({name:'Isolated lifecycle fixture',email,password,workspace_id:workspace,role:'owner'});const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');agent=await issueServiceToken(workspace,'Synthetic capacity actor',['channels:read','channels:capacity:agent']);});
afterAll(async()=>{
 try {
  // These API fixtures commit across requests. Retire only their own physical
  // mappings and release their synthetic host inventory before the next file.
  await withTransaction(async c=>{
   const outside=async()=>Promise.all(['records','channel_sessions','number_capacity_slots','number_operations'].map(async table=>(await c.query(`SELECT count(*)::int count,md5(COALESCE(string_agg(to_jsonb(item)::text,'' ORDER BY id),'')) checksum FROM ${table} item WHERE workspace_id<>$1${table==='records'?" AND kind='channel_account'":''}`,[workspace])).rows[0]));
   const previous=await outside();
   const accounts=(await c.query("SELECT * FROM records WHERE workspace_id=$1 AND kind='channel_account' AND NOT body?'deleted_at'",[workspace])).rows;
   // V7 F2: a REAL number retires only through the quota-safe sequence.
   for(const account of accounts)if(account.environment==='REAL')await retireRealAccountOn(c,workspace,account.id);else await putRecord(c,{id:account.id,version:account.version,workspaceId:workspace,environment:account.environment,kind:'channel_account',body:{...account.body,deleted_at:new Date().toISOString()}});
   await c.query('DELETE FROM number_capacity_slots WHERE workspace_id=$1',[workspace]);
   await c.query("UPDATE number_operations SET state='CANCELLED',lease_owner=NULL,lease_until=NULL,version=version+1 WHERE workspace_id=$1 AND state NOT IN('SUCCEEDED','FAILED','CANCELLED')",[workspace]);
   expect((await c.query("SELECT (SELECT count(*) FROM records WHERE workspace_id=$1 AND kind='channel_account' AND NOT body?'deleted_at')::int accounts,(SELECT count(*) FROM channel_sessions WHERE workspace_id=$1 AND archived_at IS NULL)::int sessions,(SELECT count(*) FROM number_capacity_slots WHERE workspace_id=$1)::int slots,(SELECT count(*) FROM number_operations WHERE workspace_id=$1 AND state NOT IN('SUCCEEDED','FAILED','CANCELLED'))::int jobs",[workspace])).rows[0]).toEqual({accounts:0,sessions:0,slots:0,jobs:0});
   expect(await outside()).toEqual(previous);
  });
 } finally {await app.close();await pool.end();}
});
const freePhysicalSlot=async()=>(await pool.query(`SELECT n FROM generate_series(1,20) n WHERE
 NOT EXISTS(SELECT 1 FROM number_capacity_slots WHERE environment='REAL' AND slot=n)
 AND NOT EXISTS(SELECT 1 FROM channel_sessions WHERE environment='REAL' AND archived_at IS NULL AND gateway_id='http://waha-'||lpad(n::text,2,'0')||':3000')
 AND NOT EXISTS(SELECT 1 FROM records WHERE environment='REAL' AND kind='channel_account' AND NOT body?'deleted_at' AND body->>'gateway_ref'='waha-'||lpad(n::text,2,'0'))
 ORDER BY n LIMIT 1`)).rows[0].n;
// V7 F8-D: operations are read from the database (the V5 read route was retired).
const operation=async(id:string)=>(await pool.query('SELECT * FROM number_operations WHERE id=$1',[id])).rows[0];
const slotFor=async(id:string)=>(await pool.query('SELECT * FROM number_capacity_slots WHERE account_id=$1',[id])).rows[0];
const binding=async(slot:any,action:string)=>{const a=(await pool.query('SELECT version FROM records WHERE id=$1',[slot.account_id])).rows[0],session=(await pool.query('SELECT revision FROM channel_sessions WHERE account_id=$1 AND archived_at IS NULL',[slot.account_id])).rows[0];return{action,slot_id:slot.id,account_id:slot.account_id,expected_version:slot.version,expected_account_version:a.version,expected_session_version:session?.revision??null,reason:'Isolated contract fixture'};};

it('provisions the preserved account, explicitly releases a retired drain and reuses its physical receipt without opening REAL',async()=>{
 const n=await freePhysicalSlot();
 const reference='waha-'+String(n).padStart(2,'0'),profileRef='preserved-legacy-alias';
 const account=await withTransaction(async c=>{const row=await putRecord(c,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Preserved migration fixture',provider:'waha',gateway_ref:profileRef,status:'NEW',sending_enabled:false,identity_verified:false}});await saveIntegrationSetting(c,workspace,'REAL','waha:'+profileRef,{expected_version:0,label:'Quarantined fixture',enabled:false,config:{base_url:'http://'+reference+':3000'},secrets:{api_key:'synthetic-api-key',webhook_secret:'synthetic-hook'},clear_secrets:[],reason:'Synthetic disabled profile'},'fixture');return row;});
 const session=(await pool.query('SELECT * FROM channel_sessions WHERE account_id=$1',[account.id])).rows[0];
 data(await call('POST','/v1/number-capacity/reconciliation/adopt-legacy',{items:[{account_id:account.id,slot:n,expected_account_version:account.version,expected_session_version:session.revision}],confirmation:'ADOPT_RECONCILED_LEGACY_SLOTS',reason:'Synthetic existing binding'}),201);
 const originalProfile=(await pool.query('SELECT * FROM integration_settings WHERE workspace_id=$1',[workspace])).rows;
 const policy=data(await call('GET','/v1/settings/operations'));
 let slot=await slotFor(account.id);const body=await binding(slot,'provision_existing'),key=randomUUID();
 expect((await call('POST','/v1/number-capacity',{...body,expected_version:slot.version+1})).statusCode).toBe(409);
 const provision=data(await call('POST','/v1/number-capacity',body,undefined,key),202);
 expect(data(await call('POST','/v1/number-capacity',body,undefined,key),202)).toEqual(provision);
 expect((await pool.query('SELECT body,version FROM records WHERE id=$1',[account.id])).rows[0]).toEqual({body:account.body,version:account.version});
 expect((await pool.query('SELECT * FROM channel_sessions WHERE account_id=$1',[account.id])).rows[0]).toEqual(session);
 let job=(await operation(provision.operation_id));
 const readback={slot:n,running:true,session_count:0,connected_sessions:0,image_digest:'sha256:'+'a'.repeat(64),network_present:true,volumes_preserved:true};
 data(await call('POST','/v1/number-capacity/inventory',{observed_at:new Date().toISOString(),slots:[readback]},agent));
 let claim=data(await call('POST','/v1/number-capacity/administration/'+job.id,{action:'claim',expected_version:job.version,reason:'Synthetic administration claim'},agent));
 data(await call('POST','/v1/number-capacity/administration/'+job.id,{action:'complete',expected_version:claim.version,outcome:'VERIFIED',overlay_sha:'b'.repeat(64),slots:[readback],reason:'Synthetic physical receipt contract'},agent));
 // A number retired before V7 keeps its slot until the platform drains it.
 await retireLegacyNumber(workspace,account.id);
 slot=await slotFor(account.id);
 expect((await call('POST','/v1/number-capacity',await binding(slot,'release'))).statusCode).toBe(409);
 const drain=data(await call('POST','/v1/number-capacity',{action:'drain',slot_id:slot.id,expected_version:slot.version,reason:'Explicit fixture drain'}),202);
 job=(await operation(drain.operation_id));
 claim=data(await call('POST','/v1/number-capacity/administration/'+job.id,{action:'claim',expected_version:job.version,reason:'Drain retired fixture'},agent));
 const completion={action:'complete',expected_version:claim.version,outcome:'VERIFIED',overlay_sha:'c'.repeat(64),slots:[readback],reason:'No sessions in synthetic readback'};
 expect((await call('POST','/v1/number-capacity/administration/'+job.id,{...completion,slots:[{...readback,session_count:1}]},agent)).statusCode).toBe(409);
 data(await call('POST','/v1/number-capacity/administration/'+job.id,completion,agent));
 slot=await slotFor(account.id);expect(slot.state).toBe('DRAINING');expect(slot.account_id).toBe(account.id);expect(slot.readback.overlay_sha).toBe('b'.repeat(64));
 const releaseBody=await binding(slot,'release'),releaseKey=randomUUID();
 const released=data(await call('POST','/v1/number-capacity',releaseBody,undefined,releaseKey));
 expect(released).toMatchObject({state:'PREPARED',account_id:null,history_preserved:true});
 expect(data(await call('POST','/v1/number-capacity',releaseBody,undefined,releaseKey))).toEqual(released);
 // Exercise the same route helper with a stale released slot, without claiming foreign tenant slots below n.
 const refresh=await withTransaction(async c=>{
  await c.query("UPDATE number_capacity_slots SET readback=readback||$2::jsonb WHERE id=$1",[slot.id,{observed_at:'2000-01-01T00:00:00.000Z'}]);
  const op=(await c.query("INSERT INTO number_operations(workspace_id,environment,actor_id,action,input) VALUES($1,'REAL','fixture','EXPAND',$2) RETURNING *",[workspace,{apply:false,effective_target:n}])).rows[0];
  expect(await attachCapacityOperationSlots(c,workspace,'REAL',op.id,[n])).toEqual([slot.id]);
  return op;
 });
 expect((await pool.query('SELECT operation_id FROM number_capacity_slots WHERE id=$1',[slot.id])).rows[0].operation_id).toBe(provision.operation_id);
 expect((await operation(refresh.id)).input.slot_ids).toEqual([slot.id]);
 await withRole('commerce_channel',()=>processNumberOperations());
 expect((await operation(refresh.id)).state).toBe('SUCCEEDED');
 const added=data(await call('POST','/v1/numbers/quick',{alias:'Replacement synthetic account',country:'MX'}),202);
 const reused=await slotFor(added.id);expect(reused.id).toBe(slot.id);expect(reused.operation_id).toBe(provision.operation_id);expect(added.operation_id).not.toBe(provision.operation_id);
 expect((await call('POST','/v1/number-capacity',{action:'prepare',count:n,reason:'Must not hide new pending operation'})).statusCode).toBe(409);
 await withRole('commerce_channel',()=>processNumberOperations());
 expect((await operation(added.operation_id))).toMatchObject({state:'HUMAN_ACTION_REQUIRED',result:{next_action:'APPLY_REVIEWED_CAPACITY'}});
 expect((await pool.query('SELECT * FROM integration_settings WHERE workspace_id=$1',[workspace])).rows).toEqual(originalProfile);
 expect(data(await call('GET','/v1/settings/operations'))).toEqual(policy);
 expect((await pool.query('SELECT body FROM records WHERE id=$1',[account.id])).rows[0].body.deleted_at).toBeTruthy();
 expect((await pool.query('SELECT count(*)::int n FROM commands WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
 expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
});

it('rejects existing provisioning with stale session, pending commands and uncertain remote result',async()=>{
 const n=await freePhysicalSlot(),reference='waha-'+String(n).padStart(2,'0');
 const account=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Unsafe fixture',provider:'waha',gateway_ref:reference,status:'NEW',sending_enabled:false}});
 const slot=(await pool.query("INSERT INTO number_capacity_slots(workspace_id,environment,slot,account_id,gateway_ref) VALUES($1,'REAL',$2,$3,$4) RETURNING *",[workspace,n,account.id,reference])).rows[0];
 const body=await binding(slot,'provision_existing');
 expect((await call('POST','/v1/number-capacity',{...body,expected_session_version:999})).statusCode).toBe(409);
 const command=(await pool.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key) VALUES($1,'REAL','channel_command',$2,'fixture',$3,$4) RETURNING id",[workspace,account.id,{type:'logout'},randomUUID()])).rows[0];
 expect((await call('POST','/v1/number-capacity',body)).json().error.code).toBe('RECONCILIATION_REQUIRED');
 await pool.query("UPDATE commands SET status='FAILED',result=$2 WHERE id=$1",[command.id,{remote_outcome:'UNKNOWN'}]);
 expect((await call('POST','/v1/number-capacity',body)).json().error.code).toBe('RECONCILIATION_REQUIRED');
 expect((await pool.query('SELECT count(*)::int n FROM number_operations WHERE input->>\'account_id\'=$1',[account.id])).rows[0].n).toBe(0);
});

it('requires retirement and fresh drain evidence before releasing a simulated reservation',async()=>{
 const sim=(method:any,path:string,body?:any)=>call(method,path,body,undefined,randomUUID(),'SIMULATION');
 const created=data(await sim('POST','/v1/numbers/quick',{alias:'Simulation recycling fixture',country:'MX'}),202);
 await withRole('commerce_channel',()=>processNumberOperations());
 expect((await operation(created.operation_id)).state).toBe('SUCCEEDED');
 let slot=await slotFor(created.id);
 expect((await sim('POST','/v1/number-capacity',await binding(slot,'release'))).json().error.code).toBe('RETIRE_ACCOUNT_BEFORE_RELEASE');
 await retireLegacyNumber(workspace,created.id);
 const drain=data(await sim('POST','/v1/number-capacity',{action:'drain',slot_id:slot.id,expected_version:slot.version,reason:'Drain isolated simulator fixture'}),202);
 await withRole('commerce_channel',()=>processNumberOperations());
 expect((await operation(drain.operation_id)).state).toBe('SUCCEEDED');
 slot=await slotFor(created.id);const fresh=slot.readback;
 await pool.query("UPDATE number_capacity_slots SET readback=readback||$2::jsonb WHERE id=$1",[slot.id,{expires_at:'2000-01-01T00:00:00.000Z'}]);
 expect((await sim('POST','/v1/number-capacity',await binding(slot,'release'))).json().error.code).toBe('FRESH_DRAIN_READBACK_REQUIRED');
 await pool.query('UPDATE number_capacity_slots SET readback=$2 WHERE id=$1',[slot.id,fresh]);
 data(await sim('POST','/v1/number-capacity',await binding(slot,'release')));
 const replacement=data(await sim('POST','/v1/numbers/quick',{alias:'Simulation replacement fixture',country:'MX'}),202);
 expect((await slotFor(replacement.id)).id).toBe(slot.id);
 await withRole('commerce_channel',()=>processNumberOperations());
 expect((await operation(replacement.operation_id)).state).toBe('SUCCEEDED');
 expect((await pool.query('SELECT body FROM records WHERE id=$1',[created.id])).rows[0].body.deleted_at).toBeTruthy();
});

it('allocates physical slot numbers globally: a profile never previews a number another profile holds (V7 F3)',async()=>{
 const other='capacity-foreign-'+randomUUID();await fixtureProfiles(workspace,other);
 const n=await freePhysicalSlot();
 const foreign=(await pool.query("INSERT INTO number_capacity_slots(workspace_id,environment,slot,gateway_ref) VALUES($1,'REAL',$2,$3) RETURNING id",[other,n,'waha-'+String(n).padStart(2,'0')])).rows[0];
 try{
  const own=(await pool.query("SELECT count(*)::int n FROM number_capacity_slots WHERE workspace_id=$1 AND environment='REAL'",[workspace])).rows[0].n;
  const preview=data(await call('POST','/v1/number-capacity',{action:'preview',count:own+1,reason:'Global allocation fixture'}));
  expect(preview.slot_numbers).toHaveLength(own+1);
  expect(preview.slot_numbers).not.toContain(n);
  expect(preview.legacy_host_conflict).toBe(false);
  expect((await pool.query("SELECT count(*)::int n FROM number_capacity_slots WHERE workspace_id=$1",[other])).rows[0].n).toBe(1);
 }finally{await pool.query('DELETE FROM number_capacity_slots WHERE id=$1',[foreign.id]);}
});
