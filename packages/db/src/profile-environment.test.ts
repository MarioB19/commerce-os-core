import {describe,it,expect} from 'vitest';
import {bindProfileEnvironment} from './profile-environment.js';
import type {ProfileExecutor,ProfileQuery} from './profile-context.js';
describe('profile SQL environment binding',()=>{
 function fixture(workspace='one',existing:string|null=null){
  const calls:{sql:string;values?:unknown[]}[]=[];let environment=existing;
  const db:ProfileExecutor={workspaceId:'one',query:(async(sql,values)=>{
   calls.push({sql,values});const valid=workspace===values?.[0]&&(!environment||environment===values?.[1]);
   if(valid)environment=String(values?.[1]);
   return{rows:[{environment:valid?environment:null}],rowCount:1,command:'SELECT',oid:0,fields:[]};
  })as ProfileQuery};
  return{db,calls,environment:()=>environment};
 }
 it('binds a fixed environment in one local statement without reading data',async()=>{
  const f=fixture();await bindProfileEnvironment(f.db,'REAL');expect(f.environment()).toBe('REAL');expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.values).toEqual(['one','REAL']);expect(f.calls[0]?.sql).toContain("set_config('app.environment',$2,true)");
 });
 it('allows the same binding and refuses a different environment',async()=>{
  const f=fixture('one','REAL');await bindProfileEnvironment(f.db,'REAL');await expect(bindProfileEnvironment(f.db,'SIMULATION')).rejects.toThrow('PROFILE_ENVIRONMENT_CONTEXT_MISMATCH');expect(f.environment()).toBe('REAL');
 });
 it('rejects a raw connection or mismatched profile without setting environment',async()=>{
  for(const workspace of ['', 'other']){const f=fixture(workspace);await expect(bindProfileEnvironment(f.db,'REAL')).rejects.toThrow('PROFILE_ENVIRONMENT_CONTEXT_MISMATCH');expect(f.environment()).toBeNull();}
 });
 it('rejects invalid environment before SQL',async()=>{
  const f=fixture();await expect(bindProfileEnvironment(f.db,'UNKNOWN' as 'REAL')).rejects.toThrow('PROFILE_ENVIRONMENT_INVALID');expect(f.calls).toHaveLength(0);
 });
});
