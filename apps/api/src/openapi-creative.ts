import {z} from 'zod';
import {CreativeRecipeSchema,TimedWordSchema} from '../../../packages/creative-contracts/src/index.js';
import {intelligenceQuerySchema} from './intelligence.js';
type Json=Record<string,any>;
const string={type:'string'},uuid={type:'string',format:'uuid'},integer={type:'integer',minimum:1},json={type:'object',additionalProperties:true},date={type:'string',format:'date-time'};
const object=(properties:Json,required:string[]=[])=>({type:'object',properties:{environment:{type:'string',enum:['REAL','SIMULATION'],default:'REAL'},...properties},required:['environment',...required],additionalProperties:false});
const versioned=(properties:Json={},required:string[]=[])=>object({expected_version:integer,...properties},['expected_version',...required]);
const idList={type:'array',items:uuid,maxItems:100};
/** Human, MCP and desktop metadata share one API. Signed object capabilities never become persistent MCP URLs. */
export function documentCreativeApi(spec:Json){spec.components??={};spec.components.schemas??={};
 spec.components.schemas.CreativeRecipe=z.toJSONSchema(CreativeRecipeSchema,{target:'openapi-3.0'});
 spec.components.schemas.TimedWord=z.toJSONSchema(TimedWordSchema,{target:'openapi-3.0'});
 spec.components.schemas.IntelligenceQuery=z.toJSONSchema(intelligenceQuerySchema,{target:'openapi-3.0'});
 spec.components.schemas.CreativeError={type:'object',properties:{error:{type:'object',properties:{code:string,message:string,details:{type:'array',items:json}}}}};
 const bodyDefs:Record<string,Record<string,{summary:string;schema:Json;accepted?:boolean}>>={
 '/v1/intelligence/searches':{post:{summary:'Guardar receta de búsqueda BR/MX; no consume proveedor',schema:object({name:string,query:{$ref:'#/components/schemas/IntelligenceQuery'}},['name','query'])}},
 '/v1/intelligence/searches/{id}':{patch:{summary:'Editar búsqueda y seguimiento opt-in con versión',schema:versioned({name:string,tracking_enabled:{type:'boolean'},daily_budget_minor:{type:'integer',minimum:0,maximum:10000}})}},
 '/v1/intelligence/searches/{id}/refresh':{post:{summary:'Encolar refresh facturable deduplicado;202 no significa completado',schema:versioned(),accepted:true}},
 '/v1/intelligence/import':{post:{summary:'Importar evidencia JSON manual con procedencia; no consume proveedor',schema:versioned({search_id:uuid,observed_at:date,source_url:{type:'string',format:'uri'},ads:{type:'array',items:json,minItems:1,maxItems:100}},['search_id','observed_at','source_url','ads'])}},
 '/v1/intelligence/offers/{id}':{patch:{summary:'Corregir título y etiqueta de agrupación con historial',schema:versioned({title:string,group_label:string,reason:string},['title','group_label','reason'])}},
 '/v1/intelligence/offers/{id}/regroup':{post:{summary:'Separar o mover observaciones entre ofertas conservando historial',schema:versioned({observation_ids:idList,target_offer_id:uuid,title:string,reason:string},['observation_ids','reason'])}},
 '/v1/intelligence/offers/{id}/analyze':{post:{summary:'Analizar texto con Responses y JSON Schema; cache por contenido/prompt/modelo',schema:versioned(),accepted:true}},
 '/v1/intelligence/opportunities':{post:{summary:'Crear oportunidad propia en borrador vinculada a evidencia',schema:object({offer_id:uuid,title:string,notes:string},['offer_id','title'])}},
 '/v1/studio/projects':{post:{summary:'Crear proyecto/brief propio con catálogo compartido',schema:object({title:string,product_id:uuid,offer_id:uuid,brief:json,source_opportunity_id:uuid},['title','product_id'])}},
 '/v1/studio/projects/{id}':{patch:{summary:'Editar brief con concurrencia optimista',schema:versioned({title:string,brief:json})}},
 '/v1/studio/recipes':{post:{summary:'Guardar borrador de receta individual, incluso incompleto',schema:object({project_id:uuid,title:string,recipe:json},['project_id','title','recipe'])}},
 '/v1/studio/recipes/{id}/versions':{post:{summary:'Crear versión JSON inmutable con SHA; producción valida CreativeRecipe',schema:versioned({recipe:json},['recipe'])}},
 '/v1/studio/recipes/{id}/conformity':{post:{summary:'Registrar conformidad de inputs por SHA; separado de revisión editorial',schema:versioned({decision:{type:'string',enum:['APPROVED','REJECTED']},reason:string,authority:{type:'string',enum:['HUMAN','DELEGATED_PILOT']},source:string},['decision','reason','authority','source'])}},
 '/v1/studio/recipes/{id}/quote':{post:{summary:'Validar materiales, inputs y versión; cotizar sin producir',schema:versioned()}},
 '/v1/studio/recipes/{id}/submit':{post:{summary:'Autorizar producción de una versión exacta desde cotización vigente',schema:versioned({quote_id:uuid,max_cost:{type:'number',minimum:0},authorization_id:uuid,preferred_device_id:uuid},['quote_id','max_cost']),accepted:true}},
 '/v1/studio/recipes/{id}/voice-quote':{post:{summary:'Cotizar texto exacto de versión guardada sin consumir proveedor',schema:versioned({text:{type:'string',minLength:1,maxLength:1200},voice_id:string,model_id:{type:'string',enum:['eleven_multilingual_v2','eleven_flash_v2_5']},max_duration_seconds:{type:'number',minimum:0,exclusiveMinimum:true,maximum:60}},['text','voice_id','model_id','max_duration_seconds'])}},
 '/v1/studio/recipes/{id}/voice':{post:{summary:'Generar voz desde cotización durable; nuevo SHA sin heredar aprobaciones',schema:versioned({quote_id:uuid,max_cost_usd:{type:'number',minimum:0,exclusiveMinimum:true,maximum:100}},['quote_id','max_cost_usd']),accepted:true}},
 '/v1/studio/voice-operations/{id}/reconcile':{post:{summary:'Recuperar recibo y archivos de misma voz; UNKNOWN no repite POST pagado',schema:object({expected_version:integer}),accepted:true}},
 '/v1/studio/import-legacy':{post:{summary:'Validar playbook6×3 original y derivar recetas relacionadas; no inicia renders',schema:object({project_id:uuid,bundle:json},['project_id','bundle'])}},
 '/v1/studio/uploads':{post:{summary:'Reservar subida multipart staging; máximo500MiB, transferencia directa a R2',schema:object({project_id:uuid,name:string,size_bytes:{type:'integer',minimum:1,maximum:524288000},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},content_type:string,purpose:{type:'string',enum:['source']},rights:{type:'object',properties:{status:{type:'string',enum:['OWNED','LICENSED']},evidence:string},required:['status','evidence']}},['project_id','name','size_bytes','sha256','content_type','purpose','rights'])}},
 '/v1/studio/uploads/{id}/parts/{partNumber}':{post:{summary:'Obtener capacidad temporal de UploadPart asignado; jamás PUT final',schema:versioned()}},
 '/v1/studio/uploads/{id}/complete':{post:{summary:'Cerrar multipart, verificar bytes/SHA/tipo y promover a objeto final único',schema:versioned()}},
 '/v1/studio/uploads/{id}/reconcile':{post:{summary:'Recuperar estado de sesión propia sin repetir creación multipart incierta',schema:versioned()}},
 '/v1/studio/uploads/{id}/abort':{post:{summary:'Abortar sesión propia y liberar reserva con evidencia',schema:versioned()}},
 '/v1/studio/artifacts/{id}/review':{post:{summary:'Registrar revisión humana editorial o producción por SHA/version',schema:versioned({sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},kind:{type:'string',enum:['EDITORIAL','PRODUCTION']},decision:{type:'string',enum:['APPROVED','CHANGES_REQUESTED']},reason:string},['sha256','kind','decision','reason'])}},
 '/v1/creative/settings/{provider}':{put:{summary:'Configurar proveedor y secreto cifrado; sólo administrador humano',schema:object({expected_version:{type:'integer',minimum:0},enabled:{type:'boolean'},config:json,secret:{...json,writeOnly:true}},['expected_version','enabled','config'])}},
 '/v1/creative/settings/r2/cors':{post:{summary:'Configurar CORS mínimo de biblioteca privada al origen autorizado',schema:object({})}},
 '/v1/creative/budgets':{put:{summary:'Autorizar presupuesto y unidades con vigencia, preservando reservas existentes',schema:object({expected_version:{type:'integer',minimum:0},provider:{type:'string',enum:['searchapi','openai','elevenlabs']},limit_usd:{type:'number',minimum:0,maximum:500},max_units:{type:'integer',minimum:0},expires_at:date,authorization_source:string},['expected_version','provider','limit_usd','max_units','expires_at','authorization_source'])}},
 '/v1/creative/members':{put:{summary:'Owner asigna permisos creativos y proyectos separados de Ventas',schema:object({expected_version:{type:'integer',minimum:0},user_id:string,scopes:{type:'array',items:string,maxItems:9},project_ids:{...idList,nullable:true}},['expected_version','user_id','scopes'])}},
 '/v1/creative/tokens':{post:{summary:'Crear token humano MCP revocable con scopes; no autoaprueba ni contiene keys',schema:object({name:string,scopes:{type:'array',items:string,minItems:1,maxItems:7},expires_at:date},['name','scopes','expires_at'])}},
 '/v1/creative/pairings/{id}/approve':{post:{summary:'Consentir equipo de confianza con código efímero y proyectos explícitos',schema:versioned({user_code:string,project_ids:{...idList,minItems:1}},['user_code','project_ids'])}},
 '/v1/creative/devices/{id}/revoke':{post:{summary:'Revocar token de equipo; rechaza nuevos claims y resultados',schema:versioned({reason:string})}},
 '/v1/creative/provider-operations/{id}/recover':{post:{summary:'Recuperar respuesta OpenAI UNKNOWN por ID remoto sin repetir POST pagado',schema:object({})}}
 };
 const reads:Record<string,string>={
 '/v1/intelligence/searches':'Consultar cache compartido de búsquedas, cobertura y frescura sin llamar proveedor',
 '/v1/intelligence/searches/{id}':'Consultar receta de búsqueda y ejecuciones históricas',
 '/v1/intelligence/runs/{id}':'Consultar estado202, operaciones y observaciones de una ejecución',
 '/v1/intelligence/offers':'Consultar ofertas agrupadas y ranking explicable sin inferir ventas',
 '/v1/intelligence/offers/{id}':'Consultar texto original, síntesisES, fuentes e inferencias separadas',
 '/v1/intelligence/opportunities':'Listar oportunidades en borrador',
 '/v1/studio/projects':'Listar proyectos creativos autorizados',
 '/v1/studio/projects/{id}':'Consultar brief propio y versión del proyecto',
 '/v1/studio/recipes':'Listar recetas y hashes por proyecto',
 '/v1/studio/recipes/{id}':'Consultar versión actual, historia, conformidad y validación de receta',
 '/v1/studio/voice-operations':'Consultar operaciones propias de voz por recipe_id, recuperables tras recargar',
 '/v1/studio/voice-operations/{id}':'Consultar cotización, recibo confirmado, derivados y conflictos de voz',
 '/v1/studio/uploads':'Recuperar sesiones propias pendientes sin keys ni URLs',
 '/v1/studio/uploads/{id}':'Consultar estado y SHA de una sesión propia',
 '/v1/studio/artifacts/{id}':'Consultar artefacto histórico por ID con revisión y archivo privado',
 '/v1/studio/assets':'Listar metadatos y derechos de materiales compartidos',
 '/v1/studio/assets/{id}/access':'Autorizar GET/HEAD temporales específicos; renovar al expirar, Range/seek soportados',
 '/v1/studio/jobs':'Listar trabajos y estados de equipos',
 '/v1/studio/jobs/{id}':'Consultar pasos, intentos, incidencias y QA del trabajo',
 '/v1/studio/artifacts':'Listar archivos reales, revisión y páginas autenticadas; sin URLs persistentes',
 '/v1/creative/settings':'Consultar proveedores, cuota, biblioteca, equipos y bloqueos de preparación',
 '/v1/creative/members':'Consultar permisos creativos por workspace',
 '/v1/creative/devices':'Consultar equipos emparejados de confianza',
 '/v1/creative/pairings':'Consultar solicitud efímera exacta por ID del enlace de emparejamiento'
 };
 const response={description:'Respuesta autenticada y acotada al workspace/entorno',content:{'application/json':{schema:{type:'object',properties:{data:{},job_id:uuid}}}}};
 for(const[path,summary]of Object.entries(reads)){const op=spec.paths?.[path]?.get;if(!op)continue;op.summary=summary;op.tags=[path.includes('/intelligence/')?'Inteligencia · Experimental':'Estudio · Experimental'];op.description='Consulta de metadatos. No inicia consumo pagado ni envíos comerciales.';op.parameters??=[];if(!op.parameters.some((p:Json)=>p.name==='environment'))op.parameters.push({in:'query',name:'environment',schema:{type:'string',enum:['REAL','SIMULATION'],default:'REAL'}});op.responses??={};op.responses['200']??=response;}
 for(const[path,methods]of Object.entries(bodyDefs))for(const[method,def]of Object.entries(methods)){const op=spec.paths?.[path]?.[method];if(!op)continue;op.summary=def.summary;op.tags=[path.includes('/intelligence/')?'Inteligencia · Experimental':'Estudio · Experimental'];op.requestBody={required:true,content:{'application/json':{schema:def.schema}}};op.parameters??=[];if(!op.parameters.some((p:Json)=>String(p.name).toLowerCase()==='idempotency-key'))op.parameters.push({in:'header',name:'Idempotency-Key',required:true,schema:{type:'string',minLength:8,maxLength:160}});op.responses??={};op.responses[def.accepted?'202':'200']??=response;for(const status of ['400','401','403','404','409'])op.responses[status]??={description:status==='409'?'Conflicto de versión, cuota, falta de aprobación o estado no compatible':'Solicitud rechazada',content:{'application/json':{schema:{$ref:'#/components/schemas/CreativeError'}}}};}
 for(const path of ['/v1/studio/assets','/v1/studio/projects','/v1/studio/recipes','/v1/studio/jobs','/v1/studio/artifacts']){const op=spec.paths?.[path]?.get;if(op&&path!=='/v1/studio/projects')op.parameters.push({in:'query',name:'project_id',schema:uuid});}
 const artifacts=spec.paths?.['/v1/studio/artifacts']?.get;if(artifacts){artifacts.parameters.push({in:'query',name:'job_id',schema:uuid,description:'Filtra el trabajo exacto; se combina con project_id y los permisos del usuario.'});artifacts.description+=' Los filtros project_id y job_id son UUID opcionales y se aplican juntos dentro del workspace, entorno y proyectos autorizados.';}
 const access=spec.paths?.['/v1/studio/assets/{id}/access']?.get;if(access)access.parameters.push({in:'query',name:'disposition',schema:{type:'string',enum:['inline','attachment'],default:'inline'}});
 const pair=spec.paths?.['/v1/creative/pairings']?.get;if(pair)pair.parameters.push({in:'query',name:'id',required:true,schema:uuid});
}
