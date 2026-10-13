import {fromNodeHeaders} from 'better-auth/node';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {pool,withTransaction} from '../../../packages/db/src/index.js';
import {identityAudit} from '../../../packages/db/src/identity.js';
import {createPlatformProfile,invitePlatformOwner,isPlatformAdmin,isPlatformToken,issuePlatformToken,listPlatformProfiles,listPlatformTokens,readPlatformCapacity,resolvePlatformToken,revokePlatformToken,updatePlatformProfile,PlatformError,type PlatformScope,type PlatformSession} from '../../../packages/db/src/platform-profiles.js';
import {auth,trustedOrigins} from './auth.js';

/** V7 RF-01.5/RF-02 platform administration (super-admin). An interactive
 * session or a platform token (cos_plt_, RF-02.c: same actions through MCP);
 * never a profile PAT, service token or profile fence. Every SQL port
 * re-verifies the credential and the active admin row. */
export interface PlatformRouteDependencies {
 origins:readonly string[];
 session(req:FastifyRequest):Promise<PlatformSession|null>;
 token?(raw:string):Promise<PlatformSession>;
}
const defaults:PlatformRouteDependencies={
 origins:trustedOrigins,
 async session(req){
  const native=await auth.api.getSession({headers:fromNodeHeaders(req.headers),query:{disableRefresh:true}});
  if(!native||native.session.userId!==native.user.id)return null;
  return{id:native.session.id,userId:native.user.id};
 },
 token:raw=>resolvePlatformToken(pool,raw),
};
const idParams=z.object({id:z.string().min(1).max(256)}).strict();
export async function platformProfileRoutes(app:FastifyInstance,deps:PlatformRouteDependencies=defaults){
 const resolveToken=deps.token??defaults.token!;
 app.setErrorHandler((error,_req,reply)=>{
  if(error instanceof PlatformError)return reply.code(error.statusCode).send({error:{code:error.code,message:error.code}});
  if(error instanceof z.ZodError)return reply.code(400).send({error:{code:'PLATFORM_REQUEST_INVALID',message:'PLATFORM_REQUEST_INVALID'}});
  throw error;
 });
 async function session(req:FastifyRequest,reply:FastifyReply,mutation:boolean,scope:PlatformScope|null,options:{interactiveOnly?:boolean}={}){
  reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('Vary','Cookie, Authorization');
  if(req.headers['x-commerce-profile-id']!==undefined||req.headers['x-commerce-profile-version']!==undefined)throw new PlatformError('PLATFORM_OUTSIDE_PROFILE_REQUIRED',409);
  const bearer=req.headers.authorization;
  if(bearer!==undefined){
   const raw=typeof bearer==='string'&&bearer.startsWith('Bearer ')?bearer.slice(7):'';
   if(!isPlatformToken(raw)||options.interactiveOnly)throw new PlatformError('PLATFORM_INTERACTIVE_SESSION_REQUIRED',403);
   const current=await resolveToken(raw);
   if(scope&&!current.scopes?.includes(scope))throw new PlatformError('PLATFORM_SCOPE_REQUIRED',403);
   return current;
  }
  if(mutation&&(!req.headers.origin||!deps.origins.includes(req.headers.origin)))throw new PlatformError('ORIGIN_REJECTED',403);
  const current=await deps.session(req);
  if(!current?.id||!current.userId)throw new PlatformError('PROFILE_SESSION_EXPIRED',401);
  return current;
 }
 async function audited<T>(current:PlatformSession,action:string,req:FastifyRequest,work:(db:Parameters<typeof createPlatformProfile>[0])=>Promise<T>){
  return withTransaction(async db=>{const result=await work(db);await identityAudit(db,action,'SUCCEEDED',req.id,current.userId,current.userId);return result;});
 }
 app.get('/v2/platform/access',async(req,reply)=>{
  const current=await session(req,reply,false,null);
  return{data:{admin:await isPlatformAdmin(pool,current)}};
 });
 app.get('/v2/platform/profiles',async(req,reply)=>{
  if(Object.keys(req.query??{}).length)throw new PlatformError('PLATFORM_QUERY_NOT_ALLOWED',400);
  const current=await session(req,reply,false,'platform:profiles');
  return{data:{profiles:await listPlatformProfiles(pool,current),capacity:await readPlatformCapacity(pool,current)}};
 });
 app.get('/v2/platform/capacity',async(req,reply)=>{
  if(Object.keys(req.query??{}).length)throw new PlatformError('PLATFORM_QUERY_NOT_ALLOWED',400);
  const current=await session(req,reply,false,'platform:capacity');
  return{data:await readPlatformCapacity(pool,current)};
 });
 app.post('/v2/platform/profiles',{bodyLimit:4096},async(req,reply)=>{
  const current=await session(req,reply,true,'platform:profiles');
  const result=await audited(current,'platform.profile.create',req,db=>createPlatformProfile(db,current,req.body));
  return reply.code(result.replayed?200:201).send({data:result});
 });
 app.patch('/v2/platform/profiles/:id',{bodyLimit:4096},async(req,reply)=>{
  const current=await session(req,reply,true,'platform:profiles'),{id}=idParams.parse(req.params);
  return{data:await audited(current,'platform.profile.update',req,db=>updatePlatformProfile(db,current,id,req.body))};
 });
 app.post('/v2/platform/profiles/:id/owner-invitations',{bodyLimit:4096},async(req,reply)=>{
  const current=await session(req,reply,true,'platform:profiles'),{id}=idParams.parse(req.params);
  const result=await audited(current,'platform.profile.invite_owner',req,db=>invitePlatformOwner(db,current,id,req.body));
  return reply.code(result.replayed?200:202).send({data:result});
 });
 app.get('/v2/platform/tokens',async(req,reply)=>{
  if(Object.keys(req.query??{}).length)throw new PlatformError('PLATFORM_QUERY_NOT_ALLOWED',400);
  const current=await session(req,reply,false,null);
  return{data:await listPlatformTokens(pool,current)};
 });
 app.post('/v2/platform/tokens',{bodyLimit:2048},async(req,reply)=>{
  const current=await session(req,reply,true,null,{interactiveOnly:true});
  const result=await audited(current,'platform.token.issue',req,db=>issuePlatformToken(db,current,req.body));
  return reply.code(201).send({data:result});
 });
 app.post('/v2/platform/tokens/:id/revoke',{bodyLimit:256},async(req,reply)=>{
  const current=await session(req,reply,true,null),{id}=idParams.parse(req.params);
  return{data:await audited(current,'platform.token.revoke',req,db=>revokePlatformToken(db,current,id))};
 });
}
