import type {FastifyInstance,FastifyReply} from 'fastify';
import {MCP_RELEASE,MCP_CAPABILITIES} from '../../../packages/contracts/src/mcp-capabilities.js';

const sourceSha=/^[a-f0-9]{40}$/;
const releaseId=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export type RuntimeVersion={
 service:'commerce-api';
 release:string;
 sha:string|null;
 configured:boolean;
};

/** Public build identity only. No host, environment, account, or secret data. */
export function runtimeVersion(env:Record<string,string|undefined>=process.env):RuntimeVersion{
 const sha=sourceSha.test(env.COMMERCE_RELEASE_SHA??'')?env.COMMERCE_RELEASE_SHA!:null;
 const release=releaseId.test(env.COMMERCE_RELEASE_ID??'')?env.COMMERCE_RELEASE_ID!:sha?.slice(0,12)??'unavailable';
 return{service:'commerce-api',release,sha,configured:sha!==null};
}

export function registerVersionRoute(app:FastifyInstance):void{
 app.get('/api/version',{
  schema:{
   summary:'Read the installed Commerce OS core release identity',
   description:'Public, non-sensitive deployment readback. It grants no operational authority.',
   tags:['System'],
   security:[],
   response:{
    200:{
     type:'object',additionalProperties:false,
     required:['service','release','sha','configured'],
     properties:{
      service:{type:'string',enum:['commerce-api']},
      release:{type:'string'},
      sha:{anyOf:[{type:'string',pattern:'^[a-f0-9]{40}$'},{type:'null'}]},
      configured:{type:'boolean'},
     },
    },
   },
  },
 },async(_request,reply:FastifyReply)=>{
  reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff');
  return runtimeVersion();
 });
}

/** V7.5 §8 (H04): build identity plus the MCP contract it serves, in the
 * profile envelope, so an installed MCP client can say what it lacks. Public,
 * content-free, no authority. */
export function registerBuildRoute(app:FastifyInstance):void{
 app.get('/v2/build',async(_request,reply:FastifyReply)=>{
  reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff');
  return{data:{...runtimeVersion(),mcp:{version:MCP_RELEASE,capabilities:[...MCP_CAPABILITIES]}}};
 });
}
