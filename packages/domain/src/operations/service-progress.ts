type ChannelProgressCode='READY'|'CHANNEL_WORKER_UNAVAILABLE'|'CHANNEL_WORKER_STALE'|'CHANNEL_WORKER_BLOCKED'|'CHANNEL_LOOPS_NOT_READY';
type ProgressBody=Record<string,unknown>;
const object=(value:unknown):ProgressBody|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as ProgressBody:undefined;
const time=(value:unknown)=>typeof value==='string'?Date.parse(value):NaN;

/** Assess evidence at read time: a fresh publisher cannot mask stalled work. */
export function channelProgress(heartbeatBody:unknown,now=new Date()):{ready:boolean;code:ChannelProgressCode}{
 const body=object(heartbeatBody),at=now.getTime();
 const result=(code:ChannelProgressCode)=>({ready:code==='READY',code});
 if(!body||body.service!=='channel-worker')return result('CHANNEL_WORKER_UNAVAILABLE');
 const observed=time(body.observed_at),expires=time(body.expires_at);
 if(!Number.isFinite(at)||!Number.isFinite(observed)||observed>at||!Number.isFinite(expires)||expires<=at||expires<=observed)return result('CHANNEL_WORKER_STALE');
 if(body.status!=='OK')return result('CHANNEL_WORKER_BLOCKED');
 if(body.source==='CHANNEL_LOOP_PROGRESS'){
  if(!Array.isArray(body.loops))return result('CHANNEL_LOOPS_NOT_READY');
  const loops=body.loops.map(object),required=loops.filter(loop=>loop?.required===true);
  if(loops.some(loop=>!loop||typeof loop.required!=='boolean')||!required.length||required.some(loop=>{
   if(!loop||loop.status!=='OK'||typeof loop.deadline_ms!=='number'||!Number.isFinite(loop.deadline_ms)||loop.deadline_ms<=0)return true;
   const success=time(loop.last_success_at),started=time(loop.last_started_at);
   return!Number.isFinite(success)||success>at||at-success>loop.deadline_ms||loop.consecutive_failures!==0||
    typeof loop.running!=='boolean'||loop.running&&(!Number.isFinite(started)||started>at||at-started>loop.deadline_ms);
  }))return result('CHANNEL_LOOPS_NOT_READY');
 }
 return result('READY');
}
