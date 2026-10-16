import {profileSelectionSchema} from '../../contracts/src/profiles.js';
import {resultsCommandRoute,resultsCommandResult,type ResultsCommandResult} from '../../contracts/src/results-client.js';
export class ResultsClientError extends Error{
 constructor(readonly code:'RESULTS_INPUT_INVALID'|'RESULTS_AUTHORITY_REQUIRED'|'RESULTS_WRITE_UNCONFIRMED'|'RESULTS_READ_UNCONFIRMED',readonly status=0){super(code);}
}
export type ResultsClient=(input:unknown,signal?:AbortSignal)=>Promise<ResultsCommandResult>;
async function execute(input:unknown,origin:string,headers:Record<string,string>,credentials:RequestCredentials,fetcher:typeof fetch,workspace?:string,signal?:AbortSignal){
 let q:ReturnType<typeof resultsCommandRoute>;try{q=resultsCommandRoute(input);}catch{throw new ResultsClientError('RESULTS_INPUT_INVALID');}
 const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort(),15000);let status=0;
 try{
  if(controller.signal.aborted)throw Error('aborted');
  const response=await fetcher(origin+q.route,{method:q.method,headers:{...headers,...('operation_id'in q.value?{'idempotency-key':q.value.operation_id,'content-type':'application/json'}:{})},credentials,cache:'no-store',redirect:'error',signal:controller.signal,...('body'in q.value?{body:JSON.stringify(q.value.body)}:{})});status=response.status;
  const reader=response.body?.getReader();if(!reader)throw Error('body');const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>2*1024*1024)throw Error('bound');chunks.push(part.value);}}finally{await reader.cancel();reader.releaseLock();}
  if(!response.ok||controller.signal.aborted)throw Error('unconfirmed');
  const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
  return resultsCommandResult(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)),q.value,workspace);
 }catch{throw new ResultsClientError(q.method==='GET'?'RESULTS_READ_UNCONFIRMED':'RESULTS_WRITE_UNCONFIRMED',status);}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
/** Identity is fixed in the closure. No automatic retry, fallback or implicit
 * publication; callers reconcile uncertain writes by their operation UUID.
 */
export function sessionResults(selection:unknown,fetcher:typeof fetch=fetch):ResultsClient{
 const p=profileSelectionSchema.safeParse(selection);if(!p.success||p.data.workspaceId===null||p.data.version<1)throw new ResultsClientError('RESULTS_AUTHORITY_REQUIRED');
 const workspace=p.data.workspaceId,headers={'x-commerce-profile-id':workspace,'x-commerce-profile-version':String(p.data.version)};
 return(input,signal)=>execute(input,'',headers,'include',fetcher,workspace,signal);
}
export function personalResults(origin:string,token:string,fetcher:typeof fetch=fetch):ResultsClient{
 let base:URL;try{base=new URL(origin);}catch{throw new ResultsClientError('RESULTS_AUTHORITY_REQUIRED');}
 if(base.username||base.password||base.pathname!=='/'||base.search||base.hash||!(base.protocol==='https:'||base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname))||!/^cos_pat_[A-Za-z0-9_-]{43}$/.test(token))throw new ResultsClientError('RESULTS_AUTHORITY_REQUIRED');
 const headers={authorization:'Bearer '+token};return(input,signal)=>execute(input,base.origin,headers,'omit',fetcher,undefined,signal);
}
