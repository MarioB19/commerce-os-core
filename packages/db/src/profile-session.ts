import type {QueryExecutor} from './index.js';
import {profileRoleSchema,profileStateSchema,type ProfileRole,type ProfileState} from '../../contracts/src/profiles.js';
import {effectiveProfileScopes,type ProfileAuthority} from '../../domain/src/core/profile-authorization.js';

/** Obtained from Better Auth, never a request body, header or a PAT. */
export interface InteractiveSession {id:string;userId:string}
export interface ProfileFence {workspaceId:string;version:number}
export interface SessionProfile {
 profile:{id:string;businessName:string;state:ProfileState;timezone:string;version:number};
 membership:{role:ProfileRole;version:number};
 selection:ProfileFence;
 authority:ProfileAuthority;
}
export class ProfileSessionError extends Error {
 constructor(readonly code:string,readonly statusCode=409){super(code);this.name='ProfileSessionError';}
}
function need(value:unknown,code:string,statusCode=409):asserts value{if(!value)throw new ProfileSessionError(code,statusCode);}
function identity(session:InteractiveSession){
 need(typeof session?.id==='string'&&session.id.length>0&&typeof session.userId==='string'&&session.userId.length>0,'INTERACTIVE_SESSION_REQUIRED',401);
}
function version(value:unknown){return Number.isSafeInteger(value)&&Number(value)>0;}

/** Fixed lock order: session → selection → membership → profile.
 * `lock` is for an existing transaction only. The caller retains locks through
 * its commercial write; no provider call or raw connection is exposed here.
 */
async function sessionRow(db:QueryExecutor,session:InteractiveSession,lock:'share'|'update'|undefined){
 identity(session);
 const row=(await db.query('SELECT id,"userId","expiresAt" FROM session WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp()'+(lock?' FOR '+lock.toUpperCase():''),[session.id,session.userId])).rows[0];
 need(row,'PROFILE_SESSION_EXPIRED',401);return row;
}
async function selectionRow(db:QueryExecutor,session:InteractiveSession,lock:'share'|'update'|undefined){
 return(await db.query('SELECT workspace_id,membership_version,version FROM profile_session_context WHERE session_id=$1 AND user_id=$2'+(lock?' FOR '+lock.toUpperCase():''),[session.id,session.userId])).rows[0];
}
async function memberAndProfile(db:QueryExecutor,userId:string,workspaceId:string,lock:boolean){
 const member=(await db.query('SELECT role,active,version FROM memberships WHERE user_id=$1 AND workspace_id=$2'+(lock?' FOR SHARE':''),[userId,workspaceId])).rows[0];
 need(member?.active===true,'PROFILE_MEMBERSHIP_REQUIRED',403);
 const parsed=profileRoleSchema.safeParse(member.role);
 need(parsed.success&&version(member.version),'PROFILE_ROLE_ADOPTION_REQUIRED',403);
 const profile=(await db.query('SELECT id,business_name,state,timezone,version FROM profiles WHERE id=$1'+(lock?' FOR SHARE':''),[workspaceId])).rows[0];
 need(profile&&profileStateSchema.safeParse(profile.state).success&&version(profile.version),'PROFILE_UNAVAILABLE',403);
 return {member:{...member,role:parsed.data},profile};
}

/** Minimal identity bootstrap; returns only this authenticated user's profiles. */
export async function listSessionProfiles(db:QueryExecutor,session:InteractiveSession){
 await sessionRow(db,session,undefined);
 const profiles=(await db.query(`SELECT p.id,p.business_name,p.state,p.timezone,m.role,m.version AS membership_version,
  COALESCE(c.workspace_id=p.id AND c.membership_version=m.version,false) AS selected,c.version AS selection_version
 FROM memberships m JOIN profiles p ON p.id=m.workspace_id
 LEFT JOIN profile_session_context c ON c.session_id=$2 AND c.user_id=m.user_id
 WHERE m.user_id=$1 AND m.active=true ORDER BY p.business_name,p.id`,[session.userId,session.id])).rows;
 await sessionRow(db,session,undefined);
 return profiles;
}

