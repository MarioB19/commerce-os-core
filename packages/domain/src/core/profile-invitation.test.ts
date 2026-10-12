import {describe,expect,it} from 'vitest';
import {acceptInvitation,beginInvitationDelivery,cancelInvitation,createInvitation,finishInvitationDelivery,invitationPublicState,replaceInvitationDelivery,type ProfileInvitation} from './profile-invitation.js';

const created=new Date('2026-10-11T12:00:00Z'),dispatched=new Date('2026-10-12T12:00:00Z');
const input={id:'10000000-0000-4000-8000-000000000001',workspaceId:'legacy-profile',role:'operator' as const,recipientDigest:'a'.repeat(64)};
const claim={expectedVersion:1,attemptId:'10000000-0000-4000-8000-000000000002',linkDigest:'b'.repeat(64)};
const identity={expectedVersion:1,linkDigest:claim.linkDigest,recipientDigest:input.recipientDigest,verifiedUserId:'legacy-user',verifiedEmail:true,existingMembership:false};
const queued=()=>createInvitation(input,'ACTIVE',created);
const sending=()=>beginInvitationDelivery(queued(),claim,'ACTIVE',dispatched);
const after=new Date('2026-10-12T12:01:01Z');
describe('versioned invitation state and delivery uncertainty',()=>{
 it('queues without a usable link and begins the entire TTL at durable dispatch',()=>{
  const row=queued();expect(row).toMatchObject({version:1,delivery:'QUEUED',status:'PENDING',linkDigest:null,expiresAt:null});
  const sent=sending();expect(sent.dispatchedAt).toBe(dispatched.toISOString());expect(sent.expiresAt).toBe('2026-10-13T12:00:00.000Z');expect(row.linkDigest).toBeNull();
 });
 it('does not mutate the input or reuse a dispatch attempt',()=>{
  const row=sending(),saved=structuredClone(row);
  expect(()=>beginInvitationDelivery(row,claim,'ACTIVE',after)).toThrow('DISPATCH_ALREADY_ATTEMPTED');expect(row).toEqual(saved);
 });
 it.each(['SUSPENDED'] as const)('denies creation and dispatch in %s',state=>{
  expect(()=>createInvitation(input,state,created)).toThrow('PROFILE_SUSPENDED');expect(()=>beginInvitationDelivery(queued(),claim,state,dispatched)).toThrow('PROFILE_SUSPENDED');
 });
 it('keeps uncertain delivery terminal until an explicit new version',()=>{
  const unknown=finishInvitationDelivery(sending(),{...claim,outcome:'UNCERTAIN'},after);
  expect(unknown.delivery).toBe('UNCERTAIN');expect(()=>beginInvitationDelivery(unknown,claim,'ACTIVE',after)).toThrow('ALREADY_ATTEMPTED');
  expect(()=>finishInvitationDelivery(unknown,{...claim,outcome:'ACCEPTED'},after)).toThrow('RESULT_CONFLICT');
  expect(finishInvitationDelivery(unknown,{...claim,outcome:'UNCERTAIN'},after)).toEqual(unknown);
  const replacement=replaceInvitationDelivery(unknown,1,'ACTIVE',after);expect(replacement).toMatchObject({version:2,delivery:'QUEUED',linkDigest:null,expiresAt:null,attemptId:null});
  expect(()=>acceptInvitation(replacement,{...identity,expectedVersion:2},'ACTIVE',after)).toThrow('LINK_INVALID');
 });
 it('does not resend queued or in-flight mail, or silently renew before a minute',()=>{
  for(const row of [queued(),sending()])expect(()=>replaceInvitationDelivery(row,1,'ACTIVE',after)).toThrow('IN_PROGRESS');
  const row=finishInvitationDelivery(sending(),{...claim,outcome:'REJECTED'},dispatched);
  expect(()=>replaceInvitationDelivery(row,1,'ACTIVE',new Date(dispatched.getTime()+59999))).toThrow('TOO_SOON');
 });
 it('requires the same native attempt and revision to record a result',()=>{
  expect(()=>finishInvitationDelivery(sending(),{...claim,attemptId:input.id,outcome:'ACCEPTED'},after)).toThrow('RESULT_INVALID');
  expect(()=>finishInvitationDelivery(sending(),{...claim,expectedVersion:2,outcome:'ACCEPTED'},after)).toThrow('VERSION_CONFLICT');
 });
 it.each(['SENDING','ACCEPTED','UNCERTAIN'] as const)('accepts a proven current link after %s, without claiming receipt from API acceptance',delivery=>{
  const row=delivery==='SENDING'?sending():finishInvitationDelivery(sending(),{...claim,outcome:delivery},after);
  const accepted=acceptInvitation(row,identity,'ACTIVE',after);expect(accepted).toMatchObject({status:'ACCEPTED',acceptedUserId:'legacy-user',version:2,delivery});
  expect(()=>acceptInvitation(accepted,{...identity,expectedVersion:2},'ACTIVE',after)).toThrow('NOT_PENDING');
 });
 it('rejects another recipient, unverified identity and existing membership',()=>{
  for(const changed of [{recipientDigest:'c'.repeat(64)},{verifiedEmail:false},{existingMembership:true},{verifiedUserId:''},{linkDigest:'c'.repeat(64)}])expect(()=>acceptInvitation(sending(),{...identity,...changed},'ACTIVE',after)).toThrow();
 });
 it('rejects expired, queued, rejected and suspended invitations',()=>{
  expect(()=>acceptInvitation(sending(),identity,'ACTIVE',new Date('2026-10-13T12:00:00Z'))).toThrow('EXPIRED');
  expect(()=>acceptInvitation(queued(),identity,'ACTIVE',after)).toThrow('LINK_INVALID');
  expect(()=>acceptInvitation(finishInvitationDelivery(sending(),{...claim,outcome:'REJECTED'},after),identity,'ACTIVE',after)).toThrow('NOT_DISPATCHED');
  expect(()=>acceptInvitation(sending(),identity,'SUSPENDED',after)).toThrow('PROFILE_SUSPENDED');
 });
 it('cancels a link even when provider outcome was uncertain',()=>{
  const row=cancelInvitation(finishInvitationDelivery(sending(),{...claim,outcome:'UNCERTAIN'},after),1,after);
  expect(row).toMatchObject({status:'CANCELLED',version:2});expect(()=>acceptInvitation(row,{...identity,expectedVersion:2},'ACTIVE',after)).toThrow('NOT_PENDING');expect(()=>replaceInvitationDelivery(row,2,'ACTIVE',after)).toThrow('NOT_PENDING');
 });
 it('rejects future, contradictory and overlong state instead of extending TTL',()=>{
  for(const mutate of [(x:ProfileInvitation)=>{x.dispatchedAt='2099-01-01T00:00:00Z';},(x:ProfileInvitation)=>{x.expiresAt='2099-01-01T00:00:00Z';},(x:ProfileInvitation)=>{x.acceptedUserId='foreign';},(x:ProfileInvitation)=>{x.linkDigest=null;}]){
   const row=sending();mutate(row);expect(()=>finishInvitationDelivery(row,{...claim,outcome:'UNCERTAIN'},after)).toThrow();
  }
  expect(()=>createInvitation(input,'ACTIVE',new Date('invalid'))).toThrow('CLOCK_INVALID');
 });
 it('projects expiry without exposing digests or mutating durable state',()=>{
  const row=sending();expect(invitationPublicState(row,new Date('2026-10-13T12:00:00Z'))).toEqual({id:input.id,role:'operator',version:1,status:'EXPIRED',delivery:'SENDING',expiresAt:'2026-10-13T12:00:00.000Z'});expect(row.status).toBe('PENDING');
 });
});
