import type {FastifyInstance,FastifyReply} from 'fastify';
import {z} from 'zod';
import {continuityEnvironmentSchema,continuityListSchema,continuityHumanBodySchema,continuityCommercialBodySchema} from '../../../packages/contracts/src/continuous-authorization.js';
import {listContinuousAuthorizations,readContinuousAuthorization,readContinuousHumanOperation,applyContinuousHumanCommand,issueCommercialContinuity} from '../../../packages/db/src/continuous-authorization.js';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';

function privateReply(reply:FastifyReply){reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization, X-Commerce-Profile-Id, X-Commerce-Profile-Version');}
function noQuery(query:unknown){z.object({}).strict().parse(query??{});}
const idSchema=z.object({id:z.uuid()}).strict();
/** Staged consumer. There is no public route for QR creation or protection
 * recovery: those require authenticated worker facts at their own boundary.
 */
export async function continuousAuthorizationRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 for(const [path,kind,readScope,writeScope] of [
  ['commercial','COMMERCIAL_ASSIGNMENT','assignments:read','assignments:write'],
  ['warmup','VERIFIED_QR_CONNECTION','warmup:read','warmup:write'],
 ] as const){
  const root='/v2/continuity/'+path;
  app.get(root,async(req,reply)=>{
   privateReply(reply);const query=continuityListSchema.parse(req.query??{});
   return withProfileRequest(req,query.environment,{scope:readScope,mutation:false},({db,profile})=>listContinuousAuthorizations(db,kind,query,profile.authority),deps);
  });
  app.get(root+'/operations/:id',async(req,reply)=>{
   privateReply(reply);const {id}=idSchema.parse(req.params),query=continuityEnvironmentSchema.parse(req.query??{});
   return {data:await withProfileRequest(req,query.environment,{scope:readScope,mutation:false},({db,profile})=>readContinuousHumanOperation(db,query.environment,id,kind,profile.authority),deps)};
  });
  app.get(root+'/:id',async(req,reply)=>{
   privateReply(reply);const {id}=idSchema.parse(req.params),query=continuityEnvironmentSchema.parse(req.query??{});
   return {data:await withProfileRequest(req,query.environment,{scope:readScope,mutation:false},({db,profile})=>readContinuousAuthorization(db,query.environment,id,kind,profile.authority),deps)};
  });
  app.post(root+'/:id/commands',{bodyLimit:2048},async(req,reply)=>{
   privateReply(reply);noQuery(req.query);const {id}=idSchema.parse(req.params),{environment,...command}=continuityHumanBodySchema.parse(req.body);
   return {data:await withProfileRequest(req,environment,{scope:writeScope,mutation:true},({db,profile})=>applyContinuousHumanCommand(db,environment,id,kind,command,profile.authority),deps)};
  });
 }
 app.post('/v2/continuity/commercial',{bodyLimit:2048},async(req,reply)=>{
  privateReply(reply);noQuery(req.query);const {environment,...command}=continuityCommercialBodySchema.parse(req.body);
  return {data:await withProfileRequest(req,environment,{scope:'assignments:write',mutation:true},({db,profile})=>issueCommercialContinuity(db,environment,command,profile.authority),deps)};
 });
}
