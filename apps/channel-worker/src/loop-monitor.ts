type LoopStatus='STARTING'|'OK'|'FAILED'|'STALLED'|'STALE'|'STOPPED';
export type LoopProgress={name:string;required:boolean;status:LoopStatus;running:boolean;last_started_at:string|null;last_success_at:string|null;last_failure_at:string|null;consecutive_failures:number;deadline_ms:number;running_ms:number|null};
export type ChannelProgress={ready:boolean;code:'READY'|'CHANNEL_LOOPS_NOT_READY';loops:LoopProgress[]};
type LoopState={name:string;required:boolean;deadlineMs:number;startedAt:number|null;successAt:number|null;failureAt:number|null;failures:number;running:boolean;stopped:boolean};

/** Observe a stuck promise without starting overlapping or duplicate work. */
export class ChannelLoopMonitor {
 private readonly loops=new Map<string,LoopState>();
 constructor(private readonly now=()=>Date.now()){}
 add(name:string,work:()=>Promise<unknown>,options:{deadlineMs:number;required?:boolean}){
  if(!/^[a-z][a-z0-9_]*$/.test(name)||this.loops.has(name)||options.deadlineMs<=0)throw Error('CHANNEL_LOOP_CONFIGURATION_INVALID');
  const state:LoopState={name,required:options.required??true,deadlineMs:options.deadlineMs,startedAt:null,successAt:null,failureAt:null,failures:0,running:false,stopped:false};this.loops.set(name,state);
  return{
   run:async()=>{if(state.running||state.stopped)return;state.running=true;state.startedAt=this.now();try{await work();state.successAt=this.now();state.failures=0;}catch{state.failureAt=this.now();state.failures++;process.stderr.write(`${name}_failed; durable facts preserved\n`);}finally{state.running=false;}},
   stop:()=>{state.stopped=true;},
  };
 }
 snapshot():ChannelProgress{
  const now=this.now(),loops=[...this.loops.values()].map(state=>{
   const runningMs=state.running&&state.startedAt!==null?Math.max(0,now-state.startedAt):null;
   const status:LoopStatus=state.stopped?'STOPPED':runningMs!==null&&runningMs>state.deadlineMs?'STALLED':state.failures?'FAILED':state.successAt===null?'STARTING':now-state.successAt>state.deadlineMs?'STALE':'OK';
   return{name:state.name,required:state.required,status,running:state.running,last_started_at:state.startedAt===null?null:new Date(state.startedAt).toISOString(),last_success_at:state.successAt===null?null:new Date(state.successAt).toISOString(),last_failure_at:state.failureAt===null?null:new Date(state.failureAt).toISOString(),consecutive_failures:state.failures,deadline_ms:state.deadlineMs,running_ms:runningMs};
  });
  const required=loops.filter(loop=>loop.required),ready=required.length>0&&required.every(loop=>loop.status==='OK');
  return{ready,code:ready?'READY':'CHANNEL_LOOPS_NOT_READY',loops};
 }
}

export function channelLoopMetrics(progress:ChannelProgress){
 return progress.loops.map(loop=>`commerce_channel_loop_ready{loop="${loop.name}"} ${Number(loop.status==='OK')}\ncommerce_channel_loop_running{loop="${loop.name}"} ${Number(loop.running)}\ncommerce_channel_loop_last_success_seconds{loop="${loop.name}"} ${loop.last_success_at?Date.parse(loop.last_success_at)/1000:0}\ncommerce_channel_loop_consecutive_failures{loop="${loop.name}"} ${loop.consecutive_failures}\n`).join('');
}
