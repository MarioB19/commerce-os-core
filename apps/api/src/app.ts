import {AsyncResource} from 'node:async_hooks';
import {isProfileSqlRequest} from './profile-sql-route.js';
import {runInRequestProfileScope,bindRequestProfileEnvironment,closeRequestProfileScope} from '../../../packages/db/src/profile-request-scope.js';
import {profileRuntimeRoutes} from './profile-runtime.js';
import {copySourceIsolationRoutes} from './copy-source-isolation.js';
import {documentNumbersApi} from './openapi-numbers.js';
import {personalAccessTokenRoutes,documentPersonalAccessTokens} from './personal-access-tokens.js';
import {channelSessionRoutes} from './channel-sessions.js';
import {productAssignmentRoutes} from './product-assignments.js';
import {numberHealthRoutes} from './number-health.js';
import {commercialConfigurationRoutes} from './commercial-configuration.js';
import {warmupBackfillRoutes} from './warmup-backfill.js';
import {readinessRoutes} from './readiness.js';
import {numbersRoutes} from './numbers.js';
import {warmupRoutes} from './warmup.js';
import {documentOperationalApi} from './openapi-operations.js';
import {remarketingRoutes} from './remarketing.js';
import {channelDeletionRoutes} from './channel-deletion.js';
import {sellerRoutes} from './seller.js';
import {receiptAccessRoutes} from './receipt-access.js';
import {campaignPerformanceRoutes} from './campaign-performance.js';
import {salesHistoryRoutes} from './sales-history.js';
import {integrationSettingsRoutes} from './integrations-settings.js';
import {operationalSettingsRoutes} from './operational-settings.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import {accountSecurityRoutes} from './account-security.js';
import {z,ZodError} from 'zod';
import {pool} from '../../../packages/db/src/index.js';
import {schemas,resourceKinds} from '../../../packages/contracts/src/index.js';
import {trustedOrigins} from './auth.js';
import {authenticate,envOf} from './context.js';
import {catalogRoutes} from './catalog.js';
import {channelSetupRoutes} from './channel-setup.js';
import {salesRoutes} from './sales.js';
import {systemRoutes} from './system.js';
import {documentCatalogApi} from './openapi-catalog.js';
import {metaRoutes} from './meta.js';
import {numberSetupRoutes} from './number-setup.js';
import {homeOperationsSummaryRoutes} from './home-operations-summary.js';
import {registerVersionRoute} from './version.js';
import {retiredRoutes} from './retired-routes.js';
export async function createApp(){const app=Fastify({logger:process.env.LOG_LEVEL?{level:process.env.LOG_LEVEL,redact:['req.headers.authorization','req.headers.cookie','res.headers.set-cookie','req.body']} :false,disableRequestLogging:true,bodyLimit:30*1024*1024,trustProxy:process.env.NODE_ENV==='production'});
// V7 F2: every request starts outside any profile scope. A connection's
// callbacks can be scheduled from the async context of an earlier request on
// the same socket (pipelining, pooled callbacks); the remaining lifecycle is
// rooted in this app-level context so no scope is ever inherited.
const requestRoot=new AsyncResource('CommerceApiRequest');app.addHook('onRequest',(_req,_reply,done)=>requestRoot.runInAsyncScope(()=>done()));
await app.register(cors,{origin:trustedOrigins,credentials:true,methods:['GET','POST','PATCH','PUT','DELETE','OPTIONS'],allowedHeaders:['Content-Type','Authorization','Idempotency-Key','X-Commerce-Profile-Id','X-Commerce-Profile-Version']});await app.register(rateLimit,{max:300,timeWindow:'1 minute'});await app.register(swagger,{openapi:{info:{title:'Commerce OS API',version:'7.0.0',description:'Private shared catalog and durable sales commands. SIMULATION and REAL isolated. Registration closed.'},security:[{session:[]},{service:[]}],servers:[{url:process.env.BETTER_AUTH_URL??'http://localhost:3001'}],components:{securitySchemes:{session:{type:'apiKey',in:'cookie',name:'better-auth.session_token'},service:{type:'http',scheme:'bearer'}}}}});
app.setErrorHandler((error:any,req,reply)=>{if(error instanceof ZodError)return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:'Revisa los campos indicados.',details:error.issues.map(x=>({path:x.path.join('.'),message:x.message}))}});let status=error.statusCode??500,code=error.code??(status===429?'RATE_LIMITED':'INTERNAL_ERROR');if(['23503','23514','22P02'].includes(code)||String(error.message).includes('INVALID_SCOPED_REFERENCE')||String(error.message).includes('INVALID_ASSET_REFERENCE')||String(error.message).includes('INVALID_RETAINED_ASSET_REFERENCE')||String(error.message).includes('INVALID_BINDING_')){code='INVALID_REFERENCE';status=400;}if(String(error.message).includes('AMBIGUOUS_BINDING_SCOPE')){code='AMBIGUOUS_BINDING_SCOPE';status=409;}if(code==='23505'){code=error.constraint==='channel_sessions_gateway_exclusive'?'CHANNEL_GATEWAY_ALREADY_ASSIGNED':'CONFLICT';status=409;if(code==='CHANNEL_GATEWAY_ALREADY_ASSIGNED')error.publicMessage='Este gateway físico ya tiene una cuenta reservada. Selecciona otro gateway aislado.';}if(/INVALID_AMOUNT|INVALID_CURRENCY|DUPLICATE_FULFILLMENT/.test(error.message)){code=error.message;status=400;}if(/IMMUTABLE|VERSION_CONFLICT/.test(error.message)){code='VERSION_CONFLICT';status=409;}return reply.code(status).send({error:{code,message:typeof error.publicMessage==='string'?error.publicMessage:status<500?error.message:'No se pudo completar la operación.',...(error.details?{details:error.details}:{}),...(error.diagnostic?{diagnostic:error.diagnostic}:{})}});});
// V7 F2: one profile authority per authenticated request. The remaining
// lifecycle runs inside that profile's request scope, so every historical
// query carries app.workspace_id (and app.environment once parsed) under RLS.
app.addHook('onRequest',(req,reply,done)=>{reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff');if(!req.url.startsWith('/v1/')||req.url.startsWith('/v1/openapi')||isProfileSqlRequest(req))return done();authenticate(req).then(authority=>{try{runInRequestProfileScope(authority.workspaceId,()=>done());}catch(error){done(error as Error);}},error=>done(error));});
app.addHook('preValidation',async req=>{if(req.url.startsWith('/v1/')&&!req.url.startsWith('/v1/openapi')){const environment=envOf(req);if(!isProfileSqlRequest(req))bindRequestProfileEnvironment(environment);}});
app.addHook('onResponse',async()=>{closeRequestProfileScope();});
registerVersionRoute(app);
await app.register(profileRuntimeRoutes);
await numberHealthRoutes(app);
app.get('/livez',async()=>({status:'ok',service:'api'}));app.get('/readyz',async()=>{await pool.query('SELECT 1');return{status:'ready',service:'api'};});app.get('/health/live',async()=>({status:'ok',service:'api'}));app.get('/health/ready',async()=>{await pool.query('SELECT 1');return{status:'ready',service:'api'};});
await retiredRoutes(app);await readinessRoutes(app);await warmupRoutes(app);await numbersRoutes(app);await numberSetupRoutes(app);await homeOperationsSummaryRoutes(app);await warmupBackfillRoutes(app);await remarketingRoutes(app);await accountSecurityRoutes(app);await sellerRoutes(app);
await receiptAccessRoutes(app);await campaignPerformanceRoutes(app);await salesHistoryRoutes(app);await catalogRoutes(app);await salesRoutes(app);await channelDeletionRoutes(app);await channelSetupRoutes(app);await channelSessionRoutes(app);await copySourceIsolationRoutes(app);await commercialConfigurationRoutes(app);await productAssignmentRoutes(app);await systemRoutes(app);await personalAccessTokenRoutes(app);await metaRoutes(app);await operationalSettingsRoutes(app);await integrationSettingsRoutes(app);
app.get('/v1/openapi.json',async()=>{const spec=app.swagger() as any;spec.components??={};spec.components.schemas={};for(const[kind,schema]of Object.entries(schemas)){try{spec.components.schemas[kind]=z.toJSONSchema(schema,{target:'openapi-3.0'});}catch{/* refined schemas remain documented in endpoint examples */}}for(const[path,kind]of Object.entries(resourceKinds)){if(schemas[kind]&&spec.paths?.['/v1/'+path]?.post){spec.paths['/v1/'+path].post.requestBody={required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/'+kind}}}};spec.paths['/v1/'+path].post.parameters=[{name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',minLength:8}}];}}const bodyDefinitions:Record<string,any>={'/v1/conversations/{id}/commands':{type:'object',required:['type'],properties:{type:{type:'string',enum:['send_message','assign','set_stage','consent','opt_out','commitment','receipt_received','approve_step']},expected_workflow_version_id:{type:'string'},expected_node_id:{type:'string'},reason:{type:'string',minLength:3},text:{type:'string'},asset_id:{type:'string',format:'uuid'},consent:{type:'object',required:['purpose','source','observed_at','evidence'],properties:{purpose:{type:'string'},source:{type:'string'},observed_at:{type:'string',format:'date-time'},evidence:{type:'string'}}}}},'/v1/receipts/{id}/review':{type:'object',required:['decision','reason','expected_version'],properties:{decision:{type:'string',enum:['APPROVED','REJECTED','HUMAN_REVIEW']},reason:{type:'string',minLength:3},expected_version:{type:'integer',minimum:1}}},'/v1/orders/{id}/reconcile':{type:'object',required:['amount_minor','currency','evidence_asset_id','reason','expected_version'],properties:{amount_minor:{type:'integer',minimum:1},currency:{type:'string',pattern:'^[A-Z]{3}$'},evidence_asset_id:{type:'string',format:'uuid'},reason:{type:'string',minLength:3},expected_version:{type:'integer',minimum:1}}}};for(const[path,schema]of Object.entries(bodyDefinitions))if(spec.paths?.[path]?.post)spec.paths[path].post.requestBody={required:true,content:{'application/json':{schema}}};documentCatalogApi(spec);documentOperationalApi(spec);documentPersonalAccessTokens(spec);documentNumbersApi(spec);return spec;});
return app;}
export const buildApp=createApp;
