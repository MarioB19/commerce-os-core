import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {continuityRequestSchema} from '../../../packages/contracts/src/continuous-consumer.js';
import {marketCommandSchema} from '../../../packages/contracts/src/market-variant-client.js';
import {paymentsCommandSchema} from '../../../packages/contracts/src/payments-client.js';
import {profileCatalogResourceSchema} from '../../../packages/contracts/src/profile-catalog-consumer.js';
import {profileCatalogListSchema,profileCatalogVersionsQuerySchema} from '../../../packages/contracts/src/profile-catalog.js';
import {invitationCreateSchema,invitationCancelSchema} from '../../../packages/contracts/src/profile-invitations.js';
import {profileTokenCommandSchema,profileTokenListSchema} from '../../../packages/contracts/src/profile-token-management.js';
import {profileEmployeeInputSchema,profileRoleSchema,profileSettingsInputSchema} from '../../../packages/contracts/src/profiles.js';
import {receiptPolicyCommand} from '../../../packages/contracts/src/receipt-policy-client.js';
import {resultsCommandSchema} from '../../../packages/contracts/src/results-client.js';
import type {ContinuityClient} from '../../../packages/commerce-client/src/continuous-authorization.js';
import type {MarketClient} from '../../../packages/commerce-client/src/market-variants.js';
import type {PaymentsClient} from '../../../packages/commerce-client/src/payments.js';
import type {ProfileCatalogReader} from '../../../packages/commerce-client/src/profile-catalog.js';
import type {ProfileV2Client} from '../../../packages/commerce-client/src/profile-v2.js';
import type {ReceiptPolicyClient} from '../../../packages/commerce-client/src/receipt-policies.js';
import type {ResultsClient} from '../../../packages/commerce-client/src/results.js';
import {humanAction,registerManageTool,type ManageAction} from './manage-tool.js';

export interface ProfileRegistryClients {v2:ProfileV2Client;catalog:ProfileCatalogReader;variants:MarketClient;continuity:ContinuityClient;payments:PaymentsClient;receiptPolicies:ReceiptPolicyClient;results:ResultsClient}
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
const environment=z.object({environment:z.enum(['REAL','SIMULATION']).default('REAL')}).strict();
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
 tool('products_manage','Productos del perfil','Consulta productos, ofertas y recursos del catálogo con sus versiones.',{
  listar:{schema:z.object({resource:profileCatalogResourceSchema,...profileCatalogListSchema.shape}).strict(),read:true,run:i=>c.catalog({...i,operation:'list'})},
  leer:{schema:z.object({resource:profileCatalogResourceSchema,id:z.uuid(),...environment.shape}).strict(),read:true,run:i=>c.catalog({...i,operation:'get'})},
  versiones:{schema:z.object({resource:profileCatalogResourceSchema,id:z.uuid(),...profileCatalogVersionsQuerySchema.shape}).strict(),read:true,run:i=>c.catalog({...i,operation:'versions'})},
 });
 tool('variants_manage','Variantes de mercado','Crea, edita, duplica y publica variantes con revisión explícita. Publicar no activa números ni envía mensajes.',
  fromUnion(marketCommandSchema,{list:'listar',get:'leer',adopt:'adoptar',create:'crear',replace:'editar',copy:'duplicar',publish:'publicar',release:'version',reconcile:'consultar_operacion'},op=>['list','get','release','reconcile'].includes(op),i=>c.variants(i)));
 tool('receipt_rules_manage','Reglas de comprobantes','Consulta o guarda las reglas de validación de comprobantes del perfil o de una variante.',
  fromUnion(receiptPolicyCommand,{get_profile:'leer_perfil',get_variant:'leer_variante',save_profile:'guardar_perfil',save_variant:'guardar_variante',reconcile:'consultar_operacion'},op=>op.startsWith('get')||op==='reconcile',i=>c.receiptPolicies(i)));
 tool('payments_manage','Pagos','Consulta y exporta el registro de pagos con los mismos filtros de la aplicación; no aprueba pagos.',
  fromUnion(paymentsCommandSchema,{options:'opciones',list:'listar',export:'exportar'},()=>true,async i=>{const r=await c.payments(i);if(r.operation!=='export')return r;const {bytes,...meta}=r;return{...meta,bytesBase64:Buffer.from(bytes).toString('base64')};}));
 tool('results_read','Resultados','Resultados del perfil sin mezclar monedas; sin datos no equivale a cero.',
  fromUnion(resultsCommandSchema,{options:'opciones',report:'resumen'},()=>true,i=>c.results(i)));
 tool('goals_manage','Metas','Lista, consulta y edita metas con UUID de operación; si el resultado no es concluyente, consulta la operación.',
  fromUnion(resultsCommandSchema,{goals:'listar',goal:'leer',progress:'avance',create:'crear',update:'editar',reconcile:'consultar_operacion'},op=>!['create','update'].includes(op),i=>c.results(i)));
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
 tool('number_assignments_manage','Autorizaciones de venta de números','Autorizaciones permanentes de los números asignados: consultar, autorizar, pausar, reanudar o revocar. No envía mensajes.',{
  ...fromUnion(continuityRequestSchema,{list:'autorizaciones',get:'autorizacion',receipt:'consultar_operacion',issue:'autorizar'},op=>['list','get','receipt'].includes(op),i=>c.continuity(i)),
  pausar:human('pause'),reanudar:human('resume'),revocar:human('revoke'),
 });
}
