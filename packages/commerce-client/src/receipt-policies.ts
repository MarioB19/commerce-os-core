import {profileSelectionSchema} from '../../contracts/src/profiles.js';
import {receiptPolicyRoute,receiptPolicyResponse,receiptCanonical,type ReceiptPolicyResult} from '../../contracts/src/receipt-policy-client.js';
export class ReceiptPolicyClientError extends Error{constructor(readonly code:'RECEIPT_POLICY_INPUT_INVALID'|'RECEIPT_POLICY_AUTHORITY_REQUIRED'|'RECEIPT_POLICY_READ_UNCONFIRMED'|'RECEIPT_POLICY_WRITE_UNCONFIRMED',readonly status=0){super(code);}}
export type ReceiptPolicyClient=(value:unknown,signal?:AbortSignal)=>Promise<ReceiptPolicyResult>;
async function hash(value:unknown){return[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(receiptCanonical(value))))].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function execute(input:unknown,base:string,headers:Record<string,string>,credentials:RequestCredentials,fetcher:typeof fetch,workspace?:string,signal?:AbortSignal){
 let q:ReturnType<typeof receiptPolicyRoute>;try{q=receiptPolicyRoute(input);}catch{throw new ReceiptPolicyClientError('RECEIPT_POLICY_INPUT_INVALID');}
 const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort(),15000);let status=0;
 try{
  if(controller.signal.aborted)throw Error('aborted');
  const response=await fetcher(base+q.route,{method:q.method,headers:{...headers,...('operationId'in q.value?{'idempotency-key':q.value.operationId,'content-type':'application/json'}:{})},credentials,cache:'no-store',redirect:'error',signal:controller.signal,...('body'in q.value?{body:JSON.stringify(q.value.body)}:{})});status=response.status;
  const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>262144))throw Error('bound');
  const reader=response.body?.getReader();if(!reader)throw Error('body');const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>262144)throw Error('bound');chunks.push(part.value);}}finally{await reader.cancel();reader.releaseLock();}
  if(controller.signal.aborted)throw Error('unconfirmed');
  const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
  const decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  if(q.value.operation==='reconcile'&&status===404){const code='RECEIPT_POLICY_OPERATION_NOT_FOUND';
   if([ {error:{code,message:code}}, {statusCode:404,code,error:'Not Found',message:code} ].some(value=>receiptCanonical(value)===receiptCanonical(decoded)))return{data:null};
  }
  if(!response.ok)throw Error('unconfirmed');
  const value=receiptPolicyResponse(decoded,q.value,workspace);
  if(value.data&&await hash(value.data.body)!==value.data.ref.sha256)throw Error('hash');
  if(value.effective){const {sha256,...body}=value.effective;if(await hash(body)!==sha256)throw Error('hash');}
  if(controller.signal.aborted)throw Error('aborted');return value;
 }catch{throw new ReceiptPolicyClientError(q.method==='GET'?'RECEIPT_POLICY_READ_UNCONFIRMED':'RECEIPT_POLICY_WRITE_UNCONFIRMED',status);}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export function sessionReceiptPolicies(selection:unknown,fetcher:typeof fetch=fetch):ReceiptPolicyClient{
 const p=profileSelectionSchema.safeParse(selection);if(!p.success||p.data.workspaceId===null||p.data.version<1)throw new ReceiptPolicyClientError('RECEIPT_POLICY_AUTHORITY_REQUIRED');
 const w=p.data.workspaceId,h={'x-commerce-profile-id':w,'x-commerce-profile-version':String(p.data.version)};return(q,s)=>execute(q,'',h,'include',fetcher,w,s);
}
export function personalReceiptPolicies(origin:string,token:string,fetcher:typeof fetch=fetch):ReceiptPolicyClient{
 let u:URL;try{u=new URL(origin);}catch{throw new ReceiptPolicyClientError('RECEIPT_POLICY_AUTHORITY_REQUIRED');}
 if(u.username||u.password||u.pathname!=='/'||u.search||u.hash||!(u.protocol==='https:'||u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname))||!/^cos_pat_[A-Za-z0-9_-]{43}$/.test(token))throw new ReceiptPolicyClientError('RECEIPT_POLICY_AUTHORITY_REQUIRED');
 return(q,s)=>execute(q,u.origin,{authorization:'Bearer '+token},'omit',fetcher,undefined,s);
}
