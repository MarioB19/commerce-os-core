import {z} from 'zod';
import {profileSelectionSchema} from '../../contracts/src/profiles.js';
import {marketCommandRoute,marketCommandResult,type MarketCommandResult} from '../../contracts/src/market-variant-client.js';
export class MarketClientError extends Error{
 constructor(readonly code:'MARKET_INPUT_INVALID'|'MARKET_AUTHORITY_REQUIRED'|'MARKET_WRITE_UNCONFIRMED'|'MARKET_READ_UNCONFIRMED'|'MARKET_OPERATION_NOT_FOUND',readonly status=0){super(code);}
}
const notFoundCode=z.literal('MARKET_NOT_FOUND');
const operationNotFound=z.union([z.strictObject({error:z.strictObject({code:notFoundCode,message:notFoundCode})}),z.strictObject({statusCode:z.literal(404),code:notFoundCode,error:z.literal('Not Found'),message:notFoundCode})]);
export type MarketClient=(input:unknown,signal?:AbortSignal)=>Promise<MarketCommandResult>;
async function execute(input:unknown,origin:string,headers:Record<string,string>,credentials:RequestCredentials,fetcher:typeof fetch,workspace?:string,signal?:AbortSignal){
 let q:ReturnType<typeof marketCommandRoute>;try{q=marketCommandRoute(input);}catch{throw new MarketClientError('MARKET_INPUT_INVALID');}
 const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort(),15000);let status=0,nativeAbsent=false;
 try{
  if(controller.signal.aborted)throw Error('aborted');
  const response=await fetcher(origin+q.route,{method:q.method,headers:{...headers,...('operation_id'in q.value?{'idempotency-key':q.value.operation_id,'content-type':'application/json'}:{})},credentials,cache:'no-store',redirect:'error',signal:controller.signal,...('body'in q.value?{body:JSON.stringify(q.value.body)}:{})});status=response.status;
  const reader=response.body?.getReader();if(!reader)throw Error('body');const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>2*1024*1024)throw Error('bound');chunks.push(part.value);}}finally{await reader.cancel();reader.releaseLock();}
  if(controller.signal.aborted)throw Error('unconfirmed');
  const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
  const decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  nativeAbsent=q.value.operation==='reconcile'&&status===404&&operationNotFound.safeParse(decoded).success;
  if(!response.ok)throw Error('unconfirmed');
  return marketCommandResult(decoded,q.value,workspace);
 }catch{throw new MarketClientError(nativeAbsent?'MARKET_OPERATION_NOT_FOUND':q.method==='GET'?'MARKET_READ_UNCONFIRMED':'MARKET_WRITE_UNCONFIRMED',status);}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
/** Identity is fixed in the closure. No automatic retry, fallback or implicit
 * publication; callers reconcile uncertain writes by their operation UUID.
 */
export function sessionMarketVariants(selection:unknown,fetcher:typeof fetch=fetch):MarketClient{
 const p=profileSelectionSchema.safeParse(selection);if(!p.success||p.data.workspaceId===null||p.data.version<1)throw new MarketClientError('MARKET_AUTHORITY_REQUIRED');
 const workspace=p.data.workspaceId,headers={'x-commerce-profile-id':workspace,'x-commerce-profile-version':String(p.data.version)};
 return(input,signal)=>execute(input,'',headers,'include',fetcher,workspace,signal);
}
export function personalMarketVariants(origin:string,token:string,fetcher:typeof fetch=fetch):MarketClient{
 let base:URL;try{base=new URL(origin);}catch{throw new MarketClientError('MARKET_AUTHORITY_REQUIRED');}
 if(base.username||base.password||base.pathname!=='/'||base.search||base.hash||!(base.protocol==='https:'||base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname))||!/^cos_pat_[A-Za-z0-9_-]{43}$/.test(token))throw new MarketClientError('MARKET_AUTHORITY_REQUIRED');
 const headers={authorization:'Bearer '+token};return(input,signal)=>execute(input,base.origin,headers,'omit',fetcher,undefined,signal);
}
