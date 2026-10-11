# Lanzar un producto con Codex y Commerce OS

Versión commerce-v5-launch-1. Fuente compartida por web y API: packages/domain/src/operations/launch-guide.ts.

El equipo elige la oferta. Codex desarrolla el producto y produce materiales con Vibe Marketing como referencia. Commerce OS recibe el paquete aprobado, prepara la venta, prueba y conserva la historia comercial. Inteligencia es opcional.

- Videos, recetas y campañas se crean en Codex y herramientas del equipo. Commerce OS conserva los activos terminados y referencias de campañas externas.
- Publicar configuración internamente no autoriza mensajes ni gasto. Vincular un número nuevo, activar warm-up o habilitar un alcance comercial tiene permisos propios.
- Los portales existentes conservan su publicación y accesos. QA técnico no acredita revisión editorial ni cumplimiento de un compromiso histórico.

## 1. Recibir el paquete aprobado

Responsable: Equipo + Codex.

Entrada: Oferta elegida, producto, fuentes y derechos, materiales finales con hash, condiciones de cobro, flujo, vendedor, autorizaciones y destinos expresamente seleccionados.

Comprueba que la revisión y los archivos coinciden. Conserva originales y registra sólo reemplazos necesarios. Un dato legal, clave o destino faltante queda como pendiente concreto.

Comprobación: Manifiesto versionado y revisión del paquete; sin teléfonos completos o secretos en Git.

Recuperación: Si falta un campo, completa lo independiente y conserva el borrador. No inventes precios, destinos ni datos legales.

- `GET /v1/help/launch`

## 2. Registrar producto y materiales

Responsable: Codex por API/MCP.

Entrada: Nombre, descripción, hechos, referencias y producto aprobado.

Crea el producto con Idempotency-Key y relee la respuesta. Adjunta materiales del producto. Archivos terminados mayores que 20 MiB usan la subida multipart de hasta 500 MiB.

Comprobación: IDs y revisiones persistidos; hash remoto, origen CODEX, derechos y revisión. Los videos de marketing no se confunden con entregables WhatsApp.

Recuperación: Reutiliza upload_id y clave de operación. Ante UNKNOWN consulta y concilia; no empieces otra subida sin resolver la anterior.

- `POST /v1/products`
- `GET /v1/products/{id}`
- `POST /v1/assets`
- `POST /v1/assets/uploads`
- `GET /v1/assets/uploads/{id}`
- `POST /v1/assets/uploads/{id}/initialize`
- `POST /v1/assets/uploads/{id}/parts/{part}`
- `POST /v1/assets/uploads/{id}/complete`

## 3. Fijar oferta y condiciones

Responsable: Equipo decide; Codex registra.

Entrada: Precio, moneda, perfiles de cobro, parciales, tiers y materiales autorizados.

Guarda una oferta del producto y publica internamente su versión lista. La intención de pagar un tier no acredita ingreso.

Comprobación: Versión publicada y condiciones legibles. Mi Ciclo Listo: Método del Acuerdo, $97 MXN base, $107 MXN totales y un total aprobado superior a $107 como Madrina, sin beneficios extra inventados ni entregas a terceros.

Recuperación: Corrige mediante una nueva versión. No reescribas ofertas fijadas a pedidos. Los compromisos históricos se conservan como excepciones.

- `POST /v1/products/{id}/offers`
- `POST /v1/offers/{id}/publish`
- `GET /v1/offers/{id}`

## 4. Configurar flujo y vendedor

Responsable: Codex por API/MCP.

Entrada: Oferta publicada, conocimiento del producto y reglas deterministas de avance/derivación.

Crea y valida un flujo del producto, su vendedor y la selección efectiva. Mantén separados los perfiles de Inteligencia, asistente y vendedor; no copies una clave por suposición.

Comprobación: Producto/oferta/flujo/vendedor compatibles, versiones fijadas y faltantes de preparación.

Recuperación: VERSION_CONFLICT exige releer y comparar; conserva el draft. Una API de IA caída no impide guardar configuración ni consultar la operación.

- `POST /v1/agents`
- `POST /v1/agents/{id}/publish`
- `POST /v1/workflows/apply`
- `POST /v1/workflows/{id}/validate`
- `POST /v1/workflows/{id}/publish`
- `GET /v1/workflows/{id}/seller`

## 5. Probar antes de operar

Responsable: Codex; prueba física sólo con alcance específico.

Entrada: Flujo y vendedor fijados; datos sintéticos o comprador propio autorizado.

