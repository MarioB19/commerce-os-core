import type {FastifyInstance,FastifyRequest} from 'fastify';
import {fromNodeHeaders} from 'better-auth/node';
import {auth,trustedOrigins} from './auth.js';
import {pool} from '../../../packages/db/src/index.js';
import type {InteractiveSession} from '../../../packages/db/src/profile-session.js';
import {acceptExistingProfileInvitation,readExistingProfileInvitation} from '../../../packages/db/src/profile-invitation-acceptance.js';
import {invitationAcceptSchema,invitationAcceptResultSchema,invitationAcceptanceStateSchema,type InvitationAcceptResult,type InvitationAcceptanceState} from '../../../packages/contracts/src/profile-invitation-acceptance.js';
export interface InvitationAcceptanceDependencies{
 origins:readonly string[];
 nativeSession(req:FastifyRequest):Promise<InteractiveSession|null>;
 accept(session:InteractiveSession,token:string,correlation:string):Promise<InvitationAcceptResult>;
 read(session:InteractiveSession,token:string):Promise<InvitationAcceptanceState>;
}
const defaults:InvitationAcceptanceDependencies={
 origins:trustedOrigins,
 async nativeSession(req){const result=await auth.api.getSession({headers:fromNodeHeaders(req.headers),query:{disableRefresh:true}});return result&&result.user.id===result.session.userId?{id:result.session.id,userId:result.user.id}:null;},
 accept:(session,token,correlation)=>acceptExistingProfileInvitation(pool,session,token,correlation),
 read:(session,token)=>readExistingProfileInvitation(pool,session,token),
};
function deny(code:string,statusCode:number):never{throw Object.assign(new Error(code),{code,statusCode});}
/** Prepared existing-user acceptance. Not registered by the application yet.
 * Secret input is never included in responses or route logs. */
export async function invitationAcceptanceRoutes(app:FastifyInstance,deps:InvitationAcceptanceDependencies=defaults){
 async function authorize(req:FastifyRequest){
  const input=invitationAcceptSchema.safeParse(req.body);
  if(!input.success||Object.keys(req.query??{}).length)deny('INVITATION_INPUT_INVALID',400);
  if(req.headers.authorization!==undefined||req.headers['x-commerce-profile-id']!==undefined||req.headers['x-commerce-profile-version']!==undefined)deny('INVITATION_INTERACTIVE_SESSION_ONLY',403);
  if(!req.headers.origin||!deps.origins.includes(req.headers.origin))deny('ORIGIN_REJECTED',403);
  const session=await deps.nativeSession(req);if(!session?.id||!session.userId)deny('INVITATION_SESSION_REQUIRED',401);
  return{session,token:input.data.token};
 }
 const options={
  bodyLimit:1024,logLevel:'silent' as const,
  onRequest:async(_req:FastifyRequest,reply:import('fastify').FastifyReply)=>{reply.header('Cache-Control','no-store').header('Vary','Cookie').header('Referrer-Policy','no-referrer');},
 };
 app.post('/v2/invitation-acceptance',options,async(req,reply)=>{
  const {session,token}=await authorize(req);
  const data=invitationAcceptResultSchema.parse(await deps.accept(session,token,req.id));
  reply.code(data.created?201:200);return{data};
 });
 app.post('/v2/invitation-acceptance/status',options,async req=>{
  const {session,token}=await authorize(req);
  return{data:invitationAcceptanceStateSchema.parse(await deps.read(session,token))};
 });
}
