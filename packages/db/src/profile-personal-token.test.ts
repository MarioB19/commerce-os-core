import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import type {ProfileQuery} from './profile-context.js';
import {withPersonalProfileTransaction} from './profile-personal-token.js';
import {profileScopes} from '../../contracts/src/profiles.js';

const secret='cos_pat_'+'s'.repeat(43),id='11111111-1111-4111-8111-111111111111';
function fixture(){
 const route={token_id:id,workspace_id:'one',user_id:'user'},member={role:'operator',active:true,version:2},profile={id:'one',business_name:'Synthetic',state:'ACTIVE',timezone:'UTC',version:1};
 const token={profile_scopes:['products:read','products:write'],allowed_environments:['SIMULATION'],expires_at:new Date('2099-01-01'),revoked_at:null as Date|null,unexpired:true};
 const query=vi.fn(async(sql:string)=>({rows:sql.includes('pg_try_advisory_xact_lock')?[{locked:true}]:sql.includes('locate_personal_profile_token')?[route]:sql.includes('FROM memberships')?[member]:sql.includes('FROM profiles')?[profile]:sql.startsWith('SELECT id FROM personal_access_tokens')?[{id}]:sql.includes('FROM personal_access_tokens')?[token]:[],command:sql==='COMMIT'?'COMMIT':'SELECT',rowCount:1,fields:[],oid:0}));
 const connection={query:query as ProfileQuery,release:vi.fn()},pool={query:query as ProfileQuery,connect:vi.fn(async()=>connection)};
 return{pool,query,token,member,profile,route,connection};
}
describe('fixed-profile PAT authority',()=>{
 it('locates only with the complete hash, locks in order and rechecks after work',async()=>{
  const f=fixture();
  const result=await withPersonalProfileTransaction(f.pool,secret,'SIMULATION',{scope:'products:write',mutation:true},async(db,profile)=>{expect(db.workspaceId).toBe('one');expect(profile.authority.credential.kind).toBe('personal_token');expect(JSON.stringify(profile)).not.toContain(secret);await db.query('INSERT synthetic');return 'ok';});
  expect(result).toBe('ok');expect(f.query.mock.calls[0]).toEqual(['SELECT token_id,workspace_id,user_id FROM public.locate_personal_profile_token($1)',[createHash('sha256').update(secret).digest('hex')]]);
  const calls=f.query.mock.calls.map(([sql])=>sql);expect(calls.slice(4,8).map(sql=>sql.match(/FROM ([a-z_]+)/)?.[1])).toEqual(['memberships','profiles','personal_access_tokens','personal_access_tokens']);expect(calls[6]).toContain('FOR SHARE');expect(calls[7]).toContain('clock_timestamp()');expect(calls[7]).not.toContain('FOR SHARE');expect(calls.filter(sql=>sql.includes('clock_timestamp()'))).toHaveLength(2);expect(calls.at(-1)).toBe('COMMIT');
 });
 it.each(['','cos_pat_short','cos_st_'+'s'.repeat(43),'cos_pat_'+'s'.repeat(44)])('does not query for malformed token %s',async token=>{
  const f=fixture();await expect(withPersonalProfileTransaction(f.pool,token,'SIMULATION',{scope:'products:read',mutation:false},vi.fn())).rejects.toMatchObject({code:'PROFILE_PERSONAL_TOKEN_REQUIRED'});expect(f.query).not.toHaveBeenCalled();
 });
 it.each(['legacy','wildcard','switch','duplicate','role','inactive','environment','revoked','expired','suspended'] as const)('rejects %s before commercial work',async kind=>{
  const f=fixture(),work=vi.fn();
  if(kind==='legacy')f.token.profile_scopes=null as never;
  if(kind==='wildcard')f.token.profile_scopes=['*'];
  if(kind==='switch')f.token.profile_scopes=['profiles:switch'];
  if(kind==='duplicate')f.token.profile_scopes=['products:write','products:write'];
  if(kind==='role')f.member.role='viewer';
  if(kind==='inactive')f.member.active=false;
  if(kind==='environment')f.token.allowed_environments=['REAL'];
  if(kind==='revoked')f.token.revoked_at=new Date();
  if(kind==='expired')f.token.unexpired=false;
  if(kind==='suspended')f.profile.state='SUSPENDED';
  await expect(withPersonalProfileTransaction(f.pool,secret,'SIMULATION',{scope:'products:write',mutation:true},work)).rejects.toThrow();expect(work).not.toHaveBeenCalled();expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
 });
 it('does not expand the token when the user becomes owner',async()=>{
  const f=fixture();f.member.role='owner';await expect(withPersonalProfileTransaction(f.pool,secret,'SIMULATION',{scope:'employees:write',mutation:true},vi.fn())).rejects.toMatchObject({code:'PROFILE_ACTION_FORBIDDEN'});
 });
 it('takes administrative serialization before membership and credential row locks',async()=>{
  const f=fixture();f.member.role='owner';f.token.profile_scopes=['tokens:write'];
  await withPersonalProfileTransaction(f.pool,secret,'SIMULATION',{scope:'tokens:write',mutation:true},async()=>true);
  const calls=f.query.mock.calls.map(([sql])=>sql);
  expect(calls.findIndex(sql=>sql.includes('pg_try_advisory_xact_lock'))).toBeLessThan(calls.findIndex(sql=>sql.includes('FROM memberships')&&sql.endsWith('FOR SHARE')));
 });
 it('does not let even an owner PAT change the interactive selection',async()=>{
  const f=fixture();f.member.role='owner';await expect(withPersonalProfileTransaction(f.pool,secret,'SIMULATION',{scope:'products:read',mutation:false,interactiveOnly:true},vi.fn())).rejects.toMatchObject({code:'PROFILE_INTERACTIVE_SESSION_REQUIRED'});
 });
 it('rolls back work when server time expired before the final check',async()=>{
  const f=fixture();await expect(withPersonalProfileTransaction(f.pool,secret,'SIMULATION',{scope:'products:write',mutation:true},async db=>{await db.query('INSERT synthetic');f.token.unexpired=false;})).rejects.toMatchObject({code:'PROFILE_PERSONAL_TOKEN_INVALID'});expect(f.query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
 });
 it('keeps the SQL closed scope set exactly aligned with the public contract',()=>{
  const sql=readFileSync(new URL('../profile-transition/002_profile_personal_tokens.sql',import.meta.url),'utf8');
  const literal=sql.match(/profile_scopes <@ '(\[.*\])'::jsonb/)?.[1];expect(literal).toBeDefined();expect(JSON.parse(literal!)).toEqual(profileScopes.filter(scope=>scope!=='profiles:switch'));
 });
});
