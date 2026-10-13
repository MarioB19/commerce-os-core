import {ApiError} from './api.js';

/** V7 fenced request for /v2 profile routes: one request, never retried; the
 * server re-checks the selection fence. Bounded response, closed envelope. */
export interface ProfileFence {workspaceId:string;version:number}
const messages:Record<string,string>={
 PROFILE_SESSION_EXPIRED:'Tu sesión terminó. Vuelve a iniciar sesión.',
 PROFILE_ACTION_FORBIDDEN:'Tu rol no permite esta acción en este perfil.',
 PROFILE_INTERACTIVE_SESSION_REQUIRED:'Esta acción solo puede hacerse desde la aplicación, con tu sesión.',
 PROFILE_SUSPENDED:'Este perfil está suspendido; no admite cambios.',
 PROFILE_SELECTION_CHANGED:'El perfil seleccionado cambió. Vuelve a elegirlo antes de continuar.',
 AI_AUTHORITY:'Los datos cambiaron mientras guardabas. Actualiza la página y vuelve a intentarlo.',
 AI_CONFIGURATION:'Revisa los datos: el proveedor o el modelo no están disponibles.',
 AI_BUDGET:'El límite mensual debe estar entre 1 y 100,000 USD.',
 META_TOKEN_VERSION_CONFLICT:'El token de Meta cambió mientras guardabas. Actualiza la página.',
 ONBOARDING_VERSION_CONFLICT:'La configuración inicial cambió. Actualiza la página.',
};
export function profileErrorMessage(code:string,fallback:string){return messages[code]??fallback;}
export async function profileRequest<T>(fence:ProfileFence,method:'GET'|'PUT'|'POST'|'PATCH',path:string,body?:unknown,signal?:AbortSignal,limit=65536):Promise<T>{
 if(!fence?.workspaceId||!Number.isSafeInteger(fence.version)||fence.version<1)throw new ApiError('Elige un perfil antes de continuar.',409,'PROFILE_SELECTION_REQUIRED');
 const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort(),30_000);
 const write=method!=='GET';
 try{
  const response=await fetch(path,{method,credentials:'include',cache:'no-store',redirect:'error',signal:controller.signal,
   headers:{'X-Commerce-Profile-Id':fence.workspaceId,'X-Commerce-Profile-Version':String(fence.version),...(body===undefined?{}:{'Content-Type':'application/json'})},
   ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const reader=response.body?.getReader();if(!reader)throw new Error('empty');
  const chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>limit)throw new Error('oversize');chunks.push(next.value);}}
  finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
  const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  if(!response.ok){const code=typeof value?.error?.code==='string'?value.error.code:'REQUEST_FAILED';throw new ApiError(profileErrorMessage(code,write?'No se pudo guardar. Actualiza y vuelve a intentarlo.':'No se pudo consultar.'),response.status,code);}
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,'data'))throw new Error('envelope');
  return value.data as T;
 }catch(error){
  if(error instanceof ApiError)throw error;
  if(signal?.aborted)throw error;
  throw new ApiError(write?'No se pudo confirmar el resultado. Actualiza antes de volver a intentarlo.':'No se pudo consultar. Vuelve a intentarlo.',0,write?'PROFILE_WRITE_UNCONFIRMED':'PROFILE_READ_FAILED');
 }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
