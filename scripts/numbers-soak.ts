import {providerFor} from '../apps/channel-worker/src/providers.js';
import {commercialLoad} from './numbers-soak-sales.js';
import {flushWarmupSimulatedEvents} from '../apps/channel-worker/src/warmup-simulator.js';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import os from 'node:os';
import {execFile,spawn,type ChildProcess} from 'node:child_process';
import {promisify} from 'node:util';
const command=promisify(execFile);
async function availableMemory(){if(process.platform==='darwin'){const {stdout}=await command('/usr/bin/memory_pressure',[],{timeout:2000});const match=stdout.match(/System-wide memory free percentage: (\d+)%/);return match?Number(match[1])/100:null;}return os.freemem()/os.totalmem();}
import {performance} from 'node:perf_hooks';
import {createApp} from '../apps/api/src/app.js';
import {provisionUser} from '../apps/api/src/auth.js';
import {pool} from '../packages/db/src/index.js';
import {processNumberOperations} from '../apps/channel-worker/src/number-operations.js';
import {processChannelCommands,heartbeatOwnership} from '../apps/channel-worker/src/lifecycle.js';
import {processWarmup} from '../apps/automation-worker/src/warmup.js';
import {dispatchOutbox} from '../apps/channel-worker/src/dispatch.js';
import {processInbound} from '../apps/automation-worker/src/inbound.js';
const duration=Number(process.env.NUMBERS_SOAK_SECONDS??7200),interval=Number(process.env.NUMBERS_SOAK_INTERVAL_MS??9000),count=20;
const workspace='numbers-soak-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
const app=await createApp(),email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
await provisionUser({name:'Prueba aislada de veinte números',email,password,workspace_id:workspace,role:'owner'});
const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});
if(login.statusCode!==200)throw new Error('LOGIN_FAILED');
const cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');
async function call(method:any,url:string,body?:any,key=randomUUID()):Promise<any>{const r=await app.inject({method,url:url+(url.includes('?')?'&':'?')+'environment=SIMULATION',payload:body,headers:{origin,cookie,'idempotency-key':key}});if(r.statusCode===429){await new Promise(resolve=>setTimeout(resolve,Math.min(60000,Math.max(1000,Number(r.headers['retry-after']??60)*1000))));return call(method,url,body,key);}if(r.statusCode>=300)throw new Error(method+' '+url+' '+r.statusCode+' '+r.body);return r.json().data;}
const heartbeat=setInterval(()=>{void heartbeatOwnership().catch(()=>{});},10000);
const path='docs/evidence/numbers-soak-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';await mkdir('docs/evidence',{recursive:true});
const report:any={workspace,started_at:new Date().toISOString(),profile:{accounts:count,group_sizes:[3,3,3,3,3,3,2],adapter:'no-network',text_bytes_max:250,group_sends_per_account_per_minute_max:5,clock_step_seconds:1800,wall_tick_ms:interval,requested_wall_seconds:duration,process_topology:'one local harness runs actual API and worker entry points; PostgreSQL in isolated Docker',commercial_load:{additional_legacy_accounts:2,transactions_per_tick:1,inbound_per_tick:1,format:'text and fixture URL',ai:'disabled; no external model calls or cost; does not establish AI throughput'},fault_load:{slow_gateway_ms:1200,delayed_receipts_ms:240000,duplicate_receipts:true,phases:'ticks 20-29, 40-49, 60-69; recovery after each',worker_dispatch_pause:'ticks 80-84; heartbeat continues; actual process restart requires the separate lifecycle test'},configured_gateway_limit:20,total_synthetic_accounts:22},status:'SETUP',samples:[],programs:[],capacity_steps:[],external_effects:0};
const save=()=>writeFile(path,JSON.stringify(report,null,2));
const sourceFiles=(await command('git',['ls-files','-c','-o','--exclude-standard','apps','packages','scripts'])).stdout.trim().split('\n').sort();const sourceHash=createHash('sha256');for(const file of sourceFiles)sourceHash.update(file+'\0').update(await readFile(file));report.source={base_sha:(await command('git',['rev-parse','HEAD'])).stdout.trim(),worktree_source_sha256:sourceHash.digest('hex'),files:sourceFiles.length,committed:!(await command('git',['status','--porcelain','--','apps','packages','scripts'])).stdout.trim()};
let sales:Awaited<ReturnType<typeof commercialLoad>>|undefined;
let observer:ChildProcess|undefined;
let virtual=new Date();virtual.setUTCDate(virtual.getUTCDate()-18);virtual.setUTCHours(10,0,0,0);
let clock=await call('POST','/v1/number-simulation',{action:'create',at:virtual.toISOString()});
const accounts:string[]=[];
async function runJob(id:string){for(let attempt=0;attempt<30;attempt++){await processNumberOperations();const job=await call('GET','/v1/number-operations/'+id);if(job.state==='SUCCEEDED')return job;if(['UNKNOWN','FAILED','HUMAN_ACTION_REQUIRED'].includes(job.state))throw new Error('READ_JOB_'+job.state); }throw new Error('READ_JOB_DID_NOT_FINISH');}
async function refreshGroups(){const op=await call('POST','/v1/number-groups/refresh',{account_ids:accounts});await runJob(op.operation_id);}
async function refresh(){const rows=(await call('GET','/v1/numbers?limit=100')).filter((a:any)=>accounts.includes(a.id)),key=randomUUID(),body={items:rows.map((a:any)=>({key:a.id,action:'observe-identity',id:a.id,body:{expected_version:a.version}}))};let result=await call('POST','/v1/numbers/batch',body,key);if(result.some((r:any)=>r.status===429)){await new Promise(resolve=>setTimeout(resolve,60000));result=await call('POST','/v1/numbers/batch',body,key);}if(result.some((r:any)=>r.status>=300))throw new Error('IDENTITY_BATCH_FAILED '+JSON.stringify(result.filter((r:any)=>r.status>=300)));await processNumberOperations();}

