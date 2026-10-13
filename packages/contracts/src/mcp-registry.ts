/** V7 MCP registry (Inventario y paridad V7, "Registro objetivo tipado"):
 * 40 tools in total, 34 bound to one profile by its personal token and 6 for
 * the platform identity only. Each tool exposes closed actions; there is no
 * generic HTTP, SQL, path or body tool. `pending` lists target actions not yet
 * served by the API in this build; CI fails if a registered action is missing
 * here or if the budget is exceeded. */
export const MCP_TOOL_BUDGET=40;
export interface McpRegistryEntry {name:string;audience:'profile'|'platform';actions:readonly string[];pending:readonly string[];scopes:readonly string[];family:string}
const tool=(name:string,audience:'profile'|'platform',family:string,scopes:readonly string[],actions:readonly string[],pending:readonly string[]=[]):McpRegistryEntry=>({name,audience,family,scopes,actions,pending});
export const mcpRegistry:readonly McpRegistryEntry[]=Object.freeze([
 tool('profile_context','profile','/v2/profile',['profiles:read'],['actual','listar','cambiar']),
 tool('home_get','profile','/v2/home',['home:read'],['resumen']),
 tool('employees_manage','profile','/v2/employees',['employees:read','employees:write'],['listar','invitaciones','invitar','cancelar_invitacion','cambiar_rol','desactivar','consultar_operacion'],['reenviar_invitacion']),
 tool('integrations_manage','profile','/v2/integrations',['integrations:read','integrations:write'],['listar','guardar','validar','rotar','preferencias','activar','desactivar','eliminar']),
 tool('api_tokens_manage','profile','/v2/tokens',['tokens:read','tokens:write'],['listar','crear','revocar','consultar_operacion']),
 tool('products_manage','profile','/v2/products',['products:read','products:write'],['listar','leer','crear','editar','archivar','restaurar','dependencias']),
 tool('variants_manage','profile','/v2/variants',['variants:read','variants:write'],['listar','leer','adoptar','crear','editar','revisar','duplicar','publicar','version','historial','archivar','restaurar','consultar_operacion']),
 tool('offers_manage','profile','/v2/variants/{id}/offer',['offers:read','offers:write'],['leer','guardar','validar','publicar','historial']),
 tool('materials_manage','profile','/v2/materials',['materials:read','materials:write'],['listar','leer','iniciar_subida','parte','completar','cancelar','eliminar']),
 tool('sales_flows_manage','profile','/v2/variants/{id}/sales-flow',['flows:read','flows:write'],['leer','guardar','validar','publicar','historial']),
 tool('sellers_manage','profile','/v2/variants/{id}/seller',['sellers:read','sellers:write'],['leer','guardar','validar','publicar','historial']),
 tool('collections_manage','profile','/v2/variants/{id}/collection',['collections:read','collections:write'],['leer','guardar','validar','historial']),
 tool('receipt_rules_manage','profile','/v2/payments/policies',['receipt-rules:read','receipt-rules:write'],['leer_perfil','leer_variante','guardar_perfil','guardar_variante','consultar_operacion']),
 tool('numbers_manage','profile','/v1/numbers',['numbers:read','numbers:write'],['listar','leer','crear','impacto_eliminar','eliminar'],['editar']),
 tool('number_connection_manage','profile','/v1/numbers/{id}/link',['numbers:read','numbers:connect'],['estado','conectar','vincular','desconectar','pausar','reanudar']),
 tool('number_assignments_manage','profile','/v2/continuity',['assignments:read','assignments:write'],['autorizaciones','autorizacion','autorizar','pausar','reanudar','revocar','consultar_operacion','asignar','retirar','impacto','historial','vista_inversa']),
 tool('warmup_manage','profile','/v2/continuity/warmup',['warmup:read','warmup:write'],['progreso','pausar','reanudar','evidencia']),
 tool('conversations_manage','profile','/v1/conversations',['conversations:read','conversations:write'],['listar','leer','responder','registrar_acuerdo','cerrar','registrar_baja','tomar_control','liberar_control','pausar','reanudar'],['asignar_persona','elegir_variante']),
 tool('orders_manage','profile','/v1/orders',['orders:read','orders:write'],['listar','leer'],['corregir_clasificacion','historial']),
 tool('receipts_manage','profile','/v2/receipts',['receipts:read','receipts:review'],['listar','leer','archivo','revisar']),
 tool('payments_manage','profile','/v2/payments',['payments:read','payments:write','payments:export'],['opciones','listar','exportar'],['leer','registrar','conciliar','corregir']),
 tool('remarketing_manage','profile','/v2/variants/{id}/remarketing',['remarketing:read','remarketing:write'],['leer','guardar','validar','publicar','historial','resultados'],['ciclos','previsualizar_reprogramacion','reprogramar','pausar','reanudar']),
 tool('campaigns_read','profile','/v2/campaigns',['campaigns:read','integrations:write'],['cuentas','resultados','campanas','anuncios','sincronizar_lectura'],['portafolios']),
 tool('results_read','profile','/v2/results',['results:read'],['opciones','resumen'],['embudo','series','comparar','exportar']),
 tool('goals_manage','profile','/v2/goals',['goals:read','goals:write'],['listar','leer','avance','crear','editar','consultar_operacion'],['eliminar']),
 tool('number_test_manage','profile','/v2/number-tests',['tests:read','tests:run'],['estimar','crear','leer','ultima','mensaje','seleccionar','avanzar_reloj','continuar','reiniciar'],['adjuntar','ejecutar_suite','informe']),
 tool('operations_get','profile','/v2/operations',['operations:read'],['leer_resultado'],['efectos']),
 tool('alerts_manage','profile','/v2/alerts',['alerts:read','alerts:write'],['listar','leer','acusar'],['configurar_preferencias']),
 tool('help_read','profile','/v2/help',['help:read'],['guia','descargar'],['receta','referencia']),
 tool('audit_read','profile','/v2/audit',['audit:read','audit:export'],['listar','exportar']),
 tool('privacy_manage','profile','/v2/privacy',['privacy:read','privacy:write'],[],['retencion','guardar_retencion','exportar_contacto','borrar_contacto','leer_resultado']),
 tool('profile_settings_manage','profile','/v2/profile',['profile:read','profile:write'],['leer','editar','onboarding','actualizar_onboarding'],['pausar_operacion','reanudar_operacion']),
 tool('usage_read','profile','/v2/usage',['usage:read'],['conversaciones','numeros','almacenamiento','costo_ia','cuotas']),
 tool('account_security_manage','profile','/v2/me/security',['account:read','account:write'],[],['leer','sesiones','revocar_sesion','solicitar_cambio_seguro']),
 tool('admin_profiles_manage','platform','/v2/platform/profiles',['platform:profiles'],['listar','crear','invitar_dueno','suspender','reactivar','limites'],['exportar','eliminar']),
 tool('admin_capacity_manage','platform','/v2/platform/capacity',['platform:capacity'],['leer'],['previsualizar','aplicar','drenar','conciliar']),
 tool('admin_services_read','platform','/v2/platform/health',['platform:health'],[],['salud','slo','incidentes','colas','backups']),
 tool('admin_recovery_manage','platform','/v2/platform/recovery',['platform:recovery'],[],['previsualizar','conciliar','restaurar','leer_resultado']),
 tool('admin_releases_read','platform','/v2/platform/releases',['platform:releases'],[],['actual','historial','verificaciones']),
 tool('admin_audit_read','platform','/v2/platform/audit',['platform:audit'],[],['listar','exportar','costos']),
]);
export function mcpRegistryEntry(name:string){const entry=mcpRegistry.find(e=>e.name===name);if(!entry)throw Error('MCP_TOOL_NOT_IN_REGISTRY');return entry;}
