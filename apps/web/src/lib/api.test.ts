import {afterEach,describe,expect,it,vi} from 'vitest';
import {api} from './api.js';

afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

describe('bounded browser API reads',()=>{
 it('turns a stalled read into an actionable timeout after fifteen seconds',async()=>{
  vi.useFakeTimers();
  vi.stubGlobal('fetch',vi.fn((_url:unknown,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('synthetic timeout','AbortError')),{once:true}))));
	  const pending=api('/synthetic-slow?environment=REAL'),assertion=expect(pending).rejects.toMatchObject({code:'REQUEST_TIMEOUT',status:0});
  await vi.advanceTimersByTimeAsync(15_000);
 await assertion;
 });

 it('keeps the deadline active while a response body is stalled',async()=>{
  vi.useFakeTimers();
  vi.stubGlobal('fetch',vi.fn((_url:unknown,init?:RequestInit)=>Promise.resolve({
   status:200,
   ok:true,
   headers:new Headers(),
   json:()=>new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('synthetic stalled body','AbortError')),{once:true})),
  } as Response)));
	  const pending=api('/synthetic-stalled-body?environment=REAL'),assertion=expect(pending).rejects.toMatchObject({code:'REQUEST_TIMEOUT',status:0});
  await vi.advanceTimersByTimeAsync(15_000);
  await assertion;
 });

 it('preserves caller cancellation instead of misreporting it as a server timeout',async()=>{
  const controller=new AbortController();
  vi.stubGlobal('fetch',vi.fn((_url:unknown,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('caller cancelled','AbortError')),{once:true}))));
  const pending=api('/synthetic-cancel?environment=REAL',{signal:controller.signal});
  controller.abort('navigation');
  await expect(pending).rejects.toMatchObject({name:'AbortError'});
 });
});
