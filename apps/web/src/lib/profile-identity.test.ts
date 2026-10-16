import {afterEach,describe,expect,it,vi} from 'vitest';
import {loadProfiles,selectProfile} from './profile-identity.js';
import {api} from './api.js';
const bootstrap={profiles:[{id:'business',businessName:'Negocio de prueba',state:'ACTIVE',timezone:'America/Mexico_City',role:'operator',membershipVersion:1,selected:true}],selection:{workspaceId:'business',version:2}};
function reply(data:unknown,status=200){return new Response(JSON.stringify({data}),{status,headers:{'Content-Type':'application/json'}});}
afterEach(()=>vi.unstubAllGlobals());
describe('interactive profile transport',()=>{
 it('uses the native cookie identity endpoint without workspace/environment or bearer headers',async()=>{
  const fetch=vi.fn().mockResolvedValue(reply(bootstrap));vi.stubGlobal('fetch',fetch);
  expect(await loadProfiles()).toEqual(bootstrap);
  const [path,init]=fetch.mock.calls[0];expect(path).toBe('/v2/me/profiles');expect(init.credentials).toBe('include');expect(init.headers).toEqual({});
 });
 it('preserves explicit REAL for existing business endpoints',async()=>{
  const fetch=vi.fn().mockResolvedValue(reply([]));vi.stubGlobal('fetch',fetch);await api('/products');expect(fetch.mock.calls[0][0]).toBe('/v1/products?environment=REAL');
 });
 it('sends only target and CAS version exactly once',async()=>{
  const fetch=vi.fn().mockResolvedValue(reply({workspaceId:'business',version:3}));vi.stubGlobal('fetch',fetch);
  expect(await selectProfile('business',2)).toEqual({workspaceId:'business',version:3});expect(fetch).toHaveBeenCalledTimes(1);
  const [path,init]=fetch.mock.calls[0];expect(path).toBe('/v2/me/profile-selection');expect(init.method).toBe('POST');expect(JSON.parse(init.body)).toEqual({workspaceId:'business',expectedVersion:2});expect(init.headers.Authorization).toBeUndefined();
 });
 it('does not replay failed, incomplete or mismatched responses and requests readback',async()=>{
  for(const response of [reply({workspaceId:'other',version:3}),reply({workspaceId:'business',version:2}),new Response('incomplete',{status:200}),reply({},409)]){
   const fetch=vi.fn().mockResolvedValue(response);vi.stubGlobal('fetch',fetch);
   await expect(selectProfile('business',2)).rejects.toThrow('Actualiza los perfiles');expect(fetch).toHaveBeenCalledTimes(1);
  }
  const fetch=vi.fn().mockRejectedValue(new Error('connection lost'));vi.stubGlobal('fetch',fetch);await expect(selectProfile('business',2)).rejects.toThrow('Actualiza los perfiles');expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('rejects duplicate profiles, forged selection and legacy roles before display',async()=>{
  for(const data of [{...bootstrap,profiles:[...bootstrap.profiles,...bootstrap.profiles]}, {...bootstrap,selection:{workspaceId:'other',version:2}}, {...bootstrap,selection:{workspaceId:'business',version:0}}, {...bootstrap,profiles:[{...bootstrap.profiles[0],role:'seller'}]}]){
   vi.stubGlobal('fetch',vi.fn().mockResolvedValue(reply(data)));await expect(loadProfiles()).rejects.toThrow('confirmar la lista');
  }
 });
 it('accepts no selection with a retained CAS version after a membership change',async()=>{
  const data={...bootstrap,profiles:[{...bootstrap.profiles[0],selected:false}],selection:{workspaceId:null,version:2}};vi.stubGlobal('fetch',vi.fn().mockResolvedValue(reply(data)));expect(await loadProfiles()).toEqual(data);
 });
});
