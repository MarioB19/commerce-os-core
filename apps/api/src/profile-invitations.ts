import type {FastifyInstance,FastifyReply} from 'fastify';
import {z} from 'zod';
import {invitationCreateSchema,invitationCancelSchema,invitationListQuerySchema} from '../../../packages/contracts/src/profile-invitations.js';
import {queueProfileInvitation,listProfileInvitations,cancelProfileInvitation,findProfileInvitationOperation} from '../../../packages/db/src/profile-invitation.js';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';
function invalid():never{throw Object.assign(new Error('INVITATION_INPUT_INVALID'),{code:'INVITATION_INPUT_INVALID',statusCode:400});}
function privateReply(reply:FastifyReply){reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization').header('Referrer-Policy','no-referrer');}
/** Staged routes only. Registration and mail delivery require the full cutover. */
export async function profileInvitationRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){

 app.get('/v2/invitations',async(req,reply)=>{
  privateReply(reply);
  const query=invitationListQuerySchema.safeParse(req.query??{});if(!query.success)invalid();
  return withProfileRequest(req,'REAL',{scope:'employees:read',mutation:false},({db,profile})=>listProfileInvitations(db,profile.authority,query.data.afterId),deps);
 });
 app.get('/v2/invitations/operations/:operationId',async(req,reply)=>{
  privateReply(reply);const id=z.uuid().safeParse((req.params as {operationId:unknown}).operationId);if(!id.success||Object.keys(req.query??{}).length)invalid();
  return{data:await withProfileRequest(req,'REAL',{scope:'employees:read',mutation:false},({db,profile})=>findProfileInvitationOperation(db,profile.authority,id.data),deps)};
 });
 app.post('/v2/invitations',{bodyLimit:2048},async(req,reply)=>{
  privateReply(reply);
  const body=invitationCreateSchema.safeParse(req.body);if(!body.success||Object.keys(req.query??{}).length)invalid();
  const data=await withProfileRequest(req,'REAL',{scope:'employees:write',mutation:true},({db,profile})=>queueProfileInvitation(db,profile.authority,body.data,req.id),deps);
  reply.code(data.created?201:200);return{data};
 });
 app.post('/v2/invitations/:id/cancel',{bodyLimit:1024},async(req,reply)=>{
  privateReply(reply);
  const body=invitationCancelSchema.safeParse(req.body),id=z.uuid().safeParse((req.params as {id:unknown}).id);if(!body.success||!id.success||Object.keys(req.query??{}).length)invalid();
  return{data:await withProfileRequest(req,'REAL',{scope:'employees:write',mutation:true},({db,profile})=>cancelProfileInvitation(db,profile.authority,id.data,body.data.expectedVersion,req.id),deps)};
 });
}
