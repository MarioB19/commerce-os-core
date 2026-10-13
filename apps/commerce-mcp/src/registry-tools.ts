import {remarketingPolicySchema} from '../../../packages/contracts/src/sales-flow.js';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {continuityRequestSchema} from '../../../packages/contracts/src/continuous-consumer.js';
import {variantSellerSchema,variantOfferSchema,collectionInputSchema,variantLocaleSchema,variantSections} from '../../../packages/contracts/src/variants.js';
import {paymentsCommandSchema} from '../../../packages/contracts/src/payments-client.js';
import {invitationCreateSchema,invitationCancelSchema} from '../../../packages/contracts/src/profile-invitations.js';
import {profileTokenCommandSchema,profileTokenListSchema} from '../../../packages/contracts/src/profile-token-management.js';
import {profileEmployeeInputSchema,profileRoleSchema,profileSettingsInputSchema} from '../../../packages/contracts/src/profiles.js';
import {receiptPolicyCommand} from '../../../packages/contracts/src/receipt-policy-client.js';
import {resultsCommandSchema} from '../../../packages/contracts/src/results-client.js';
import type {ContinuityClient} from '../../../packages/commerce-client/src/continuous-authorization.js';
import type {PaymentsClient} from '../../../packages/commerce-client/src/payments.js';
import type {ProfileV1Client,ProfileV2Client,ProfileVariantClient} from '../../../packages/commerce-client/src/profile-v2.js';
import {numberCountries,type NumberCountry} from '../../../packages/domain/src/numbers/phone.js';
import type {ReceiptPolicyClient} from '../../../packages/commerce-client/src/receipt-policies.js';
import type {ResultsClient} from '../../../packages/commerce-client/src/results.js';
import {ProfileSalesError,type ProfileSalesClient} from '../../../packages/commerce-client/src/profile-sales.js';
import {profileSalesPointer,type ProfileSalesMutation} from '../../../packages/contracts/src/profile-sales-consumer.js';
import {createHash} from 'node:crypto';
import {humanAction,registerManageTool,type ManageAction} from './manage-tool.js';
import {helpMarkdown} from '../../../packages/contracts/src/help.js';

export interface ProfileRegistryClients {v2:ProfileV2Client;v1:ProfileV1Client;variant:ProfileVariantClient;continuity:ContinuityClient;payments:PaymentsClient;receiptPolicies:ReceiptPolicyClient;results:ResultsClient;sales:ProfileSalesClient}
const id=(v:string)=>encodeURIComponent(v);
const query=(values:Record<string,unknown>)=>{const q=new URLSearchParams();for(const[k,v]of Object.entries(values))if(v!==undefined&&v!==null)q.set(k,String(v));const s=q.toString();return s?'?'+s:'';};
function failure(action:string,error:unknown,input:unknown){
 const e=error as {code?:unknown;path?:unknown;reason?:unknown};
 const code=typeof e?.code==='string'?e.code:'MCP_OUTCOME_UNCONFIRMED';
 if(code==='HUMAN_ACTION_REQUIRED')return{code,next:'Hazlo desde la aplicación con tu sesión: '+String(e.path)+' ('+String(e.reason)+').'};
 const operationId=input&&typeof input==='object'&&'operationId' in input?String((input as {operationId:unknown}).operationId):input&&typeof input==='object'&&'operation_id' in input?String((input as {operation_id:unknown}).operation_id):undefined;
 return{code,...(operationId?{operationId}:{}),next:/UNCONFIRMED/.test(code)?'El resultado no es concluyente: consulta la operación antes de repetir '+action+'.':'Revisa permisos, versión y datos; no se repitió automáticamente.'};
}
/** Splits a contract union (discriminated by `operation`) into registry actions. */
function fromUnion(union:{options:readonly z.ZodObject<any>[]},map:Record<string,string>,read:(operation:string)=>boolean,run:(command:Record<string,unknown>)=>Promise<unknown>,destructive:(operation:string)=>boolean=()=>false):Record<string,ManageAction>{
 const actions:Record<string,ManageAction>={};
 for(const option of union.options){
  const operation=(option.shape.operation as z.ZodLiteral<string>).value,action=map[operation];if(!action)continue;
  const {operation:_omit,...shape}=option.shape;
  actions[action]={schema:z.object(shape).strict(),read:read(operation),destructive:destructive(operation),run:input=>run({...input,operation})};
 }
 return actions;
}
const v=(method:'GET'|'POST'|'PUT'|'PATCH',schema:z.ZodObject<any>,path:(input:any)=>string,body?:(input:any)=>unknown,options:{read?:boolean;destructive?:boolean}={})=>(client:ProfileV2Client):ManageAction=>({schema,read:options.read??method==='GET',destructive:options.destructive,run:input=>client(method,path(input),body?body(input):undefined)});
const empty=z.object({}).strict();
const provider=z.enum(['openai','anthropic','google']);
/** The composed V7 registry (Inventario y paridad V7): one tool per domain with
 * closed actions; profile identity comes only from the configured token. */
