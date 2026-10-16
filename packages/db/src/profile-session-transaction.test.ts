import {describe,expect,it,vi} from 'vitest';
import type {ProfileQuery} from './profile-context.js';
import {withProfileSessionTransaction} from './profile-session-transaction.js';
const session={id:'native-session',userId:'user'},fence={workspaceId:'business',version:1};
function fixture(){
 const native={expiresAt:new Date('2099-01-01')},selection={workspace_id:'business',membership_version:1,version:1},member={role:'operator',active:true,version:1},profile={id:'business',business_name:'Synthetic',state:'ACTIVE',timezone:'UTC',version:1};
 let expired=false;
 const query=vi.fn(async(sql:string)=>({rows:sql.includes('pg_try_advisory_xact_lock')?[{locked:true}]:sql.includes('FROM session WHERE')?(expired?[]:[native]):sql.includes('FROM profile_session_context')?[selection]:sql.includes('FROM memberships')?[member]:sql.includes('FROM profiles')?[profile]:[],rowCount:1,command:sql==='COMMIT'?'COMMIT':'SELECT',fields:[],oid:0}));
 const connection={query:query as ProfileQuery,release:vi.fn()};return{query,connection,pool:{connect:async()=>connection},member,profile,selection,expire:()=>{expired=true;}};
}
describe('session authorization and SQL context share one transaction',()=>{
 it('authorizes before the callback and repeats locked native authority before committing',async()=>{
  const f=fixture(),work=vi.fn(async db=>{expect(db.workspaceId).toBe('business');await db.query('SELECT commercial_fixture');return 'result';});
  expect(await withProfileSessionTransaction(f.pool,session,fence,{scope:'products:write',mutation:true},work)).toBe('result');
  const statements=f.query.mock.calls.map(([sql])=>sql);expect(statements.filter(sql=>sql.endsWith('FOR SHARE'))).toHaveLength(6);expect(statements.at(-1)).toBe('COMMIT');expect(statements.indexOf('SELECT commercial_fixture')).toBe(7);expect(work).toHaveBeenCalledOnce();expect(f.connection.release).toHaveBeenCalledOnce();
 });
 it.each(['stale_selection','wrong_profile','downgraded','suspended','owner_only'] as const)('does not invoke commercial work for %s',async kind=>{
  const f=fixture(),work=vi.fn(),action={scope:'products:write' as const,mutation:true};const input={...fence};
  if(kind==='stale_selection')input.version=2;
  if(kind==='wrong_profile')input.workspaceId='another';
  if(kind==='downgraded')f.member.role='viewer';
  if(kind==='suspended')f.profile.state='SUSPENDED';
  await expect(withProfileSessionTransaction(f.pool,session,input,kind==='owner_only'?{scope:'employees:write',mutation:true}:action,work)).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
 });
 it('rolls back work if the native session expired before commit',async()=>{
  const f=fixture();await expect(withProfileSessionTransaction(f.pool,session,fence,{scope:'products:write',mutation:true},async db=>{await db.query('UPDATE synthetic_work');f.expire();})).rejects.toMatchObject({code:'PROFILE_SESSION_EXPIRED'});
  expect(f.query.mock.calls.some(([sql])=>sql==='UPDATE synthetic_work')).toBe(true);expect(f.query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
 });
 it('rejects a foreign fence before probing its administrative lock',async()=>{
  const f=fixture();f.member.role='owner';
  await expect(withProfileSessionTransaction(f.pool,session,{workspaceId:'foreign',version:1},{scope:'employees:write',mutation:true},async()=>true)).rejects.toMatchObject({code:'PROFILE_SELECTION_CHANGED'});
  expect(f.query.mock.calls.some(([sql])=>sql.includes('pg_try_advisory_xact_lock'))).toBe(false);
 });
 it('takes administrative serialization before native authority row locks',async()=>{
  const f=fixture();f.member.role='owner';
  await withProfileSessionTransaction(f.pool,session,fence,{scope:'employees:write',mutation:true},async()=>true);
  const calls=f.query.mock.calls.map(([sql])=>sql);
  expect(calls.findIndex(sql=>sql.includes('pg_try_advisory_xact_lock'))).toBeLessThan(calls.findIndex(sql=>sql.includes('FROM session WHERE')&&sql.endsWith('FOR SHARE')));
 });
 it('cannot change its own membership and keep an earlier authorization to commit',async()=>{
  const f=fixture();await expect(withProfileSessionTransaction(f.pool,session,fence,{scope:'products:write',mutation:true},async()=>{f.member.active=false;})).rejects.toMatchObject({code:'PROFILE_MEMBERSHIP_REQUIRED'});expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
 });
});
