import {describe,it,expect} from 'vitest';
import {continuousAuthorizationSchema,continuousHumanCommandSchema,type ContinuousAuthorization} from '../../../contracts/src/continuous-authorization.js';
import {profileRoleScopes} from '../../../contracts/src/profiles.js';
import type {ProfileAuthority} from '../core/profile-authorization.js';
import {continuousHumanTransition,assertContinuousProtection,clearContinuousProtection,continuousEligibility,type ContinuousEligibility} from './continuous-authorization.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const time='2026-10-12T00:00:00.000Z',later=new Date('2026-10-12T01:00:00.000Z'),proof='a'.repeat(64);
function state():ContinuousAuthorization{return {id:id(1),workspaceId:'profile-a',environment:'REAL',accountId:id(2),
 source:{kind:'COMMERCIAL_ASSIGNMENT',assignmentId:id(3),assignmentRevision:1,bindingId:id(4)},createdBy:'owner',createdAt:time,
 version:1,humanPaused:false,revokedAt:null,protections:[]};}
function authority():ProfileAuthority{return {profile:{id:'profile-a',state:'ACTIVE'},membership:{userId:'owner',workspaceId:'profile-a',role:'owner',active:true,version:1},
 credential:{kind:'session',userId:'owner',workspaceId:'profile-a',revoked:false,expiresAt:'2026-11-12T00:00:00Z',scopes:profileRoleScopes.owner,membershipVersion:1}};}
function facts():ContinuousEligibility{return {workspaceId:'profile-a',environment:'REAL',accountId:id(2),profileActive:true,accountActive:true,channelConnected:true,
 identityMatches:true,quotaAvailable:true,aiAvailable:true,ownsEmissionLease:true,recipientOptedOut:false,
 assignment:{id:id(3),revision:1,bindingId:id(4)},recipient:{kind:'NEW_INBOUND',consented:true,insideAllowedWindow:true}};}
const assertInput=()=>({operationId:id(10),expectedVersion:1,reason:'CHANNEL_DOWN' as const,incidentId:id(11),observedAt:'2026-10-12T00:01:00Z',evidenceSha256:proof});

describe('permanent authorization identity',()=>{
 it('has no expiry, release revision or credential renewal field',()=>{
  for(const addition of [{expiresAt:'2026-10-13T00:00:00Z'},{release:'future'},{credentialExpiry:time}])expect(continuousAuthorizationSchema.safeParse({...state(),...addition}).success).toBe(false);
  expect(continuousEligibility(state(),facts())).toEqual({eligible:true,state:'READY',reasons:[]});
 });
 it('rejects duplicate protections, unknown sources and backwards revocation',()=>{
  const p={reason:'CHANNEL_DOWN',incidentId:id(11),observedAt:time,evidenceSha256:proof};
  expect(continuousAuthorizationSchema.safeParse({...state(),protections:[p,p]}).success).toBe(false);
  expect(continuousAuthorizationSchema.safeParse({...state(),source:{kind:'DEPLOYMENT'}}).success).toBe(false);
  expect(continuousAuthorizationSchema.safeParse({...state(),revokedAt:'2026-10-11T00:00:00Z'}).success).toBe(false);
 });
 it('human API schema cannot carry protection, other profile or release commands',()=>{
  const c={operationId:id(10),expectedVersion:1,action:'pause'};
  for(const extra of [{protections:[]},{workspaceId:'profile-b'},{release:'v2'},{action:'clear-protection'}])expect(continuousHumanCommandSchema.safeParse({...c,...extra}).success).toBe(false);
 });
});

