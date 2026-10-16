import {hkdfSync,randomUUID} from 'node:crypto';
import type {ProfileExecutor,ProfilePool} from '../../db/src/profile-context.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../domain/src/core/profile-authorization.js';
import {AnthropicAdapter,GoogleAdapter,OpenAIAdapter,type ProviderAdapter} from './client.js';
import {configureAiGrant} from './configuration.js';
import {AiError,requireAi,type Provider,type Scope} from './contracts.js';
import {modelFromRow,PostgresAiPorts,storeAiCredential} from './persistence.js';
import {quote} from './catalog.js';
import {invokeCredentialVerification} from './verification.js';

/** V7 F2 profile AI integration (RF-13/RF-14.b, RNF-04.a). Each business saves
 * its own keys; a key is usable only after one fixed minimal verification
 * request succeeds with that key. Secrets never leave encrypted storage. */
export const aiProviderIds=['openai','anthropic','google'] as const satisfies readonly Provider[];
type Environment=Scope['environment'];
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_LIMIT=100_000_000_000,MIN_LIMIT=1_000_000;

/** Dedicated subkey derived from the installation data key (custody unchanged). */
export function aiCredentialKey(secret=process.env.PRIVATE_DATA_KEY??process.env.DATA_ENCRYPTION_KEY??process.env.ENCRYPTION_KEY):Uint8Array{
 requireAi(typeof secret==='string'&&secret.length>0,'CONFIGURATION');
 const raw=Buffer.from(secret,/^[a-f0-9]{64}$/i.test(secret)?'hex':'base64');requireAi(raw.length===32,'CONFIGURATION');
 return new Uint8Array(hkdfSync('sha256',raw,Buffer.from('commerce-os'),Buffer.from('commerce.ai.credential.v1'),32));
}
async function now(db:ProfileExecutor){return new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now);}
async function authorize(db:ProfileExecutor,authority:ProfileAuthority,mutation:boolean,interactiveOnly=false){
 const moment=await now(db);
 authorizeProfileAction(authority,{scope:mutation?'integrations:write':'integrations:read',workspaceId:db.workspaceId,mutation,interactiveOnly},moment);return moment;
}
function environmentOf(e:unknown):Environment{requireAi(e==='REAL'||e==='SIMULATION','CONFIGURATION');return e;}
function providerOf(p:unknown):Provider{requireAi(typeof p==='string'&&(aiProviderIds as readonly string[]).includes(p),'CONFIGURATION');return p as Provider;}
const iso=(v:unknown)=>v===null||v===undefined?null:new Date(v as string).toISOString();

