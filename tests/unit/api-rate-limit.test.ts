import {expect,it,vi} from 'vitest';
import {createApp} from '../../apps/api/src/app.js';
import {pool} from '../../packages/db/src/index.js';

it('returns actionable RATE_LIMITED at request301 with the original HTTP429 and Retry-After',async()=>{
 const query=vi.spyOn(pool,'query'),app=await createApp();
 try{
  for(let i=0;i<300;i++)expect((await app.inject({method:'GET',url:'/livez'})).statusCode).toBe(200);
  const denied=await app.inject({method:'GET',url:'/livez'});
  expect(denied.statusCode).toBe(429);expect(denied.json().error.code).toBe('RATE_LIMITED');
  expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);expect(denied.headers['x-ratelimit-limit']).toBe('300');
  expect(query).not.toHaveBeenCalled();
 }finally{await app.close();query.mockRestore();}
});

it('preserves explicit error codes and the fallback for non429 errors',async()=>{
 const app=await createApp();
 app.get('/coded-limit-fixture',async()=>{throw Object.assign(new Error('Fixture limit'),{statusCode:429,code:'SPECIFIC_LIMIT'});});
 app.get('/internal-fixture',async()=>{throw new Error('Fixture private detail');});
 try{
  const coded=await app.inject('/coded-limit-fixture');expect(coded.statusCode).toBe(429);expect(coded.json().error.code).toBe('SPECIFIC_LIMIT');
  const internal=await app.inject('/internal-fixture');expect(internal.statusCode).toBe(500);expect(internal.json().error.code).toBe('INTERNAL_ERROR');expect(internal.body).not.toContain('private detail');
 }finally{await app.close();}
});