export async function resolveSessionProfile(db:QueryExecutor,session:InteractiveSession,fence?:ProfileFence,options:{lock?:boolean}={}):Promise<SessionProfile>{
 if(options.lock)need(fence,'PROFILE_REQUEST_FENCE_REQUIRED',400);
 const native=await sessionRow(db,session,options.lock?'share':undefined);
 // The native session SHARE lock above serializes both authenticated020 and
 // legacy selection writers, which acquire UPDATE on that parent first. The
 // child is SELECT-only for the API after030; locking it would require UPDATE.
 const selected=await selectionRow(db,session,undefined);
 // Under forced profile RLS (V7 F2) the selection row is visible only in the
 // fenced profile's context: a fence for another profile reads as no row.
 need(selected&&version(selected.version),fence?'PROFILE_SELECTION_CHANGED':'PROFILE_SELECTION_REQUIRED');
 if(fence)need(typeof fence.workspaceId==='string'&&version(fence.version)&&fence.workspaceId===selected.workspace_id&&fence.version===selected.version,'PROFILE_SELECTION_CHANGED');
 const {member,profile}=await memberAndProfile(db,session.userId,selected.workspace_id,Boolean(options.lock));
 need(member.version===selected.membership_version,'PROFILE_SESSION_ACCESS_CHANGED');
 const authority:ProfileAuthority={profile:{id:profile.id,state:profile.state},membership:{userId:session.userId,workspaceId:profile.id,role:member.role,active:true,version:member.version},credential:{kind:'session',userId:session.userId,workspaceId:profile.id,revoked:false,expiresAt:new Date(native.expiresAt).toISOString(),scopes:[],membershipVersion:selected.membership_version}};
 effectiveProfileScopes(authority);
 return {profile:{id:profile.id,businessName:profile.business_name,state:profile.state,timezone:profile.timezone,version:profile.version},membership:{role:member.role,version:member.version},selection:{workspaceId:profile.id,version:selected.version},authority};
}

/** Must run in one transaction. Locking the native session serializes the first
 * selection too, where no context row yet exists. CAS never switches on replay.
 */
export async function selectSessionProfile(db:QueryExecutor,session:InteractiveSession,workspaceId:string,expectedVersion:number):Promise<ProfileFence>{
 need(typeof workspaceId==='string'&&workspaceId.length>0&&!workspaceId.includes('\0')&&Number.isSafeInteger(expectedVersion)&&expectedVersion>=0,'PROFILE_SELECTION_INVALID',400);
 await sessionRow(db,session,'update');
 const selected=await selectionRow(db,session,'update');
 need((selected?.version??0)===expectedVersion,'PROFILE_SELECTION_CHANGED');
 const {member}=await memberAndProfile(db,session.userId,workspaceId,true);
 // Membership/profile locks can wait beyond the original session expiry.
 // Recheck the database clock after waiting; retain the same native row lock.
 await sessionRow(db,session,'update');
 const row=(await db.query(`INSERT INTO profile_session_context(session_id,user_id,workspace_id,membership_version,version)
 SELECT $1,$2,$3,$4,1 WHERE EXISTS(SELECT 1 FROM session WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp())
 ON CONFLICT(session_id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id,
 membership_version=EXCLUDED.membership_version,version=profile_session_context.version+1,updated_at=clock_timestamp()
 WHERE profile_session_context.user_id=$2 AND profile_session_context.version=$5 RETURNING workspace_id,version`,[session.id,session.userId,workspaceId,member.version,expectedVersion])).rows[0];
 need(row&&version(row.version),'PROFILE_SELECTION_CHANGED');
 return {workspaceId:row.workspace_id,version:row.version};
}
