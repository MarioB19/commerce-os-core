import {activeAt,channelIdentityHash,type CommercialAssignment} from '../../../packages/db/src/commercial-assignments.js';
import type {Body,DomainRecord} from '../../../packages/contracts/src/index.js';

/** Readiness of one commercial assignment to sell under an explicit operation
 * authorization (V5 R4 projection still shown in the owner launch status). */
export function projectAssignmentAuthorization(input:{setup:Body;assignment:CommercialAssignment;account:DomainRecord;authorization:Body|null;usage:number;now?:Date}){
 const now=input.now??new Date(),authorization=input.authorization,scope=authorization?.scope??{},blockers:string[]=[];
 for(const check of input.setup.checks??[])if(!check.ok)blockers.push(`SETUP_${String(check.key??'UNKNOWN').toUpperCase()}`);
 if(!activeAt(input.assignment,now.toISOString()))blockers.push('ASSIGNMENT_NOT_CURRENT');
 if(input.setup.sending_enabled!==true)blockers.push('ACCOUNT_NOT_ACTIVATED');
 if(!authorization)blockers.push('EXPLICIT_AUTHORIZATION_REQUIRED');
 else{
  if(authorization.revoked_at)blockers.push('AUTHORIZATION_REVOKED');
  if(!authorization.expires_at||Date.parse(authorization.expires_at)<=now.getTime())blockers.push('AUTHORIZATION_EXPIRED');
  if(authorization.configuration_version!==input.setup.configuration_version)blockers.push('CONFIGURATION_CHANGED');
  if(scope.mode!=='product_assignment'||scope.assignment_id!==input.assignment.id||scope.assignment_revision!==input.assignment.revision||scope.binding_id!==input.assignment.binding_id||scope.product_id!==input.assignment.product_id)blockers.push('AUTHORIZATION_SCOPE_CHANGED');
  if(!Array.isArray(scope.account_ids)||!scope.account_ids.includes(input.account.id)||scope.channel_identity_hash!==channelIdentityHash(input.account))blockers.push('CHANNEL_IDENTITY_CHANGED');
  if(!Number.isInteger(scope.max_messages)||scope.max_messages<1||input.usage>=scope.max_messages)blockers.push('AUTHORIZATION_LIMIT_REACHED');
 }
 return{ready:blockers.length===0,blockers:[...new Set(blockers)]};
}
