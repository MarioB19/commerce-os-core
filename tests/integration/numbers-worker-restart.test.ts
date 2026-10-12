import {evidencePath} from '../support/test-evidence-path.js';
import {it,expect,afterAll} from 'vitest';
import {fork,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes,randomUUID,createHmac,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool} from '../../packages/db/src/index.js';
import {processNumberOperations} from '../../apps/channel-worker/src/number-operations.js';
import {evidencePath} from '../support/evidence.js';
afterAll(()=>pool.end());
it('drains twenty simulated accounts, terminates the actual owner process and transfers only after expiry plus verified isolation',async()=>{
 const workspace='restart-'+randomUUID(),directory=await mkdtemp(join(tmpdir(),'numbers-restart-')),proofKey=randomBytes(32).toString('hex');
 const app=await createApp(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!,email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Isolated restart operator',email,password,workspace_id:workspace,role:'owner'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin},payload:{email,password}}),cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');
 const call=async(method:any,url:string,body?:any,status=200)=>{if(method==='POST'&&/^\/v1\/channel-accounts\/[^/]+\/commands$/.test(url)&&body.expected_version===undefined){const current=await app.inject({method:'GET',url:url.replace('/channel-accounts/','/numbers/').replace('/commands','')+'?environment=SIMULATION',headers:{origin,cookie}});expect(current.statusCode).toBe(200);body={...body,expected_version:current.json().data.version};}const r=await app.inject({method,url:url+'?environment=SIMULATION',payload:body,headers:{origin,cookie,'idempotency-key':randomUUID()}});expect(r.statusCode,r.body).toBe(status);return r.json().data;};
 const children:ChildProcess[]=[];
 async function start(){const child=fork(resolve('tests/support/numbers-lifecycle-process.ts'),[],{execArgv:['--import','tsx'],env:{...process.env,LOG_LEVEL:'silent',OWNERSHIP_PROOF_DIR:directory,OWNERSHIP_PROOF_KEY:proofKey},stdio:['ignore','ignore','ignore','ipc']});children.push(child);const [ready]=await once(child,'message');expect(ready.ready).toBe(true);
  return{child,owner:ready.owner_id as string,rpc:async(action:string)=>{const id=randomUUID();const response=new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{child.off('message',listener);reject(new Error('CHILD_RESPONSE_TIMEOUT'));},30000);function listener(message:any){if(message.id!==id)return;clearTimeout(timer);child.off('message',listener);if(message.error)reject(new Error(message.error));else resolve(message.result);}child.on('message',listener);});child.send({id,action});return response;}};
 }
 try{
  const ids:string[]=[];for(let n=0;n<20;n++)ids.push((await call('POST','/v1/numbers',{alias:'Restart '+n,responsible:'Synthetic operator',device_ref:'Restart device '+n},202)).id);
  await processNumberOperations();for(const id of ids){const a=await call('GET','/v1/numbers/'+id);await call('POST','/v1/channel-accounts/'+id+'/commands',{type:'connect',expected_version:a.version,reason:'Isolated no-network lifecycle'},202);}
  const first=await start();expect(await first.rpc('commands')).toBe(20);await first.rpc('heartbeat');
  const owners=()=>pool.query('SELECT account_id,owner_id,generation,frozen,lease_expires_at FROM session_ownership WHERE workspace_id=$1 ORDER BY account_id',[workspace]);
  expect((await owners()).rows.every(r=>r.owner_id===first.owner&&r.generation===1&&!r.frozen)).toBe(true);
  for(const id of ids)await call('POST','/v1/channel-accounts/'+id+'/commands',{type:'freeze',reason:'Explicit twenty-account drain'},202);
  expect(await first.rpc('commands')).toBe(20);expect((await owners()).rows.every(r=>r.frozen)).toBe(true);
  const killedPid=first.child.pid!,exited=once(first.child,'exit');first.child.kill('SIGTERM');await exited;expect(()=>process.kill(killedPid,0)).toThrow();
  const second=await start();expect(second.owner).not.toBe(first.owner);await second.rpc('discover');expect((await owners()).rows.every(r=>r.owner_id===first.owner)).toBe(true);
  await call('POST','/v1/channel-accounts/'+ids[0]+'/commands',{type:'transfer_ownership',owner_id:second.owner,isolation_evidence:'absent-proof',reason:'Live lease cannot transfer'},202);await second.rpc('commands');expect((await owners()).rows.every(r=>r.owner_id===first.owner)).toBe(true);
  const expiry=Math.max(...(await owners()).rows.map(r=>new Date(r.lease_expires_at).getTime()));await new Promise(r=>setTimeout(r,Math.max(0,expiry-Date.now()+50)));
  await call('POST','/v1/channel-accounts/'+ids[0]+'/commands',{type:'transfer_ownership',owner_id:second.owner,isolation_evidence:'absent-proof',reason:'Expiry alone is not isolation'},202);await second.rpc('commands');expect((await owners()).rows.every(r=>r.owner_id===first.owner)).toBe(true);
  const recoveryStarted=performance.now();
  // This is evidence of the terminated local child and a closed simulator adapter, never physical WAHA isolation.
  for(const id of ids){const reference='isolated-'+id,data={account_id:id,previous_owner_id:first.owner,previous_generation:1,method:'network_isolation',evidence_sha256:createHash('sha256').update(JSON.stringify({terminated_pid:killedPid,adapter:'numberSimulator without network',environment:'SIMULATION'})).digest('hex'),verified_at:new Date().toISOString()};await writeFile(join(directory,reference+'.json'),JSON.stringify({data,signature:createHmac('sha256',proofKey).update(JSON.stringify(data)).digest('hex')}),{mode:0o600});await call('POST','/v1/channel-accounts/'+id+'/commands',{type:'transfer_ownership',owner_id:second.owner,isolation_evidence:reference,reason:'Confirmed child termination and closed simulator isolation'},202);}
  expect(await second.rpc('commands')).toBe(20);expect((await owners()).rows.every(r=>r.owner_id===second.owner&&r.generation===2&&r.frozen)).toBe(true);
  for(const id of ids)await call('POST','/v1/channel-accounts/'+id+'/commands',{type:'resume',reason:'Explicit simulator resume after transfer'},202);
  expect(await second.rpc('commands')).toBe(20);expect((await owners()).rows.every(r=>r.owner_id===second.owner&&r.generation===2&&!r.frozen)).toBe(true);
  // Saturate only this fixture process's connection pool, then release without altering database records.
  const held=await Promise.all(Array.from({length:pool.options.max??10},()=>pool.connect()));const pressureStarted=performance.now();const waiting=call('GET','/v1/number-capacity');setTimeout(()=>held.forEach(c=>c.release()),250);const capacity=await waiting;const dbPressure=performance.now()-pressureStarted;
  expect(dbPressure).toBeGreaterThanOrEqual(240);expect(capacity.topology).toHaveLength(20);expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
  const evidence={status:'PASSED',environment:'SIMULATION',accounts:20,actual_child_terminated:true,owner_generation_before:1,owner_generation_after:2,expired_lease_without_proof_rejected:true,transfer_frozen:true,explicit_resume:true,recovery_ms:performance.now()-recoveryStarted,db_pressure_ms:dbPressure,outbox_effects:0,physical_isolation_verified:false,completed_at:new Date().toISOString()};await writeFile(evidencePath('numbers-worker-restart.json'),JSON.stringify(evidence,null,2));
 }finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}await app.close();await rm(directory,{recursive:true,force:true});}
},180000);
