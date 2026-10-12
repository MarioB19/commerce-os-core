import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {QueryExecutor} from './index.js';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from './profile-context.js';
import {profileIdSchema,profileStateSchema,type ProfileState} from '../../contracts/src/profiles.js';

/** Service tokens are profile-bound automation credentials (V5 MCP). They are
 * not a membership identity: they never select a profile, switch sessions or
 * administer people/credentials. Authority is the token's own closed scopes. */
export type ServiceEnvironment='REAL'|'SIMULATION';
export interface ServiceProfile {
 kind:'service';
 tokenId:string;
 profile:{id:string;state:ProfileState};
 actorId:string;name:string;
 scopes:readonly string[];
 allowedEnvironments:readonly ServiceEnvironment[];
 resourceIds:readonly string[]|null;
 expiresAt:string;
 environment:ServiceEnvironment;
 /** cos_v5_ tokens replay per token; earlier tokens keep the actor namespace. */
 idempotencyActor?:string;
}
export class ServiceProfileTokenError extends Error {
 readonly statusCode=401;
 constructor(readonly code:string){super(code);this.name='ServiceProfileTokenError';}
}
function need(value:unknown,code:string):asserts value{if(!value)throw new ServiceProfileTokenError(code);}
interface Route {tokenId:string;workspaceId:string;hash:string;v5?:boolean}
const scopesSchema=z.array(z.string().min(1).max(80)).min(1).max(64);
const environmentsSchema=z.array(z.enum(['REAL','SIMULATION'])).min(1).max(2);
const resourcesSchema=z.array(z.string().min(1).max(256)).min(1).max(256).nullable();

/** Bearer secrets other than cos_pat_ are opaque. Only the full SHA-256 is used. */
export function isServiceBearer(token:unknown):token is string{
 return typeof token==='string'&&token.length>=16&&token.length<=512&&!token.startsWith('cos_pat_')&&/^[\x21-\x7e]+$/.test(token);
}
async function locate(db:QueryExecutor,token:string):Promise<Route>{
 need(isServiceBearer(token),'INVALID_TOKEN');
 const hash=createHash('sha256').update(token).digest('hex');
 const rows=(await db.query('SELECT token_id,workspace_id FROM public.locate_service_profile_token($1)',[hash])).rows;
 need(rows.length===1&&typeof rows[0].token_id==='string'&&profileIdSchema.safeParse(rows[0].workspace_id).success,'INVALID_TOKEN');
 return{tokenId:rows[0].token_id,workspaceId:rows[0].workspace_id,hash,v5:token.startsWith('cos_v5_')};
}
/** Inside the token profile's transaction; locks the token row by default. */
export async function serviceAuthority(db:ProfileExecutor,route:Route,environment:ServiceEnvironment|null,lock=true):Promise<ServiceProfile>{
 need(db.workspaceId===route.workspaceId,'INVALID_TOKEN');
 need(environment===null||environment==='REAL'||environment==='SIMULATION','ENVIRONMENT_FORBIDDEN');
 const profile=(await db.query('SELECT id,state FROM profiles WHERE id=$1'+(lock?' FOR SHARE':''),[route.workspaceId])).rows[0];
 need(profile&&profileStateSchema.safeParse(profile.state).success,'INVALID_TOKEN');
 const token=(await db.query(`SELECT id,actor_id,name,scopes,allowed_environments,resource_ids,expires_at FROM service_tokens
  WHERE id=$1 AND workspace_id=$2 AND token_hash=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()`+(lock?' FOR SHARE':''),[route.tokenId,route.workspaceId,route.hash])).rows[0];
 need(token,'INVALID_TOKEN');
 const scopes=scopesSchema.safeParse(token.scopes),environments=environmentsSchema.safeParse(token.allowed_environments),resources=resourcesSchema.safeParse(token.resource_ids??null);
 need(scopes.success&&environments.success&&resources.success,'INVALID_TOKEN');
 if(environment!==null&&!environments.data.includes(environment))throw Object.assign(new ServiceProfileTokenError('ENVIRONMENT_FORBIDDEN'),{statusCode:403});
 return{kind:'service',...(route.v5?{idempotencyActor:'service:'+token.id}:{}),tokenId:token.id,profile:{id:profile.id,state:profile.state},actorId:token.actor_id,name:token.name,scopes:scopes.data,
  allowedEnvironments:environments.data,resourceIds:resources.data,expiresAt:new Date(token.expires_at).toISOString(),environment:environment??environments.data[0]!};
}
/** Resolve once, outside any profile scope, for request authentication. The
 * route's environment is checked later against allowedEnvironments. */
export async function resolveServiceProfile(pool:ProfilePool&QueryExecutor,token:string):Promise<ServiceProfile>{
 const route=await locate(pool,token);
 return withProfileTransaction(pool,route.workspaceId,db=>serviceAuthority(db,route,null,false));
}
/** Re-lock an authenticated service token inside the caller's transaction. */
export async function relockServiceProfile(db:ProfileExecutor,tokenId:string,environment:ServiceEnvironment):Promise<ServiceProfile>{
 const hash=(await db.query('SELECT token_hash FROM service_tokens WHERE id=$1 AND workspace_id=$2',[tokenId,db.workspaceId])).rows[0]?.token_hash;
 need(typeof hash==='string','INVALID_TOKEN');
 return serviceAuthority(db,{tokenId,workspaceId:db.workspaceId,hash},environment,true);
}
/** One transaction: locked authority before and after the SQL work. */
export async function withServiceProfileTransaction<T>(pool:ProfilePool&QueryExecutor,token:string,environment:ServiceEnvironment,
 work:(db:ProfileExecutor,profile:ServiceProfile)=>Promise<T>):Promise<T>{
 const route=await locate(pool,token);
 return withProfileTransaction(pool,route.workspaceId,async db=>{
  const current=await serviceAuthority(db,route,environment);
  const result=await work(db,current);
  await serviceAuthority(db,route,environment);
  return result;
 });
}
