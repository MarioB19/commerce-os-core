import {fromNodeHeaders} from 'better-auth/node';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {profileBootstrapSchema,profileBrowserIdentitySchema,selectProfileSchema,type ProfileBootstrap} from '../../../packages/contracts/src/profiles.js';
import {pool,withTransaction} from '../../../packages/db/src/index.js';
import {identityAudit} from '../../../packages/db/src/identity.js';
import {ProfileSessionError,type InteractiveSession,type ProfileFence} from '../../../packages/db/src/profile-session.js';
import {listProfileChoicesFromSession,selectProfileFromSession} from '../../../packages/db/src/profile-identity-bootstrap.js';
import {auth,trustedOrigins} from './auth.js';

export interface ProfileIdentityDependencies {
 origins:readonly string[];
 session(req:FastifyRequest):Promise<(InteractiveSession&{user?:{id:string;name:string;email:string}})|null>;
 list(session:InteractiveSession):ReturnType<typeof listProfileChoicesFromSession>;
 select(session:InteractiveSession,workspace:string,version:number,correlation:string):Promise<ProfileFence>;
}
const defaults:ProfileIdentityDependencies={
 origins:trustedOrigins,
 async session(req){
  const native=await auth.api.getSession({headers:fromNodeHeaders(req.headers),query:{disableRefresh:true}});
  if(!native||native.session.userId!==native.user.id)return null;
  return{id:native.session.id,userId:native.user.id,user:{id:native.user.id,name:native.user.name,email:native.user.email}};
 },
 list:session=>listProfileChoicesFromSession(pool,session),
 select:(session,workspace,version,correlation)=>withTransaction(async db=>{
  const selection=await selectProfileFromSession(db,session,workspace,version);
  await identityAudit(db,'profile.selection','SUCCEEDED',correlation,session.userId,session.userId);
  return selection;
 }),
};
function denied(code:string,statusCode:number){return new ProfileSessionError(code,statusCode);}
function bootstrap(rows:Awaited<ReturnType<typeof listProfileChoicesFromSession>>):ProfileBootstrap{
 const versions=new Set(rows.map(row=>row.selection_version??0));
 if(versions.size>1)throw denied('PROFILE_BOOTSTRAP_INCONSISTENT',503);
 const selected=rows.filter(row=>row.selected===true);
 if(selected.length>1)throw denied('PROFILE_BOOTSTRAP_INCONSISTENT',503);
 const parsed=profileBootstrapSchema.safeParse({profiles:rows.map(row=>({id:row.id,businessName:row.business_name,state:row.state,timezone:row.timezone,role:row.role,membershipVersion:row.membership_version,selected:row.selected})),selection:{workspaceId:selected[0]?.id??null,version:[...versions][0]??0}});
 if(!parsed.success)throw denied('PROFILE_ROLE_ADOPTION_REQUIRED',503);
 return parsed.data;
}

/** Registered only with the complete profile-auth cutover; never uses legacy principal(). */
export async function profileIdentityRoutes(app:FastifyInstance,deps:ProfileIdentityDependencies=defaults){
 async function session(req:FastifyRequest,reply:FastifyReply){
  reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('Vary','Cookie');
  if(req.headers.authorization!==undefined)throw denied('PROFILE_INTERACTIVE_SESSION_REQUIRED',403);
  if(Object.keys(req.query??{}).length)throw denied('PROFILE_QUERY_NOT_ALLOWED',400);
  if(req.method==='POST'&&(!req.headers.origin||!deps.origins.includes(req.headers.origin)))throw denied('ORIGIN_REJECTED',403);
  const current=await deps.session(req);
  if(!current?.id||!current.userId)throw denied('PROFILE_SESSION_EXPIRED',401);
  return current;
 }
 app.get('/v2/me',async(req,reply)=>{
  const current=await session(req,reply),user=profileBrowserIdentitySchema.safeParse(current.user);
  if(!user.success||user.data.id!==current.userId)throw denied('PROFILE_IDENTITY_INCONSISTENT',503);
  return{data:{user:user.data,profile:bootstrap(await deps.list(current))}};
 });
 app.get('/v2/me/profiles',async(req,reply)=>({data:bootstrap(await deps.list(await session(req,reply)))}));
 app.post('/v2/me/profile-selection',{bodyLimit:2048},async(req,reply)=>{
  const current=await session(req,reply),input=selectProfileSchema.safeParse(req.body);
  if(!input.success)throw denied('PROFILE_SELECTION_INVALID',400);
  return{data:await deps.select(current,input.data.workspaceId,input.data.expectedVersion,req.id)};
 });
}
