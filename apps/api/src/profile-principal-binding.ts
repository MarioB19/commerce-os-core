import type {FastifyRequest} from 'fastify';
import type {ProfileRequestContext} from './profile-request.js';
import type {ProfileExecutor} from '../../../packages/db/src/profile-context.js';
import {currentProfileExecutor,joinProfileQueryWork} from '../../../packages/db/src/profile-query-routing.js';
import {profileLegacyPrincipal} from '../../../packages/domain/src/core/profile-legacy-principal.js';
import {authorizeProfileAction,type ProfileAction,type ProfileAuthority} from '../../../packages/domain/src/core/profile-authorization.js';
import type {Principal} from '../../../packages/domain/src/core/permissions.js';

type Action=Omit<ProfileAction,'workspaceId'>;
interface Binding {principal:Principal;executor:ProfileExecutor;authority:ProfileAuthority;active:boolean}
const bindings=new WeakMap<FastifyRequest,Binding>();
function deny():never{throw Object.assign(new Error('PROFILE_PRINCIPAL_BOUNDARY_REQUIRED'),{code:'PROFILE_PRINCIPAL_BOUNDARY_REQUIRED',statusCode:403});}
/** Only a server-created binding in the same live transaction can replace the
 * legacy PAT check. Fields on Principal or on the request never confer this.
 */
export function profilePrincipalAuthority(req:FastifyRequest,principal:Principal,executor?:ProfileExecutor):boolean{
 const binding=bindings.get(req),live=currentProfileExecutor();
 if(!binding){if(live)return deny();return false;}
 if(!binding.active||live!==binding.executor||principal!==binding.principal||(executor&&executor!==binding.executor))return deny();
 return true;
}

/** A server-fixed secondary action inside a materialized handler. The same
 * native locks and outer final authority check protect it; no alias is added.
 * A failed check poisons the transaction even if the handler catches it.
 */
export async function authorizeBoundProfileAction(req:FastifyRequest,action:Action):Promise<void>{
 const binding=bindings.get(req);
 if(!binding||!binding.active||currentProfileExecutor()!==binding.executor)return deny();
 await joinProfileQueryWork(binding.executor,async()=>authorizeProfileAction(binding.authority,{...action,workspaceId:binding.executor.workspaceId}));
}

/** Construct once per route with only its reviewed compatibility aliases. The
 * callback is invoked inside withProfileRequest + withProfileQueryRouting.
 */
export function profilePrincipalBinder(registry:WeakMap<FastifyRequest,Principal>,permissions:readonly string[]){
 const aliases=Object.freeze([...permissions]);
 return(req:FastifyRequest,context:ProfileRequestContext,action:Action):(()=>void)=>{
  if(registry.has(req)||bindings.has(req)||currentProfileExecutor(context.db.workspaceId)!==context.db)return deny();
  const profile=context.profile,authority=profile.authority;
  if(profile.profile.id!==context.db.workspaceId||authority.profile.id!==context.db.workspaceId)return deny();
  const credential=authority.credential.kind==='session'&&'selection'in profile
   ?{kind:'session' as const}
   :authority.credential.kind==='personal_token'&&'tokenId'in profile&&profile.environment===context.environment
    ?{kind:'personal_token' as const,tokenId:profile.tokenId}:deny();
  const principal=profileLegacyPrincipal(authority,{...action,workspaceId:context.db.workspaceId},{
   // Display identity is resolved by account endpoints. Business authorization
   // and idempotency use only the locked native membership's user ID here.
   user:{id:authority.membership.userId,name:'',email:''},environment:context.environment,credential,legacyPermissions:[...aliases],
  });
  const binding:Binding={principal,executor:context.db,authority,active:true};
  registry.set(req,principal);bindings.set(req,binding);
  return()=>{binding.active=false;registry.delete(req);};
 };
}
