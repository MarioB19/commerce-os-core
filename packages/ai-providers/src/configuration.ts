import {modelFromRow} from './persistence.js';
import {credentialVerificationIdentity} from './verification.js';
import type {ProfileExecutor} from '../../db/src/profile-context.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../domain/src/core/profile-authorization.js';
import {requireAi,integer,type Scope,type Provider} from './contracts.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const environment=(e:string)=>requireAi(['REAL','SIMULATION'].includes(e),'CONFIGURATION');
const iso=(s:string)=>{requireAi(typeof s==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString()===s,'CONFIGURATION');return s;};
const amount=(n:number)=>requireAi(integer(n)&&n>0,'BUDGET');
async function authorize(db:ProfileExecutor,authority:ProfileAuthority,mutation:boolean){
 const now=new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now);
 authorizeProfileAction(authority,{scope:mutation?'integrations:write':'integrations:read',workspaceId:db.workspaceId,mutation,interactiveOnly:mutation},now);return now;
}
/** Must run inside the current F2 authority transaction. Periods are explicit,
 * nonoverlapping and immutable; a new key/revision never resets their history. */
export async function configureAiBudget(db:ProfileExecutor,authority:ProfileAuthority,input:{periodId:string;environment:Scope['environment'];startsAt:string;endsAt:string;profileLimitMicrousd:number;keyLimits:readonly {credentialId:string;limitMicrousd:number}[]}){
 await authorize(db,authority,true);environment(input.environment);requireAi(uuid.test(input.periodId),'CONFIGURATION');iso(input.startsAt);iso(input.endsAt);amount(input.profileLimitMicrousd);
 requireAi(Array.isArray(input.keyLimits)&&input.keyLimits.length>0&&input.keyLimits.length<=3&&new Set(input.keyLimits.map(x=>x.credentialId)).size===input.keyLimits.length,'CONFIGURATION');
 for(const limit of input.keyLimits){requireAi(uuid.test(limit.credentialId),'CONFIGURATION');amount(limit.limitMicrousd);}
 const limits=input.keyLimits.map(x=>({...x})).sort((a,b)=>a.credentialId.localeCompare(b.credentialId));
 await db.query('SELECT ai_scope_lock($1,$2)',[db.workspaceId,input.environment]);
 const prior=(await db.query('SELECT * FROM ai_budget_periods WHERE workspace_id=$1 AND environment=$2 AND id=$3',[db.workspaceId,input.environment,input.periodId])).rows[0];
 if(prior){const saved=(await db.query('SELECT credential_id,limit_microusd FROM ai_key_budgets WHERE workspace_id=$1 AND environment=$2 AND period_id=$3 ORDER BY credential_id',[db.workspaceId,input.environment,input.periodId])).rows;
  requireAi(new Date(prior.starts_at).toISOString()===input.startsAt&&new Date(prior.ends_at).toISOString()===input.endsAt&&Number(prior.profile_limit_microusd)===input.profileLimitMicrousd&&saved.length===limits.length&&saved.every((x,i)=>x.credential_id===limits[i].credentialId&&Number(x.limit_microusd)===limits[i].limitMicrousd),'AUTHORITY');return {periodId:input.periodId,effect:'EXISTING_MATCH' as const};}
 await db.query('INSERT INTO ai_budget_periods(id,workspace_id,environment,starts_at,ends_at,profile_limit_microusd) VALUES($1,$2,$3,$4,$5,$6)',[input.periodId,db.workspaceId,input.environment,input.startsAt,input.endsAt,input.profileLimitMicrousd]);
 for(const limit of limits)await db.query('INSERT INTO ai_key_budgets(workspace_id,environment,period_id,credential_id,limit_microusd) VALUES($1,$2,$3,$4,$5)',[db.workspaceId,input.environment,input.periodId,limit.credentialId,limit.limitMicrousd]);
 return {periodId:input.periodId,effect:'CREATED' as const};
}
export interface AiGrantRequest {grantId:string;environment:Scope['environment'];credentialId:string;variantId:string|null;task:string;isTest:boolean;provider:Provider;model:string;modelRevision:string;priceVersion:string;expiresAt:string}
/** Selects only a price/model already installed in the protected catalogue. */
export async function configureAiGrant(db:ProfileExecutor,authority:ProfileAuthority,input:AiGrantRequest){
 const moment=await authorize(db,authority,true);environment(input.environment);iso(input.expiresAt);
 requireAi(uuid.test(input.grantId)&&uuid.test(input.credentialId)&&['openai','anthropic','google'].includes(input.provider)&&/^[a-z][a-z0-9._-]{0,63}$/.test(input.task)&&typeof input.isTest==='boolean'&&(input.isTest?input.variantId===null&&input.task==='credential.verify':typeof input.variantId==='string'&&uuid.test(input.variantId)&&input.task!=='credential.verify'),'CONFIGURATION');
 for(const field of [input.model,input.modelRevision,input.priceVersion])requireAi(typeof field==='string'&&field.length>0&&field.length<=128,'CONFIGURATION');
 await db.query('SELECT ai_scope_lock($1,$2)',[db.workspaceId,input.environment]);
 const modelRow=(await db.query('SELECT * FROM ai_model_prices WHERE provider=$1 AND model=$2 AND model_revision=$3 AND price_version=$4',[input.provider,input.model,input.modelRevision,input.priceVersion])).rows[0];const identity=input.isTest?credentialVerificationIdentity(modelFromRow(modelRow,moment.getTime())):null;
 const fields=[input.credentialId,input.variantId,input.task,input.isTest,identity?.sha256??null,identity?.bytes??null,input.provider,input.model,input.modelRevision,input.priceVersion,input.expiresAt,authority.membership.userId,authority.membership.version];
 const prior=(await db.query('SELECT * FROM ai_runtime_grants WHERE workspace_id=$1 AND environment=$2 AND id=$3',[db.workspaceId,input.environment,input.grantId])).rows[0];
 if(prior){requireAi(prior.version===1&&prior.revoked_at===null&&JSON.stringify([prior.credential_id,prior.variant_id,prior.task,prior.is_test,prior.test_request_sha256,prior.test_request_bytes,prior.provider,prior.model,prior.model_revision,prior.price_version,new Date(prior.expires_at).toISOString(),prior.actor_id,prior.actor_membership_version])===JSON.stringify(fields),'AUTHORITY');return {grantId:input.grantId,version:1,effect:'EXISTING_MATCH' as const};}
 requireAi(Date.parse(input.expiresAt)>moment.getTime()+60000,'AUTHORITY');
 await db.query('INSERT INTO ai_runtime_grants(id,workspace_id,environment,credential_id,variant_id,task,is_test,test_request_sha256,test_request_bytes,provider,model,model_revision,price_version,expires_at,actor_id,actor_membership_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',[input.grantId,db.workspaceId,input.environment,...fields]);
 return {grantId:input.grantId,version:1,effect:'CREATED' as const};
}
export async function revokeAiGrant(db:ProfileExecutor,authority:ProfileAuthority,input:{grantId:string;environment:Scope['environment'];expectedVersion:number}){
 await authorize(db,authority,true);environment(input.environment);requireAi(uuid.test(input.grantId)&&integer(input.expectedVersion)&&input.expectedVersion>0,'CONFIGURATION');
 await db.query('SELECT ai_scope_lock($1,$2)',[db.workspaceId,input.environment]);
 const result=await db.query('UPDATE ai_runtime_grants SET version=version+1,revoked_at=clock_timestamp() WHERE workspace_id=$1 AND environment=$2 AND id=$3 AND version=$4 AND revoked_at IS NULL RETURNING id,version,revoked_at',[db.workspaceId,input.environment,input.grantId,input.expectedVersion]);requireAi(result.rowCount===1,'AUTHORITY');
 return {grantId:result.rows[0].id as string,version:result.rows[0].version as number,revokedAt:new Date(result.rows[0].revoked_at).toISOString()};
}
export async function readAiCredentialOperation(db:ProfileExecutor,authority:ProfileAuthority,input:{operationId:string;environment:Scope['environment']}){
 await authorize(db,authority,false);environment(input.environment);requireAi(uuid.test(input.operationId),'CONFIGURATION');
 const result=await db.query('SELECT result FROM ai_credential_operations WHERE workspace_id=$1 AND environment=$2 AND actor_id=$3 AND operation_id=$4',[db.workspaceId,input.environment,authority.membership.userId,input.operationId]);return result.rows[0]?.result??null;
}
export async function readAiAttempt(db:ProfileExecutor,authority:ProfileAuthority,input:{attemptId:string;environment:Scope['environment']}){
 await authorize(db,authority,false);environment(input.environment);requireAi(uuid.test(input.attemptId),'CONFIGURATION');
 const result=await db.query('SELECT attempt_id,variant_id,conversation_id,task,is_test,provider,model,model_revision,price_version,state,code,reserved_microusd,charged_microusd,measured_cost_microusd,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,audio_input_tokens,created_at,intent_at,settled_at FROM ai_attempts WHERE workspace_id=$1 AND environment=$2 AND attempt_id=$3',[db.workspaceId,input.environment,input.attemptId]);return result.rows[0]??null;
}

