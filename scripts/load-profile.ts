import {performance} from 'node:perf_hooks';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {pool,putRecord,uuid,encrypt,withTransaction} from '../packages/db/src/index.js';
import {buildIngress} from '../apps/ingress/src/server.js';
import {processInbound} from '../apps/automation-worker/src/inbound.js';
import {materializeInboundMedia} from '../apps/automation-worker/src/media.js';
import {materializeEffectResults} from '../apps/automation-worker/src/effect-results.js';
import {proposeEffect} from '../apps/automation-worker/src/shared.js';
import {dispatchOutbox,acquireOwnership,recordHealth,heartbeatOwnership} from '../apps/channel-worker/src/runtime.js';
import {downloadInboundMedia} from '../apps/channel-worker/src/media.js';
import {SimulatorProvider} from '../packages/messaging/src/index.js';
import type {DomainRecord} from '../packages/contracts/src/index.js';

const workspace='load-'+uuid(),owner='load-owner',total=2500,rate=20,conversations=500;
const accounts:DomainRecord[]=[],provider=new SimulatorProvider(),ackMs:number[]=[],rss:number[]=[],failures:number[]=[];
const start=performance.now(),cpu=process.cpuUsage();
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const app=await buildIngress();
const address=await app.listen({host:'127.0.0.1',port:0});
let running=true,heartbeat=0,error:unknown;
try {
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB3sAAAAASUVORK5CYII=','base64');
 const key=uuid(),root=process.env.PRIVATE_STORAGE_DIR!;
 mkdirSync(join(root,'assets'),{recursive:true,mode:0o700});writeFileSync(join(root,'assets',key+'.enc'),encrypt(bytes.toString('base64')),{mode:0o600});
 const asset=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'asset',body:{kind:'file',status:'READY',name:'Synthetic one-pixel.png',mime_type:'image/png',storage_key:key,size_bytes:bytes.length}});
 for(let i=0;i<10;i++){
  const account=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body:{name:'Load '+i,provider:'simulator',status:'WORKING'}});
  await acquireOwnership(account,owner);await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[account.id]);await recordHealth(account,()=>provider);accounts.push(account);
 }
 const loop=(fn:()=>Promise<void>)=>(async()=>{try{while(running){await fn();await sleep(100);}}catch(e){error=e;running=false;}})();
 const consumers=[loop(async()=>{await processInbound(50);}),loop(async()=>{await downloadInboundMedia(20,()=>provider);await materializeInboundMedia(100);}),loop(async()=>{
   const messages=(await pool.query<DomainRecord>(`SELECT m.* FROM records m WHERE m.workspace_id=$1 AND m.kind='message' AND m.body->>'direction'='INBOUND' AND NOT EXISTS(SELECT 1 FROM outbox o WHERE o.workspace_id=m.workspace_id AND o.logical_key='load-reply:'||m.id::text) ORDER BY m.created_at LIMIT 100`,[workspace])).rows;
   for(const m of messages){const c=(await pool.query<DomainRecord>('SELECT * FROM records WHERE id=$1',[m.body.conversation_id])).rows[0]!;await withTransaction(tx=>proposeEffect(tx,c,m.body.kind==='image'?{kind:'image',asset_id:asset.id,text:'Synthetic media response'}:{kind:'text',text:'Synthetic text response'},'load-reply:'+m.id));}
 }),loop(async()=>{
   if(Date.now()-heartbeat>10000){await heartbeatOwnership(owner);for(const account of accounts)await recordHealth(account,()=>provider);heartbeat=Date.now();rss.push(process.memoryUsage().rss);}
   await dispatchOutbox(50,()=>provider,owner);
 }),loop(async()=>{await materializeEffectResults();})];
 const admissionStart=performance.now();
 for(let batch=0;batch<total/rate&&running;batch++){
  const remaining=admissionStart+batch*1000-performance.now();if(remaining>0)await sleep(remaining);
  await Promise.all(Array.from({length:rate},async(_,j)=>{
   const n=batch*rate+j,account=accounts[n%10]!,kind=n%20===0?'image':'text';const tick=performance.now();
   const response=await fetch(`${address}/webhooks/simulator/${workspace}/${account.id}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${process.env.SIMULATOR_INGRESS_TOKEN}`},body:JSON.stringify({id:'load-'+n,identity:'lid:load-'+(n%conversations),kind,text:'Synthetic load '+n,...(kind==='image'?{media:{providerId:'fixture:png'}}:{})})});
   ackMs.push(performance.now()-tick);if(!response.ok)failures.push(response.status);await response.arrayBuffer();
  }));
 }
 const drainUntil=performance.now()+60000;while(running&&provider.sent.length<total&&performance.now()<drainUntil)await sleep(200);
 running=false;await Promise.all(consumers);if(error)throw error;
 const incoming=(await pool.query(`SELECT count(*)::int total,count(*)FILTER(WHERE body->>'kind'='image' AND body->>'media_status'='READY')::int media FROM records WHERE workspace_id=$1 AND kind='message' AND body->>'direction'='INBOUND'`,[workspace])).rows[0];
 const counts=(await pool.query(`SELECT (SELECT count(*)::int FROM records WHERE workspace_id=$1 AND kind='conversation') conversations,(SELECT count(*)::int FROM outbox WHERE workspace_id=$1 AND status='SENT') sent,(SELECT count(*)::int FROM inbound_envelopes WHERE workspace_id=$1 AND status<>'PROCESSED') pending`,[workspace])).rows[0];
 const latencies=(await pool.query(`SELECT extract(epoch FROM (m.created_at-e.received_at))*1000 AS ms FROM records m JOIN inbound_envelopes e ON e.id::text=m.body->>'envelope_id' WHERE m.workspace_id=$1 AND m.kind='message' AND m.body->>'direction'='INBOUND'`,[workspace])).rows.map(r=>Number(r.ms));
 const quantile=(values:number[],q:number)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*q)-1]??null;
 const elapsed=(performance.now()-start)/1000,usage=process.cpuUsage(cpu);
 const evidence={measured_at:new Date().toISOString(),profile:{accounts:10,conversations:500,inbound_messages:2500,outbound_messages:2500,admission_per_second:rate,peak_concurrent_http:rate,media_percentage_each_direction:5,media_bytes:bytes.length,media:'Actual one-pixel PNG fixture, encrypted private file read/write; deliberately small, not a representative large-media benchmark'},implementation:'Production runtime functions; real HTTP ingress and PostgreSQL17. Pipeline workers run concurrently in one harness process. Synthetic reply generator replaces business/AI deliberation. Separate Docker image and independent process checks are documented elsewhere.',results:{...counts,incoming,provider_simulator_acceptances:provider.sent.length,outgoing_media:provider.sent.filter(m=>!!m.media?.bytes).length,http_failures:failures,ack_p95_ms:quantile(ackMs,.95),durable_to_materialized_p95_ms:quantile(latencies,.95),elapsed_seconds:elapsed,drained_total_messages_per_second:5000/elapsed,harness_peak_rss_bytes:Math.max(...rss),harness_cpu_seconds:(usage.user+usage.system)/1e6},limits:['Ten simulated accounts do not validate ten real sessions.','Local development host; no VPS capacity guarantee.','No real gateway network latency, AI call cost or typical large-media workload.','Burst profile compresses the proposed daily conversation count; measured values are not a production SLA.']};
 mkdirSync('docs/evidence',{recursive:true});writeFileSync('docs/evidence/load-profile.json',JSON.stringify(evidence,null,2)+'\n');
 assert.deepEqual(failures,[]);assert.equal(counts.conversations,500);assert.equal(incoming.total,2500);assert.equal(incoming.media,125);assert.equal(counts.sent,2500);assert.equal(counts.pending,0);assert.equal(provider.sent.filter(m=>!!m.media?.bytes).length,125);
 console.log(JSON.stringify(evidence.results));
}finally{running=false;await app.close();await pool.end();}
