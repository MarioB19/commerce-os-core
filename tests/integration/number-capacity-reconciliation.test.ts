import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord,withTransaction} from '../../packages/db/src/index.js';
import {saveIntegrationSetting} from '../../packages/db/src/integration-settings.js';
import {roleExecutor} from '../support/database-role.js';

const workspace='capacity-reconcile-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!,withRole=roleExecutor(pool);
let app:Awaited<ReturnType<typeof createApp>>,cookie='',fixtureAccountId:string|undefined;
const call=(method:any,path:string,body?:any,key=randomUUID())=>withRole('commerce_api',()=>app.inject({method,url:path+'?environment=REAL',payload:body,headers:{origin,cookie,'idempotency-key':key}}));
const data=(response:any,status=200)=>{expect(response.statusCode,response.body).toBe(status);return response.json().data;};

beforeAll(async()=>{
 app=await createApp();const email=`capacity-reconcile-${randomUUID()}@example.invalid`,password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Capacity reconciliation owner',email,password,workspace_id:workspace,role:'owner'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});expect(login.statusCode).toBe(200);cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(value=>String(value).split(';')[0]).join('; ');
});
afterAll(async()=>{
 try {
  if(fixtureAccountId){
   const account=data(await call('GET','/v1/channel-accounts/'+fixtureAccountId));
   data(await call('DELETE','/v1/channel-accounts/'+fixtureAccountId,{expected_version:account.version,confirmation:'DELETE_CHANNEL_ACCOUNT',reason:'Retire isolated reconciliation fixture'}));
  }
 } finally {await app.close();await pool.end();}
});

it('adopts an exact legacy gateway idempotently and uses its inventory as preview floor',async()=>{
 const slot=Number((await pool.query(`SELECT n FROM generate_series(1,20) n WHERE
  NOT EXISTS(SELECT 1 FROM number_capacity_slots WHERE environment='REAL' AND slot=n)
  AND NOT EXISTS(SELECT 1 FROM channel_sessions WHERE environment='REAL' AND archived_at IS NULL AND gateway_id='http://waha-'||lpad(n::text,2,'0')||':3000')
  ORDER BY n LIMIT 1`)).rows[0].n),alias='legacy-adopt-'+randomUUID().slice(0,8);
 const account=await withTransaction(async c=>{
  const created=await putRecord(c,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Legacy reconciliation fixture',provider:'waha',gateway_ref:alias,status:'DISCONNECTED',sending_enabled:false}});
  await saveIntegrationSetting(c,workspace,'REAL','waha:'+alias,{expected_version:0,label:'Observed legacy gateway',enabled:true,config:{base_url:`http://waha-${String(slot).padStart(2,'0')}:3000`},secrets:{api_key:randomBytes(24).toString('base64url'),webhook_secret:randomBytes(24).toString('base64url')},clear_secrets:[],reason:'Isolated reconciliation fixture'},'fixture');return created;
 });
 fixtureAccountId=account.id;
 const session=(await pool.query('SELECT revision FROM channel_sessions WHERE account_id=$1',[account.id])).rows[0];
 const reconciliation=data(await call('GET','/v1/number-capacity/reconciliation')),legacy=reconciliation.items.find((item:any)=>item.code==='LEGACY_SLOT_UNREGISTERED'&&item.account_id===account.id);
 expect(legacy).toMatchObject({slot,account_version:account.version,session_version:session.revision,adoptable:true,next_action:'ADOPT_LEGACY_SLOT'});
 const body={items:[{account_id:account.id,slot,expected_account_version:account.version,expected_session_version:session.revision}],confirmation:'ADOPT_RECONCILED_LEGACY_SLOTS',reason:'Adopt exact observed legacy gateway'},key=randomUUID();
 const adopted=data(await call('POST','/v1/number-capacity/reconciliation/adopt-legacy',body,key),201);expect(adopted).toMatchObject({external_effects:false,next_action:'READ_CAPACITY'});expect(adopted.adopted).toHaveLength(1);expect(adopted.adopted[0]).toMatchObject({slot,account_id:account.id,state:'RESERVED',readback:{verified:false,source:'legacy_gateway_reconciliation'}});
 expect(data(await call('POST','/v1/number-capacity/reconciliation/adopt-legacy',body,key),201)).toEqual(adopted);
 const capacity=data(await call('GET','/v1/number-capacity'));expect(capacity).toMatchObject({installed:null,reserved:1,canonical_reserved:1,legacy_reserved:0,available:null});
 const preview=data(await call('POST','/v1/number-capacity',{action:'preview',reason:'Read current reconciled inventory'}));expect(preview).toMatchObject({requested_target:null,target:slot,inventory_floor:slot,target_adjusted_to_inventory:false});
 expect((await pool.query("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND event_type='number.capacity.legacy_adopted'",[workspace])).rows[0].n).toBe(1);
 const mismatchedSlot=slot===20?19:slot+1;await pool.query("UPDATE channel_sessions SET gateway_id='http://waha-'||lpad($2::text,2,'0')||':3000',revision=revision+1 WHERE account_id=$1",[account.id,mismatchedSlot]);
 const mismatch=data(await call('GET','/v1/number-capacity/reconciliation')).items.find((item:any)=>item.code==='GATEWAY_SLOT_MISMATCH'&&item.account_id===account.id);expect(mismatch).toMatchObject({canonical_slot:slot,session_gateway_slot:mismatchedSlot});
 const blocked=await call('POST','/v1/numbers',{alias:'Must not reuse physical slot',responsible:'Synthetic owner',device_ref:'Blocked by mismatch'});expect(blocked.statusCode,blocked.body).toBe(409);expect(blocked.json().error.code).toBe('GATEWAY_SLOT_MISMATCH');
},60000);
