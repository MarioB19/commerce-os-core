export const AUTOMATION_LOOP_NAMES=['automation_inbound','automation_commands','automation_results','automation_workflows','automation_campaigns','automation_warmup','automation_warmup_simulation','automation_meta_insights','operations_monitor','automation_agents','intelligence','automation_receipts','automation_variant_receipts','number_lab','result_projections'] as const;
export type AutomationLoopName=typeof AUTOMATION_LOOP_NAMES[number];
export const AUTOMATION_LOOP_DEADLINE_MS=180_000;
type ProgressBody=Record<string,unknown>;
const object=(value:unknown):ProgressBody|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as ProgressBody:undefined;
const time=(value:unknown)=>typeof value==='string'?Date.parse(value):NaN;
const count=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;

/** Poll completion is scheduler evidence, not a claim of external or business effects. */
export function automationLoopsReady(value:unknown,now=Date.now()):boolean{
 if(!Number.isFinite(now)||!Array.isArray(value)||value.length!==AUTOMATION_LOOP_NAMES.length)return false;
 const loops=value.map(object);
 if(new Set(loops.map(loop=>loop?.name)).size!==AUTOMATION_LOOP_NAMES.length)return false;
 return AUTOMATION_LOOP_NAMES.every(name=>{
  const loop=loops.find(item=>item?.name===name);
  if(!loop||loop.required!==true||loop.status!=='OK'||loop.deadline_ms!==AUTOMATION_LOOP_DEADLINE_MS||loop.consecutive_failures!==0||typeof loop.running!=='boolean')return false;
  if(!count(loop.attempts)||!count(loop.successes)||!count(loop.failures)||Number(loop.successes)<1||loop.attempts!==Number(loop.successes)+Number(loop.failures)+Number(loop.running))return false;
  const success=time(loop.last_success_at),started=time(loop.last_started_at),failure=time(loop.last_failure_at);
  if(!Number.isFinite(success)||success>now||now-success>loop.deadline_ms||!Number.isFinite(started)||started>now)return false;
  if(loop.running?(started<success||now-started>loop.deadline_ms||loop.running_ms!==Math.max(0,now-started)):(started>success||loop.running_ms!==null))return false;
  return loop.failures===0?loop.last_failure_at===null:Number.isFinite(failure)&&failure<=success;
 });
}

type AutomationProgressCode='READY'|'AUTOMATION_WORKER_UNAVAILABLE'|'AUTOMATION_WORKER_STALE'|'AUTOMATION_WORKER_BLOCKED'|'AUTOMATION_LOOPS_NOT_READY';
export function automationProgress(heartbeatBody:unknown,now=new Date()):{ready:boolean;code:AutomationProgressCode}{
 const body=object(heartbeatBody),at=now.getTime(),result=(code:AutomationProgressCode)=>({ready:code==='READY',code});
 if(!body||body.service!=='automation-worker')return result('AUTOMATION_WORKER_UNAVAILABLE');
 const observed=time(body.observed_at),expires=time(body.expires_at);
 if(!Number.isFinite(at)||!Number.isFinite(observed)||observed>at||!Number.isFinite(expires)||expires<=at||expires<=observed||expires-observed>45_000)return result('AUTOMATION_WORKER_STALE');
 if(body.status!=='OK')return result('AUTOMATION_WORKER_BLOCKED');
 // running_ms is a measurement at publication; freshness and the running deadline
 // are re-evaluated against the current clock, without expecting a stored clock to move.
 const loops=Array.isArray(body.loops)?body.loops.map(value=>{const loop=object(value);return loop?.running?{...loop,running_ms:Math.max(0,at-time(loop.last_started_at))}:value;}):body.loops;
 if(body.source!=='AUTOMATION_LOOP_PROGRESS'||!automationLoopsReady(loops,at))return result('AUTOMATION_LOOPS_NOT_READY');
 return result('READY');
}