export type AiKeyState='MISSING'|'UNVERIFIED'|'VERIFYING'|'VERIFIED'|'FAILED'|'DISABLED';
export interface AiProviderStatus {provider:Provider;state:AiKeyState;revision:number;enabled:boolean;hint:string|null;failure:string|null;updatedAt:string|null}
export interface AiIntegrationView {
 environment:Environment;providers:AiProviderStatus[];
 preferences:{version:number;defaultProvider:Provider|null;defaultModel:string|null;monthlyLimitMicrousd:number|null};
 budget:{startsAt:string;endsAt:string;limitMicrousd:number;usedMicrousd:number}|null;
 models:{provider:Provider;model:string;capabilities:string[]}[];
}
async function currentModels(db:ProfileExecutor){
 return(await db.query(`SELECT DISTINCT ON(provider,model) provider,model,model_revision,price_version,model_document,valid_from,valid_until,input_ceiling,output_ceiling,input_rate,output_rate,cache_read_rate,cache_write_rate,audio_input_rate
  FROM ai_model_prices WHERE valid_from<=clock_timestamp() AND valid_until>clock_timestamp()+interval '15 minutes' ORDER BY provider,model,valid_from DESC,price_version DESC`)).rows;
}
async function preferences(db:ProfileExecutor,environment:Environment){
 return(await db.query('SELECT version,default_provider,default_model,monthly_limit_microusd FROM ai_profile_preferences WHERE workspace_id=$1 AND environment=$2',[db.workspaceId,environment])).rows[0] as {version:number;default_provider:Provider|null;default_model:string|null;monthly_limit_microusd:string|null}|undefined;
}
export async function readAiIntegrations(db:ProfileExecutor,authority:ProfileAuthority,environment:Environment):Promise<AiIntegrationView>{
 await authorize(db,authority,false);environment=environmentOf(environment);
 const keys=(await db.query(`SELECT k.provider,k.revision,k.enabled,k.state,k.updated_at,v.key_hint,
   (SELECT a.state FROM ai_attempts a WHERE a.workspace_id=k.workspace_id AND a.environment=k.environment AND a.credential_id=k.id AND a.credential_revision=k.revision AND a.is_test LIMIT 1) AS attempt_state,
   (SELECT a.code FROM ai_attempts a WHERE a.workspace_id=k.workspace_id AND a.environment=k.environment AND a.credential_id=k.id AND a.credential_revision=k.revision AND a.is_test LIMIT 1) AS attempt_code
  FROM ai_credentials k LEFT JOIN ai_credential_versions v ON (v.workspace_id,v.environment,v.credential_id,v.revision)=(k.workspace_id,k.environment,k.id,k.revision)
  WHERE k.workspace_id=$1 AND k.environment=$2`,[db.workspaceId,environment])).rows;
 const providers=aiProviderIds.map((provider):AiProviderStatus=>{
  const k=keys.find(row=>row.provider===provider);
  if(!k)return{provider,state:'MISSING',revision:0,enabled:false,hint:null,failure:null,updatedAt:null};
  const state:AiKeyState=!k.enabled?'DISABLED':k.state==='VERIFIED'?'VERIFIED':['REJECTED','UNCERTAIN'].includes(k.attempt_state)?'FAILED':['RESERVED','INTENT'].includes(k.attempt_state)?'VERIFYING':'UNVERIFIED';
  return{provider,state,revision:k.revision,enabled:k.enabled,hint:k.key_hint?'••••'+k.key_hint:null,failure:state==='FAILED'?String(k.attempt_code??'UNKNOWN'):null,updatedAt:iso(k.updated_at)};
 });
 const pref=await preferences(db,environment);
 const period=(await db.query(`SELECT p.id,p.starts_at,p.ends_at,p.profile_limit_microusd,
   COALESCE((SELECT sum(a.charged_microusd) FROM ai_attempt_allocations x JOIN ai_attempts a USING(workspace_id,environment,attempt_id) WHERE x.workspace_id=p.workspace_id AND x.environment=p.environment AND x.period_id=p.id),0)::text AS used
  FROM ai_budget_periods p WHERE p.workspace_id=$1 AND p.environment=$2 AND p.starts_at<=clock_timestamp() AND p.ends_at>clock_timestamp()`,[db.workspaceId,environment])).rows[0];
 const models=(await currentModels(db)).filter(m=>Array.isArray(m.model_document?.capabilities)).map(m=>({provider:m.provider as Provider,model:m.model as string,capabilities:[...m.model_document.capabilities] as string[]}));
 return{environment,providers,
  preferences:{version:pref?.version??0,defaultProvider:pref?.default_provider??null,defaultModel:pref?.default_model??null,monthlyLimitMicrousd:pref?.monthly_limit_microusd===null||pref?.monthly_limit_microusd===undefined?null:Number(pref.monthly_limit_microusd)},
  budget:period?{startsAt:iso(period.starts_at)!,endsAt:iso(period.ends_at)!,limitMicrousd:Number(period.profile_limit_microusd),usedMicrousd:Number(period.used)}:null,models};
}

/** Profile preferences: default model (must be in the current reviewed catalog)
 * and the monthly limit. Existing periods are immutable; a new limit opens the
 * next period, never rewrites a running one. */
