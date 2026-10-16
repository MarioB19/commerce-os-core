import {z} from 'zod';
import {continuousAuthorizationSchema,continuousHumanCommandSchema,commercialContinuityIssueSchema,continuityEnvironmentSchema,continuityListSchema,type ContinuousAuthorization} from './continuous-authorization.js';
export const continuityPurposeSchema=z.enum(['commercial','warmup']);
const id=z.uuid().transform(value=>value.toLowerCase());
export const continuityRequestSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('list'),purpose:continuityPurposeSchema,...continuityListSchema.shape}).strict(),
 z.object({operation:z.literal('get'),purpose:continuityPurposeSchema,id,...continuityEnvironmentSchema.shape}).strict(),
 z.object({operation:z.literal('receipt'),purpose:continuityPurposeSchema,operationId:id,...continuityEnvironmentSchema.shape}).strict(),
 z.object({operation:z.literal('command'),purpose:continuityPurposeSchema,id,...continuityEnvironmentSchema.shape,...continuousHumanCommandSchema.shape}).strict(),
 z.object({operation:z.literal('issue'),purpose:z.literal('commercial'),...continuityEnvironmentSchema.shape,...commercialContinuityIssueSchema.shape}).strict(),
]);
export type ContinuityRequest=z.infer<typeof continuityRequestSchema>;
export interface ContinuityResult{data:ContinuousAuthorization[];nextAfterId:string|null}
export function continuityRoute(input:unknown){
 const value=continuityRequestSchema.parse(input),{operation,purpose,...rest}=value;
 let route='/v2/continuity/'+purpose,body:object|undefined;
 if(operation==='command'){route+='/'+value.id+'/commands';const {id:_id,...fields}=rest as Omit<typeof value,'operation'|'purpose'>;body=fields;}
 else if(operation==='issue')body=rest;
 else{
  if(operation==='get')route+='/'+value.id;
  if(operation==='receipt')route+='/operations/'+value.operationId;
  const query=new URLSearchParams();for(const[k,v]of Object.entries(rest))if(k!=='id'&&k!=='operationId'&&v!==undefined)query.set(k,String(v));route+='?'+query;
 }
 return {value,route,method:body?'POST' as const:'GET' as const,body};
}
export function continuityResult(input:unknown,request:ContinuityRequest,workspaceId?:string):ContinuityResult{
 let data:ContinuousAuthorization[],nextAfterId:string|null=null;
 if(request.operation==='list'){
  const value=z.object({data:z.array(continuousAuthorizationSchema).max(request.limit),nextAfterId:id.nullable()}).strict().parse(input);
  data=value.data;nextAfterId=value.nextAfterId;
  if(data.some((row,i)=>row.id<=(i?data[i-1]!.id:request.afterId??''))||nextAfterId!==null&&(data.length!==request.limit||nextAfterId!==data.at(-1)?.id))throw new Error('CONTINUITY_PAGE_INVALID');
 }else{
  const value=z.object({data:request.operation==='receipt'?continuousAuthorizationSchema.nullable():continuousAuthorizationSchema}).strict().parse(input);data=value.data?[value.data]:[];
 }
 const kind=request.purpose==='commercial'?'COMMERCIAL_ASSIGNMENT':'VERIFIED_QR_CONNECTION';
 if(data.some(row=>row.environment!==request.environment||row.source.kind!==kind||workspaceId!==undefined&&row.workspaceId!==workspaceId
  ||(request.operation==='get'||request.operation==='command')&&row.id!==request.id
  ||request.operation==='list'&&request.accountId!==undefined&&row.accountId!==request.accountId))throw new Error('CONTINUITY_RESPONSE_SCOPE_CHANGED');
 if(request.operation==='issue'&&data.some(row=>row.source.kind!=='COMMERCIAL_ASSIGNMENT'||row.source.assignmentId!==request.assignmentId||row.source.assignmentRevision!==request.expectedRevision))throw new Error('CONTINUITY_RESPONSE_ORIGIN_CHANGED');
 if(request.operation==='command'&&data.some(row=>![request.expectedVersion,request.expectedVersion+1].includes(row.version)
  ||request.action==='pause'&&(!row.humanPaused||row.revokedAt!==null)
  ||request.action==='resume'&&(row.humanPaused||row.revokedAt!==null)
  ||request.action==='revoke'&&row.revokedAt===null))throw new Error('CONTINUITY_COMMAND_UNCONFIRMED');
 return {data,nextAfterId};
}