describe('human pauses and revocation',()=>{
 it('records actor and version while retaining the immutable binding',()=>{
  const before=state(),result=continuousHumanTransition(before,{operationId:id(10),expectedVersion:1,action:'pause'},authority(),later);
  expect(result.state).toEqual({...before,humanPaused:true,version:2});expect(before.humanPaused).toBe(false);
  expect(result.event).toMatchObject({type:'HUMAN_PAUSED',version:2,actorId:'owner',workspaceId:'profile-a',accountId:id(2)});
 });
 it('resume is explicit, does not clear protections, and a stale version fails',()=>{
  const s=assertContinuousProtection(state(),assertInput(),'profile-a',later).state;
  s.humanPaused=true;
  expect(()=>continuousHumanTransition(s,{operationId:id(12),expectedVersion:1,action:'resume'},authority(),later)).toThrow('CONTINUITY_VERSION_CONFLICT');
  const result=continuousHumanTransition(s,{operationId:id(12),expectedVersion:2,action:'resume'},authority(),later);
  expect(result.state.protections).toEqual(s.protections);expect(continuousEligibility(result.state,facts()).state).toBe('PROTECTED');
 });
 it('revocation is terminal and repeated revocation is a no-op at the current version',()=>{
  const s=continuousHumanTransition(state(),{operationId:id(10),expectedVersion:1,action:'revoke'},authority(),later).state;
  expect(continuousEligibility(s,facts()).state).toBe('REVOKED');
  expect(()=>continuousHumanTransition(s,{operationId:id(12),expectedVersion:2,action:'resume'},authority(),later)).toThrow('CONTINUITY_REVOKED');
  expect(continuousHumanTransition(s,{operationId:id(12),expectedVersion:2,action:'revoke'},authority(),later).event).toBeNull();
 });
 it.each(['viewer','wrong_profile','expired','revoked','platform','suspended'] as const)('rejects %s authority',kind=>{
  const a=authority();if(kind==='viewer')a.membership.role='viewer';if(kind==='wrong_profile')a.profile.id='profile-b';
  if(kind==='expired')a.credential.expiresAt=time;if(kind==='revoked')a.credential.revoked=true;
  if(kind==='platform')a.credential.kind='platform_token';if(kind==='suspended')a.profile.state='SUSPENDED';
  expect(()=>continuousHumanTransition(state(),{operationId:id(10),expectedVersion:1,action:'pause'},a,later)).toThrow();
 });
 it('an operator PAT needs the matching purpose scope',()=>{
  const a=authority();a.membership.role='operator';a.credential.kind='personal_token';a.credential.scopes=['warmup:write'];
  expect(()=>continuousHumanTransition(state(),{operationId:id(10),expectedVersion:1,action:'pause'},a,later)).toThrow('PROFILE_ACTION_FORBIDDEN');
 });
});

describe('cause-specific protection recovery',()=>{
 it('healing preserves a human pause and another cause',()=>{
  const s=state();s.humanPaused=true;
  const first=assertContinuousProtection(s,assertInput(),'profile-a',later).state;
  const second=assertContinuousProtection(first,{...assertInput(),expectedVersion:2,reason:'AI_UNAVAILABLE',incidentId:id(12)},'profile-a',later).state;
  const result=clearContinuousProtection(second,{operationId:id(13),expectedVersion:3,reason:'CHANNEL_DOWN',incidentId:id(11),
   observedAt:'2026-10-12T00:02:00Z',evidenceSha256:proof,recovery:'HEALTH_OBSERVED'},'profile-a',later);
  expect(result.state.humanPaused).toBe(true);expect(result.state.protections.map(x=>x.reason)).toEqual(['AI_UNAVAILABLE']);
  expect(continuousEligibility(result.state,facts()).state).toBe('PAUSED');
 });
 it('a late recovery cannot clear a newer incident',()=>{
  const s=assertContinuousProtection(state(),assertInput(),'profile-a',later).state;
  const newer=assertContinuousProtection(s,{...assertInput(),expectedVersion:2,incidentId:id(12),observedAt:'2026-10-12T00:02:00Z'},'profile-a',later).state;
  expect(()=>clearContinuousProtection(newer,{operationId:id(13),expectedVersion:3,reason:'CHANNEL_DOWN',incidentId:id(11),observedAt:'2026-10-12T00:03:00Z',
   evidenceSha256:proof,recovery:'HEALTH_OBSERVED'},'profile-a',later)).toThrow('CONTINUITY_INCIDENT_CHANGED');
 });
 it('a stale incident or altered evidence for the same ID is rejected',()=>{
  const s=assertContinuousProtection(state(),assertInput(),'profile-a',later).state;
  expect(()=>assertContinuousProtection(s,{...assertInput(),expectedVersion:2,incidentId:id(12)},'profile-a',later)).toThrow('CONTINUITY_OBSERVATION_STALE');
  expect(()=>assertContinuousProtection(s,{...assertInput(),expectedVersion:2,evidenceSha256:'b'.repeat(64)},'profile-a',later)).toThrow('CONTINUITY_INCIDENT_REUSED');
  expect(assertContinuousProtection(s,{...assertInput(),expectedVersion:2},'profile-a',later).event).toBeNull();
 });
 it('channel health cannot settle an uncertain send',()=>{
  const s=assertContinuousProtection(state(),{...assertInput(),reason:'SEND_UNCERTAIN'},'profile-a',later).state;
  const c={operationId:id(12),expectedVersion:2,reason:'SEND_UNCERTAIN' as const,incidentId:id(11),observedAt:'2026-10-12T00:02:00Z',evidenceSha256:proof,recovery:'HEALTH_OBSERVED' as const};
  expect(()=>clearContinuousProtection(s,c,'profile-a',later)).toThrow('CONTINUITY_EFFECT_RECONCILIATION_REQUIRED');
  expect(clearContinuousProtection(s,{...c,recovery:'EFFECT_RECONCILED'},'profile-a',later).state.protections).toEqual([]);
 });
 it('future observations and another profile fail closed',()=>{
  expect(()=>assertContinuousProtection(state(),{...assertInput(),observedAt:'2026-10-13T00:00:00Z'},'profile-a',later)).toThrow('CONTINUITY_OBSERVATION_TIME_INVALID');
  expect(()=>assertContinuousProtection(state(),assertInput(),'profile-b',later)).toThrow('CONTINUITY_PROFILE_MISMATCH');
 });
});

