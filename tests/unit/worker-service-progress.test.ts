import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../../packages/db/src/index.js',()=>({query:vi.fn(async()=>({rows:[]}))}));
import {workerService} from '../../packages/jobs/src/index.js';
import {query} from '../../packages/db/src/index.js';
let service:Awaited<ReturnType<typeof workerService>>|undefined;
afterEach(async()=>{await service?.close();service=undefined;vi.restoreAllMocks();});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
it('combines complete loop progress, main tick and independent heartbeat without masking failures',async()=>{
 let ready=false,failHeartbeat=false,failTick=false,heartbeats=0;vi.spyOn(process.stderr,'write').mockReturnValue(true);
 service=await workerService('automation-worker',0,async()=>{if(failTick)throw Error('private tick');},60000,{progress:()=>({ready,code:ready?'READY':'AUTOMATION_LOOPS_NOT_READY',loops:[]}),heartbeat:async()=>{heartbeats++;if(failHeartbeat)throw Error('private heartbeat');},metrics:()=> 'fixture_metric 1\n'});await settle();
 const health=()=>service!.app.inject({url:'/readyz'});
 expect((await health()).statusCode).toBe(503);ready=true;expect((await health()).statusCode).toBe(200);
 failHeartbeat=true;await service.heartbeat();const blocked=await health();expect(blocked.statusCode).toBe(503);expect(blocked.json().code).toBe('WORKER_HEARTBEAT_FAILED');
 await service.run();expect((await health()).statusCode).toBe(503);
 failHeartbeat=false;await service.heartbeat();expect((await health()).statusCode).toBe(200);
 failTick=true;await service.run();expect((await health()).json().code).toBe('WORKER_TICK_FAILED');
 failTick=false;await service.run();expect((await health()).statusCode).toBe(200);expect(heartbeats).toBe(3);
 expect((await service.app.inject({url:'/metrics'})).body).toContain('fixture_metric 1');expect(JSON.stringify(blocked.json())).not.toContain('private');
});
it('keeps a stalled heartbeat non-overlapping and unavailable, then recovers after its completion',async()=>{
 let now=1000,calls=0,release!:()=>void;vi.spyOn(Date,'now').mockImplementation(()=>now);
 service=await workerService('automation-worker',0,async()=>{},60000,{progress:()=>({ready:true,code:'READY',loops:[]}),heartbeat:()=>{calls++;return new Promise<void>(resolve=>release=resolve);}});await settle();
 expect((await service.app.inject({url:'/readyz'})).json().code).toBe('WORKER_HEARTBEAT_STARTING');
 now+=46_000;await service.heartbeat();expect(calls).toBe(1);expect((await service.app.inject({url:'/readyz'})).statusCode).toBe(503);
 release();await settle();expect((await service.app.inject({url:'/readyz'})).statusCode).toBe(200);
 now+=46_000;expect((await service.app.inject({url:'/readyz'})).json().code).toBe('WORKER_HEARTBEAT_STALE');
 vi.mocked(query).mockRejectedValueOnce(Error('secret DB message'));const response=await service.app.inject({url:'/readyz'});expect(response.statusCode).toBe(503);expect(response.json()).toEqual({ok:false,code:'DB_UNAVAILABLE'});
});