Evalúa el vendedor y ejecuta laboratorio SIMULATION con snapshot. El ensayo de comprador único puede usar cualquier tier; no requiere beneficiaria. No habilita envíos.

Comprobación: Resultado por escenario, propuestas/efectos y lectura posterior. TEST/Falso quedan fuera de ingreso y reportes comerciales.

Recuperación: Repite con el mismo idempotency key tras pérdida de respuesta. Detén el ensayo si faltan autorizaciones o no coincide la oferta del recorrido.

Si la relación está en `offer.workflow_version_id` y el flujo no fija oferta, selecciona explícitamente la versión publicada que quieres ensayar. Envía `workflow_version_id`, `expected_version`, `offer_version_id` y `expected_offer_version` a `/v1/simulation-snapshots` en SIMULATION, con Idempotency-Key. MCP `simulation_snapshot` recibe los mismos cuatro campos y fuerza ese entorno. El servidor exige mismo producto, flujo exacto, pertenencia y permisos; bloquea ofertas ajenas, borradores, conflictos o revisiones sustituidas. La UI muestra un selector de ofertas válidas y no elige la primera. El recibo `source` conserva las dos referencias y revisiones; toda ejecución posterior utiliza los IDs SIMULATION devueltos. [Decisión y recuperación](adr-v5-simulation-offer.md).

- `POST /v1/simulation-snapshots`
- `POST /v1/workflows/{id}/evaluations`
- `GET /v1/evaluations/{id}`
- `POST /v1/simulations`
- `GET /v1/simulations/{id}`
- `POST /v1/launch-tests`
- `GET /v1/launch-tests`

## 6. Elegir números y montar relaciones

Responsable: Equipo selecciona; Codex aplica ese mapeo.

Entrada: Números existentes indicados por el equipo o manifiesto aprobado.

Consulta inventario y salud, después guarda cada relación número × producto con oferta, flujo, vendedor, entrada y vigencia. B conserva A; batch informa resultados parciales. Sin destinos seleccionados, entrega opciones y deja el mapeo pendiente.

Comprobación: Cada vínculo tiene revisión e historial. Registrado, conectado, asignado y autorizado son estados distintos.

Recuperación: Relee los vínculos exitosos y corrige sólo los fallidos. Restaurar crea un draft; montar de nuevo no concede permiso de envío.

- `GET /v1/channel-inventory?product_id={id}`
- `GET /v1/channel-accounts/{id}/health`
- `POST /v1/assignments/batch`
- `GET /v1/assignments?product_id={id}`
- `GET /v1/assignments/{id}/preflight`

## 7. Resolver producto y conservar el chat

Responsable: Reglas deterministas; equipo ante ambigüedad.

Entrada: Referencia reconocida, mensaje/pedido previo o elección explícita.

Resuelve el producto antes del vendedor y flujo. En un mismo chat, cada producto conserva su recorrido, pedido, comprobantes y materiales. Un sí, ya pagué o monto aislado no elige un pedido.

Comprobación: Precedencia y conflictos registrados; Producto por seleccionar ante falta de contexto. Jobs/timers/efectos fijan asignación y versiones.

Recuperación: Deriva el caso ambiguo o selecciona explícitamente. La baja del contacto es global; límites y turnos se coordinan en el chat compartido.

- `GET /v1/conversations/{id}`
- `POST /v1/conversations/{id}/select-product`
- `GET /v1/assignments/{id}/history`

## 8. Revisar el alcance antes de enviar

Responsable: Equipo autoriza; reglas verifican cada efecto.

Entrada: Participantes/destinatarios concretos, límites, contenido, capacidades y vigencia.

Una autorización de A no cubre B. El preflight combina identidad, sesión, preparación, políticas, consentimiento, opt-out y warm-up. Cambiar una relación invalida sus permisos pertinentes.

Comprobación: Alcance registrado y guard de dispatch vigente. La salud o el color del número no conceden permiso.

Recuperación: Si una identidad o credencial global cambia, reconcilia el canal. UNKNOWN conserva historia y reserva; nunca repitas un envío incierto.

- `GET /v1/assignments/{id}/preflight`
- `POST /v1/assignments/{id}/authorize`

## 9. Preparar warm-up del teléfono

Responsable: Equipo selecciona alcance; motor persistido ejecuta.

Entrada: Participantes propios, identidad/evidencia, contenido, horarios, límites y vigencia.

Preparar muestra impacto sobre todos los productos. Activar guarda ese alcance concreto. Pausar detiene nuevos claims, conserva vuelo y progreso; no gradúa ni libera comercio. La simulación ejecuta recepción, ACK y respuesta con dos o tres cuentas virtuales sin red externa.

