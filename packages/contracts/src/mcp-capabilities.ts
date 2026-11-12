/** V7.5 §8 (H04): the MCP contract this build serves. A client compares its own
 * list with the server's to report exactly what it lacks; the tool count alone
 * never proves parity. Names are tool.action (or tool.action.field). */
export const MCP_RELEASE='7.5.0';
export const MCP_CAPABILITIES=[
 'numbers_manage.crear.calentamiento','numbers_manage.cambiar_calentamiento',
 'number_connection_manage.reintentar_preparacion','number_connection_manage.confirmar_desvinculacion','number_connection_manage.conciliar_propiedad',
 'warmup_manage.iniciar.audienceConfirmed','warmup_manage.revisar_proteccion','warmup_manage.recuperar_proteccion',
 'alerts_manage.listar.cursor','alerts_manage.leer.directo','alerts_manage.acusar_todos',
 'profile_context.version',
] as const;
export type McpCapability=typeof MCP_CAPABILITIES[number];
export function mcpCompatibility(client:{version:string;capabilities:readonly string[]},server:{version:string;capabilities:readonly string[]}){
 const missing=server.capabilities.filter(c=>!client.capabilities.includes(c));
 return{compatible:missing.length===0,missing,update:missing.length?'Actualiza el paquete MCP local (descárgalo de la aplicación) y recarga el catálogo de herramientas.':null};
}
