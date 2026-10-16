import {z} from 'zod';
import {ApiError} from './api.js';

const inputSchema=z.object({email:z.string().trim().toLowerCase().max(254).pipe(z.email()),password:z.string().min(1).max(128)}).strict();
const uncertain=()=>new ApiError('No se pudo confirmar el inicio de sesión. Comprueba la sesión antes de volver a enviar la contraseña.',0,'INVITATION_LOGIN_UNCONFIRMED');
/** One native login request; the caller must then observe the signed-cookie session.
 * Response contents never become identity or a token held by the application. */
export async function loginInvitationSession(input:{email:string;password:string}){
 const body=inputSchema.parse(input),controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),15_000);
 try{
  const response=await fetch('/api/auth/sign-in/email',{method:'POST',credentials:'include',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
  const reader=response.body?.getReader();if(!reader)throw uncertain();let length=0;
  // Native login can return user fields; consume a bounded body without exposing
  // it to the flow. Only the subsequent profile GET establishes session state.
  try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>8192)throw uncertain();}}finally{await reader.cancel();reader.releaseLock();}
  if(response.status!==200)throw uncertain();
 }catch{throw uncertain();}finally{clearTimeout(timeout);}
}
