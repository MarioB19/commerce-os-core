import {describe,it,expect} from 'vitest';
import {authorizeProfileAction,effectiveProfileScopes,migrateProfileRole,type ProfileAuthority} from './profile-authorization.js';
import {profileScopeSchema,profileRoleScopes} from '../../../contracts/src/profiles.js';
const now=new Date('2026-10-11T12:00:00Z');
function fixture():ProfileAuthority{return {profile:{id:'one',state:'ACTIVE'},membership:{userId:'u',workspaceId:'one',role:'owner',active:true,version:2},credential:{kind:'personal_token',userId:'u',workspaceId:'one',revoked:false,expiresAt:'2026-10-12T00:00:00Z',scopes:['products:read','products:write','employees:write']}};}
describe('V7 profile authorization',()=>{
 it('applies both D-23 branches explicitly without assuming production users',()=>{
  for(const present of [false,true]){
   expect(migrateProfileRole('owner',present)).toBe('owner');expect(migrateProfileRole('operator',present)).toBe('operator');
   for(const r of ['analyst','viewer'] as const)expect(migrateProfileRole(r,present)).toBe('viewer');
   for(const r of ['seller','reconciler'] as const)expect(migrateProfileRole(r,present)).toBe(present?'operator':'viewer');
  }
  expect(()=>migrateProfileRole('seller',undefined as unknown as boolean)).toThrow('D23_ROLE_INVENTORY_REQUIRED');
 });
 it('intersects stored token scopes with the current membership, immediately after downgrade',()=>{
  const a=fixture();authorizeProfileAction(a,{scope:'employees:write',workspaceId:'one',mutation:true},now);
  a.membership.role='operator';expect(()=>authorizeProfileAction(a,{scope:'employees:write',workspaceId:'one',mutation:true},now)).toThrow('PROFILE_ACTION_FORBIDDEN');
  a.membership.role='viewer';expect(effectiveProfileScopes(a,now)).toEqual(['products:read']);
 });
 it('never adds token scopes when the owner has broader permissions',()=>{
  const a=fixture();a.credential.scopes=['products:read'];
  expect(()=>authorizeProfileAction(a,{scope:'products:write',workspaceId:'one',mutation:true},now)).toThrow('PROFILE_ACTION_FORBIDDEN');
  expect(profileScopeSchema.safeParse('*').success).toBe(false);expect(profileScopeSchema.safeParse('platform:profiles').success).toBe(false);
 });
 it('rejects another profile or user despite valid resource IDs and scopes',()=>{
  const a=fixture();expect(()=>authorizeProfileAction(a,{scope:'products:read',workspaceId:'two',mutation:false},now)).toThrow('PROFILE_RESOURCE_SCOPE_MISMATCH');
  a.membership.workspaceId='two';expect(()=>effectiveProfileScopes(a,now)).toThrow('PROFILE_MEMBERSHIP_REQUIRED');
  a.membership.workspaceId='one';a.credential.userId='other';expect(()=>effectiveProfileScopes(a,now)).toThrow('PROFILE_MEMBERSHIP_REQUIRED');
 });
 it('does not permit PAT profile switching or platform token access to business data',()=>{
  const a=fixture();a.credential.scopes=['profiles:switch'];
  expect(()=>authorizeProfileAction(a,{scope:'profiles:switch',workspaceId:'one',mutation:false},now)).toThrow('PROFILE_INTERACTIVE_SESSION_REQUIRED');
  a.credential.kind='platform_token';expect(()=>effectiveProfileScopes(a,now)).toThrow('PLATFORM_TOKEN_NOT_A_PROFILE_IDENTITY');
 });
 it('requires active membership, unrevoked and unexpired credential',()=>{
  for(const modify of [(a:ProfileAuthority)=>{a.membership.active=false;},(a:ProfileAuthority)=>{a.credential.revoked=true;},(a:ProfileAuthority)=>{a.credential.expiresAt=now.toISOString();}]){
   const a=fixture();modify(a);expect(()=>effectiveProfileScopes(a,now)).toThrow();
  }
 });
 it('requires refreshed session membership version and keeps suspension limited to mutations',()=>{
  const a=fixture();a.credential.kind='session';a.credential.membershipVersion=1;
  expect(()=>effectiveProfileScopes(a,now)).toThrow('PROFILE_SESSION_ACCESS_CHANGED');a.credential.membershipVersion=2;
  authorizeProfileAction(a,{scope:'profiles:switch',workspaceId:'one',mutation:false},now);
  a.profile.state='SUSPENDED';authorizeProfileAction(a,{scope:'products:read',workspaceId:'one',mutation:false},now);
  expect(()=>authorizeProfileAction(a,{scope:'products:write',workspaceId:'one',mutation:true},now)).toThrow('PROFILE_SUSPENDED');
  expect(()=>authorizeProfileAction(a,{scope:'products:write',workspaceId:'one',mutation:false},now)).toThrow('PROFILE_SUSPENDED');
 });
 it('preserves personal account security for readonly users even when the business profile is suspended',()=>{
  const a=fixture();a.membership.role='viewer';a.profile.state='SUSPENDED';a.credential.scopes=['account:write'];
  authorizeProfileAction(a,{scope:'account:write',workspaceId:'one',mutation:true},now);
 });
 it('keeps readonly roles away from exports/mutations and operators away from credentials',()=>{
  expect(profileRoleScopes.viewer.every(s=>s.endsWith(':read')||s==='profiles:switch'||s==='account:write')).toBe(true);
  expect(profileRoleScopes.viewer).not.toContain('payments:export');expect(profileRoleScopes.viewer).not.toContain('audit:export');
  expect(profileRoleScopes.operator).not.toContain('tokens:write');expect(profileRoleScopes.operator).not.toContain('integrations:write');
  expect(profileRoleScopes.operator).toContain('receipts:review');expect(profileRoleScopes.operator).toContain('payments:write');
 });
});
