import {expect,it} from 'vitest';
import {AutomationLoopMonitor,automationLoopMetrics} from '../../apps/automation-worker/src/loop-monitor.js';
import {AUTOMATION_LOOP_NAMES,AUTOMATION_LOOP_DEADLINE_MS,automationProgress} from '../../packages/domain/src/operations/automation-progress.js';

const ops=AUTOMATION_LOOP_NAMES.indexOf('operations_monitor');
function fixture(){let now=Date.parse('2026-10-09T05:00:00Z');const monitor=new AutomationLoopMonitor(()=>now),handles=AUTOMATION_LOOP_NAMES.map(name=>monitor.add(name,async()=>{}));return{monitor,handles,now:()=>now,advance:(ms:number)=>{now+=ms;},run:()=>Promise.all(handles.map(handle=>handle.run())),body:()=>({service:'automation-worker',source:'AUTOMATION_LOOP_PROGRESS',status:monitor.snapshot().ready?'OK':'BLOCKED',observed_at:new Date(now).toISOString(),expires_at:new Date(now+45_000).toISOString(),loops:monitor.snapshot().loops})};}
it('requires all twelve registrations and completed first iterations; polling is counted without effects',async()=>{
 const empty=new AutomationLoopMonitor();expect(empty.snapshot().ready).toBe(false);
 const f=fixture();expect(f.monitor.snapshot().loops).toHaveLength(13);expect(f.monitor.snapshot().ready).toBe(false);
 await f.run();expect(f.monitor.snapshot().ready).toBe(true);expect(f.monitor.snapshot().loops.every(loop=>loop.attempts===1&&loop.successes===1&&loop.failures===0)).toBe(true);
 f.advance(1);await f.run();expect(f.monitor.snapshot().loops.every(loop=>loop.attempts===2&&loop.successes===2)).toBe(true);
 expect(automationLoopMetrics(f.monitor.snapshot())).toContain('commerce_automation_loop_successes_total{loop="automation_inbound"} 2');
 expect(()=>f.monitor.add('automation_commands',async()=>{})).toThrow('CONFIGURATION_INVALID');
});
it('records an immediate failure without leaking its contents and only a real success recovers',async()=>{
 let now=1_000,fail=false;const monitor=new AutomationLoopMonitor(()=>now),handles=AUTOMATION_LOOP_NAMES.map(name=>monitor.add(name,async()=>{if(name==='operations_monitor'&&fail)throw Error('private provider token');}));
 await Promise.all(handles.map(handle=>handle.run()));fail=true;now++;
 await expect(handles[ops]!.run()).rejects.toThrow('private provider token');
 expect(monitor.snapshot()).toMatchObject({ready:false});expect(monitor.snapshot().loops[ops]).toMatchObject({status:'FAILED',attempts:2,successes:1,failures:1,consecutive_failures:1,last_success_at:new Date(1000).toISOString()});
 expect(JSON.stringify(monitor.snapshot())).not.toContain('private provider token');fail=false;now++;await handles[ops]!.run();
 expect(monitor.snapshot().ready).toBe(true);expect(monitor.snapshot().loops[ops]).toMatchObject({status:'OK',attempts:3,successes:2,failures:1,consecutive_failures:0,last_failure_at:new Date(1001).toISOString()});
});
it('does not overlap stalled work and does not turn stopped work into progress',async()=>{
 let now=1_000,release!:()=>void,calls=0;const monitor=new AutomationLoopMonitor(()=>now),held=new Promise<void>(resolve=>release=resolve),loop=monitor.add('automation_agents',async()=>{calls++;await held;});
 const pending=loop.run();await loop.run();expect(calls).toBe(1);now+=AUTOMATION_LOOP_DEADLINE_MS+1;
 expect(monitor.snapshot().loops[0]).toMatchObject({status:'STALLED',attempts:1,successes:0,running:true});
 loop.stop();release();await pending;await loop.run();expect(calls).toBe(1);expect(monitor.snapshot().loops[0]).toMatchObject({status:'STOPPED',attempts:1,successes:1,running:false});
});
it('rejects stale or incomplete persisted evidence even if its publisher says OK',async()=>{
 const f=fixture();await f.run();const body=f.body(),now=new Date(f.now()),loops=body.loops;
 expect(automationProgress(body,now).ready).toBe(true);
 expect(automationProgress({...body,source:'local_probe'},now).code).toBe('AUTOMATION_LOOPS_NOT_READY');
 for(const bad of [[],loops.slice(1),[...loops.slice(1),loops[1]],loops.map((loop,i)=>i===0?{...loop,required:false}:loop),loops.map((loop,i)=>i===0?{...loop,successes:0}:loop),loops.map((loop,i)=>i===0?{...loop,attempts:55}:loop),loops.map((loop,i)=>i===0?{...loop,deadline_ms:3600000}:loop),loops.map((loop,i)=>i===0?{...loop,status:'FAILED',consecutive_failures:1}:loop)])expect(automationProgress({...body,loops:bad},now).ready).toBe(false);
 f.advance(AUTOMATION_LOOP_DEADLINE_MS+1);expect(f.monitor.snapshot().ready).toBe(false);
 expect(automationProgress({...body,observed_at:new Date(f.now()).toISOString(),expires_at:new Date(f.now()+45000).toISOString()},new Date(f.now())).code).toBe('AUTOMATION_LOOPS_NOT_READY');
 expect(automationProgress(body,new Date(f.now())).code).toBe('AUTOMATION_WORKER_STALE');
});
it('re-evaluates an in-flight loop at read time without requiring stored running_ms to tick',async()=>{
 const f=fixture();await f.run();const body=f.body(),start=f.now();body.loops[0]={...body.loops[0]!,running:true,attempts:2,running_ms:0};
 expect(automationProgress(body,new Date(start+10_000)).ready).toBe(true);
 expect(automationProgress({...body,loops:body.loops.map((loop,i)=>i===0?{...loop,last_started_at:new Date(start-180001).toISOString()}:loop)},new Date(start)).ready).toBe(false);
});
