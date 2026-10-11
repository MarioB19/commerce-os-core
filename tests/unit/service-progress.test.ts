import {expect,it} from 'vitest';
import {channelProgress} from '../../packages/domain/src/operations/service-progress.js';

const now=new Date('2026-09-27T12:00:00Z');
const loop={name:'ownership_heartbeat',required:true,status:'OK',running:false,last_started_at:'2026-09-27T11:59:59Z',last_success_at:'2026-09-27T11:59:59Z',consecutive_failures:0,deadline_ms:45_000};
const heartbeat={service:'channel-worker',status:'OK',observed_at:'2026-09-27T11:59:59Z',expires_at:'2026-09-27T12:00:44Z',source:'CHANNEL_LOOP_PROGRESS',loops:[loop]};

it('distinguishes missing, stale, degraded and healthy worker evidence',()=>{
 expect(channelProgress(undefined,now).code).toBe('CHANNEL_WORKER_UNAVAILABLE');
 expect(channelProgress({...heartbeat,service:'automation-worker'},now).code).toBe('CHANNEL_WORKER_UNAVAILABLE');
 for(const delta of [{observed_at:'invalid'},{observed_at:'2026-09-27T12:00:01Z'},{expires_at:'invalid'},{expires_at:now.toISOString()}])expect(channelProgress({...heartbeat,...delta},now).code).toBe('CHANNEL_WORKER_STALE');
 expect(channelProgress({...heartbeat,status:'BLOCKED'},now).code).toBe('CHANNEL_WORKER_BLOCKED');
 expect(channelProgress(heartbeat,now)).toEqual({ready:true,code:'READY'});
});

it('rechecks required loop progress even when the publisher says OK and is fresh',()=>{
 for(const status of ['STARTING','FAILED','STALLED','STALE','STOPPED'])expect(channelProgress({...heartbeat,loops:[{...loop,status}]},now).code).toBe('CHANNEL_LOOPS_NOT_READY');
 for(const loops of [[],undefined,[null],[{...loop,required:undefined}],[{...loop,last_success_at:'invalid'}],[{...loop,last_success_at:'2026-09-27T12:00:01Z'}],[{...loop,last_success_at:'2026-09-27T11:59:00Z'}],[{...loop,deadline_ms:0}],[{...loop,consecutive_failures:1}],[{...loop,running:true,last_started_at:'2026-09-27T11:59:00Z'}]])expect(channelProgress({...heartbeat,loops},now).code).toBe('CHANNEL_LOOPS_NOT_READY');
 expect(channelProgress({...heartbeat,loops:[loop,{...loop,name:'discovery',required:false,status:'STALLED'}]},now).ready).toBe(true);
});

it('preserves the legacy heartbeat contract during rollout without weakening progress evidence',()=>{
 expect(channelProgress({...heartbeat,source:'persistHeartbeat',loops:undefined},now).ready).toBe(true);
 expect(channelProgress({...heartbeat,source:'persistHeartbeat',loops:undefined,status:'BLOCKED'},now).ready).toBe(false);
});
