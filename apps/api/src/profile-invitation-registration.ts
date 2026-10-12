import type {FastifyInstance,FastifyRequest} from 'fastify';
import {fromNodeHeaders} from 'better-auth/node';
import {hashPassword} from 'better-auth/crypto';
import {auth,trustedOrigins} from './auth.js';
import {pool} from '../../../packages/db/src/index.js';
import {identityLimit} from '../../../packages/db/src/identity.js';
import {registerInvitedProfileIdentity} from '../../../packages/db/src/profile-invitation-acceptance.js';
import {invitationRegistrationSchema,invitationRegistrationResultSchema,type InvitationRegistrationResult} from '../../../packages/contracts/src/profile-invitation-registration.js';
export interface InvitationRegistrationDependencies{
 origins:readonly string[];
 hasSession(req:FastifyRequest):Promise<boolean>;
 limit(kind:string,value:string,max:number):Promise<boolean>;
 hash(password:string):Promise<string>;
 register(input:{token:string;email:string;name:string;passwordHash:string},correlation:string):Promise<InvitationRegistrationResult>;
}
const defaults:InvitationRegistrationDependencies={origins:trustedOrigins,hasSession:async req=>Boolean(await auth.api.getSession({headers:fromNodeHeaders(req.headers),query:{disableRefresh:true}})),limit:identityLimit,hash:hashPassword,register:(input,correlation)=>registerInvitedProfileIdentity(pool,input,correlation)};
function deny(code:string,statusCode:number):never{throw Object.assign(new Error(code),{code,statusCode});}
const safeErrors=new Set(['INVITATION_LINK_INVALID_OR_EXPIRED','INVITATION_PROFILE_SUSPENDED','INVITATION_ISSUER_NO_LONGER_AUTHORIZED','INVITATION_RECIPIENT_MISMATCH','INVITATION_EXISTING_IDENTITY_LOGIN_REQUIRED','PROFILE_AUTHORITY_BUSY','INVITATION_EXISTING_SESSION_USE_ACCEPTANCE','IDENTITY_RATE_LIMITED']);
/** Prepared only. Native public sign-up stays disabled; no session/cookie is issued. */
export async function invitationRegistrationRoutes(app:FastifyInstance,deps:InvitationRegistrationDependencies=defaults){
 app.post('/v2/invitation-registration',{bodyLimit:4096,logLevel:'silent',onRequest:async(_req,reply)=>{reply.header('Cache-Control','no-store').header('Vary','Cookie').header('Referrer-Policy','no-referrer');}},async(req,reply)=>{
  const input=invitationRegistrationSchema.safeParse(req.body);if(!input.success||Object.keys(req.query??{}).length)deny('INVITATION_INPUT_INVALID',400);
  if(!req.headers.origin||!deps.origins.includes(req.headers.origin))deny('ORIGIN_REJECTED',403);
  if(req.headers.authorization!==undefined||req.headers['x-commerce-profile-id']!==undefined||req.headers['x-commerce-profile-version']!==undefined)deny('INVITATION_REGISTRATION_IDENTITY_REJECTED',403);
  try{
  if(await deps.hasSession(req))deny('INVITATION_EXISTING_SESSION_USE_ACCEPTANCE',409);
  if(!await deps.limit('invitation-register-ip',req.ip,10)||!await deps.limit('invitation-register-link',input.data.token,5))deny('IDENTITY_RATE_LIMITED',429);
   const {password,...values}=input.data,passwordHash=await deps.hash(password);
   const data=invitationRegistrationResultSchema.parse(await deps.register({...values,passwordHash},req.id));reply.code(201);return{data};
  }catch(error){
   const e=error as {code?:string;statusCode?:number};
   if(e.code&&safeErrors.has(e.code))deny(e.code,[403,404,409,429].includes(e.statusCode??0)?e.statusCode!:409);
   // Database/crypto/transport diagnostics can contain email, hash or submitted
   // values. Never serialize them or infer rollback from a missing COMMIT ACK.
   deny('INVITATION_REGISTRATION_OUTCOME_UNCONFIRMED',503);
  }
 });
}
