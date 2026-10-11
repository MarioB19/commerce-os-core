import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {processNumberOperations} from '../../apps/channel-worker/src/number-operations.js';
import {pool} from '../../packages/db/src/index.js';
import {CAPACITY_READBACK_TTL_MS} from '../../packages/contracts/src/numbers.js';
import {roleExecutor} from '../support/database-role.js';

const workspace='capacity-simulation-clock-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!,withRole=roleExecutor(pool);
let app:Awaited<ReturnType<typeof createApp>>,cookie='';
const call=(method:any,path:string,body?:any,key=randomUUID())=>withRole('commerce_api',()=>app.inject({method,url:path+'?environment=SIMULATION',payload:body,headers:{origin,cookie,'idempotency-key':key}}));
const data=(response:any,status=200)=>{expect(response.statusCode,response.body).toBe(status);return response.json().data;};

beforeAll(async()=>{
 app=await createApp();const email=`capacity-simulation-${randomUUID()}@example.invalid`,password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Capacity simulation clock owner',email,password,workspace_id:workspace,role:'owner'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});expect(login.statusCode,login.body).toBe(200);
 cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(value=>String(value).split(';')[0]).join('; ');
});
afterAll(async()=>{await app.close();await pool.end();});

it('stamps simulated capacity readback with the virtual clock while REAL physical capacity remains unclaimed',async()=>{
 const virtualNow='2026-09-01T12:00:00.000Z';
 let clock=data(await call('POST','/v1/number-simulation',{action:'create',at:virtualNow}));expect(new Date(clock.virtual_now).toISOString()).toBe(virtualNow);
 const preview=data(await call('POST','/v1/number-capacity',{action:'preview',count:2,reason:'Verify bounded simulated capacity'}));
 const expanded=data(await call('POST','/v1/number-capacity',{action:'expand',count:2,review:preview.review,confirmation:'APPLY_REVIEWED_CAPACITY',reason:'Apply bounded simulated capacity'}),202);
 await withRole('commerce_channel',()=>processNumberOperations());
 expect(data(await call('GET','/v1/number-operations/'+expanded.operation_id)).state).toBe('SUCCEEDED');
 const capacity=data(await call('GET','/v1/number-capacity'));expect(capacity).toMatchObject({installed:2,physical_capacity_verified:null,metrics:{provisioned_verified:2,physical_capacity_measured:null}});
 expect(capacity.slots).toHaveLength(2);
 for(const slot of capacity.slots){
  expect(slot.readback).toMatchObject({verified:true,environment:'SIMULATION',adapter:'no-network',observed_at:virtualNow});
  expect(Date.parse(slot.readback.expires_at)-Date.parse(slot.readback.observed_at)).toBe(CAPACITY_READBACK_TTL_MS);
 }
 const created=await Promise.all([0,1].map(index=>call('POST','/v1/numbers',{alias:'Occupied simulation '+index,responsible:'Synthetic owner',device_ref:'Simulation device '+index}).then(response=>data(response,202))));
 await withRole('commerce_channel',()=>processNumberOperations());
 const occupiedBefore=data(await call('GET','/v1/number-capacity')).slots.filter((slot:any)=>slot.account_id);
 expect(occupiedBefore).toHaveLength(2);expect(occupiedBefore.map((slot:any)=>slot.account_id).sort()).toEqual(created.map(item=>item.id).sort());
 clock=data(await call('POST','/v1/number-simulation',{action:'advance',seconds:CAPACITY_READBACK_TTL_MS/1000+1,expected_version:clock.version}));
 const stale=data(await call('GET','/v1/number-capacity'));expect(stale).toMatchObject({installed:null,metrics:{verification_status:'STALE',readback_unverified:2}});
 const fullPreview=data(await call('POST','/v1/number-capacity',{action:'preview',count:20,reason:'Revalidate all bounded simulated slots'}));
 const fullExpansion=data(await call('POST','/v1/number-capacity',{action:'expand',count:20,review:fullPreview.review,confirmation:'APPLY_REVIEWED_CAPACITY',reason:'Revalidate all bounded simulated slots'}),202);
 await withRole('commerce_channel',()=>processNumberOperations());expect(data(await call('GET','/v1/number-operations/'+fullExpansion.operation_id)).state).toBe('SUCCEEDED');
 const refreshed=data(await call('GET','/v1/number-capacity'));expect(refreshed).toMatchObject({installed:20,metrics:{provisioned_verified:20,verification_status:'CURRENT',readback_unverified:0}});expect(refreshed.slots).toHaveLength(20);
 for(const before of occupiedBefore){const after=refreshed.slots.find((slot:any)=>slot.id===before.id);expect(after).toMatchObject({account_id:before.account_id,state:before.state,operation_id:before.operation_id,readback:{verified:true,observed_at:new Date(clock.virtual_now).toISOString()}});}
},60000);
