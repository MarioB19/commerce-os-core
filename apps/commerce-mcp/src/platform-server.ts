import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {platformV2,type ProfileV2Client} from '../../../packages/commerce-client/src/profile-v2.js';
import {registerManageTool,type ManageAction} from './manage-tool.js';

/** V7 platform MCP (RF-02.c): the same administrative actions as the
 * «Plataforma» page, bound to one admin's platform token (cos_plt_). It never
 * reaches profile routes, conversations, contacts or payments. */
const profileId=z.string().min(1).max(256);
const limits=z.object({numbers:z.number().int().min(0).max(20),products:z.number().int().min(0).max(100000),dailyConversations:z.number().int().min(0).max(100000)}).strict();
const id=(v:string)=>encodeURIComponent(v);
function failure(action:string,error:unknown,input:unknown){
 const code=typeof (error as {code?:unknown})?.code==='string'?(error as {code:string}).code:'PLATFORM_OUTCOME_UNCONFIRMED';
 const operationId=input&&typeof input==='object'&&'operationId' in input?String((input as {operationId:unknown}).operationId):undefined;
 return{code,...(operationId?{operationId}:{}),next:/UNCONFIRMED/.test(code)?'Resultado no concluyente: repite '+action+' con el mismo operationId; la plataforma devuelve el resultado original.':'Revisa alcance del token, versión y datos; no se repitió automáticamente.'};
}
export function registerPlatformTools(server:McpServer,client:ProfileV2Client){
 const tool=(name:string,title:string,description:string,actions:Record<string,ManageAction>)=>registerManageTool(server,name,{title,description},actions,failure);
 const update=(state:'ACTIVE'|'SUSPENDED'):ManageAction=>({schema:z.object({profileId,operationId:z.uuid(),expectedVersion:z.number().int().positive()}).strict(),read:false,destructive:state==='SUSPENDED',
  run:i=>client('PATCH','/v2/platform/profiles/'+id(i.profileId),{operationId:i.operationId,expectedVersion:i.expectedVersion,state})});
 tool('admin_profiles_manage','Perfiles de la plataforma','Conteos agregados por perfil y acciones de alta, invitación de la primera persona Dueña, suspensión, reactivación y límites. Nunca lee conversaciones ni datos de clientes.',{
  listar:{schema:z.object({}).strict(),read:true,run:()=>client('GET','/v2/platform/profiles')},
  crear:{schema:z.object({operationId:z.uuid(),businessName:z.string().trim().min(1).max(160),timezone:z.string().min(1).max(64),limits}).strict(),read:false,run:i=>client('POST','/v2/platform/profiles',i)},
  invitar_dueno:{schema:z.object({profileId,operationId:z.uuid(),email:z.string().email().max(254)}).strict(),read:false,run:i=>client('POST','/v2/platform/profiles/'+id(i.profileId)+'/owner-invitations',{operationId:i.operationId,email:i.email})},
  suspender:update('SUSPENDED'),reactivar:update('ACTIVE'),
  limites:{schema:z.object({profileId,operationId:z.uuid(),expectedVersion:z.number().int().positive(),limits}).strict(),read:false,run:i=>client('PATCH','/v2/platform/profiles/'+id(i.profileId),{operationId:i.operationId,expectedVersion:i.expectedVersion,limits:i.limits})},
 });
 tool('admin_capacity_manage','Capacidad de la instalación','Perfiles y números usados frente al máximo de la instalación (3 perfiles, 20 números).',{
  leer:{schema:z.object({}).strict(),read:true,run:()=>client('GET','/v2/platform/capacity')},
 });
}
export function createPlatformMcp(origin:string,token:string,fetcher:typeof fetch=fetch){
 if(!/^https?:\/\//.test(origin))throw Error('MCP_CONFIGURATION_REQUIRED');
 if(!/^cos_plt_[A-Za-z0-9_-]{43}$/.test(token))throw Error('MCP_PLATFORM_TOKEN_REQUIRED');
 const server=new McpServer({name:'commerce-os-platform',version:'7.0.0'},{capabilities:{tools:{}}});
 registerPlatformTools(server,platformV2(origin,token,fetcher));
 return server;
}