export async function saveAiPreferences(db:ProfileExecutor,authority:ProfileAuthority,input:{environment:Environment;expectedVersion:number;defaultProvider?:Provider|null;defaultModel?:string|null;monthlyLimitMicrousd?:number|null}){
 await authorize(db,authority,true);const environment=environmentOf(input.environment);
 requireAi(Number.isSafeInteger(input.expectedVersion)&&input.expectedVersion>=0,'CONFIGURATION');
 await db.query('SELECT ai_scope_lock($1,$2)',[db.workspaceId,environment]);
 const prior=await preferences(db,environment);requireAi((prior?.version??0)===input.expectedVersion,'AUTHORITY');
 const provider=input.defaultProvider===undefined?prior?.default_provider??null:input.defaultProvider===null?null:providerOf(input.defaultProvider);
 const model=input.defaultModel===undefined?prior?.default_model??null:input.defaultModel;
 requireAi((provider===null)===(model===null),'CONFIGURATION');
 if(provider&&model&&(input.defaultProvider!==undefined||input.defaultModel!==undefined))requireAi((await currentModels(db)).some(m=>m.provider===provider&&m.model===model),'CONFIGURATION');
 const limit=input.monthlyLimitMicrousd===undefined?(prior?.monthly_limit_microusd===null||prior?.monthly_limit_microusd===undefined?null:Number(prior.monthly_limit_microusd)):input.monthlyLimitMicrousd;
 requireAi(limit===null||(Number.isSafeInteger(limit)&&limit>=MIN_LIMIT&&limit<=MAX_LIMIT),'BUDGET');
 const actor=authority.membership.userId;
 const row=prior?(await db.query('UPDATE ai_profile_preferences SET version=version+1,default_provider=$3,default_model=$4,monthly_limit_microusd=$5,updated_by=$6 WHERE workspace_id=$1 AND environment=$2 AND version=$7 RETURNING version',[db.workspaceId,environment,provider,model,limit,actor,input.expectedVersion])).rows[0]
  :(await db.query('INSERT INTO ai_profile_preferences(workspace_id,environment,version,default_provider,default_model,monthly_limit_microusd,updated_by) VALUES($1,$2,1,$3,$4,$5,$6) RETURNING version',[db.workspaceId,environment,provider,model,limit,actor])).rows[0];
 requireAi(row,'AUTHORITY');
 if(limit!==null)await ensureBudgetPeriods(db,environment,limit);
 return{version:row.version as number,defaultProvider:provider,defaultModel:model,monthlyLimitMicrousd:limit};
}
function monthStart(d:Date,offset=0){return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+offset,1));}
/** Opens the current calendar month (UTC) and, in its last three days, the next
 * one, each with the profile limit; every configured key receives the same
 * per-key limit in each open period. Running periods are never rewritten. */
