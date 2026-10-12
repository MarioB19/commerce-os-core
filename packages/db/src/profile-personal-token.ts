import {changesProfileAuthority,lockProfileAuthorityChange} from './profile-authority-lock.js';
import {createHash} from 'node:crypto';
import type {QueryExecutor} from './index.js';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from './profile-context.js';
import {personalProfileScopeSchema,profileRoleSchema,profileStateSchema,type ProfileRole,type ProfileState} from '../../contracts/src/profiles.js';
import {authorizeProfileAction,type ProfileAction,type ProfileAuthority} from '../../domain/src/core/profile-authorization.js';
import {z} from 'zod';

const scopesSchema=z.array(personalProfileScopeSchema).min(1).max(64).refine(scopes=>new Set(scopes).size===scopes.length);
const environmentsSchema=z.array(z.enum(['REAL','SIMULATION'])).min(1).max(2).refine(values=>new Set(values).size===values.length);
export type ProfileEnvironment='REAL'|'SIMULATION';
interface TokenRoute {tokenId:string;workspaceId:string;userId:string;hash:string}
export interface PersonalProfile {
 profile:{id:string;businessName:string;state:ProfileState;timezone:string;version:number};
 membership:{role:ProfileRole;version:number};
 tokenId:string;
 environment:ProfileEnvironment;
 authority:ProfileAuthority;
}
export class PersonalProfileTokenError extends Error {
 readonly statusCode=401;
 constructor(readonly code:string){super(code);this.name='PersonalProfileTokenError';}
}
function need(value:unknown,code:string):asserts value{if(!value)throw new PersonalProfileTokenError(code);}
function positive(value:unknown){return Number.isSafeInteger(value)&&Number(value)>0;}

/** The only global lookup is a fixed SECURITY DEFINER function returning three
 * identity IDs. The full secret/hash never appears in the returned authority.
 */
async function locate(db:QueryExecutor,token:string):Promise<TokenRoute>{
 need(typeof token==='string'&&/^cos_pat_[A-Za-z0-9_-]{43}$/.test(token),'PROFILE_PERSONAL_TOKEN_REQUIRED');
 const hash=createHash('sha256').update(token).digest('hex');
 const rows=(await db.query('SELECT token_id,workspace_id,user_id FROM public.locate_personal_profile_token($1)',[hash])).rows;
 need(rows.length===1,'PROFILE_PERSONAL_TOKEN_INVALID');
 const row=rows[0];
 need(typeof row.token_id==='string'&&/^[a-f0-9-]{36}$/.test(row.token_id)&&
  typeof row.workspace_id==='string'&&row.workspace_id.length>0&&
  typeof row.user_id==='string'&&row.user_id.length>0,'PROFILE_TOKEN_ROUTE_INVALID');
 return{tokenId:row.token_id,workspaceId:row.workspace_id,userId:row.user_id,hash};
}

/** Existing scoped transaction only. Membership → profile → token; the second
 * token read runs after the row lock has been acquired, using server time.
 */
async function authority(db:ProfileExecutor,route:TokenRoute,environment:ProfileEnvironment,lock=true):Promise<PersonalProfile>{
 need(db.workspaceId===route.workspaceId,'PROFILE_TOKEN_ROUTE_INVALID');
 const member=(await db.query('SELECT role,active,version FROM memberships WHERE user_id=$1 AND workspace_id=$2'+(lock?' FOR SHARE':''),[route.userId,route.workspaceId])).rows[0];
 const role=profileRoleSchema.safeParse(member?.role);
 need(member?.active===true&&role.success&&positive(member.version),'PROFILE_TOKEN_MEMBERSHIP_REQUIRED');
 const profile=(await db.query('SELECT id,business_name,state,timezone,version FROM profiles WHERE id=$1'+(lock?' FOR SHARE':''),[route.workspaceId])).rows[0];
 need(profile&&profileStateSchema.safeParse(profile.state).success&&positive(profile.version),'PROFILE_TOKEN_PROFILE_UNAVAILABLE');
 const values=[route.tokenId,route.workspaceId,route.userId,route.hash];
 const where=' FROM personal_access_tokens WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND token_hash=$4';
 need((await db.query('SELECT id'+where+(lock?' FOR SHARE':''),values)).rows.length===1,'PROFILE_PERSONAL_TOKEN_INVALID');
 const token=(await db.query('SELECT profile_scopes,allowed_environments,expires_at,revoked_at,expires_at>clock_timestamp() AS unexpired'+where,values)).rows[0];
 need(token&&token.revoked_at===null&&token.unexpired===true,'PROFILE_PERSONAL_TOKEN_INVALID');
 const scopes=scopesSchema.safeParse(token.profile_scopes),environments=environmentsSchema.safeParse(token.allowed_environments);
 need(scopes.success,'PROFILE_TOKEN_SCOPE_ADOPTION_REQUIRED');
 need(environments.success&&environments.data.includes(environment),'PROFILE_TOKEN_ENVIRONMENT_DENIED');
 const expiresAt=new Date(token.expires_at);
 need(Number.isFinite(expiresAt.getTime()),'PROFILE_PERSONAL_TOKEN_INVALID');
 const result:PersonalProfile={profile:{id:profile.id,businessName:profile.business_name,state:profile.state,timezone:profile.timezone,version:profile.version},membership:{role:role.data,version:member.version},tokenId:route.tokenId,environment,
  authority:{profile:{id:profile.id,state:profile.state},membership:{userId:route.userId,workspaceId:profile.id,role:role.data,active:true,version:member.version},credential:{kind:'personal_token',userId:route.userId,workspaceId:profile.id,expiresAt:expiresAt.toISOString(),revoked:false,scopes:scopes.data}}};
 return result;
}

