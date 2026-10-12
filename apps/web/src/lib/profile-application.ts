import {profileBrowserBootstrapSchema,type ProfileBrowserBootstrap} from '../../../../packages/contracts/src/profiles.js';
import {ApiError} from './api.js';
export type ProfileApplicationState={status:'LOADING'}|{status:'ERROR';error:Error}|{status:'READY'|'SELECTING';data:ProfileBrowserBootstrap;message?:string};
/** Identity read only: no selected-profile header, selector input, token or cache. */
export async function loadProfileApplication(signal:AbortSignal):Promise<ProfileBrowserBootstrap>{
 const controller=new AbortController(),abort=()=>controller.abort();
 if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
 const timeout=setTimeout(abort,15_000);
 try{
  const response=await fetch('/v2/me',{credentials:'include',cache:'no-store',signal:controller.signal}),reader=response.body?.getReader();
  if(!reader)throw Error('empty');
  const chunks:Uint8Array[]=[];let bytes=0;
  try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>16384)throw Error('oversize');chunks.push(next.value);}}
  finally{await reader.cancel();reader.releaseLock();}
  const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
  const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  if(!response.ok)throw new ApiError(response.status===401?'Inicia sesión para continuar.':'No se pudo confirmar tu acceso a los perfiles.',response.status,'PROFILE_BOOTSTRAP_REJECTED');
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||!Object.hasOwn(body,'data'))throw Error('envelope');
  return profileBrowserBootstrapSchema.parse(body.data);
 }catch(error){if(error instanceof ApiError)throw error;throw new ApiError('No se pudo confirmar tu acceso. Vuelve a consultar.',0,'PROFILE_BOOTSTRAP_UNCONFIRMED');}
 finally{clearTimeout(timeout);signal.removeEventListener('abort',abort);}
}
/** A new identity generation always clears the previous tree before any read. */
export function createProfileApplication(read=loadProfileApplication){
 let state:ProfileApplicationState={status:'LOADING'},epoch=0,active=true,flight:AbortController|null=null;
 const listeners=new Set<()=>void>(),emit=(next:ProfileApplicationState)=>{state=next;for(const listener of listeners)listener();};
 async function refresh(select=false,expected?:{workspaceId:string;version:number}){
  if(!active)return;const serial=++epoch;flight?.abort();const current=new AbortController();flight=current;emit({status:'LOADING'});
  try{
   const data=profileBrowserBootstrapSchema.parse(await read(current.signal));
   if(!active||serial!==epoch||current.signal.aborted)return;
   const selected=data.profile.profiles.find(p=>p.id===data.profile.selection.workspaceId&&p.selected);
   const confirmed=!expected||(data.profile.selection.workspaceId===expected.workspaceId&&data.profile.selection.version===expected.version);
   emit({status:!select&&selected&&confirmed?'READY':'SELECTING',data,...(!confirmed?{message:'La selección cambió. Revisa el perfil antes de continuar.'}:{})});
  }catch(error){if(active&&serial===epoch&&!current.signal.aborted)emit({status:'ERROR',error:error instanceof Error?error:Error('No se pudo confirmar tu acceso.')});}
 }
 return{snapshot:()=>state,subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
  refresh:()=>refresh(),choose:()=>refresh(true),confirm:(selection:{workspaceId:string;version:number})=>refresh(false,selection),
  dispose(){active=false;epoch++;flight?.abort();listeners.clear();state={status:'LOADING'};}};
}
