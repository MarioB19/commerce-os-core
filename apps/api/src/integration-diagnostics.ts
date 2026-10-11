import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {pool,withTransaction,uuid,hash,stableJson,decrypt,type QueryExecutor} from '../../../packages/db/src/index.js';
import {readIntegrationSettings} from '../../../packages/db/src/integration-settings.js';
import {assertGlobalBudgetCapacity} from '../../../packages/provider-broker/src/global-budget.js';
import {boundedJson} from '../../../packages/provider-broker/src/index.js';
import {diagnosticRequest,diagnosticUsage,classifyDiagnosticHttp,validateDiagnosticResponse} from '../../../packages/domain/src/core/integration-diagnostic.js';
import {principal,envOf,parseBody,fail,assertResource,audit,sanitize,idempotencyActor} from './context.js';

export function integrationPermission(req:FastifyRequest,scope:'read'|'write'|'verify',key?:string){const p=principal(req);if(p.service){if(!p.scopes.includes(`integrations:${scope}`))throw fail(403,'INTEGRATION_SCOPE_REQUIRED');if(key)assertResource(p,key);}else if(p.role!=='owner')throw fail(403,'OWNER_REQUIRED');return p;}
async function profile(req:FastifyRequest,key:string,c:QueryExecutor=pool,secret=false){
 const p=principal(req),environment=envOf(req);
 if(key==='intelligence:openai'){
  const r=(await c.query("SELECT * FROM creative_settings WHERE workspace_id=$1 AND environment=$2 AND provider='openai'",[p.workspace_id,environment])).rows[0];
  return {key,label:'Inteligencia · OpenAI',version:r?.version??0,enabled:r?.enabled??false,model:r?.config?.models?.[0]??'',secret_configured:Boolean(r?.secret_ciphertext),api_key:secret&&r?.secret_ciphertext?JSON.parse(decrypt(r.secret_ciphertext)).api_key:undefined,input_rate:.75,output_rate:4.5,updated_at:r?.updated_at??null,capability:'responses.structured'};
 }
 if(!['openai:default','openai:assistant'].includes(key))throw fail(400,'DIAGNOSTIC_PROFILE_UNSUPPORTED');
 const r=await readIntegrationSettings(c,p.workspace_id,environment,key,{secrets:secret});
 return {key,label:key==='openai:default'?'Vendedor WhatsApp · OpenAI':'Asistente operativo · OpenAI',version:r?.version??0,enabled:r?.enabled??false,model:String(r?.config.model??''),secret_configured:r?.secret_fields.api_key===true,api_key:r?.secrets.api_key,input_rate:Number(r?.config.input_cost_per_million_minor??0)/100,output_rate:Number(r?.config.output_cost_per_million_minor??0)/100,updated_at:r?.updated_at??null,capability:'responses.structured'};
}
function publicDiagnostic(row:any,currentVersion:number){const stale=row.profile_version!==currentVersion;return {...sanitize(row),status:stale?'STALE':row.status,inference_verified:!stale&&row.inference_verified,configuration_verified:!stale&&row.status==='VERIFIED',quality_evaluated:false,commercial_activation:false,next_action:stale?'La configuración cambió. Verifica esta revisión.':row.result?.next_action??'Consulta el resultado de la capacidad probada.'};}
async function finish(row:any,outcome:{status:string;authenticated?:boolean;verified?:boolean;cost?:number|null;units?:number|null;usage?:any;error?:string;result:any}){
 return withTransaction(async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`creative-provider:${row.workspace_id}`]);const current=(await c.query('SELECT * FROM integration_diagnostics WHERE id=$1 FOR UPDATE',[row.id])).rows[0];if(current.status!=='RUNNING')return current;
  if(outcome.cost!==undefined&&outcome.cost!==null)await c.query('UPDATE creative_budgets SET reserved_usd=reserved_usd-$2,spent_usd=spent_usd+$3,reserved_units=reserved_units-$4,spent_units=spent_units+$5 WHERE id=$1',[row.budget_id,row.estimated_cost_usd,outcome.cost,row.reserved_units,outcome.units??0]);
  return(await c.query('UPDATE integration_diagnostics SET status=$2,authenticated=$3,inference_verified=$4,confirmed_cost_usd=$5,usage=$6,error_code=$7,result=$8,finished_at=now(),updated_at=now() WHERE id=$1 RETURNING *',[row.id,outcome.status,outcome.authenticated??false,outcome.verified??false,outcome.cost??null,outcome.usage??null,outcome.error??null,outcome.result])).rows[0];
 });
}
export async function integrationDiagnosticRoutes(app:FastifyInstance){
 app.get('/v1/integration-profiles',async req=>{const p=integrationPermission(req,'read'),items=[];for(const key of ['intelligence:openai','openai:default','openai:assistant']){if(p.service&&p.resource_ids&&!p.resource_ids.includes(key))continue;const row=await profile(req,key);const last=(await pool.query('SELECT * FROM integration_diagnostics WHERE workspace_id=$1 AND environment=$2 AND profile_key=$3 ORDER BY started_at DESC LIMIT 1',[p.workspace_id,envOf(req),key])).rows[0];items.push({...row,api_key:undefined,configured:row.secret_configured&&Boolean(row.model),diagnostic:last?publicDiagnostic(last,row.version):null,max_test_cost_usd:.02,quality_evaluated:false,verification_enables_use:false});}return {data:items};});
 app.get('/v1/integration-diagnostics/:id',async req=>{const p=integrationPermission(req,'read');const row=(await pool.query('SELECT * FROM integration_diagnostics WHERE workspace_id=$1 AND environment=$2 AND id=$3',[p.workspace_id,envOf(req),z.uuid().parse((req.params as any).id)])).rows[0];if(!row)throw fail(404,'NOT_FOUND');assertResource(p,row.profile_key);const cfg=await profile(req,row.profile_key);return {data:publicDiagnostic(row,cfg.version)};});
 app.post('/v1/integration-profiles/:key/verify', {config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{
  const key=String((req.params as any).key),p=integrationPermission(req,'verify',key),environment=envOf(req),b=z.object({expected_version:z.number().int().positive(),capability:z.literal('responses.structured').default('responses.structured'),max_cost_usd:z.number().positive().max(.02)}).strict().parse(parseBody(req));
  if(environment!=='REAL')throw fail(400,'REAL_DIAGNOSTIC_REQUIRED','La verificación externa requiere el perfil REAL. El laboratorio no llama proveedores.');
  const rawKey=z.string().min(8).max(160).parse(req.headers['idempotency-key']),operationKey=idempotencyActor(p)===p.user.id?rawKey:hash(idempotencyActor(p)+':'+rawKey),requestHash=hash(stableJson({key,environment,...b}));
  const start=await withTransaction(async c=>{
   if(p.service&&p.token_id&&!(await c.query('SELECT id FROM service_tokens WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE',[p.token_id,p.workspace_id])).rowCount)throw fail(401,'INVALID_TOKEN');
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`creative-provider:${p.workspace_id}`]);
   const old=(await c.query('SELECT * FROM integration_diagnostics WHERE workspace_id=$1 AND environment=$2 AND actor_id=$3 AND profile_key=$4 AND operation_key=$5',[p.workspace_id,environment,p.user.id,key,operationKey])).rows[0];
   if(old){if(old.request_hash!==requestHash)throw fail(409,'IDEMPOTENCY_CONFLICT');return{row:old,execute:false};}
   const cfg=await profile(req,key,c,true);if(cfg.version!==b.expected_version)throw fail(409,'VERSION_CONFLICT');if(!cfg.api_key)throw fail(409,'PROVIDER_SECRET_REQUIRED','Guarda la clave de este perfil.');if(!cfg.model||!cfg.input_rate||!cfg.output_rate)throw fail(409,'MODEL_OR_TARIFF_REQUIRED','Guarda el modelo y sus tarifas verificadas.');
   await c.query("UPDATE integration_diagnostics SET status='UNKNOWN',error_code='PROCESS_INTERRUPTED',updated_at=now() WHERE workspace_id=$1 AND status='RUNNING' AND started_at<now()-interval '2 minutes'",[p.workspace_id]);
   if((await c.query("SELECT 1 FROM integration_diagnostics WHERE workspace_id=$1 AND environment=$2 AND profile_key=$3 AND profile_version=$4 AND status IN ('RUNNING','UNKNOWN')",[p.workspace_id,environment,key,cfg.version])).rowCount)throw fail(409,'DIAGNOSTIC_IN_FLIGHT_OR_UNKNOWN','Consulta el diagnóstico pendiente; no se repite la inferencia.');
   const request=diagnosticRequest(cfg.model),units=Buffer.byteLength(stableJson(request))+1024+128,estimate=Math.ceil(((units-128)*cfg.input_rate+128*cfg.output_rate))/1e6;
   if(estimate>b.max_cost_usd)throw fail(409,'OPERATION_BUDGET_EXCEEDED');
   const budget=(await c.query("SELECT * FROM creative_budgets WHERE workspace_id=$1 AND environment=$2 AND provider='openai' AND expires_at>clock_timestamp() FOR UPDATE",[p.workspace_id,environment])).rows[0];
   if(!budget)throw fail(409,'PROVIDER_BUDGET_REQUIRED','Falta un presupuesto OpenAI vigente; guardar el perfil no lo crea.');
   if(Number(budget.spent_usd)+Number(budget.reserved_usd)+estimate>Number(budget.limit_usd)||Number(budget.spent_units)+Number(budget.reserved_units)+units>Number(budget.max_units))throw fail(409,'PROVIDER_BUDGET_EXCEEDED');
   await assertGlobalBudgetCapacity(c,p.workspace_id,estimate);
   await c.query('UPDATE creative_budgets SET reserved_usd=reserved_usd+$2,reserved_units=reserved_units+$3 WHERE id=$1',[budget.id,estimate,units]);
   const row=(await c.query("INSERT INTO integration_diagnostics(id,workspace_id,environment,profile_key,profile_version,actor_id,operation_key,request_hash,capability,model,status,estimated_cost_usd,budget_id,reserved_units) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'RUNNING',$11,$12,$13) RETURNING *",[uuid(),p.workspace_id,environment,key,cfg.version,p.user.id,operationKey,requestHash,b.capability,cfg.model,estimate,budget.id,units])).rows[0];await audit(c,req,'integration.verification_started',row.id,{profile_key:key,profile_version:cfg.version,max_cost_usd:b.max_cost_usd});return {row,execute:true,cfg,request};
  });
  let row=start.row;
  if(start.execute){try{
   const response=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${start.cfg!.api_key}`,'Content-Type':'application/json'},body:JSON.stringify(start.request),redirect:'error',signal:AbortSignal.timeout(20000)});
   if(!response.ok){let errorCode:string|undefined;try{errorCode=(await boundedJson(response,65536)).error?.code;}catch{/* Do not expose a provider error body. */}const result=classifyDiagnosticHttp(response.status,errorCode);row=await finish(row,{status:result.status,...(!result.uncertain?{cost:0,units:0}:{}),error:result.code,result:{http_status:response.status,next_action:result.next}});
   }else{const body=await boundedJson(response,65536),check=validateDiagnosticResponse(body),usage=diagnosticUsage(body.usage,{input:start.cfg!.input_rate,output:start.cfg!.output_rate});row=await finish(row,{status:check.verified&&usage?'VERIFIED':'PARTIAL',authenticated:true,verified:check.verified&&Boolean(usage),cost:usage?.cost_usd,units:usage?.total_tokens,usage:usage?{input_tokens:usage.input_tokens,output_tokens:usage.output_tokens,total_tokens:usage.total_tokens}:null,error:check.verified&&!usage?'USAGE_UNAVAILABLE':check.verified?undefined:check.code,result:{output_valid:check.verified,synthetic:true,tools_used:false,latency_ms:Date.now()-Date.parse(row.started_at),next_action:check.verified&&usage?'Inferencia mínima comprobada. La evaluación de calidad y habilitación son independientes.':'Revisa compatibilidad de respuesta/usage; no se repite automáticamente.'}});}
  }catch{row=await finish(row,{status:'UNKNOWN',error:'NETWORK_OR_TIMEOUT_UNKNOWN',result:{next_action:'Resultado incierto por red o tiempo. Conserva la reserva y consulta antes de repetir.'}});}}
  const current=await profile(req,key);return reply.code(row.status==='RUNNING'?202:200).send({data:publicDiagnostic(row,current.version)});
 });
}