/** Caller supplies the server action and parsed environment, never a workspace
 * override. Local SQL work only; external effects require a separate outbox.
 */
export async function withPersonalProfileTransaction<T>(
 pool:ProfilePool&QueryExecutor,token:string,environment:ProfileEnvironment,
 action:Omit<ProfileAction,'workspaceId'>,work:(db:ProfileExecutor,profile:PersonalProfile)=>Promise<T>,
):Promise<T>{
 need(environment==='REAL'||environment==='SIMULATION','PROFILE_TOKEN_ENVIRONMENT_DENIED');
 const route=await locate(pool,token);
 return withProfileTransaction(pool,route.workspaceId,async db=>{
  if(changesProfileAuthority(action)){
   const before=await authority(db,route,environment,false);
   authorizeProfileAction(before.authority,{...action,workspaceId:route.workspaceId});
   await lockProfileAuthorityChange(db,action);
  }
  const current=await authority(db,route,environment),boundAction={...action,workspaceId:route.workspaceId};
  authorizeProfileAction(current.authority,boundAction);
  const result=await work(db,current);
  const final=await authority(db,route,environment);
  authorizeProfileAction(final.authority,boundAction);
  return result;
 });
}

/** Request authentication for routes outside the single-transaction SQL
 * adapter: resolves the token's own profile and effective authority without
 * choosing an action. Each route still checks its own permission. */
export async function resolvePersonalProfile(pool:ProfilePool&QueryExecutor,token:string):Promise<PersonalProfile&{allowedEnvironments:ProfileEnvironment[];route:{tokenId:string;workspaceId:string;userId:string}}>{
 const route=await locate(pool,token);
 return withProfileTransaction(pool,route.workspaceId,async db=>{
  // The route's environment is parsed later; the legacy boundary then rejects
  // any environment outside this token's own allowed list.
  const allowed=environmentsSchema.safeParse((await db.query('SELECT allowed_environments FROM personal_access_tokens WHERE id=$1 AND workspace_id=$2 AND user_id=$3 AND token_hash=$4',
   [route.tokenId,route.workspaceId,route.userId,route.hash])).rows[0]?.allowed_environments);
  need(allowed.success,'PROFILE_PERSONAL_TOKEN_INVALID');
  const profile=await authority(db,route,allowed.data[0]!,false);
  return{...profile,allowedEnvironments:allowed.data,route:{tokenId:route.tokenId,workspaceId:route.workspaceId,userId:route.userId}};
 });
}
/** Re-lock an already authenticated PAT inside the caller's profile
 * transaction (mutations). Same lock order and server clock as the reader. */
export async function relockPersonalProfile(db:ProfileExecutor,route:{tokenId:string;workspaceId:string;userId:string},environment:ProfileEnvironment):Promise<void>{
 need(db.workspaceId===route.workspaceId,'PROFILE_TOKEN_ROUTE_INVALID');
 const hash=(await db.query('SELECT token_hash FROM personal_access_tokens WHERE id=$1 AND workspace_id=$2 AND user_id=$3',[route.tokenId,route.workspaceId,route.userId])).rows[0]?.token_hash;
 need(typeof hash==='string','PROFILE_PERSONAL_TOKEN_INVALID');
 await authority(db,{...route,hash},environment,true);
}