async function ensureBudgetPeriods(db:ProfileExecutor,environment:Environment,limit:number){
 const moment=await now(db),keys=(await db.query('SELECT id FROM ai_credentials WHERE workspace_id=$1 AND environment=$2 ORDER BY id',[db.workspaceId,environment])).rows.map(r=>r.id as string);
 const months=[0];if(monthStart(moment,1).getTime()-moment.getTime()<3*86400000)months.push(1);
 for(const offset of months){
  const startsAt=monthStart(moment,offset),endsAt=monthStart(moment,offset+1);
  let period=(await db.query('SELECT id,profile_limit_microusd FROM ai_budget_periods WHERE workspace_id=$1 AND environment=$2 AND starts_at<$4 AND ends_at>$3 ORDER BY starts_at LIMIT 1',[db.workspaceId,environment,startsAt,endsAt])).rows[0];
  if(!period){
   const id=randomUUID();
   // A period that started earlier in the month only covers from now on.
   const from=offset===0?new Date(Math.max(startsAt.getTime(),moment.getTime()-60000)):startsAt;
   if(endsAt.getTime()-from.getTime()<86400000)continue;
   await db.query('INSERT INTO ai_budget_periods(id,workspace_id,environment,starts_at,ends_at,profile_limit_microusd) VALUES($1,$2,$3,$4,$5,$6)',[id,db.workspaceId,environment,from,endsAt,limit]);
   period={id,profile_limit_microusd:limit};
  }
  for(const key of keys)await db.query('INSERT INTO ai_key_budgets(workspace_id,environment,period_id,credential_id,limit_microusd) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[db.workspaceId,environment,period.id,key,Number(period.profile_limit_microusd)]);
 }
}

export interface AiVerificationPlan {workspaceId:string;environment:Environment;provider:Provider;grantId:string;attemptId:string;modelRow:Record<string,unknown>}
/** Interactive owner action. Stores the new key revision (UNVERIFIED), makes
 * sure the running month has a budget for it and prepares exactly one
 * verification grant; the network call happens after COMMIT (verifyAiKey). */
export async function saveAiKey(db:ProfileExecutor,authority:ProfileAuthority,input:{operationId:string;environment:Environment;provider:Provider;expectedRevision:number;key:string},encryptionKey:Uint8Array){
 const moment=await authorize(db,authority,true,true);const environment=environmentOf(input.environment),provider=providerOf(input.provider);
 const saved=await storeAiCredential(db,authority,{operationId:input.operationId,environment,provider,expectedRevision:input.expectedRevision,key:input.key},encryptionKey);
 const pref=await preferences(db,environment);
 if(pref?.monthly_limit_microusd)await ensureBudgetPeriods(db,environment,Number(pref.monthly_limit_microusd));
 const candidates=(await currentModels(db)).filter(m=>m.provider===provider&&Array.isArray(m.model_document?.capabilities)&&m.model_document.capabilities.includes('chat'))
  .sort((a,b)=>Number(a.input_rate)*a.input_ceiling+Number(a.output_rate)*a.output_ceiling-(Number(b.input_rate)*b.input_ceiling+Number(b.output_rate)*b.output_ceiling));
 const existing=(await db.query('SELECT id FROM ai_runtime_grants WHERE workspace_id=$1 AND environment=$2 AND credential_id=$3 AND is_test AND revoked_at IS NULL AND expires_at>clock_timestamp()+interval \'2 minutes\' AND task=\'credential.verify\' ORDER BY expires_at DESC LIMIT 1',[db.workspaceId,environment,saved.credentialId])).rows[0];
 const result={provider,credentialId:saved.credentialId,revision:saved.revision,state:'UNVERIFIED' as const};
 if(!candidates.length)return{...result,verification:null,unavailable:'AI_MODEL_CATALOG_REQUIRED' as const};
 if(!pref?.monthly_limit_microusd)return{...result,verification:null,unavailable:'AI_BUDGET_REQUIRED' as const};
 const model=candidates[0]!;let grantId=existing?.id as string|undefined;
 if(!grantId){
  grantId=randomUUID();
  await configureAiGrant(db,authority,{grantId,environment,credentialId:saved.credentialId,variantId:null,task:'credential.verify',isTest:true,provider,model:model.model,modelRevision:model.model_revision,priceVersion:model.price_version,expiresAt:new Date(moment.getTime()+15*60000).toISOString()});
 }
 const plan:AiVerificationPlan={workspaceId:db.workspaceId,environment,provider,grantId,attemptId:saved.verificationAttemptId,modelRow:model};
 return{...result,verification:plan,unavailable:null};
}

export interface AiVerificationRuntime {pool:ProfilePool;key:Uint8Array;fetcher?:typeof fetch;clock?:()=>number;timeoutMs?:number}
const adapters:{[P in Provider]:new(ports:ConstructorParameters<typeof OpenAIAdapter>[0])=>ProviderAdapter}={openai:OpenAIAdapter,anthropic:AnthropicAdapter,google:GoogleAdapter};
/** One fixed minimal request with the saved key; never retried. Must run outside
 * any profile transaction. The database marks the key VERIFIED atomically. */
export async function verifyAiKey(runtime:AiVerificationRuntime,plan:AiVerificationPlan){
 requireAi(uuid.test(plan.grantId)&&uuid.test(plan.attemptId),'CONFIGURATION');
 const clock=runtime.clock??Date.now,model=modelFromRow(plan.modelRow,clock());
 const scope:Scope={workspaceId:plan.workspaceId,profileId:plan.workspaceId,variantId:'credential-verification',attemptId:plan.attemptId,task:'credential.verify',environment:plan.environment};
 const ports=new PostgresAiPorts(runtime.pool,plan.grantId,runtime.key);
 const adapter=new adapters[plan.provider]({credentials:ports,admission:ports,...(runtime.fetcher?{fetcher:runtime.fetcher}:{}),clock});
 const budget=quote(plan.workspaceId,model,Number.MAX_SAFE_INTEGER,clock()).maximumMicrousd;
 try{const outcome=await invokeCredentialVerification(adapter,scope,model,budget,runtime.timeoutMs??15000);return outcome.state==='SUCCEEDED'?{state:'VERIFIED' as const}:{state:'FAILED' as const,code:outcome.code};}
 catch(error){return{state:'FAILED' as const,code:error instanceof AiError?error.code:'AUTHORITY'};}
}

/** Disables or re-enables the current key revision (no secret involved). */
export async function setAiKeyEnabled(db:ProfileExecutor,authority:ProfileAuthority,input:{environment:Environment;provider:Provider;expectedRevision:number;enabled:boolean}){
 await authorize(db,authority,true);const environment=environmentOf(input.environment),provider=providerOf(input.provider);
 requireAi(typeof input.enabled==='boolean'&&Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>0,'CONFIGURATION');
 await db.query('SELECT ai_scope_lock($1,$2)',[db.workspaceId,environment]);
 const row=(await db.query('UPDATE ai_credentials SET enabled=$5,updated_at=clock_timestamp() WHERE workspace_id=$1 AND environment=$2 AND provider=$3 AND revision=$4 RETURNING revision,enabled',[db.workspaceId,environment,provider,input.expectedRevision,input.enabled])).rows[0];
 requireAi(row,'AUTHORITY');return{provider,revision:row.revision as number,enabled:row.enabled as boolean};
}
