import {createCipheriv,createDecipheriv,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {withProfileTransaction,type ProfileExecutor,type ProfilePool} from '../../db/src/profile-context.js';
import {currentProfileExecutor} from '../../db/src/profile-query-routing.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../domain/src/core/profile-authorization.js';
import {quote as priceQuote,measuredCost,validateModel} from './catalog.js';
import {AiError,requireAi,integer,profileId,type AdmissionPort,type CredentialPort,type Model,type Outcome,type Provider,type Quote,type RequestIdentity,type Scope} from './contracts.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const canonical=(v:unknown):string=>JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])):value);
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const iso=(v:unknown)=>new Date(v instanceof Date?v.getTime():String(v)).toISOString();
function amount(v:unknown):number{const n=typeof v==='string'?Number(v):v;requireAi(integer(n),'USAGE_INVALID');return n;}
function validateScope(s:Scope){requireAi(s.workspaceId===s.profileId&&profileId(s.workspaceId)&&uuid.test(s.attemptId)&&['REAL','SIMULATION'].includes(s.environment)&&/^[a-z][a-z0-9._-]{0,63}$/.test(s.task)&&(s.task==='credential.verify'?s.variantId==='credential-verification'&&s.conversationId===undefined:uuid.test(s.variantId)&&(!s.conversationId||uuid.test(s.conversationId))),'AUTHORITY');}
function requestValid(r:RequestIdentity){requireAi(r&&Object.keys(r).length===3&&/^[a-f0-9]{64}$/.test(r.sha256)&&integer(r.bytes)&&r.bytes>0&&r.bytes<=8388608&&['chat','vision','audio'].includes(r.capability),'AUTHORITY');}
function bound(a:any,s:Scope){requireAi(a&&a.workspace_id===s.workspaceId&&a.environment===s.environment&&a.attempt_id===s.attemptId&&(a.variant_id??'credential-verification')===s.variantId&&(a.conversation_id??undefined)===s.conversationId&&a.task===s.task,'AUTHORITY');}
function identity(a:any,r:RequestIdentity){requireAi(a.request_sha256===r.sha256&&a.request_bytes===r.bytes&&a.capability===r.capability,'AUTHORITY');}
export function modelFromRow(p:any,now:number):Model{
 requireAi(p,'CONFIGURATION');const m:Model=p.model_document;validateModel(m,now);
 requireAi(m.provider===p.provider&&m.model===p.model&&m.revision===p.model_revision&&m.price.version===p.price_version
  &&iso(m.price.validFrom)===iso(p.valid_from)&&iso(m.price.validUntil)===iso(p.valid_until)
  &&m.inputTokenCeiling===p.input_ceiling&&m.outputTokenCeiling===p.output_ceiling
  &&m.price.input===amount(p.input_rate)&&m.price.output===amount(p.output_rate)&&m.price.cacheRead===amount(p.cache_read_rate)&&m.price.cacheWrite===amount(p.cache_write_rate)&&m.price.audioInput===amount(p.audio_input_rate),'CONFIGURATION');return structuredClone(m);
}
const priceSql='SELECT * FROM ai_model_prices WHERE provider=$1 AND model=$2 AND model_revision=$3 AND price_version=$4';
const priceValues=(q:Quote)=>[q.provider,q.model,q.modelRevision,q.priceVersion];
async function now(db:ProfileExecutor){return new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();}

export interface CredentialBinding {workspaceId:string;environment:Scope['environment'];provider:Provider;credentialId:string;revision:number}
interface Ciphertext {version:1;iv:string;tag:string;ciphertext:string}
function aad(binding:CredentialBinding){requireAi(profileId(binding.workspaceId)&&uuid.test(binding.credentialId)&&integer(binding.revision)&&binding.revision>0&&['REAL','SIMULATION'].includes(binding.environment)&&['openai','anthropic','google'].includes(binding.provider),'CREDENTIAL_SCOPE');return Buffer.from(canonical({purpose:'commerce.ai.credential.v1',...binding}));}
export function encryptAiCredential(binding:CredentialBinding,value:string,key:Uint8Array):Ciphertext{
 requireAi(key.length===32&&typeof value==='string'&&/^[\x21-\x7e]{1,8192}$/.test(value),'CREDENTIAL_SCOPE');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(binding));const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return{version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')};
}
function decryptAiCredential(binding:CredentialBinding,value:Ciphertext,key:Uint8Array):string{
 try{requireAi(key.length===32&&value&&Object.keys(value).length===4&&value.version===1&&typeof value.ciphertext==='string'&&value.ciphertext.length<=10924,'CREDENTIAL_SCOPE');
  const decode=(s:string,n?:number)=>{requireAi(typeof s==='string'&&/^[A-Za-z0-9+/]*={0,2}$/.test(s),'CREDENTIAL_SCOPE');const b=Buffer.from(s,'base64');requireAi(b.toString('base64')===s&&(n===undefined||b.length===n),'CREDENTIAL_SCOPE');return b;};
  const cipher=createDecipheriv('aes-256-gcm',key,decode(value.iv,12));cipher.setAAD(aad(binding));cipher.setAuthTag(decode(value.tag,16));const raw=Buffer.concat([cipher.update(decode(value.ciphertext)),cipher.final()]);try{const result=new TextDecoder('utf8',{fatal:true}).decode(raw);requireAi(/^[\x21-\x7e]{1,8192}$/.test(result),'CREDENTIAL_SCOPE');return result;}finally{raw.fill(0);}
 }catch{throw new AiError('CREDENTIAL_SCOPE');}
}

/** Constructed only by trusted API/worker composition. Its pool has the dedicated
 * commerce_ai role; every call owns a new COMMIT-confirmed profile transaction.
 * Never invoke a provider while an outer profile transaction is active. */
export class PostgresAiPorts implements AdmissionPort,CredentialPort {
 private readonly encryptionKey:Uint8Array;
 constructor(private readonly pool:ProfilePool,private readonly grantId:string,encryptionKey:Uint8Array){requireAi(uuid.test(grantId)&&encryptionKey.length===32,'CONFIGURATION');this.encryptionKey=new Uint8Array(encryptionKey);}
 private tx<T>(scope:Scope,work:(db:ProfileExecutor)=>Promise<T>):Promise<T>{validateScope(scope);requireAi(!currentProfileExecutor(),'AUTHORITY');return withProfileTransaction(this.pool,scope.workspaceId,work);}
 async reserve(scope:Scope,q:Quote,request:RequestIdentity){requestValid(request);return this.tx(scope,async db=>{
  await db.query('SELECT ai_scope_lock($1,$2)',[scope.workspaceId,scope.environment]);
  const denial=(await db.query('SELECT * FROM ai_admission_denials WHERE workspace_id=$1 AND environment=$2 AND attempt_id=$3',[scope.workspaceId,scope.environment,scope.attemptId])).rows[0];if(denial){bound(denial,scope);requireAi(denial.grant_id===this.grantId&&denial.request_sha256===request.sha256,'AUTHORITY');}
  const existing=(await db.query('SELECT * FROM ai_attempts WHERE workspace_id=$1 AND environment=$2 AND attempt_id=$3 FOR UPDATE',[scope.workspaceId,scope.environment,scope.attemptId])).rows[0];
  if(existing){bound(existing,scope);identity(existing,request);const original=(await db.query(priceSql,[existing.provider,existing.model,existing.model_revision,existing.price_version])).rows[0];requireAi(original,'CONFIGURATION');const originalTime=Date.parse(iso(original.valid_from));const originalModel=modelFromRow(original,originalTime);requireAi(existing.grant_id===this.grantId&&same(q,priceQuote(scope.profileId,originalModel,amount(existing.reserved_microusd),originalTime)),'AUTHORITY');return{effect:'ALREADY_ATTEMPTED' as const,reservationId:scope.attemptId};}
  const model=modelFromRow((await db.query(priceSql,priceValues(q))).rows[0],await now(db));requireAi(same(q,priceQuote(scope.profileId,model,q.maximumMicrousd,await now(db)))&&model.capabilities.includes(request.capability),'AUTHORITY');
  const row=(await db.query(`SELECT g.*,k.revision AS credential_revision FROM ai_runtime_grants g JOIN ai_credentials k ON (k.workspace_id,k.environment,k.id)=(g.workspace_id,g.environment,g.credential_id) WHERE g.workspace_id=$1 AND g.environment=$2 AND g.id=$3`,[scope.workspaceId,scope.environment,this.grantId])).rows[0];requireAi(row,'AUTHORITY');
  await db.query(`INSERT INTO ai_attempts(attempt_id,workspace_id,environment,variant_id,conversation_id,task,is_test,grant_id,grant_version,credential_id,credential_revision,provider,model,model_revision,price_version,request_sha256,request_bytes,capability,reserved_microusd,charged_microusd,state,authorized_until)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19,'RESERVED',clock_timestamp()+interval '60 seconds')`,
  [scope.attemptId,scope.workspaceId,scope.environment,scope.task==='credential.verify'?null:scope.variantId,scope.conversationId??null,scope.task,scope.task==='credential.verify',this.grantId,row.version,row.credential_id,row.credential_revision,q.provider,q.model,q.modelRevision,q.priceVersion,request.sha256,request.bytes,request.capability,q.maximumMicrousd]);
  return{effect:'SEND_ONCE' as const,reservationId:scope.attemptId};
 }).catch(async(error:unknown)=>{
  const causes:Record<string,string>={AI_PROFILE_INACTIVE:'PROFILE_INACTIVE',AI_GRANT_OWNER_CHANGED:'OWNER_CHANGED',AI_CREDENTIAL_UNAVAILABLE:'KEY_UNAVAILABLE',AI_GRANT_CHANGED:'GRANT_CHANGED',AI_AUTHORITY_EXPIRED:'AUTHORITY_EXPIRED',AI_AUTHORITY_WINDOW_REQUIRED:'AUTHORITY_EXPIRED',AI_BUDGET_EXCEEDED:'BUDGET_EXCEEDED',AI_BUDGET_COVERAGE_REQUIRED:'BUDGET_UNCONFIGURED'};
  const cause=error instanceof Error?causes[error.message]:undefined;
  if(cause)await this.tx(scope,async db=>{await db.query('SELECT ai_scope_lock($1,$2)',[scope.workspaceId,scope.environment]);
   const grant=(await db.query('SELECT * FROM ai_runtime_grants WHERE workspace_id=$1 AND environment=$2 AND id=$3',[scope.workspaceId,scope.environment,this.grantId])).rows[0];requireAi(grant&&(grant.variant_id??'credential-verification')===scope.variantId&&grant.task===scope.task,'AUTHORITY');
   await db.query('INSERT INTO ai_admission_denials(workspace_id,environment,attempt_id,grant_id,variant_id,conversation_id,task,request_sha256,cause) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',[scope.workspaceId,scope.environment,scope.attemptId,this.grantId,scope.task==='credential.verify'?null:scope.variantId,scope.conversationId??null,scope.task,request.sha256,cause]);});
  throw error;
 });}
 async acquire(scope:Scope,provider:Provider){return this.tx(scope,async db=>{
  const row=(await db.query(`SELECT a.*,k.enabled,k.state AS key_state,k.revision AS current_revision,v.ciphertext FROM ai_attempts a JOIN ai_credentials k ON (k.workspace_id,k.environment,k.id)=(a.workspace_id,a.environment,a.credential_id) JOIN ai_credential_versions v ON (v.workspace_id,v.environment,v.credential_id,v.revision)=(a.workspace_id,a.environment,a.credential_id,a.credential_revision) WHERE a.workspace_id=$1 AND a.environment=$2 AND a.attempt_id=$3`,[scope.workspaceId,scope.environment,scope.attemptId])).rows[0];
  bound(row,scope);requireAi(row.grant_id===this.grantId&&row.provider===provider&&row.state==='RESERVED'&&row.enabled&&row.current_revision===row.credential_revision&&(row.is_test||row.key_state==='VERIFIED')&&Date.parse(iso(row.authorized_until))>await now(db),'CREDENTIAL_SCOPE');
  return{workspaceId:scope.workspaceId,profileId:scope.profileId,environment:scope.environment,provider,version:row.credential_revision,key:decryptAiCredential({workspaceId:scope.workspaceId,environment:scope.environment,provider,credentialId:row.credential_id,revision:row.credential_revision},row.ciphertext,this.encryptionKey)};
 });}
 async beforeSend(scope:Scope,q:Quote,reservationId:string,binding:{request:RequestIdentity;credentialVersion:number}){requireAi(reservationId===scope.attemptId,'AUTHORITY');requestValid(binding.request);return this.tx(scope,async db=>{
  const a=(await db.query('SELECT * FROM ai_attempts WHERE workspace_id=$1 AND environment=$2 AND attempt_id=$3 FOR UPDATE',[scope.workspaceId,scope.environment,scope.attemptId])).rows[0];bound(a,scope);identity(a,binding.request);requireAi(a.grant_id===this.grantId&&a.state==='RESERVED'&&a.credential_revision===binding.credentialVersion,'AUTHORITY');
  const model=modelFromRow((await db.query(priceSql,priceValues(q))).rows[0],await now(db));requireAi(same(q,priceQuote(scope.profileId,model,q.maximumMicrousd,await now(db)))&&same([a.provider,a.model,a.model_revision,a.price_version,amount(a.reserved_microusd)],[q.provider,q.model,q.modelRevision,q.priceVersion,q.maximumMicrousd]),'AUTHORITY');
  const changed=await db.query("UPDATE ai_attempts SET state='INTENT' WHERE workspace_id=$1 AND environment=$2 AND attempt_id=$3 AND state='RESERVED' RETURNING attempt_id",[scope.workspaceId,scope.environment,scope.attemptId]);requireAi(changed.rowCount===1,'AUTHORITY');
 });}
 async record(scope:Scope,reservationId:string,outcome:Outcome){requireAi(reservationId===scope.attemptId,'AUTHORITY');return this.tx(scope,async db=>{
  const a=(await db.query('SELECT * FROM ai_attempts WHERE workspace_id=$1 AND environment=$2 AND attempt_id=$3 FOR UPDATE',[scope.workspaceId,scope.environment,scope.attemptId])).rows[0];bound(a,scope);requireAi(a.grant_id===this.grantId&&outcome.priceVersion===a.price_version,'AUTHORITY');
  const p=(await db.query(priceSql,[a.provider,a.model,a.model_revision,a.price_version])).rows[0];requireAi(p,'CONFIGURATION');
  // The immutable price applies to measured usage even after its admission expiry.
  const model=modelFromRow(p,Date.parse(iso(p.valid_from)));const usage=outcome.usage;
  const measured=usage?measuredCost(model,usage):null;requireAi((measured===null?outcome.costMicrousd===undefined:outcome.costMicrousd===measured),'USAGE_INVALID');
  const charged=outcome.state==='SUCCEEDED'?measured:Math.max(amount(a.charged_microusd),measured??0);requireAi(charged!==null,'USAGE_INVALID');
  const values=[outcome.state,'code'in outcome?outcome.code:null,charged,measured,usage?.input??null,usage?.output??null,usage?.cacheRead??null,usage?.cacheWrite??null,usage?.audioInput??null];
  if(!['RESERVED','INTENT'].includes(a.state)){requireAi(same([a.state,a.code,amount(a.charged_microusd),a.measured_cost_microusd===null?null:amount(a.measured_cost_microusd),...['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','audio_input_tokens'].map(k=>a[k]===null?null:amount(a[k]))],values),'AUTHORITY');return;}
  await db.query(`UPDATE ai_attempts SET state=$4,code=$5,charged_microusd=$6,measured_cost_microusd=$7,input_tokens=$8,output_tokens=$9,cache_read_tokens=$10,cache_write_tokens=$11,audio_input_tokens=$12 WHERE workspace_id=$1 AND environment=$2 AND attempt_id=$3`,[scope.workspaceId,scope.environment,scope.attemptId,...values]);
 });}
}

/** Call only from withProfileSessionTransaction(integrations:write). The secret
 * enters encrypted storage, never the returned operation result. No model call. */
export async function storeAiCredential(db:ProfileExecutor,authority:ProfileAuthority,input:{operationId:string;environment:Scope['environment'];provider:Provider;expectedRevision:number;key:string},encryptionKey:Uint8Array){
 authorizeProfileAction(authority,{scope:'integrations:write',workspaceId:db.workspaceId,mutation:true,interactiveOnly:true},new Date(await now(db)));
 requireAi(encryptionKey.length===32&&typeof input.key==='string'&&/^[\x21-\x7e]{1,8192}$/.test(input.key)&&uuid.test(input.operationId)&&integer(input.expectedRevision)&&['openai','anthropic','google'].includes(input.provider)&&['REAL','SIMULATION'].includes(input.environment),'CONFIGURATION');await db.query('SELECT ai_scope_lock($1,$2)',[db.workspaceId,input.environment]);
 const digest=createHmac('sha256',encryptionKey).update(canonical({purpose:'commerce.ai.key-operation.v1',workspaceId:db.workspaceId,...input})).digest('hex');
 const prior=(await db.query('SELECT request_sha256,result FROM ai_credential_operations WHERE workspace_id=$1 AND environment=$2 AND actor_id=$3 AND operation_id=$4',[db.workspaceId,input.environment,authority.membership.userId,input.operationId])).rows[0];if(prior){requireAi(prior.request_sha256===digest,'AUTHORITY');return prior.result as {credentialId:string;revision:number;state:'UNVERIFIED';verificationRequired:true;verificationAttemptId:string};}
 const existing=(await db.query('SELECT * FROM ai_credentials WHERE workspace_id=$1 AND environment=$2 AND provider=$3',[db.workspaceId,input.environment,input.provider])).rows[0];requireAi((existing?.revision??0)===input.expectedRevision,'AUTHORITY');
 const id=existing?.id??randomUUID(),revision=input.expectedRevision+1;const ciphertext=encryptAiCredential({workspaceId:db.workspaceId,environment:input.environment,provider:input.provider,credentialId:id,revision},input.key,encryptionKey);
 if(!existing)await db.query('INSERT INTO ai_credentials(id,workspace_id,environment,provider,revision) VALUES($1,$2,$3,$4,1)',[id,db.workspaceId,input.environment,input.provider]);
 await db.query('INSERT INTO ai_credential_versions(workspace_id,environment,credential_id,revision,verification_attempt,ciphertext) VALUES($1,$2,$3,$4,$5,$6)',[db.workspaceId,input.environment,id,revision,input.operationId,ciphertext]);
 if(existing)await db.query("UPDATE ai_credentials SET revision=$4,state='UNVERIFIED',verified_attempt=NULL,enabled=true,updated_at=clock_timestamp() WHERE workspace_id=$1 AND environment=$2 AND id=$3",[db.workspaceId,input.environment,id,revision]);
 const result={credentialId:id,revision,state:'UNVERIFIED' as const,verificationRequired:true as const,verificationAttemptId:input.operationId};await db.query('INSERT INTO ai_credential_operations(workspace_id,environment,actor_id,operation_id,request_sha256,result) VALUES($1,$2,$3,$4,$5,$6)',[db.workspaceId,input.environment,authority.membership.userId,input.operationId,digest,result]);return result;
}
