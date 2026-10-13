import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import pg from 'pg';
import {z} from 'zod';
import {AiError} from '../../../packages/ai-providers/src/contracts.js';
import {aiCredentialKey,aiProviderIds,readAiIntegrations,saveAiKey,saveAiPreferences,setAiKeyEnabled,verifyAiKey,type AiVerificationRuntime} from '../../../packages/ai-providers/src/profile-integrations.js';
import {appendEvent} from '../../../packages/db/src/index.js';
import type {ProfileExecutor} from '../../../packages/db/src/profile-context.js';
import {checkMetaToken,IntegrationError,readMetaIntegration,readOnboarding,recordMetaCheck,saveMetaToken,setMetaEnabled,updateOnboarding} from '../../../packages/db/src/profile-integrations.js';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';

/** V7 F2 profile integrations (RF-01.2, RF-13, RF-14.b, RNF-04.a, RF-11.a/b)
 * and onboarding (RF-13.c, RF-04.d). Secrets enter only through an interactive
 * owner session; responses show at most the last four characters. */
export interface IntegrationRouteDependencies {
 request?:ProfileRequestDependencies;
 /** Dedicated commerce_ai runtime for the single verification request. */
 aiRuntime?:()=>AiVerificationRuntime|null;
 aiKey?:()=>Uint8Array;
 metaFetcher?:typeof fetch;
}
let cachedRuntime:AiVerificationRuntime|null|undefined;
function defaultAiRuntime():AiVerificationRuntime|null{
 if(cachedRuntime!==undefined)return cachedRuntime;
 const url=process.env.AI_DATABASE_URL;
 if(!url){cachedRuntime=null;return null;}
 const pool=new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:30000});
 // A dedicated login assumes the closed commerce_ai role; nothing else.
 pool.on('connect',client=>{client.query('SET ROLE commerce_ai').catch(()=>{process.stderr.write('ai_runtime_role_not_assumed\n');});});
 cachedRuntime={pool,key:aiCredentialKey()};return cachedRuntime;
}
const provider=z.enum(aiProviderIds);
const keyBody=z.object({operationId:z.uuid(),expectedRevision:z.number().int().min(0).max(1_000_000),key:z.string().min(8).max(8192).regex(/^[\x21-\x7e]+$/)}).strict();
const stateBody=z.object({expectedRevision:z.number().int().positive().max(1_000_000),enabled:z.boolean()}).strict();
const preferencesBody=z.object({expectedVersion:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),defaultProvider:provider.nullable().optional(),defaultModel:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/).nullable().optional(),
 monthlyLimitMicrousd:z.number().int().min(1_000_000).max(100_000_000_000).nullable().optional()}).strict();
