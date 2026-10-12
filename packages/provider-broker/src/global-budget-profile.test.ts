import {describe,it,expect,vi} from 'vitest';
import {withProfileQueryRouting} from '../../db/src/profile-query-routing.js';
import type {ProfileQuery} from '../../db/src/profile-context.js';
import {readGlobalBudget,assertGlobalBudgetCapacity} from './global-budget.js';
const state=()=>({configured:true,limit_usd:'10.000000',spent_usd:'2.000000',reserved_usd:'3.000000',external_reserved_usd:'1.000000',unknown_cost_operations:'2',version:1,expires_at:new Date('2030-01-01T00:00:00Z'),expired:false,external_status:'NONE',external_expired:false});
const foreign={query:vi.fn(async()=>{throw Error('UNSCOPED_QUERY_FORBIDDEN');})};
describe('profile global creative budget port',()=>{
 it('uses the actual profile executor and exposes only the fixed aggregate',async()=>{
  const query=vi.fn(async()=>({rows:[state()]}));const result=await withProfileQueryRouting({workspaceId:'p',query:query as unknown as ProfileQuery},()=>readGlobalBudget(foreign,'p'));
  expect(result).toMatchObject({mode:'EXPLICIT',spent_usd:2,reserved_usd:3,unknown_cost_operations:2,available_usd:4});expect(query).toHaveBeenCalledExactlyOnceWith('SELECT * FROM public.read_profile_global_budget($1)',['p']);expect(foreign.query).not.toHaveBeenCalled();
 });
 it('never falls back when the closed SQL reader is absent or rejects authority',async()=>{
  const query=vi.fn(async()=>{throw Error('PROFILE_GLOBAL_BUDGET_SCOPE_REQUIRED');});await expect(withProfileQueryRouting({workspaceId:'p',query:query as unknown as ProfileQuery},()=>readGlobalBudget(foreign,'p'))).rejects.toThrow('PROFILE_GLOBAL_BUDGET_SCOPE_REQUIRED');expect(query).toHaveBeenCalledTimes(1);expect(foreign.query).not.toHaveBeenCalled();
 });
 it('rejects workspace changes before reading any counter',async()=>{
  const query=vi.fn();await expect(withProfileQueryRouting({workspaceId:'p',query:query as unknown as ProfileQuery},()=>readGlobalBudget(foreign,'other'))).rejects.toThrow('PROFILE_QUERY_CONTEXT_MISMATCH');expect(query).not.toHaveBeenCalled();
 });
 it('requires one complete finite native state and authentic expiry shape',async()=>{
  for(const delta of [{limit_usd:'NaN'},{reserved_usd:'-1'},{unknown_cost_operations:'0.5'},{unknown_cost_operations:'9007199254740992'},{configured:true,expires_at:null},{version:0},{external_status:'invented'}]){
   const query=vi.fn(async()=>({rows:[{...state(),...delta}]}));await expect(withProfileQueryRouting({workspaceId:'p',query:query as unknown as ProfileQuery},()=>readGlobalBudget(foreign,'p'))).rejects.toThrow('GLOBAL_BUDGET_STATE_INVALID');
  }
 });
 it('preserves external uncertainty and expiry blocks',async()=>{
  for(const [delta,reason]of [[{expired:true},'GLOBAL_BUDGET_EXPIRED'],[{external_status:'UNKNOWN'},'GLOBAL_EXTERNAL_COST_UNKNOWN'],[{external_status:'KNOWN',external_expired:true},'GLOBAL_EXTERNAL_SNAPSHOT_EXPIRED'],[{limit_usd:'1'},'GLOBAL_BUDGET_OVERCOMMITTED']] as const){
   const query=vi.fn(async()=>({rows:[{...state(),...delta}]}));expect(await withProfileQueryRouting({workspaceId:'p',query:query as unknown as ProfileQuery},()=>readGlobalBudget(foreign,'p'))).toMatchObject({blocked_reason:reason});
  }
 });
 it('retains migrated limits without inventing an explicit authorization',async()=>{
  const query=vi.fn(async()=>({rows:[{...state(),configured:false,version:0,expires_at:null}]}));expect(await withProfileQueryRouting({workspaceId:'p',query:query as unknown as ProfileQuery},()=>readGlobalBudget(foreign,'p'))).toMatchObject({mode:'MIGRATED_PROVIDER_LIMITS',version:0,expires_at:null});
 });
 it('uses the same profile transaction for the mutex and budget decision',async()=>{
  const query=vi.fn(async(sql:string)=>({rows:sql.includes('read_profile_global_budget')?[state()]:[]}));const r=await withProfileQueryRouting({workspaceId:'p',query:query as unknown as ProfileQuery},()=>assertGlobalBudgetCapacity(foreign,'p',4));expect(r.available_usd).toBe(4);expect(query.mock.calls[0]![0]).toContain('pg_advisory_xact_lock');expect(query).toHaveBeenCalledTimes(2);expect(foreign.query).not.toHaveBeenCalled();
 });
 it('refuses excess capacity without releasing existing or UNKNOWN reservations',async()=>{
  const query=vi.fn(async(sql:string)=>({rows:sql.includes('read_profile_global_budget')?[state()]:[]}));await expect(withProfileQueryRouting({workspaceId:'p',query:query as unknown as ProfileQuery},()=>assertGlobalBudgetCapacity(foreign,'p',4.000001))).rejects.toMatchObject({code:'GLOBAL_BUDGET_EXCEEDED'});expect(query.mock.calls.some(([s])=>/UPDATE|INSERT|DELETE/.test(s))).toBe(false);
 });
});
