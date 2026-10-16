import {z} from 'zod';
import {profileSelectionSchema} from '../../../../packages/contracts/src/profiles.js';
import {invitationCreateSchema,invitationCancelSchema,invitationPageSchema,invitationListedSchema,invitationResultSchema,type InvitationPage,type InvitationListed,type InvitationResult} from '../../../../packages/contracts/src/profile-invitations.js';
import {ApiError} from './api.js';
import type {ProfileRequestFence} from './profile-settings.js';
async function request(path:string,fence:ProfileRequestFence,body?:unknown,signal?:AbortSignal,allowAbsent=false):Promise<unknown>{
 const selected=profileSelectionSchema.parse(fence);if(!selected.workspaceId||selected.version<1)throw new ApiError('Elige un perfil antes de continuar.',409,'PROFILE_SELECTION_REQUIRED');
 const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>controller.abort(),15_000);
 try{
  const response=await fetch(path,{method:body===undefined?'GET':'POST',credentials:'include',cache:'no-store',signal:controller.signal,headers:{'x-commerce-profile-id':selected.workspaceId,'x-commerce-profile-version':String(selected.version),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const reader=response.body?.getReader();if(!reader)throw new Error('empty response');const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>1048576)throw new Error('oversize response');chunks.push(next.value);}}finally{await reader.cancel();reader.releaseLock();}
  const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  if(allowAbsent&&response.status===404&&value?.message==='INVITATION_OPERATION_NOT_FOUND')return null;
  if(response.status===409&&value?.code==='INVITATION_ALREADY_PENDING'&&value?.message==='INVITATION_ALREADY_PENDING')throw new ApiError('Ya existe una invitación pendiente para ese correo. Actualiza la lista para gestionarla.',409,'INVITATION_ALREADY_PENDING');
  if(!response.ok)throw new ApiError('No se pudo confirmar la solicitud. Consulta su estado antes de continuar.',response.status,'INVITATION_REQUEST_REJECTED');return value;
 }catch(error){if(error instanceof ApiError)throw error;throw new ApiError('No se pudo confirmar la solicitud. Consulta su estado antes de continuar.',0,'INVITATION_REQUEST_UNCONFIRMED');}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export async function loadProfileInvitations(fence:ProfileRequestFence,afterId?:string,signal?:AbortSignal):Promise<InvitationPage>{
 if(afterId!==undefined)z.uuid().parse(afterId);const page=invitationPageSchema.parse(await request('/v2/invitations'+(afterId?'?afterId='+encodeURIComponent(afterId):''),fence,undefined,signal));
 if(afterId&&page.data.some(row=>row.id<=afterId))throw new ApiError('No se pudo confirmar la página de invitaciones.',503,'INVITATION_PAGE_INVALID');return page;
}
export async function findProfileInvitationOperation(fence:ProfileRequestFence,operationId:string):Promise<InvitationListed|null>{
 z.uuid().parse(operationId);const value=await request('/v2/invitations/operations/'+operationId,fence,undefined,undefined,true);if(value===null)return null;return z.object({data:invitationListedSchema}).strict().parse(value).data;
}
export async function createProfileInvitation(fence:ProfileRequestFence,input:unknown){
 const body=invitationCreateSchema.parse(input),result=z.object({data:invitationResultSchema.extend({created:z.boolean()}).strict()}).strict().parse(await request('/v2/invitations',fence,body)).data;
 if(result.role!==body.role||result.created&&(result.status!=='PENDING'||result.delivery!=='QUEUED'||result.version!==1||result.expiresAt!==null))throw new ApiError('Consulta el estado de la solicitud antes de continuar.',409,'INVITATION_CREATE_UNCONFIRMED');return result;
}
export async function cancelProfileInvitation(fence:ProfileRequestFence,id:string,expectedVersion:number):Promise<InvitationResult>{
 z.uuid().parse(id);const body=invitationCancelSchema.parse({expectedVersion}),result=z.object({data:invitationResultSchema}).strict().parse(await request('/v2/invitations/'+id+'/cancel',fence,body)).data;
 if(result.id!==id||result.status!=='CANCELLED'||result.version!==expectedVersion+1)throw new ApiError('Consulta el estado de la invitación antes de continuar.',409,'INVITATION_CANCEL_UNCONFIRMED');return result;
}