export type AiDependencyCause='PROFILE_INACTIVE'|'OWNER_CHANGED'|'KEY_UNAVAILABLE'|'GRANT_CHANGED'|'AUTHORITY_EXPIRED'|'BUDGET_EXCEEDED'|'BUDGET_UNCONFIGURED';
/** A current dependency observation, never a send permission or a pause mutation.
 * An existing attempt always needs its original reconciliation path. */
export async function readAiDependency(db:ProfileExecutor,authority:ProfileAuthority,input:{environment:Scope['environment'];grantId:string;attemptId:string}){
 await authorize(db,authority,false);environment(input.environment);requireAi(uuid.test(input.grantId)&&uuid.test(input.attemptId),'CONFIGURATION');
 await db.query('SELECT ai_scope_lock($1,$2)',[db.workspaceId,input.environment]);
 const attempt=(await db.query('SELECT grant_id,state,code FROM ai_attempts WHERE workspace_id=$1 AND environment=$2 AND attempt_id=$3',[db.workspaceId,input.environment,input.attemptId])).rows[0];
 if(attempt){requireAi(attempt.grant_id===input.grantId,'AUTHORITY');return{state:'ATTEMPT_ALREADY_DURABLE' as const,attemptState:attempt.state as string,cause:attempt.code as string|null,resume:'RECONCILE_ONLY' as const,humanRequired:attempt.state!=='SUCCEEDED',clearHumanPause:false as const};}
 const denied=(await db.query('SELECT cause,grant_id FROM ai_admission_denials WHERE workspace_id=$1 AND environment=$2 AND attempt_id=$3',[db.workspaceId,input.environment,input.attemptId])).rows[0];if(denied)requireAi(denied.grant_id===input.grantId,'AUTHORITY');
 const row=(await db.query(`SELECT g.*,k.enabled,k.state AS key_state,p.state AS profile_state,m.active AS owner_active,m.role AS owner_role,m.version AS owner_version,price.valid_from,price.valid_until,
  ceil((price.input_ceiling::numeric*greatest(price.input_rate,price.cache_read_rate,price.cache_write_rate,price.audio_input_rate)+price.output_ceiling::numeric*price.output_rate)/1000000)::text AS maximum
  FROM ai_runtime_grants g JOIN ai_credentials k ON(k.workspace_id,k.environment,k.id)=(g.workspace_id,g.environment,g.credential_id)
  JOIN profiles p ON p.id=g.workspace_id LEFT JOIN memberships m ON m.workspace_id=g.workspace_id AND m.user_id=g.actor_id
  JOIN ai_model_prices price ON(price.provider,price.model,price.model_revision,price.price_version)=(g.provider,g.model,g.model_revision,g.price_version)
  WHERE g.workspace_id=$1 AND g.environment=$2 AND g.id=$3`,[db.workspaceId,input.environment,input.grantId])).rows[0];
 const current=new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime(),end=current+60000;
 let cause:AiDependencyCause|null=null;
 if(!row||row.revoked_at)cause='GRANT_CHANGED';else if(row.profile_state!=='ACTIVE')cause='PROFILE_INACTIVE';
 else if(!row.owner_active||row.owner_role!=='owner'||row.owner_version!==row.actor_membership_version)cause='OWNER_CHANGED';
 else if(!row.enabled||!row.is_test&&row.key_state!=='VERIFIED')cause='KEY_UNAVAILABLE';
 else if(new Date(row.valid_from).getTime()>current||new Date(row.valid_until).getTime()<end||new Date(row.expires_at).getTime()<end)cause='AUTHORITY_EXPIRED';
 else {
  const maximum=BigInt(row.maximum);const periods=(await db.query(`SELECT b.id,b.starts_at,b.ends_at,b.profile_limit_microusd,k.limit_microusd,
   coalesce((SELECT sum(a.charged_microusd) FROM ai_attempt_allocations x JOIN ai_attempts a USING(workspace_id,environment,attempt_id) WHERE x.workspace_id=b.workspace_id AND x.environment=b.environment AND x.period_id=b.id),0)::text AS profile_used,
   coalesce((SELECT sum(a.charged_microusd) FROM ai_attempt_allocations x JOIN ai_attempts a USING(workspace_id,environment,attempt_id) WHERE x.workspace_id=b.workspace_id AND x.environment=b.environment AND x.period_id=b.id AND x.credential_id=$3),0)::text AS key_used
   FROM ai_budget_periods b LEFT JOIN ai_key_budgets k ON(k.workspace_id,k.environment,k.period_id)=(b.workspace_id,b.environment,b.id) AND k.credential_id=$3
   WHERE b.workspace_id=$1 AND b.environment=$2 AND b.starts_at<$5 AND b.ends_at>$4 ORDER BY b.starts_at`,[db.workspaceId,input.environment,row.credential_id,new Date(current).toISOString(),new Date(end).toISOString()])).rows;
  let covered=current;
  for(const period of periods){if(new Date(period.starts_at).getTime()>covered||period.limit_microusd===null){cause='BUDGET_UNCONFIGURED';break;}if(maximum+BigInt(period.profile_used)>BigInt(period.profile_limit_microusd)||maximum+BigInt(period.key_used)>BigInt(period.limit_microusd)){cause='BUDGET_EXCEEDED';break;}covered=Math.max(covered,new Date(period.ends_at).getTime());}
  if(!cause&&covered<end)cause='BUDGET_UNCONFIGURED';
 }
 return {state:cause?'HUMAN_REQUIRED' as const:denied?'DEPENDENCY_RECOVERED' as const:'NO_DEPENDENCY_BLOCK' as const,cause,previousCause:denied?.cause as AiDependencyCause|undefined??null,resume:'NEW_ADMISSION_REQUIRED' as const,humanRequired:cause!==null,clearHumanPause:false as const};
}
