import {profileSelectionSchema,profileIdSchema} from '../../contracts/src/profiles.js';
import {paymentsCommandRoute,paymentsListResponse,paymentsOptionResponse,paymentsMime} from '../../contracts/src/payments-client.js';
export class PaymentsClientError extends Error{constructor(readonly code:'PAYMENTS_INPUT_INVALID'|'PAYMENTS_AUTHORITY_REQUIRED'|'PAYMENTS_READ_UNCONFIRMED',readonly status=0){super(code);}}
export type PaymentsResult=ReturnType<typeof paymentsListResponse>|ReturnType<typeof paymentsOptionResponse>|{operation:'export';workspaceId:string;format:'csv'|'xlsx';mime:string;sha256:string;bytes:Uint8Array};
export type PaymentsClient=(input:unknown,signal?:AbortSignal)=>Promise<PaymentsResult>;
async function execute(input:unknown,origin:string,headers:Record<string,string>,credentials:RequestCredentials,fetcher:typeof fetch,workspace?:string,signal?:AbortSignal):Promise<PaymentsResult>{
 let q:ReturnType<typeof paymentsCommandRoute>;try{q=paymentsCommandRoute(input);}catch{throw new PaymentsClientError('PAYMENTS_INPUT_INVALID');}
 const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>controller.abort(),15000);let status=0;
 try{
  if(controller.signal.aborted)throw Error('aborted');
  const response=await fetcher(origin+q.route,{method:'GET',headers,credentials,cache:'no-store',redirect:'error',signal:controller.signal});status=response.status;
  if(!response.ok)throw Error('rejected');
  const maximum=q.value.operation==='export'?16*1024*1024:2*1024*1024,length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maximum))throw Error('bound');
  const reader=response.body?.getReader();if(!reader)throw Error('body');const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>maximum)throw Error('bound');chunks.push(part.value);}}finally{await reader.cancel();reader.releaseLock();}
  if(controller.signal.aborted||length!==null&&Number(length)!==size)throw Error('incomplete');const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  if(q.value.operation==='options')return paymentsOptionResponse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),q.value,workspace);
  if(q.value.operation==='list')return paymentsListResponse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),q.value,workspace);
  const format=q.value.query.format,profile=profileIdSchema.parse(response.headers.get('x-commerce-profile-id')),sha=response.headers.get('x-commerce-export-sha256');
  if(workspace!==undefined&&profile!==workspace||response.headers.get('content-type')!==paymentsMime[format]||response.headers.get('content-disposition')!==`attachment; filename="payments.${format}"`||!sha||!/^[a-f0-9]{64}$/.test(sha))throw Error('binding');
  if(format==='csv'&&!(bytes[0]===239&&bytes[1]===187&&bytes[2]===191)||format==='xlsx'&&!(bytes[0]===80&&bytes[1]===75&&bytes[2]===3&&bytes[3]===4))throw Error('format');
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');if(digest!==sha||controller.signal.aborted)throw Error('hash');
  return{operation:'export',workspaceId:profile,format,mime:paymentsMime[format],sha256:sha,bytes};
 }catch{throw new PaymentsClientError(status===401||status===403||status===409?'PAYMENTS_AUTHORITY_REQUIRED':'PAYMENTS_READ_UNCONFIRMED',status);}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export function sessionPayments(selection:unknown,fetcher:typeof fetch=fetch):PaymentsClient{
 const p=profileSelectionSchema.safeParse(selection);if(!p.success||p.data.workspaceId===null||p.data.version<1)throw new PaymentsClientError('PAYMENTS_AUTHORITY_REQUIRED');const workspace=p.data.workspaceId;
 return(input,signal)=>execute(input,'',{'x-commerce-profile-id':workspace,'x-commerce-profile-version':String(p.data.version)},'include',fetcher,workspace,signal);
}
export function personalPayments(origin:string,token:string,fetcher:typeof fetch=fetch):PaymentsClient{
 let base:URL;try{base=new URL(origin);}catch{throw new PaymentsClientError('PAYMENTS_AUTHORITY_REQUIRED');}
 if(base.username||base.password||base.pathname!=='/'||base.search||base.hash||!(base.protocol==='https:'||base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname))||!/^cos_pat_[A-Za-z0-9_-]{43}$/.test(token))throw new PaymentsClientError('PAYMENTS_AUTHORITY_REQUIRED');
 return(input,signal)=>execute(input,base.origin,{authorization:'Bearer '+token},'omit',fetcher,undefined,signal);
}
