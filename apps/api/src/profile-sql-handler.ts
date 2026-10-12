import type {FastifyReply,FastifyRequest,RouteHandlerMethod} from 'fastify';
import {validateHeaderName,validateHeaderValue} from 'node:http';
import {z} from 'zod';
import {environmentSchema} from '../../../packages/contracts/src/index.js';
import {profileScopeSchema} from '../../../packages/contracts/src/profiles.js';
import {withProfileQueryRouting,currentProfileExecutor} from '../../../packages/db/src/profile-query-routing.js';
import {withLegacyProfileRequest,type LegacyProfileRequestContext,type ProfileRequestDependencies} from './profile-request.js';

const actionSchema=z.object({scope:profileScopeSchema,mutation:z.boolean(),interactiveOnly:z.boolean().optional()}).strict();
type Action=z.infer<typeof actionSchema>;
interface Dependencies {
 request?:ProfileRequestDependencies;
 bindIdentity(req:FastifyRequest,context:LegacyProfileRequestContext,action:Readonly<Action>):()=>void;
}
function deny(code:string):never{throw Object.assign(new Error(code),{code,statusCode:500});}
/** Parse the V1 environment contract before identity binding. Token authority is
 * checked by withProfileRequest; this parser never selects a profile or token.
 */
export function profileHttpEnvironment(req:FastifyRequest){
 const body=(req.body as Record<string,unknown>|undefined)?.environment;
 const query=(req.query as Record<string,unknown>|undefined)?.environment;
 if(body!==undefined&&query!==undefined&&body!==query)throw Object.assign(new Error('ENVIRONMENT_CONFLICT'),{code:'ENVIRONMENT_CONFLICT',statusCode:400});
 if(body===undefined&&query===undefined&&!['GET','HEAD','OPTIONS'].includes(req.method))throw Object.assign(new Error('ENVIRONMENT_REQUIRED'),{code:'ENVIRONMENT_REQUIRED',statusCode:400});
 return environmentSchema.parse(body??query??'REAL');
}
function snapshot(value:unknown):unknown{
 if(Buffer.isBuffer(value))return Buffer.from(value);
 if(value instanceof Error)return deny('PROFILE_RESPONSE_NOT_MATERIALIZED');
 try{const copy=structuredClone(value);if(JSON.stringify(copy)===undefined)return deny('PROFILE_RESPONSE_NOT_MATERIALIZED');return copy;}catch{return deny('PROFILE_RESPONSE_NOT_MATERIALIZED');}
}
function validateHeader(name:string,value:unknown){
 validateHeaderName(name);
 const values=Array.isArray(value)?value:[value];
 for(const item of values){if(typeof item!=='string'&&typeof item!=='number')return deny('PROFILE_RESPONSE_HEADER_INVALID');validateHeaderValue(name,String(item));}
}
/** A response remains local until the authority transaction confirms COMMIT.
 * This adapter is for materialized SQL handlers, not streams or external I/O.
 */
function pendingReply(){
 let status=200,sent=false,payload:unknown,rejected=false;
 const headers=new Map<string,{name:string;value:unknown}>();
 const reject=(code:string):never=>{rejected=true;return deny(code);};
 const materialize=(value:unknown)=>{try{return snapshot(value);}catch{return reject('PROFILE_RESPONSE_NOT_MATERIALIZED');}};
 const methods={
  code(value:number){if(!Number.isInteger(value)||value<100||value>599)return reject('PROFILE_RESPONSE_STATUS_INVALID');status=value;return facade;},
  status(value:number){return methods.code(value);},
  header(name:string,value:unknown){try{validateHeader(name,value);}catch{return reject('PROFILE_RESPONSE_HEADER_INVALID');}headers.set(name.toLowerCase(),{name,value:materialize(value)});return facade;},
  type(value:string){return methods.header('Content-Type',value);},
  getHeader(name:string){return headers.get(name.toLowerCase())?.value;},
  hasHeader(name:string){return headers.has(name.toLowerCase());},
  removeHeader(name:string){headers.delete(name.toLowerCase());return facade;},
  send(value:unknown){if(sent)return reject('PROFILE_RESPONSE_ALREADY_STAGED');payload=value===undefined&&[204,304].includes(status)?undefined:materialize(value);sent=true;return facade;},
 };
 const facade=new Proxy(Object.create(null),{
  get(_target,key){
   if(key==='then')return undefined;
   if(key==='sent')return sent;
   if(key==='statusCode')return status;
   if(typeof key==='string'&&Object.hasOwn(methods,key))return methods[key as keyof typeof methods];
   return reject('PROFILE_RESPONSE_ESCAPE_FORBIDDEN');
  },
  set(){return reject('PROFILE_RESPONSE_ESCAPE_FORBIDDEN');},
 }) as FastifyReply;
 return{facade,finish(result:unknown){
  if(rejected)return deny('PROFILE_RESPONSE_REJECTED');
  if(!sent){if(result===undefined)return deny('PROFILE_RESPONSE_REQUIRED');payload=snapshot(result);}
  else if(result!==undefined&&result!==facade)return deny('PROFILE_RESPONSE_AMBIGUOUS');
  const materializedHeaders=[...headers.values()].map(header=>({name:header.name,value:snapshot(header.value)}));
  try{for(const header of materializedHeaders)validateHeader(header.name,header.value);}catch{return reject('PROFILE_RESPONSE_HEADER_INVALID');}
  const contentType=headers.get('content-type')?.value;
  if(contentType!==undefined&&(typeof contentType!=='string'||
   payload!==undefined&&payload!==null&&typeof payload!=='string'&&!Buffer.isBuffer(payload)&&!contentType.split(';',1)[0]!.trim().toLowerCase().includes('json')))
   return reject('PROFILE_RESPONSE_CONTENT_TYPE_INVALID');
  return{status,headers:materializedHeaders,payload};
 }};
}

/** Fixed route action; no action supplied by an HTTP field. Mount only after
 * its route and called helpers have been reviewed as SQL/materialized work.
 */
export function authorizedProfileSqlHandler(actionValue:Action,handler:RouteHandlerMethod,deps:Dependencies):RouteHandlerMethod{
 const action=Object.freeze(actionSchema.parse(actionValue));
 return async function(req,reply){
  const environment=profileHttpEnvironment(req),response=pendingReply();
  const staged=await withLegacyProfileRequest(req,environment,action,context=>withProfileQueryRouting(context.db,async()=>{
   const release=deps.bindIdentity(req,{...context,db:currentProfileExecutor(context.db.workspaceId)!},action);
   try{return response.finish(await handler.call(this,req,response.facade));}
   finally{release();}
  }),deps.request);
  // No send/header/status mutation occurs before the awaited authority boundary.
  reply.code(staged.status);
  for(const header of staged.headers)reply.header(header.name,header.value);
  return reply.send(staged.payload);
 };
}
