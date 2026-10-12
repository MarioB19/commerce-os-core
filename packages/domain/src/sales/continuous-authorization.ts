import {continuousAuthorizationSchema,continuousHumanCommandSchema,assertProtectionSchema,clearProtectionSchema,
 type ContinuousAuthorization,type ContinuousHumanCommand,type AssertProtection,type ClearProtection,type ProtectionReason} from '../../../contracts/src/continuous-authorization.js';
import {authorizeProfileAction,type ProfileAuthority} from '../core/profile-authorization.js';

export class ContinuityError extends Error{
 constructor(readonly code:string){super(code);this.name='ContinuityError';}
}
function need(value:unknown,code:string):asserts value{if(!value)throw new ContinuityError(code);}
function moment(now:Date):string{need(Number.isFinite(now.getTime()),'CONTINUITY_CLOCK_REQUIRED');return now.toISOString();}
function scoped(state:ContinuousAuthorization,workspaceId:string):ContinuousAuthorization{
 const value=continuousAuthorizationSchema.parse(state);
 need(value.workspaceId===workspaceId,'CONTINUITY_PROFILE_MISMATCH');return value;
}
function fence(state:ContinuousAuthorization,expected:number){
 need(state.version===expected,'CONTINUITY_VERSION_CONFLICT');
 need(state.version<Number.MAX_SAFE_INTEGER,'CONTINUITY_VERSION_EXHAUSTED');
}
export interface ContinuityEvent{
 operationId:string;authorizationId:string;workspaceId:string;accountId:string;environment:'REAL'|'SIMULATION';
 version:number;at:string;type:'HUMAN_PAUSED'|'HUMAN_RESUMED'|'REVOKED'|'PROTECTION_ASSERTED'|'PROTECTION_CLEARED';
 actorId:string|null;reason:ProtectionReason|null;incidentId:string|null;evidenceSha256:string|null;
}
export interface ContinuityTransition{state:ContinuousAuthorization;event:ContinuityEvent|null}
function change(state:ContinuousAuthorization,patch:Partial<ContinuousAuthorization>,event:Omit<ContinuityEvent,
 'authorizationId'|'workspaceId'|'accountId'|'environment'|'version'>):ContinuityTransition{
 const next=continuousAuthorizationSchema.parse({...state,...patch,version:state.version+1});
 return {state:next,event:{...event,authorizationId:state.id,workspaceId:state.workspaceId,accountId:state.accountId,
  environment:state.environment,version:next.version}};
}

/** Human authority comes from the locked profile transaction. Deployment and
 * worker identities cannot enter this adapter or manufacture a human pause.
 */
export function continuousHumanTransition(state:ContinuousAuthorization,input:ContinuousHumanCommand,authority:ProfileAuthority,now:Date):ContinuityTransition{
 const s=scoped(state,authority.profile.id),command=continuousHumanCommandSchema.parse(input),at=moment(now);
 authorizeProfileAction(authority,{scope:s.source.kind==='COMMERCIAL_ASSIGNMENT'?'assignments:write':'warmup:write',
  workspaceId:s.workspaceId,mutation:true},now);
 need(Date.parse(at)>=Date.parse(s.createdAt),'CONTINUITY_CLOCK_REVERSED');fence(s,command.expectedVersion);
 if(command.action==='revoke'&&s.revokedAt)return {state:s,event:null};
 need(!s.revokedAt,'CONTINUITY_REVOKED');
 if(command.action!=='revoke'&&s.humanPaused===(command.action==='pause'))return {state:s,event:null};
 return change(s,command.action==='revoke'?{revokedAt:at}:{humanPaused:command.action==='pause'},
  {operationId:command.operationId,at,type:command.action==='pause'?'HUMAN_PAUSED':command.action==='resume'?'HUMAN_RESUMED':'REVOKED',
   actorId:authority.membership.userId,reason:null,incidentId:null,evidenceSha256:null});
}

/** Only authenticated internal observations reach these two functions. Their
 * inputs are deliberately separate from the public human command schema.
 * Persistence must hold the profile transaction and compare the same version.
 */
export function assertContinuousProtection(state:ContinuousAuthorization,input:AssertProtection,workspaceId:string,now:Date):ContinuityTransition{
 const s=scoped(state,workspaceId),command=assertProtectionSchema.parse(input),at=moment(now);fence(s,command.expectedVersion);
 need(!s.revokedAt,'CONTINUITY_REVOKED');
 need(Date.parse(command.observedAt)>=Date.parse(s.createdAt)&&Date.parse(command.observedAt)<=Date.parse(at),'CONTINUITY_OBSERVATION_TIME_INVALID');
 const old=s.protections.find(item=>item.reason===command.reason);
 const protection={reason:command.reason,incidentId:command.incidentId,observedAt:command.observedAt,evidenceSha256:command.evidenceSha256};
 if(old&&old.incidentId===command.incidentId){
  need(old.observedAt===command.observedAt&&old.evidenceSha256===command.evidenceSha256,'CONTINUITY_INCIDENT_REUSED');
  return {state:s,event:null};
 }
 need(!old||Date.parse(command.observedAt)>Date.parse(old.observedAt),'CONTINUITY_OBSERVATION_STALE');
 return change(s,{protections:[...s.protections.filter(item=>item.reason!==command.reason),protection]},
  {operationId:command.operationId,at,type:'PROTECTION_ASSERTED',actorId:null,reason:command.reason,incidentId:command.incidentId,evidenceSha256:command.evidenceSha256});
}
export function clearContinuousProtection(state:ContinuousAuthorization,input:ClearProtection,workspaceId:string,now:Date):ContinuityTransition{
 const s=scoped(state,workspaceId),command=clearProtectionSchema.parse(input),at=moment(now);fence(s,command.expectedVersion);
 need(!s.revokedAt,'CONTINUITY_REVOKED');
 const old=s.protections.find(item=>item.reason===command.reason);
 need(old&&old.incidentId===command.incidentId,'CONTINUITY_INCIDENT_CHANGED');
 need(Date.parse(command.observedAt)>Date.parse(old.observedAt)&&Date.parse(command.observedAt)<=Date.parse(at),'CONTINUITY_OBSERVATION_STALE');
 need(command.reason!=='SEND_UNCERTAIN'||command.recovery==='EFFECT_RECONCILED','CONTINUITY_EFFECT_RECONCILIATION_REQUIRED');
 return change(s,{protections:s.protections.filter(item=>item.reason!==command.reason)},
  {operationId:command.operationId,at,type:'PROTECTION_CLEARED',actorId:null,reason:command.reason,incidentId:command.incidentId,evidenceSha256:command.evidenceSha256});
}

