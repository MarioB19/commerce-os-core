import {assertGlobalBudgetCapacity} from './global-budget.js';
import {ElevenLabsVoiceRequestSchema} from '../../creative-contracts/src/index.js';
import {z} from 'zod';
import {pool,withTransaction,hash,stableJson,uuid,decrypt,type QueryExecutor} from '../../db/src/index.js';
export interface ProviderScope {workspaceId:string;environment:string;actorId:string}
export interface ProviderOperation {kind:'searchapi.search'|'openai.analyze'|'elevenlabs.voice';request:Record<string,any>;operationKey:string;maxCostUsd?:number;expectedConfigVersion?:number}
export const providerError=(statusCode:number,code:string,message=code)=>Object.assign(new Error(message),{statusCode,code});
const Model='gpt-5.4-mini-2026-03-17';
const searchSchema=z.object({engine:z.literal('meta_ad_library'),q:z.string().min(2).max(250),country:z.enum(['BR','MX']),active_status:z.enum(['active','inactive','all']).default('active'),media_type:z.enum(['all','image','video','meme']).default('all'),limit:z.number().int().min(1).max(50).default(50),page_token:z.string().max(20000).optional(),next_page_token:z.string().max(20000).optional(),content_languages:z.string().max(30).optional()}).strict();
const analysisSchema=z.object({model:z.literal(Model),instructions:z.string().min(1).max(12000),input:z.string().min(1).max(48000),text:z.object({format:z.object({type:z.literal('json_schema'),name:z.string().regex(/^[a-zA-Z0-9_]{1,64}$/),strict:z.literal(true),schema:z.record(z.string(),z.unknown())}).strict()}).strict(),max_output_tokens:z.number().int().min(128).max(3000)}).strict();
const voiceSchema=ElevenLabsVoiceRequestSchema;
export function normalizeOperation(op:ProviderOperation){
 let request:Record<string,any>,provider:string,units:number,estimate:number;
 if(op.kind==='searchapi.search'){request=searchSchema.parse(op.request);provider='searchapi';units=1;estimate=.004;}
 else if(op.kind==='openai.analyze'){request=analysisSchema.parse(op.request);if(Buffer.byteLength(stableJson(request))>80000)throw providerError(400,'PROVIDER_INPUT_TOO_LARGE');provider='openai';units=Buffer.byteLength(request.input+request.instructions)+request.max_output_tokens;estimate=(Buffer.byteLength(stableJson(request))+1024)*.75/1e6+request.max_output_tokens*4.5/1e6;}
 else if(op.kind==='elevenlabs.voice'){request=voiceSchema.parse(op.request);provider='elevenlabs';units=request.text.length;estimate=units*.0003;}
 else throw providerError(400,'PROVIDER_OPERATION_NOT_ALLOWED');
 if(!/^[A-Za-z0-9_:./-]{8,200}$/.test(op.operationKey))throw providerError(400,'OPERATION_KEY_REQUIRED');
 return {request,provider,units,estimate:Math.ceil(estimate*1e6)/1e6};
}
export async function providerConfig(scope:Pick<ProviderScope,'workspaceId'|'environment'>,provider:string,db:QueryExecutor=pool,options:{diagnostic?:boolean}={}){const row=(await db.query('SELECT * FROM creative_settings WHERE workspace_id=$1 AND environment=$2 AND provider=$3',[scope.workspaceId,scope.environment,provider])).rows[0];if(!row||(!row.enabled&&!options.diagnostic)||!row.secret_ciphertext)throw providerError(409,'PROVIDER_NOT_CONFIGURED',`Configura ${provider} y su presupuesto.`);return {...row,secret:JSON.parse(decrypt(row.secret_ciphertext))};}
export async function boundedJson(response:Response,maxBytes:number){const declared=Number(response.headers.get('content-length'));if(declared>maxBytes){await response.body?.cancel();throw providerError(502,'PROVIDER_RESPONSE_TOO_LARGE');}if(!response.body)throw providerError(502,'PROVIDER_EMPTY_RESPONSE');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;for(;;){const{done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes){await reader.cancel();throw providerError(502,'PROVIDER_RESPONSE_TOO_LARGE');}chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
function publicOperation(row:any){return {id:row.id,status:row.status,result:row.result??undefined,estimated_cost:Number(row.estimated_cost),confirmed_cost:row.confirmed_cost===null?undefined:Number(row.confirmed_cost),currency:row.currency,remote_id:row.remote_id??undefined,error_code:row.error_code??undefined};}
/** Public standard tariff applied to acknowledged usage; not a billing invoice. */
export function openAIUsageCost(usage:any){const input=usage?.input_tokens,output=usage?.output_tokens,cached=usage?.input_tokens_details?.cached_tokens??0;if(![input,output,cached].every(x=>Number.isSafeInteger(x)&&x>=0)||cached>input)return null;return{units:input+output,cost:Math.ceil((input-cached)*.75+cached*.075+output*4.5)/1e6};}
/** Reserve and mark RUNNING in a committed transaction before the only external request. */
export async function executeProviderOperation(scope:ProviderScope,op:ProviderOperation,options:{fetch?:typeof fetch;diagnostic?:boolean}={}){
 const normalized=normalizeOperation(op);if(op.maxCostUsd!==undefined&&(!Number.isFinite(op.maxCostUsd)||normalized.estimate>op.maxCostUsd))throw providerError(409,'OPERATION_BUDGET_EXCEEDED');const requestHash=hash(stableJson({kind:op.kind,request:normalized.request}));
 const start=await withTransaction(async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`creative-provider:${scope.workspaceId}`]);
  const existing=(await c.query('SELECT * FROM creative_provider_operations WHERE workspace_id=$1 AND environment=$2 AND kind=$3 AND operation_key=$4',[scope.workspaceId,scope.environment,op.kind,op.operationKey])).rows[0];
  if(existing){if(existing.status==='RUNNING'&&Date.parse(existing.started_at)<Date.now()-300000){await c.query("UPDATE creative_provider_operations SET status='UNKNOWN',error_code='PROCESS_INTERRUPTED' WHERE id=$1 AND status='RUNNING'",[existing.id]);existing.status='UNKNOWN';}if(existing.request_hash!==requestHash)throw providerError(409,'PROVIDER_IDEMPOTENCY_CONFLICT');return {row:existing,execute:false};}
  const config=await providerConfig(scope,normalized.provider,c,{diagnostic:options.diagnostic===true&&op.kind==='searchapi.search'});
  if(op.expectedConfigVersion!==undefined&&config.version!==op.expectedConfigVersion)throw providerError(409,'PROVIDER_CONFIG_CHANGED');
  if(op.kind==='openai.analyze'&&!(config.config.models??[Model]).includes(normalized.request.model))throw providerError(403,'MODEL_NOT_ALLOWED');
  if(op.kind==='elevenlabs.voice'&&!(config.config.voice_ids??[]).includes(normalized.request.voice_id))throw providerError(403,'VOICE_NOT_ALLOWED');
  const budget=(await c.query('SELECT * FROM creative_budgets WHERE workspace_id=$1 AND environment=$2 AND provider=$3 AND expires_at>clock_timestamp() FOR UPDATE',[scope.workspaceId,scope.environment,normalized.provider])).rows[0];
  if(!budget)throw providerError(409,'PROVIDER_BUDGET_REQUIRED');
  if(Number(budget.spent_usd)+Number(budget.reserved_usd)+normalized.estimate>Number(budget.limit_usd)||Number(budget.spent_units)+Number(budget.reserved_units)+normalized.units>Number(budget.max_units))throw providerError(409,'PROVIDER_BUDGET_EXCEEDED');
  // Stale RUNNING is ambiguous. Do not release its reservation or retry it.
  await c.query("UPDATE creative_provider_operations SET status='UNKNOWN',error_code='PROCESS_INTERRUPTED' WHERE workspace_id=$1 AND status='RUNNING' AND started_at<now()-interval '5 minutes'",[scope.workspaceId]);
  if((await c.query("SELECT 1 FROM creative_provider_operations WHERE workspace_id=$1 AND status='RUNNING'",[scope.workspaceId])).rowCount)throw providerError(409,'PROVIDER_BUSY');
  await assertGlobalBudgetCapacity(c,scope.workspaceId,normalized.estimate,{requireExplicit:Boolean(normalized.request.purpose)});
  await c.query('UPDATE creative_budgets SET reserved_usd=reserved_usd+$2,reserved_units=reserved_units+$3 WHERE id=$1',[budget.id,normalized.estimate,normalized.units]);
  const row=(await c.query("INSERT INTO creative_provider_operations(id,workspace_id,environment,actor_id,provider,kind,operation_key,request_hash,request,budget_id,status,estimated_cost,units,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'RUNNING',$11,$12,now()) RETURNING *",[uuid(),scope.workspaceId,scope.environment,scope.actorId,normalized.provider,op.kind,op.operationKey,requestHash,normalized.request,budget.id,normalized.estimate,normalized.units])).rows[0];return {row,execute:true,config};
 });
 if(!start.execute)return publicOperation(start.row);
 const row=start.row,config=start.config!,send=options.fetch??fetch;let result:any,remoteId:string|null=null,confirmedCost:number|null=null,confirmedUnits:number|null=null;
 try{
  let url:string,body:any,headers:Record<string,string>,method:string;
  if(op.kind==='searchapi.search'){
   const {limit:_,page_token,next_page_token,...params}=normalized.request;
   url='https://www.searchapi.io/api/v1/search';method='POST';body={...params,...((page_token??next_page_token)?{next_page_token:page_token??next_page_token}:{})};headers={Authorization:`Bearer ${config.secret.api_key}`,'Content-Type':'application/json'};
  }else if(op.kind==='openai.analyze'){
   url='https://api.openai.com/v1/responses';method='POST';body={...normalized.request,service_tier:'default',store:true,metadata:{commerce_operation_id:row.id}};headers={Authorization:`Bearer ${config.secret.api_key}`,'Content-Type':'application/json'};
  }else{
   url=`https://api.elevenlabs.io/v1/text-to-speech/${normalized.request.voice_id}/with-timestamps?output_format=mp3_44100_128`;method='POST';body={text:normalized.request.text,model_id:normalized.request.model_id,...(normalized.request.voice_settings?{voice_settings:normalized.request.voice_settings}:{})};headers={'xi-api-key':config.secret.api_key,'Content-Type':'application/json'};
  }
  const response=await send(url,{method,headers,body:JSON.stringify(body),signal:AbortSignal.timeout(90000),redirect:'error'});
  remoteId=response.headers.get('request-id')??response.headers.get('x-request-id');
  if(remoteId)await pool.query('UPDATE creative_provider_operations SET remote_id=$2 WHERE id=$1',[row.id,remoteId]);
  // Explicit authentication/input refusal is safe to settle with no generation. 429/5xx remains UNKNOWN.
  if([400,401,403,404,422].includes(response.status)){await response.body?.cancel();await settle(row,'FAILED',null,0,0,remoteId,`PROVIDER_HTTP_${response.status}`);return publicOperation({...row,status:'FAILED',result:null,confirmed_cost:0,error_code:`PROVIDER_HTTP_${response.status}`});}
  if(!response.ok){await response.body?.cancel();throw providerError(502,`PROVIDER_HTTP_${response.status}`);}
  result=await boundedJson(response,op.kind==='elevenlabs.voice'?(normalized.request.purpose==='whatsapp'?8:4)*1024*1024:3*1024*1024);
  remoteId=result.id??result.search_metadata?.id??remoteId;
  if(op.kind==='searchapi.search'){if(options.diagnostic&&(typeof result.search_metadata?.id!=='string'||!Array.isArray(result.ads)))throw providerError(502,'PROVIDER_DIAGNOSTIC_RESPONSE_INVALID');confirmedCost=null;confirmedUnits=1;}
  else if(op.kind==='openai.analyze'){
   const usage=openAIUsageCost(result.usage);if(usage){confirmedUnits=usage.units;confirmedCost=usage.cost;}
  }else{
   // Keep the bounded paid response durable independently of storing the audio object.
   const audio=result.audio_base64;if(typeof audio!=='string'||audio.length>(normalized.request.purpose==='whatsapp'?6:2)*1024*1024)throw providerError(502,'VOICE_AUDIO_TOO_LARGE');
   const times=result.normalized_alignment??result.alignment;const duration=Math.max(...(times?.character_end_times_seconds??[Infinity]));
   if(!Number.isFinite(duration)||duration>normalized.request.max_duration_seconds+.5)throw providerError(502,'VOICE_DURATION_EXCEEDED');
   confirmedUnits=Number(response.headers.get('character-cost')??normalized.units);confirmedCost=null;
  }
  await settle(row,'CONFIRMED',result,confirmedCost,confirmedUnits,remoteId,null,config.version);
  return publicOperation({...row,status:'CONFIRMED',result,confirmed_cost:confirmedCost,remote_id:remoteId});
 }catch(error:any){await pool.query("UPDATE creative_provider_operations SET status='UNKNOWN',remote_id=COALESCE($2,remote_id),error_code=$3,finished_at=now() WHERE id=$1 AND status='RUNNING'",[row.id,remoteId,/^[A-Z0-9_]+$/.test(error.code??'')?error.code:'PROVIDER_RESULT_UNKNOWN']);return publicOperation({...row,status:'UNKNOWN',result:null,remote_id:remoteId,error_code:'PROVIDER_RESULT_UNKNOWN'});}
}
async function settle(row:any,status:string,result:any,cost:number|null,units:number|null,remoteId:string|null,error:string|null,verifiedConfigVersion?:number){await withTransaction(async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`creative-provider:${row.workspace_id}`]);const locked=(await c.query('SELECT status FROM creative_provider_operations WHERE id=$1 FOR UPDATE',[row.id])).rows[0];if(!['RUNNING','UNKNOWN'].includes(locked.status))return;
 await c.query('UPDATE creative_provider_operations SET status=$2,result=$3,confirmed_cost=$4,confirmed_units=$5,remote_id=$6,error_code=$7,finished_at=now() WHERE id=$1',[row.id,status,result,cost,units,remoteId,error]);
 if(status==='CONFIRMED'&&verifiedConfigVersion!==undefined)await c.query('UPDATE creative_settings SET verified_at=now(),verified_operation_id=$4 WHERE workspace_id=$1 AND environment=$2 AND provider=$3 AND version=$5',[row.workspace_id,row.environment,row.provider,row.id,verifiedConfigVersion]);
 // An acknowledged result with missing usage keeps its conservative reservation pending reconciliation.
 if(cost!==null)await c.query('UPDATE creative_budgets SET reserved_usd=reserved_usd-$2,spent_usd=spent_usd+$3 WHERE id=$1',[row.budget_id,row.estimated_cost,cost]);if(units!==null)await c.query('UPDATE creative_budgets SET reserved_units=reserved_units-$2,spent_units=spent_units+$3 WHERE id=$1',[row.budget_id,row.units,units]);
});}
export async function recoverOpenAI(scope:ProviderScope,id:string){const row=(await pool.query("SELECT * FROM creative_provider_operations WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND kind='openai.analyze'",[id,scope.workspaceId,scope.environment])).rows[0];if(!row||row.status!=='UNKNOWN'||!row.remote_id)throw providerError(409,'PROVIDER_RECOVERY_ID_REQUIRED');const cfg=await providerConfig(scope,'openai');const r=await fetch(`https://api.openai.com/v1/responses/${encodeURIComponent(row.remote_id)}`,{headers:{Authorization:`Bearer ${cfg.secret.api_key}`},signal:AbortSignal.timeout(30000),redirect:'error'});if(!r.ok)throw providerError(409,'PROVIDER_RECOVERY_UNAVAILABLE');const result=await boundedJson(r,3*1024*1024);if(result.status!=='completed'||!result.usage)throw providerError(409,'PROVIDER_RECOVERY_PENDING');const usage=openAIUsageCost(result.usage);if(!usage)throw providerError(409,'PROVIDER_USAGE_UNAVAILABLE');await settle(row,'CONFIRMED',result,usage.cost,usage.units,row.remote_id,null);return{id,status:'CONFIRMED'};}
