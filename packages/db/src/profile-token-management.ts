import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {appendEvent} from './index.js';
import type {ProfileExecutor} from './profile-context.js';
import {authorizeProfileAction,effectiveProfileScopes,type ProfileAuthority} from '../../domain/src/core/profile-authorization.js';
import {profileTokenCommandSchema,profileTokenIdSchema,profileTokenListSchema,profileTokenMetadataSchema,profileTokenOperationSchema,type ProfileTokenCommand} from '../../contracts/src/profile-token-management.js';
const columns='id,user_id,name,allowed_environments,profile_scopes,expires_at,revoked_at,version,created_at';
export class ProfileTokenManagementError extends Error{
 constructor(readonly code:string,readonly statusCode=409){super(code);this.name='ProfileTokenManagementError';}
}
function need(v:unknown,code:string,status=409):asserts v{if(!v)throw new ProfileTokenManagementError(code,status);}
function iso(value:unknown){const date=new Date(value as string);need(Number.isFinite(date.getTime()),'PROFILE_TOKEN_METADATA_INVALID',503);return date.toISOString();}
function metadata(row:any){return profileTokenMetadataSchema.parse({id:row.id,userId:row.user_id,name:row.name,allowedEnvironments:row.allowed_environments,scopes:row.profile_scopes,expiresAt:iso(row.expires_at),revokedAt:row.revoked_at===null?null:iso(row.revoked_at),version:row.version,createdAt:iso(row.created_at)});}
function operation(row:any){return profileTokenOperationSchema.parse({id:row.operation_id,action:row.action,tokenId:row.token_id,tokenVersion:row.token_version,replacedTokenId:row.replaced_token_id,createdAt:iso(row.created_at)});}
async function clock(db:ProfileExecutor){const row=(await db.query('SELECT clock_timestamp() AS observed_at')).rows[0];return new Date(iso(row?.observed_at));}
function authorize(db:ProfileExecutor,authority:ProfileAuthority,mutation:boolean,at:Date,interactiveOnly=false){authorizeProfileAction(authority,{workspaceId:db.workspaceId,scope:mutation?'tokens:write':'tokens:read',mutation,interactiveOnly},at);}
export async function listProfileTokens(db:ProfileExecutor,authority:ProfileAuthority,input:unknown){
 const q=profileTokenListSchema.parse(input);authorize(db,authority,false,await clock(db));
 const rows=(await db.query(`SELECT ${columns} FROM personal_access_tokens WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,[db.workspaceId,q.limit+1,q.offset])).rows;
 return{data:rows.slice(0,q.limit).map(metadata),meta:{hasMore:rows.length>q.limit,limit:q.limit,offset:q.offset}};
}
export async function readProfileTokenOperation(db:ProfileExecutor,authority:ProfileAuthority,id:unknown){
 const ident=profileTokenIdSchema.parse(id);authorize(db,authority,false,await clock(db));
 const row=(await db.query('SELECT operation_id,action,token_id,token_version,replaced_token_id,created_at FROM profile_token_operations WHERE workspace_id=$1 AND operation_id=$2',[db.workspaceId,ident])).rows[0];
 need(row,'PROFILE_TOKEN_OPERATION_NOT_FOUND',404);return operation(row);
}
/** Caller holds the common authority transaction/advisory lock. No commit,
 * network, secret persistence or retry occurs in this repository. */
export async function mutateProfileToken(db:ProfileExecutor,authority:ProfileAuthority,raw:unknown,credentialId?:string){
 const input=profileTokenCommandSchema.parse(raw),actor=authority.membership.userId;
 const initial=await clock(db);authorize(db,authority,true,initial,input.action!=='revoke');
 if(authority.credential.kind==='personal_token')need(profileTokenIdSchema.safeParse(credentialId).success,'PROFILE_TOKEN_CREDENTIAL_ID_REQUIRED',403);
 need(input.action!=='revoke'||input.tokenId!==credentialId,'PROFILE_TOKEN_SELF_REVOCATION_REQUIRES_SESSION');
 const requestSha=createHash('sha256').update(JSON.stringify(input)).digest('hex');
 const before=(await db.query('SELECT * FROM profile_token_operations WHERE workspace_id=$1 AND operation_id=$2',[db.workspaceId,input.operationId])).rows[0];
 if(before){need(before.request_sha256===requestSha&&before.actor_id===actor&&before.action===input.action,'PROFILE_TOKEN_OPERATION_CONFLICT');return{operation:operation(before),token:null,secretDelivered:false};}
 let previous:any;
 if(input.action!=='create'){
  previous=(await db.query(`SELECT ${columns} FROM personal_access_tokens WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[db.workspaceId,input.tokenId])).rows[0];
  need(previous,'PROFILE_TOKEN_NOT_FOUND',404);metadata(previous);
  need(previous.version===input.expectedVersion,'PROFILE_TOKEN_VERSION_CONFLICT');
  need(previous.revoked_at===null,'PROFILE_TOKEN_ALREADY_REVOKED');
  if(input.action==='rotate')need(previous.user_id===actor,'PROFILE_TOKEN_ROTATION_REQUIRES_HOLDER',403);
 }
 const at=await clock(db);authorize(db,authority,true,at,input.action!=='revoke');
 if(input.action==='rotate')need(Date.parse(previous.expires_at)>at.getTime(),'PROFILE_TOKEN_NOT_ACTIVE');
 if(input.action!=='revoke')grant(db,authority,input,at);
 let token:string|null=null,row=previous;
 if(input.action!=='revoke'){
  token='cos_pat_'+randomBytes(32).toString('base64url');const id=randomUUID(),digest=createHash('sha256').update(token).digest('hex');
  row=(await db.query(`INSERT INTO personal_access_tokens(id,workspace_id,user_id,name,token_hash,allowed_environments,profile_scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${columns},token_hash`,[id,db.workspaceId,actor,input.name,digest,JSON.stringify(input.allowedEnvironments),JSON.stringify(input.scopes),input.expiresAt])).rows[0];
  need(row&&row.id===id&&row.user_id===actor&&row.version===1&&row.revoked_at===null&&row.token_hash===digest,'PROFILE_TOKEN_CREATE_UNCONFIRMED');
  const savedMetadata=metadata(row);need(savedMetadata.name===input.name&&savedMetadata.expiresAt===input.expiresAt&&JSON.stringify(savedMetadata.scopes)===JSON.stringify(input.scopes)&&JSON.stringify(savedMetadata.allowedEnvironments)===JSON.stringify(input.allowedEnvironments),'PROFILE_TOKEN_CREATE_UNCONFIRMED');
 }
 if(previous&&input.action!=='create'){
  const revoked=(await db.query(`UPDATE personal_access_tokens SET revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND version=$3 AND revoked_at IS NULL RETURNING ${columns}`,[db.workspaceId,previous.id,input.expectedVersion])).rows[0];
  need(revoked&&revoked.id===previous.id&&revoked.version===previous.version+1&&revoked.revoked_at!==null,'PROFILE_TOKEN_REVOKE_UNCONFIRMED');metadata(revoked);if(input.action==='revoke')row=revoked;
 }
 const saved=(await db.query('INSERT INTO profile_token_operations(workspace_id,operation_id,actor_id,action,request_sha256,token_id,token_user_id,token_version,replaced_token_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[db.workspaceId,input.operationId,actor,input.action,requestSha,row.id,row.user_id,row.version,input.action==='rotate'?previous.id:null])).rows[0];
 const receipt=operation(saved);need(receipt.id===input.operationId&&receipt.action===input.action&&receipt.tokenId===row.id&&receipt.tokenVersion===row.version&&receipt.replacedTokenId===(input.action==='rotate'?previous.id:null),'PROFILE_TOKEN_OPERATION_UNCONFIRMED');
 await appendEvent(db,{workspace_id:db.workspaceId,environment:input.environment,event_type:'profile.personal_token.'+input.action,aggregate_id:row.id,correlation_id:input.operationId,actor:{type:authority.credential.kind==='session'?'human':'personal_api',id:actor,...(credentialId?{credential_id:credentialId}:{})},payload:{operation_id:input.operationId,token_id:row.id,replaced_token_id:receipt.replacedTokenId,version:row.version,reason:input.reason,commercial_activation_authorized:false}});
 const final=await clock(db);authorize(db,authority,true,final,input.action!=='revoke');if(input.action!=='revoke')grant(db,authority,input,final);
 return{operation:receipt,token,secretDelivered:token!==null};
}
function grant(db:ProfileExecutor,authority:ProfileAuthority,input:Exclude<ProfileTokenCommand,{action:'revoke'}>,at:Date){
 need(input.allowedEnvironments.includes(input.environment),'PROFILE_TOKEN_ENVIRONMENTS_INVALID',400);
 const expiry=Date.parse(input.expiresAt);need(expiry>at.getTime()&&expiry<=at.getTime()+90*86400000,'PROFILE_TOKEN_EXPIRY_INVALID',400);
 const scopes=effectiveProfileScopes(authority,at);need(input.scopes.every(scope=>scopes.includes(scope)),'PROFILE_TOKEN_GRANT_EXCEEDS_ISSUER',403);
 need(authority.credential.workspaceId===db.workspaceId,'PROFILE_TOKEN_IDENTITY_INVALID',403);
}
