import {beforeAll,afterAll,it,expect} from 'vitest';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {randomUUID,randomBytes} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord,withTransaction,getRecord,hash} from '../../packages/db/src/index.js';
import {saveIntegrationSetting} from '../../packages/db/src/integration-settings.js';
import {processNumberOperations} from '../../apps/channel-worker/src/number-operations.js';
import {roleExecutor} from '../support/database-role.js';
const withRole=roleExecutor(pool),workspace='capacity-contract-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
// V7 F2: fixture workspaces are adopted profiles (max three per installation).
beforeAll(()=>fixtureProfiles(workspace));
const createdIds:string[]=[];
let app:Awaited<ReturnType<typeof createApp>>,cookie:string;
const call=(method:any,path:string,body?:any,token?:string,key=randomUUID())=>withRole('commerce_api',()=>app.inject({method,url:path+'?environment=REAL',payload:body,headers:{origin,...(token?{authorization:'Bearer '+token}:{cookie}),'idempotency-key':key}}));
const data=(r:any,status=200)=>{expect(r.statusCode,r.body).toBe(status);return r.json().data;};
beforeAll(async()=>{app=await createApp();const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');await provisionUser({name:'Isolated capacity fixture',email,password,workspace_id:workspace,role:'owner'});const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');});
afterAll(async()=>{await app.close();await pool.end();});
// V7 F8-D: operations are read from the database and service tokens are
// issued as fixtures; the V5 /v1/number-operations and token creation routes
// were retired. The capacity agent contract itself is unchanged.
const operation=async(id:string)=>(await pool.query('SELECT * FROM number_operations WHERE id=$1',[id])).rows[0];
async function serviceToken(name:string,scopes:string[]){const token=randomBytes(24).toString('hex');await pool.query("INSERT INTO service_tokens(workspace_id,actor_id,name,token_hash,scopes,allowed_environments,expires_at) VALUES($1,'capacity-fixture',$2,$3,$4,'[\"REAL\"]',now()+interval '1 hour')",[workspace,name,hash(token),JSON.stringify(scopes)]);return token;}
it('reserves concurrent distinct slots and creates only the reviewed initial integration without changing existing operational policy',async()=>{
 // An earlier account can occupy a physical gateway under a different profile alias.
 const legacySlot=(await pool.query(`SELECT n FROM generate_series(1,20) n WHERE
 NOT EXISTS(SELECT 1 FROM channel_sessions WHERE environment='REAL' AND archived_at IS NULL AND gateway_id='http://waha-'||lpad(n::text,2,'0')||':3000')
 AND NOT EXISTS(SELECT 1 FROM records WHERE environment='REAL' AND kind='channel_account' AND NOT body?'deleted_at' AND body->>'gateway_ref'='waha-'||lpad(n::text,2,'0'))
 AND NOT EXISTS(SELECT 1 FROM number_capacity_slots WHERE environment='REAL' AND slot=n)
 ORDER BY n LIMIT 1`)).rows[0].n;
 const legacy=await withTransaction(async c=>{const a=await putRecord(c,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Preserved legacy fixture',provider:'waha',gateway_ref:'previous-alias',status:'DISCONNECTED',sending_enabled:false}});
  await saveIntegrationSetting(c,workspace,'REAL','waha:previous-alias',{expected_version:0,label:'Previous gateway fixture',enabled:true,config:{base_url:'http://waha-'+String(legacySlot).padStart(2,'0')+':3000'},secrets:{api_key:randomBytes(24).toString('base64url'),webhook_secret:randomBytes(24).toString('base64url')},clear_secrets:[],reason:'Explicit isolated legacy reservation fixture'},'fixture');return a;});
 createdIds.push(legacy.id);
 const legacySession=(await pool.query('SELECT * FROM channel_sessions WHERE account_id=$1',[legacy.id])).rows[0];
 const preview=data(await call('POST','/v1/number-capacity',{action:'preview',count:20,reason:'Preserve earlier physical allocation'}));
 expect(preview.preserved_legacy_slots).toContain(legacySlot);expect(preview.additional_slots).toBe(19);
 const created=await Promise.all([0,1].map(i=>call('POST','/v1/numbers/quick',{alias:'Capacity fixture '+i,country:'MX'}).then(r=>data(r,202))));
 createdIds.push(...created.map(a=>a.id));
 const capacity=data(await call('GET','/v1/number-capacity'));expect(capacity.reserved).toBe(3);expect(capacity.metrics.reserved).toBe(3);expect(capacity.canonical_reserved).toBe(2);expect(capacity.legacy_reserved).toBe(1);expect(new Set(capacity.slots.map((s:any)=>s.slot)).size).toBe(2);expect(capacity.topology).toHaveLength(3);expect(capacity.slots.every((s:any)=>s.slot!==legacySlot)).toBe(true);
 const pending=await call('POST','/v1/number-capacity',{action:'prepare',count:5,reason:'Must preserve pending operations'});expect(pending.statusCode).toBe(409);
 await withRole('commerce_channel',()=>processNumberOperations());const job=await operation(created[0].operation_id);expect(job.state).toBe('HUMAN_ACTION_REQUIRED');
 const readOnly=await serviceToken('Test read only',['channels:read']);
 const denied=await call('POST','/v1/number-capacity/inventory',{observed_at:new Date().toISOString(),slots:[]},readOnly);expect(denied.statusCode).toBe(403);
 const agent=await serviceToken('Isolated actuator fixture',['channels:read','channels:capacity:agent','integrations:read','integrations:write']);
 const slot=capacity.slots.find((s:any)=>s.account_id===created[0].id),readback={slot:slot.slot,running:true,session_count:0,connected_sessions:0,image_digest:'sha256:'+'a'.repeat(64),network_present:true,volumes_preserved:true};
 // Explicit synthetic host-readback fixture exercises the contract; this is not physical evidence.
 data(await call('POST','/v1/number-capacity/inventory',{observed_at:new Date().toISOString(),slots:[readback]},agent));
 const claim=data(await call('POST','/v1/number-capacity/administration/'+job.id,{action:'claim',expected_version:job.version,reason:'Contract fixture claim'},agent));
 const before=data(await call('GET','/v1/settings/operations'));
 const reference='waha-'+String(slot.slot).padStart(2,'0'),patch={expected_version:0,capacity_operation_id:job.id,label:'Isolated fixture gateway',enabled:true,config:{base_url:'http://'+reference+':3000'},secrets:{api_key:randomBytes(24).toString('base64url'),webhook_secret:randomBytes(24).toString('base64url')},reason:'Initial integration bound to reviewed fixture'};
 const saved=data(await call('PUT','/v1/settings/integrations/waha:'+reference,patch,agent));expect(saved.operation_review_required).toBe(false);expect(saved.operational_revision).toBe(before.version);
 const after=data(await call('GET','/v1/settings/operations'));expect(after).toEqual(before);
 const replay=await call('PUT','/v1/settings/integrations/waha:'+reference,{...patch,expected_version:saved.version},agent);expect(replay.statusCode).toBe(409);
 data(await call('POST','/v1/number-capacity/administration/'+job.id,{action:'complete',expected_version:claim.version,outcome:'VERIFIED',overlay_sha:'b'.repeat(64),slots:[readback],reason:'Synthetic readback contract only'},agent));
 expect((await operation(job.id)).state).toBe('SUCCEEDED');
 const secondSlot=capacity.slots.find((s:any)=>s.account_id===created[1].id),secondReadback={...readback,slot:secondSlot.slot};
 data(await call('POST','/v1/number-capacity/inventory',{observed_at:new Date().toISOString(),slots:[secondReadback]},agent));
 const secondJob=await operation(created[1].operation_id);
 const secondClaim=data(await call('POST','/v1/number-capacity/administration/'+secondJob.id,{action:'claim',expected_version:secondJob.version,reason:'Second actor recovery fixture'},agent));
 const replacement=await serviceToken('Replacement session fixture',['channels:read','channels:capacity:agent','integrations:read','integrations:write']);
 expect((await call('POST','/v1/number-capacity/administration/'+secondJob.id,{action:'complete',expected_version:secondClaim.version,outcome:'VERIFIED',overlay_sha:'b'.repeat(64),slots:[secondReadback],reason:'Cannot steal a live claim'},replacement)).statusCode).toBe(409);
 const uncertain=data(await call('POST','/v1/number-capacity/administration/'+secondJob.id,{action:'complete',expected_version:secondClaim.version,outcome:'UNKNOWN',reason:'Synthetic lost response'},agent));
 const secondRef='waha-'+String(secondSlot.slot).padStart(2,'0');
 data(await call('PUT','/v1/settings/integrations/waha:'+secondRef,{...patch,capacity_operation_id:secondJob.id,config:{base_url:'http://'+secondRef+':3000'}},replacement));
 data(await call('POST','/v1/number-capacity/administration/'+secondJob.id,{action:'reconcile',expected_version:uncertain.version,outcome:'VERIFIED',overlay_sha:'b'.repeat(64),slots:[secondReadback],reason:'Existing resources read back by a new authorized session'},replacement));
 expect((await operation(secondJob.id)).state).toBe('SUCCEEDED');
 const account=(await getRecord(pool,workspace,'channel_account',created[0].id))!.body;expect(account.sending_enabled).toBe(false);expect(account.identity_verified).toBe(false);
 expect((await pool.query('SELECT body,version FROM records WHERE id=$1',[legacy.id])).rows[0]).toEqual({body:legacy.body,version:legacy.version});
 expect((await pool.query('SELECT * FROM channel_sessions WHERE account_id=$1',[legacy.id])).rows[0]).toEqual(legacySession);
 expect((await pool.query('SELECT count(*)::int n FROM commands WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
},60000);
