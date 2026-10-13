import {randomUUID} from 'node:crypto';
import type {ProfileExecutor,ProfilePool} from '../../db/src/profile-context.js';
import {withProfileTransaction} from '../../db/src/profile-context.js';
import {currentProfileExecutor} from '../../db/src/profile-query-routing.js';
import {currentWorkerProfile} from '../../db/src/profile-worker-scope.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../domain/src/core/profile-authorization.js';
import {resolveModel,quote} from './catalog.js';
import {configureAiGrant} from './configuration.js';
import {modelFromRow,PostgresAiPorts} from './persistence.js';
import {AnthropicAdapter,GoogleAdapter,OpenAIAdapter,type ProviderAdapter} from './client.js';
import {laboratorySellerInput,parseLaboratorySeller} from './laboratory-seller.js';
import {aiTasks,type AiTask} from './price-catalog.js';
import {AiError,requireAi,type Capability,type Model,type Provider,type Selection} from './contracts.js';
import type {AgentProposal} from '../../domain/src/sales/ai.js';

/** V7 F4 (RF-14.a/c/d, D-09): the model of each variant and its permanent
 * runtime authority. The owner's publication (or an explicit confirmation)
 * mints one grant per task for the resolved model; the seller then admits,
 * reserves and accounts every call against the profile's own key and monthly
 * budget, imputed to the variant and conversation. */
type Environment='REAL'|'SIMULATION';
export interface VariantAiSelection {primary:Selection|null;fallback:Selection|null}
export interface TaskStatus {task:AiTask;label:string;capability:Capability;state:'READY'|'NEEDS_OWNER'|'HUMAN_REQUIRED';code:string|null;provider:Provider|null;model:string|null;selection:string|null;grant_expires_at:string|null}
const statusLabels:Record<string,string>={KEY_NOT_CONFIGURED:'Falta una clave de IA verificada para este proveedor',CAPABILITY_NOT_CONFIGURED:'Ningún modelo configurado puede hacer esta tarea; la atiende una persona',
 DEFAULT_MODEL_REQUIRED:'Elige el modelo predeterminado del perfil en Integraciones',GRANT_REQUIRED:'La persona Dueña debe confirmar la IA de esta variante',BUDGET_REQUIRED:'Configura el límite mensual de IA en Integraciones'};
export const aiStatusLabel=(code:string|null)=>code?statusLabels[code]??code:'Lista';

async function catalog(db:ProfileExecutor){
 const rows=(await db.query(`SELECT DISTINCT ON(provider,model) * FROM ai_model_prices WHERE valid_from<=clock_timestamp() AND valid_until>clock_timestamp()+interval '15 minutes'
  ORDER BY provider,model,valid_from DESC,price_version DESC`)).rows;
 const now=new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
 return rows.map(r=>({model:modelFromRow(r,now),row:r}));
}
async function profileConfiguration(db:ProfileExecutor,environment:Environment,variantId:string,selection:VariantAiSelection){
 const prefs=(await db.query('SELECT version,default_provider,default_model,monthly_limit_microusd FROM ai_profile_preferences WHERE workspace_id=$1 AND environment=$2',[db.workspaceId,environment])).rows[0];
 const keys=(await db.query(`SELECT id,provider FROM ai_credentials WHERE workspace_id=$1 AND environment=$2 AND enabled AND state='VERIFIED'`,[db.workspaceId,environment])).rows as {id:string;provider:Provider}[];
 const primary=selection.primary??(prefs?.default_provider?{provider:prefs.default_provider,model:prefs.default_model}:null);
 return{prefs,keys,primary,config:primary?{profileId:db.workspaceId,version:prefs?.version??1,default:prefs?.default_provider?{provider:prefs.default_provider,model:prefs.default_model}:primary,
  variants:selection.primary?{[variantId]:selection.primary}:{},capabilityFallbacks:selection.fallback?[selection.fallback]:[],configuredProviders:[...new Set(keys.map(k=>k.provider))]}:null};
}
/** What each task of the variant would use now, and whether it may run. */
export async function variantAiStatus(db:ProfileExecutor,environment:Environment,variantId:string,selection:VariantAiSelection):Promise<TaskStatus[]>{
 const {prefs,config}=await profileConfiguration(db,environment,variantId,selection),models=await catalog(db),now=Date.now();
 const grants=(await db.query(`SELECT task,provider,model,model_revision,price_version,expires_at FROM ai_runtime_grants WHERE workspace_id=$1 AND environment=$2 AND variant_id=$3
  AND NOT is_test AND revoked_at IS NULL AND expires_at>clock_timestamp()+interval '2 minutes'`,[db.workspaceId,environment,variantId])).rows;
 return(Object.entries(aiTasks) as [AiTask,typeof aiTasks[AiTask]][]).map(([task,spec])=>{
  const base={task,label:spec.label,capability:spec.capability as Capability,provider:null,model:null,selection:null,grant_expires_at:null};
  if(!config)return{...base,state:'HUMAN_REQUIRED' as const,code:'DEFAULT_MODEL_REQUIRED'};
  const resolved=resolveModel(config,variantId,spec.capability as Capability,models.map(m=>m.model),now);
  if(resolved.state!=='MODEL')return{...base,state:'HUMAN_REQUIRED' as const,code:resolved.code};
  const m=resolved.model,grant=grants.find(g=>g.task===task&&g.provider===m.provider&&g.model===m.model&&g.model_revision===m.revision&&g.price_version===m.price.version);
  const filled={...base,provider:m.provider,model:m.model,selection:resolved.selection};
  if(!prefs?.monthly_limit_microusd)return{...filled,state:'HUMAN_REQUIRED' as const,code:'BUDGET_REQUIRED'};
  return grant?{...filled,state:'READY' as const,code:null,grant_expires_at:new Date(grant.expires_at).toISOString()}:{...filled,state:'NEEDS_OWNER' as const,code:'GRANT_REQUIRED'};
 });
}
/** Owner act (interactive): one grant per task for the resolved model, valid
 * until that price version expires. Existing matching grants are kept. */