describe('eligibility at the emission boundary',()=>{
 it.each(['profileActive','accountActive','channelConnected','identityMatches','quotaAvailable','aiAvailable','ownsEmissionLease'] as const)('requires %s',key=>{
  const f=facts();f[key]=false;expect(continuousEligibility(state(),f).eligible).toBe(false);
 });
 it('does not accept another binding/revision, an opted-out recipient or a closed window',()=>{
  for(const patch of [{assignment:{id:id(5),revision:1,bindingId:id(4)}},{assignment:{id:id(3),revision:2,bindingId:id(4)}},
   {assignment:{id:id(3),revision:1,bindingId:id(5)}},{recipientOptedOut:true},{recipient:{kind:'NEW_INBOUND' as const,consented:true,insideAllowedWindow:false}}]){
   expect(continuousEligibility(state(),{...facts(),...patch}).eligible).toBe(false);
  }
 });
 it('environment and number identity cannot be substituted',()=>{
  expect(()=>continuousEligibility(state(),{...facts(),environment:'SIMULATION'})).toThrow('CONTINUITY_RESOURCE_MISMATCH');
  expect(()=>continuousEligibility(state(),{...facts(),accountId:id(50)})).toThrow('CONTINUITY_RESOURCE_MISMATCH');
 });
 it('warm-up requires an eligible own-profile peer and waits when none exists',()=>{
  const s=state();s.source={kind:'VERIFIED_QR_CONNECTION',connectionId:id(20),identityFingerprint:proof};
  const f=facts();f.recipient={kind:'OWN_NUMBER',workspaceId:'profile-a',environment:'REAL',accountId:id(21),accountActive:true,connected:true,humanPaused:false,optedOut:false,
   authorization:{...s,id:id(22),accountId:id(21)}};
  expect(continuousEligibility(s,f).eligible).toBe(true);
  for(const patch of [{workspaceId:'profile-b'},{accountId:s.accountId},{environment:'SIMULATION' as const},{optedOut:true},{humanPaused:true},{connected:false},{accountActive:false}])
   expect(continuousEligibility(s,{...f,recipient:{...f.recipient,...patch}}).eligible).toBe(false);
  expect(continuousEligibility(s,{...f,recipient:{kind:'NO_PEER'}})).toMatchObject({eligible:false,state:'WAITING_PEER'});
  expect(continuousEligibility(s,facts()).reasons).toContain('WARMUP_OWN_PROFILE_PEER_REQUIRED');
 });
 it.each(['missing','revoked','protected','commercial_only','foreign_account','foreign_profile','foreign_environment','human_pause'] as const)('rejects %s peer authorization',variant=>{
  const s=state();s.source={kind:'VERIFIED_QR_CONNECTION',connectionId:id(20),identityFingerprint:proof};
  let peer:ContinuousAuthorization|null={...s,id:id(22),accountId:id(21)};
  if(variant==='missing')peer=null;
  else if(variant==='revoked')peer.revokedAt=later.toISOString();
  else if(variant==='protected')peer.protections=[{reason:'IDENTITY_CHANGED',incidentId:id(23),observedAt:time,evidenceSha256:proof}];
  else if(variant==='commercial_only')peer.source=state().source;
  else if(variant==='foreign_account')peer.accountId=id(24);
  else if(variant==='foreign_profile')peer.workspaceId='profile-b';
  else if(variant==='foreign_environment')peer.environment='SIMULATION';
  else peer.humanPaused=true;
  expect(continuousEligibility(s,{...facts(),recipient:{kind:'OWN_NUMBER',workspaceId:'profile-a',environment:'REAL',accountId:id(21),accountActive:true,
   connected:true,humanPaused:false,optedOut:false,authorization:peer}}).reasons).toContain('WARMUP_PEER_AUTHORIZATION_REQUIRED');
 });
});
