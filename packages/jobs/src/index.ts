import {PgBoss} from 'pg-boss';
import Fastify from 'fastify';
import {query} from '@commerce/db';
export type JobName='automation.wake'|'channel.wake';
export interface JobBus {start():Promise<void>;send(name:JobName,id:string):Promise<void>;work(name:JobName,handler:(id:string)=>Promise<void>):Promise<void>;stop():Promise<void>}
/** Jobs are hints: every consumer scans durable business facts even if queue history disappears. */
export class PostgresJobBus implements JobBus {
  private boss:PgBoss;
  constructor(connectionString=process.env.DATABASE_URL){if(!connectionString)throw new Error('DATABASE_URL_REQUIRED');const schema=process.env.JOB_SCHEMA??'pgboss';if(!/^pgboss(?:_automation|_channel)?$/.test(schema))throw new Error('JOB_SCHEMA_INVALID');this.boss=new PgBoss({connectionString,schema,max:2,createSchema:!process.env.JOB_SCHEMA});this.boss.on('error',()=>{process.stderr.write('job_bus_error\n');});}
  async start(){await this.boss.start();for(const name of ['automation.wake','channel.wake']as const)await this.boss.createQueue(name,{retryLimit:3,retryDelay:2,expireInSeconds:60});}
  async send(name:JobName,id:string){await this.boss.send(name,{id},{singletonKey:id});}
  async work(name:JobName,handler:(id:string)=>Promise<void>){await this.boss.work<{id:string}>(name,{batchSize:1,pollingIntervalSeconds:1},async jobs=>{for(const job of jobs)await handler(job.data.id);});}
  async stop(){await this.boss.stop({graceful:true});}
}
export type WorkerProgressHooks={progress:()=>{ready:boolean;code:string;loops:unknown[]};heartbeat:()=>Promise<void>;metrics?:()=>string};
export async function workerService(name:string,port:number,tick:()=>Promise<void>,intervalMs=500,hooks?:WorkerProgressHooks){
  const app=Fastify({logger:false});let active=false,lastSuccess=0,lastError:string|null=null,lastHeartbeat=0,heartbeatActive=false,heartbeatError=false,heartbeatStarted=0;
  app.get('/livez',async()=>({ok:true,service:name}));app.get('/readyz',async(_req,reply)=>{try{await query('SELECT 1');const progress=hooks?.progress(),detail={service:name,last_success_at:lastSuccess?new Date(lastSuccess).toISOString():null,...progress};if(progress&&!progress.ready)return reply.code(503).send({...detail,ok:false});if(hooks&&(heartbeatError||!lastHeartbeat||Date.now()-lastHeartbeat>45_000||heartbeatActive&&Date.now()-heartbeatStarted>45_000))return reply.code(503).send({...detail,ready:false,ok:false,code:heartbeatError?'WORKER_HEARTBEAT_FAILED':!lastHeartbeat?'WORKER_HEARTBEAT_STARTING':'WORKER_HEARTBEAT_STALE'});if(lastError&&(hooks||Date.now()-lastSuccess>60_000))return reply.code(503).send({...detail,ready:false,ok:false,code:lastError});return{...detail,ok:true};}catch{return reply.code(503).send({ok:false,code:'DB_UNAVAILABLE'});}});
  app.get('/metrics',async(_req,reply)=>reply.type('text/plain').send(`commerce_worker_last_success_seconds{service="${name}"} ${Math.floor(lastSuccess/1000)}\ncommerce_worker_busy{service="${name}"} ${Number(active)}\n`+(hooks?.metrics?.()??'')));
  const heartbeat=async()=>{if(!hooks||heartbeatActive)return;heartbeatActive=true;heartbeatStarted=Date.now();try{await hooks.heartbeat();lastHeartbeat=Date.now();heartbeatError=false;}catch{heartbeatError=true;process.stderr.write(`${name}: heartbeat failed; durable facts retained\n`);}finally{heartbeatActive=false;}};
  const run=async()=>{if(active)return;active=true;try{await tick();if(!hooks&&Date.now()-lastHeartbeat>15000){await persistHeartbeat(name);lastHeartbeat=Date.now();}lastSuccess=Date.now();lastError=null;}catch{lastError='WORKER_TICK_FAILED';process.stderr.write(`${name}: tick failed; durable facts retained\n`);}finally{active=false;}};
  const timer=setInterval(()=>void run(),intervalMs),heartbeatTimer=hooks?setInterval(()=>void heartbeat(),15000):undefined;await app.listen({host:process.env.HOST??'0.0.0.0',port});void run();void heartbeat();
  return {app,run,heartbeat,close:async()=>{clearInterval(timer);clearInterval(heartbeatTimer);await app.close();}};
}
export async function persistHeartbeat(service:string,instance=service){
 const workspaces=(await query(`SELECT DISTINCT workspace_id,environment FROM records WHERE kind='channel_account'`)).rows;
 for(const row of workspaces){await query(`INSERT INTO records(workspace_id,environment,kind,body) SELECT $1,$2,'service_heartbeat',jsonb_build_object('service',$3::text,'instance',$4::text,'status','OK','observed_at',now(),'expires_at',now()+interval '45 seconds','source','local_probe') WHERE NOT EXISTS(SELECT 1 FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='service_heartbeat' AND body->>'instance'=$4)`,[row.workspace_id,row.environment,service,instance]);await query(`UPDATE records SET body=body||jsonb_build_object('status','OK','observed_at',now(),'expires_at',now()+interval '45 seconds'),version=version+1,updated_at=now() WHERE workspace_id=$1 AND environment=$2 AND kind='service_heartbeat' AND body->>'instance'=$3`,[row.workspace_id,row.environment,instance]);}
}
