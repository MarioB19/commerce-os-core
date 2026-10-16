import {fromNodeHeaders} from 'better-auth/node';
import type {FastifyRequest} from 'fastify';
import {profileIdSchema,profileRoleScopes,type ProfileScope} from '../../../packages/contracts/src/profiles.js';
import type {Role} from '../../../packages/contracts/src/index.js';
import {pool} from '../../../packages/db/src/index.js';
import {withProfileTransaction,type ProfileExecutor} from '../../../packages/db/src/profile-context.js';
import {resolveSessionProfile,type InteractiveSession,type ProfileFence} from '../../../packages/db/src/profile-session.js';
import {resolveImplicitSessionFence} from '../../../packages/db/src/profile-implicit-selection.js';
import {resolvePersonalProfile,relockPersonalProfile} from '../../../packages/db/src/profile-personal-token.js';
import {resolveServiceProfile,relockServiceProfile,isServiceBearer} from '../../../packages/db/src/profile-service-token.js';
import {effectiveProfileScopes} from '../../../packages/domain/src/core/profile-authorization.js';
import {legacyAliasesForScopes} from '../../../packages/domain/src/core/profile-legacy-principal.js';
import {permissionsFor,type Principal} from '../../../packages/domain/src/core/permissions.js';
import {auth,trustedOrigins} from './auth.js';

/** Unified request authority (V7 F2). Every authenticated historical route is
 * bound to exactly one profile resolved by the server from the credential:
 * - interactive session: the explicit CAS selection (headers X-Commerce-Profile-
 *   Id/-Version are verified when sent and required with 2+ memberships); with
 *   exactly one active membership the selection is made automatically and
 *   audited, never "the first" of several;
 * - personal token (cos_pat_): the profile its route was issued for;
 * - service token: the profile of its workspace (V5 automation/MCP).
 * Authorization by role/scope stays with each route; RLS binds every query. */
export type RequestCredential=
 |{kind:'session';session:InteractiveSession;fence:ProfileFence}
 |{kind:'personal_token';route:{tokenId:string;workspaceId:string;userId:string}}
 |{kind:'service_token';tokenId:string};
export interface RequestAuthority {workspaceId:string;principal:Principal;credential:RequestCredential;profileState:'ACTIVE'|'SUSPENDED'}
const authorities=new WeakMap<FastifyRequest,RequestAuthority>();
export const requestAuthority=(req:FastifyRequest)=>authorities.get(req);
const fail=(statusCode:number,code:string,message=code)=>Object.assign(new Error(message),{statusCode,code});
const readOnly=(method:string)=>['GET','HEAD','OPTIONS'].includes(method);