async function advance(seconds=1800){clock=await call('POST','/v1/number-simulation',{action:'advance',seconds,expected_version:clock.version});virtual=new Date(clock.virtual_now);}
try{
 for(const target of [2,5,10,20]){const preview=await call('POST','/v1/number-capacity',{action:'preview',count:target,reason:'Dimensionamiento de ensayo local'});const op=await call('POST','/v1/number-capacity',{action:'expand',count:target,review:preview.review,confirmation:'APPLY_REVIEWED_CAPACITY',reason:'Ampliación sintética explícita'});await processNumberOperations();const result=await call('GET','/v1/number-operations/'+op.operation_id);if(result.state!=='SUCCEEDED')throw new Error('CAPACITY_OPERATION_FAILED');const capacity=await call('GET','/v1/number-capacity?limit=100');if(capacity.installed!==target)throw new Error('CAPACITY_READBACK_FAILED');report.capacity_steps.push({target,installed:capacity.installed,operation_id:op.operation_id});
  for(let n=accounts.length;n<target;n++){const created=await call('POST','/v1/numbers',{alias:'Ensayo '+String(n+1).padStart(2,'0'),responsible:'Operador de pruebas',device_ref:'Dispositivo aislado '+n});accounts.push(created.id);}await processNumberOperations();
 }
 await refresh();
 for(const id of accounts){let a=await call('GET','/v1/numbers/'+id);await call('POST','/v1/numbers/'+id+'/confirm-identity',{expected_version:a.version,ownership_confirmed:true,name:a.alias,about:'Perfil interno de prueba sin red'});a=await call('GET','/v1/numbers/'+id);await call('POST','/v1/numbers/'+id+'/preparation',{action:'start',expected_version:a.version,timezone:'UTC'});await call('POST','/v1/channel-accounts/'+id+'/commands',{type:'connect',expected_version:a.version,reason:'Conectar sólo adaptador interno'});}
 await processChannelCommands(20);
 for(const id of accounts){const s=await call('GET','/v1/channel-accounts/'+id+'/session');await call('PATCH','/v1/channel-accounts/'+id+'/session',{expected_version:s.revision,operational_pause:false,reason:'Operación de simulador autorizada'});}
 for(let day=0;day<4;day++){
  for(const id of accounts)for(const task of day===0?['authentic_profile','responsible_device','consented_contacts','human_conversations']:['human_conversations']){const prep=await call('GET','/v1/numbers/'+id+'/preparation');await call('POST','/v1/numbers/'+id+'/preparation',{expected_version:prep.episode.version,action:'declare',task,status:'COMPLETED',note:'Declaración sintética. Cero actividad humana real acreditada.'});}
  await advance(86400);
 }
 await refresh();await heartbeatOwnership();
 let offset=0;for(const size of report.profile.group_sizes){await call('POST','/v1/number-simulation/groups',{name:'Grupo interno '+offset,account_ids:accounts.slice(offset,offset+size)});offset+=size;}
 const seeded=await call('POST','/v1/number-library/seed',{}),contents=[];for(const d of seeded.drafts)contents.push((await call('POST','/v1/number-library/'+d.id+'/approve',{expected_version:d.version,confirmation:'APPROVE_OWN_TEST_CONTENT'})).approved_content_id);
 await refreshGroups();
 for(const g of await call('GET','/v1/number-groups?limit=100')){let p=await call('POST','/v1/number-programs',{name:g.name,topology:'group',group_id:g.id,account_ids:g.members.map((m:any)=>m.account_id),content_ids:contents,profile:{name:'Quince días comprobables',timezone:'UTC',start_hour:0,end_hour:23,jitter_seconds:0},expires_at:new Date(virtual.getTime()+40*86400000).toISOString()});const r=await call('POST','/v1/number-programs/'+p.id+'/commands',{expected_version:p.version,action:'review',reason:'Revisión del ensayo de capacidad'});if(!r.ready)throw new Error('PREFLIGHT '+r.reasons.join(','));p=await call('POST','/v1/number-programs/'+p.id+'/commands',{expected_version:r.version,action:'authorize',review:r.review,confirmation:'AUTHORIZE_REVIEWED_PROGRAM',reason:'Autorización sólo del simulador'});p=await call('POST','/v1/number-programs/'+p.id+'/commands',{expected_version:p.version,action:'activate',review:p.review,confirmation:'ACTIVATE_REVIEWED_PROGRAM',reason:'Activación sólo del simulador'});report.programs.push(p.id);}
 sales=await commercialLoad(call,workspace);
 // Separate bootstrap requests from the sustained-load rate window.
 await new Promise(resolve=>setTimeout(resolve,60000));await heartbeatOwnership();
 report.status='RUNNING';report.load_started_at=new Date().toISOString();report.host={platform:process.platform,cpu_cores:os.cpus().length,memory_total_bytes:os.totalmem()};await save();observer=spawn(process.execPath,['scripts/numbers-soak-observer.mjs',path],{env:process.env,stdio:['ignore','ignore','inherit']});console.log(JSON.stringify({status:'RUNNING',report:path,accounts:count,independent_observer:true}));
 const eligible=new Map<string,number>();report.eligibility_measurement_revision=2;report.eligible_dispatch_wait_ms=[];report.eligible_dispatch_method='Measured before each real dispatcher pass: due group effects with confirmed predecessor reception; explicit quiet hours, pause, expiry and rate blocks excluded. Provider invocation records elapsed wall time. Includes between-pass wait; backlog is re-read after the final dispatch so newly rate-blocked effects are excluded. Virtual calendar is not wall latency.';
 async function refreshEligibility(){const candidates=(await pool.query("SELECT o.id FROM outbox o JOIN warmup_turns t ON t.effect_id=o.id JOIN warmup_conversations v ON v.id=t.conversation_id JOIN warmup_pools p ON p.id=v.pool_id WHERE o.workspace_id=$1 AND o.status IN('READY','BLOCKED') AND p.enabled AND NOT p.paused AND NOT p.breaker_open AND o.not_before<=$2 AND o.expires_at>$2 AND (o.predecessor_id IS NULL OR EXISTS(SELECT 1 FROM warmup_group_receipts r JOIN outbox predecessor ON predecessor.id=r.effect_id WHERE r.effect_id=o.predecessor_id AND r.receiver_id=t.sender_id AND r.delivery_source='authenticated_receive' AND predecessor.status IN('DELIVERED','READ'))) AND COALESCE(o.result->>'reason','') NOT IN('WARMUP_QUIET_HOURS','WARMUP_RATE_LIMIT','WARMUP_POOL_PAUSED','EFFECT_EXPIRED')",[workspace,virtual])).rows;const current=new Set(candidates.map(r=>r.id));for(const id of eligible.keys())if(!current.has(id))eligible.delete(id);for(const {id}of candidates)if(!eligible.has(id))eligible.set(id,performance.now());}
 async function measuredDispatch(){await refreshEligibility();return dispatchOutbox(100,async account=>{const provider=await providerFor(account),send=provider.send.bind(provider);provider.send=async message=>{if(eligible.has(message.effectId)){report.eligible_dispatch_wait_ms.push(performance.now()-eligible.get(message.effectId)!);eligible.delete(message.effectId);}return send(message);};return provider;});}
 const started=performance.now();let cpu=os.cpus().map(c=>c.times),ticks=0;
 while(performance.now()-started<duration*1000){const tick=performance.now();await heartbeatOwnership();await advance();await refresh();
  const fault=ticks>=20&&ticks<30?'slow_gateway':ticks>=40&&ticks<50?'delay':ticks>=60&&ticks<70?'duplicate':'none';
  if([20,30,40,50,60,70].includes(ticks)){await call('POST','/v1/number-simulation/groups',{name:'Grupo interno 0',account_ids:accounts.slice(0,3),fault});report.faults??=[];report.faults.push({tick:ticks,fault,elapsed_s:(performance.now()-started)/1000});}
  await sales.tick();await flushWarmupSimulatedEvents();await refreshGroups();await processWarmup();let sent=0;for(let pass=0;pass<3;pass++){if(ticks<80||ticks>=85)sent+=await measuredDispatch();await processInbound(200);}if(ticks<80||ticks>=85)await measuredDispatch();else eligible.clear();
  // A separately reviewed SIMULATION maintenance program keeps the load active after graduation.
  const programs=await call('GET','/v1/number-programs?limit=100');
  for(const completed of programs.filter((p:any)=>p.purpose==='preparation'&&p.status==='COMPLETED'&&!report.maintenance?.some((m:any)=>m.preparation_id===p.id))){
   const snapshot=await call('GET','/v1/numbers/'+completed.account_ids[0]+'/preparation');
   let maintenance=await call('POST','/v1/number-programs',{name:completed.name+' · mantenimiento simulado',purpose:'maintenance',topology:'group',group_id:completed.group_id,account_ids:completed.account_ids,content_ids:contents,profile:{name:'Mantenimiento explícito',timezone:'UTC',start_hour:0,end_hour:23,jitter_seconds:0},expires_at:new Date(virtual.getTime()+40*86400000).toISOString()});
   for(const action of ['review','authorize','activate'])maintenance=await call('POST','/v1/number-programs/'+maintenance.id+'/commands',{action,expected_version:maintenance.version,reason:'Alcance separado sólo del ensayo',...(action==='authorize'?{review:maintenance.review,confirmation:'AUTHORIZE_REVIEWED_PROGRAM'}:action==='activate'?{review:maintenance.review,confirmation:'ACTIVATE_REVIEWED_PROGRAM'}:{})});
   report.maintenance??=[];report.maintenance.push({preparation_id:completed.id,program_id:maintenance.id,graduation:snapshot.progress,elapsed_s:(performance.now()-started)/1000});
  }
  const wait=performance.now(),connection=await pool.connect(),dbWait=performance.now()-wait;connection.release();
  const queue=(await pool.query("SELECT status,count(*)::int n FROM outbox WHERE workspace_id=$1 GROUP BY status",[workspace])).rows;
  const progress=(await pool.query("SELECT status,count(*)::int n,min(effective_days)::int min_days,max(effective_days)::int max_days FROM warmup_states WHERE workspace_id=$1 GROUP BY status",[workspace])).rows;
  const nextCpu=os.cpus().map(c=>c.times);let busy=0,total=0;for(let i=0;i<nextCpu.length;i++){const previous=cpu[i]!,next=nextCpu[i]!;for(const k of Object.keys(next) as (keyof typeof next)[]){const diff=next[k]-previous[k];total+=diff;if(k!=='idle')busy+=diff;}}cpu=nextCpu;
  // The last dispatch may newly block a candidate for rate/quiet hours. Re-read before measuring backlog.
  await refreshEligibility();
  report.samples.push({eligible_queue:eligible.size,elapsed_s:(performance.now()-started)/1000,virtual_now:virtual.toISOString(),tick_ms:performance.now()-tick,db_connection_wait_ms:dbWait,sent,queue,progress,host_cpu_busy_ratio:total?busy/total:null,host_free_memory_ratio:os.freemem()/os.totalmem(),host_available_memory_ratio:await availableMemory(),host_memory_source:process.platform==='darwin'?'memory_pressure system-wide free percentage (includes reclaimable memory)':'os.freemem',process_rss:process.memoryUsage().rss,pool_total:pool.totalCount,pool_waiting:pool.waitingCount});
  report.elapsed_seconds=(performance.now()-started)/1000;report.ticks=++ticks;await save();if(ticks%20===0)console.log(JSON.stringify({status:'RUNNING',ticks,elapsed_s:Math.round(report.elapsed_seconds),progress}));
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,interval-(performance.now()-tick))));
  const observedTick=performance.now()-tick;if(observedTick>60000)throw new Error("LOAD_INTERRUPTED_TICK_"+Math.round(observedTick));
 }
 const duplicate=(await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND attempts>1',[workspace])).rows[0].n;report.duplicate_attempts=duplicate;report.commercial_transactions=sales.transactions;report.commercial_tick_ms=sales.timings;report.synthetic_outbox=(await pool.query("SELECT kind,status,count(*)::int n FROM outbox WHERE workspace_id=$1 GROUP BY kind,status",[workspace])).rows;report.elapsed_seconds=(performance.now()-started)/1000;report.status=duration>=7200&&report.elapsed_seconds>=7200&&!duplicate?'COMPLETED_WITH_LIMITS':'PARTIAL';report.completed_at=new Date().toISOString();await save();console.log(JSON.stringify({status:report.status,report:path,elapsed_seconds:report.elapsed_seconds}));
}catch(e){report.status='FAILED';report.error=e instanceof Error?e.message:String(e);await save();throw e;}finally{clearInterval(heartbeat);await sales?.close();await app.close();await pool.end();if(observer&&observer.exitCode===null)await new Promise<void>(resolve=>{const timer=setTimeout(()=>{observer?.kill('SIGTERM');resolve();},10000);observer!.once('exit',()=>{clearTimeout(timer);resolve();});});}