export async function authorizeVariantAi(db:ProfileExecutor,authority:ProfileAuthority,environment:Environment,variantId:string,selection:VariantAiSelection,only?:readonly AiTask[]){
 const {config,keys}=await profileConfiguration(db,environment,variantId,selection),models=await catalog(db),now=Date.now();
 const minted:{task:AiTask;grant_id:string;provider:Provider;model:string}[]=[];
 if(!config)return{minted,status:await variantAiStatus(db,environment,variantId,selection)};
 for(const [task,spec] of Object.entries(aiTasks) as [AiTask,typeof aiTasks[AiTask]][]){
  if(only&&!only.includes(task))continue;
  const resolved=resolveModel(config,variantId,spec.capability as Capability,models.map(m=>m.model),now);if(resolved.state!=='MODEL')continue;
  const m=resolved.model,row=models.find(x=>x.model.provider===m.provider&&x.model.model===m.model)!.row,credential=keys.find(k=>k.provider===m.provider);if(!credential)continue;
  const existing=(await db.query(`SELECT id FROM ai_runtime_grants WHERE workspace_id=$1 AND environment=$2 AND variant_id=$3 AND task=$4 AND provider=$5 AND model=$6 AND model_revision=$7 AND price_version=$8
   AND credential_id=$9 AND NOT is_test AND revoked_at IS NULL AND expires_at>clock_timestamp()+interval '1 day' LIMIT 1`,[db.workspaceId,environment,variantId,task,m.provider,m.model,m.revision,m.price.version,credential.id])).rows[0];
  if(existing)continue;
  const grantId=randomUUID();
  await configureAiGrant(db,authority,{grantId,environment,credentialId:credential.id,variantId,task,isTest:false,provider:m.provider,model:m.model,modelRevision:m.revision,priceVersion:m.price.version,
   expiresAt:new Date(new Date(row.valid_until).getTime()).toISOString()});
  minted.push({task,grant_id:grantId,provider:m.provider,model:m.model});
 }
 return{minted,status:await variantAiStatus(db,environment,variantId,selection)};
}

/** V7 F6 (RF-19): the configuration «Probar número» prices with — the same
 * resolution as each variant's seller (its own selection, then the profile
 * default) — and the protected catalogue. Null without a default model. */
export async function laboratoryAiConfiguration(db:ProfileExecutor,selections:Readonly<Record<string,VariantAiSelection>>){
 const prefs=(await db.query("SELECT version,default_provider,default_model FROM ai_profile_preferences WHERE workspace_id=$1 AND environment='REAL'",[db.workspaceId])).rows[0];
 const keys=(await db.query(`SELECT provider FROM ai_credentials WHERE workspace_id=$1 AND environment='REAL' AND enabled AND state='VERIFIED'`,[db.workspaceId])).rows as {provider:Provider}[];
 const variants:Record<string,Selection>={};for(const [id,s] of Object.entries(selections))if(s.primary)variants[id]=s.primary;
 const fallback=Object.values(selections).map(s=>s.fallback).filter((s):s is Selection=>!!s);
 const first=Object.values(variants)[0];const base=prefs?.default_provider?{provider:prefs.default_provider as Provider,model:String(prefs.default_model)}:first;
 const models=(await catalog(db)).map(m=>m.model as Model);
 return{version:Number(prefs?.version??0),models,config:base&&prefs?{profileId:db.workspaceId,version:Number(prefs.version),default:base,variants,capabilityFallbacks:fallback,configuredProviders:[...new Set(keys.map(k=>k.provider))]}:null};
}
/** Laboratory grants (task laboratory.chat) per variant whose model matches the
 * one the run was priced with. Missing ones are minted only by an interactive
 * owner (integrations:write); otherwise the caller is told who must confirm. */
