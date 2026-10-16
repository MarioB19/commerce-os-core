import {profileSelectionSchema} from '../../contracts/src/profiles.js';
import {continuityRoute,continuityResult,type ContinuityResult} from '../../contracts/src/continuous-consumer.js';
export class ContinuityClientError extends Error{
 constructor(readonly code:'CONTINUITY_INPUT_INVALID'|'CONTINUITY_AUTHORITY_REQUIRED'|'CONTINUITY_REQUEST_REJECTED'|'CONTINUITY_OUTCOME_UNCONFIRMED',readonly status=0){super(code);}
}
export type ContinuityClient=(input:unknown,signal?:AbortSignal)=>Promise<ContinuityResult>;
async function call(input:unknown,origin:string,headers:Record<string,string>,credentials:RequestCredentials,fetcher:typeof fetch,workspaceId:string|undefined,signal?:AbortSignal){
 let request:ReturnType<typeof continuityRoute>;try{request=continuityRoute(input);}catch{throw new ContinuityClientError('CONTINUITY_INPUT_INVALID');}
 const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort(),15_000);
 try{
  if(controller.signal.aborted)throw new Error('aborted');
  const response=await fetcher(origin+request.route,{method:request.method,headers:{...headers,...(request.body?{'content-type':'application/json'}:{})},
   ...(request.body?{body:JSON.stringify(request.body)}:{}),credentials,cache:'no-store',redirect:'error',signal:controller.signal});
  const reader=response.body?.getReader();if(!reader)throw new Error('empty response');const chunks:Uint8Array[]= [];let size=0;
  try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>2*1024*1024)throw new Error('response bound');chunks.push(item.value);}}finally{await reader.cancel();reader.releaseLock();}
  if(controller.signal.aborted)throw new Error('aborted');
  if(!response.ok){
   // A proxy/server timeout may arrive after COMMIT. Its response cannot
   // establish rejection of a write, so reconciliation keeps the original ID.
   if(request.method==='POST'&&(response.status>=500||[408,425,429].includes(response.status)))throw new ContinuityClientError('CONTINUITY_OUTCOME_UNCONFIRMED',response.status);
   throw new ContinuityClientError('CONTINUITY_REQUEST_REJECTED',response.status);
  }
  const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
  return continuityResult(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)),request.value,workspaceId);
 }catch(error){if(error instanceof ContinuityClientError)throw error;throw new ContinuityClientError('CONTINUITY_OUTCOME_UNCONFIRMED');}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
/** No retry. Preserve operationId after an uncertain write and read its receipt. */
export function sessionContinuity(selection:unknown,fetcher:typeof fetch=fetch):ContinuityClient{
 const parsed=profileSelectionSchema.safeParse(selection);if(!parsed.success||!parsed.data.workspaceId||parsed.data.version<1)throw new ContinuityClientError('CONTINUITY_AUTHORITY_REQUIRED');
 const workspaceId=parsed.data.workspaceId,headers={'x-commerce-profile-id':workspaceId,'x-commerce-profile-version':String(parsed.data.version)};
 return(input,signal)=>call(input,'',headers,'include',fetcher,workspaceId,signal);
}
export function personalContinuity(origin:string,token:string,fetcher:typeof fetch=fetch):ContinuityClient{
 let base:URL;try{base=new URL(origin);}catch{throw new ContinuityClientError('CONTINUITY_AUTHORITY_REQUIRED');}
 if(base.username||base.password||base.pathname!=='/'||base.search||base.hash||!(base.protocol==='https:'||base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname))||!/^cos_pat_[A-Za-z0-9_-]{43}$/.test(token))throw new ContinuityClientError('CONTINUITY_AUTHORITY_REQUIRED');
 const headers={authorization:'Bearer '+token};return(input,signal)=>call(input,base.origin,headers,'omit',fetcher,undefined,signal);
}
