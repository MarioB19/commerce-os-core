import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {appendEvent,type QueryExecutor} from './index.js';
import {identityDigest} from './identity.js';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from './profile-context.js';
import {lockProfileAuthorityChange} from './profile-authority-lock.js';
import type {InteractiveSession} from './profile-session.js';
import {invitationRecipientDigest,readInvitationRecipient} from './profile-invitation.js';
import {acceptInvitation,type ProfileInvitation} from '../../domain/src/core/profile-invitation.js';
import {profileIdSchema} from '../../contracts/src/profiles.js';

import {invitationLinkTokenSchema} from '../../contracts/src/profile-invitation-acceptance.js';
export {invitationLinkTokenSchema};
export function invitationLinkDigest(token:string){return identityDigest('profile-invitation-link',invitationLinkTokenSchema.parse(token));}
/** Token stays in RAM until the separately committed encrypted dispatch input.
 * This helper neither persists a digest nor starts a link's lifetime.
 */
export function generateInvitationLink(){const token='cos_inv_'+randomBytes(32).toString('base64url');return{token,digest:invitationLinkDigest(token)};}
function fail(code:string,statusCode=409):never{throw Object.assign(new Error(code),{code,statusCode});}
function date(value:unknown){if(!(value instanceof Date)||!Number.isFinite(value.getTime()))fail('INVITATION_DATABASE_CLOCK_REQUIRED',503);return value;}
function model(row:any):ProfileInvitation{return{id:row.id,workspaceId:row.workspace_id,role:row.role,version:row.version,recipientDigest:row.recipient_digest,status:row.status,delivery:row.delivery,attemptId:row.attempt_id,linkDigest:row.link_digest,createdAt:date(row.created_at).toISOString(),dispatchedAt:row.dispatched_at===null?null:date(row.dispatched_at).toISOString(),expiresAt:row.expires_at===null?null:date(row.expires_at).toISOString(),acceptedUserId:row.accepted_user_id};}
interface Route{invitationId:string;workspaceId:string;digest:string}
async function locate(pool:QueryExecutor,token:string):Promise<Route>{
 const digest=invitationLinkDigest(token),rows=(await pool.query('SELECT invitation_id,workspace_id FROM public.locate_profile_invitation($1)',[digest])).rows;
 if(rows.length!==1||!z.uuid().safeParse(rows[0].invitation_id).success||!profileIdSchema.safeParse(rows[0].workspace_id).success)fail('INVITATION_LINK_INVALID_OR_EXPIRED',404);
 return{invitationId:rows[0].invitation_id,workspaceId:rows[0].workspace_id,digest};
}
async function nativeIdentity(db:ProfileExecutor,session:InteractiveSession){
 if(!profileIdSchema.safeParse(session.id).success||!profileIdSchema.safeParse(session.userId).success)fail('INVITATION_SESSION_REQUIRED',401);
 const native=(await db.query('SELECT id,"userId","expiresAt" FROM session WHERE id=$1 AND "userId"=$2 FOR SHARE',[session.id,session.userId])).rows[0];
 if(!native)fail('INVITATION_SESSION_REQUIRED',401);
 const user=(await db.query('SELECT id,email,"emailVerified" FROM "user" WHERE id=$1 FOR SHARE',[session.userId])).rows[0];
 if(!user||user.id!==session.userId||user.emailVerified!==true)fail('INVITATION_VERIFIED_IDENTITY_REQUIRED',403);
 return{user,expiresAt:date(native.expiresAt)};
}
async function activeInvitation(db:ProfileExecutor,route:Route){
 const profile=(await db.query('SELECT id,state FROM profiles WHERE id=$1 FOR SHARE',[route.workspaceId])).rows[0];
 if(profile?.id!==route.workspaceId||profile.state!=='ACTIVE')fail('INVITATION_PROFILE_SUSPENDED',403);
 const row=(await db.query('SELECT * FROM profile_invitations WHERE workspace_id=$1 AND id=$2 AND link_digest=$3 FOR UPDATE',[route.workspaceId,route.invitationId,route.digest])).rows[0];
 if(!row)fail('INVITATION_LINK_INVALID_OR_EXPIRED',404);
 return row;
}
async function clock(db:ProfileExecutor){return date((await db.query('SELECT clock_timestamp() AS now')).rows[0]?.now);}
function live(row:any,route:Route,sessionExpires:Date|null,time:Date){
 if(sessionExpires!==null&&time>=sessionExpires)fail('INVITATION_SESSION_EXPIRED',401);
 if(row.link_digest!==route.digest||!(row.expires_at instanceof Date)||time>=row.expires_at||!['SENDING','ACCEPTED','UNCERTAIN'].includes(row.delivery))fail('INVITATION_LINK_INVALID_OR_EXPIRED',404);
}

/** Existing verified Better Auth identity. Recipient authority comes from the
 * native session and secret link, never from an existing profile selection/PAT.
 * Result is exposed only after withProfileTransaction confirms COMMIT.
 */