export async function laboratoryGrants(db:ProfileExecutor,authority:ProfileAuthority,cases:readonly {variant_id:string;quote:{provider:string;model:string;modelRevision:string;priceVersion:string}}[],selections:Readonly<Record<string,VariantAiSelection>>){
 const grants:Record<string,string>={},missing:string[]=[];
 let owner=true;try{authorizeProfileAction(authority,{scope:'integrations:write',workspaceId:db.workspaceId,mutation:true,interactiveOnly:true});}catch{owner=false;}
 const find=async(variantId:string,q:{provider:string;model:string;modelRevision:string;priceVersion:string})=>(await db.query(`SELECT id FROM ai_runtime_grants WHERE workspace_id=$1 AND environment='REAL' AND variant_id=$2 AND task='laboratory.chat'
  AND provider=$3 AND model=$4 AND model_revision=$5 AND price_version=$6 AND NOT is_test AND revoked_at IS NULL AND expires_at>clock_timestamp()+interval '10 minutes' ORDER BY expires_at DESC,id LIMIT 1`,[db.workspaceId,variantId,q.provider,q.model,q.modelRevision,q.priceVersion])).rows[0]?.id as string|undefined;
 for(const variantId of [...new Set(cases.map(c=>c.variant_id))]){
  const q=cases.find(c=>c.variant_id===variantId)!.quote;let id=await find(variantId,q);
  // RF-19.d: the receipt reading is minted with the seller (same model); a
  // model without vision leaves receipts to the tester, never blocks the test.
  if(!id&&owner){await authorizeVariantAi(db,authority,'REAL',variantId,selections[variantId]??{primary:null,fallback:null},['laboratory.chat','laboratory.vision']).catch(e=>{if(!(e instanceof AiError))throw e;});id=await find(variantId,q);}
  if(id)grants[variantId]=id;else missing.push(variantId);
 }
 return{grants,missing};
}

const adapters:{[P in Provider]:new(ports:ConstructorParameters<typeof OpenAIAdapter>[0])=>ProviderAdapter}={openai:OpenAIAdapter,anthropic:AnthropicAdapter,google:GoogleAdapter};
export interface SellerCall {workspaceId:string;variantId:string;conversationId:string;attemptId:string;instructions:string;context:Record<string,unknown>}
export interface SellerOutcome {proposal:AgentProposal;usage:{input_tokens:number;output_tokens:number;cost_minor:number};provider:Provider;model:string;cost_microusd:number;attempt_id:string}
/** Production seller for variants whose agent uses the profile's AI. Runs
 * outside any profile transaction; admission and accounting are durable. */
export class ProfileSellerAi {
 private readonly key:Uint8Array;
 constructor(private readonly options:{aiPool:ProfilePool;custodyKey:Uint8Array;fetcher?:typeof fetch;clock?:()=>number;timeoutMs?:number}){requireAi(options.custodyKey.length===32,'CONFIGURATION');this.key=new Uint8Array(options.custodyKey);}
 async propose(call:SellerCall):Promise<SellerOutcome>{
  requireAi(!currentProfileExecutor()&&!currentWorkerProfile(),'AUTHORITY');
  const o=this.options;
  const {grantId,model}=await withProfileTransaction(o.aiPool,call.workspaceId,async db=>{
   await db.query("SELECT set_config('app.environment','REAL',true)");
   const row=(await db.query(`SELECT g.id AS grant_id,p.* FROM ai_runtime_grants g JOIN ai_model_prices p ON(p.provider,p.model,p.model_revision,p.price_version)=(g.provider,g.model,g.model_revision,g.price_version)
    WHERE g.workspace_id=$1 AND g.environment='REAL' AND g.variant_id=$2 AND g.task='sales.chat' AND NOT g.is_test AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()+interval '2 minutes'
     AND p.valid_from<=clock_timestamp() AND p.valid_until>clock_timestamp()+interval '2 minutes' ORDER BY g.expires_at DESC,g.id LIMIT 1`,[call.workspaceId,call.variantId])).rows[0];
   if(!row)throw new AiError('AUTHORITY');
   const now=new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
   return{grantId:row.grant_id as string,model:modelFromRow(row,now) as Model};
  });
  const ports=new PostgresAiPorts(o.aiPool,grantId,this.key);
  const adapter=new adapters[model.provider]({credentials:ports,admission:ports,...(o.fetcher?{fetcher:o.fetcher}:{}),...(o.clock?{clock:o.clock}:{})});
  const budget=quote(call.workspaceId,model,Number.MAX_SAFE_INTEGER,(o.clock??Date.now)()).maximumMicrousd;
  const invocation=await adapter.invoke({scope:{workspaceId:call.workspaceId,profileId:call.workspaceId,variantId:call.variantId,attemptId:call.attemptId,conversationId:call.conversationId,task:'sales.chat',environment:'REAL'},
   model,input:laboratorySellerInput(call.instructions,call.context),budgetMicrousd:budget,timeoutMs:o.timeoutMs??20000,parse:parseLaboratorySeller});
  if(invocation.state!=='SUCCEEDED')throw new AiError(invocation.code);
  const u=invocation.outcome.usage;
  return{proposal:invocation.value,usage:{input_tokens:u.input+u.cacheRead+u.cacheWrite+u.audioInput,output_tokens:u.output,cost_minor:0},provider:model.provider,model:model.model,cost_microusd:invocation.outcome.costMicrousd,attempt_id:call.attemptId};
 }
}
