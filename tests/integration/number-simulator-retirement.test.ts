import {afterAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {getRecord,pool} from '../../packages/db/src/index.js';
import {processNumberOperations} from '../../apps/channel-worker/src/number-operations.js';
import {processChannelCommands,recordHealth} from '../../apps/channel-worker/src/lifecycle.js';
import {providerFor} from '../../apps/channel-worker/src/providers.js';

afterAll(()=>pool.end());
it.each(['disconnect','logout'] as const)('retires after canonical %s and subsequent provider health without racing the reader',async type=>{
 const workspace='sim-retire-'+randomUUID(),app=await createApp(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Synthetic lifecycle owner',email,password,workspace_id:workspace,role:'owner'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin},payload:{email,password}});expect(login.statusCode).toBe(200);
 const cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');
 const call=async(method:any,url:string,body?:any,status=200,key=randomUUID())=>{const result=await app.inject({method,url:url+'?environment=SIMULATION',headers:{cookie,origin,'idempotency-key':key},payload:body});expect(result.statusCode,result.body).toBe(status);return status>=400?result.json().error:result.json().data;};
 try{
  const created=await call('POST','/v1/numbers',{alias:'Synthetic lifecycle number',responsible:'Synthetic owner',device_ref:'Synthetic device'},202);
  await processNumberOperations('sim-retirement-fixture',providerFor);
  expect((await call('GET','/v1/number-operations/'+created.operation_id)).state).toBe('SUCCEEDED');
  const command=async(action:string)=>{const a=await call('GET','/v1/numbers/'+created.id);const cmd=await call('POST','/v1/channel-accounts/'+created.id+'/commands',{type:action,expected_version:a.version,reason:'Isolated simulator lifecycle regression'},202);await processChannelCommands(20,providerFor);expect((await call('GET','/v1/commands/'+cmd.id)).status).toBe('APPLIED');};
  await command('connect');await command(type);
  let record=(await getRecord(pool,workspace,'channel_account',created.id))!;expect(record.body.status).toBe('STOPPED');
  // Force the exact periodic read after the lifecycle result, with a new adapter.
  // No business state or delivery evidence is inserted by the test.
  await new Promise(resolve=>setTimeout(resolve,5));await recordHealth(record,providerFor);
  record=(await getRecord(pool,workspace,'channel_account',created.id))!;expect(record.body.status).toBe('STOPPED');
  const session=await call('GET','/v1/channel-accounts/'+created.id+'/session');expect(session.stored_observed_state).toBe('STOPPED');expect(session.desired_state).toBe('STOPPED');expect(session.operational_pause).toBe(true);expect(session.ownership.frozen).toBe(true);expect(session.uncertain_commands).toEqual([]);
  const args={expected_version:record.version,confirmation:'DELETE_CHANNEL_ACCOUNT',reason:'Retire isolated fixture after durable stop and fresh health'};
  expect(await call('DELETE','/v1/channel-accounts/'+created.id,{...args,expected_version:record.version-1},409)).toMatchObject({code:'VERSION_CONFLICT'});
  const key=randomUUID(),retired=await call('DELETE','/v1/channel-accounts/'+created.id,args,200,key);expect(retired).toEqual({id:created.id,deleted:true,history_preserved:true});expect(await call('DELETE','/v1/channel-accounts/'+created.id,args,200,key)).toEqual(retired);
  expect((await call('GET','/v1/numbers')).some((n:any)=>n.id===created.id)).toBe(false);
  record=(await getRecord(pool,workspace,'channel_account',created.id))!;expect(record.body.deleted_at).toBeTruthy();expect(record.body.status).toBe('STOPPED');
  expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
  expect((await pool.query("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='channel.deleted'",[workspace,created.id])).rows[0].n).toBe(1);
 }finally{await app.close();}
});
