import type {FastifyInstance,FastifyReply} from 'fastify';
import {profileTokenCommandSchema,profileTokenIdSchema,profileTokenListSchema} from '../../../packages/contracts/src/profile-token-management.js';
import {listProfileTokens,mutateProfileToken,readProfileTokenOperation} from '../../../packages/db/src/profile-token-management.js';
import {withProfileRequest,profileReadEnvironment,type ProfileRequestDependencies} from './profile-request.js';
function fail(code:string):never{throw Object.assign(new Error(code),{code,statusCode:400});}
function headers(reply:FastifyReply){reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization').header('Referrer-Policy','no-referrer');}
/** Prepared only. The commercial app does not register this plugin yet. */
export async function profileTokenRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){

 app.get('/v2/tokens',async(req,reply)=>{headers(reply);const p=profileTokenListSchema.safeParse(req.query??{});if(!p.success)fail('PROFILE_TOKEN_QUERY_INVALID');return withProfileRequest(req,p.data.environment,{scope:'tokens:read',mutation:false},({db,profile})=>listProfileTokens(db,profile.authority,p.data),deps);});
 app.get('/v2/tokens/operations/:id',async(req,reply)=>{headers(reply);const id=profileTokenIdSchema.safeParse((req.params as {id:string}).id);if(!id.success)fail('PROFILE_TOKEN_OPERATION_INVALID');return withProfileRequest(req,profileReadEnvironment(req),{scope:'tokens:read',mutation:false},async({db,profile})=>({data:await readProfileTokenOperation(db,profile.authority,id.data)}),deps);});
 app.post('/v2/tokens/operations',{bodyLimit:8192},async(req,reply)=>{headers(reply);
  if(Object.keys(req.query??{}).length)fail('PROFILE_QUERY_NOT_ALLOWED');const p=profileTokenCommandSchema.safeParse(req.body);if(!p.success)fail('PROFILE_TOKEN_INPUT_INVALID');
  const result=await withProfileRequest(req,p.data.environment,{scope:'tokens:write',mutation:true,interactiveOnly:p.data.action!=='revoke'},({db,profile})=>mutateProfileToken(db,profile.authority,p.data,'tokenId'in profile?profile.tokenId:undefined),deps);
  reply.code(result.secretDelivered?201:200);return{data:result};
 });
}
