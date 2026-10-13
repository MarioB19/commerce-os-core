import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';
import {marketOperation,readMarketOperation} from '../../../packages/db/src/market-variants.js';
import {VariantError,listProducts,createProduct,editProduct,productDependencies,setProductArchived,createVariant,readVariant,listVariants,
 saveVariantSection,reviewVariant,publishVariant,duplicateVariant,setVariantArchived,variantHistory,variantNumbers,variantNumberImpact,
 setVariantNumber,numberVariantsView,numberAssignmentHistory} from '../../../packages/db/src/variant-workspace.js';
import {adoptLegacyProduct} from '../../../packages/db/src/variant-migration.js';
import {variantRemarketingResults} from '../../../packages/db/src/remarketing-results.js';
import {variantAiStatus,authorizeVariantAi,aiStatusLabel} from '../../../packages/ai-providers/src/variant-ai.js';
import {AiError} from '../../../packages/ai-providers/src/contracts.js';
import {variantSellerSchema,variantSaleSchema,type VariantSection} from '../../../packages/contracts/src/variants.js';
import type {ProfileScope} from '../../../packages/contracts/src/profiles.js';

/** V7 F4 (RF-05/06/08): products, variants and their five sections. One shared
 * service for UI, API and MCP; every mutation carries an Idempotency-Key and
 * returns the same durable result on retry. */
