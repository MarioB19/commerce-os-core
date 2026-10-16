/** V7 F7 (RF-16.a/c/d/e, RF-15.d): in-app help, one source for the web page,
 * the API (`/v2/help`) and MCP (`help_read`). Spanish, operator language; the
 * technical words appear only where a person must type them. Versioned so a
 * downloaded copy says which text it is. */
export const HELP_VERSION='2026-10-13';
export interface HelpSection {id:string;title:string;summary:string;body:string}
export const helpSections:readonly HelpSection[]=Object.freeze([
 {id:'empezar',title:'Empieza a vender en 6 pasos',summary:'De cero a tu primera venta por WhatsApp.',body:
`1. **Conecta tu IA.** En *Mi cuenta → Integraciones* guarda la clave de tu proveedor (OpenAI, Anthropic o Google), elige el modelo predeterminado y un límite mensual. La IA la paga tu clave; Commerce OS no cobra por ella.
2. **Crea tu producto.** En *Productos → Nuevo producto* escribe el nombre y crea su primera variante por mercado (por ejemplo «México», en pesos y español).
3. **Completa la variante.** Llena sus secciones y publica:
   - **Venta:** el flujo (venta por conversación o guiada) y el vendedor.
   - **Oferta y materiales:** precio y qué recibe el cliente.
   - **Cobro:** SPEI y/o enlace de pago.
   - **Remarketing:** hasta tres seguimientos.
4. **Agrega tu número.** En *Números → Agregar número* escribe su alias; luego, en el teléfono, abre WhatsApp → *Dispositivos vinculados* → *Vincular dispositivo* y escanea el QR. El calentamiento empieza solo.
5. **Asigna la variante al número.** En la variante, sección *Números*, elige «Vender en este número». Desde ese momento el número atiende y hace seguimiento sin que tengas que volver a autorizarlo.
6. **Prueba y revisa.** Usa *Probar número* para conversar como cliente sin enviar nada real. Cuando llegue un pago, apruébalo en *Ventas → Comprobantes*.`},
 {id:'dia-a-dia',title:'Tu día a día',summary:'Dónde ver lo pendiente y cómo resolverlo.',body:
`- **Inicio** te dice si tus números están conectados y atendiendo, cuánto vendiste hoy y en la semana frente a tu meta, y qué falta por hacer.
- **Comprobantes**: los que esperan una decisión salen primero. Aprobar entrega lo comprado y registra el pago; rechazar avisa al cliente. Si no se leyó el monto, escríbelo antes de aprobar.
- **Conversaciones** y **Pedidos** muestran cada cliente con su producto y su estado.
- **Pagos** es tu hoja de ingresos: filtra, exporta a CSV o Excel y abre cada comprobante.
- **Resultados** compara tus ventas, conversión, costo de anuncios y de IA con el periodo anterior.
- **Avisos**: si un número se desconecta o se pausa, verás la causa y qué hacer. Al corregirla, la atención se reanuda sola.`},
 {id:'probar',title:'Probar un número',summary:'Conversa como cliente sin enviar nada real.',body:
`- Antes de empezar ves el **costo máximo de IA** de la prueba; lo paga tu clave y cuenta en tu presupuesto.
- La prueba usa la configuración vigente al iniciarla. Si cambias algo, pulsa **Reiniciar**.
- **Continuar** muestra el siguiente mensaje del negocio; **Adelantar 2/8/24 h** mueve sólo el reloj de la prueba para ver los seguimientos.
- Si el número vende varias variantes, elige por cuál llega el cliente.
- Nada sale por WhatsApp, no se registran ventas ni pagos y los datos bancarios aparecen como marcador de prueba.`},
 {id:'ia',title:'Operar con IA (Claude o Codex)',summary:'Conecta tu asistente al perfil con un acceso personal.',body:
`1. En *Mi cuenta → Accesos MCP* crea un acceso para este perfil y guarda el token en un archivo que sólo tú puedas leer (por ejemplo \`~/commerce-os/token.txt\`, permisos \`600\`).
2. Descarga el conector: [commerce-os-mcp.mjs](/downloads/commerce-os-mcp.mjs) (necesita Node 20 o superior).
3. Configura tu asistente con la dirección de tu Commerce OS y la ruta del token:

**Claude Desktop** (\`claude_desktop_config.json\`):
\`\`\`json
{"mcpServers":{"commerce-os":{"command":"node","args":["/ruta/commerce-os-mcp.mjs"],
 "env":{"COMMERCE_API_ORIGIN":"https://commerce-os.inovaris.online","COMMERCE_MCP_TOKEN_FILE":"/ruta/token.txt"}}}}
\`\`\`
**Claude Code**:
\`\`\`
claude mcp add commerce-os -e COMMERCE_API_ORIGIN=https://commerce-os.inovaris.online -e COMMERCE_MCP_TOKEN_FILE=/ruta/token.txt -- node /ruta/commerce-os-mcp.mjs
\`\`\`
**Codex** (\`~/.codex/config.toml\`):
\`\`\`toml
[mcp_servers.commerce-os]
command = "node"
args = ["/ruta/commerce-os-mcp.mjs"]
env = { COMMERCE_API_ORIGIN = "https://commerce-os.inovaris.online", COMMERCE_MCP_TOKEN_FILE = "/ruta/token.txt" }
\`\`\`
- **Qué puede hacer:** consultar y editar productos, variantes, cobro y remarketing; revisar comprobantes; leer resultados y campañas; probar números.
- **Qué no puede hacer:** empezar a vender en un número nuevo (lo decides tú en la aplicación), gastar en anuncios ni usar otro perfil. Cada cambio lleva una operación que no se repite aunque se reintente.`},
 {id:'whatsapp',title:'WhatsApp: buenas prácticas',summary:'Cómo vender sin poner en riesgo tus números.',body:
`- Responde a quien te escribe y haz seguimientos sólo a quien ya conversó contigo, dentro de los horarios que configures.
- Respeta la baja: si alguien escribe «baja» o pide no recibir mensajes, no se le vuelve a escribir.
- No envíes mensajes masivos a listas compradas ni rotes números para evadir límites.
- El QR vincula un dispositivo a tu WhatsApp. Si WhatsApp lo desvincula, Commerce OS te avisa y sólo tienes que escanear de nuevo.
- Usa teléfonos propios y mantenlos con batería e internet los primeros días.`},
 {id:'privacidad',title:'Privacidad y tus datos',summary:'Qué guardamos, por cuánto tiempo y cómo se protege.',body:
`- Cada perfil está aislado: tus empleados sólo ven el perfil al que los invitaste, con el rol que les diste.
- Las claves de IA, los tokens y los datos bancarios se guardan cifrados y nunca se muestran completos.
- Los teléfonos se muestran enmascarados; los comprobantes se abren sólo dentro de la aplicación.
- Conservación por defecto:

  | Dato | Tiempo |
  |---|---|
  | Pruebas de número | 30 días |
  | Registros técnicos | 90 días |
  | Conversaciones | 180 días |
  | Pagos y auditoría | 5 años, o lo que exija la ley |
- Cuando se borra una conversación, las métricas agregadas (ventas, conversión, costos) se conservan sin datos personales.
- Las copias de seguridad cifradas se eliminan al cumplir su ciclo; no prometemos borrado inmediato de copias inmutables.`},
 {id:'terminos',title:'Términos de uso',summary:'Reglas básicas del servicio.',body:
`- Commerce OS es una herramienta para vender tus propios productos digitales por WhatsApp. Tú eres responsable de lo que vendes, de tus precios, de tus mensajes y de cumplir las leyes de tu país y las políticas de WhatsApp y Meta.
- La IA responde con la clave y el modelo que tú eliges; su costo lo paga tu cuenta con el proveedor.
- Los resultados que muestra la aplicación son mediciones de lo ocurrido; no son promesas de ventas.
- Podemos pausar un perfil ante abuso, spam o riesgo para otros usuarios, avisándote la causa.
- Versión ${HELP_VERSION}. Si cambian estos términos te lo diremos en la aplicación.`},
 {id:'api',title:'API y MCP',summary:'Para integraciones propias.',body:
`- **Autenticación:** encabezado \`Authorization: Bearer cos_pat_…\` con un acceso personal del perfil. Cada acceso sirve para un solo perfil.
- **Escrituras:** envía \`Idempotency-Key\` con un UUID; repetir la misma operación devuelve el mismo resultado.
- **Rutas principales** (\`/v2\`): \`products\`, \`variants\` (y sus secciones \`offer\`, \`sale\`, \`collection\`, \`remarketing\`, \`numbers\`), \`materials\`, \`receipts\`, \`payments\`, \`results\`, \`goals\`, \`number-tests\`, \`campaigns\`, \`home\`, \`alerts\`.
- **Errores:** \`{"error":{"code":"…","message":"…"}}\` con un código estable y un mensaje para personas.
- El conector MCP ofrece las mismas tareas con las mismas reglas que la aplicación y la API.`},
]);
/** The whole guide as one Markdown document (download). */
export function helpMarkdown(){
 return `# Ayuda de Commerce OS\n\nVersión ${HELP_VERSION}\n\n`+helpSections.map(s=>`## ${s.title}\n\n${s.body}\n`).join('\n');
}