Comprobación: Software, simulación, prueba real y observación temporal se acreditan por separado. Treinta días efectivos, estabilidad siete días, muestra madura mínima20 y entrega98% son criterios internos, no garantías Meta.

Recuperación: Falta de conexión, compañero, evidencia o vigencia muestra causa y siguiente acción. No rellenes días, ACK ni graduación con datos virtuales.

- `GET /v1/warmup`
- `POST /v1/warmup/pools/{id}/preflight`
- `POST /v1/warmup/pools/{id}/activate`
- `PATCH /v1/warmup/pools/{id} (action=pause)`
- `POST /v1/warmup/pools/{id}/resume`
- `POST /v1/warmup/simulate`
- `GET /v1/warmup/simulations/{id}`

## 10. Operar y medir

Responsable: Equipo + Commerce OS.

Entrada: Conversación/pedido correcto y comprobante revisado.

El comprobante aprobado determina el importe y tier una sola vez; el extra es desglose incluido. Consulta resultados por producto y ventana. Los costos observados, estimados, reservados y desconocidos permanecen separados.

Comprobación: Atribución, dedupe, parciales, reversión e historial. Salud separa COMMERCIAL/WARMUP/TEST/SIMULATION; muestra numeradores, denominadores, fuentes y vigencia.

Recuperación: No equipares SENT con ingreso o silencio del cliente con caída. Sin muestra o n menor que20, las métricas son descriptivas e insuficientes para inferencia automática.

- `GET /v1/orders?product_id={id}`
- `GET /v1/reports/summary?product_id={id}`
- `GET /v1/costs?product_id={id}`
- `GET /v1/channel-accounts/{id}/health`

## 11. Gestionar cambios y excepciones

Responsable: Equipo + asistente operativo.

Entrada: Producto, revisión esperada, motivo y dependencias actuales.

El asistente consulta preparación y propone un diff; sólo declara cambio aplicado después de releerlo. Eliminar un flujo/vendedor envía a Papelera con dependencias revisadas y política de handoff; los pedidos y comprobantes se conservan.

Comprobación: Propuesta/estado, revisión, hash de dependencias, historial y lectura posterior.

Recuperación: Un recurso usado exige reemplazo/desasignación compatible o muestra el bloqueo. Restaurar no reactiva vínculos, timers ni autorizaciones.

- `GET /v1/products/{id}/assistant`
- `POST /v1/products/{id}/assistant/proposals`
- `POST /v1/products/{id}/assistant/proposals/{proposal}/state`
- `GET /v1/workflows/{id}/dependencies`
- `POST /v1/workflows/{id}/archive`
- `POST /v1/workflows/{id}/archive` con `archived: false`

## Opcional: investigación y verificación de APIs

Responsable: Codex o equipo, por acción explícita.

Entrada: Perfil/modelo configurado, presupuesto vigente y evidencia con fuente/fecha.

Consultar guardados no consume proveedor. Refrescar y analizar usa reservas y lotes. Las ofertas observadas, hipótesis y ofertas comerciales permanecen separadas. Verificar conexión comprueba una capacidad sintética, sin activar ventas.

Comprobación: Cobertura/modalidad, hechos citados, inferencias, vacíos, prompt/modelo, costos y latencia. HTTP200 o listar modelos no acredita inferencia.

Recuperación: 401/403, cuota,429 temporal, formato/modelo, conflicto y UNKNOWN tienen causas separadas. Una prueba de una revisión antigua no valida una nueva.

- `GET /v1/intelligence/offers`
- `GET /v1/intelligence/compare`
- `GET /v1/integration-profiles`
- `POST /v1/integration-profiles/{key}/verify`
- `GET /v1/provider-diagnostic-profiles`

## Software y operaciones comerciales

Responsable: Codex implementa; CI/CD publica software autorizado.

Entrada: Clasificación por función y dependencias.

Producto, materiales, oferta, flujo, vendedor y asignaciones soportados se operan por API, sin otro build. Cambios técnicos usan rama aislada, pruebas por impacto y CI/CD; verify no despliega.

Comprobación: SHA de main → run → paquete sellado/hash → deploy SUCCEEDED → HTTPS/API/MCP. Las operaciones comerciales requieren su propia lectura posterior.

Recuperación: Consulta un despliegue incierto antes de repetir. Conserva release previo, respaldos y rollback compatible; no borres historia ni restaures permisos operativos automáticamente.

- `GET /v1/openapi.json`
