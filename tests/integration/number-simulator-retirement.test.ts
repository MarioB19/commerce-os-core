import {afterAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {getRecord,pool} from '../../packages/db/src/index.js';
import {processNumberOperations} from '../../apps/channel-worker/src/number-operations.js';
import {processChannelCommands,recordHealth} from '../../apps/channel-worker/src/lifecycle.js';
import {providerFor} from '../../apps/channel-worker/src/providers.js';
import {queueChannelCommand,type ChannelCommandType} from '../support/channel-commands.js';

afterAll(()=>pool.end());
it.each(['disconnect','logout'] as const)('retires after canonical %s and subsequent provider health without racing the reader',async type=>{
 const workspace='sim-retire-'+randomUUID(),app=await createApp(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Synthetic lifecycle owner',email,password,workspace_id:workspace,role:'owner'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin},payload:{email,password}});expect(login.statusCode).toBe(200);
 const cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');
 const call=async(method:any,url:string,body?:any,status=200,key=randomUUID())=>{const result=await app.inject({method,url:url+'?environment=SIMULATION',headers:{cookie,origin,'idempotency-key':key},payload:body});expect(result.statusCode,result.body).toBe(status);return status>=400?result.json().error:result.json().data;};
 try{
  const created=await call('POST','/v1/numbers/quick',{alias:'Synthetic lifecycle number',country:'MX'},202);
  await processNumberOperations('sim-retirement-fixture',providerFor);
  expect((await pool.query('SELECT state FROM number_operations WHERE id=$1',[created.operation_id])).rows[0].state).toBe('SUCCEEDED');
  // V7 F8-D: lifecycle commands queued as the V7 number journey queues them.
  const command=async(action:ChannelCommandType)=>{const a=(await getRecord(pool,workspace,'channel_account',created.id))!;const cmd=await queueChannelCommand({id:created.id,workspace_id:workspace,environment:'SIMULATION'},action,{expected_version:a.version,reason:'Isolated simulator lifecycle regression'});await processChannelCommands(20,providerFor);expect((await pool.query('SELECT status FROM commands WHERE id=$1',[cmd.id])).rows[0].status).toBe('APPLIED');};
  await command('connect');await command(type);
  let record=(await getRecord(pool,workspace,'channel_account',created.id))!;expect(record.body.status).toBe('STOPPED');
  // Force the exact periodic read after the lifecycle result, with a new adapter.
  // No business state or delivery evidence is inserted by the test.
  await new Promise(resolve=>setTimeout(resolve,5));await recordHealth(record,providerFor);
  record=(await getRecord(pool,workspace,'channel_account',created.id))!;expect(record.body.status).toBe('STOPPED');
  const session=await call('GET','/v1/channel-accounts/'+created.id+'/session');expect(session.stored_observed_state).toBe('STOPPED');expect(session.desired_state).toBe('STOPPED');expect(session.operational_pause).toBe(true);expect(session.ownership.frozen).toBe(true);expect(session.uncertain_commands).toEqual([]);
  // V7 removal from Números: a stale confirmation is refused, the same request
  // replays, and the stopped, unlinked number is kept as history.
  expect(await call('POST','/v1/numbers/'+created.id+'/removal',{expected_version:record.version-1,confirmation:'REMOVE_NUMBER'},409)).toMatchObject({code:'VERSION_CONFLICT'});
  const key=randomUUID(),args={expected_version:record.version,confirmation:'REMOVE_NUMBER'},retired=await call('POST','/v1/numbers/'+created.id+'/removal',args,202,key);expect(await call('POST','/v1/numbers/'+created.id+'/removal',args,202,key)).toEqual(retired);
  // Logout already unlinked the line; a disconnect leaves it linked, so removal closes the session first.
  expect(retired).toMatchObject({id:created.id,state:type==='logout'?'REMOVED':'REMOVING'});
  if(type==='disconnect'){await processChannelCommands(20,providerFor);expect((await call('GET','/v1/numbers/'+created.id+'/link')).state).toBe('REMOVED');}
  expect(JSON.stringify(await call('GET','/v1/numbers/overview'))).not.toContain(created.id);
  record=(await getRecord(pool,workspace,'channel_account',created.id))!;expect(record.body.deleted_at).toBeTruthy();expect(record.body.status).toBe('STOPPED');
  expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
  expect((await pool.query("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND aggregate_id=$2 AND event_type='channel.deleted'",[workspace,created.id])).rows[0].n).toBe(1);
 }finally{await app.close();}
});
