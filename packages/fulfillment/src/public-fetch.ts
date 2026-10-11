import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {Readable} from 'node:stream';
import {isPublicAddress,validatePublicEndpoint} from '../../db/src/integration-settings.js';
/** Resolve once, reject private/special addresses, and pin the verified DNS answer for TLS. */
export const publicEndpointFetch:typeof fetch=async(input,init={})=>{
 const url=validatePublicEndpoint(input instanceof Request?input.url:String(input));
 const addresses=await lookup(url.hostname,{all:true,verbatim:true});if(!addresses.length||addresses.some(item=>!isPublicAddress(item.address)))throw new Error('INTEGRATION_PUBLIC_ADDRESS_DENIED');const address=addresses[0]!;
 if(init.body!==undefined&&init.body!==null&&typeof init.body!=='string')throw new Error('INTEGRATION_REQUEST_BODY_UNSUPPORTED');
 return new Promise<Response>((resolve,reject)=>{
  const headers=Object.fromEntries(new Headers(init.headers).entries());const req=request(url,{method:init.method??'GET',headers,signal:init.signal??undefined,lookup:((_hostname:any,options:any,callback:any)=>{if(options?.all)callback(null,[address]);else callback(null,address.address,address.family);}) as any},response=>{
   const status=response.statusCode??502;if(status>=300&&status<400){response.destroy();reject(new Error('INTEGRATION_REDIRECT_DENIED'));return;}
   const safeHeaders=new Headers();for(const key of ['content-type','content-length','retry-after']){const value=response.headers[key];if(typeof value==='string')safeHeaders.set(key,value);}
   resolve(new Response([204,205,304].includes(status)?null:Readable.toWeb(response) as ReadableStream<Uint8Array>,{status,headers:safeHeaders}));
  });req.once('error',()=>reject(new Error('INTEGRATION_NETWORK_UNAVAILABLE')));if(typeof init.body==='string')req.write(init.body);req.end();
 });
};
