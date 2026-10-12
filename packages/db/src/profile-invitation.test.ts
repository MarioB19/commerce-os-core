import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {decrypt,encrypt} from './index.js';
import {invitationRecipientDigest,queueProfileInvitation,readInvitationRecipient,listProfileInvitations,cancelProfileInvitation} from './profile-invitation.js';
import type {ProfileAuthority} from '../../domain/src/core/profile-authorization.js';
import type {ProfileExecutor,ProfileQuery} from './profile-context.js';
const id='3a3756a8-4667-41c5-8113-f49da7ea5e12',operationId='1f78beba-0f99-4b3a-a4f2-e229ec224f86';
const input={operationId,email:'  TEST@example.test ',role:'operator'};
function fixture(){
 const authority:ProfileAuthority={profile:{id:'one',state:'ACTIVE'},membership:{workspaceId:'one',userId:'owner',role:'owner',active:true,version:1},credential:{kind:'session',userId:'owner',workspaceId:'one',expiresAt:'2099-01-01T00:00:00Z',revoked:false,membershipVersion:1,scopes:[]}};
 let saved:any,existing=false,job=true,wrong=false;const now=new Date('2026-10-11T20:00:00Z');
 const query=vi.fn(async(sql:string,values:unknown[]=[]):Promise<any>=>{
  let rows:any[]=[];
  if(sql.startsWith('SELECT clock'))rows=[{now}];
  else if(sql.startsWith('SELECT 1'))rows=existing?[{n:1}]:[];
  else if(sql.startsWith('SELECT'))rows=saved?[saved]:[];
  else if(sql.startsWith('INSERT INTO profile_invitations(')){saved={id:values[0],workspace_id:values[1],operation_id:values[2],requested_by:values[3],role:values[4],recipient_digest:values[5],recipient_ciphertext:values[6],request_digest:values[7],created_at:values[8],status:'PENDING',delivery:'QUEUED',version:wrong?2:1};rows=[saved];}
  else if(sql.startsWith('INSERT INTO profile_invitation_mail_jobs'))rows=job?[{id:values[0]}]:[];
  else if(sql.startsWith('UPDATE')){saved={...saved,status:'CANCELLED',version:saved.version+1};rows=[saved];}
  return{rows,rowCount:rows.length};
 });
 const db:ProfileExecutor={workspaceId:'one',query:query as ProfileQuery};return{db,query,authority,now,get:()=>saved,set:(row:any)=>{saved=row;},existing:()=>{existing=true;},noJob:()=>{job=false;},wrong:()=>{wrong=true;}};
}
beforeEach(()=>{vi.stubEnv('PRIVATE_DATA_KEY','11'.repeat(32));vi.stubEnv('BETTER_AUTH_SECRET','synthetic-invitation-secret-only');});afterEach(()=>vi.unstubAllEnvs());
describe('staged invitation custody and persistence',()=>{
 it('normalizes recipient and separates HMAC by profile and purpose',()=>{expect(invitationRecipientDigest('one','Test@example.test')).toBe(invitationRecipientDigest('one',' test@example.test '));expect(invitationRecipientDigest('one','test@example.test')).not.toBe(invitationRecipientDigest('two','test@example.test'));});
 it('writes ciphertext, one queue entry and non-PII audit in the same executor',async()=>{
  const f=fixture(),result=await queueProfileInvitation(f.db,f.authority,input,'correlation');expect(result).toMatchObject({created:true,version:1,delivery:'QUEUED',expiresAt:null});expect(JSON.stringify(result)).not.toContain('example.test');
  const row=f.get();expect(row.recipient_ciphertext).not.toContain('example.test');expect(JSON.parse(decrypt(row.recipient_ciphertext))).toEqual({scope:'profile.invitation.recipient.v1',workspaceId:'one',invitationId:row.id,email:'test@example.test'});expect(readInvitationRecipient(row)).toBe('test@example.test');
  const event=f.query.mock.calls.find(([q])=>q.startsWith('INSERT INTO domain_events'))![1]!;expect(event[8]).toEqual({role:'operator',version:1});expect(JSON.stringify(event)).not.toContain('example.test');expect(f.query.mock.calls.filter(([q])=>q.startsWith('INSERT INTO profile_invitation_mail_jobs'))).toHaveLength(1);
 });
 it('returns same operation without another write and rejects changed content or actor',async()=>{
  const f=fixture();const first=await queueProfileInvitation(f.db,f.authority,input,'a');f.query.mockClear();expect(await queueProfileInvitation(f.db,f.authority,input,'b')).toEqual({...first,created:false});expect(f.query.mock.calls).toHaveLength(1);
  await expect(queueProfileInvitation(f.db,f.authority,{...input,role:'viewer'},'b')).rejects.toThrow('INVITATION_OPERATION_CONTENT_CHANGED');f.authority.membership.userId='other';f.authority.credential.userId='other';await expect(queueProfileInvitation(f.db,f.authority,input,'b')).rejects.toThrow('INVITATION_OPERATION_CONTENT_CHANGED');
 });
 it('rejects another pending invitation before encryption or writes',async()=>{const f=fixture();f.existing();await expect(queueProfileInvitation(f.db,f.authority,input,'a')).rejects.toThrow('INVITATION_ALREADY_PENDING');expect(f.query.mock.calls.some(([q])=>q.startsWith('INSERT'))).toBe(false);});
 it('refuses unconfirmed invitation and queue before auditing',async()=>{for(const kind of ['wrong','noJob']as const){const f=fixture();f[kind]();await expect(queueProfileInvitation(f.db,f.authority,input,'a')).rejects.toThrow(/UNCONFIRMED/);expect(f.query.mock.calls.some(([q])=>q.startsWith('INSERT INTO domain_events'))).toBe(false);}});
 it('rejects altered encrypted custody in profile, identity, scope and digest',()=>{
  const base={id,workspace_id:'one',recipient_digest:invitationRecipientDigest('one','test@example.test')};for(const delta of [{workspaceId:'two'},{invitationId:operationId},{scope:'identity.reset-mail'},{email:'other@example.test'}]){
   expect(()=>readInvitationRecipient({...base,recipient_ciphertext:encrypt({scope:'profile.invitation.recipient.v1',workspaceId:'one',invitationId:id,email:'test@example.test',...delta})})).toThrow();
  }
 });
 it.each(['operator','viewer']as const)('denies %s before SQL or PII access',async role=>{const f=fixture();f.authority.membership.role=role;await expect(queueProfileInvitation(f.db,f.authority,input,'a')).rejects.toThrow();await expect(listProfileInvitations(f.db,f.authority)).rejects.toThrow();expect(f.query).not.toHaveBeenCalled();});
 it('denies suspended creation and malformed request without writes',async()=>{const f=fixture();f.authority.profile.state='SUSPENDED';await expect(queueProfileInvitation(f.db,f.authority,input,'a')).rejects.toThrow();expect(f.query).not.toHaveBeenCalled();f.authority.profile.state='ACTIVE';await expect(queueProfileInvitation(f.db,f.authority,{...input,workspaceId:'two'},'a')).rejects.toThrow();expect(f.query).not.toHaveBeenCalled();});
 it('lists only profile-scoped public state and authenticated recipient',async()=>{const f=fixture();await queueProfileInvitation(f.db,f.authority,input,'a');f.query.mockClear();const result=await listProfileInvitations(f.db,f.authority,id);expect(result.data[0]).toEqual({...invitationResult(f.get()),email:'test@example.test'});expect(result.nextAfterId).toBeNull();expect(f.query.mock.calls[0][1]).toEqual(['one',id]);});
 it('presents the native dispatch expiration and uses the database clock for expired links',async()=>{const f=fixture();await queueProfileInvitation(f.db,f.authority,input,'a');const expiry=new Date('2026-10-12T20:00:00.000Z');f.set({...f.get(),delivery:'ACCEPTED',expires_at:expiry,native_now:f.now});expect((await listProfileInvitations(f.db,f.authority)).data[0]).toMatchObject({status:'PENDING',expiresAt:expiry.toISOString()});f.set({...f.get(),native_now:expiry});expect((await listProfileInvitations(f.db,f.authority)).data[0].status).toBe('EXPIRED');f.set({...f.get(),native_now:undefined});await expect(listProfileInvitations(f.db,f.authority)).rejects.toThrow('INVITATION_DATABASE_CLOCK_REQUIRED');});
 it('cancels one version without deleting queue or allowing stale replay',async()=>{const f=fixture();await queueProfileInvitation(f.db,f.authority,input,'a');f.query.mockClear();expect(await cancelProfileInvitation(f.db,f.authority,f.get().id,1,'b')).toMatchObject({status:'CANCELLED',version:2});await expect(cancelProfileInvitation(f.db,f.authority,f.get().id,1,'c')).rejects.toThrow('INVITATION_VERSION_OR_STATE_CHANGED');expect(f.query.mock.calls.some(([q])=>q.startsWith('DELETE'))).toBe(false);});
});
function invitationResult(row:any){return{id:row.id,role:row.role,version:row.version,status:row.status,delivery:row.delivery,expiresAt:null};}
