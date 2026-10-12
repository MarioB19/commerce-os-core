import {profileSelectionSchema} from '../../contracts/src/profiles.js';
import {profileCatalogReadRoute,profileCatalogResult,type ProfileCatalogResult} from '../../contracts/src/profile-catalog-consumer.js';

export class ProfileCatalogError extends Error{
 constructor(readonly code:'CATALOG_INPUT_INVALID'|'CATALOG_AUTHORITY_REQUIRED'|'CATALOG_REQUEST_REJECTED'|'CATALOG_READ_UNCONFIRMED',readonly status=0){super(code);}
}
type Fetcher=typeof fetch;
export type ProfileCatalogReader=(input:unknown,signal?:AbortSignal)=>Promise<ProfileCatalogResult>;
const LIMIT=2*1024*1024;
async function read(input:unknown,origin:string,headers:Record<string,string>,credentials:RequestCredentials,fetcher:Fetcher,signal?:AbortSignal){
 let request:ReturnType<typeof profileCatalogReadRoute>;
 try{request=profileCatalogReadRoute(input);}catch{throw new ProfileCatalogError('CATALOG_INPUT_INVALID');}
 const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort(),15_000);
 try{
  if(controller.signal.aborted)throw new Error('aborted');
  const response=await fetcher(origin+request.route,{method:'GET',headers,credentials,cache:'no-store',redirect:'error',signal:controller.signal});
  const reader=response.body?.getReader();if(!reader)throw new Error('empty body');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>LIMIT)throw new Error('response limit');chunks.push(item.value);}}
  finally{await reader.cancel();reader.releaseLock();}
  if(controller.signal.aborted)throw new Error('aborted');
  if(!response.ok)throw new ProfileCatalogError('CATALOG_REQUEST_REJECTED',response.status);
  const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}
  return profileCatalogResult(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)),request.value);
 }catch(error){if(error instanceof ProfileCatalogError)throw error;throw new ProfileCatalogError('CATALOG_READ_UNCONFIRMED');}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

/** Cookie transport has no origin or bearer override. Fence is copied before I/O. */
export function sessionProfileCatalog(selection:unknown,fetcher:Fetcher=fetch):ProfileCatalogReader{
 const parsed=profileSelectionSchema.safeParse(selection);
 if(!parsed.success||parsed.data.workspaceId===null||parsed.data.version<1)throw new ProfileCatalogError('CATALOG_AUTHORITY_REQUIRED');
 const headers={'x-commerce-profile-id':parsed.data.workspaceId,'x-commerce-profile-version':String(parsed.data.version)};
 return(input,signal)=>read(input,'',headers,'include',fetcher,signal);
}

/** One fixed PAT; tools can neither replace it nor add cookie/profile selectors. */
export function personalProfileCatalog(origin:string,token:string,fetcher:Fetcher=fetch):ProfileCatalogReader{
 let base:URL;try{base=new URL(origin);}catch{throw new ProfileCatalogError('CATALOG_AUTHORITY_REQUIRED');}
 if(base.username||base.password||base.pathname!=='/'||base.search||base.hash||
  !(base.protocol==='https:'||base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname))||!/^cos_pat_[A-Za-z0-9_-]{43}$/.test(token))throw new ProfileCatalogError('CATALOG_AUTHORITY_REQUIRED');
 const headers={authorization:'Bearer '+token};
 return(input,signal)=>read(input,base.origin,headers,'omit',fetcher,signal);
}
