import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {continuousWarmupAuthorityBlock,readCurrentQrContinuity} from './continuous-warmup.js';
import type {ContinuousAuthorization} from '../../contracts/src/continuous-authorization.js';
import type {ProfileExecutor} from './profile-context.js';
const workspace='warmup-continuity-synthetic';
function grant():ContinuousAuthorization{return{id:randomUUID(),workspaceId:workspace,environment:'REAL',accountId:randomUUID(),
 source:{kind:'VERIFIED_QR_CONNECTION',connectionId:randomUUID(),identityFingerprint:'a'.repeat(64)},
 createdAt:'2026-10-12T00:00:00Z',createdBy:'synthetic-owner',version:1,humanPaused:false,revokedAt:null,protections:[]};}
function scope(sender:ContinuousAuthorization,peer:ContinuousAuthorization){return{workspaceId:workspace,environment:'REAL' as const,senderId:sender.accountId,peerId:peer.accountId};}
describe('continuous warmup permission requires two separate current own origins',()=>{
 it('admits permission for two own grants without asserting physical readiness',()=>{const a=grant(),b=grant();expect(continuousWarmupAuthorityBlock(a,b,scope(a,b))).toBeUndefined();});
 it.each(['missing','foreign','simulation','self','wrongAccount','commercial','paused','revoked','protected']as const)('does not authorize %s peer',kind=>{
  const a=grant(),b=grant(),s=scope(a,b);
  if(kind==='foreign')b.workspaceId='foreign';if(kind==='simulation')b.environment='SIMULATION';if(kind==='self')b.accountId=a.accountId;
  if(kind==='wrongAccount')b.accountId=randomUUID();if(kind==='commercial')b.source={kind:'COMMERCIAL_ASSIGNMENT',assignmentId:randomUUID(),assignmentRevision:1,bindingId:randomUUID()};
  if(kind==='paused')b.humanPaused=true;if(kind==='revoked')b.revokedAt='2026-10-12T01:00:00Z';
  if(kind==='protected')b.protections=[{reason:'SEND_UNCERTAIN',incidentId:randomUUID(),observedAt:'2026-10-12T01:00:00Z',evidenceSha256:'a'.repeat(64)}];
  expect(continuousWarmupAuthorityBlock(a,kind==='missing'?undefined:b,s)).toBe('CONTINUITY_OWN_PEER_REQUIRED');
 });
 it.each(['revoked','paused','protected']as const)('preserves sender %s gate',kind=>{
  const a=grant(),b=grant();if(kind==='revoked')a.revokedAt='2026-10-12T01:00:00Z';if(kind==='paused')a.humanPaused=true;
  if(kind==='protected')a.protections=[{reason:'CHANNEL_DOWN',incidentId:randomUUID(),observedAt:'2026-10-12T01:00:00Z',evidenceSha256:'a'.repeat(64)}];
  expect(continuousWarmupAuthorityBlock(a,b,scope(a,b))).toBe({revoked:'CONTINUITY_REVOKED',paused:'CONTINUITY_HUMAN_PAUSED',protected:'CONTINUITY_PROTECTED'}[kind]);
 });
 it('does not replace a revoked latest origin with an earlier one',async()=>{
  const a=grant();a.revokedAt='2026-10-12T01:00:00Z';let reads=0;
  const db={workspaceId:workspace,query:async(sql:string)=>({rows:sql.includes('current_user')?[{role:'commerce_channel',workspace}]:sql.includes('read_locked_continuous_worker_profile')?[{id:workspace,state:'ACTIVE',version:1,timezone:'UTC'}]:(reads++,[{state:a}])})} as ProfileExecutor;
  expect(await readCurrentQrContinuity(db,'REAL',a.accountId)).toEqual(a);expect(reads).toBe(1);
 });
 it.each(['none','ambiguous','foreign']as const)('rejects %s durable current origin',async kind=>{
  const a=grant();if(kind==='foreign')a.workspaceId='foreign';
  const db={workspaceId:workspace,query:async(sql:string)=>({rows:sql.includes('current_user')?[{role:'commerce_automation',workspace}]:sql.includes('read_locked_continuous_worker_profile')?[{id:workspace,state:'ACTIVE',version:1,timezone:'UTC'}]:kind==='none'?[]:kind==='ambiguous'?[{state:a},{state:a}]:[{state:a}]})} as ProfileExecutor;
  expect(await readCurrentQrContinuity(db,'REAL',a.accountId)).toBeUndefined();
 });
});
