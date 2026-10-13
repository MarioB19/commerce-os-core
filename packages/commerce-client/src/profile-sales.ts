import {z} from 'zod';
import {profileSelectionSchema} from '../../contracts/src/profiles.js';
import {profileSalesMutation,profileSalesRead,profileSalesPointer,profileSalesRows,verifyProfileSalesCommand,type ProfileSalesMutation,type ProfileSalesPointer,type ProfileSalesRead} from '../../contracts/src/profile-sales-consumer.js';
export class ProfileSalesError extends Error{constructor(readonly code:'SALES_UNCONFIRMED'|'SALES_REJECTED'|'SALES_OPERATION_NOT_FOUND',readonly status=0){super(code);}}
const absent=z.object({error:z.object({code:z.literal('SALES_OPERATION_NOT_FOUND'),message:z.literal('SALES_OPERATION_NOT_FOUND')}).strict()}).strict();
/** Fixed selected session and routes; no bearer, origin, retry or action override. */
export function sessionProfileSales(selection:unknown,fetcher:typeof fetch=fetch){
 const s=profileSelectionSchema.parse(selection);if(!s.workspaceId||s.version<1)throw Error('SALES_AUTHORITY_REQUIRED');
 return salesClient('',{'x-commerce-profile-id':s.workspaceId,'x-commerce-profile-version':String(s.version)},'include',s.workspaceId,fetcher);
}
/** V7 F8 (RF-15.a): the same conversations and orders contract for one
 * personal access token, so MCP and the application share routes, permissions
 * and the command shape. The profile is the token's; commands are checked
 * against the workspace the API returns, never one chosen by the caller. */
export function personalProfileSales(origin:string,token:string,fetcher:typeof fetch=fetch){
 let base:URL;try{base=new URL(origin);}catch{throw Error('SALES_AUTHORITY_REQUIRED');}
 if(base.username||base.password||base.pathname!=='/'||base.search||base.hash||!(base.protocol==='https:'||base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname))||!/^cos_pat_[A-Za-z0-9_-]{43}$/.test(token))throw Error('SALES_AUTHORITY_REQUIRED');
 return salesClient(base.origin,{authorization:'Bearer '+token},'omit',null,fetcher);
}
function salesClient(origin:string,headers:Record<string,string>,credentials:RequestCredentials,expectedWorkspace:string|null,fetcher:typeof fetch){
 const workspace=expectedWorkspace;
 async function request(path:string,signal?:AbortSignal,mutation?:ProfileSalesMutation,reconcile=false){
  const controller=new AbortController(),abort=()=>controller.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,15000);
  try{
   if(controller.signal.aborted)throw Error('aborted');
   const response=await fetcher(origin+path,{method:mutation?'POST':'GET',headers:{...headers,accept:'application/json',...(mutation?{'content-type':'application/json','idempotency-key':mutation.operation_id}:{})},...(mutation?{body:JSON.stringify({...mutation.body,environment:mutation.environment})}:{}),credentials,cache:'no-store',redirect:'error',signal:controller.signal});
   const reader=response.body?.getReader();if(!reader)throw Error('empty');let size=0;const parts:Uint8Array[]=[];
   try{for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>2*1024*1024)throw Error('bound');parts.push(chunk.value);}}finally{await reader.cancel();reader.releaseLock();}
   if(controller.signal.aborted)throw Error('aborted');const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
   if(!response.ok)throw new ProfileSalesError(reconcile&&response.status===404&&absent.safeParse(raw).success?'SALES_OPERATION_NOT_FOUND':'SALES_REJECTED',response.status);
   if(response.status!==(mutation?202:200))throw new ProfileSalesError('SALES_UNCONFIRMED',response.status);
   return raw as unknown;
  }catch(error){if(error instanceof ProfileSalesError)throw error;throw new ProfileSalesError('SALES_UNCONFIRMED');}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 return{
  async read(input:ProfileSalesRead,signal?:AbortSignal){const q=profileSalesRead.parse(input),params=new URLSearchParams({environment:q.environment});if(q.operation==='list')for(const[k,v]of Object.entries(q))if(!['operation','resource','environment'].includes(k)&&v!==undefined)params.set(k,String(v));const raw=await request('/v1/'+q.resource+(q.operation==='get'?'/'+q.id:'')+'?'+params,signal);return profileSalesRows(raw,q);},
  async write(input:ProfileSalesMutation,signal?:AbortSignal){const q=profileSalesMutation.parse(input),tail=q.operation==='conversation.command'?'commands':q.operation==='conversation.controls'?'controls':'review',resource=q.operation==='receipt.review'?'receipts':'conversations';const raw=z.object({data:z.unknown()}).strict().parse(await request(`/v1/${resource}/${q.resource_id}/${tail}`,signal,q));
   const bound=workspace??z.object({workspace_id:z.string().min(1)}).catchall(z.unknown()).parse(raw.data).workspace_id;
   if(q.operation==='conversation.controls'){const row=z.object({command_id:z.uuid(),workspace_id:z.literal(bound),environment:z.literal(q.environment),scope_type:z.literal('conversation'),scope_id:z.literal(q.resource_id),paused:z.boolean(),takeover:z.boolean(),suppressed:z.boolean(),version:z.number().int().positive()}).catchall(z.unknown()).parse(raw.data);return{command_id:row.command_id};}
   return{command_id:verifyProfileSalesCommand(raw.data,q,bound).id};
  },
  async reconcile(input:ProfileSalesPointer,signal?:AbortSignal){const q=profileSalesPointer.parse(input),query=new URLSearchParams({environment:q.environment,operation:q.operation,resource_id:q.resource_id});const raw=z.object({data:z.object({key:z.literal(q.operation_id),operation:z.literal(q.operation),resource_id:z.literal(q.resource_id),command:z.unknown()}).strict()}).strict().parse(await request('/v1/sales-operations/'+q.operation_id+'?'+query,signal,undefined,true));const bound=workspace??z.object({workspace_id:z.string().min(1)}).catchall(z.unknown()).parse(raw.data.command).workspace_id;return verifyProfileSalesCommand(raw.data.command,q,bound);},
 };
}
export type ProfileSalesClient=ReturnType<typeof sessionProfileSales>;