const messages:Record<string,string>={
 VERSION_CONFLICT:'Otra persona guardó cambios. Actualiza y vuelve a intentarlo; tus cambios siguen en el formulario.',
 PRODUCT_NOT_FOUND:'No encontramos ese producto en este perfil.',VARIANT_NOT_FOUND:'No encontramos esa variante en este perfil.',
 PRODUCT_ARCHIVED:'El producto está archivado. Restáuralo para editarlo.',PRODUCT_ACTIVE:'El producto ya está activo.',
 PRODUCT_HAS_ACTIVE_NUMBERS:'Quita primero los números que venden este producto.',VARIANT_HAS_ACTIVE_NUMBERS:'Quita primero los números que venden esta variante.',
 VARIANT_ARCHIVED:'La variante está archivada. Restáurala para editarla.',VARIANT_ACTIVE:'La variante ya está activa.',
 VARIANT_INCOMPLETE:'Completa lo que falta antes de publicar.',VARIANT_MATERIAL_INVALID:'Revisa los materiales indicados.',
 VARIANT_NOT_PUBLISHED:'Publica la variante antes de asignarla a un número.',NUMBER_SELLS_OTHER_VARIANT:'Este número ya vende otra variante de este producto. Quítala primero.',
 VARIANT_NUMBER_NOT_ASSIGNED:'Este número no vende esta variante.',NUMBER_NOT_FOUND:'No encontramos ese número en este perfil.',
 COLLECTION_METHOD_REQUIRED:'Configura SPEI, un enlace de pago o ambos.',COLLECTION_SPEI_REQUIRES_MXN:'SPEI sólo aplica a variantes en pesos mexicanos (MXN).',
 COLLECTION_SPEI_MISSING:'No hay datos SPEI guardados para conservar.',COLLECTION_LINK_MISSING:'Escribe el enlace de pago.',COLLECTION_LINK_DUPLICATE:'Hay un enlace repetido.',
 VARIANT_CURRENCY_LOCKED:'Una variante publicada conserva su moneda. Duplica la variante para otro mercado.',
 VARIANT_FLOW_NOT_PUBLISHED:'Elige un flujo publicado.',VARIANT_FLOW_OTHER_PRODUCT:'Ese flujo pertenece a otro producto.',
 VARIANT_GUIDED_CONTENT_REQUIRED:'Completa los audios y textos del flujo guiado.',VARIANT_SALE_MESSAGES_REQUIRED:'Completa los mensajes de venta.',
 VARIANT_COLLECTION_CHANGED:'El cobro anterior ya no está disponible. Configura el cobro de nuevo.',VARIANT_CONFIGURATION_CHANGED:'La configuración cambió mientras se publicaba. Vuelve a intentarlo.',
 MARKET_OPERATION_CONFLICT:'Esa operación ya se usó con otros datos.',MARKET_OPERATION_BUSY:'La misma operación sigue en curso.',
 CONTINUITY_SCOPE_BUSY:'Otra operación está cambiando este número. Vuelve a intentarlo.',
 HUMAN_ASSIGNMENT_REQUIRED:'Vender una variante en un número se decide en la aplicación con tu sesión.',
 PROFILE_INTERACTIVE_SESSION_REQUIRED:'Esta confirmación sólo puede hacerse desde la aplicación, con tu sesión.',
};
function fail(code:string,statusCode=400):never{throw Object.assign(new Error(code),{code,statusCode,publicMessage:messages[code]});}
function headers(reply:FastifyReply){reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization');}
async function mapped<T>(work:()=>Promise<T>):Promise<T>{
 try{return await work();}catch(error){
  if(error instanceof VariantError)throw Object.assign(new Error(error.code),{code:error.code,statusCode:error.statusCode,details:error.details,publicMessage:messages[error.code]??(error.statusCode<500?undefined:undefined)});
  const code=error instanceof Error?(error as {code?:string}).code??error.message:'';
  if(['MARKET_OPERATION_CONFLICT','MARKET_OPERATION_BUSY','CONTINUITY_SCOPE_BUSY'].includes(code))fail(code,409);
  throw error;
 }
}
const environmentQuery=z.object({environment:z.enum(['REAL','SIMULATION']).default('REAL')}).passthrough();
const env=(req:FastifyRequest)=>environmentQuery.parse(req.query??{}).environment;
const rest=(req:FastifyRequest)=>{const {environment:_,...q}=(req.query??{}) as Record<string,unknown>;return q;};
const idParam=z.object({id:z.string().uuid()}).strict();
const operationKey=(req:FastifyRequest)=>z.string().uuid().parse(req.headers['idempotency-key']);
const actorOf=(profile:{authority:{membership:{userId:string};credential:{kind:string}}})=>({id:profile.authority.membership.userId,kind:profile.authority.credential.kind==='session'?'human' as const:'personal_api' as const});
const sectionScopes:Record<string,ProfileScope>={sale:'flows:write','sales-flow':'flows:write',seller:'sellers:write',offer:'offers:write',collection:'collections:write',remarketing:'remarketing:write',ai:'variants:write',market:'variants:write'};
const sectionReadScopes:Record<string,ProfileScope>={sale:'flows:read','sales-flow':'flows:read',seller:'sellers:read',offer:'offers:read',collection:'collections:read',remarketing:'remarketing:read',ai:'variants:read',market:'variants:read'};

export async function variantWorkspaceRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 const read=<T>(req:FastifyRequest,scope:ProfileScope,work:(ctx:{db:import('../../../packages/db/src/profile-context.js').ProfileExecutor;environment:'REAL'|'SIMULATION'})=>Promise<T>)=>{
  const environment=env(req);return mapped(()=>withProfileRequest(req,environment,{scope,mutation:false},({db})=>work({db,environment}),deps));
 };
 const write=<T extends object>(req:FastifyRequest,scope:ProfileScope,request:unknown,work:(ctx:{db:import('../../../packages/db/src/profile-context.js').ProfileExecutor;environment:'REAL'|'SIMULATION';actor:ReturnType<typeof actorOf>;profile:any;operationId:string})=>Promise<T>)=>{
  const environment=env(req),operationId=operationKey(req);
  return mapped(()=>withProfileRequest(req,environment,{scope,mutation:true},async({db,profile})=>{
   const actor=actorOf(profile);
   return marketOperation(db,environment,actor.id,operationId,{route:req.routeOptions.url,params:req.params,request},()=>work({db,environment,actor,profile,operationId}));
  },deps));
 };
 app.addHook('onRequest',async(req,reply)=>{if(req.url.startsWith('/v2/products')||req.url.startsWith('/v2/variants')||req.url.startsWith('/v2/number-variants'))headers(reply);});
 // Products (parents).
 app.get('/v2/products',async req=>({data:await read(req,'products:read',({db,environment})=>listProducts(db,environment,rest(req)))}));
 app.post('/v2/products',{bodyLimit:16384},async(req,reply)=>{const data=await write(req,'products:write',req.body,({db,environment,actor})=>createProduct(db,environment,req.body,actor));reply.code(201);return{data};});
 app.patch('/v2/products/:id',{bodyLimit:8192},async req=>{const {id}=idParam.parse(req.params);return{data:await write(req,'products:write',req.body,({db,environment,actor})=>editProduct(db,environment,id,req.body,actor))};});
 app.get('/v2/products/:id/dependencies',async req=>{const {id}=idParam.parse(req.params);return{data:await read(req,'products:read',({db,environment})=>productDependencies(db,environment,id))};});
 for(const action of ['archive','restore'] as const)app.post(`/v2/products/:id/${action}`,{bodyLimit:1024},async req=>{const {id}=idParam.parse(req.params);
  return{data:await write(req,'products:write',req.body,({db,environment,actor})=>setProductArchived(db,environment,id,req.body,action==='archive',actor))};});
 // Variants.
 app.get('/v2/variants',async req=>({data:await read(req,'variants:read',({db,environment})=>listVariants(db,environment,rest(req)))}));
 app.post('/v2/variants',{bodyLimit:8192},async(req,reply)=>{const data=await write(req,'variants:write',req.body,({db,environment,actor})=>createVariant(db,environment,req.body,actor));reply.code(201);return{data};});
 app.get('/v2/variants/:id',async req=>{const {id}=idParam.parse(req.params);return{data:await read(req,'variants:read',({db,environment})=>readVariant(db,environment,id))};});
 // V7 F7 (RF-10.e): what this variant's follow-ups achieved in a period.
 app.get('/v2/variants/:id/remarketing/results',async req=>{const {id}=idParam.parse(req.params);
  return{data:await read(req,'remarketing:read',({db,environment})=>variantRemarketingResults(db,environment,id,rest(req)))};});
 app.get('/v2/variants/:id/history',async req=>{const {id}=idParam.parse(req.params);return{data:await read(req,'variants:read',({db,environment})=>variantHistory(db,environment,id))};});
 app.post('/v2/variants/:id/review',{bodyLimit:2048},async req=>{const {id}=idParam.parse(req.params);return{data:await write(req,'variants:write',req.body,({db,environment,actor})=>reviewVariant(db,environment,id,req.body,actor))};});
 app.post('/v2/variants/:id/publish',{bodyLimit:2048},async req=>{const {id}=idParam.parse(req.params);return{data:await write(req,'variants:write',req.body,async({db,environment,actor,profile})=>{
  const result=await publishVariant(db,environment,id,req.body,actor);
  // The owner's own publication also confirms the variant's AI for the
  // resolved models (one grant per task); an operator's leaves it pending.
  const a=profile.authority,ai=result.variant.document.ai;
  const owner=a.membership.role==='owner'&&a.credential.kind==='session';
  const authorized=owner?await authorizeVariantAi(db,a,environment,id,ai).catch(e=>{if(e instanceof AiError)return null;throw e;}):null;
  const status=authorized?.status??await variantAiStatus(db,environment,id,ai);
  return{...result,ai:status.map(t=>({...t,state_label:aiStatusLabel(t.code)}))};
 })};});
 app.get('/v2/variants/:id/ai-status',async req=>{const {id}=idParam.parse(req.params);
  return{data:await read(req,'variants:read',async({db,environment})=>{const v=await readVariant(db,environment,id);
   return(await variantAiStatus(db,environment,id,v.document.ai)).map(t=>({...t,state_label:aiStatusLabel(t.code)}));})};});
 app.post('/v2/variants/:id/ai-authorization',{bodyLimit:256},async req=>{const {id}=idParam.parse(req.params);
  return{data:await write(req,'integrations:write',{},async({db,environment,profile})=>{
   if(profile.authority.credential.kind!=='session')fail('PROFILE_INTERACTIVE_SESSION_REQUIRED',403);
   const v=await readVariant(db,environment,id);const r=await authorizeVariantAi(db,profile.authority,environment,id,v.document.ai);
   return{minted:r.minted,status:r.status.map(t=>({...t,state_label:aiStatusLabel(t.code)}))};
  })};});
 app.post('/v2/variants/:id/duplicate',{bodyLimit:4096},async(req,reply)=>{const {id}=idParam.parse(req.params);const data=await write(req,'variants:write',req.body,({db,environment,actor})=>duplicateVariant(db,environment,id,req.body,actor));reply.code(201);return{data};});
 for(const action of ['archive','restore'] as const)app.post(`/v2/variants/:id/${action}`,{bodyLimit:1024},async req=>{const {id}=idParam.parse(req.params);
  return{data:await write(req,'variants:write',req.body,({db,environment,actor})=>setVariantArchived(db,environment,id,req.body,action==='archive',actor))};});
 // Sections: read one part of the document or save it. `sales-flow` and
 // `seller` are the two halves of Venta for the MCP tools.
 const sectionParam=z.object({id:z.string().uuid(),section:z.enum(['sale','sales-flow','seller','offer','collection','remarketing','ai','market'])}).strict();
 app.get('/v2/variants/:id/:section',async req=>{const {id,section}=sectionParam.parse(req.params);
  return{data:await read(req,sectionReadScopes[section]!,async({db,environment})=>{const v=await readVariant(db,environment,id),d=v.document;
   const value=section==='sale'?d.sale:section==='sales-flow'?{...d.sale,seller:undefined}:section==='seller'?d.sale.seller:section==='offer'?d.offer:section==='collection'?d.collection:section==='remarketing'?d.remarketing:section==='ai'?d.ai:{name:d.name,locale:d.locale};
   return{variant_id:v.id,version:v.version,section,value,missing:v.missing,state:v.state,state_label:v.state_label};})};});
 app.put('/v2/variants/:id/:section',{bodyLimit:262144},async req=>{const {id,section}=sectionParam.parse(req.params);
  const body=z.object({expected_version:z.number().int().positive(),value:z.unknown()}).strict().parse(req.body);
  return{data:await write(req,sectionScopes[section]!,req.body,async({db,environment,actor})=>{
   let target:VariantSection,value=body.value;
   if(section==='sales-flow'||section==='seller'){
    const current=(await readVariant(db,environment,id)).document.sale;
    value=section==='seller'?{...current,seller:variantSellerSchema.parse(body.value)}:variantSaleSchema.parse({...(body.value as object),seller:current.seller});target='sale';
   }else target=section==='market'?'locale':section as VariantSection;
   return saveVariantSection(db,environment,id,{section:target,expected_version:body.expected_version,value},actor);
  })};});
 // Numbers (RF-06.d): assign/remove with one human act, inverse view, impact.
 app.get('/v2/variants/:id/numbers',async req=>{const {id}=idParam.parse(req.params);return{data:await read(req,'assignments:read',({db,environment})=>variantNumbers(db,environment,id))};});
 app.get('/v2/variants/:id/numbers/:account_id/impact',async req=>{const p=z.object({id:z.string().uuid(),account_id:z.string().uuid()}).strict().parse(req.params);
  return{data:await read(req,'assignments:read',({db,environment})=>variantNumberImpact(db,environment,p.id,p.account_id))};});
 app.post('/v2/variants/:id/numbers',{bodyLimit:1024},async req=>{const {id}=idParam.parse(req.params);
  return{data:await write(req,'assignments:write',req.body,({db,environment,actor,profile,operationId})=>{
   // D-01: starting to sell in a number is a human act in the application; an
   // agent's token can only remove a relation.
   if((req.body as {sell?:unknown})?.sell===true&&profile.authority.credential.kind!=='session')fail('HUMAN_ASSIGNMENT_REQUIRED',403);
   return setVariantNumber(db,environment,id,req.body,actor,{authority:profile.authority,operationId});})};});
 app.get('/v2/number-variants/:id/history',async req=>{const {id}=idParam.parse(req.params);return{data:await read(req,'assignments:read',({db,environment})=>numberAssignmentHistory(db,environment,id))};});
 app.post('/v2/products/:id/adopt',{bodyLimit:256},async req=>{const {id}=idParam.parse(req.params);
  return{data:await write(req,'products:write',{},({db,environment,actor})=>adoptLegacyProduct(db,environment,id,actor.id))};});
 app.get('/v2/number-variants',async req=>{const q=z.object({environment:z.enum(['REAL','SIMULATION']).optional(),offer_id:z.string().uuid().optional()}).strict().parse(req.query??{});
  return{data:await read(req,'assignments:read',({db,environment})=>numberVariantsView(db,environment,{offer_id:q.offer_id}))};});
 app.get('/v2/variant-operations/:id',async req=>{const {id}=idParam.parse(req.params);const environment=env(req);
  return{data:await mapped(()=>withProfileRequest(req,environment,{scope:'variants:read',mutation:false},({db,profile})=>readMarketOperation(db,environment,profile.authority.membership.userId,id),deps))};});
}
