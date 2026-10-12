import {z} from 'zod';
import {profileIdSchema,profileScopeSchema,type ProfileScope} from '../../../contracts/src/profiles.js';
import {authorizeProfileAction,type ProfileAction,type ProfileAuthority} from './profile-authorization.js';
import type {Principal} from './permissions.js';

/** Route compatibility only. Missing scopes/aliases are intentionally denied;
 * this table is not a new business action or platform-token permission model. */
const pairs:Partial<Record<ProfileScope,readonly string[]>>={
 'products:read':['catalog:read','products:read'],
 'products:write':['catalog:write','products:write'],
 'offers:read':['catalog:read','offers:read'],
 'offers:write':['catalog:write','offers:write'],
 'materials:read':['catalog:read','assets:read'],
 'materials:write':['catalog:write','assets:write'],
 'flows:read':['catalog:read','workflows:read'],
 'flows:write':['workflows:write','workflows:draft'],
 'sellers:read':['catalog:read'],
 'sellers:write':['workflows:write'],
 'numbers:read':['channels:read','sales:read'],
 'numbers:write':['channels:manage','channels:capacity','channels:capacity:agent'],
 'numbers:connect':['channels:manage'],
 'assignments:read':['channels:read','assignments:read'],
 'assignments:write':['channels:manage','assignments:write','assignments:authorize'],
 'warmup:read':['sales:read','warmup:read'],
 'warmup:write':['channels:manage','warmup:manage','warmup:activate'],
 'conversations:read':['sales:read'],
 'conversations:write':['sales:operate','sales:propose'],
 'orders:read':['sales:read'],
 'orders:write':['sales:operate'],
 'receipts:read':['sales:read'],
 'receipts:review':['finance:review'],
 'payments:write':['finance:classify','finance:reconcile'],
 'remarketing:read':['sales:read'],
 'remarketing:write':['sales:operate'],
 'campaigns:read':['reports:read'],
 'results:read':['reports:read'],
 'home:read':['reports:read'],
 'usage:read':['reports:read'],
 'operations:read':['commands:read'],
 'tests:read':['workflows:read'],
 'tests:run':['simulations:run','workflows:write'],
};
for(const values of Object.values(pairs))Object.freeze(values);Object.freeze(pairs);
const actionSchema=z.object({workspaceId:profileIdSchema,scope:profileScopeSchema,mutation:z.boolean(),interactiveOnly:z.boolean().optional()}).strict();
const identitySchema=z.object({user:z.object({id:profileIdSchema,name:z.string().max(1024),email:z.string().max(320)}).strict(),environment:z.enum(['REAL','SIMULATION']),credential:z.discriminatedUnion('kind',[
 z.object({kind:z.literal('session')}).strict(),
 z.object({kind:z.literal('personal_token'),tokenId:z.uuid()}).strict(),
]),legacyPermissions:z.array(z.string().min(1).max(80)).max(8).refine(v=>new Set(v).size===v.length)}).strict();
export type ProfilePrincipalIdentity=z.infer<typeof identitySchema>;
export type ProfileBoundPrincipal=Principal&{readonly profile_action:Readonly<ProfileAction>;readonly profile_environment:'REAL'|'SIMULATION'};
function fail(code:string):never{throw Object.assign(new Error(code),{code,statusCode:403});}

/** Call inside withProfileRequest's callback, after native identity resolution.
 * No caller-provided role, profile selector, bearer or platform token is accepted.
 * This value is scoped to one already-authorized route/transaction only. */
export function profileLegacyPrincipal(authority:ProfileAuthority,action:ProfileAction,identity:ProfilePrincipalIdentity,now=new Date()):ProfileBoundPrincipal{
 const current=actionSchema.parse(action),native=identitySchema.parse(identity);
 authorizeProfileAction(authority,current,now);
 if(native.credential.kind!==authority.credential.kind||native.user.id!==authority.membership.userId)fail('PROFILE_PRINCIPAL_IDENTITY_MISMATCH');
 const allowed=pairs[current.scope]??[];
 if(native.legacyPermissions.some(alias=>!allowed.includes(alias)))fail('PROFILE_LEGACY_PERMISSION_UNMAPPED');
 const principal:ProfileBoundPrincipal={user:{...native.user},workspace_id:authority.profile.id,role:authority.membership.role,permissions:[current.scope,...native.legacyPermissions],service:false,scopes:[current.scope],authentication_method:native.credential.kind==='session'?'session':'personal_access_token',token_expires_at:authority.credential.expiresAt,allowed_environments:[native.environment],resource_ids:null,profile_action:{...current},profile_environment:native.environment,
  ...(native.credential.kind==='personal_token'?{token_id:native.credential.tokenId,idempotency_actor:'personal:'+native.credential.tokenId}:{})};
 Object.freeze(principal.user);Object.freeze(principal.permissions);Object.freeze(principal.scopes);Object.freeze(principal.allowed_environments);Object.freeze(principal.profile_action);
 return Object.freeze(principal);
}
