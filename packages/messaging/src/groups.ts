import {ProviderError, type ProviderGroup} from './types.js';
import {canonicalIdentity} from './security.js';
/** Only explicit provider mappings resolve LID. Equal digits are never evidence. */
export function parseGroup(id:string,detail:Record<string,any>,participants:unknown,security:Record<string,any>,runtime:{version:string;engine:string}):ProviderGroup {
 if(!/^[\d-]+@g\.us$/.test(id)||!Array.isArray(participants)||participants.length<1||participants.length>1024||typeof security.adminOnly!=='boolean')throw new ProviderError('GROUP_RESPONSE_INCOMPLETE');
 const members=participants.map(p=>{
  if(!p||typeof p.id!=='string'||!['participant','admin','superadmin'].includes(p.role))throw new ProviderError('GROUP_MEMBER_UNRESOLVED');
  const identity=canonicalIdentity(p.id),phone=typeof p.phoneNumber==='string'?canonicalIdentity(p.phoneNumber):null;
  const resolved=identity.startsWith('wa:')?identity:identity.startsWith('lid:')&&phone?.startsWith('wa:')?phone:null;
  return{identity,verifiedIdentity:resolved,admin:p.role==='admin'||p.role==='superadmin',mappingSource:resolved===identity?'provider_identity':resolved?'provider_explicit_mapping':'unresolved'};
 });
 if(new Set(members.map(p=>p.identity)).size!==members.length)throw new ProviderError('GROUP_DUPLICATE_MEMBERS');
 return{id,name:String(detail.subject??detail.name??'Grupo propio').slice(0,100),members,adminOnly:security.adminOnly,observedAt:new Date().toISOString(),runtime,complete:true};
}
