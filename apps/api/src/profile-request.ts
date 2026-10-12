import {fromNodeHeaders} from 'better-auth/node';
import type {FastifyRequest} from 'fastify';
import {z} from 'zod';
import {profileIdSchema} from '../../../packages/contracts/src/profiles.js';
import {pool} from '../../../packages/db/src/index.js';
import type {ProfileExecutor} from '../../../packages/db/src/profile-context.js';
import {bindProfileEnvironment} from '../../../packages/db/src/profile-environment.js';
import type {InteractiveSession,ProfileFence,SessionProfile} from '../../../packages/db/src/profile-session.js';
import {withProfileSessionTransaction} from '../../../packages/db/src/profile-session-transaction.js';
import {withPersonalProfileTransaction,type PersonalProfile,type ProfileEnvironment} from '../../../packages/db/src/profile-personal-token.js';
import type {ProfileAction} from '../../../packages/domain/src/core/profile-authorization.js';
import {auth,trustedOrigins} from './auth.js';

type Action=Omit<ProfileAction,'workspaceId'>;
export interface ProfileRequestContext {db:ProfileExecutor;profile:SessionProfile|PersonalProfile;environment:ProfileEnvironment}
type Work<T>=(context:ProfileRequestContext)=>Promise<T>;
export interface ProfileRequestDependencies {
 origins:readonly string[];
 nativeSession(req:FastifyRequest):Promise<InteractiveSession|null>;
 session<T>(session:InteractiveSession,fence:ProfileFence,environment:ProfileEnvironment,action:Action,work:Work<T>):Promise<T>;
 personal<T>(token:string,environment:ProfileEnvironment,action:Action,work:Work<T>):Promise<T>;
}
const defaults:ProfileRequestDependencies={
 origins:trustedOrigins,
 async nativeSession(req){
  const value=await auth.api.getSession({headers:fromNodeHeaders(req.headers),query:{disableRefresh:true}});
  return value&&value.session.userId===value.user.id?{id:value.session.id,userId:value.user.id}:null;
 },
 session:(session,fence,environment,action,work)=>withProfileSessionTransaction(pool,session,fence,action,async(db,profile)=>{await bindProfileEnvironment(db,environment);return work({db,profile,environment});}),
 personal:(token,environment,action,work)=>withPersonalProfileTransaction(pool,token,environment,action,async(db,profile)=>{await bindProfileEnvironment(db,environment);return work({db,profile,environment});}),
};
function deny(code:string,statusCode=400):never{throw Object.assign(new Error(code),{code,statusCode});}
const readQuery=z.object({environment:z.enum(['REAL','SIMULATION']).optional()}).strict();
/** Only for reads whose complete query contract is environment. Other route
 * families parse their own closed query schemas before calling the adapter.
 */
export function profileReadEnvironment(req:FastifyRequest):ProfileEnvironment{
 const result=readQuery.safeParse(req.query??{});
 if(!result.success)return deny('PROFILE_QUERY_INVALID');
 return result.data.environment??'REAL';
}
function requestFence(req:FastifyRequest):ProfileFence{
 const profile=profileIdSchema.safeParse(req.headers['x-commerce-profile-id']);
 const raw=req.headers['x-commerce-profile-version'];
 if(!profile.success||typeof raw!=='string'||!/^[1-9][0-9]*$/.test(raw)||String(Number(raw))!==raw||!Number.isSafeInteger(Number(raw)))return deny('PROFILE_REQUEST_FENCE_REQUIRED',409);
 return {workspaceId:profile.data,version:Number(raw)};
}

/** One identity kind and one transaction; raw replies, pools and arbitrary
 * profile overrides are deliberately absent from the callback contract.
 */
export async function withProfileRequest<T>(req:FastifyRequest,environment:ProfileEnvironment,action:Action,work:Work<T>,deps:ProfileRequestDependencies=defaults):Promise<T>{
 if(environment!=='REAL'&&environment!=='SIMULATION')return deny('PROFILE_ENVIRONMENT_INVALID');
 const bearer=req.headers.authorization;
 if(bearer!==undefined){
  if(req.headers['x-commerce-profile-id']!==undefined||req.headers['x-commerce-profile-version']!==undefined)return deny('PROFILE_TOKEN_CANNOT_SELECT',403);
  if(typeof bearer!=='string'||!/^Bearer cos_pat_[A-Za-z0-9_-]{43}$/.test(bearer))return deny('PROFILE_PERSONAL_TOKEN_REQUIRED',401);
  return deps.personal(bearer.slice(7),environment,action,work);
 }
 if((action.mutation||!['GET','HEAD','OPTIONS'].includes(req.method))&&(!req.headers.origin||!deps.origins.includes(req.headers.origin)))return deny('ORIGIN_REJECTED',403);
 const fence=requestFence(req),session=await deps.nativeSession(req);
 if(!session?.id||!session.userId)return deny('PROFILE_SESSION_EXPIRED',401);
 return deps.session(session,fence,environment,action,work);
}
