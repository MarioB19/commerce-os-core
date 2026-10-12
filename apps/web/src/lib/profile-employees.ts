import {z} from 'zod';
import {profileSelectionSchema,profileIdSchema,profileEmployeeSchema,profileEmployeeInputSchema,profileEmployeeResultSchema,type ProfileEmployee,type ProfileEmployeeResult} from '../../../../packages/contracts/src/profiles.js';
import {ApiError} from './api.js';
import type {ProfileRequestFence} from './profile-settings.js';
function headers(fence:ProfileRequestFence){
 const parsed=profileSelectionSchema.parse(fence);
 if(!parsed.workspaceId||parsed.version<1)throw new ApiError('Elige un perfil antes de continuar.',409,'PROFILE_SELECTION_REQUIRED');
 return{'x-commerce-profile-id':parsed.workspaceId,'x-commerce-profile-version':String(parsed.version)};
}
async function request(path:string,fence:ProfileRequestFence,body?:unknown,signal?:AbortSignal):Promise<unknown>{
 const selected=headers(fence),controller=new AbortController();
 const abort=()=>controller.abort(signal?.reason);
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort(),15_000);
 try{
  const response=await fetch(path,{method:body===undefined?'GET':'PATCH',credentials:'include',cache:'no-store',signal:controller.signal,headers:{...selected,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const reader=response.body?.getReader();if(!reader)throw new Error('empty response');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>1048576)throw new Error('oversize response');chunks.push(next.value);}}
  finally{await reader.cancel();reader.releaseLock();}
  const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  if(!response.ok)throw new ApiError('No se pudo confirmar el estado de los empleados. Actualiza sus datos antes de continuar.',response.status,'PROFILE_REQUEST_REJECTED');
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!Object.hasOwn(value,'data'))throw new Error('response envelope');
  return value.data;
 }catch(error){
  if(error instanceof ApiError)throw error;
  throw new ApiError(body===undefined?'No se pudieron consultar los empleados del perfil.':'No se pudo confirmar el guardado. Actualiza los empleados antes de volver a guardar.',0,'PROFILE_REQUEST_UNCONFIRMED');
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export async function loadProfileEmployees(fence:ProfileRequestFence,signal?:AbortSignal):Promise<ProfileEmployee[]>{
 const parsed=z.array(profileEmployeeSchema).safeParse(await request('/v2/employees',fence,undefined,signal));
 if(!parsed.success||new Set(parsed.data.map(v=>v.user_id)).size!==parsed.data.length)throw new ApiError('No se pudo confirmar la lista de empleados.',503,'PROFILE_EMPLOYEES_RESPONSE_INVALID');
 return parsed.data;
}
/** One versioned PATCH; fresh GET is required after any uncertain result. */
export async function saveProfileEmployee(fence:ProfileRequestFence,userId:string,input:unknown):Promise<ProfileEmployeeResult>{
 const id=profileIdSchema.parse(userId),body=profileEmployeeInputSchema.parse(input);
 const parsed=profileEmployeeResultSchema.safeParse(await request('/v2/employees/'+encodeURIComponent(id),fence,body));
 if(!parsed.success||parsed.data.user_id!==id||parsed.data.version!==body.expectedVersion+(parsed.data.changed?1:0)||parsed.data.role!==body.role||parsed.data.active!==body.active)
  throw new ApiError('No se pudo confirmar el cambio. Actualiza los empleados antes de volver a guardar.',409,'PROFILE_EMPLOYEE_UNCONFIRMED');
 return parsed.data;
}