async function invitationAccess(pool:ProfilePool&QueryExecutor,session:InteractiveSession,token:string,correlation:string,write:boolean){
 const route=await locate(pool,token);
 return withProfileTransaction(pool,route.workspaceId,async db=>{
  await lockProfileAuthorityChange(db,{scope:'employees:write',mutation:true});
  const identity=await nativeIdentity(db,session),row=await activeInvitation(db,route),time=await clock(db);
  live(row,route,identity.expiresAt,time);
  const author=(await db.query('SELECT role,active FROM memberships WHERE user_id=$1 AND workspace_id=$2 FOR SHARE',[row.requested_by,route.workspaceId])).rows[0];
  if(author?.active!==true||author.role!=='owner')fail('INVITATION_ISSUER_NO_LONGER_AUTHORIZED',403);
  const recipientDigest=invitationRecipientDigest(route.workspaceId,identity.user.email);
  if(recipientDigest!==row.recipient_digest||readInvitationRecipient(row)!==identity.user.email.trim().toLowerCase())fail('INVITATION_RECIPIENT_MISMATCH',403);
  if(row.status==='ACCEPTED'){
   if(row.accepted_user_id!==session.userId)fail('INVITATION_RECIPIENT_MISMATCH',403);
   // A repeated acceptance confirms its historical result, never inserts or
   // reactivates a membership that has since been changed or revoked.
   live(row,route,identity.expiresAt,await clock(db));
   return{workspaceId:route.workspaceId,invitationId:row.id,accepted:true as const,created:false,state:'ACCEPTED' as const};
  }
  const member=await db.query('SELECT user_id FROM memberships WHERE user_id=$1 AND workspace_id=$2',[session.userId,route.workspaceId]);
  const latest=await clock(db);live(row,route,identity.expiresAt,latest);
  const next=acceptInvitation(model(row),{expectedVersion:row.version,linkDigest:route.digest,recipientDigest,verifiedUserId:session.userId,verifiedEmail:true,existingMembership:member.rows.length!==0},'ACTIVE',latest);
  if(!write)return{workspaceId:route.workspaceId,invitationId:row.id,accepted:false as const,created:false,state:'PENDING' as const};
  await db.query("SELECT pg_catalog.set_config('app.invitation_link_digest',$1,true),pg_catalog.set_config('app.invitation_session_id',$2,true)",[route.digest,session.id]);
  const inserted=await db.query('INSERT INTO memberships(user_id,workspace_id,role,active) VALUES($1,$2,$3,true) RETURNING user_id,workspace_id,role,active',[session.userId,route.workspaceId,next.role]);
  if(inserted.rows.length!==1||inserted.rows[0].user_id!==session.userId||inserted.rows[0].workspace_id!==route.workspaceId||inserted.rows[0].role!==next.role||inserted.rows[0].active!==true)fail('INVITATION_MEMBERSHIP_WRITE_UNCONFIRMED');
  const updated=await db.query("UPDATE profile_invitations SET status='ACCEPTED',version=version+1,accepted_user_id=$4 WHERE workspace_id=$1 AND id=$2 AND version=$3 AND status='PENDING' AND expires_at>clock_timestamp() RETURNING *",[route.workspaceId,row.id,row.version,session.userId]);
  const saved=updated.rows[0];if(updated.rows.length!==1||saved.status!=='ACCEPTED'||saved.version!==next.version||saved.accepted_user_id!==session.userId)fail('INVITATION_ACCEPTANCE_WRITE_UNCONFIRMED');
  await appendEvent(db,{workspace_id:route.workspaceId,environment:'REAL',event_type:'profile.invitation.accepted',aggregate_id:row.id,correlation_id:correlation,actor:{type:'human',id:session.userId},payload:{role:next.role,version:next.version}});
  const final=await activeInvitation(db,route);if(final.status!=='ACCEPTED'||final.accepted_user_id!==session.userId||final.version!==next.version)fail('INVITATION_ACCEPTANCE_CHANGED');
  live(final,route,identity.expiresAt,await clock(db));
  return{workspaceId:route.workspaceId,invitationId:row.id,accepted:true as const,created:true,state:'ACCEPTED' as const};
 });
}
export async function acceptExistingProfileInvitation(pool:ProfilePool&QueryExecutor,session:InteractiveSession,token:string,correlation:string){
 const result=await invitationAccess(pool,session,token,correlation,true);
 if(!result.accepted)fail('INVITATION_ACCEPTANCE_WRITE_UNCONFIRMED');
 return{workspaceId:result.workspaceId,invitationId:result.invitationId,accepted:true as const,created:result.created};
}
/** Reads the same authorized invitation under locks, without membership,
 * invitation or audit writes. The secret still travels only in a request body. */
