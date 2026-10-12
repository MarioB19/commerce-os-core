import {z} from 'zod';
import {profileSelectionSchema} from '../../contracts/src/profiles.js';
import {marketCatalogSchema,marketCatalogQuerySchema} from '../../contracts/src/market-catalog.js';
/** Fixed GET only. No caller path, body, profile override or retry. */
export function sessionMarketCatalog(selection:unknown,fetcher:typeof fetch=fetch){
 const p=profileSelectionSchema.parse(selection);if(!p.workspaceId||p.version<1)throw Error('MARKET_AUTHORITY_REQUIRED');
 const workspace=p.workspaceId,headers={'x-commerce-profile-id':workspace,'x-commerce-profile-version':String(p.version)};
 return async(productId:unknown,environment:unknown,signal?:AbortSignal)=>{
  const id=z.uuid().parse(productId).toLowerCase(),q=marketCatalogQuerySchema.parse({environment}),controller=new AbortController();
  const abort=()=>controller.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,15000);
  try{
   if(controller.signal.aborted)throw Error('abort');
   const response=await fetcher('/v2/market/products/'+id+'/options?'+new URLSearchParams(q),{headers,credentials:'include',cache:'no-store',redirect:'error',signal:controller.signal});
   if(!response.ok)throw Error('http');const reader=response.body?.getReader();if(!reader)throw Error('body');let size=0;const parts:Uint8Array[]=[];
   try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>512*1024)throw Error('bound');parts.push(value);}}finally{await reader.cancel();reader.releaseLock();}
   if(controller.signal.aborted)throw Error('abort');const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}
   const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),data=z.object({data:marketCatalogSchema}).strict().parse(raw).data;
   if(data.scope.workspace_id!==workspace||data.scope.environment!==q.environment||data.product.id!==id)throw Error('scope');return data;
  }catch{throw Error('MARKET_CATALOG_UNCONFIRMED');}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 };
}
