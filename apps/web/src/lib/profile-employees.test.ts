import {afterEach,describe,expect,it,vi} from 'vitest';
import {loadProfileEmployees,saveProfileEmployee} from './profile-employees.js';
const fence={workspaceId:'own',version:3},row={user_id:'employee',name:'Synthetic Employee',email:'employee@example.test',role:'operator',active:true,version:2};
const input={expectedVersion:2,role:'viewer',active:false};
const response=(data:unknown)=>new Response(JSON.stringify({data}),{status:200});
afterEach(()=>vi.unstubAllGlobals());
describe('employee transport bound to current profile selection',()=>{
 it('reads only exact v2 with authenticated session and selection fence',async()=>{
  const fetch=vi.fn(async()=>response([row]));vi.stubGlobal('fetch',fetch);expect(await loadProfileEmployees(fence)).toEqual([row]);expect(fetch).toHaveBeenCalledWith('/v2/employees',expect.objectContaining({method:'GET',credentials:'include',cache:'no-store',headers:{'x-commerce-profile-id':'own','x-commerce-profile-version':'3'}}));
 });
 it('sends one closed versioned PATCH and verifies exact target/result',async()=>{
  const result={user_id:'employee',role:'viewer',active:false,version:3,changed:true},fetch=vi.fn(async()=>response(result));vi.stubGlobal('fetch',fetch);
  expect(await saveProfileEmployee(fence,'employee',input)).toEqual(result);expect(fetch).toHaveBeenCalledOnce();expect(fetch.mock.calls[0]).toEqual(['/v2/employees/employee',expect.objectContaining({method:'PATCH',body:JSON.stringify(input)})]);
 });
 it('encodes a legacy text identity as one path segment',async()=>{
  const fetch=vi.fn(async()=>response({user_id:'employee/?#',role:'viewer',active:false,version:3,changed:true}));vi.stubGlobal('fetch',fetch);await saveProfileEmployee(fence,'employee/?#',input);expect(fetch).toHaveBeenCalledWith('/v2/employees/employee%2F%3F%23',expect.any(Object));
 });
 it('never retries an unknown transport or rejected result',async()=>{
  const fetch=vi.fn(async()=>{throw new Error('timeout');});vi.stubGlobal('fetch',fetch);await expect(saveProfileEmployee(fence,'employee',input)).rejects.toThrow('Actualiza');expect(fetch).toHaveBeenCalledOnce();
 });
 it.each([{user_id:'other',role:'viewer',active:false,version:3,changed:true},{user_id:'employee',role:'owner',active:false,version:3,changed:true},{user_id:'employee',role:'viewer',active:false,version:4,changed:true}])('rejects result target/authority/version drift %#',async value=>{vi.stubGlobal('fetch',vi.fn(async()=>response(value)));await expect(saveProfileEmployee(fence,'employee',input)).rejects.toThrow('Actualiza');});
 it('rejects duplicate identities, unadopted roles and oversized bodies',async()=>{
  for(const value of [[row,row],[{...row,role:'seller'}]]){vi.stubGlobal('fetch',vi.fn(async()=>response(value)));await expect(loadProfileEmployees(fence)).rejects.toThrow('confirmar');}
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(' '.repeat(1048577))));await expect(loadProfileEmployees(fence)).rejects.toThrow('consultar');
 });
 it('rejects invalid input before fetch and does not accept null selection',async()=>{
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(saveProfileEmployee(fence,'employee',{...input,workspaceId:'other'})).rejects.toThrow();await expect(loadProfileEmployees({workspaceId:'',version:0})).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
 });
});
