import {afterEach,describe,expect,it,vi} from 'vitest';
import {loadProfileSettings,saveProfileSettings} from './profile-settings.js';
const fence={workspaceId:'one',version:3};
const summary={id:'one',business_name:'Synthetic',timezone:'UTC',version:2,state:'ACTIVE',number_limit:2,product_limit:10,daily_conversation_limit:100};
const input={expectedVersion:2,businessName:'Edited',timezone:'America/Mexico_City'};
const saved={id:'one',business_name:input.businessName,timezone:input.timezone,version:3,changed:true};
const response=(data:unknown,status=200)=>new Response(JSON.stringify({data}),{status,headers:{'Content-Type':'application/json'}});
afterEach(()=>vi.unstubAllGlobals());
describe('native selected profile settings transport',()=>{
 it('uses only the exact v2 endpoint, native cookies and observed fence without legacy environment selectors',async()=>{
  const fetch=vi.fn().mockResolvedValue(response(summary));vi.stubGlobal('fetch',fetch);expect(await loadProfileSettings(fence)).toEqual(summary);
  expect(fetch).toHaveBeenCalledOnce();const[path,options]=fetch.mock.calls[0];expect(path).toBe('/v2/profile');expect(options.credentials).toBe('include');expect(options.cache).toBe('no-store');expect(options.headers).toEqual({'x-commerce-profile-id':'one','x-commerce-profile-version':'3'});expect(options.method).toBe('GET');
 });
 it('sends a single validated PATCH and requires the exact own-profile versioned readback',async()=>{
  const fetch=vi.fn().mockResolvedValue(response(saved));vi.stubGlobal('fetch',fetch);expect(await saveProfileSettings(fence,input)).toEqual(saved);
  expect(fetch).toHaveBeenCalledOnce();const[path,options]=fetch.mock.calls[0];expect(path).toBe('/v2/profile');expect(options.method).toBe('PATCH');expect(JSON.parse(options.body)).toEqual(input);expect(options.headers.Authorization).toBeUndefined();
 });
 it('rejects stale, foreign, incomplete or mismatched write responses without replay',async()=>{
  for(const data of [{...saved,id:'two'},{...saved,version:2},{...saved,business_name:'Other'},{...saved,timezone:'UTC'},{...saved,changed:false}]){
   const fetch=vi.fn().mockResolvedValue(response(data));vi.stubGlobal('fetch',fetch);await expect(saveProfileSettings(fence,input)).rejects.toThrow('Actualiza');expect(fetch).toHaveBeenCalledOnce();
  }
  const fetch=vi.fn().mockRejectedValue(new Error('connection lost'));vi.stubGlobal('fetch',fetch);await expect(saveProfileSettings(fence,input)).rejects.toThrow('Actualiza');expect(fetch).toHaveBeenCalledOnce();
 });
 it('accepts an explicit no-op only with unchanged version and matching values',async()=>{
  const value={...saved,version:2,changed:false};vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(value)));expect(await saveProfileSettings(fence,input)).toEqual(value);
 });
 it('rejects invalid input or missing selection before fetch',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  await expect(saveProfileSettings(fence,{...input,workspaceId:'two'})).rejects.toThrow();await expect(saveProfileSettings(fence,{...input,timezone:'invalid'})).rejects.toThrow();await expect(loadProfileSettings({...fence,version:0})).rejects.toThrow('Elige');expect(fetch).not.toHaveBeenCalled();
 });
 it('rejects cross-profile or oversized reads and closed-envelope violations',async()=>{
  for(const reply of [response({...summary,id:'two'}),new Response(JSON.stringify({data:summary,unexpected:true})),new Response('x'.repeat(8193))]){const fetch=vi.fn().mockResolvedValue(reply);vi.stubGlobal('fetch',fetch);await expect(loadProfileSettings(fence)).rejects.toThrow();expect(fetch).toHaveBeenCalledOnce();}
 });
 it('propagates cancellation to fetch without another request',async()=>{
  const controller=new AbortController();controller.abort();const fetch=vi.fn(async(_path:string,options:RequestInit)=>{expect(options.signal?.aborted).toBe(true);throw new Error('aborted');});vi.stubGlobal('fetch',fetch);await expect(loadProfileSettings(fence,controller.signal)).rejects.toThrow('consultar');expect(fetch).toHaveBeenCalledOnce();
 });
});
