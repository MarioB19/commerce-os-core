import {numberTools,numberRequest} from './numbers.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {CommerceApi,type HttpMethod} from '../../../packages/commerce-client/src/index.js';
import {offerVersionCreateInputSchema,remarketingCycleStatusSchema,remarketingReprogramApplyInputSchema,remarketingReprogramPreviewInputSchema,salesFlowSaveDraftInputSchema,salesFlowValidateInputSchema} from '../../../packages/contracts/src/index.js';
const id=z.string().uuid(),environment=z.enum(['REAL','SIMULATION']).default('REAL'),key=z.string().min(8).max(160),payload=z.record(z.string(),z.unknown());
const resources=z.enum(['products','offers','workflows','agents','assets','channel-accounts','orders','conversations','receipts','simulations']);
const mutation={expected_version:z.number().int().nonnegative(),idempotency_key:key,environment};
export const toolDefinitions={
 ...numberTools,
 command_get:{title:'Consultar resultado durable de comando',description:'Estado y resultado persistidos de un comando. Un resultado incierto exige conciliación, nunca repetición automática.',schema:{command_id:id,environment}},
 channel_session_get:{title:'Consultar continuidad de sesión',description:'Estado observado/deseado, principal declarado, backups, ownership y alertas por cuenta. Sólo lectura.',schema:{account_id:id,environment}},
 channel_session_configure:{title:'Configurar continuidad y principal',description:'Configura responsable, inventario y recuperación explícita con revisión. No concede permisos de envío.',schema:{account_id:id,body:payload,...mutation}},
 channel_primary_usage:{title:'Registrar uso humano del principal',description:'Registra una confirmación del operador con fecha y fuente. Nunca inferir uso de mensajes, ACK o heartbeat WAHA.',schema:{account_id:id,used_at:z.string().datetime({offset:true}),reason:z.string().min(3),...mutation}},
 channel_session_recovery:{title:'Gestionar recuperación de cuenta',description:'Preparar revinculación, solicitar cuarentena, conciliar resultado incierto o acusar alerta. No resetea volúmenes ni repite mutaciones remotas.',schema:{account_id:id,body:payload,...mutation}},
 channel_command:{title:'Solicitar control de sesión',description:'Comando durable por cuenta: enviar expected_version vigente (obligatorio para nuevas altas), consultar resultado antes de otro intento. Conectar o reiniciar requiere autorización específica; software publicado no concede operación.',schema:{account_id:id,expected_version:z.number().int().positive().optional(),type:z.enum(['connect','disconnect','restart','logout','freeze','resume','check_health','transfer_ownership']),owner_id:z.string().optional(),isolation_evidence:z.string().min(5).optional(),reason:z.string().min(3),idempotency_key:key,environment}},

 launch_guide:{title:'Consultar proceso de lanzamiento',description:'Entradas, responsables, estados, evidencia, errores y recuperación de V5. Inteligencia opcional; fábrica sólo en Codex.',schema:{environment}},
 intelligence_search:{title:'Buscar ofertas almacenadas',description:'Evidencia paginada sin consumo proveedor. Continuar con meta.next_cursor.',schema:{q:z.string().max(180).optional(),country:z.enum(['BR','MX']).optional(),cursor:z.string().optional(),limit:z.number().int().min(1).max(100).default(30),environment}},
 intelligence_get_offer:{title:'Leer expediente y fuentes',description:'Expediente observado, análisis y página completa de evidencia. Continuar con evidence_page.next_cursor.',schema:{offer_id:id,cursor:z.string().optional(),limit:z.number().int().min(1).max(100).default(30),environment}},
 intelligence_search_create:{title:'Guardar búsqueda',description:'Guarda una búsqueda; no consulta proveedores.',schema:{name:z.string(),query:payload,idempotency_key:key,environment}},
 intelligence_refresh:{title:'Actualizar búsqueda explícitamente',description:'Consulta facturable sujeta a reservas y límites vigentes; devuelve ejecución durable. No significa completada.',schema:{search_id:id,...mutation}},
 intelligence_analyze:{title:'Analizar evidencia por lotes',description:'Análisis facturable acotado con fuentes; propuestas no cambian oferta comercial.',schema:{offer_id:id,...mutation}},
 intelligence_compare:{title:'Comparar expedientes',description:'Comparación almacenada, con dimensiones, fuentes y vacíos. Cero llamadas proveedor.',schema:{offer_ids:z.array(id).min(2).max(6),environment}},
 intelligence_job_get:{title:'Leer ejecución de Inteligencia',description:'Consulta estado persistido, cobertura y operaciones; independiente de trabajos archivados de video.',schema:{job_id:id,kind:z.enum(['runs','analyses']),environment}},
 intelligence_reconcile:{title:'Conciliar análisis incierto',description:'Recupera resultado existente por ID proveedor y reanuda lotes sin repetir inferencia. Sin ID recuperable conserva reserva.',schema:{analysis_id:id,body:payload,idempotency_key:key,environment}},
 intelligence_batch_get:{title:'Leer lote completo',description:'Obtiene evidencia y resultado de un lote de análisis sin truncarlo.',schema:{analysis_id:id,batch_index:z.number().int().nonnegative(),environment}},
 catalog_list:{title:'Consultar catálogo y operación',description:'Lista recursos por producto y estado; conserva metadata y cursores.',schema:{resource:resources,product_id:id.optional(),q:z.string().optional(),status:z.string().optional(),include_archived:z.boolean().optional(),offset:z.number().int().nonnegative().optional(),limit:z.number().int().min(1).max(100).optional(),environment}},
 catalog_get:{title:'Consultar recurso completo',description:'Lee versión persistida con sus permisos. Sin llamadas proveedor.',schema:{resource:resources,resource_id:id,environment}},
 catalog_create:{title:'Crear recurso comercial',description:'Crea configuración o material terminado por API. No envía mensajes ni genera videos. Registrar una oferta no exige Inteligencia.',schema:{resource:z.enum(['products','offers','workflows','agents','assets']),body:payload,idempotency_key:key,environment}},
 catalog_update:{title:'Editar borrador con revisión',description:'Edita configuración existente con control de concurrencia.',schema:{resource:z.enum(['products','offers','workflows','agents','assets']),resource_id:id,body:payload,...mutation}},
	 catalog_transition:{title:'Validar, publicar internamente o recuperar',description:'La publicación es interna; archivo/restore conserva historia y no reactiva envíos. Consulta dependencies antes de retirar.',schema:{resource:z.enum(['products','offers','workflows','agents','assets']),resource_id:id,action:z.enum(['validate','publish','archive','restore']),body:payload.default({}),...mutation}},
	 offer_version_create:{title:'Crear versión editable de oferta',description:'Crea un sucesor DRAFT inmutable desde la versión elegida con revisión esperada. No publica, activa asignaciones ni envía mensajes.',schema:{offer_id:id,...offerVersionCreateInputSchema.shape,idempotency_key:key,environment}},
	 sales_flow_get:{title:'Leer flujo de venta de una oferta',description:'Lee el borrador versionado y su validación humana: presentación, acuerdo, entregas, cobro, cierre, seguimiento y vendedor. No devuelve secretos de materiales.',schema:{offer_id:id,environment}},
	 sales_flow_validate:{title:'Validar borrador de flujo de venta',description:'Aplica las mismas reglas de web/API a contenido, tres ventanas, materiales, cobro y vendedor sin guardar ni publicar.',schema:{offer_id:id,...salesFlowValidateInputSchema.shape,environment}},
	 sales_flow_save_draft:{title:'Guardar borrador de flujo de venta',description:'Guarda una oferta DRAFT con revisión esperada. No publica, activa asignaciones ni autoriza mensajes.',schema:{offer_id:id,...salesFlowSaveDraftInputSchema.shape,idempotency_key:key,environment}},
 resource_dependencies:{title:'Dependencias antes de eliminar',description:'Consulta referencias y revisión para un retiro recuperable.',schema:{resource:z.enum(['workflows','agents']),resource_id:id,environment}},
 product_configuration:{title:'Preparación del producto',description:'Lee oferta, flujo, vendedor, faltantes y números; configuración separada de activación.',schema:{product_id:id,environment}},
	 remarketing_cycles_list:{title:'Consultar ciclos de seguimiento',description:'Lee snapshot, cupo compartido, intentos y estado por contacto. No reprograma ni envía.',schema:{contact_id:id.optional(),status:remarketingCycleStatusSchema.optional(),environment}},
	 remarketing_reprogram_preview:{title:'Previsualizar reprogramación',description:'Compara una oferta publicada con un ciclo abierto. Conserva consumidos, muestra vencidos y bloqueos de ventana sin crear timers.',schema:{cycle_id:id,...remarketingReprogramPreviewInputSchema.shape,environment}},
	 remarketing_reprogram_apply:{title:'Aplicar reprogramación revisada',description:'Sólo reprograma slots pendientes no iniciados con la vista previa exacta. Nunca repone cupo, reenvía consumidos ni despacha vencidos en ráfaga.',schema:{cycle_id:id,...remarketingReprogramApplyInputSchema.shape,idempotency_key:key,environment}},
 channel_inventory:{title:'Números y productos actuales',description:'Alias enmascarados, identidad, sesión, salud y relaciones. Compartir número no lo hace inutilizable.',schema:{product_id:id.optional(),environment}},
 assignments_list:{title:'Consultar asignaciones independientes',description:'Consulta relaciones número por producto sin elegir la primera.',schema:{product_id:id.optional(),account_id:id.optional(),status:z.enum(['ACTIVE','DRAFT','RETIRED']).optional(),environment}},
 assignments_apply:{title:'Aplicar mapeo elegido',description:'Batch idempotente con resultados parciales. Agregar B conserva A. No habilita sus envíos.',schema:{assignments:z.array(payload).min(1).max(50),idempotency_key:key,environment}},
 assignment_transition:{title:'Consultar o retirar una relación',description:'Revisión, preflight, historial y vista previa read-only del impacto de reemplazar un vínculo. change_preview no modifica chats ni autoriza la aplicación.',schema:{assignment_id:id,action:z.enum(['preflight','history','change_preview','retire','restore','activate']),body:payload.default({}),...mutation}},
 channel_health:{title:'Salud explicable por capacidad',description:'Fuentes, vigencia, muestras/ventanas y causas separadas por propósito; no concede envíos.',schema:{account_id:id,environment}},
 warmup_overview:{title:'Consultar preparación de números',description:'Estado, progreso, planes y evidencia real/simulada separados.',schema:{environment}},
 warmup_preflight:{title:'Preparar activación de warm-up',description:'Devuelve diff y alcance participantes/contenido/límites/vigencia e impacto sobre todos los productos. No envía.',schema:{pool_id:id,body:payload,environment}},
 warmup_activate:{title:'Activar alcance concreto revisado',description:'Requiere autorización concreta vigente, revisión y hash del preflight, participantes propios y confirmación ACTIVATE_REVIEWED_OWN_NUMBERS. La autorización general de implementación no autoriza mensajes.',schema:{pool_id:id,body:payload,idempotency_key:key,environment}},
 warmup_pause:{title:'Pausar o reanudar warm-up',description:'Pausa nuevos claims; reanudación conserva progreso y valida permisos sin reenviar UNKNOWN.',schema:{pool_id:id,action:z.enum(['pause','resume']),body:payload,idempotency_key:key,environment}},
 warmup_simulate:{title:'Ejecutar conversación virtual',description:'SIMULATION reproducible con seed, recepción, ACK, respuesta y fallos. Cero red externa y cero ventas.',schema:{seed:z.number().int().min(0).max(2147483647),participants:z.union([z.literal(2),z.literal(3)]).default(2),at:z.string().datetime().optional(),fault:z.enum(['none','delay','duplicate','out_of_order','accepted_timeout','rejected','peer_disconnected']).default('none'),idempotency_key:key}},
 warmup_simulation_get:{title:'Consultar simulación completa',description:'Lee evidencia persistida del pipeline, sin inventar días o recepción física.',schema:{run_id:id}},
 provider_diagnostic_profiles:{title:'Capacidades de SearchAPI y R2',description:'Metadatos de conexión y pruebas persistidas sin consumo.',schema:{environment}},
 provider_diagnostic_verify:{title:'Verificar proveedor específico',description:'SearchAPI consulta mínima presupuestada; R2 escribe/lee/elimina sólo objeto temporal autorizado. No genera videos ni mensajes.',schema:{profile_key:z.enum(['creative:searchapi','creative:r2']),body:payload,idempotency_key:key,environment}},
 provider_diagnostic_get:{title:'Leer diagnóstico específico',description:'Estado persistido, evidencia, reserva e incertidumbre del mismo intento.',schema:{diagnostic_id:id,environment}},
 provider_diagnostic_reconcile:{title:'Conciliar objeto temporal propio',description:'Recuperación aislada de prueba R2; nunca repite PUT de producción.',schema:{diagnostic_id:id,body:payload,idempotency_key:key,environment}},
 intelligence_corpus_fixture:{title:'Leer corpus y oráculo de evaluación',description:'Doce casos sintéticos fijos y estimación de dos prompts. Cero consumo.',schema:{environment}},
 intelligence_corpus_evaluate:{title:'Evaluar el mismo corpus con dos prompts',description:'Prueba explícita limitada a USD0.10 y límites vigentes inferiores. No crea ofertas ni declara revisión humana.',schema:{body:payload,idempotency_key:key,environment}},
 intelligence_corpus_get:{title:'Leer evaluación comparativa',description:'Resultados, fuentes, cobertura, latencia, costos y fallos observados.',schema:{evaluation_id:id,environment}},
 intelligence_corpus_reconcile:{title:'Conciliar evaluación sin inferir de nuevo',description:'Lee operaciones guardadas; UNKNOWN permanece reservado si no hay resultado.',schema:{evaluation_id:id,idempotency_key:key,environment}},
 integration_profiles:{title:'Configuración y pruebas por perfil',description:'Consulta configuración, inferencia mínima, calidad y habilitación por separado, sin secretos ni consumo.',schema:{environment}},
 integration_verify:{title:'Verificar conexión del perfil',description:'Un clic API ejecuta inferencia sintética mínima, revisión/idempotencia y presupuesto máximo USD0.02. No habilita ventas.',schema:{profile_key:z.enum(['intelligence:openai','openai:default','openai:assistant']),max_cost_usd:z.number().positive().max(.02),...mutation}},
 integration_diagnostic_get:{title:'Consultar diagnóstico',description:'Resultado persistido, usage, costo, error y revisión; UNKNOWN no reinfiere.',schema:{diagnostic_id:id,environment}},
 integration_save:{title:'Guardar perfil cifrado',description:'Configura perfil por API con permisos dedicados. No prueba proveedor ni habilita envíos.',schema:{profile_key:z.string().min(3),body:payload,idempotency_key:key,environment}},
 assistant_context:{title:'Consultar contexto del producto',description:'Obtiene recursos y excepciones del producto para asistencia. Sin consumo modelo.',schema:{product_id:id,environment}},
 assistant_proposal_state:{title:'Resolver propuesta o excepción',description:'Concilia lectura de cambio aplicado o cierra excepción con revisión y motivo. No ejecuta cambios comerciales por sí sola.',schema:{product_id:id,proposal_id:id,body:payload,idempotency_key:key,environment}},
 assistant_propose:{title:'Preparar propuesta contextual',description:'Persiste propuesta/diff con revisión; no declara éxito sin lectura posterior ni ejecuta efectos externos.',schema:{product_id:id,body:payload,idempotency_key:key,environment}},
 proposal_message:{title:'Preparar mensaje para revisión',description:'Guarda propuesta, no la envía. El contexto comercial se conserva por recorrido.',schema:{conversation_id:id,body:payload,...mutation}},
 command_effects:{title:'Consultar efectos',description:'Lee efectos y estados confirmados; ACCEPTED no equivale a entrega.',schema:{command_id:id,environment}},
 simulation_run:{title:'Ensayar flujo sin red',description:'Simula un flujo usando el laboratorio aislado, no crea ingresos reales.',schema:{body:payload,idempotency_key:key}},
 simulation_snapshot:{title:'Copiar configuración al laboratorio',description:'Copia versiones REAL a SIMULATION sin cambiar fuentes ni enviar. Para relación desde la oferta, indicar offer_version_id y expected_offer_version juntos; oferta publicada del mismo producto y flujo exacto. Sin selección usa la oferta fijada por el flujo.',schema:{workflow_version_id:id,expected_version:z.number().int().positive(),offer_version_id:id.optional(),expected_offer_version:z.number().int().positive().optional(),idempotency_key:key}},
 assets_upload_create:{title:'Registrar subida de activo terminado',description:'Inicia subida multipart de archivo existente con hash, producto, derechos y revisión; no genera ni edita video.',schema:{body:payload,idempotency_key:key,environment}},
 assets_upload_operation:{title:'Continuar subida',description:'Consulta/reconcilia la misma subida sin repetir efectos inciertos.',schema:{upload_id:id,action:z.enum(['get','initialize','complete','abort','part']),part:z.number().int().positive().optional(),body:payload.default({}),idempotency_key:key,environment}},
 results_summary:{title:'Resultados del producto',description:'Comprobantes aprobados como ingreso, TEST excluido; importes observados separados de intención.',schema:{product_id:id.optional(),environment}},
 costs_summary:{title:'Costos registrados',description:'Uso confirmado, estimado, reservado y desconocido por producto o recorrido; monedas separadas, sin llamadas al proveedor ni asignaciones inferidas de Inteligencia.',schema:{product_id:id.optional(),conversation_id:id.optional(),environment}},
 seller_effective:{title:'Vendedor del flujo',description:'Lee vendedor y contexto de la oferta del flujo. Si hay varias ofertas, requiere offer_version_id explícito.',schema:{workflow_id:id,offer_version_id:id.optional(),environment}},
 workflow_evaluate:{title:'Evaluar vendedor aislado',description:'Crea evaluación sin mensajes reales con el vendedor y oferta del flujo.',schema:{workflow_id:id,body:payload,idempotency_key:key,environment}},
 evaluation_get:{title:'Leer evaluación',description:'Resultado persistido por escenario y evidencia de calidad.',schema:{evaluation_id:id,environment}},
 evaluation_turn:{title:'Avanzar ensayo aislado',description:'Turno de evaluación con revisión y límites; sin envíos.',schema:{evaluation_id:id,body:payload,idempotency_key:key,environment}},
 launch_tests:{title:'Consultar o preparar ensayo comprador único',description:'Registra alcance TEST de comprador propio, oferta y asignación explícitas. No autoriza mensajes. Sin beneficiaria.',schema:{action:z.enum(['list','create','revoke']),test_id:id.optional(),product_id:id.optional(),body:payload.default({}),idempotency_key:key.optional(),environment}},
 effective_seller:{title:'Vendedor efectivo del recorrido',description:'Consulta proveedor, perfil y preparación de una asignación concreta sin habilitarla.',schema:{account_id:id,assignment_id:id.optional(),environment}},
 assignment_authorize:{title:'Autorizar alcance comercial concreto',description:'Requiere autorización explícita de usuario para destinatarios, límites y vigencia. A no autoriza B. No invocar sólo por publicación de configuración.',schema:{assignment_id:id,body:payload,idempotency_key:key,environment}},
 conversation_select_product:{title:'Elegir producto explícitamente',description:'Selección de operador sobre asignación existente con revisión de chat; conserva historia y no envía mensajes.',schema:{conversation_id:id,assignment_id:id,reason:z.string().min(3),...mutation}},
 archive_production_list:{title:'Consultar archivo histórico',description:'Sólo lectura de proyectos o activos preservados; producción retirada.',schema:{kind:z.enum(['projects','assets']),project_id:id.optional(),cursor:z.string().optional(),limit:z.number().int().min(1).max(100).optional(),environment}}
};
export type ToolName=keyof typeof toolDefinitions;
const query=(v:Record<string,unknown>)=>new URLSearchParams(Object.entries(v).filter(([,x])=>x!==undefined).map(([k,x])=>[k,String(x)])).toString();
export function toolRequest(name:ToolName,a:any):{route:string;method?:HttpMethod;body?:any;key?:string}{
 const numbers=numberRequest(name,a);if(numbers)return numbers;
 const env=a.environment??'REAL',get=(route:string,values:Record<string,unknown>={})=>({route:route+'?'+query({environment:env,...values}),method:'GET' as const}),post=(route:string,body:any=a.body??{},method:HttpMethod='POST')=>({route,body:{...body,environment:env},method,key:a.idempotency_key});
 switch(name){
 case'launch_guide':return get('/v1/help/launch');
 case'intelligence_search':return get('/v1/intelligence/offers',{q:a.q,country:a.country,cursor:a.cursor,limit:a.limit});
 case'intelligence_get_offer':return get(`/v1/intelligence/offers/${a.offer_id}`,{cursor:a.cursor,limit:a.limit});
 case'intelligence_search_create':return post('/v1/intelligence/searches',{name:a.name,query:a.query});
 case'intelligence_refresh':return post(`/v1/intelligence/searches/${a.search_id}/refresh`,{expected_version:a.expected_version});
 case'intelligence_analyze':return post(`/v1/intelligence/offers/${a.offer_id}/analyze`,{expected_version:a.expected_version});
 case'intelligence_compare':return get('/v1/intelligence/compare',{offer_ids:a.offer_ids.join(',')});
 case'intelligence_job_get':return get(`/v1/intelligence/${a.kind}/${a.job_id}`);
 case'intelligence_reconcile':return post(`/v1/intelligence/analyses/${a.analysis_id}/reconcile`);
 case'intelligence_batch_get':return get(`/v1/intelligence/analyses/${a.analysis_id}/batches/${a.batch_index}`);
 case'catalog_list':return get('/v1/'+a.resource,{product_id:a.product_id,q:a.q,status:a.status,include_archived:a.include_archived,offset:a.offset,limit:a.limit});
 case'catalog_get':return get(`/v1/${a.resource}/${a.resource_id}`);
 case'catalog_create':{if(a.resource==='offers'){const {product_id,...body}=a.body;z.uuid().parse(product_id);return post('/v1/products/'+product_id+'/offers',body);}return post('/v1/'+a.resource);}
	 case'catalog_update':return post(`/v1/${a.resource}/${a.resource_id}`,{...a.body,expected_version:a.expected_version},'PATCH');
	 case'catalog_transition':{if((a.action==='validate'&&a.resource!=='workflows')||(a.action==='publish'&&a.resource==='assets'))throw Object.assign(new Error('UNSUPPORTED_OPERATION'),{code:'UNSUPPORTED_OPERATION'});if(a.action==='archive'||a.action==='restore')return post(`/v1/${a.resource}/${a.resource_id}/archive`,{...a.body,expected_version:a.expected_version,archived:a.action==='archive'});if(a.resource==='products'){if(a.action==='validate')throw Object.assign(new Error('UNSUPPORTED_OPERATION'),{code:'UNSUPPORTED_OPERATION'});return post(`/v1/products/${a.resource_id}/transition`,{expected_version:a.expected_version,status:a.action==='publish'?'PUBLISHED':a.action==='archive'?'ARCHIVED':'DRAFT'});}return post(`/v1/${a.resource}/${a.resource_id}/${a.action}`,{...a.body,expected_version:a.expected_version});}
	 case'offer_version_create':return post(`/v1/offers/${a.offer_id}/versions`,{expected_version:a.expected_version,changes:a.changes});
 case'sales_flow_get':return get(`/v1/offers/${a.offer_id}/sales-flow`);
 case'sales_flow_validate':return post(`/v1/offers/${a.offer_id}/sales-flow/validate`,{changes:a.changes,...(a.expected_version===undefined?{}:{expected_version:a.expected_version})});
 case'sales_flow_save_draft':return post(`/v1/offers/${a.offer_id}/sales-flow`,{changes:a.changes,expected_version:a.expected_version},'PATCH');
 case'resource_dependencies':return get(`/v1/${a.resource}/${a.resource_id}/dependencies`);
 case'product_configuration':return get(`/v1/products/${a.product_id}/configuration`);
 case'remarketing_cycles_list':return get('/v1/remarketing-cycles',{contact_id:a.contact_id,status:a.status});
 case'remarketing_reprogram_preview':return post(`/v1/remarketing-cycles/${a.cycle_id}/reprogram/preview`,{offer_version_id:a.offer_version_id});
 case'remarketing_reprogram_apply':return post(`/v1/remarketing-cycles/${a.cycle_id}/reprogram`,{offer_version_id:a.offer_version_id,expected_revision:a.expected_revision,preview_hash:a.preview_hash,previewed_at:a.previewed_at});
 case'channel_inventory':return get('/v1/channel-inventory',{product_id:a.product_id});
 case'assignments_list':return get('/v1/assignments',{product_id:a.product_id,account_id:a.account_id,status:a.status});
 case'assignments_apply':return post('/v1/assignments/batch',{assignments:a.assignments});
 case'assignment_transition':return a.action==='change_preview'?get(`/v1/assignments/${a.assignment_id}/change-preview`,{expected_version:a.expected_version}):['history','preflight'].includes(a.action)?get(`/v1/assignments/${a.assignment_id}/${a.action}`):post(`/v1/assignments/${a.assignment_id}/${a.action}`,{...a.body,expected_version:a.expected_version});
 case'command_get':return get(`/v1/commands/${a.command_id}`);
 case'channel_session_get':return get(`/v1/channel-accounts/${a.account_id}/session`);
 case'channel_session_configure':return post(`/v1/channel-accounts/${a.account_id}/session`,{...a.body,expected_version:a.expected_version},'PATCH');
 case'channel_primary_usage':return post(`/v1/channel-accounts/${a.account_id}/primary-usage`,{used_at:a.used_at,source:'operator_confirmation',reason:a.reason,expected_version:a.expected_version});
 case'channel_session_recovery':return post(`/v1/channel-accounts/${a.account_id}/session/recovery`,{...a.body,expected_version:a.expected_version});
 case'channel_command':return post(`/v1/channel-accounts/${a.account_id}/commands`,{type:a.type,reason:a.reason,...(a.expected_version!==undefined?{expected_version:a.expected_version}:{}),...(a.owner_id?{owner_id:a.owner_id}:{}),...(a.isolation_evidence?{isolation_evidence:a.isolation_evidence}:{})});
 case'channel_health':return get(`/v1/channel-accounts/${a.account_id}/health`);
 case'warmup_overview':return get('/v1/warmup');
 case'warmup_preflight':return post(`/v1/warmup/pools/${a.pool_id}/preflight`);
 case'warmup_activate':return post(`/v1/warmup/pools/${a.pool_id}/activate`);
 case'warmup_pause':return a.action==='pause'?post(`/v1/warmup/pools/${a.pool_id}`,{...a.body,action:'pause'},'PATCH'):post(`/v1/warmup/pools/${a.pool_id}/resume`);
 case'warmup_simulate':return {route:'/v1/warmup/simulate',method:'POST',body:{environment:'SIMULATION',seed:a.seed,participants:a.participants,at:a.at,fault:a.fault},key:a.idempotency_key};
 case'warmup_simulation_get':return {route:`/v1/warmup/simulations/${a.run_id}?environment=SIMULATION`,method:'GET'};
 case'provider_diagnostic_profiles':return get('/v1/provider-diagnostic-profiles');
 case'provider_diagnostic_verify':return post(`/v1/provider-diagnostic-profiles/${encodeURIComponent(a.profile_key)}/verify`);
 case'provider_diagnostic_get':return get(`/v1/provider-diagnostics/${a.diagnostic_id}`);
 case'provider_diagnostic_reconcile':return post(`/v1/provider-diagnostics/${a.diagnostic_id}/reconcile`);
 case'intelligence_corpus_fixture':return get('/v1/intelligence/corpus-evaluation-fixture');
 case'intelligence_corpus_evaluate':return post('/v1/intelligence/corpus-evaluations');
 case'intelligence_corpus_get':return get(`/v1/intelligence/corpus-evaluations/${a.evaluation_id}`);
 case'intelligence_corpus_reconcile':return post(`/v1/intelligence/corpus-evaluations/${a.evaluation_id}/reconcile`,{confirmation:'READ_EXISTING_PROVIDER_OPERATIONS_ONLY'});
 case'integration_profiles':return get('/v1/integration-profiles');
 case'integration_verify':return post(`/v1/integration-profiles/${encodeURIComponent(a.profile_key)}/verify`,{expected_version:a.expected_version,max_cost_usd:a.max_cost_usd,capability:'responses.structured'});
 case'integration_diagnostic_get':return get(`/v1/integration-diagnostics/${a.diagnostic_id}`);
 case'integration_save':return a.profile_key==='intelligence:openai'?post('/v1/creative/settings/openai',a.body,'PUT'):a.profile_key.startsWith('creative:')?post('/v1/creative/settings/'+encodeURIComponent(a.profile_key.slice(9)),a.body,'PUT'):post(`/v1/settings/integrations/${encodeURIComponent(a.profile_key)}`,a.body,'PUT');
 case'assistant_context':return get(`/v1/products/${a.product_id}/assistant`);
 case'assistant_proposal_state':return post(`/v1/products/${a.product_id}/assistant/proposals/${a.proposal_id}/state`);
 case'assistant_propose':return post(`/v1/products/${a.product_id}/assistant/proposals`);
 case'proposal_message':return post(`/v1/conversations/${a.conversation_id}/proposals`,{...a.body,expected_version:a.expected_version});
 case'command_effects':return get(`/v1/commands/${a.command_id}/effects`);
 case'simulation_run':return {route:'/v1/simulations',method:'POST',body:{...a.body,environment:'SIMULATION'},key:a.idempotency_key};
 case'simulation_snapshot':return {route:'/v1/simulation-snapshots',method:'POST',body:{workflow_version_id:a.workflow_version_id,expected_version:a.expected_version,...(a.offer_version_id!==undefined?{offer_version_id:a.offer_version_id}:{}),...(a.expected_offer_version!==undefined?{expected_offer_version:a.expected_offer_version}:{}),environment:'SIMULATION'},key:a.idempotency_key};
 case'assets_upload_create':return post('/v1/assets/uploads');
 case'assets_upload_operation':return a.action==='get'?get(`/v1/assets/uploads/${a.upload_id}`):post(`/v1/assets/uploads/${a.upload_id}/${a.action==='part'?'parts/'+a.part:a.action}`);
 case'results_summary':return get('/v1/reports/summary',{product_id:a.product_id});
 case'costs_summary':return get('/v1/costs',{product_id:a.product_id,conversation_id:a.conversation_id});
 case'seller_effective':return get(`/v1/workflows/${a.workflow_id}/seller`,{offer_version_id:a.offer_version_id});
 case'workflow_evaluate':return post(`/v1/workflows/${a.workflow_id}/evaluations`);
 case'evaluation_get':return get(`/v1/evaluations/${a.evaluation_id}`);
 case'evaluation_turn':return post(`/v1/evaluations/${a.evaluation_id}/turns`);
 case'launch_tests':return a.action==='list'?get('/v1/launch-tests',{product_id:a.product_id}):post('/v1/launch-tests'+(a.action==='revoke'?'/'+a.test_id+'/revoke':''));
 case'effective_seller':return get(`/v1/channel-accounts/${a.account_id}/effective-seller`,{assignment_id:a.assignment_id});
 case'assignment_authorize':return post(`/v1/assignments/${a.assignment_id}/authorize`);
 case'conversation_select_product':return post(`/v1/conversations/${a.conversation_id}/select-product`,{assignment_id:a.assignment_id,reason:a.reason,expected_version:a.expected_version});
 case'archive_production_list':return get(`/v1/archive/production/${a.kind}`,{project_id:a.project_id,cursor:a.cursor,limit:a.limit});
 }
 throw new Error('UNKNOWN_TOOL');
}
export function safeResult(value:unknown,access=false):any{
 if(Array.isArray(value))return value.map(v=>safeResult(v,access));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/(?:ciphertext|token_hash|password|api_key|access_token|refresh_token|secret_access|storage_key|local_path|bytes_base64|^token$)/i.test(k)&& (access||k!=='signed_url')).map(([k,v])=>[k,safeResult(v,access)]));
 if(typeof value==='string'&&!access&&/^https?:/i.test(value)&&/[?&](?:x-amz-|signature|token|credential)/i.test(value))return '[temporary access omitted; request asset access explicitly]';
 return value;
}
/** APIs paginate. Preserve complete pages, evidence, operation IDs and metadata. */
export function boundedToolResult(_name:ToolName,raw:unknown,_origin:string):unknown{return safeResult(raw);}
export function createCommerceMcp(api:CommerceApi){const server=new McpServer({name:'commerce-os',version:'5.0.0'},{capabilities:{tools:{}}});for(const [name,d]of Object.entries(toolDefinitions)){const readOnly=name in numberTools?numberRequest(name,{environment:'REAL',body:{}})?.method==='GET':['sales_flow_validate','remarketing_reprogram_preview'].includes(name)||/search$|get$|list$|compare$|configuration$|inventory$|health$|overview$|profiles$|context$|dependencies$|effects$|summary$|guide$|effective$|fixture$/.test(name);server.registerTool(name,{title:d.title,description:d.description,inputSchema:d.schema,annotations:{readOnlyHint:readOnly,destructiveHint:name==='number_retire',idempotentHint:true,openWorldHint:!readOnly}},async(a:any)=>{try{const r=toolRequest(name as ToolName,a),raw=await api.request(r.route,{method:r.method,body:r.body,idempotencyKey:r.key}),result=safeResult(raw,name==='assets_upload_operation'&&a.action==='part');return{content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result};}catch(error:any){const result={code:/^[A-Z0-9_]+$/.test(error.code??error.message)?error.code??error.message:'COMMERCE_REQUEST_FAILED',details:safeResult(error.details),uncertain:Boolean(error.uncertain),next:'Consulta estado y revisión persistidos antes de reintentar con la misma clave.'};return{isError:true,content:[{type:'text' as const,text:JSON.stringify(result)}]};}});}return server;}