export function registerProfileRegistryTools(server:McpServer,c:ProfileRegistryClients){
 const tool=(name:string,title:string,description:string,actions:Record<string,ManageAction>)=>registerManageTool(server,name,{title,description},actions,failure);
 tool('profile_context','Perfil de este acceso','El token está ligado a un solo perfil: listar devuelve sólo ese perfil. Cambiar de perfil exige otro token o la sesión de la aplicación.',{
  actual:v('GET',empty,()=>'/v2/profile')(c.v2),
  listar:{schema:empty,read:true,run:async()=>({profiles:[await c.v2('GET','/v2/profile')]})},
  cambiar:{schema:empty,read:false,run:humanAction('/home','Un token de perfil no cambia de perfil; crea un token en el otro perfil.')},
 });
 tool('profile_settings_manage','Datos y configuración inicial del perfil','Consulta o edita nombre y zona horaria, y la guía inicial. Editar exige la versión vigente.',{
  leer:v('GET',empty,()=>'/v2/profile')(c.v2),
  editar:v('PATCH',profileSettingsInputSchema,()=>'/v2/profile',i=>i)(c.v2),
  onboarding:v('GET',empty,()=>'/v2/onboarding')(c.v2),
  actualizar_onboarding:v('PATCH',z.object({expectedVersion:z.number().int().min(0),metaSkipped:z.boolean().optional(),dismissed:z.boolean().optional()}).strict(),()=>'/v2/onboarding',i=>i)(c.v2),
 });
 tool('employees_manage','Empleados e invitaciones','Lista personas e invitaciones, invita, cambia rol o desactiva con la versión vigente. Invitar envía un correo transaccional al destinatario indicado.',{
  listar:v('GET',empty,()=>'/v2/employees')(c.v2),
  invitaciones:v('GET',z.object({afterId:z.uuid().optional()}).strict(),i=>'/v2/invitations'+query(i))(c.v2),
  invitar:v('POST',invitationCreateSchema,()=>'/v2/invitations',i=>i)(c.v2),
  cancelar_invitacion:v('POST',invitationCancelSchema.extend({invitationId:z.uuid()}).strict(),i=>'/v2/invitations/'+id(i.invitationId)+'/cancel',i=>({expectedVersion:i.expectedVersion}),{destructive:true})(c.v2),
  cambiar_rol:v('PATCH',z.object({userId:z.string().min(1).max(256),expectedVersion:profileEmployeeInputSchema.shape.expectedVersion,role:profileRoleSchema}).strict(),i=>'/v2/employees/'+id(i.userId),i=>({expectedVersion:i.expectedVersion,role:i.role,active:true}))(c.v2),
  desactivar:v('PATCH',z.object({userId:z.string().min(1).max(256),expectedVersion:profileEmployeeInputSchema.shape.expectedVersion,role:profileRoleSchema}).strict(),i=>'/v2/employees/'+id(i.userId),i=>({expectedVersion:i.expectedVersion,role:i.role,active:false}),{destructive:true})(c.v2),
  consultar_operacion:v('GET',z.object({operationId:z.uuid()}).strict(),i=>'/v2/invitations/operations/'+id(i.operationId))(c.v2),
 });
 tool('api_tokens_manage','Accesos MCP del perfil','Lista o revoca tokens de este perfil. Crear un token nuevo exige la sesión de la aplicación.',{
  listar:v('GET',profileTokenListSchema,i=>'/v2/tokens'+query(i))(c.v2),
  crear:{schema:z.object({}).passthrough(),read:false,run:humanAction('/account/tokens','Un token nunca crea otro token.')},
  revocar:v('POST',(profileTokenCommandSchema.options[2] as z.ZodObject<any>).omit({action:true}),()=>'/v2/tokens/operations',i=>({...i,action:'revoke'}),{destructive:true})(c.v2),
  consultar_operacion:v('GET',z.object({operationId:z.uuid()}).strict(),i=>'/v2/tokens/operations/'+id(i.operationId))(c.v2),
 });
 tool('integrations_manage','Integraciones de IA y Meta','Estado de las claves propias del negocio (sólo últimos cuatro caracteres) y preferencias de IA. Guardar, rotar o validar una clave se hace en la aplicación.',{
  listar:v('GET',empty,()=>'/v2/integrations')(c.v2),
  guardar:{schema:z.object({provider:z.enum(['openai','anthropic','google','meta'])}).strict(),read:false,run:humanAction('/account/integrations','Las claves sólo se escriben en la aplicación por la persona Dueña.')},
  rotar:{schema:z.object({provider:z.enum(['openai','anthropic','google','meta'])}).strict(),read:false,run:humanAction('/account/integrations','Reemplaza la clave en la aplicación; se verifica al guardarla.')},
  validar:{schema:z.object({provider:z.enum(['openai','anthropic','google','meta'])}).strict(),read:false,run:humanAction('/account/integrations','La validación ocurre al guardar la clave.')},
  preferencias:v('PUT',z.object({expectedVersion:z.number().int().min(0),defaultProvider:provider.nullable().optional(),defaultModel:z.string().max(128).nullable().optional(),monthlyLimitMicrousd:z.number().int().min(1_000_000).max(100_000_000_000).nullable().optional()}).strict(),()=>'/v2/integrations/ai/preferences',i=>i)(c.v2),
  activar:v('POST',z.object({provider:z.enum(['openai','anthropic','google','meta']),expectedRevision:z.number().int().positive()}).strict(),i=>i.provider==='meta'?'/v2/integrations/meta/state':'/v2/integrations/ai/'+i.provider+'/state',i=>({expectedRevision:i.expectedRevision,enabled:true}))(c.v2),
  desactivar:v('POST',z.object({provider:z.enum(['openai','anthropic','google','meta']),expectedRevision:z.number().int().positive()}).strict(),i=>i.provider==='meta'?'/v2/integrations/meta/state':'/v2/integrations/ai/'+i.provider+'/state',i=>({expectedRevision:i.expectedRevision,enabled:false}),{destructive:true})(c.v2),
  eliminar:v('POST',z.object({provider:z.enum(['openai','anthropic','google','meta']),expectedRevision:z.number().int().positive()}).strict(),i=>i.provider==='meta'?'/v2/integrations/meta/state':'/v2/integrations/ai/'+i.provider+'/state',i=>({expectedRevision:i.expectedRevision,enabled:false}),{destructive:true})(c.v2),
 });
 const operation=z.object({operationId:z.uuid()});
 const variantId=z.object({variantId:z.uuid()}).strict();
 const P=(method:'GET'|'POST'|'PUT'|'PATCH',schema:z.ZodObject<any>,path:(i:any)=>string,body?:(i:any)=>unknown,options:{read?:boolean;destructive?:boolean}={}):ManageAction=>({schema,read:options.read??method==='GET',destructive:options.destructive,
  run:i=>c.variant(method,path(i),body?body(i):undefined,method==='GET'?undefined:i.operationId)});
 tool('products_manage','Productos del perfil','Productos padre con sus variantes por mercado: consultar, crear (con su primera variante), editar, archivar o restaurar. Crear no asigna números ni envía mensajes.',{
  listar:P('GET',z.object({include:z.enum(['active','all']).optional(),q:z.string().max(160).optional()}).strict(),i=>'/v2/products'+query(i)),
  leer:{schema:z.object({productId:z.uuid()}).strict(),read:true,run:async i=>{const all=await c.variant('GET','/v2/products?include=all') as {id:string}[];const found=all.find(p=>p.id===i.productId.toLowerCase());if(!found)throw Object.assign(new Error('PRODUCT_NOT_FOUND'),{code:'PRODUCT_NOT_FOUND'});return found;}},
  crear:P('POST',operation.extend({name:z.string().min(1).max(160),description:z.string().max(4000).optional(),variant:z.object({name:z.string().min(1).max(160),locale:variantLocaleSchema}).strict()}).strict(),()=>'/v2/products',({operationId:_,...i})=>i),
  editar:P('PATCH',operation.extend({productId:z.uuid(),expectedVersion:z.number().int().positive(),name:z.string().min(1).max(160),description:z.string().max(4000)}).strict(),i=>'/v2/products/'+id(i.productId),i=>({expected_version:i.expectedVersion,name:i.name,description:i.description})),
  archivar:P('POST',operation.extend({productId:z.uuid(),expectedVersion:z.number().int().positive()}).strict(),i=>'/v2/products/'+id(i.productId)+'/archive',i=>({expected_version:i.expectedVersion}),{destructive:true}),
  restaurar:P('POST',operation.extend({productId:z.uuid(),expectedVersion:z.number().int().positive()}).strict(),i=>'/v2/products/'+id(i.productId)+'/restore',i=>({expected_version:i.expectedVersion})),
  dependencias:P('GET',z.object({productId:z.uuid()}).strict(),i=>'/v2/products/'+id(i.productId)+'/dependencies'),
 });
 tool('materials_manage','Materiales privados','Archivos y enlaces que reciben tus clientes. Los archivos se suben en partes de 4 MiB (base64), se verifican por tamaño y SHA-256 y se guardan cifrados. Eliminar sólo los oculta de configuraciones nuevas.',{
  listar:P('GET',z.object({q:z.string().max(160).optional(),include:z.enum(['active','all']).optional()}).strict(),i=>'/v2/materials'+query(i)),
  leer:P('GET',z.object({materialId:z.uuid()}).strict(),i=>'/v2/materials/'+id(i.materialId)),
  iniciar_subida:P('POST',operation.extend({kind:z.enum(['file','link']),name:z.string().min(1).max(160),mime_type:z.string().max(80).optional(),size_bytes:z.number().int().positive().optional(),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),link:z.string().max(2000).optional()}).strict(),()=>'/v2/materials',({operationId:_,link,...i})=>({...i,...(link?{url:link}:{})})),
  parte:{schema:z.object({materialId:z.uuid(),part:z.number().int().min(1).max(10),base64:z.string().max(5_600_000)}).strict(),read:false,run:i=>c.variant('PUT','/v2/materials/'+id(i.materialId)+'/parts/'+i.part,{base64:i.base64},crypto.randomUUID())},
  completar:P('POST',operation.extend({materialId:z.uuid()}).strict(),i=>'/v2/materials/'+id(i.materialId)+'/complete',()=>({})),
  cancelar:P('POST',operation.extend({materialId:z.uuid()}).strict(),i=>'/v2/materials/'+id(i.materialId)+'/cancel',()=>({}),{destructive:true}),
  eliminar:P('POST',operation.extend({materialId:z.uuid(),expectedVersion:z.number().int().positive()}).strict(),i=>'/v2/materials/'+id(i.materialId)+'/archive',i=>({expected_version:i.expectedVersion}),{destructive:true}),
 });
 const section=z.enum(variantSections);
 tool('variants_manage','Variantes de mercado','Cada variante es un mercado del producto (país, moneda, idioma, zona) con cinco secciones. Editar guarda un borrador; publicar aplica a conversaciones nuevas y no asigna números ni envía mensajes.',{
  listar:P('GET',z.object({productId:z.uuid().optional(),include:z.enum(['active','all']).optional()}).strict(),i=>'/v2/variants'+query({product_id:i.productId,include:i.include})),
  leer:P('GET',variantId,i=>'/v2/variants/'+id(i.variantId)),
  adoptar:P('POST',operation.extend({productId:z.uuid()}).strict(),i=>'/v2/products/'+id(i.productId)+'/adopt',()=>({})),
  crear:P('POST',operation.extend({productId:z.uuid(),name:z.string().min(1).max(160),locale:variantLocaleSchema}).strict(),()=>'/v2/variants',i=>({product_id:i.productId,name:i.name,locale:i.locale})),
  editar:P('PUT',operation.extend({variantId:z.uuid(),section,expectedVersion:z.number().int().positive(),value:z.unknown()}).strict(),i=>'/v2/variants/'+id(i.variantId)+'/'+(i.section==='locale'?'market':i.section),i=>({expected_version:i.expectedVersion,value:i.value})),
  revisar:P('POST',operation.extend({variantId:z.uuid(),expectedVersion:z.number().int().positive(),reviewed:z.array(z.enum(['language','price_currency','collection','flow_seller','remarketing','materials'])).min(1).max(6)}).strict(),i=>'/v2/variants/'+id(i.variantId)+'/review',i=>({expected_version:i.expectedVersion,reviewed:i.reviewed})),
  duplicar:P('POST',operation.extend({variantId:z.uuid(),name:z.string().min(1).max(160),locale:variantLocaleSchema}).strict(),i=>'/v2/variants/'+id(i.variantId)+'/duplicate',i=>({name:i.name,locale:i.locale})),
  publicar:P('POST',operation.extend({variantId:z.uuid(),expectedVersion:z.number().int().positive(),documentSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),i=>'/v2/variants/'+id(i.variantId)+'/publish',i=>({expected_version:i.expectedVersion,document_sha256:i.documentSha256})),
  version:P('GET',z.object({releaseId:z.uuid()}).strict(),i=>'/v2/market/releases/'+id(i.releaseId)+'?environment=REAL'),
  historial:P('GET',variantId,i=>'/v2/variants/'+id(i.variantId)+'/history'),
  archivar:P('POST',operation.extend({variantId:z.uuid(),expectedVersion:z.number().int().positive()}).strict(),i=>'/v2/variants/'+id(i.variantId)+'/archive',i=>({expected_version:i.expectedVersion}),{destructive:true}),
  restaurar:P('POST',operation.extend({variantId:z.uuid(),expectedVersion:z.number().int().positive()}).strict(),i=>'/v2/variants/'+id(i.variantId)+'/restore',i=>({expected_version:i.expectedVersion})),
  consultar_operacion:P('GET',z.object({operationId:z.uuid()}).strict(),i=>'/v2/variant-operations/'+id(i.operationId)),
 });
 // One tool per variant section (Inventario V7): read, save, check what is
 // missing, publish the variant, history. Same service as the application.
 const sectionTool=(name:string,title:string,description:string,path:string,value:z.ZodType,publish:boolean,extra:Record<string,ManageAction>={})=>tool(name,title,description,{
  leer:P('GET',variantId,i=>'/v2/variants/'+id(i.variantId)+'/'+path),
  guardar:P('PUT',operation.extend({variantId:z.uuid(),expectedVersion:z.number().int().positive(),value}).strict(),i=>'/v2/variants/'+id(i.variantId)+'/'+path,i=>({expected_version:i.expectedVersion,value:i.value})),
  validar:{schema:variantId,read:true,run:async i=>{const v=await c.variant('GET','/v2/variants/'+id(i.variantId)) as {state:string;state_label:string;missing:unknown[];unpublished_changes:boolean};return{state:v.state,state_label:v.state_label,missing:v.missing,unpublished_changes:v.unpublished_changes};}},
  ...(publish?{publicar:P('POST',operation.extend({variantId:z.uuid(),expectedVersion:z.number().int().positive(),documentSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),i=>'/v2/variants/'+id(i.variantId)+'/publish',i=>({expected_version:i.expectedVersion,document_sha256:i.documentSha256}))}:{}),
  historial:P('GET',variantId,i=>'/v2/variants/'+id(i.variantId)+'/history'),
  ...extra,
 });
 sectionTool('offers_manage','Oferta y materiales de la variante','Precio, tiers y qué recibe el cliente y cuándo. Guardar deja un borrador; publicar aplica a conversaciones nuevas.','offer',variantOfferSchema,true);
 sectionTool('sales_flows_manage','Flujo de venta de la variante','Flujo base (venta por conversación o guiado) con sus mensajes en lenguaje de operación.','sales-flow',z.record(z.string(),z.unknown()),true);
 sectionTool('sellers_manage','Vendedor de la variante','Nombre, instrucciones, conocimiento y límites del vendedor; el idioma es el de la variante.','seller',variantSellerSchema,true);
 sectionTool('remarketing_manage','Remarketing de la variante','Hasta tres seguimientos (texto, audio o video) para quien no acepta o no paga, con horario permitido en la zona de la variante. Se detienen si la persona compra, responde o pide la baja. Guardar deja un borrador; publicar aplica a conversaciones nuevas.','remarketing',remarketingPolicySchema.nullable(),true,{
  // RF-10.e: what the follow-ups did in a period (cycles, sent, replies, sales and revenue recovered).
  resultados:P('GET',z.object({variantId:z.uuid(),from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/)}).strict(),i=>'/v2/variants/'+id(i.variantId)+'/remarketing/results?from='+i.from+'&to='+i.to),
  // RF-10.c: the same cycles and reprogramming the application shows.
  ciclos:P('GET',z.object({variantId:z.uuid(),status:z.enum(['OPEN','CLOSED','ALL']).optional(),limit:z.number().int().min(1).max(100).optional()}).strict(),i=>'/v2/variants/'+id(i.variantId)+'/remarketing/cycles'+query({...(i.status?{status:i.status}:{}),...(i.limit?{limit:String(i.limit)}:{})})),
  previsualizar_reprogramacion:P('POST',z.object({variantId:z.uuid(),cycleId:z.uuid()}).strict(),i=>'/v2/variants/'+id(i.variantId)+'/remarketing/cycles/'+id(i.cycleId)+'/reprogram/preview',()=>({}),{read:true}),
  reprogramar:P('POST',operation.extend({variantId:z.uuid(),cycleId:z.uuid(),expectedRevision:z.number().int().positive(),previewHash:z.string().regex(/^[a-f0-9]{64}$/),previewedAt:z.string().datetime()}).strict(),i=>'/v2/variants/'+id(i.variantId)+'/remarketing/cycles/'+id(i.cycleId)+'/reprogram',i=>({expected_revision:i.expectedRevision,preview_hash:i.previewHash,previewed_at:i.previewedAt})),
 });
 sectionTool('collections_manage','Cobro de la variante','SPEI y/o enlace de pago. Los datos se guardan cifrados y nunca se devuelven completos.','collection',collectionInputSchema,false);
 tool('receipt_rules_manage','Reglas de comprobantes','Consulta o guarda las reglas de validación de comprobantes del perfil o de una variante.',
  fromUnion(receiptPolicyCommand,{get_profile:'leer_perfil',get_variant:'leer_variante',save_profile:'guardar_perfil',save_variant:'guardar_variante',reconcile:'consultar_operacion'},op=>op.startsWith('get')||op==='reconcile',i=>c.receiptPolicies(i)));
 const receiptId=z.object({receiptId:z.uuid()}).strict();
 // V7 F8 (RF-15.a): Ventas → Conversaciones y Pedidos by MCP, with the same
 // routes, permissions and command shape as the application. A command with
 // an unconfirmed outcome is read back once; repeating the same operationId
 // never repeats the effect.
 const sales=async(command:ProfileSalesMutation)=>{
  try{return await c.sales.write(command);}
  catch(error){
   if(!(error instanceof ProfileSalesError)||error.code!=='SALES_UNCONFIRMED')throw error;
   const pointer=profileSalesPointer.parse({operation:command.operation,operation_id:command.operation_id,resource_id:command.resource_id,environment:command.environment,request_sha256:createHash('sha256').update(JSON.stringify(command)).digest('hex')});
   try{return{command_id:(await c.sales.reconcile(pointer)).id,read_back:true};}
   catch{throw Object.assign(Error('SALES_UNCONFIRMED'),{code:'SALES_UNCONFIRMED'});}
  }
 };
 const conversationId=z.object({conversationId:z.uuid()}).strict();
 const reasoned=z.object({operationId:z.uuid(),conversationId:z.uuid(),reason:z.string().trim().min(3).max(2000)}).strict();
 const control=(body:{paused?:boolean;takeover?:boolean;suppressed?:boolean}):ManageAction=>({schema:reasoned,read:false,run:i=>sales({operation:'conversation.controls',operation_id:i.operationId,resource_id:i.conversationId,environment:'REAL',body:{...body,reason:i.reason}})});
 const listQuery=z.object({q:z.string().max(160).optional(),status:z.string().max(100).optional(),stage:z.string().max(100).optional(),limit:z.number().int().min(1).max(50).optional(),offset:z.number().int().min(0).max(10000).optional()}).strict();
 tool('conversations_manage','Conversaciones','Conversaciones del perfil con su producto, etapa y mensajes. Responder envía un mensaje real por WhatsApp a esa persona; tomar el control detiene al vendedor automático hasta liberarlo. No hace envíos masivos.',{
  listar:{schema:listQuery,read:true,run:i=>c.sales.read({operation:'list',resource:'conversations',environment:'REAL',limit:20,offset:0,...i})},
  leer:{schema:conversationId,read:true,run:i=>c.sales.read({operation:'get',resource:'conversations',id:i.conversationId,environment:'REAL'})},
  responder:{schema:z.object({operationId:z.uuid(),conversationId:z.uuid(),text:z.string().min(1).max(4096),expectedVersion:z.number().int().positive()}).strict(),read:false,
   run:i=>sales({operation:'conversation.command',operation_id:i.operationId,resource_id:i.conversationId,environment:'REAL',body:{type:'send_message',kind:'text',text:i.text,expected_version:i.expectedVersion}})},
  registrar_acuerdo:{schema:z.object({operationId:z.uuid(),conversationId:z.uuid()}).strict(),read:false,run:i=>sales({operation:'conversation.command',operation_id:i.operationId,resource_id:i.conversationId,environment:'REAL',body:{type:'commitment'}})},
  cerrar:{schema:reasoned,read:false,destructive:true,run:i=>sales({operation:'conversation.command',operation_id:i.operationId,resource_id:i.conversationId,environment:'REAL',body:{type:'close_conversation',reason:i.reason}})},
  registrar_baja:{schema:reasoned,read:false,destructive:true,run:i=>sales({operation:'conversation.command',operation_id:i.operationId,resource_id:i.conversationId,environment:'REAL',body:{type:'opt_out',reason:i.reason}})},
  tomar_control:control({takeover:true}),
  liberar_control:control({takeover:false}),
  pausar:control({paused:true}),
  reanudar:control({paused:false}),
 });
 tool('orders_manage','Pedidos','Pedidos del perfil con su producto, monto y estado de pago. Sólo lectura: los pagos se aprueban en Comprobantes.',{
  listar:{schema:listQuery,read:true,run:i=>c.sales.read({operation:'list',resource:'orders',environment:'REAL',limit:20,offset:0,...i})},
  leer:{schema:z.object({orderId:z.uuid()}).strict(),read:true,run:i=>c.sales.read({operation:'get',resource:'orders',id:i.orderId,environment:'REAL'})},
 });
 tool('receipts_manage','Comprobantes','Cola de comprobantes: primero los que esperan una decisión. Cada uno trae su resultado (Aprobado, Por revisar, Rechazado, Prueba o Falso) y la regla que lo decidió. Revisar aprueba o rechaza uno; el archivo se abre en la aplicación.',{
  listar:P('GET',z.object({view:z.enum(['pending','all']).optional(),limit:z.number().int().min(1).max(100).optional(),offset:z.number().int().min(0).optional()}).strict(),i=>'/v2/receipts'+query(i)),
  leer:P('GET',receiptId,i=>'/v2/receipts/'+id(i.receiptId)),
  // The image or PDF of a customer's payment stays in the app (never in an AI context).
  archivo:{schema:receiptId,read:true,run:async i=>{const raw=await c.variant('GET','/v2/receipts/'+id(i.receiptId)) as Record<string,unknown>;
   const r=(raw&&typeof raw==='object'&&'data' in raw?raw.data:raw) as {has_document?:boolean;mime_type?:string|null}|undefined;
   return{data:{available:r?.has_document===true,mime_type:r?.mime_type??null,open_in_app:'/sales/receipts?receipt='+id(i.receiptId)}};}},
  revisar:P('POST',operation.extend({receiptId:z.uuid(),decision:z.enum(['APPROVED','REJECTED']),expectedVersion:z.number().int().positive(),reason:z.string().max(300).optional()}).strict(),
   i=>'/v2/receipts/'+id(i.receiptId)+'/decision',i=>({decision:i.decision,expected_version:i.expectedVersion,...(i.reason?{reason:i.reason}:{})})),
 });
 // V7 F6 (RF-19.a/l): «Probar número» by task. The estimate comes first and the
 // start accepts its ceiling; nothing in a test reaches WhatsApp or REAL data.
 const runId=z.object({runId:z.uuid()}).strict();
 const step=(action:(i:any)=>unknown,extra:z.ZodRawShape={})=>P('POST',operation.extend({runId:z.uuid(),expectedVersion:z.number().int().positive(),...extra}).strict(),
  i=>'/v2/number-tests/'+id(i.runId)+'/actions',i=>({expected_version:i.expectedVersion,action:action(i)}));
 tool('number_test_manage','Probar número','Prueba un número como lo vería un cliente, con la configuración vigente fijada al iniciar. Primero estima el costo máximo de IA (lo paga la clave del perfil); crear acepta ese máximo. Cada acción se aplica en segundo plano: lee la prueba para ver la conversación y el siguiente paso. Nada se envía por WhatsApp ni cuenta como venta.',{
  // RF-19.i: what blocks the test (or leaves part of it out) and where to fix it.
  diagnosticar:P('GET',z.object({accountId:z.uuid()}).strict(),i=>'/v2/number-tests/diagnose?account_id='+id(i.accountId)),
  estimar:{schema:z.object({accountId:z.uuid(),mode:z.enum(['CHAT']).optional()}).strict(),read:true,run:i=>c.variant('POST','/v2/number-tests/estimate',{account_id:i.accountId,mode:i.mode??'CHAT'},crypto.randomUUID())},
  crear:P('POST',operation.extend({accountId:z.uuid(),acceptedMaximumMicrousd:z.number().int().positive()}).strict(),()=>'/v2/number-tests',i=>({account_id:i.accountId,mode:'CHAT',accepted_maximum_microusd:i.acceptedMaximumMicrousd})),
  leer:P('GET',runId,i=>'/v2/number-tests/'+id(i.runId)),
  // RF-19.p/h: the automatic buyer over every variant of a number: estimate,
  // start with that ceiling, then read the report (one verdict per variant).
  estimar_suite:{schema:z.object({accountId:z.uuid()}).strict(),read:true,run:i=>c.variant('POST','/v2/number-tests/suites/estimate',{account_id:i.accountId},crypto.randomUUID())},
  ejecutar_suite:P('POST',operation.extend({accountId:z.uuid(),acceptedMaximumMicrousd:z.number().int().positive()}).strict(),()=>'/v2/number-tests/suites',i=>({account_id:i.accountId,accepted_maximum_microusd:i.acceptedMaximumMicrousd})),
  informe:P('GET',z.object({suiteId:z.uuid().optional(),accountId:z.uuid().optional()}).strict().refine(i=>!!i.suiteId!==!!i.accountId,'suiteId o accountId'),i=>i.suiteId?'/v2/number-tests/suites/'+id(i.suiteId):'/v2/number-tests/suites/latest?account_id='+id(i.accountId!)),
  // RF-19.o: the whole test as JSON while it is kept (30 days).
  exportar:P('GET',runId,i=>'/v2/number-tests/'+id(i.runId)+'/export'),
  ultima:P('GET',z.object({accountId:z.uuid().optional()}).strict(),i=>'/v2/number-tests/latest'+(i.accountId?'?account_id='+id(i.accountId):'')),
  mensaje:step(i=>({type:'message',text:i.text}),{text:z.string().trim().min(1).max(4096)}),
  seleccionar:step(i=>({type:'select_variant',variant_id:i.variantId,origin:i.entry??'EXPLICIT'}),{variantId:z.uuid(),entry:z.enum(['EXPLICIT','ADVERTISEMENT']).optional()}),
  avanzar_reloj:step(i=>({type:'advance',hours:i.hours}),{hours:z.union([z.literal(2),z.literal(8),z.literal(24)])}),
  continuar:step(()=>({type:'continue'})),
  // RF-19.d: the customer sends an example receipt (image or PDF ≤4 MB, base64);
  // the test reads it with the profile's key and decides it with its rules.
  adjuntar:{schema:operation.extend({runId:z.uuid(),expectedVersion:z.number().int().positive(),mimeType:z.enum(['image/png','image/jpeg','image/webp','application/pdf']),base64:z.string().min(4).max(5_600_000).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict(),read:false,run:async i=>{
   const raw=await c.variant('POST','/v2/number-tests/'+id(i.runId)+'/attachments',{mime_type:i.mimeType,base64:i.base64},crypto.randomUUID()) as Record<string,unknown>;
   const saved=(raw&&typeof raw==='object'&&'data' in raw?raw.data:raw) as {attachment_id:string};
   return c.variant('POST','/v2/number-tests/'+id(i.runId)+'/actions',{expected_version:i.expectedVersion,action:{type:'receipt',attachment_id:saved.attachment_id}},i.operationId);}},
  revisar_comprobante:step(i=>({type:'review_receipt',receipt_id:i.receiptId,decision:i.decision,reason:i.reason}),{receiptId:z.uuid(),decision:z.enum(['APPROVED','REJECTED']),reason:z.string().trim().min(1).max(500)}),
  // A new test of the same number with the configuration current now.
  reiniciar:{schema:operation.extend({runId:z.uuid(),acceptedMaximumMicrousd:z.number().int().positive()}).strict(),read:false,run:async i=>{
   const v=await c.variant('GET','/v2/number-tests/'+id(i.runId)) as {run:{account_id:string}};
   return c.variant('POST','/v2/number-tests',{account_id:v.run.account_id,mode:'CHAT',accepted_maximum_microusd:i.acceptedMaximumMicrousd},i.operationId);}},
 });
 // V7 F7 (RF-11, RF-09.k): read only; spend, conversations and the sales they brought.
 const period=z.object({from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),currency:z.string().regex(/^[A-Z]{3}$/).optional()}).strict();
 const campaigns=(pick:(v:any)=>unknown):ManageAction=>({schema:period,read:true,run:async i=>{const raw=await c.variant('GET','/v2/campaigns?from='+i.from+'&to='+i.to+(i.currency?'&currency='+i.currency:'')) as any;const v=raw&&typeof raw==='object'&&'data' in raw?raw.data:raw;return pick(v);}});
 tool('campaigns_read','Campañas (sólo lectura)','Gasto, conversaciones, ventas e ingresos atribuidos por campaña y anuncio, cruzados con la hoja de pagos. Sólo lee: no crea, pausa ni cambia presupuesto; sincronizar_lectura pide una lectura nueva a Meta.',{
  cuentas:campaigns(v=>({connected:v.connected,accounts:v.accounts})),
  resultados:campaigns(v=>({connected:v.connected,summary:v.report?.summary??null,quality:v.report?.quality??null})),
  campanas:campaigns(v=>({connected:v.connected,campaigns:v.report?.groups.campaigns??[]})),
  anuncios:campaigns(v=>({connected:v.connected,ads:v.report?.groups.ads??[]})),
  // Asks for a fresh GET-only read with the profile's own token (owner, integrations:write).
  sincronizar_lectura:{schema:z.object({operationId:z.uuid()}).strict(),read:false,run:i=>c.variant('POST','/v2/campaigns/sync',{},i.operationId)},
 });
 tool('payments_manage','Pagos','Consulta y exporta el registro de pagos con los mismos filtros de la aplicación; no aprueba pagos.',
  fromUnion(paymentsCommandSchema,{options:'opciones',list:'listar',export:'exportar'},()=>true,async i=>{const r=await c.payments(i);if(r.operation!=='export')return r;const {bytes,...meta}=r;return{...meta,bytesBase64:Buffer.from(bytes).toString('base64')};}));
 tool('results_read','Resultados','Resultados del perfil sin mezclar monedas; sin datos no equivale a cero.',
  fromUnion(resultsCommandSchema,{options:'opciones',report:'resumen'},()=>true,i=>c.results(i)));
 tool('goals_manage','Metas','Lista, consulta y edita metas con UUID de operación; si el resultado no es concluyente, consulta la operación.',
  fromUnion(resultsCommandSchema,{goals:'listar',goal:'leer',progress:'avance',create:'crear',update:'editar',reconcile:'consultar_operacion'},op=>!['create','update'].includes(op),i=>c.results(i)));
 // V7 F7 (RF-16.d): the in-app help, the same text for people and assistants.
 tool('help_read','Ayuda','Guía de Commerce OS en español: empezar a vender, día a día, probar números, operar con IA, buenas prácticas de WhatsApp, privacidad, términos y API.',{
  guia:v('GET',z.object({section:z.string().regex(/^[a-z-]{2,40}$/).optional()}).strict(),i=>'/v2/help'+(i.section?'?section='+i.section:''))(c.v2),
  descargar:{schema:empty,read:true,run:async()=>({format:'text/markdown',markdown:helpMarkdown()})},
 });
 tool('home_get','Inicio del perfil','Resumen de Inicio: números conectados y aptos para atender (con causas), ventas de hoy, pendientes y siguiente paso.',{
  resumen:v('GET',empty,()=>'/v2/home')(c.v2),
 });
 const usage=(pick:(u:any)=>unknown):ManageAction=>({schema:empty,read:true,run:async()=>pick(await c.v2('GET','/v2/usage'))});
 tool('usage_read','Uso del perfil','Uso observado junto a los límites configurados del perfil; nunca un pronóstico.',{
  conversaciones:usage(u=>({timezone:u.timezone,conversationsToday:u.conversationsToday})),numeros:usage(u=>({numbers:u.numbers})),
  almacenamiento:usage(u=>({storage:u.storage})),costo_ia:usage(u=>({aiCost:u.aiCost})),cuotas:usage(u=>u),
 });
 tool('audit_read','Auditoría del perfil','Acciones sensibles del perfil (quién, qué, cuándo) sin contenido de conversaciones ni secretos. Exportar requiere permiso de Dueño.',{
  listar:v('GET',z.object({before:z.iso.datetime({offset:true}).optional(),limit:z.number().int().min(1).max(200).optional()}).strict(),i=>'/v2/audit'+query(i))(c.v2),
  exportar:v('GET',empty,()=>'/v2/audit/export?format=json')(c.v2),
 });
 tool('operations_get','Resultado de una operación','Consulta el resultado registrado de una operación propia por su UUID antes de repetirla.',{
  leer_resultado:v('GET',z.object({operationId:z.uuid()}).strict(),i=>'/v2/operations/'+id(i.operationId))(c.v2),
 });
 const command=continuityRequestSchema.options.find(o=>(o.shape.operation as z.ZodLiteral<string>).value==='command')!;
 const {operation:_operation,action:_action,...commandShape}=command.shape as Record<string,z.ZodType>;
 const human=(action:'pause'|'resume'|'revoke'):ManageAction=>({schema:z.object(commandShape).strict(),read:false,destructive:action!=='resume',run:i=>c.continuity({...i,operation:'command',action})});
 tool('number_assignments_manage','Números que venden cada variante','Autorizaciones permanentes de los números asignados y la relación número↔variante. Asignar un número exige a la persona en la aplicación; retirar se puede hacer aquí. No envía mensajes.',{
  ...fromUnion(continuityRequestSchema,{list:'autorizaciones',get:'autorizacion',receipt:'consultar_operacion',issue:'autorizar'},op=>['list','get','receipt'].includes(op),i=>c.continuity(i)),
  pausar:human('pause'),reanudar:human('resume'),revocar:human('revoke'),
  asignar:{schema:z.object({variantId:z.uuid(),numberId:z.uuid()}).strict(),read:false,run:humanAction('/products','Vender una variante en un número es una decisión humana en la aplicación (Productos → variante → Números).')},
  retirar:P('POST',operation.extend({variantId:z.uuid(),numberId:z.uuid()}).strict(),i=>'/v2/variants/'+id(i.variantId)+'/numbers',i=>({account_id:i.numberId,sell:false}),{destructive:true}),
  impacto:P('GET',z.object({variantId:z.uuid(),numberId:z.uuid()}).strict(),i=>'/v2/variants/'+id(i.variantId)+'/numbers/'+id(i.numberId)+'/impact'),
  historial:P('GET',z.object({numberId:z.uuid()}).strict(),i=>'/v2/number-variants/'+id(i.numberId)+'/history'),
  vista_inversa:P('GET',z.object({offerId:z.uuid().optional()}).strict(),i=>'/v2/number-variants'+query({offer_id:i.offerId})),
 });

 // V7 F3 (RF-07, wireframe D): the number journey. The QR is shown only in the
 // application to the person who scans it; no tool returns QR material.
 const numberId=z.object({numberId:z.uuid()}).strict(),countries=Object.keys(numberCountries) as [NumberCountry,...NumberCountry[]];
 tool('numbers_manage','Números de WhatsApp','Lista tus números con estado legible, agrega uno (alias, país y número privado), consulta el impacto antes de eliminar y elimina conservando la historia. Agregar no conecta ni envía.',{
  listar:{schema:empty,read:true,run:()=>c.v1('GET','/v1/numbers/overview')},
  leer:{schema:numberId,read:true,run:i=>c.v1('GET','/v1/numbers/'+id(i.numberId)+'/link')},
  crear:{schema:z.object({operationId:z.uuid(),alias:z.string().trim().min(2).max(100),country:z.enum(countries),phone:z.string().trim().min(4).max(32).optional()}).strict(),read:false,
   run:i=>c.v1('POST','/v1/numbers/quick',{alias:i.alias,country:i.country,...(i.phone?{phone:i.phone}:{})},i.operationId)},
  impacto_eliminar:{schema:numberId,read:true,run:i=>c.v1('GET','/v1/numbers/'+id(i.numberId)+'/removal')},
  eliminar:{schema:z.object({operationId:z.uuid(),numberId:z.uuid(),expectedVersion:z.number().int().positive()}).strict(),read:false,destructive:true,
   run:i=>c.v1('POST','/v1/numbers/'+id(i.numberId)+'/removal',{expected_version:i.expectedVersion,confirmation:'REMOVE_NUMBER'},i.operationId)},
 });
 const qr=humanAction('/numbers','El QR se muestra sólo en la aplicación, a la persona que lo escanea con su teléfono.');
 tool('number_connection_manage','Conexión del número','Estado de la vinculación del número. Conectar o vincular se hace en la aplicación con el QR; desconectar cierra la sesión de ese número sin borrar su historia.',{
  estado:{schema:numberId,read:true,run:i=>c.v1('GET','/v1/numbers/'+id(i.numberId)+'/link')},
  conectar:{schema:numberId,read:false,run:qr},vincular:{schema:numberId,read:false,run:qr},
  desconectar:{schema:z.object({operationId:z.uuid(),numberId:z.uuid()}).strict(),read:false,destructive:true,run:i=>c.v1('POST','/v1/numbers/'+id(i.numberId)+'/link',{action:'unlink'},i.operationId)},
  pausar:{schema:z.object({operationId:z.uuid(),numberId:z.uuid()}).strict(),read:false,destructive:true,run:i=>c.v1('POST','/v1/numbers/'+id(i.numberId)+'/pause',{paused:true},i.operationId)},
  reanudar:{schema:z.object({operationId:z.uuid(),numberId:z.uuid()}).strict(),read:false,run:i=>c.v1('POST','/v1/numbers/'+id(i.numberId)+'/pause',{paused:false},i.operationId)},
 });
 tool('alerts_manage','Avisos del perfil','Avisos abiertos sobre números y envíos, en lenguaje de operación, con el enlace a resolverlos. Acusar recibo no resuelve la causa.',{
  listar:v('GET',z.object({include:z.enum(['open','all']).optional()}).strict(),i=>'/v2/alerts'+query(i))(c.v2),
  leer:{schema:z.object({alertId:z.uuid()}).strict(),read:true,run:async i=>{const r=await c.v2('GET','/v2/alerts?include=all') as {alerts:{id:string}[]};const found=r.alerts.find(a=>a.id===i.alertId.toLowerCase());if(!found)throw Object.assign(new Error('ALERT_NOT_FOUND'),{code:'ALERT_NOT_FOUND'});return found;}},
  acusar:v('POST',z.object({alertId:z.uuid()}).strict(),i=>'/v2/alerts/'+id(i.alertId)+'/acknowledge',()=>({}))(c.v2),
 });
 // D-17: connecting by QR authorizes same-profile warm-up permanently. Pausing
 // or resuming it is a human command on that grant; a pause is never lifted
 // automatically. Progress needs evidence of days, never elapsed time alone.
 const warmupCommand=(action:'pause'|'resume'):ManageAction=>({schema:z.object({operationId:z.uuid(),numberId:z.uuid()}).strict(),read:false,destructive:action==='pause',run:async i=>{
  const listed=await c.continuity({operation:'list',purpose:'warmup',environment:'REAL',accountId:i.numberId,limit:20}) as {data:{id:string;version:number;revokedAt:string|null;createdAt:string}[]};
  const grant=[...listed.data].filter(g=>!g.revokedAt).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];
  if(!grant)throw Object.assign(new Error('WARMUP_NOT_AUTHORIZED'),{code:'WARMUP_NOT_AUTHORIZED'});
  return c.continuity({operation:'command',purpose:'warmup',id:grant.id,environment:'REAL',operationId:i.operationId,expectedVersion:grant.version,action});
 }});
 tool('warmup_manage','Calentamiento del número','Progreso del calentamiento automático con su evidencia, y pausa o reanudación explícitas. Sólo entre números propios del mismo perfil; nunca contacta clientes.',{
  progreso:{schema:numberId,read:true,run:i=>c.v1('GET','/v1/numbers/'+id(i.numberId)+'/preparation')},
  evidencia:{schema:numberId,read:true,run:i=>c.v1('GET','/v1/numbers/'+id(i.numberId)+'/episodes')},
  pausar:warmupCommand('pause'),reanudar:warmupCommand('resume'),
 });
}
