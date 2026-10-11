import {AUTOMATION_LOOP_NAMES,AUTOMATION_LOOP_DEADLINE_MS,automationLoopsReady,type AutomationLoopName} from '../../../packages/domain/src/operations/automation-progress.js';
type LoopStatus='STARTING'|'OK'|'FAILED'|'STALLED'|'STALE'|'STOPPED';
export type AutomationLoopProgress={name:AutomationLoopName;required:true;status:LoopStatus;running:boolean;last_started_at:string|null;last_success_at:string|null;last_failure_at:string|null;consecutive_failures:number;attempts:number;successes:number;failures:number;deadline_ms:number;running_ms:number|null};
export type AutomationProgress={ready:boolean;code:'READY'|'AUTOMATION_LOOPS_NOT_READY';loops:AutomationLoopProgress[]};
type State={name:AutomationLoopName;startedAt:number|null;successAt:number|null;failureAt:number|null;consecutiveFailures:number;attempts:number;successes:number;failures:number;running:boolean;stopped:boolean};

/** Same no-overlap and stale-work semantics as channel, with a closed inventory. */
export class AutomationLoopMonitor {
 private readonly loops=new Map<AutomationLoopName,State>();
 constructor(private readonly now=()=>Date.now()){}
 add(name:AutomationLoopName,work:()=>Promise<unknown>){
  if(!AUTOMATION_LOOP_NAMES.includes(name)||this.loops.has(name))throw Error('AUTOMATION_LOOP_CONFIGURATION_INVALID');
  const state:State={name,startedAt:null,successAt:null,failureAt:null,consecutiveFailures:0,attempts:0,successes:0,failures:0,running:false,stopped:false};this.loops.set(name,state);
  return{
   run:async()=>{if(state.running||state.stopped)return;state.running=true;state.startedAt=this.now();state.attempts++;try{await work();state.successAt=this.now();state.successes++;state.consecutiveFailures=0;}catch(error){state.failureAt=this.now();state.failures++;state.consecutiveFailures++;throw error;}finally{state.running=false;}},
   stop:()=>{state.stopped=true;},
  };
 }
 snapshot():AutomationProgress{
  const now=this.now(),loops=[...this.loops.values()].map(state=>{
   const runningMs=state.running&&state.startedAt!==null?Math.max(0,now-state.startedAt):null;
   const status:LoopStatus=state.stopped?'STOPPED':runningMs!==null&&runningMs>AUTOMATION_LOOP_DEADLINE_MS?'STALLED':state.consecutiveFailures?'FAILED':state.successAt===null?'STARTING':now-state.successAt>AUTOMATION_LOOP_DEADLINE_MS?'STALE':'OK';
   return{name:state.name,required:true as const,status,running:state.running,last_started_at:state.startedAt===null?null:new Date(state.startedAt).toISOString(),last_success_at:state.successAt===null?null:new Date(state.successAt).toISOString(),last_failure_at:state.failureAt===null?null:new Date(state.failureAt).toISOString(),consecutive_failures:state.consecutiveFailures,attempts:state.attempts,successes:state.successes,failures:state.failures,deadline_ms:AUTOMATION_LOOP_DEADLINE_MS,running_ms:runningMs};
  });
  const ready=automationLoopsReady(loops,now);return{ready,code:ready?'READY':'AUTOMATION_LOOPS_NOT_READY',loops};
 }
}
export function automationLoopMetrics(progress:AutomationProgress){
 return progress.loops.map(loop=>`commerce_automation_loop_ready{loop="${loop.name}"} ${Number(loop.status==='OK')}\ncommerce_automation_loop_running{loop="${loop.name}"} ${Number(loop.running)}\ncommerce_automation_loop_successes_total{loop="${loop.name}"} ${loop.successes}\ncommerce_automation_loop_failures_total{loop="${loop.name}"} ${loop.failures}\ncommerce_automation_loop_last_success_seconds{loop="${loop.name}"} ${loop.last_success_at?Date.parse(loop.last_success_at)/1000:0}\ncommerce_automation_loop_consecutive_failures{loop="${loop.name}"} ${loop.consecutive_failures}\n`).join('');
}
