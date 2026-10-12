import {z} from 'zod';
import {invitationAcceptSchema,invitationAcceptResultSchema,invitationAcceptanceStateSchema,invitationLinkTokenSchema} from '../../../../packages/contracts/src/profile-invitation-acceptance.js';
import {ApiError} from './api.js';

/** Call once in the route bootstrap, before rendering or issuing requests.
 * The returned secret belongs only in memory; this helper never stores it. */
export function takeInvitationToken(location:Pick<Location,'hash'|'pathname'|'search'>,history:Pick<History,'replaceState'|'state'>){
 const fragment=location.hash;
 history.replaceState(history.state,'',location.pathname+location.search);
 if(location.pathname!=='/accept-invitation'||location.search)return null;
 const parsed=invitationLinkTokenSchema.safeParse(fragment.slice(1));
 return parsed.success?parsed.data:null;
}
async function request(path:string,token:string,signal?:AbortSignal):Promise<unknown>{
 const body=invitationAcceptSchema.parse({token}),controller=new AbortController(),abort=()=>controller.abort(signal?.reason);
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort(),15_000);
 try{
  const response=await fetch(path,{method:'POST',credentials:'include',cache:'no-store',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
  const reader=response.body?.getReader();if(!reader)throw Error('missing body');const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>4096)throw Error('response too large');chunks.push(item.value);}}finally{await reader.cancel();reader.releaseLock();}
  const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
  if(!response.ok)throw new ApiError('No se pudo comprobar la invitación. Revisa que iniciaste sesión con el correo invitado y vuelve a consultar.',response.status,'INVITATION_NOT_CONFIRMED');
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
 }catch(error){if(error instanceof ApiError)throw error;throw new ApiError('No se pudo confirmar el resultado. Comprueba el estado antes de aceptar otra vez.',0,'INVITATION_NOT_CONFIRMED');}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export async function readInvitationAcceptance(token:string,signal?:AbortSignal){
 return z.object({data:invitationAcceptanceStateSchema}).strict().parse(await request('/v2/invitation-acceptance/status',token,signal)).data;
}
export async function acceptInvitationLink(token:string,signal?:AbortSignal){
 return z.object({data:invitationAcceptResultSchema}).strict().parse(await request('/v2/invitation-acceptance',token,signal)).data;
}
