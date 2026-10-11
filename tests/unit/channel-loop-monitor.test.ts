import {describe,expect,it,vi} from 'vitest';
import {ChannelLoopMonitor,channelLoopMetrics} from '../../apps/channel-worker/src/loop-monitor.js';

describe('channel scheduler progress',()=>{
 it('does not report ready before required work succeeds, after it stops, or when its progress becomes stale',async()=>{
  let now=1_000;const monitor=new ChannelLoopMonitor(()=>now);
  expect(monitor.snapshot().ready).toBe(false);
  const loop=monitor.add('dispatch',async()=>{}, {deadlineMs:100});
  expect(monitor.snapshot().loops[0]?.status).toBe('STARTING');
  await loop.run();expect(monitor.snapshot().ready).toBe(true);
  now+=101;expect(monitor.snapshot()).toMatchObject({ready:false,loops:[{status:'STALE'}]});
  await loop.run();expect(monitor.snapshot().ready).toBe(true);
  loop.stop();await loop.run();expect(monitor.snapshot()).toMatchObject({ready:false,loops:[{status:'STOPPED'}]});
 });
 it('detects a stuck promise without launching duplicate work and keeps ownership work independent',async()=>{
  let now=1_000,release!:()=>void,discoveryCalls=0,renewals=0;
  const held=new Promise<void>(resolve=>release=resolve),monitor=new ChannelLoopMonitor(()=>now);
  const discovery=monitor.add('discovery',async()=>{discoveryCalls++;await held;},{deadlineMs:100,required:false});
  const ownership=monitor.add('ownership',async()=>{renewals++;},{deadlineMs:100});
  const inFlight=discovery.run();await discovery.run();await ownership.run();
  now+=101;await ownership.run();expect(renewals).toBe(2);expect(discoveryCalls).toBe(1);
  expect(monitor.snapshot()).toMatchObject({ready:true,loops:[{name:'discovery',status:'STALLED'},{name:'ownership',status:'OK'}]});
  release();await inFlight;expect(monitor.snapshot().loops[0]?.status).toBe('OK');
 });
 it('makes failed and stalled critical work unavailable, then recovers only after success',async()=>{
  let now=1_000,fail=true,release!:()=>void;const monitor=new ChannelLoopMonitor(()=>now),stderr=vi.spyOn(process.stderr,'write').mockReturnValue(true);
  const loop=monitor.add('dispatch',async()=>{if(fail)throw Error('private provider details');},{deadlineMs:100});
  try{
   await loop.run();expect(monitor.snapshot()).toMatchObject({ready:false,loops:[{status:'FAILED',consecutive_failures:1}]});
   expect(stderr).toHaveBeenCalledWith('dispatch_failed; durable facts preserved\n');
   fail=false;await loop.run();expect(monitor.snapshot()).toMatchObject({ready:true,loops:[{status:'OK',consecutive_failures:0}]});
   const blocked=monitor.add('ownership',()=>new Promise<void>(resolve=>release=resolve),{deadlineMs:100}),pending=blocked.run();
   now+=101;expect(monitor.snapshot()).toMatchObject({ready:false,loops:[{status:'STALE'},{status:'STALLED'}]});
   expect(channelLoopMetrics(monitor.snapshot())).toContain('commerce_channel_loop_running{loop="ownership"} 1');
   expect(JSON.stringify(monitor.snapshot())).not.toContain('private provider details');
   release();await pending;
  }finally{stderr.mockRestore();}
 });
});
