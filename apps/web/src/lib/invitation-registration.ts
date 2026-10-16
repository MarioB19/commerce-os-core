import {z} from 'zod';
import {invitationRegistrationSchema,invitationRegistrationResultSchema,type InvitationRegistrationInput} from '../../../../packages/contracts/src/profile-invitation-registration.js';
import {ApiError} from './api.js';

const rejected=new Map<string,number[]>([
 ['INVITATION_INPUT_INVALID',[400]],['ORIGIN_REJECTED',[403]],['INVITATION_REGISTRATION_IDENTITY_REJECTED',[403]],
 ['INVITATION_LINK_INVALID_OR_EXPIRED',[404,409]],['INVITATION_PROFILE_SUSPENDED',[403]],
 ['INVITATION_ISSUER_NO_LONGER_AUTHORIZED',[403,409]],['INVITATION_RECIPIENT_MISMATCH',[403,409]],
 ['PROFILE_AUTHORITY_BUSY',[409]],['IDENTITY_RATE_LIMITED',[429]],
]);
const loginRequired=new Set(['INVITATION_EXISTING_IDENTITY_LOGIN_REQUIRED','INVITATION_EXISTING_SESSION_USE_ACCEPTANCE']);
const unknown=()=>new ApiError('El resultado no está confirmado. Inicia sesión para comprobar la invitación antes de volver a intentarlo.',0,'INVITATION_REGISTRATION_UNKNOWN');
/** One bounded POST. Never retries or stores invitation/password/session data. */
export async function registerInvitationIdentity(input:InvitationRegistrationInput){
 const body=invitationRegistrationSchema.parse(input),controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),15_000);
 try{
  const response=await fetch('/v2/invitation-registration',{method:'POST',credentials:'include',cache:'no-store',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
  const reader=response.body?.getReader();if(!reader)throw unknown();const chunks:Uint8Array[]=[];let length=0;
  try{while(true){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>4096)throw unknown();chunks.push(next.value);}}finally{await reader.cancel();reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(response.status===201)return z.object({data:invitationRegistrationResultSchema}).strict().parse(value).data;
  const nativeError=z.object({error:z.object({code:z.string(),message:z.string()}).strict()}).strict().safeParse(value);
  const isolatedError=z.object({statusCode:z.number().int(),code:z.string(),error:z.string(),message:z.string()}).strict().safeParse(value);
  const error=nativeError.success?nativeError.data.error:isolatedError.success&&isolatedError.data.statusCode===response.status?isolatedError.data:undefined;
  if(error&&error.message===error.code){
   if(response.status===409&&loginRequired.has(error.code))throw new ApiError('Ya existe una identidad o sesión. Inicia sesión con el correo invitado para comprobar y aceptar el enlace.',409,'INVITATION_REGISTRATION_LOGIN_REQUIRED');
   if(rejected.get(error.code)?.includes(response.status))throw new ApiError('El alta fue rechazada. Revisa los datos y la vigencia del enlace antes de volver a intentarlo.',response.status,'INVITATION_REGISTRATION_REJECTED');
  }
  throw unknown();
 }catch(error){if(error instanceof ApiError)throw error;throw unknown();}
 finally{clearTimeout(timer);}
}
