import {profileSelectionSchema,profileOverviewSchema,profileSettingsInputSchema,profileSettingsResultSchema,type ProfileOverview,type ProfileSettingsResult} from '../../../../packages/contracts/src/profiles.js';
import {ApiError} from './api.js';
export interface ProfileRequestFence {workspaceId:string;version:number}
function headers(fence:ProfileRequestFence){
 const parsed=profileSelectionSchema.parse(fence);
 if(!parsed.workspaceId||parsed.version<1)throw new ApiError('Elige un perfil antes de continuar.',409,'PROFILE_SELECTION_REQUIRED');
 return{'x-commerce-profile-id':parsed.workspaceId,'x-commerce-profile-version':String(parsed.version)};
}
async function request(fence:ProfileRequestFence,body?:unknown,signal?:AbortSignal):Promise<unknown>{
 const selected=headers(fence),controller=new AbortController();
 const abort=()=>controller.abort(signal?.reason);
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort(),15_000);
 try{
  const response=await fetch('/v2/profile',{method:body===undefined?'GET':'PATCH',credentials:'include',cache:'no-store',signal:controller.signal,headers:{...selected,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const reader=response.body?.getReader();if(!reader)throw new Error('empty response');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>8192)throw new Error('oversize response');chunks.push(next.value);}}
  finally{await reader.cancel();reader.releaseLock();}
  const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  if(!response.ok)throw new ApiError('No se pudo confirmar el estado del perfil. Actualiza sus datos antes de continuar.',response.status,'PROFILE_REQUEST_REJECTED');
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!Object.hasOwn(value,'data'))throw new Error('response envelope');
  return value.data;
 }catch(error){
  if(error instanceof ApiError)throw error;
  throw new ApiError(body===undefined?'No se pudieron consultar los datos del perfil.':'No se pudo confirmar el guardado. Actualiza los datos antes de volver a guardar.',0,'PROFILE_REQUEST_UNCONFIRMED');
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export async function loadProfileSettings(fence:ProfileRequestFence,signal?:AbortSignal):Promise<ProfileOverview>{
 const parsed=profileOverviewSchema.safeParse(await request(fence,undefined,signal));
 if(!parsed.success||parsed.data.id!==fence.workspaceId)throw new ApiError('No se pudo confirmar el perfil consultado.',503,'PROFILE_RESPONSE_INVALID');
 return parsed.data;
}
/** Exactly one PATCH. A failure is never retried automatically. */
export async function saveProfileSettings(fence:ProfileRequestFence,input:unknown):Promise<ProfileSettingsResult>{
 const body=profileSettingsInputSchema.parse(input);
 const parsed=profileSettingsResultSchema.safeParse(await request(fence,body));
 if(!parsed.success||parsed.data.id!==fence.workspaceId||parsed.data.version!==body.expectedVersion+(parsed.data.changed?1:0)||parsed.data.business_name!==body.businessName||parsed.data.timezone!==body.timezone)
  throw new ApiError('No se pudo confirmar el guardado. Actualiza los datos antes de volver a guardar.',409,'PROFILE_SETTINGS_UNCONFIRMED');
 return parsed.data;
}
