import {randomUUID} from 'node:crypto';
export type HttpMethod='GET'|'POST'|'PATCH'|'PUT'|'DELETE';
export interface ApiEnvelope<T>{data:T;meta?:Record<string,unknown>;next_cursor?:string|null;[key:string]:unknown}
export interface RequestOptions{method?:HttpMethod;body?:unknown;idempotencyKey?:string;expectedRevision?:number;timeoutMs?:number}
export class ApiError extends Error{constructor(public code:string,public status:number,public details?:unknown,public uncertain=false){super(code);}}
export function validateOrigin(value:string){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('HTTPS_ORIGIN_REQUIRED');return u.origin;}
/** Neutral HTTP contract. Mutations are never automatically retried. Keep the key and query persisted state after uncertain transport. */
export class CommerceApi{
 readonly origin:string;
 constructor(origin:string,private readonly token?:string){this.origin=validateOrigin(origin);}
 async request<T=unknown>(route:string,options:RequestOptions={}):Promise<ApiEnvelope<T>>{
  if(!route.startsWith('/')||route.startsWith('//')||route.includes('..')||/[\\\r\n]/.test(route))throw Error('INVALID_API_ROUTE');
  const method=options.method??(options.body===undefined?'GET':'POST');const mutation=method!=='GET';
  const key=mutation?options.idempotencyKey??randomUUID():undefined;
  const body=options.expectedRevision===undefined?options.body:{...(options.body as Record<string,unknown>??{}),expected_version:options.expectedRevision};
  let r:Response;try{r=await fetch(this.origin+route,{method,headers:{accept:'application/json',...(this.token?{authorization:`Bearer ${this.token}`}:{ }),...(body===undefined?{}:{'content-type':'application/json'}),...(key?{'idempotency-key':key}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(options.timeoutMs??30000)});}catch{throw new ApiError('API_TRANSPORT_UNCERTAIN',0,{idempotency_key:key,method},mutation);}
  const raw=await r.text();if(raw.length>4*1024*1024)throw new ApiError('API_RESPONSE_TOO_LARGE',r.status,undefined,mutation);
  let data:any;try{data=JSON.parse(raw);}catch{throw new ApiError('API_INVALID_RESPONSE',r.status,undefined,mutation);}
  if(!r.ok)throw new ApiError(typeof data?.error?.code==='string'?data.error.code:typeof data?.code==='string'?data.code:`API_HTTP_${r.status}`,r.status,data?.error?.details);
  return (Object.prototype.hasOwnProperty.call(data,'data')?data:{data}) as ApiEnvelope<T>;
 }
 async call<T=any>(route:string,body?:unknown,idempotencyKey?:string):Promise<T>{return(await this.request<T>(route,{body,idempotencyKey})).data;}
 async *pages<T=unknown>(route:string,options:{maxPages?:number}={}):AsyncGenerator<ApiEnvelope<T>>{let next=route;const seen=new Set<string>();for(let i=0;i<(options.maxPages??100);i++){if(seen.has(next))throw new ApiError('API_CURSOR_CYCLE',0);seen.add(next);const page=await this.request<T>(next);yield page;const cursor=page.next_cursor??page.meta?.next_cursor;if(!cursor)return;const url=new URL(route,this.origin);url.searchParams.set('cursor',String(cursor));next=url.pathname+url.search;}throw new ApiError('API_PAGE_LIMIT',0);}
}
