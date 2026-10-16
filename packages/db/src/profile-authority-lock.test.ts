import {describe,expect,it,vi} from 'vitest';
import {lockProfileAuthorityChange} from './profile-authority-lock.js';
import type {ProfileExecutor,ProfileQuery} from './profile-context.js';
function fixture(locked:unknown=true){
 const query=vi.fn(async(sql:string,values?:unknown[])=>({sql,values,rows:[{locked}],rowCount:1,command:'SELECT',fields:[],oid:0}));
 return{query,db:{workspaceId:'tenant\'quoted',query:query as ProfileQuery} satisfies ProfileExecutor};
}
describe('profile authority change admission',()=>{
 it.each(['employees:write','tokens:write','profile:write'] as const)('serializes the fixed administrative action %s with a parameterized namespace',async scope=>{
  const f=fixture();await lockProfileAuthorityChange(f.db,{scope,mutation:true});
  expect(f.query).toHaveBeenCalledWith(expect.stringContaining('pg_try_advisory_xact_lock'),[f.db.workspaceId]);
  expect(f.query.mock.calls[0][0]).not.toContain(f.db.workspaceId);
 });
 it('does not serialize ordinary business work or profile reads',async()=>{
  const f=fixture();await lockProfileAuthorityChange(f.db,{scope:'products:write',mutation:true});await lockProfileAuthorityChange(f.db,{scope:'profile:read',mutation:false});expect(f.query).not.toHaveBeenCalled();
 });
 it.each([false,null,1,'true'])('fails closed for a non-true lock result %s',async locked=>{
  await expect(lockProfileAuthorityChange(fixture(locked).db,{scope:'tokens:write',mutation:true})).rejects.toMatchObject({code:'PROFILE_AUTHORITY_BUSY',statusCode:409});
 });
 it('rejects an administrative action incorrectly labelled as a read',async()=>{
  const f=fixture();await expect(lockProfileAuthorityChange(f.db,{scope:'employees:write',mutation:false})).rejects.toThrow('PROFILE_ADMINISTRATIVE_ACTION_INVALID');expect(f.query).not.toHaveBeenCalled();
 });
});