function headerFence(req:FastifyRequest):ProfileFence|undefined{
 const id=req.headers['x-commerce-profile-id'],raw=req.headers['x-commerce-profile-version'];
 if(id===undefined&&raw===undefined)return undefined;
 const profile=profileIdSchema.safeParse(id);
 if(!profile.success||typeof raw!=='string'||!/^[1-9][0-9]*$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw fail(409,'PROFILE_REQUEST_FENCE_REQUIRED');
 return{workspaceId:profile.data,version:Number(raw)};
}
/** Historical permissions keep the legacy role table when the credential has
 * the role's complete scope set; a restricted PAT gets only mapped aliases. */
function personalPermissions(role:Role,scopes:readonly ProfileScope[]){
 const full=profileRoleScopes[role as 'owner'|'operator'|'viewer'].filter(s=>s!=='profiles:switch');
 return full.every(scope=>scopes.includes(scope))?permissionsFor(role):legacyAliasesForScopes(scopes);
}
async function displayIdentity(db:ProfileExecutor,userId:string){
 const user=(await db.query('SELECT id,name,email FROM "user" WHERE id=$1',[userId])).rows[0];
 if(!user)throw fail(401,'INVALID_PERSONAL_TOKEN');
 return{id:user.id as string,name:user.name as string,email:user.email as string};
}

export async function authenticateRequest(req:FastifyRequest):Promise<RequestAuthority>{
 const bearer=req.headers.authorization;
 let result:RequestAuthority;
 if(bearer!==undefined){
  if(req.headers['x-commerce-profile-id']!==undefined||req.headers['x-commerce-profile-version']!==undefined)throw fail(403,'PROFILE_TOKEN_CANNOT_SELECT');
  if(typeof bearer!=='string'||!bearer.startsWith('Bearer '))throw fail(401,'INVALID_TOKEN');
  const token=bearer.slice(7);
  if(token.startsWith('cos_pat_')){
   const personal=await resolvePersonalProfile(pool,token).catch(()=>{throw fail(401,'INVALID_PERSONAL_TOKEN');});
   const scopes=effectiveProfileScopes(personal.authority),role=personal.membership.role as Role;
   const user=await withProfileTransaction(pool,personal.profile.id,db=>displayIdentity(db,personal.route.userId));
   result={workspaceId:personal.profile.id,profileState:personal.profile.state,credential:{kind:'personal_token',route:personal.route},
    principal:{user,workspace_id:personal.profile.id,role,permissions:personalPermissions(role,scopes),service:false,scopes:[],authentication_method:'personal_access_token',
     token_id:personal.tokenId,token_expires_at:personal.authority.credential.expiresAt,idempotency_actor:'personal:'+personal.tokenId,
     allowed_environments:[...personal.allowedEnvironments],resource_ids:null}};
  }else{
   if(!isServiceBearer(token))throw fail(401,'INVALID_TOKEN');
   const service=await resolveServiceProfile(pool,token).catch(()=>{throw fail(401,'INVALID_TOKEN');});
   result={workspaceId:service.profile.id,profileState:service.profile.state,credential:{kind:'service_token',tokenId:service.tokenId},
    principal:{user:{id:service.actorId,name:service.name,email:''},workspace_id:service.profile.id,role:'viewer',permissions:[],service:true,
     authentication_method:'service_token',scopes:[...service.scopes],token_id:service.tokenId,...(token.startsWith('cos_v5_')?{idempotency_actor:'service:'+service.tokenId}:{}),
     allowed_environments:[...service.allowedEnvironments],resource_ids:service.resourceIds?[...service.resourceIds]:null}};
  }
 }else{
  const native=await auth.api.getSession({headers:fromNodeHeaders(req.headers)});
  if(!native||native.session.userId!==native.user.id)throw fail(401,'UNAUTHENTICATED','Inicia sesión.');
  if(!readOnly(req.method)&&(!req.headers.origin||!trustedOrigins.includes(req.headers.origin)))throw fail(403,'ORIGIN_REJECTED');
  const session={id:native.session.id,userId:native.user.id};
  const fence=headerFence(req)??await resolveImplicitSessionFence(pool,session,req.id);
  const profile=await withProfileTransaction(pool,fence.workspaceId,db=>resolveSessionProfile(db,session,fence));
  result={workspaceId:profile.profile.id,profileState:profile.profile.state,credential:{kind:'session',session,fence:profile.selection},
   principal:{user:{id:native.user.id,name:native.user.name,email:native.user.email},workspace_id:profile.profile.id,role:profile.membership.role as Role,
    permissions:permissionsFor(profile.membership.role as Role),service:false,scopes:[],authentication_method:'session'}};
 }
 // V7: a suspended profile keeps read access to its own data and account
 // security, but no historical commercial mutation.
 if(result.profileState!=='ACTIVE'&&!readOnly(req.method)&&!req.url.startsWith('/v1/account'))throw fail(403,'PROFILE_SUSPENDED','Este perfil está suspendido.');
 authorities.set(req,result);
 return result;
}

/** Inside a mutation's profile transaction: the same credential is locked and
 * re-validated with the database clock before the change can commit. */
export async function relockRequestAuthority(req:FastifyRequest,db:ProfileExecutor,environment:'REAL'|'SIMULATION'):Promise<void>{
 const current=authorities.get(req);
 if(!current)return;
 if(db.workspaceId!==current.workspaceId)throw fail(403,'PROFILE_REQUEST_SCOPE_MISMATCH');
 if(current.credential.kind==='session'){
  const profile=await resolveSessionProfile(db,current.credential.session,current.credential.fence,{lock:true});
  if(profile.membership.role!==current.principal.role)throw fail(409,'PROFILE_SESSION_ACCESS_CHANGED');
  if(profile.profile.state!=='ACTIVE'&&!req.url.startsWith('/v1/account'))throw fail(403,'PROFILE_SUSPENDED','Este perfil está suspendido.');
 }else if(current.credential.kind==='personal_token'){
  await relockPersonalProfile(db,current.credential.route,environment).catch(error=>{throw Object.assign(fail(401,'INVALID_PERSONAL_TOKEN'),{cause:error});});
 }else{
  const service=await relockServiceProfile(db,current.credential.tokenId,environment).catch(error=>{throw Object.assign(fail(401,'INVALID_TOKEN'),{cause:error});});
  if(service.profile.state!=='ACTIVE')throw fail(403,'PROFILE_SUSPENDED','Este perfil está suspendido.');
 }
}
