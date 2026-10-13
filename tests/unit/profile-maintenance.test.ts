import {describe,expect,it,vi} from 'vitest';
import {runChannelProfileMaintenance} from '../../apps/channel-worker/src/profile-maintenance.js';
import {processProfileQrWarmup} from '../../apps/automation-worker/src/profile-warmup.js';
import type {WorkerProfileSelection} from '../../packages/db/src/profile-worker-scope.js';

const selection=(workspaceId:string,state:'ACTIVE'|'SUSPENDED'='ACTIVE')=>({workspaceId,state,version:1,environment:'REAL'}) as WorkerProfileSelection;
function runtime(selections:WorkerProfileSelection[]){const run=vi.fn((_s:WorkerProfileSelection,work:()=>Promise<unknown>)=>work());return{discover:vi.fn(async()=>selections),run:run as unknown as (<T>(s:WorkerProfileSelection,work:()=>Promise<T>)=>Promise<T>)&typeof run};}
vi.mock('../../packages/db/src/profile-worker-scope.js',async importActual=>({...(await importActual<object>()),withWorkerProfilePhase:async(fn:(db:unknown)=>unknown)=>fn({workspaceId:'phase'})}));
describe('V7 profile-scoped worker maintenance',()=>{
 it('runs expiry and QR continuity only for ACTIVE profiles and reports every profile',async()=>{
  const r=runtime([selection('a'),selection('s','SUSPENDED'),selection('b')]),expire=vi.fn(async()=>2),connections=vi.fn(async(_workspace:string)=>({registered:1,deferred:0,failures:[] as string[]}));
  expect(await runChannelProfileMaintenance({runtime:r,expire,connections})).toEqual({skipped:null,profiles:[{profile:'a',expired:2,registered:1},{profile:'b',expired:2,registered:1}]});
  expect(r.run).toHaveBeenCalledTimes(2);expect(connections.mock.calls.map(c=>c[0])).toEqual(['a','b']);
 });
 it('isolates one profile failure, still processes the rest and then reports it',async()=>{
  const r=runtime([selection('a'),selection('b')]),expire=vi.fn(async()=>{if(expire.mock.calls.length===1)throw Object.assign(Error('EXPIRY_PROFILE_REQUIRED'),{code:'EXPIRY_PROFILE_REQUIRED'});return 0;}),connections=vi.fn(async(_workspace:string)=>({registered:0,deferred:0,failures:[] as string[]}));
  await expect(runChannelProfileMaintenance({runtime:r,expire,connections})).rejects.toMatchObject({code:'PROFILE_MAINTENANCE_PARTIAL',profiles:[{profile:'a',error:'EXPIRY_PROFILE_REQUIRED'},{profile:'b',expired:0,registered:0}]});
 });
 it('plans QR-continuous warm-up per ACTIVE profile without touching suspended ones',async()=>{
  const r=runtime([selection('a'),selection('s','SUSPENDED')]),process=vi.fn(async()=>({enrolled:0,results:[{}],externalEffects:0 as const}));
  expect(await processProfileQrWarmup({runtime:r,process})).toEqual({skipped:null,profiles:[{profile:'a',planned:1}]});expect(process).toHaveBeenCalledTimes(1);
 });
 it('skips profile jobs outside a reviewed runtime login (local development)',async()=>{
  expect(await runChannelProfileMaintenance()).toEqual({skipped:'RUNTIME_LOGIN_REQUIRED',profiles:[]});
  expect(await processProfileQrWarmup()).toEqual({skipped:'RUNTIME_LOGIN_REQUIRED',profiles:[]});
 });
});
