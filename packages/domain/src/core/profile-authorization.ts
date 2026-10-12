import {profileRoleScopes,type ProfileRole,type ProfileScope,type ProfileState} from '../../../contracts/src/profiles.js';
export type LegacyMembershipRole='owner'|'operator'|'seller'|'reconciler'|'analyst'|'viewer';
/** D-23 input must come from the locked, current migration inventory, never a default. */
export function migrateProfileRole(role:LegacyMembershipRole,observedSellerOrReconciler:boolean):ProfileRole {
  if(typeof observedSellerOrReconciler!=='boolean')throw new Error('D23_ROLE_INVENTORY_REQUIRED');
  if(role==='owner'||role==='operator')return role;
  if(role==='seller'||role==='reconciler')return observedSellerOrReconciler?'operator':'viewer';
  if(role==='analyst'||role==='viewer')return 'viewer';
  throw new Error('UNKNOWN_MEMBERSHIP_ROLE');
}
export interface ProfileAuthority {
  profile:{id:string;state:ProfileState};
  membership:{userId:string;workspaceId:string;role:ProfileRole;active:boolean;version:number};
  credential:{kind:'session'|'personal_token'|'platform_token';userId:string;workspaceId:string;revoked:boolean;
    expiresAt:string;scopes:readonly ProfileScope[];membershipVersion?:number};
}
export interface ProfileAction {scope:ProfileScope;workspaceId:string;mutation:boolean;interactiveOnly?:boolean}
export class ProfileAuthorizationError extends Error {
  readonly statusCode=403;
  constructor(readonly code:string){super(code);this.name='ProfileAuthorizationError';}
}
function need(condition:unknown,code:string):asserts condition{if(!condition)throw new ProfileAuthorizationError(code);}
export function effectiveProfileScopes(authority:ProfileAuthority,now=new Date()):readonly ProfileScope[]{
  const {profile,membership:m,credential:c}=authority;
  need(c.kind!=='platform_token','PLATFORM_TOKEN_NOT_A_PROFILE_IDENTITY');
  need((c.kind==='session'||c.kind==='personal_token')&&(profile.state==='ACTIVE'||profile.state==='SUSPENDED'),'PROFILE_AUTHORITY_INVALID');
  need(Number.isFinite(now.getTime())&&Number.isFinite(Date.parse(c.expiresAt))&&Date.parse(c.expiresAt)>now.getTime()&&c.revoked===false,'PROFILE_CREDENTIAL_INVALID');
  need(m.active===true&&typeof m.userId==='string'&&m.userId.length>0&&typeof profile.id==='string'&&profile.id.length>0&&m.userId===c.userId&&m.workspaceId===c.workspaceId&&m.workspaceId===profile.id,'PROFILE_MEMBERSHIP_REQUIRED');
  need(Number.isSafeInteger(m.version)&&m.version>0&&Object.hasOwn(profileRoleScopes,m.role),'PROFILE_MEMBERSHIP_INVALID');
  if(c.kind==='session')need(c.membershipVersion===m.version,'PROFILE_SESSION_ACCESS_CHANGED');
  const allowed=profileRoleScopes[m.role];
  return c.kind==='session'?allowed:allowed.filter(scope=>scope!=='profiles:switch'&&c.scopes.includes(scope));
}
export function authorizeProfileAction(authority:ProfileAuthority,action:ProfileAction,now=new Date()):void{
  const scopes=effectiveProfileScopes(authority,now);
  need(action.workspaceId===authority.profile.id,'PROFILE_RESOURCE_SCOPE_MISMATCH');
  need(!(action.interactiveOnly||action.scope==='profiles:switch')||authority.credential.kind==='session','PROFILE_INTERACTIVE_SESSION_REQUIRED');
  const modifiesProfile=action.scope!=='profiles:switch'&&!action.scope.endsWith(':read')&&!action.scope.endsWith(':export');
  need(action.scope==='account:write'||!(action.mutation||modifiesProfile)||authority.profile.state==='ACTIVE','PROFILE_SUSPENDED');
  need(scopes.includes(action.scope),'PROFILE_ACTION_FORBIDDEN');
}