export async function readExistingProfileInvitation(pool:ProfilePool&QueryExecutor,session:InteractiveSession,token:string){
 const result=await invitationAccess(pool,session,token,'',false);
 return{workspaceId:result.workspaceId,invitationId:result.invitationId,state:result.state};
}

/** Prepared invitation-only identity creation. The caller computes the native
 * Better Auth password hash after persistent rate limits; raw passwords never
 * enter this transaction. No session is fabricated or issued here. */
export async function registerInvitedProfileIdentity(pool:ProfilePool&QueryExecutor,input:{token:string;email:string;name:string;passwordHash:string},correlation:string){
 const email=z.email().max(320).parse(input.email).toLowerCase(),name=z.string().trim().min(1).max(120).refine(v=>!v.includes('\0')).parse(input.name);
 if(!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(input.passwordHash))fail('INVITATION_NATIVE_PASSWORD_HASH_REQUIRED',503);
 const route=await locate(pool,input.token),userId=randomUUID(),accountId=randomUUID();
 try{return await withProfileTransaction(pool,route.workspaceId,async db=>{
  await lockProfileAuthorityChange(db,{scope:'employees:write',mutation:true});
  const row=await activeInvitation(db,route),initial=await clock(db);
  // No session exists for this path; lifetime is limited to the actual link.
  live(row,route,null,initial);
  const issuer=(await db.query('SELECT role,active FROM memberships WHERE user_id=$1 AND workspace_id=$2 FOR SHARE',[row.requested_by,route.workspaceId])).rows[0];
  if(issuer?.active!==true||issuer.role!=='owner')fail('INVITATION_ISSUER_NO_LONGER_AUTHORIZED',403);
  const recipientDigest=invitationRecipientDigest(route.workspaceId,email);
  if(recipientDigest!==row.recipient_digest||readInvitationRecipient(row)!==email)fail('INVITATION_RECIPIENT_MISMATCH',403);
  if((await db.query('SELECT id FROM "user" WHERE lower(email)=$1',[email])).rows.length)fail('INVITATION_EXISTING_IDENTITY_LOGIN_REQUIRED');
  const latest=await clock(db);live(row,route,null,latest);
  const next=acceptInvitation(model(row),{expectedVersion:row.version,linkDigest:route.digest,recipientDigest,verifiedUserId:userId,verifiedEmail:true,existingMembership:false},'ACTIVE',latest);
  await db.query("SELECT pg_catalog.set_config('app.invitation_link_digest',$1,true),pg_catalog.set_config('app.invitation_new_user_id',$2,true)",[route.digest,userId]);
  const user=await db.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true) RETURNING id',[userId,name,email]);
  if(user.rows.length!==1||user.rows[0].id!==userId)fail('INVITATION_IDENTITY_WRITE_UNCONFIRMED');
  const account=await db.query('INSERT INTO account(id,"accountId","providerId","userId",password,issuer) VALUES($1,$2,$3,$2,$4,$5) RETURNING id',[accountId,userId,'credential',input.passwordHash,'local:credential']);
  if(account.rows.length!==1||account.rows[0].id!==accountId)fail('INVITATION_CREDENTIAL_WRITE_UNCONFIRMED');
  const member=await db.query('INSERT INTO memberships(user_id,workspace_id,role,active) VALUES($1,$2,$3,true) RETURNING user_id,workspace_id,role,active',[userId,route.workspaceId,next.role]);
  if(member.rows.length!==1||member.rows[0].user_id!==userId||member.rows[0].workspace_id!==route.workspaceId||member.rows[0].role!==next.role||member.rows[0].active!==true)fail('INVITATION_MEMBERSHIP_WRITE_UNCONFIRMED');
  const saved=(await db.query("UPDATE profile_invitations SET status='ACCEPTED',version=version+1,accepted_user_id=$4 WHERE workspace_id=$1 AND id=$2 AND version=$3 AND status='PENDING' AND expires_at>clock_timestamp() RETURNING *",[route.workspaceId,row.id,row.version,userId])).rows;
  if(saved.length!==1||saved[0].status!=='ACCEPTED'||saved[0].version!==next.version||saved[0].accepted_user_id!==userId)fail('INVITATION_ACCEPTANCE_WRITE_UNCONFIRMED');
  await appendEvent(db,{workspace_id:route.workspaceId,environment:'REAL',event_type:'profile.invitation.accepted',aggregate_id:row.id,correlation_id:correlation,actor:{type:'human',id:userId},payload:{role:next.role,version:next.version,identityCreated:true}});
  const final=await activeInvitation(db,route);if(final.status!=='ACCEPTED'||final.accepted_user_id!==userId||final.version!==next.version)fail('INVITATION_ACCEPTANCE_CHANGED');
  live(final,route,null,await clock(db));
  return{registered:true as const,loginRequired:true as const};
 });}catch(error){if((error as {code?:string})?.code==='23505')fail('INVITATION_EXISTING_IDENTITY_LOGIN_REQUIRED');throw error;}
}
