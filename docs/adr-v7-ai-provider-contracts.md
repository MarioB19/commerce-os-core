# Adaptadores IA por capacidad y credencial del perfil

Fecha: 2026-10-11. Estado: paquete preparado y revisado; consumidores y key real
sin activar. Alcance: F4, RF-14; complementa ADR-V7-06 del vault.

`packages/ai-providers` tendrá tres adaptadores REST acotados: OpenAI Responses
y transcripciones, Anthropic Messages y Google Gemini generateContent. Los
modelos, capacidades y precios se fijan en un catálogo versionado del servidor;
no se selecciona un modelo por popularidad ni se promete audio en Anthropic.
La selección consulta el default del perfil y el override de la variante. Puede
resolver otra capacidad con un modelo compatible del mismo proveedor y, sólo si
está configurado explícitamente, con una credencial complementaria del mismo
perfil. En otro caso devuelve necesidad de intervención humana. Esa selección
ocurre antes del envío; un timeout o resultado incierto no inicia otra llamada.

Los adaptadores reciben puertos explícitos de credencial y admisión. No leen
variables globales ni la base de otro perfil. Cada intento conserva identidad
de perfil, variante, tarea, precio, modelo y presupuesto. El puerto de admisión
debe reservar duraderamente y registrar el intento antes del POST, además de
revalidar la autoridad al final de las lecturas. Su integración con el ledger
del negocio y el contexto transaccional F2 es un gate posterior de activación.
La conversación, cuando exista, viaja en ese mismo contexto hasta el recibo.
La reserva incluye el hash semántico de la solicitud, sin prompts ni contenido
del archivo. La última comprobación recibe además la revisión exacta de la key
obtenida; una rotación/revocación concurrente debe impedir el POST.

Las peticiones usan endpoints oficiales fijos, sin redirecciones, sin herramientas
ni URLs de assets provistas por el modelo. Imágenes y audio viajan como bytes
validados y limitados; no hay descargas arbitrarias. Cada llamada tiene plazo
absoluto y cotas de petición/respuesta. Se ejecuta un solo POST por intento. Los
errores públicos contienen códigos cerrados, nunca cuerpos, keys o prompts.

Las salidas son propuestas. Se validan con el schema determinista del consumidor
antes de afectar ventas o comprobantes. Las respuestas bloqueadas, truncadas,
con herramientas, uso ausente o ambiguo no se etiquetan como éxito. Uso medido,
estimación previa y precio fechado se distinguen; no se inventan tokens ni costo
cero si falta el recibo del proveedor. Los límites previos usan cotas del modelo
revisado, también para imágenes/audio, y redondeo conservador de enteros.
Esas cotas deben ser los máximos nativos del modelo revisado, no un objetivo de
tokens elegido por el usuario. El catálogo debe acreditar esos máximos antes de
activarse: el límite de bytes no equivale a un contador de tokens multimedia.
Las identidades de modelo reportadas se cotejan con las snapshots cubiertas por
el precio; una respuesta de otro modelo conserva uso, pero no inventa su costo.
Si el proveedor excede una reserva, se registra el uso y costo medidos, se rechaza
la propuesta y se requiere conciliación; no se borra el exceso ni se reintenta.
Las peticiones seleccionan capacidad estándar explícita. Una respuesta que
declara otro nivel de servicio no hereda la tarifa estándar. Gemini solicita
sólo salida textual y se rechaza uso de herramientas no solicitado.

Las pruebas de contrato son sintéticas y no usan ninguna key de un negocio.
No cambian el proveedor/modelo actual ni montan las nuevas rutas. La validación
mínima al guardar una key (RF-13) y la única muestra real autorizada de Operación
Brandon requieren su propio contexto, reserva vigente y evidencia; no se piden
keys Anthropic/Google para completar estos contratos.

Fuentes oficiales verificadas al iniciar el incremento:

- [OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI transcriptions](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)
- [Anthropic Messages y uso](https://platform.claude.com/docs/en/build-with-claude/working-with-messages)
- [Gemini generateContent](https://ai.google.dev/api/generate-content)
- [Gemini audio](https://ai.google.dev/gemini-api/docs/audio)

Estas referencias fijan el protocolo, no una tarifa ni disponibilidad futura de
un modelo. El catálogo y sus precios tienen caducidad explícita y deben volver
a comprobarse al habilitar una configuración del negocio.

La respuesta HTTP 408 o 5xx después del POST conserva UNCERTAIN y la reserva: puede haber ejecución o cobro sin uso disponible. Sólo una lista cerrada de errores de rechazo de solicitud (400/401/403/404/413/415/422/429) se clasifica REJECTED; tampoco permite replay o devolución automática. Los cuerpos de error no se leen ni se propagan.

## Adenda 2026-11-11 — razonamiento de Claude 5.x (Claude)

Al preparar el primer uso real de Anthropic como vendedor se comprobó que los
modelos revisados del catálogo (`claude-haiku-5-5`, `claude-sonnet-5-5`)
razonan por defecto: sin el campo `thinking` la respuesta puede traer bloques
`thinking` (texto omitido, sólo firma) antes del texto, y ese razonamiento
consume `max_tokens`. El adaptador rechazaba cualquier bloque que no fuera
`text`, así que una respuesta válida terminaba en `OUTPUT_REJECTED` de forma
intermitente (también la verificación de la key).

Decisión:

- La petición Messages fija el razonamiento mínimo que acepta cada modelo
  revisado con su esfuerzo por defecto: Haiku 5.5 `{"type":"disabled"}`;
  Sonnet 5.5 `{"type":"between_tools"}` (rechaza `disabled`; sin herramientas
  equivale a no razonar). Un modelo fuera de esa lista conserva el default
  del proveedor.
- La salida ignora los bloques `thinking` y `redacted_thinking`, igual que los
  `reasoning` de OpenAI y los `thought` de Gemini. Cualquier otro bloque que no
  sea texto (p. ej. `tool_use`) sigue rechazado, y una respuesta sin texto
  también.
- El uso medido no cambia: Anthropic cobra el razonamiento como salida y ya se
  registra en `output_tokens`.

Fuente: [Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)
y [Effort](https://platform.claude.com/docs/en/build-with-claude/effort),
consultadas el 2026-11-11.