export interface ContinuousEligibility{
 workspaceId:string;environment:'REAL'|'SIMULATION';accountId:string;
 profileActive:boolean;accountActive:boolean;channelConnected:boolean;identityMatches:boolean;quotaAvailable:boolean;
 aiAvailable:boolean;ownsEmissionLease:boolean;recipientOptedOut:boolean;
 assignment:{id:string;revision:number;bindingId:string}|null;
 recipient:{kind:'NEW_INBOUND';consented:boolean;insideAllowedWindow:boolean}|{kind:'NO_PEER'}|{
  kind:'OWN_NUMBER';workspaceId:string;environment:'REAL'|'SIMULATION';accountId:string;accountActive:boolean;
  connected:boolean;humanPaused:boolean;optedOut:boolean;authorization:ContinuousAuthorization|null};
}
export type ContinuityDecision={eligible:boolean;state:'READY'|'REVOKED'|'PAUSED'|'PROTECTED'|'WAITING_PEER';reasons:readonly string[]};
/** Shared final decision. This is a gate, not an effect or ownership proof.
 * The worker must acquire/fence its lease and re-read fresh provider/consent/
 * quota facts at the actual emission boundary. No release or wall-clock lease
 * renewal is part of the permanent authorization itself.
 */
export function continuousEligibility(state:ContinuousAuthorization,facts:ContinuousEligibility):ContinuityDecision{
 const s=scoped(state,facts.workspaceId);
 need(s.environment===facts.environment&&s.accountId===facts.accountId,'CONTINUITY_RESOURCE_MISMATCH');
 if(s.revokedAt)return {eligible:false,state:'REVOKED',reasons:['AUTHORIZATION_REVOKED']};
 if(s.humanPaused)return {eligible:false,state:'PAUSED',reasons:['HUMAN_PAUSE']};
 const reasons:string[]=s.protections.map(item=>item.reason);
 const conditions:Array<[boolean,string]>=[[facts.profileActive,'PROFILE_SUSPENDED'],[facts.accountActive,'ACCOUNT_RETIRED'],[facts.channelConnected,'CHANNEL_DOWN'],
  [facts.identityMatches,'IDENTITY_CHANGED'],[facts.quotaAvailable,'QUOTA_EXHAUSTED'],[facts.aiAvailable,'AI_UNAVAILABLE'],
  [facts.ownsEmissionLease,'EMISSION_OWNERSHIP_REQUIRED'],[facts.recipientOptedOut===false,'RECIPIENT_OPTED_OUT']];
 for(const[allowed,reason]of conditions)if(allowed!==true)reasons.push(reason);
 if(s.source.kind==='COMMERCIAL_ASSIGNMENT'){
  if(facts.assignment?.id!==s.source.assignmentId||facts.assignment.revision!==s.source.assignmentRevision||facts.assignment.bindingId!==s.source.bindingId)
   reasons.push('COMMERCIAL_ASSIGNMENT_CHANGED');
  if(facts.recipient.kind!=='NEW_INBOUND')reasons.push('COMMERCIAL_RECIPIENT_NOT_AUTHORIZED');
  else if(facts.recipient.consented!==true||facts.recipient.insideAllowedWindow!==true)reasons.push('INBOUND_CONSENT_WINDOW_REQUIRED');
 }else{
  const peer=facts.recipient;
  if(peer.kind==='NO_PEER'){
   if(!reasons.length)return {eligible:false,state:'WAITING_PEER',reasons:['NO_ELIGIBLE_OWN_PEER']};
   reasons.push('NO_ELIGIBLE_OWN_PEER');
  }else if(peer.kind!=='OWN_NUMBER'||peer.workspaceId!==s.workspaceId||peer.environment!==s.environment||peer.accountId===s.accountId)
   reasons.push('WARMUP_OWN_PROFILE_PEER_REQUIRED');
  else{
   const parsed=continuousAuthorizationSchema.safeParse(peer.authorization),authorization=parsed.success?parsed.data:null;
   if(!authorization||authorization.workspaceId!==s.workspaceId||authorization.environment!==s.environment||authorization.accountId!==peer.accountId
    ||authorization.source.kind!=='VERIFIED_QR_CONNECTION'||authorization.revokedAt||authorization.humanPaused||authorization.protections.length)
    reasons.push('WARMUP_PEER_AUTHORIZATION_REQUIRED');
   if(peer.accountActive!==true||peer.connected!==true||peer.humanPaused!==false||peer.optedOut!==false){
   if(!reasons.length)return {eligible:false,state:'WAITING_PEER',reasons:['NO_ELIGIBLE_OWN_PEER']};
   reasons.push('NO_ELIGIBLE_OWN_PEER');
   }
  }
 }
 return {eligible:reasons.length===0,state:reasons.length?'PROTECTED':'READY',reasons:[...new Set(reasons)]};
}