const metaBody=z.object({expectedRevision:z.number().int().min(0).max(1_000_000),token:z.string().min(20).max(4096).regex(/^[A-Za-z0-9_|.-]+$/)}).strict();
const onboardingBody=z.object({expectedVersion:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),metaSkipped:z.boolean().optional(),dismissed:z.boolean().optional()}).strict();
const aiStatus:Record<string,number>={CONFIGURATION:400,BUDGET:400,AUTHORITY:409,CREDENTIAL_SCOPE:409};
function fail(code:string,statusCode=409):never{throw Object.assign(new Error(code),{code,statusCode});}
function parse<T>(schema:z.ZodType<T>,value:unknown,code:string):T{const r=schema.safeParse(value);if(!r.success)fail(code,400);return r.data;}
async function mapped<T>(work:()=>Promise<T>):Promise<T>{
 try{return await work();}
 catch(error){
  if(error instanceof AiError)fail('AI_'+error.code,aiStatus[error.code]??409);
  if(error instanceof IntegrationError)fail(error.code,error.statusCode);
  throw error;
 }
}
function headers(reply:FastifyReply){reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization').header('Referrer-Policy','no-referrer');}
function noQuery(req:FastifyRequest){if(Object.keys(req.query??{}).length)fail('PROFILE_QUERY_NOT_ALLOWED',400);}
type Profile=Parameters<Parameters<typeof withProfileRequest>[3]>[0]['profile'];
function actor(profile:Profile){return{type:profile.authority.credential.kind==='session'?'human':'personal_api',id:profile.authority.membership.userId,...('tokenId' in profile?{credential_id:(profile as {tokenId:string}).tokenId}:{})};}
async function event(db:ProfileExecutor,req:FastifyRequest,profile:Profile,type:string,aggregate:string,payload:Record<string,unknown>){
 await appendEvent(db,{workspace_id:db.workspaceId,environment:'REAL',event_type:type,aggregate_id:aggregate,correlation_id:req.id,actor:actor(profile),payload});
}
export async function profileIntegrationRoutes(app:FastifyInstance,deps:IntegrationRouteDependencies={}){
 const aiRuntime=deps.aiRuntime??defaultAiRuntime,aiKey=deps.aiKey??(()=>aiCredentialKey()),request=deps.request;
 const view=(req:FastifyRequest)=>withProfileRequest(req,'REAL',{scope:'integrations:read',mutation:false},async({db,profile})=>({ai:await readAiIntegrations(db,profile.authority,'REAL'),meta:await readMetaIntegration(db,profile.authority)}),request);
 app.get('/v2/integrations',async(req,reply)=>{headers(reply);noQuery(req);return{data:await mapped(()=>view(req))};});
 app.put('/v2/integrations/ai/:provider/key',{bodyLimit:16384},async(req,reply)=>{
  headers(reply);noQuery(req);
  const name=parse(provider,(req.params as {provider:unknown}).provider,'AI_PROVIDER_INVALID'),input=parse(keyBody,req.body,'AI_KEY_INPUT_INVALID');
  const saved=await mapped(()=>withProfileRequest(req,'REAL',{scope:'integrations:write',mutation:true,interactiveOnly:true},async({db,profile})=>{
   const result=await saveAiKey(db,profile.authority,{operationId:input.operationId,environment:'REAL',provider:name,expectedRevision:input.expectedRevision,key:input.key},aiKey());
   await event(db,req,profile,'profile.integration.ai_key.saved',result.credentialId,{provider:name,revision:result.revision});
   return result;
  },request));
  let verification:{state:string;code?:string};
  if(!saved.verification)verification={state:'UNAVAILABLE',code:saved.unavailable??'AI_VERIFICATION_UNAVAILABLE'};
  else{const runtime=aiRuntime();verification=runtime?await verifyAiKey(runtime,saved.verification):{state:'UNAVAILABLE',code:'AI_RUNTIME_UNAVAILABLE'};}
  return{data:{provider:name,revision:saved.revision,verification,integrations:await mapped(()=>view(req))}};
 });
 app.post('/v2/integrations/ai/:provider/state',{bodyLimit:1024},async(req,reply)=>{
  headers(reply);noQuery(req);
  const name=parse(provider,(req.params as {provider:unknown}).provider,'AI_PROVIDER_INVALID'),input=parse(stateBody,req.body,'AI_STATE_INPUT_INVALID');
  return{data:await mapped(()=>withProfileRequest(req,'REAL',{scope:'integrations:write',mutation:true},async({db,profile})=>{
   const result=await setAiKeyEnabled(db,profile.authority,{environment:'REAL',provider:name,expectedRevision:input.expectedRevision,enabled:input.enabled});
   await event(db,req,profile,'profile.integration.ai_key.state_changed',db.workspaceId,{provider:name,revision:result.revision,enabled:result.enabled});
   return result;
  },request))};
 });
 app.put('/v2/integrations/ai/preferences',{bodyLimit:2048},async(req,reply)=>{
  headers(reply);noQuery(req);const input=parse(preferencesBody,req.body,'AI_PREFERENCES_INPUT_INVALID');
  return{data:await mapped(()=>withProfileRequest(req,'REAL',{scope:'integrations:write',mutation:true},async({db,profile})=>{
   const result=await saveAiPreferences(db,profile.authority,{environment:'REAL',...input});
   await event(db,req,profile,'profile.integration.ai_preferences.saved',db.workspaceId,{version:result.version,default_provider:result.defaultProvider,default_model:result.defaultModel,monthly_limit_microusd:result.monthlyLimitMicrousd});
   return result;
  },request))};
 });
 app.put('/v2/integrations/meta/token',{bodyLimit:8192},async(req,reply)=>{
  headers(reply);noQuery(req);const input=parse(metaBody,req.body,'META_TOKEN_INPUT_INVALID');
  const saved=await mapped(()=>withProfileRequest(req,'REAL',{scope:'integrations:write',mutation:true,interactiveOnly:true},async({db,profile})=>{
   const result=await saveMetaToken(db,profile.authority,{expectedRevision:input.expectedRevision,token:input.token});
   await event(db,req,profile,'profile.integration.meta_token.saved',db.workspaceId,{revision:result.revision});
   return result;
  },request));
  const check=await checkMetaToken(input.token,deps.metaFetcher??fetch);
  await mapped(()=>withProfileRequest(req,'REAL',{scope:'integrations:write',mutation:true},async({db,profile})=>{
   const recorded=await recordMetaCheck(db,profile.authority,saved.revision,check);
   if(recorded.recorded)await event(db,req,profile,'profile.integration.meta_token.checked',db.workspaceId,{revision:saved.revision,state:check.state,...(check.state==='INVALID'?{reason:check.reason}:{})});
  },request));
  return{data:{revision:saved.revision,check:check.state==='VERIFIED'?{state:check.state}:{state:check.state,reason:check.reason},integrations:await mapped(()=>view(req))}};
 });
 app.post('/v2/integrations/meta/state',{bodyLimit:1024},async(req,reply)=>{
  headers(reply);noQuery(req);const input=parse(stateBody,req.body,'META_STATE_INPUT_INVALID');
  return{data:await mapped(()=>withProfileRequest(req,'REAL',{scope:'integrations:write',mutation:true},async({db,profile})=>{
   const result=await setMetaEnabled(db,profile.authority,input);
   await event(db,req,profile,'profile.integration.meta_token.state_changed',db.workspaceId,result);
   return result;
  },request))};
 });
 app.get('/v2/onboarding',async(req,reply)=>{headers(reply);noQuery(req);
  return{data:await mapped(()=>withProfileRequest(req,'REAL',{scope:'profile:read',mutation:false},({db,profile})=>readOnboarding(db,profile.authority),request))};
 });
 app.patch('/v2/onboarding',{bodyLimit:1024},async(req,reply)=>{
  headers(reply);noQuery(req);const input=parse(onboardingBody,req.body,'ONBOARDING_INPUT_INVALID');
  return{data:await mapped(()=>withProfileRequest(req,'REAL',{scope:'profile:write',mutation:true},({db,profile})=>updateOnboarding(db,profile.authority,input),request))};
 });
}
