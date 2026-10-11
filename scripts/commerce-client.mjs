#!/usr/bin/env node
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {basename} from 'node:path';
import {pathToFileURL} from 'node:url';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class CommerceClient {
 constructor({baseUrl=process.env.COMMERCE_API_URL,token=process.env.COMMERCE_SERVICE_TOKEN,lab=false,timeoutMs=30000}={}){
  if(!baseUrl||!token)throw new Error('COMMERCE_API_URL and COMMERCE_SERVICE_TOKEN are required. Read the token from private storage, never pass it as a command argument.');
  this.base=new URL(baseUrl);if(this.base.protocol!=='https:'&&!(this.base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(this.base.hostname)))throw new Error('HTTPS_REQUIRED');
  this.token=token;this.environment=lab?'SIMULATION':'REAL';this.timeoutMs=timeoutMs;
 }
 async request(method,path,{body,key,query={}}={}){
  if(!path.startsWith('/v1/')||path.includes('://')||path.startsWith('//'))throw new Error('RELATIVE_V1_PATH_REQUIRED');
  const url=new URL(path,this.base);if(url.origin!==this.base.origin)throw new Error('ORIGIN_MISMATCH');
  for(const[k,v]of Object.entries(query))url.searchParams.set(k,String(v));
  if((url.searchParams.has('environment')&&url.searchParams.get('environment')!==this.environment)||(body?.environment&&body.environment!==this.environment))throw new Error('ENVIRONMENT_CONFLICT');
  const mutation=!['GET','HEAD'].includes(method.toUpperCase());url.searchParams.set('environment',this.environment);
  const headers={Authorization:'Bearer '+this.token};if(mutation){headers['Idempotency-Key']=key??randomUUID();headers['Content-Type']='application/json';}
  let response;try{response=await fetch(url,{method,headers,body:mutation?JSON.stringify({...body,environment:this.environment}):undefined,signal:AbortSignal.timeout(this.timeoutMs),redirect:'error'});}catch(error){throw Object.assign(new Error('TRANSPORT_UNCERTAIN: inspect the operation before retrying with the same key.'),{code:'TRANSPORT_UNCERTAIN',idempotencyKey:headers['Idempotency-Key'],cause:error});}
  const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error?.message??'HTTP_ERROR'),{code:value.error?.code??'HTTP_ERROR',status:response.status,details:value.error?.details,idempotencyKey:headers['Idempotency-Key']});
  return{...value,http_status:response.status,idempotency_key:headers['Idempotency-Key']};
 }
 async upload(path,{name=basename(path),mimeType,key=randomUUID()}={}){
  if(!mimeType)throw new Error('MIME_REQUIRED');const bytes=await readFile(path);if(!bytes.length||bytes.length>20971520)throw new Error('INVALID_SIZE');
  const {createHash}=await import('node:crypto');const sha256=createHash('sha256').update(bytes).digest('hex');
  const intent=await this.request('POST','/v1/assets/upload-intents',{body:{name,kind:'file',mime_type:mimeType,size_bytes:bytes.length,sha256},key:key+':intent'});
  await this.request('PUT',`/v1/assets/${intent.data.id}/content`,{body:{base64:bytes.toString('base64')},key:key+':content'});
  return this.request('POST',`/v1/assets/${intent.data.id}/complete`,{body:{},key:key+':complete'});
 }
 async follow(commandId,{until='DELIVERED',timeoutMs=60000,intervalMs=1000}={}){
  if(!['SENT','DELIVERED','READ'].includes(until))throw new Error('INVALID_ACK_TARGET');
  const deadline=Date.now()+timeoutMs;let command,effects=[];
  while(Date.now()<deadline){
   command=(await this.request('GET',`/v1/commands/${commandId}`)).data;
   if(command.status==='FAILED')return{status:'FAILED',command,effects};
   if(command.status==='APPLIED'){
    effects=(await this.request('GET',`/v1/commands/${commandId}/effects`)).data;
    if(!effects.length)return{status:'APPLIED_WITHOUT_DIRECT_EFFECT',command,effects};
    if(effects.some(effect=>['UNKNOWN','FAILED','CANCELLED','BLOCKED'].includes(effect.status)))return{status:'ATTENTION_REQUIRED',command,effects};
    const rank={SENT:1,DELIVERED:2,READ:3};
    if(effects.every(effect=>(rank[effect.status]??0)>=rank[until]))return{status:until,command,effects,portal_access:'NOT_OBSERVED'};
   }
   await wait(Math.min(intervalMs,Math.max(0,deadline-Date.now())));
  }
  return{status:'TIMEOUT',command,effects,portal_access:'NOT_OBSERVED'};
 }
}
const safe=(value,key='')=>{
 if(/token|ciphertext|cookie|password|secret|base64|storage_key|delivery_reference/i.test(key))return'[REDACTED]';
 if(Array.isArray(value))return value.map(item=>safe(item));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,safe(v,k)]));
 return value;
};
async function main(){
 const args=process.argv.slice(2);if(!args.length||args.includes('--help')){process.stdout.write('Commerce OS authenticated HTTP client (REAL default).\nrequest METHOD /v1/path [--body file.json] [--key stable-key] [--lab]\nupload file --mime audio/mpeg --key stable-key [--lab]\nfollow command-id [--until DELIVERED|READ|SENT] [--lab]\nMutation CLI requests require --key; credentials come from COMMERCE_SERVICE_TOKEN.\n');return;}
 const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};const client=new CommerceClient({lab:args.includes('--lab')});let result;
 if(args[0]==='request'){
  const method=args[1]?.toUpperCase(),path=args[2];if(!method||!path)throw new Error('METHOD_AND_PATH_REQUIRED');const key=option('--key');if(!['GET','HEAD'].includes(method)&&!key)throw new Error('STABLE_IDEMPOTENCY_KEY_REQUIRED');
  const file=option('--body'),body=file?JSON.parse(await readFile(file,'utf8')):undefined;result=await client.request(method,path,{body,key});
 }else if(args[0]==='upload'){
  if(!option('--key'))throw new Error('STABLE_IDEMPOTENCY_KEY_REQUIRED');result=await client.upload(args[1],{mimeType:option('--mime'),name:option('--name'),key:option('--key')});
 }else if(args[0]==='follow')result=await client.follow(args[1],{until:option('--until')??'DELIVERED'});
 else throw new Error('UNKNOWN_COMMAND');
 process.stdout.write(JSON.stringify(safe(result),null,2)+'\n');if(['FAILED','ATTENTION_REQUIRED','TIMEOUT'].includes(result.status))process.exitCode=2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{process.stderr.write(JSON.stringify({error:{code:error.code??error.message,status:error.status,idempotency_key:error.idempotencyKey}})+'\n');process.exitCode=1;});
