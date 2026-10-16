import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {commercialContinuityAuthorityBlock,continuousInboundRecipient,readCommercialContinuity,lockedContinuousWorkerProfile,type CommercialContinuityOrigin} from './continuous-commercial.js';
import type {ProfileExecutor} from './profile-context.js';
import type {ContinuousAuthorization} from '../../contracts/src/continuous-authorization.js';
import type {DomainRecord} from '../../contracts/src/index.js';

const workspace='f3-commercial-synthetic',now=new Date('2026-10-12T05:00:00Z');
function fixture(){
 const origin:CommercialContinuityOrigin={assignmentId:randomUUID(),assignmentRevision:2,bindingId:randomUUID(),accountId:randomUUID(),productId:randomUUID()};
 const state:ContinuousAuthorization={id:randomUUID(),workspaceId:workspace,environment:'REAL',accountId:origin.accountId,
  source:{kind:'COMMERCIAL_ASSIGNMENT',assignmentId:origin.assignmentId,assignmentRevision:origin.assignmentRevision,bindingId:origin.bindingId},
  createdAt:'2026-10-12T04:59:00Z',createdBy:'synthetic-owner',version:1,humanPaused:false,revokedAt:null,protections:[]};
 const contact={id:randomUUID(),workspace_id:workspace,environment:'REAL',kind:'contact',version:1,created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z',body:{status:'ACTIVE'}} as DomainRecord;
 const conversation={id:randomUUID(),workspace_id:workspace,environment:'REAL',kind:'conversation',version:1,created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-12T04:30:00Z',body:{contact_id:contact.id,started_at:'2026-10-01T00:00:00Z',last_inbound_at:'2026-10-12T04:30:00Z'}} as DomainRecord;
 return{origin,state,contact,conversation};
}
describe('continuous commercial authority is scoped and separate from emission readiness',()=>{
 it('does not expire an old assignment or inbound history on installation',()=>{
  const f=fixture();expect(commercialContinuityAuthorityBlock(f.state,workspace,'REAL',f.origin)).toBeUndefined();
  expect(continuousInboundRecipient(f.conversation,f.contact,now)).toBe(true);
 });
 it.each(['workspace','environment','account','assignment','revision','binding']as const)('rejects changed %s scope',field=>{
  const f=fixture(),origin={...f.origin};if(field==='account')origin.accountId=randomUUID();if(field==='assignment')origin.assignmentId=randomUUID();if(field==='revision')origin.assignmentRevision++;if(field==='binding')origin.bindingId=randomUUID();
  expect(commercialContinuityAuthorityBlock(f.state,field==='workspace'?'foreign':workspace,field==='environment'?'SIMULATION':'REAL',origin)).toBe('CONTINUITY_ASSIGNMENT_CHANGED');
 });
 it.each(['revoked','paused','protected']as const)('retains %s denial without conflating protections',kind=>{
  const f=fixture();if(kind==='revoked')f.state.revokedAt=now.toISOString();if(kind==='paused')f.state.humanPaused=true;
  if(kind==='protected')f.state.protections=[{reason:'SEND_UNCERTAIN',incidentId:randomUUID(),observedAt:now.toISOString(),evidenceSha256:'a'.repeat(64)}];
  expect(commercialContinuityAuthorityBlock(f.state,workspace,'REAL',f.origin)).toBe({revoked:'CONTINUITY_REVOKED',paused:'CONTINUITY_HUMAN_PAUSED',protected:'CONTINUITY_PROTECTED'}[kind]);
 });
 it.each(['missing','future','reversed','expired','suppressed','revokedConsent','foreign','wrongContact']as const)('rejects %s inbound evidence',kind=>{
  const f=fixture();if(kind==='missing')delete f.conversation.body.last_inbound_at;if(kind==='future')f.conversation.body.last_inbound_at='2026-10-13T00:00:00Z';if(kind==='reversed')f.conversation.body.last_inbound_at='2026-09-30T00:00:00Z';if(kind==='expired')f.conversation.body.last_inbound_at='2026-10-11T05:00:00Z';if(kind==='suppressed')f.contact.body.status='SUPPRESSED';if(kind==='revokedConsent')f.contact.body.consent={revoked_at:'2026-10-12T04:45:00Z'};if(kind==='foreign')f.contact.workspace_id='other';if(kind==='wrongContact')f.conversation.body.contact_id=randomUUID();
  expect(continuousInboundRecipient(f.conversation,f.contact,now)).toBe(false);
 });
 it('requires independently verified template and actual consent after the window',()=>{
  const f=fixture();f.conversation.body.last_inbound_at='2026-10-10T05:00:00Z';
  expect(continuousInboundRecipient(f.conversation,f.contact,now,true)).toBe(false);
  f.contact.body.consent={purpose:'messages',source:'synthetic-form',evidence:'synthetic-evidence',observed_at:'2026-10-01T00:00:00Z'};
  expect(continuousInboundRecipient(f.conversation,f.contact,now)).toBe(false);expect(continuousInboundRecipient(f.conversation,f.contact,now,true)).toBe(true);
  f.contact.body.consent.observed_at='2026-10-13T00:00:00Z';expect(continuousInboundRecipient(f.conversation,f.contact,now,true)).toBe(false);
 });
 it.each(['wrongRole','wrongContext','suspended','foreignProfile']as const)('rejects %s worker facts',async kind=>{
  const db={workspaceId:workspace,query:async(sql:string)=>({rows:sql.includes('current_user')?[{role:kind==='wrongRole'?'commerce_api':'commerce_automation',workspace:kind==='wrongContext'?'foreign':workspace}]:[{id:kind==='foreignProfile'?'foreign':workspace,state:kind==='suspended'?'SUSPENDED':'ACTIVE',version:1}]})} as ProfileExecutor;
  await expect(lockedContinuousWorkerProfile(db)).rejects.toThrow(/^CONTINUITY_/);
 });
 it('selects exact live origin without searching temporal authorization or substituting a newer grant',async()=>{
  const f=fixture(),calls:string[]=[];
  const db={workspaceId:workspace,query:async(sql:string)=>{calls.push(sql);return{rows:sql.includes('current_user')?[{role:'commerce_automation',workspace}]:sql.includes('read_locked_continuous_worker_profile')?[{id:workspace,state:'ACTIVE',version:1,timezone:'UTC'}]:sql.includes('commercial_assignments')?[{id:f.origin.assignmentId,revision:2,binding_id:f.origin.bindingId,account_id:f.origin.accountId,product_id:f.origin.productId}]:[{state:f.state}]};}} as ProfileExecutor;
  expect(await readCommercialContinuity(db,'REAL',f.origin)).toEqual(f.state);expect(calls.some(sql=>sql.includes('operation_authorizations'))).toBe(false);
  f.state.humanPaused=true;expect(await readCommercialContinuity(db,'REAL',f.origin)).toEqual(f.state);
  f.state.revokedAt=now.toISOString();expect(await readCommercialContinuity(db,'REAL',f.origin)).toBeUndefined();
 });
});
