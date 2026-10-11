import {isIP} from 'node:net';
/** A grant and its notification are different durable effects. Never log the returned access. */
export interface GrantRequest {
  grantId:string; subjectId:string; assetReference:string;
  environment:'SIMULATION'|'REAL'; offerVersionId:string;
}
export interface PrivateAccess {url?:string;code?:string;instructions?:string}
export interface GrantResult {
  status:'GRANTED'|'REJECTED'|'UNKNOWN'; providerGrantId?:string;
  access?:PrivateAccess;reason?:string;
}
export interface FulfillmentProvider {grant(input:GrantRequest):Promise<GrantResult>}
/** Shared codes are an operator-approved artifact, not proof of a remote portal grant. */
export function parseStaticAccessReference(reference:string):Required<PrivateAccess> {
 try {
  const value=JSON.parse(reference);if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['url','code','instructions'].includes(key)))throw new Error();
  if(typeof value.url!=='string'||value.url.length>2048||typeof value.code!=='string'||!value.code.trim()||value.code.length>512||typeof value.instructions!=='string'||value.instructions.length>4096||[...value.code].some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127))throw new Error();
  const url=new URL(value.url);if(url.protocol!=='https:'||url.username||url.password||url.hash||isIP(url.hostname.replace(/^\[|\]$/g,''))||!url.hostname.includes('.')||/localhost|\.local$|\.internal$|metadata/i.test(url.hostname))throw new Error();
  return{url:url.href,code:value.code,instructions:value.instructions};
 }catch{throw new Error('STATIC_ACCESS_REFERENCE_INVALID');}
}
export class StaticAccessFulfillmentProvider implements FulfillmentProvider {
 async grant(input:GrantRequest):Promise<GrantResult>{
  if(input.environment!=='REAL')return{status:'REJECTED',reason:'STATIC_ACCESS_REQUIRES_REAL_ENVIRONMENT'};
  if(!input.grantId||!input.subjectId||!input.offerVersionId)return{status:'REJECTED',reason:'GRANT_INPUT_INVALID'};
  try{return{status:'GRANTED',providerGrantId:`static:${input.grantId}`,access:parseStaticAccessReference(input.assetReference)};}
  catch{return{status:'REJECTED',reason:'STATIC_ACCESS_REFERENCE_INVALID'};}
 }
}
export class SimulatedFulfillmentProvider implements FulfillmentProvider {
 private grants=new Map<string,GrantResult>();
 async grant(input:GrantRequest):Promise<GrantResult>{
  if(input.environment!=='SIMULATION')return{status:'REJECTED',reason:'SIMULATOR_ENVIRONMENT_REQUIRED'};
  if(!this.grants.has(input.grantId))this.grants.set(input.grantId,{status:'GRANTED',providerGrantId:`simulation:${input.grantId}`,access:{url:`https://example.com/simulation-access/${encodeURIComponent(input.grantId)}`,instructions:'Concesión sintética; no acredita acceso a un portal real.'}});
  return structuredClone(this.grants.get(input.grantId)!);
 }
}
/** Endpoint is protected operator configuration, never a URL supplied by customer content or a flow node. */
export class WebhookFulfillmentProvider implements FulfillmentProvider {
 private endpoint:URL;
 constructor(private readonly config:{endpoint:string;token:string;allowedOrigin:string;timeoutMs?:number;fetcher?:typeof fetch}){
  this.endpoint=new URL(config.endpoint);
  if(this.endpoint.protocol!=='https:'||this.endpoint.origin!==config.allowedOrigin||this.endpoint.username||this.endpoint.password||this.endpoint.hash)throw new Error('FULFILLMENT_ENDPOINT_NOT_ALLOWED');
  if(config.token.length<16)throw new Error('FULFILLMENT_TOKEN_REQUIRED');
 }
 async grant(input:GrantRequest):Promise<GrantResult>{
  if(input.environment!=='REAL')return{status:'REJECTED',reason:'REMOTE_GRANT_REQUIRES_REAL_ENVIRONMENT'};
  if(!input.grantId||!input.subjectId||!input.assetReference||!input.offerVersionId)return{status:'REJECTED',reason:'GRANT_INPUT_INVALID'};
  try {
   const response=await(this.config.fetcher??fetch)(this.endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(this.config.timeoutMs??10000),headers:{Authorization:`Bearer ${this.config.token}`,'Content-Type':'application/json','Idempotency-Key':input.grantId},body:JSON.stringify({schema_version:1,grant_id:input.grantId,subject_id:input.subjectId,asset_reference:input.assetReference,offer_version_id:input.offerVersionId})});
   if(response.status>=400&&response.status<500&&response.status!==408)return{status:'REJECTED',reason:`GRANT_HTTP_${response.status}`};
   if(!response.ok)return{status:'UNKNOWN',reason:`GRANT_HTTP_${response.status}`};
   if(Number(response.headers.get('content-length')??0)>65536)return{status:'UNKNOWN',reason:'GRANT_RESPONSE_TOO_LARGE'};
   const reader=response.body?.getReader();if(!reader)return{status:'UNKNOWN',reason:'GRANT_RESPONSE_INVALID'};
   const chunks:Uint8Array[]=[];let length=0;
   while(true){const result=await reader.read();if(result.done)break;length+=result.value.byteLength;if(length>65536){await reader.cancel();return{status:'UNKNOWN',reason:'GRANT_RESPONSE_TOO_LARGE'};}chunks.push(result.value);}
   const raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(raw.status!=='GRANTED'||typeof raw.grant_id!=='string'||!raw.grant_id||raw.grant_id.length>256)return{status:'UNKNOWN',reason:'GRANT_RESPONSE_INVALID'};
   const access:PrivateAccess={};
   for(const key of ['url','code','instructions'] as const){if(raw.access?.[key]!==undefined){if(typeof raw.access[key]!=='string'||raw.access[key].length>4096)return{status:'UNKNOWN',reason:'GRANT_ACCESS_INVALID'};access[key]=raw.access[key];}}
   if(access.url){const u=new URL(access.url);if(u.protocol!=='https:'||u.username||u.password)return{status:'UNKNOWN',reason:'GRANT_ACCESS_URL_INVALID'};}
   if(!Object.keys(access).length)return{status:'UNKNOWN',reason:'GRANT_ACCESS_MISSING'};
   return{status:'GRANTED',providerGrantId:raw.grant_id,access};
  }catch{return{status:'UNKNOWN',reason:'GRANT_RESPONSE_UNCERTAIN'};}
 }
}
