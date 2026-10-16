import {describe,it,expect,vi} from 'vitest';
import type {ProfileQuery} from './profile-context.js';
import {listSessionProfiles,resolveSessionProfile,selectSessionProfile} from './profile-session.js';
import {authorizeProfileAction} from '../../domain/src/core/profile-authorization.js';

const session={id:'opaque-session',userId:'user-one'};
function fixture(){
 const native={id:session.id,userId:session.userId,expiresAt:new Date('2099-01-01T00:00:00Z')};
 const selected={workspace_id:'profile-one',membership_version:4,version:9};
 const member={role:'operator',active:true,version:4};
 const profile={id:'profile-one',business_name:'Synthetic',state:'ACTIVE',timezone:'America/Mexico_City',version:2};
 const query=vi.fn(async(sql:string,_values?:unknown[])=>({rows:[sql.startsWith('INSERT')?{workspace_id:'profile-one',version:10}:sql.includes('FROM session WHERE')?native:sql.includes('FROM profile_session_context')?selected:sql.includes('FROM memberships')?member:sql.includes('FROM profiles')?profile:{workspace_id:'profile-one',version:10}],rowCount:1,command:'SELECT',oid:0,fields:[]}));
 return {native,selected,member,profile,query,db:{query:query as ProfileQuery}};
}
describe('server-owned per-session profile selection',()=>{
 it('resolves only the native selected profile with current role and version',async()=>{
  const f=fixture(),actual=await resolveSessionProfile(f.db,session,{workspaceId:'profile-one',version:9});
  expect(actual.profile.id).toBe('profile-one');expect(actual.membership).toEqual({role:'operator',version:4});
  expect(actual.authority.credential.kind).toBe('session');
  expect(f.query.mock.calls[0][1]).toEqual([session.id,session.userId]);
  expect(f.query.mock.calls[2][1]).toEqual([session.userId,'profile-one']);
 });
 it('never picks the first membership if the session has no selection',async()=>{
  const f=fixture();f.query.mockResolvedValueOnce({rows:[f.native]} as any).mockResolvedValueOnce({rows:[]} as any);
  await expect(resolveSessionProfile(f.db,session)).rejects.toMatchObject({code:'PROFILE_SELECTION_REQUIRED'});
  expect(f.query).toHaveBeenCalledTimes(2);
 });
 it('rejects another session owner or an expired/deleted native session before content',async()=>{
  const f=fixture();f.query.mockResolvedValueOnce({rows:[]} as any);
  await expect(resolveSessionProfile(f.db,session)).rejects.toMatchObject({code:'PROFILE_SESSION_EXPIRED',statusCode:401});
  expect(f.query).toHaveBeenCalledTimes(1);
 });
 it.each([{workspaceId:'other',version:9},{workspaceId:'profile-one',version:8},{workspaceId:'profile-one',version:NaN}])('rejects a stale or forged request fence %j before reading the profile',async fence=>{
  const f=fixture();await expect(resolveSessionProfile(f.db,session,fence)).rejects.toMatchObject({code:'PROFILE_SELECTION_CHANGED'});
  expect(f.query).toHaveBeenCalledTimes(2);
 });
 it('requires a fence for mutation revalidation and retains deterministic row-lock order',async()=>{
  const f=fixture();await expect(resolveSessionProfile(f.db,session,undefined,{lock:true})).rejects.toMatchObject({code:'PROFILE_REQUEST_FENCE_REQUIRED'});
  expect(f.query).not.toHaveBeenCalled();
  await resolveSessionProfile(f.db,session,{workspaceId:'profile-one',version:9},{lock:true});
  expect(f.query.mock.calls.map(([sql])=>sql.endsWith(' FOR SHARE'))).toEqual([true,false,true,true]);
  expect(f.query.mock.calls[1][0]).toBe('SELECT workspace_id,membership_version,version FROM profile_session_context WHERE session_id=$1 AND user_id=$2');
 });
 it.each([{active:false},{role:'viewer',version:5},{role:'seller'},{role:'owner',version:0}])('rejects revoked, changed or unmigrated membership %j',async change=>{
  const f=fixture();Object.assign(f.member,change);await expect(resolveSessionProfile(f.db,session)).rejects.toThrow();
 });
 it('returns suspended profile metadata but denies a commercial mutation using the same authority',async()=>{
  const f=fixture();f.profile.state='SUSPENDED';const actual=await resolveSessionProfile(f.db,session);
  expect(()=>authorizeProfileAction(actual.authority,{workspaceId:actual.profile.id,scope:'products:write',mutation:true})).toThrow('PROFILE_SUSPENDED');
  expect(()=>authorizeProfileAction(actual.authority,{workspaceId:actual.profile.id,scope:'account:write',mutation:true})).not.toThrow();
 });
 it('serializes first selection on the native session and writes only the authenticated user',async()=>{
  const f=fixture();f.query.mockResolvedValueOnce({rows:[f.native]} as any).mockResolvedValueOnce({rows:[]} as any);
  const result=await selectSessionProfile(f.db,session,'profile-one',0);
  expect(result).toEqual({workspaceId:'profile-one',version:10});
  expect(f.query.mock.calls[0][0]).toMatch(/FOR UPDATE$/);expect(f.query.mock.calls[1][0]).toMatch(/FOR UPDATE$/);
  expect(f.query.mock.calls.at(-1)?.[1]).toEqual([session.id,session.userId,'profile-one',4,0]);
 });
 it('does not change selection when CAS is stale, including replay after success',async()=>{
  const f=fixture();await expect(selectSessionProfile(f.db,session,'profile-two',8)).rejects.toMatchObject({code:'PROFILE_SELECTION_CHANGED'});
  expect(f.query).toHaveBeenCalledTimes(2);expect(f.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
 });
 it('cannot select a profile with no active current membership',async()=>{
  const f=fixture();f.member.active=false;
  await expect(selectSessionProfile(f.db,session,'profile-one',9)).rejects.toMatchObject({code:'PROFILE_MEMBERSHIP_REQUIRED'});
  expect(f.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
 });
 it('does not report a switch when the database CAS returned no row',async()=>{
  const f=fixture(),original=f.query.getMockImplementation()!;
  f.query.mockImplementation(async(sql,values)=>sql.startsWith('INSERT')?{rows:[]} as any:original(sql,values));
  await expect(selectSessionProfile(f.db,session,'profile-one',9)).rejects.toMatchObject({code:'PROFILE_SELECTION_CHANGED'});
 });
 it('rejects session expiry after waiting for membership/profile locks before writing selection',async()=>{
  const f=fixture(),original=f.query.getMockImplementation()!;let sessionReads=0;
  f.query.mockImplementation(async(sql,values)=>sql.includes('FROM session WHERE')&&++sessionReads===2?{rows:[]} as any:original(sql,values));
  await expect(selectSessionProfile(f.db,session,'profile-one',9)).rejects.toMatchObject({code:'PROFILE_SESSION_EXPIRED'});
  expect(f.query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
 });
 it('does not return profile metadata when the identity expired during the listing',async()=>{
  const f=fixture(),original=f.query.getMockImplementation()!;let sessionReads=0;
  f.query.mockImplementation(async(sql,values)=>sql.includes('FROM session WHERE')&&++sessionReads===2?{rows:[]} as any:original(sql,values));
  await expect(listSessionProfiles(f.db,session)).rejects.toMatchObject({code:'PROFILE_SESSION_EXPIRED'});
 });
 it('lists only memberships of the current authenticated user, without commercial joins',async()=>{
  const f=fixture();await listSessionProfiles(f.db,session);
  const [sql,values]=f.query.mock.calls[1]!;expect(values).toEqual([session.userId,session.id]);
  expect(sql).toContain('WHERE m.user_id=$1 AND m.active=true');expect(sql).not.toContain('records');
 });
});
