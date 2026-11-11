import {ProviderError, type ProviderGroup} from './types.js';
import {canonicalIdentity} from './security.js';
const GROUP_ID=/^[\d-]+@g\.us$/;
const text=(...values:unknown[])=>values.find((v):v is string=>typeof v==='string'&&v.length>0);
/** One value per concept: a response that states the same fact twice with
 * different values is contradictory and is rejected, never guessed. */
function single(code:string,...values:unknown[]){
 const present=values.filter(v=>v!==undefined&&v!==null&&v!=='');
 if(new Set(present.map(v=>typeof v==='string'?v:JSON.stringify(v))).size>1)throw new ProviderError(code);
 return present[0];
}
/** Group id and display name of a list or detail row. WAHA NOWEB/WEBJS answer
 * `id` + `subject|name`; WAHA GOWS (2026.8) answers `JID` + `Name`. */
export function parseGroupRow(row:unknown):{id:string;name:string}{
 if(!row||typeof row!=='object'||Array.isArray(row))throw new ProviderError('GROUP_LIST_RESPONSE_UNSUPPORTED');
 const g=row as Record<string,unknown>,id=single('GROUP_LIST_RESPONSE_UNSUPPORTED',typeof g.id==='object'&&g.id?(g.id as Record<string,unknown>)._serialized:g.id,g.JID);
 if(typeof id!=='string'||!GROUP_ID.test(id))throw new ProviderError('GROUP_LIST_RESPONSE_UNSUPPORTED');
 return{id,name:String(text(g.subject,g.name,g.Name)??'Grupo').slice(0,100)};
}
export function parseGroupList(value:unknown,limit:number):{id:string;name:string}[]{
 if(!value||typeof value!=='object')throw new ProviderError('GROUP_LIST_RESPONSE_UNSUPPORTED');
 const rows=Array.isArray(value)?value:Object.values(value as Record<string,unknown>);
 if(rows.length>limit)throw new ProviderError('GROUP_LIST_RESPONSE_UNSUPPORTED');
 const groups=rows.map(parseGroupRow);
 if(new Set(groups.map(g=>g.id)).size!==groups.length)throw new ProviderError('GROUP_LIST_RESPONSE_UNSUPPORTED');
 return groups;
}
/** Only explicit provider mappings resolve LID. Equal digits are never evidence.
 * A member the provider cannot map to a phone keeps its opaque provider
 * identity: it can be an external participant, never one of our own lines. */
export function parseGroup(id:string,detail:Record<string,any>,participants:unknown,security:Record<string,any>,runtime:{version:string;engine:string}):ProviderGroup {
 if(!GROUP_ID.test(id)||!detail||typeof detail!=='object'||!Array.isArray(participants)||participants.length<1||participants.length>1024||!security||typeof security!=='object')throw new ProviderError('GROUP_RESPONSE_INCOMPLETE');
 // Unknown permission is never read as "everyone may write".
 const adminOnly=single('GROUP_PERMISSION_RESPONSE_UNSUPPORTED',security.adminOnly,security.adminsOnly);
 if(typeof adminOnly!=='boolean')throw new ProviderError('GROUP_PERMISSION_RESPONSE_UNSUPPORTED');
 const described=single('GROUP_RESPONSE_MISMATCH',typeof detail.id==='object'&&detail.id?detail.id._serialized:detail.id,detail.JID);
 if(described!==undefined&&described!==id)throw new ProviderError('GROUP_RESPONSE_MISMATCH');
 const members=participants.map(p=>{
  if(!p||typeof p!=='object'||typeof p.id!=='string'||!['participant','admin','superadmin'].includes(p.role))throw new ProviderError('GROUP_MEMBER_UNRESOLVED');
  const mapped=single('GROUP_MEMBER_IDENTITY_CONFLICT',p.phoneNumber,p.pn);
  if(mapped!==undefined&&typeof mapped!=='string')throw new ProviderError('GROUP_MEMBER_UNRESOLVED');
  const identity=canonicalIdentity(p.id),phone=typeof mapped==='string'?canonicalIdentity(mapped):null;
  if(identity.startsWith('opaque:'))throw new ProviderError('GROUP_MEMBER_UNRESOLVED');
  if(identity.startsWith('wa:')&&phone?.startsWith('wa:')&&phone!==identity)throw new ProviderError('GROUP_MEMBER_IDENTITY_CONFLICT');
  const resolved=identity.startsWith('wa:')?identity:identity.startsWith('lid:')&&phone?.startsWith('wa:')?phone:null;
  return{identity,verifiedIdentity:resolved,admin:p.role==='admin'||p.role==='superadmin',mappingSource:resolved===identity?'provider_identity':resolved?'provider_explicit_mapping':'unresolved'};
 });
 if(new Set(members.map(p=>p.identity)).size!==members.length)throw new ProviderError('GROUP_DUPLICATE_MEMBERS');
 const verified=members.map(p=>p.verifiedIdentity).filter((v):v is string=>!!v);
 if(new Set(verified).size!==verified.length)throw new ProviderError('GROUP_MEMBER_IDENTITY_CONFLICT');
 return{id,name:String(text(detail.subject,detail.name,detail.Name)??'Grupo').slice(0,100),members,adminOnly,observedAt:new Date().toISOString(),runtime,complete:true};
}
