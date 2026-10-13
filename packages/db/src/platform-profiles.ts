import {createHash,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {encrypt,uuid,type QueryExecutor} from './index.js';
import {invitationRecipientDigest} from './profile-invitation.js';
import {invitationEmailSchema} from '../../contracts/src/profile-invitations.js';
import {profileIdSchema} from '../../contracts/src/profiles.js';

/** V7 RF-01.5/RF-02 platform administration. Every call runs outside any
 * profile context, through closed SECURITY DEFINER ports owned by
 * commerce_platform_owner: the native session is re-verified in SQL and only
 * an active platform admin passes. Ports return aggregates only. */
/** An interactive native session, or a platform token (id 'platform-token:<sha256>')
 * whose scopes the API checks per route; SQL re-verifies either on every port. */
export type PlatformSession={id:string;userId:string;scopes?:readonly PlatformScope[]};
export const platformScopes=['platform:profiles','platform:capacity','platform:health','platform:recovery','platform:releases','platform:audit'] as const;
export type PlatformScope=typeof platformScopes[number];
export class PlatformError extends Error{constructor(readonly code:string,readonly statusCode:number){super(code);}}
const known:Record<string,number>={PROFILE_SESSION_EXPIRED:401,PLATFORM_ADMIN_REQUIRED:403,PLATFORM_OUTSIDE_PROFILE_REQUIRED:409,PLATFORM_PROFILE_INVALID:400,
 PLATFORM_INVITATION_INVALID:400,PLATFORM_OPERATION_INVALID:400,PLATFORM_OPERATION_CONTENT_CHANGED:409,PLATFORM_PROFILE_NOT_FOUND:404,PLATFORM_PROFILE_CHANGED:409,
 PLATFORM_PROFILE_HAS_OWNER:409,PROFILE_SUSPENDED:409,INVITATION_ALREADY_PENDING:409,PROFILE_QUOTA_ALLOCATION_EXCEEDED:409,PROFILE_QUOTA_BELOW_CONSUMED:409,PROFILE_QUOTA_BUSY:409,
 PLATFORM_TOKEN_INVALID:401,PLATFORM_INTERACTIVE_SESSION_REQUIRED:403,PLATFORM_TOKEN_LIMIT:409,PLATFORM_TOKEN_INVALID_INPUT:400,PLATFORM_TOKEN_NOT_FOUND:404};
async function port<T>(work:()=>Promise<T>):Promise<T>{
 try{return await work();}
 catch(error){const code=(error as {message?:string}).message;if(code&&Object.hasOwn(known,code))throw new PlatformError(code,known[code]!);throw error;}
}
function session(value:PlatformSession){if(!value?.id||!value.userId)throw new PlatformError('PROFILE_SESSION_EXPIRED',401);return value;}
const count=z.coerce.number().int().min(0);
const summarySchema=z.object({id:profileIdSchema,business_name:z.string(),state:z.enum(['ACTIVE','SUSPENDED']),timezone:z.string(),number_limit:z.number().int(),product_limit:z.number().int(),
 daily_conversation_limit:z.number().int(),version:z.number().int().positive(),owners:count,numbers_registered:count,numbers_connected:count,products:count,variants:count,offers:count,
 ai_unverified:count,meta_invalid:z.boolean(),last_activity_at:z.date().nullable(),created_at:z.date()}).strict();
export type PlatformProfileSummary={id:string;businessName:string;state:'ACTIVE'|'SUSPENDED';timezone:string;limits:{numbers:number;products:number;dailyConversations:number};version:number;
 owners:number;numbers:{registered:number;connected:number;disconnected:number};products:number;variants:number;offers:number;signals:string[];lastActivityAt:string|null;createdAt:string};
export async function listPlatformProfiles(db:QueryExecutor,current:PlatformSession):Promise<PlatformProfileSummary[]>{
 const s=session(current);
 const rows=await port(async()=>(await db.query('SELECT * FROM platform_profile_summaries($1,$2)',[s.id,s.userId])).rows);
 return rows.map(raw=>{
  const r=summarySchema.parse(raw),disconnected=r.numbers_registered-r.numbers_connected,signals=[] as string[];
  if(disconnected>0)signals.push('NUMBERS_DISCONNECTED');if(r.ai_unverified>0)signals.push('AI_UNVERIFIED');if(r.meta_invalid)signals.push('META_INVALID');if(r.owners===0)signals.push('OWNER_MISSING');
  if(r.numbers_registered>=r.number_limit&&r.number_limit>0)signals.push('NUMBER_LIMIT_REACHED');
  return{id:r.id,businessName:r.business_name,state:r.state,timezone:r.timezone,limits:{numbers:r.number_limit,products:r.product_limit,dailyConversations:r.daily_conversation_limit},version:r.version,
   owners:r.owners,numbers:{registered:r.numbers_registered,connected:r.numbers_connected,disconnected},products:r.products,variants:r.variants,offers:r.offers,signals,
   lastActivityAt:r.last_activity_at?.toISOString()??null,createdAt:r.created_at.toISOString()};
 });
}
export async function readPlatformCapacity(db:QueryExecutor,current:PlatformSession){
 const s=session(current);
 const row=await port(async()=>(await db.query('SELECT * FROM platform_capacity($1,$2)',[s.id,s.userId])).rows[0]);
 if(!row)throw new PlatformError('PLATFORM_QUOTA_POLICY_REQUIRED',503);
 return{profiles:{used:Number(row.profiles),max:row.max_profiles},numbers:{allocated:Number(row.allocated_numbers),registered:Number(row.registered_numbers),max:row.max_numbers},dailyConversationsPerProfile:row.daily_conversations};
}
export const platformCreateProfileSchema=z.object({operationId:z.uuid(),businessName:z.string().trim().min(1).max(160),timezone:z.string().min(1).max(64),
 limits:z.object({numbers:z.number().int().min(0).max(20),products:z.number().int().min(0).max(100000),dailyConversations:z.number().int().min(0).max(100000)}).strict()}).strict();
export const platformUpdateProfileSchema=z.union([
 z.object({operationId:z.uuid(),expectedVersion:z.number().int().positive(),state:z.enum(['ACTIVE','SUSPENDED'])}).strict(),
 z.object({operationId:z.uuid(),expectedVersion:z.number().int().positive(),limits:platformCreateProfileSchema.shape.limits}).strict(),
]);
export const platformInviteOwnerSchema=z.object({operationId:z.uuid(),email:invitationEmailSchema}).strict();
const resultSchema=z.object({status:z.enum(['CREATED','UPDATED','QUEUED']),profile_id:profileIdSchema,version:z.number().int().positive().optional(),invitation_id:z.uuid().optional(),replayed:z.literal(true).optional()}).strict();
function result(raw:unknown){const r=resultSchema.parse(raw);return{status:r.status,profileId:r.profile_id,...(r.version?{version:r.version}:{}),...(r.invitation_id?{invitationId:r.invitation_id}:{}),replayed:r.replayed===true};}
export async function createPlatformProfile(db:QueryExecutor,current:PlatformSession,raw:unknown){
 const s=session(current),input=platformCreateProfileSchema.parse(raw);
 return result(await port(async()=>(await db.query('SELECT platform_create_profile($1,$2,$3,$4,$5,$6,$7,$8) AS r',[s.id,s.userId,input.operationId,input.businessName,input.timezone,input.limits.numbers,input.limits.products,input.limits.dailyConversations])).rows[0]?.r));
}
export async function updatePlatformProfile(db:QueryExecutor,current:PlatformSession,profileId:string,raw:unknown){
 const s=session(current),id=profileIdSchema.parse(profileId),input=platformUpdateProfileSchema.parse(raw);
 const limits='limits' in input?input.limits:null,state='state' in input?input.state:null;
 return result(await port(async()=>(await db.query('SELECT platform_update_profile($1,$2,$3,$4,$5,$6,$7,$8,$9) AS r',[s.id,s.userId,input.operationId,id,input.expectedVersion,state,limits?.numbers??null,limits?.products??null,limits?.dailyConversations??null])).rows[0]?.r));
}
/** The recipient is encrypted here under the profile invitation custody scope;
 * SQL stores only its digest and ciphertext, as for member invitations. */
export async function invitePlatformOwner(db:QueryExecutor,current:PlatformSession,profileId:string,raw:unknown){
 const s=session(current),id=profileIdSchema.parse(profileId),input=platformInviteOwnerSchema.parse(raw),invitationId=uuid();
 const email=invitationEmailSchema.parse(input.email),digest=invitationRecipientDigest(id,email);
 const ciphertext=encrypt({scope:'profile.invitation.recipient.v1',workspaceId:id,invitationId,email});
 return result(await port(async()=>(await db.query('SELECT platform_invite_owner($1,$2,$3,$4,$5,$6,$7) AS r',[s.id,s.userId,input.operationId,id,invitationId,digest,ciphertext])).rows[0]?.r));
}
/** Whether the session user is an active platform admin (navigation only). */
export async function isPlatformAdmin(db:QueryExecutor,current:PlatformSession){
 try{await port(async()=>db.query('SELECT platform_admin_actor($1,$2)',[session(current).id,current.userId]));return true;}
 catch(error){if(error instanceof PlatformError&&error.code==='PLATFORM_ADMIN_REQUIRED')return false;throw error;}
}
const tokenPattern=/^cos_plt_[A-Za-z0-9_-]{43}$/;
const tokenHash=(token:string)=>createHash('sha256').update(token,'utf8').digest('hex');
export const isPlatformToken=(value:unknown):value is string=>typeof value==='string'&&tokenPattern.test(value);
/** Resolves a presented platform token; the secret itself never reaches SQL. */
export async function resolvePlatformToken(db:QueryExecutor,token:string):Promise<PlatformSession>{
 if(!isPlatformToken(token))throw new PlatformError('PLATFORM_TOKEN_INVALID',401);
 const hash=tokenHash(token),row=await port(async()=>(await db.query('SELECT * FROM platform_token_actor($1)',[hash])).rows[0]);
 if(!row)throw new PlatformError('PLATFORM_TOKEN_INVALID',401);
 return{id:'platform-token:'+hash,userId:row.user_id,scopes:z.array(z.enum(platformScopes)).parse(row.scopes)};
}
export const platformTokenInputSchema=z.object({name:z.string().trim().min(1).max(100),scopes:z.array(z.enum(platformScopes)).min(1).max(6),expiresAt:z.iso.datetime({offset:true})}).strict();
const tokenMetadata=z.object({id:z.uuid(),name:z.string(),scopes:z.array(z.enum(platformScopes)),expiresAt:z.coerce.date(),createdAt:z.coerce.date()}).strict();
/** Interactive session only. The bearer is returned once and stored as a hash. */
export async function issuePlatformToken(db:QueryExecutor,current:PlatformSession,raw:unknown){
 const s=session(current),input=platformTokenInputSchema.parse(raw);
 if(s.id.startsWith('platform-token:'))throw new PlatformError('PLATFORM_INTERACTIVE_SESSION_REQUIRED',403);
 const token='cos_plt_'+randomBytes(32).toString('base64url'),id=uuid();
 const result=await port(async()=>(await db.query('SELECT platform_issue_token($1,$2,$3,$4,$5,$6,$7) AS r',[s.id,s.userId,id,input.name,input.scopes,input.expiresAt,tokenHash(token)])).rows[0]?.r);
 const meta=tokenMetadata.parse(result);
 return{token,id:meta.id,name:meta.name,scopes:meta.scopes,expiresAt:meta.expiresAt.toISOString(),createdAt:meta.createdAt.toISOString()};
}
export async function listPlatformTokens(db:QueryExecutor,current:PlatformSession){
 const s=session(current);
 const rows=await port(async()=>(await db.query('SELECT * FROM platform_list_tokens($1,$2)',[s.id,s.userId])).rows);
 return rows.map(r=>({id:r.id as string,name:r.name as string,scopes:[...r.scopes] as string[],expiresAt:new Date(r.expires_at).toISOString(),revokedAt:r.revoked_at?new Date(r.revoked_at).toISOString():null,createdAt:new Date(r.created_at).toISOString()}));
}
export async function revokePlatformToken(db:QueryExecutor,current:PlatformSession,id:string){
 const s=session(current),tokenId=z.uuid().parse(id);
 return z.object({id:z.uuid(),revoked:z.literal(true),changed:z.boolean()}).strict().parse(await port(async()=>(await db.query('SELECT platform_revoke_token($1,$2,$3) AS r',[s.id,s.userId,tokenId])).rows[0]?.r));
}
/** RF-07.f supervisor credential: platform:capacity only, one profile, REAL, 15 minutes. */
export async function issueCapacityAgentToken(db:QueryExecutor,current:PlatformSession,workspaceId:string){
 const s=session(current),id=profileIdSchema.parse(workspaceId);
 if(s.id.startsWith('platform-token:')&&!current.scopes?.includes('platform:capacity'))throw new PlatformError('PLATFORM_SCOPE_REQUIRED',403);
 const token='cos_cap_'+randomBytes(32).toString('base64url'),tokenId=uuid(),expiresAt=new Date(Date.now()+14*60000).toISOString();
 const result=z.object({id:z.uuid(),workspaceId:profileIdSchema,expiresAt:z.coerce.date()}).strict().parse(await port(async()=>(await db.query('SELECT platform_issue_capacity_agent_token($1,$2,$3,$4,$5,$6) AS r',[s.id,s.userId,id,tokenId,tokenHash(token),expiresAt])).rows[0]?.r));
 return{token,id:result.id,workspaceId:result.workspaceId,expiresAt:result.expiresAt.toISOString()};
}
