/** V7 fixed-identity HTTP client for /v2 profile routes (RF-15). The personal
 * token and origin are bound in the closure; callers pass only a closed route
 * template chosen by a registry tool, never a free path, header or profile. */
export class ProfileV2ClientError extends Error{constructor(readonly code:string,readonly status=0){super(code);}}
export type ProfileV2Method='GET'|'POST'|'PUT'|'PATCH';
export type ProfileV2Client=(method:ProfileV2Method,path:string,body?:unknown,signal?:AbortSignal)=>Promise<unknown>;
const pathPattern=/^\/v2\/[a-z0-9-]+(?:\/[A-Za-z0-9._~%-]+)*(?:\?[A-Za-z0-9._~%&=-]*)?$/;
export function personalProfileV2(origin:string,token:string,fetcher:typeof fetch=fetch,limit=2*1024*1024):ProfileV2Client{
 return fixedBearer(origin,token,/^cos_pat_[A-Za-z0-9_-]{43}$/,path=>!path.startsWith('/v2/platform/'),fetcher,limit);
}
/** Platform identity (cos_plt_): only /v2/platform routes, never a profile route. */
export function platformV2(origin:string,token:string,fetcher:typeof fetch=fetch,limit=2*1024*1024):ProfileV2Client{
 return fixedBearer(origin,token,/^cos_plt_[A-Za-z0-9_-]{43}$/,path=>path.startsWith('/v2/platform/'),fetcher,limit);
}
/** V7 F3: the reviewed /v1 number journey (RF-07, wireframe D) for the same
 * personal token. Only the listed path families; the environment is fixed to
 * REAL and every write carries the caller's operation UUID as idempotency key,
 * so a repeated MCP call with the same operation never repeats the effect. */
export type ProfileV1Client=(method:ProfileV2Method,path:string,body?:unknown,operationId?:string,signal?:AbortSignal)=>Promise<unknown>;
const v1Pattern=/^\/v1\/(numbers|number-operations)(?:\/[A-Za-z0-9._~%-]+)*$/;
export function personalProfileV1(origin:string,token:string,fetcher:typeof fetch=fetch,limit=2*1024*1024):ProfileV1Client{
 return async(method,path,body,operationId,signal)=>{
  if(!v1Pattern.test(path)||path.includes('..'))throw new ProfileV2ClientError('PROFILE_ROUTE_INVALID');
  if(method!=='GET'&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId??''))throw new ProfileV2ClientError('OPERATION_ID_REQUIRED');
  const client=fixedBearer(origin,token,/^cos_pat_[A-Za-z0-9_-]{43}$/,()=>true,fetcher,limit,/^\/v1\/[a-z-]+(?:\/[A-Za-z0-9._~%-]+)*\?environment=REAL$/,method==='GET'?{}:{'idempotency-key':'mcp:'+operationId!.toLowerCase()});
  return client(method,path+'?environment=REAL',body,signal);
 };
}
/** V7 F4: products and variants for the same personal token. Writes carry the
 * caller's operation UUID as Idempotency-Key, so a retried MCP call returns the
 * durable result instead of repeating the change. */
export type ProfileVariantClient=(method:ProfileV2Method,path:string,body?:unknown,operationId?:string,signal?:AbortSignal)=>Promise<unknown>;
const variantPattern=/^\/v2\/(products|variants|number-variants|variant-operations|market|materials|receipts)(?:\/[A-Za-z0-9._~%-]+)*(?:\?[A-Za-z0-9._~%&=-]*)?$/;
export function personalVariantClient(origin:string,token:string,fetcher:typeof fetch=fetch,limit=2*1024*1024):ProfileVariantClient{
 return async(method,path,body,operationId,signal)=>{
  if(!variantPattern.test(path)||path.includes('..'))throw new ProfileV2ClientError('PROFILE_ROUTE_INVALID');
  if(method!=='GET'&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId??''))throw new ProfileV2ClientError('OPERATION_ID_REQUIRED');
  const client=fixedBearer(origin,token,/^cos_pat_[A-Za-z0-9_-]{43}$/,()=>true,fetcher,limit,variantPattern,method==='GET'?{}:{'idempotency-key':operationId!.toLowerCase()});
  return client(method,path,body,signal);
 };
}
function fixedBearer(origin:string,token:string,tokenPattern:RegExp,allowed:(path:string)=>boolean,fetcher:typeof fetch,limit:number,pattern=pathPattern,extra:Record<string,string>={}):ProfileV2Client{
 let base:URL;try{base=new URL(origin);}catch{throw new ProfileV2ClientError('PROFILE_AUTHORITY_REQUIRED');}
 if(base.username||base.password||base.pathname!=='/'||base.search||base.hash||!(base.protocol==='https:'||base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname))||!tokenPattern.test(token))
  throw new ProfileV2ClientError('PROFILE_AUTHORITY_REQUIRED');
 return async(method,path,body,signal)=>{
  if(!pattern.test(path)||path.includes('..')||!allowed(path))throw new ProfileV2ClientError('PROFILE_ROUTE_INVALID');
  const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(),30000),write=method!=='GET';
  try{
   const response=await fetcher(base.origin+path,{method,headers:{...extra,authorization:'Bearer '+token,accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'})},credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal,...(body===undefined?{}:{body:JSON.stringify(body)})});
   const reader=response.body?.getReader();if(!reader)throw Error('body');const chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit)throw Error('bound');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
   const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
   const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
   if(!response.ok){const code=typeof value?.error?.code==='string'&&/^[A-Z][A-Z0-9_]{2,80}$/.test(value.error.code)?value.error.code:write?'PROFILE_WRITE_REJECTED':'PROFILE_READ_REJECTED';throw new ProfileV2ClientError(code,response.status);}
   if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,'data'))throw Error('envelope');
   return value.data;
  }catch(error){
   if(error instanceof ProfileV2ClientError)throw error;
   throw new ProfileV2ClientError(write?'PROFILE_WRITE_UNCONFIRMED':'PROFILE_READ_UNCONFIRMED');
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 };
}
