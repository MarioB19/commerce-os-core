import {describe,it,expect,vi} from 'vitest';
import {processNumberLabWorkflows} from './workflows.js';
import {createNumberLabEngineRuntime} from '../../../packages/db/src/number-lab-engine-runtime.js';
import type {ProfilePool,ProfileQuery} from '../../../packages/db/src/profile-context.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const identity={database:'commerce_lab_engine_unit',installationId:id(1),engineSha256:'a'.repeat(64)},binding={runId:id(2),operationId:id(3),snapshotSha256:'b'.repeat(64)};
function fixture(){
 let live=true;const queries:{sql:string;values:unknown[]|undefined}[]=[];
 const query=vi.fn(async(sql:string,values?:unknown[])=>{queries.push({sql,values});
  const rows=sql.includes('pg_roles')?[{database:identity.database,database_name:identity.database,role:'commerce_lab_engine',rolcanlogin:false,rolinherit:false,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,memberships:false,installation_id:identity.installationId,engine_sha256:identity.engineSha256}]:sql.includes('engine.executions')?[{run_id:binding.runId,operation_id:binding.operationId,snapshot_sha256:binding.snapshotSha256,engine_sha256:identity.engineSha256,workspace_id:'number-lab:'+binding.runId,state:'INTENT',live}]:[];
  return{command:sql==='COMMIT'?'COMMIT':'SELECT',rowCount:rows.length,fields:[],oid:0,rows};
 });const pool:ProfilePool={connect:vi.fn(async()=>({query:query as ProfileQuery,release:vi.fn()}))};
 return{runtime:createNumberLabEngineRuntime(pool,identity),query,queries,expire(){live=false;}};
}
describe('canonical workflows through the number-lab lease',()=>{
 it('executes all three canonical scans in separate committed native phases',async()=>{const f=fixture(),lease=await f.runtime.lease(binding);expect(await processNumberLabWorkflows(lease,2)).toEqual({workflows:0,timers:0});
  const scans=f.queries.filter(x=>x.sql.includes("kind='conversation'")||x.sql.startsWith('SELECT t.id FROM timers'));
  expect(scans).toHaveLength(3);expect(scans.map(x=>x.values)).toEqual([[2],[8],[2]]);expect(f.queries.filter(x=>x.sql==='COMMIT')).toHaveLength(4);
  expect(f.queries.some(x=>/INSERT|UPDATE|DELETE/.test(x.sql))).toBe(false);
 });
 it.each([0,26,-1,1.5,Infinity,NaN])('rejects invalid batch %s before consuming a lease',async limit=>{const f=fixture(),lease=await f.runtime.lease(binding),before=f.queries.length;await expect(processNumberLabWorkflows(lease,limit)).rejects.toThrow('LAB_ENGINE_BATCH_LIMIT');expect(f.queries).toHaveLength(before);await expect(processNumberLabWorkflows(lease,1)).resolves.toEqual({workflows:0,timers:0});});
 it('does not fall back to the commercial pool for an identical forged lease',async()=>{const f=fixture(),lease=await f.runtime.lease(binding),before=f.queries.length;await expect(processNumberLabWorkflows({...lease})).rejects.toThrow('LAB_ENGINE_LEASE_REQUIRED');expect(f.queries).toHaveLength(before);});
 it('stops all later scans if the native execution expires during the first scan',async()=>{const f=fixture(),lease=await f.runtime.lease(binding),base=f.query.getMockImplementation()!;f.query.mockImplementation(async(sql,values)=>{const result=await base(sql,values);if(sql.includes("body ? 'offer_version_id'"))f.expire();return result;});await expect(processNumberLabWorkflows(lease)).rejects.toThrow('LAB_ENGINE_BINDING_REQUIRED');expect(f.queries.some(x=>x.sql.startsWith('SELECT t.id FROM timers'))).toBe(false);expect(f.queries.filter(x=>x.sql==='ROLLBACK')).toHaveLength(1);});
 it('never replays a consumed execution',async()=>{const f=fixture(),lease=await f.runtime.lease(binding);await processNumberLabWorkflows(lease);const before=f.queries.length;await expect(processNumberLabWorkflows(lease)).rejects.toThrow('LAB_ENGINE_LEASE_REQUIRED');expect(f.queries).toHaveLength(before);});
});
