import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {encrypt} from './index.js';
import {acceptExistingProfileInvitation,readExistingProfileInvitation,registerInvitedProfileIdentity,generateInvitationLink,invitationLinkDigest} from './profile-invitation-acceptance.js';
import {invitationRecipientDigest} from './profile-invitation.js';
const invitationId='11111111-1111-4111-8111-111111111111',attemptId='22222222-2222-4222-8222-222222222222';
const session={id:'session-native',userId:'recipient-native'};
function fixture(){
 let now=new Date('2026-10-11T21:00:00Z'),clockCalls=0;
 const token=generateInvitationLink().token,email='recipient@example.invalid',workspaceId='target-profile';
 let row:any={id:invitationId,workspace_id:workspaceId,requested_by:'owner-native',role:'operator',version:1,recipient_digest:invitationRecipientDigest(workspaceId,email),recipient_ciphertext:encrypt({scope:'profile.invitation.recipient.v1',workspaceId,invitationId,email}),status:'PENDING',delivery:'UNCERTAIN',attempt_id:attemptId,link_digest:invitationLinkDigest(token),created_at:new Date(now.getTime()-1000),dispatched_at:now,expires_at:new Date(now.getTime()+86400000),accepted_user_id:null};
 const native:any={...session,expiresAt:new Date(now.getTime()+3600000)},profile:any={id:workspaceId,state:'ACTIVE'};
 let user:any={id:session.userId,email,emailVerified:true},author:any={role:'owner',active:true},member=false,locked=true,locate=true,failCommit=false,unconfirmed=false;
 let onClock:((count:number)=>void)|undefined;
 const release=vi.fn();
 const query=vi.fn(async(sql:string,args:unknown[]=[]):Promise<any>=>{
  let rows:any[]=[];
  if(sql==='COMMIT'){if(failCommit)throw Error('SYNTHETIC_COMMIT_UNKNOWN');return{rows:[],command:'COMMIT'};}
  if(sql.includes('pg_try_advisory_xact_lock'))rows=[{locked}];
  else if(sql.startsWith('SELECT id,"userId"'))rows=native?[native]:[];
  else if(sql.startsWith('SELECT id,email'))rows=user?[user]:[];
  else if(sql.startsWith('SELECT id,state'))rows=profile?[profile]:[];
  else if(sql.startsWith('SELECT * FROM profile_invitations'))rows=row?[row]:[];
  else if(sql.startsWith('SELECT role,active'))rows=author?[author]:[];
  else if(sql.startsWith('SELECT user_id'))rows=member?[{user_id:session.userId}]:[];
  else if(sql.startsWith('SELECT clock')){clockCalls++;onClock?.(clockCalls);rows=[{now}];}
  else if(sql.startsWith('INSERT INTO "user"')||sql.startsWith('INSERT INTO account'))rows=[{id:args[0]}];
  else if(sql.startsWith('INSERT INTO memberships'))rows=unconfirmed?[]:[{user_id:args[0],workspace_id:args[1],role:args[2],active:true}];
  else if(sql.startsWith('UPDATE profile_invitations')){row={...row,status:'ACCEPTED',version:row.version+1,accepted_user_id:args[3]};rows=[row];}
  return{rows,rowCount:rows.length};
 });
 const pool={query:vi.fn(async()=>({rows:locate?[{invitation_id:invitationId,workspace_id:workspaceId}]:[]})),connect:vi.fn(async()=>({query,release}))};
 return{pool,query,release,token,workspaceId,getRow:()=>row,setRow:(value:any)=>{row={...row,...value};},user:(value:any)=>{user={...user,...value};},author:(value:any)=>{author=value;},suspend:()=>{profile.state='SUSPENDED';},expiredSession:()=>{native.expiresAt=now;},missing:()=>{locate=false;},busy:()=>{locked=false;},existing:()=>{member=true;},failCommit:()=>{failCommit=true;},unconfirmed:()=>{unconfirmed=true;},advance:(value:number)=>{now=new Date(now.getTime()+value);},onClock:(fn:(count:number)=>void)=>{onClock=fn;}};
}
beforeEach(()=>{vi.stubEnv('PRIVATE_DATA_KEY','11'.repeat(32));vi.stubEnv('BETTER_AUTH_SECRET','synthetic-acceptance-secret-only');});
afterEach(()=>vi.unstubAllEnvs());
describe('prepared native invitation acceptance',()=>{
 it('generates256bit secret and stores only purpose separated HMAC',()=>{const a=generateInvitationLink(),b=generateInvitationLink();expect(a.token).toMatch(/^cos_inv_[A-Za-z0-9_-]{43}$/);expect(a.token).not.toBe(b.token);expect(a.digest).toBe(invitationLinkDigest(a.token));expect(a.digest).not.toContain(a.token);});
 it('accepts matching verified native identity into exactly the invited role after COMMIT',async()=>{const f=fixture();const result=await acceptExistingProfileInvitation(f.pool as any,session,f.token,'correlation');expect(result).toEqual({workspaceId:f.workspaceId,invitationId,accepted:true,created:true});expect(f.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');expect(f.release).toHaveBeenCalledOnce();const insert=f.query.mock.calls.find(([q])=>q.startsWith('INSERT INTO memberships'));expect(insert?.[1]).toEqual([session.userId,f.workspaceId,'operator']);const audit=f.query.mock.calls.find(([q])=>q.startsWith('INSERT INTO domain_events'));expect(JSON.stringify(audit)).not.toContain('example.invalid');expect(JSON.stringify(f.query.mock.calls)).not.toContain(f.token);});
 it('fences authority before any identity or profile row lock',async()=>{const f=fixture();f.busy();await expect(acceptExistingProfileInvitation(f.pool as any,session,f.token,'c')).rejects.toThrow('PROFILE_AUTHORITY_BUSY');expect(f.query.mock.calls.some(([q])=>q.includes('FOR SHARE')||q.includes('FOR UPDATE'))).toBe(false);expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');});
 it('rejects missing or malformed secret before transaction',async()=>{const f=fixture();f.missing();await expect(acceptExistingProfileInvitation(f.pool as any,session,f.token,'c')).rejects.toThrow('INVALID_OR_EXPIRED');expect(f.pool.connect).not.toHaveBeenCalled();await expect(acceptExistingProfileInvitation(f.pool as any,session,'bad','c')).rejects.toThrow();});
 it.each(['unverified','other-recipient','suspended','issuer-revoked','issuer-operator','expired-session','cancelled','rejected-delivery','existing-member'] as const)('blocks %s before membership write',async kind=>{const f=fixture();if(kind==='unverified')f.user({emailVerified:false});if(kind==='other-recipient')f.user({email:'foreign@example.invalid'});if(kind==='suspended')f.suspend();if(kind==='issuer-revoked')f.author({role:'owner',active:false});if(kind==='issuer-operator')f.author({role:'operator',active:true});if(kind==='expired-session')f.expiredSession();if(kind==='cancelled')f.setRow({status:'CANCELLED',version:2});if(kind==='rejected-delivery')f.setRow({delivery:'REJECTED'});if(kind==='existing-member')f.existing();await expect(acceptExistingProfileInvitation(f.pool as any,session,f.token,'c')).rejects.toThrow();expect(f.query.mock.calls.some(([q])=>q.startsWith('INSERT INTO memberships'))).toBe(false);});
 it('rechecks expiry after waiting for issuer before first write',async()=>{const f=fixture();f.onClock(count=>{if(count===2)f.advance(3600000);});await expect(acceptExistingProfileInvitation(f.pool as any,session,f.token,'c')).rejects.toThrow('SESSION_EXPIRED');expect(f.query.mock.calls.some(([q])=>q.startsWith('INSERT INTO memberships'))).toBe(false);});
 it('rolls back acceptance if link expires after audit before commit',async()=>{const f=fixture();f.onClock(count=>{if(count===3)f.advance(86400000);});await expect(acceptExistingProfileInvitation(f.pool as any,session,f.token,'c')).rejects.toThrow();expect(f.query.mock.calls.some(([q])=>q.startsWith('INSERT INTO memberships'))).toBe(true);expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');expect(f.query.mock.calls.some(([q])=>q==='COMMIT')).toBe(false);});
 it('historical acceptance never reinserts or reactivates a subsequently revoked member',async()=>{const f=fixture();f.setRow({status:'ACCEPTED',version:2,accepted_user_id:session.userId});expect(await acceptExistingProfileInvitation(f.pool as any,session,f.token,'c')).toMatchObject({created:false});expect(f.query.mock.calls.some(([q])=>q.startsWith('INSERT')||q.startsWith('UPDATE'))).toBe(false);});
 it('does not return acceptance when membership write or COMMIT is uncertain',async()=>{for(const kind of ['unconfirmed','failCommit'] as const){const f=fixture();f[kind]();await expect(acceptExistingProfileInvitation(f.pool as any,session,f.token,'c')).rejects.toThrow();expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');}});
 it.each(['PENDING','ACCEPTED'] as const)('reads %s without invitation, membership or audit writes',async state=>{const f=fixture();if(state==='ACCEPTED')f.setRow({status:state,version:2,accepted_user_id:session.userId});expect(await readExistingProfileInvitation(f.pool as any,session,f.token)).toEqual({workspaceId:f.workspaceId,invitationId,state});expect(f.query.mock.calls.some(([q])=>/^(INSERT|UPDATE|DELETE)/.test(q))).toBe(false);expect(f.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');});
 it('read status checks expiry after authority waits and cannot acknowledge failed commit',async()=>{const f=fixture();f.onClock(count=>{if(count===2)f.advance(3600000);});await expect(readExistingProfileInvitation(f.pool as any,session,f.token)).rejects.toThrow('SESSION_EXPIRED');const g=fixture();g.failCommit();await expect(readExistingProfileInvitation(g.pool as any,session,g.token)).rejects.toThrow('COMMIT_UNKNOWN');});
});

describe('prepared invitation-only native identity creation',()=>{
 const passwordHash='a'.repeat(32)+':'+'b'.repeat(128);
 const values=(f:ReturnType<typeof fixture>)=>({token:f.token,email:'recipient@example.invalid',name:'Recipient',passwordHash});
 it('creates native credential, invitation membership and audit in one transaction without a session',async()=>{const f=fixture();expect(await registerInvitedProfileIdentity(f.pool as any,values(f),'c')).toEqual({registered:true,loginRequired:true});const calls=f.query.mock.calls;expect(calls.at(-1)?.[0]).toBe('COMMIT');expect(calls.some(([q])=>q.startsWith('INSERT INTO session'))).toBe(false);expect(calls.find(([q])=>q.startsWith('INSERT INTO account'))?.[1]?.slice(2)).toEqual(['credential',passwordHash,'local:credential']);expect(JSON.stringify(calls.find(([q])=>q.startsWith('INSERT INTO domain_events')))).not.toContain('example.invalid');});
 it.each(['suspended','issuer-revoked','recipient-mismatch','expired','cancelled'] as const)('rejects %s before identity writes',async kind=>{const f=fixture(),input=values(f);if(kind==='suspended')f.suspend();if(kind==='issuer-revoked')f.author({role:'operator',active:true});if(kind==='recipient-mismatch')input.email='other@example.invalid';if(kind==='expired')f.advance(86400000);if(kind==='cancelled')f.setRow({status:'CANCELLED',version:2});await expect(registerInvitedProfileIdentity(f.pool as any,input,'c')).rejects.toThrow();expect(f.query.mock.calls.some(([q])=>q.startsWith('INSERT'))).toBe(false);});
 it('rejects malformed prepared hash before even locating the invitation',async()=>{const f=fixture();await expect(registerInvitedProfileIdentity(f.pool as any,{...values(f),passwordHash:'raw-password'},'c')).rejects.toThrow('NATIVE_PASSWORD_HASH_REQUIRED');expect(f.pool.query).not.toHaveBeenCalled();});
 it('rechecks invitation after issuer wait and rolls back if COMMIT cannot be confirmed',async()=>{const f=fixture();f.onClock(count=>{if(count===2)f.advance(86400000);});await expect(registerInvitedProfileIdentity(f.pool as any,values(f),'c')).rejects.toThrow();expect(f.query.mock.calls.some(([q])=>q.startsWith('INSERT'))).toBe(false);const g=fixture();g.failCommit();await expect(registerInvitedProfileIdentity(g.pool as any,values(g),'c')).rejects.toThrow('COMMIT_UNKNOWN');expect(g.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');});
});
