import {z} from 'zod';
import {profileSelectionSchema} from '../../../../packages/contracts/src/profiles.js';
import {profileTokenCommandSchema,profileTokenIdSchema,profileTokenMetadataSchema,profileTokenOperationSchema,profileTokenMutationResultSchema,type ProfileTokenCommand} from '../../../../packages/contracts/src/profile-token-management.js';
import type {ProfileRequestFence} from './profile-settings.js';
export class ProfileTokenRequestError extends Error{constructor(readonly knownRejected=false){super(knownRejected?'La solicitud fue rechazada. Actualiza los datos antes de continuar.':'No se confirmó la solicitud. Consulta la operación antes de continuar.');}}
function reply<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)throw new ProfileTokenRequestError();return result.data;}
const rejected=new Map<string,number>([['PROFILE_TOKEN_INPUT_INVALID',400],['PROFILE_TOKEN_EXPIRY_INVALID',400],['PROFILE_TOKEN_ENVIRONMENTS_INVALID',400],['PROFILE_TOKEN_ROTATION_REQUIRES_HOLDER',403],['PROFILE_TOKEN_GRANT_EXCEEDS_ISSUER',403],['PROFILE_ACTION_FORBIDDEN',403],['PROFILE_SUSPENDED',403],['PROFILE_INTERACTIVE_SESSION_REQUIRED',403],['PROFILE_TOKEN_NOT_FOUND',404],['PROFILE_TOKEN_ALREADY_REVOKED',409],['PROFILE_TOKEN_NOT_ACTIVE',409],['PROFILE_TOKEN_VERSION_CONFLICT',409],['PROFILE_TOKEN_OPERATION_CONFLICT',409],['PROFILE_AUTHORITY_BUSY',409]]);
async function request(selection:ProfileRequestFence,path:string,body?:ProfileTokenCommand,signal?:AbortSignal){
 const fence=profileSelectionSchema.parse(selection);if(!fence.workspaceId||fence.version<1)throw new ProfileTokenRequestError(true);
 const controller=new AbortController(),abort=()=>controller.abort();if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,15000);
 try{
  const response=await fetch(path,{method:body?'POST':'GET',credentials:'include',redirect:'error',cache:'no-store',signal:controller.signal,headers:{'x-commerce-profile-id':fence.workspaceId,'x-commerce-profile-version':String(fence.version),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const reader=response.body?.getReader();if(!reader)throw Error();let size=0;const chunks:Uint8Array[]=[];
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>1048576)throw Error();chunks.push(value);}}finally{await reader.cancel();reader.releaseLock();}
  if(controller.signal.aborted)throw Error();const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  if(response.status===404&&value?.error?.code==='PROFILE_TOKEN_OPERATION_NOT_FOUND'&&!body)return null;
  if(!response.ok){const code=value?.error?.code,message=value?.error?.message;throw new ProfileTokenRequestError(rejected.get(code)===response.status||response.status===409&&code==='VERSION_CONFLICT'&&message==='PROFILE_TOKEN_VERSION_CONFLICT');}
  return value;
 }catch(error){if(error instanceof ProfileTokenRequestError)throw error;throw new ProfileTokenRequestError();}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export async function loadProfileTokens(fence:ProfileRequestFence,offset=0,signal?:AbortSignal){
 z.number().int().min(0).max(10000).parse(offset);const value=reply(z.object({data:z.array(profileTokenMetadataSchema).max(20),meta:z.object({hasMore:z.boolean(),limit:z.literal(20),offset:z.literal(offset)}).strict()}).strict(),await request(fence,'/v2/tokens?limit=20&offset='+offset,undefined,signal));
 if(new Set(value.data.map(r=>r.id)).size!==value.data.length||value.meta.hasMore&&value.data.length!==20)throw new ProfileTokenRequestError();return value;
}
export async function readProfileTokenOperation(fence:ProfileRequestFence,id:string){
 const ident=profileTokenIdSchema.parse(id),value=await request(fence,'/v2/tokens/operations/'+ident);if(value===null)return null;const r=reply(z.object({data:profileTokenOperationSchema}).strict(),value).data;if(r.id!==ident)throw new ProfileTokenRequestError();return r;
}
export async function mutateProfileToken(fence:ProfileRequestFence,input:unknown){
 const body=profileTokenCommandSchema.parse(input),result=reply(z.object({data:profileTokenMutationResultSchema}).strict(),await request(fence,'/v2/tokens/operations',body)).data;
 if(result.operation.id!==body.operationId||result.operation.action!==body.action||body.action==='revoke'&&(result.operation.tokenId!==body.tokenId||result.operation.tokenVersion!==body.expectedVersion+1)||body.action==='rotate'&&result.operation.replacedTokenId!==body.tokenId||body.action!=='rotate'&&result.operation.replacedTokenId!==null||body.action!=='revoke'&&result.operation.tokenVersion!==1)throw new ProfileTokenRequestError();return result;
}
