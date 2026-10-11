# API privada de Commerce OS

Base `/v1`; OpenAPI generado en `GET /v1/openapi.json`. Fastify independiente, puerto local 3001; `/livez` y `/readyz` distinguen proceso y PostgreSQL. REST de negocio requiere sesión Better Auth o token acotado. Registro público cerrado.

## Acceso y concurrencia

`POST /api/auth/sign-in/email` usa cookie HttpOnly. Mutaciones con cookie verifican Origin de TRUSTED_ORIGINS. Propietario provisiona cuentas individuales en Sistema o `POST /v1/users`; contraseñas con hasher Better Auth. La migración 0004 incorpora el issuer local:credential requerido por Better Auth 1.7.

`POST /v1/service-tokens` owner: `{name,scopes,expires_at}`. Scopes: products:read/write/publish, offers:read/write/publish, workflows:read/draft/publish, simulations:run. Los scopes de publicación sólo habilitan versiones internas y no conceden acciones externas. Hash de autenticación; respuesta idempotente de credencial cifrada. DELETE revoca inmediatamente. Estos tokens no envían, administran canales, autorizan operación, leen bancos ni concilian.

POST de negocio y PUT de contenido requieren Idempotency-Key estable por operación lógica. Repetir clave/cuerpo devuelve lo anterior; otro cuerpo da 409. PATCH usa expected_version. DELETE de token/autorización también requiere clave y deja auditoría. Usuarios/tokens se crean atómicamente con su registro idempotente.

Guía ejecutable completa: [Automatizaciones API-first](api-automation.md), con autenticación, scopes, producto → oferta → flujo, publicación interna, versiones, idempotencia, errores y revocación. Decisión: [ADR de API-first](adr-api-first-2026-09-06.md).

## Catálogo para asistentes

```bash
curl --fail-with-body "$COMMERCE_API_URL/v1/products" \
  -H "Authorization: Bearer $COMMERCE_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $COMMERCE_OPERATION_ID" \
  --data '{"name":"Producto de demostración","initial_offer":{"currency":"MXN","base_amount_minor":9900,"fulfillment":[]}}'
```

Las variables se configuran mediante canal protegido, fuera del repositorio. Respuesta `{data:{id,version,environment,...,initial_offer,readiness}}`; crear no publica ni requiere WhatsApp. environment predeterminado SIMULATION; REAL se consulta y reporta separado.

- Productos: GET /products, GET/PATCH /products/:id, POST /products/:id/duplicate, GET /products/:id/versions.
- Versiones: GET/POST /products/:id/versions, /offers/:id/versions y /workflows/:id/versions. Productos cambian estado con POST /products/:id/transition.
- Ofertas: POST /products/:id/offers crea ID inmutable nuevo. POST /offers/:id/publish `{expected_version}` verifica banco/política/assets finalizados y devuelve otra versión PUBLISHED. No habilita envíos.
- Banco: POST /bank-profiles `{name,bank,holder,account_number,currency,instructions}` cifra material; GET sólo alias/banco/terminación/versión. POST /receipt-policies configura política determinista de aprobación del comprobante.
- Assets: POST /assets/upload-intents `{name,kind:"file",mime_type,size_bytes,sha256?}`; PUT /assets/:id/content `{base64}` verifica tamaño, SHA256 **de bytes** y firmas conocidas; POST /assets/:id/complete finaliza. READY queda sellado: cambios requieren otro asset.
- Archivos cifrados en PRIVATE_STORAGE_DIR/assets/storage_key.enc fuera del vault. GET /assets/:id/content requiere owner/operator/reconciler y usa attachment/no-store. Link exige HTTPS; access conserva referencia de entrega cifrada.

## Ventas persistidas

Colecciones /conversations, /contacts, /leads, /orders, /receipts, /fulfillments, /touchpoints responden `{data:[],meta:{total}}`. Filtros q/status/stage/account_id/product_id/assigned_to/offer_version_id, entorno, limit/offset. Un vendedor sólo accede a conversaciones asignadas, incluso desde ID directo de contacto/pedido/comprobante.

GET /conversations/:id incluye mensajes, eventos, outbox, contacto, oferta histórica, pedido y controles. Lecturas ordinarias minimizan datos bancarios/accesos. POST /conversations/:id/commands admite mensajes/media referenciada, asignación, etapa, consentimiento, baja, compromiso y comprobante. Responde 202 con comando durable; GET /commands/:id distingue PENDING/APPLIED/FAILED. Aceptación de comando no prueba envío completado.

POST /conversations/:id/controls `{paused?,takeover?,suppressed?,reason}` escribe control urgente y muestra in_flight. Consentimiento usa `{type:"consent",consent:{purpose,source,observed_at,evidence}}`. Baja aplica al contacto entre números.

POST /receipts/:id/review `{decision:"APPROVED"|"REJECTED"|"HUMAN_REVIEW",reason,expected_version}` exige permiso documental. Aprobar exige importe positivo y evidencia privada; puede recibir amount_minor/currency aceptados, payment_key adicional y replaces_receipt_id. `/orders/:id/reconcile` se conserva deprecado para consumidores legados; no gobierna el ingreso.

GET /outbox, /timers, /events. Outbox /edit invalida aprobación inmediatamente y crea comando; /approve valida hash+autorización; /cancel no deshace HTTP aceptado. /resolve owner con outcome/evidence resuelve UNKNOWN: confirmar no enviado cancela, nunca reenvía a ciegas.

## Flujos, importación y campañas

POST /workflows/validate, /apply, /:id/publish, /:id/duplicate, /:id/rollback; nodos tipados, sin código arbitrario. Publicar/revertir crea versión para nuevas ejecuciones. POST/PATCH /agents conserva conocimiento anterior mediante IDs inmutables, con proveedor/modelo/timeout/costos/tokens configurables.

POST /simulations `{account_id,offer_version_id,workflow_version_id?,contact_name?}` sólo acepta cuentas/entorno simulados. Responde id y command_id. POST /simulations/:id/advance `{seconds}` avanza reloj durable.

POST /message-campaigns/:id/preview muestra elegibles/exclusiones. /schedule requiere fecha, expected_version, autorización owner vigente de hash/campaña/cuenta/límite. /cancel invalida inmediatamente. Adquisición: /acquisition-campaigns, /ad-sets, /ads, /bindings conservan source/evidence y vigencia.

GET /contacts/export conserva contactos/históricos y procedencia. JSON `{source,environment,rows,meta}` es reutilizable en POST /imports/preview. Preview valida/deduplica sin fabricar consentimiento. POST /imports/:id/commit crea comando. Históricos importados quedan no verificados y no disparan workflows.

POST /conversions/prepare `{order_id,destination:"export"|"meta_business_messaging"}` exige venta válida por comprobante; un evento lógico por pedido/destino. Business Messaging necesita ctwa_clid observado, dataset/API y evidencia vigente de elegibilidad configurada en cuenta. Sólo faltantes reales producen blockers. GET /conversions/:id/export descarga propuesta. No envía CAPI ni asume deduplicación remota.

Meta devolvió 429 en la página central consultada; se contrastaron campos base con [SDK oficial](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/objects/serverside/user-data.js) y [ejemplo oficial](https://github.com/fbsamples/lead-ads-webhook-sample/blob/main/postman/FB%20Conversions%20API%20%28Part%201%20-%20online%29.postman_collection.json). La configuración exige evidencia del contrato/eligibilidad vigentes para preparar payload específico. Preparación local no acredita integración remota.

## Operación y comprobación

POST /channel-accounts/:id/commands lifecycle/health pasa al channel-worker. GET /channel-accounts/:id/qr autentica y delega al canal interno con no-store; nunca comparte API key. /assignments crea binding temporal. POST /incidents/:id/resolve audita resolución sin reanudar silenciosamente la cuenta.

POST /operation-authorizations owner exige confirmation AUTHORIZE_SCOPE, scope de cuentas/versiones/audiencias/límites, config_hash y expires_at. Cambiar configuración no extiende una aprobación. Seed no autoriza operación real. /system/controls pausa workspace/cuenta/flujo con motivo. Resultados /reports/summary y /reports/export incluyen definición, filtros y evidencia.

POST /assignments/:id/authorize exige la revisión de la asignación y la configuración, `recipient_mode`, destinatarios, `max_messages`, `expires_at`, permiso de automatización y `AUTHORIZE_REAL_SCOPE`. El dueño puede fijar hasta 366 días; operadores y tokens de servicio sólo hasta siete días. La renovación revoca el permiso anterior en la misma transacción. Para `new_inbound`, si asignación, revisión, identidad y configuración siguen iguales, las conversaciones iniciadas desde el primer permiso conservan su elegibilidad durante su ventana de atención. Este endpoint no inicia campañas ni envía mensajes al guardar.

Pruebas: api-security.test.ts (auth real PostgreSQL, alta cerrada, CSRF, idempotencia, ámbitos/roles, assets y tokens), role-boundaries.test.ts (roles reales PostgreSQL), sales-journey.test.ts (dos productos/conversaciones completos), database.test.ts (referencias, revisiones, concurrencia, cifrado). Provider real, monitor externo y producción se reportan separados de estos resultados locales.

## Retención de contenido

POST /retention/policies owner requiere confirmation APPROVE_RETENTION_POLICY, motivo, caducidad y TTL explícitos en días para envelopes, mensajes, assets, IA e idempotencia. La aprobación de una política no ejecuta borrados. GET /retention/policies consulta sólo el workspace/entorno.

El proceso de mantenimiento utiliza una conexión PostgreSQL con rol commerce_maintenance, separado de api/ingress/automation/channel. Con Node/tsx y entorno protegido cargado:

```bash
pnpm exec tsx scripts/retention.ts plan --policy "$RETENTION_POLICY_ID" --workspace "$COMMERCE_WORKSPACE" --environment SIMULATION
pnpm exec tsx scripts/retention.ts apply --plan "$RETENTION_PLAN_PATH" --confirm "$RETENTION_PLAN_DIGEST" --environment SIMULATION
```

El primer comando sólo persiste/guarda una propuesta privada de IDs/hashes. Aplicar confirma ese digest exacto, vuelve a comprobar política, cambios posteriores, ámbito, vigencia y referencias. La eliminación de archivos pendientes se puede reanudar idempotentemente. REAL exige además ALLOW_REAL_RETENTION=true y flag --real-authorized; no se habilitan en setup ni pruebas.

Se redacta contenido vencido de envelopes terminales, mensajes (incluidas revisiones), caché de texto de conversaciones inactivas, propuestas IA, texto de efectos terminales y respuestas idempotentes del entorno. Los mensajes/evidencias con trabajo en vuelo y archivos referenciados se conservan. IDs, tiempos, fuente, hashes y tombstones quedan auditables. Una respuesta idempotente retenida devuelve 410 y nunca vuelve a ejecutar la operación. Bases/archivos activos y backups tienen retenciones distintas; este proceso no acredita eliminación en backups externos.

Verificación: tests/integration/retention.test.ts pasa contra PostgreSQL aislado; pruebas sintéticas de borrado selectivo, preservación financiera/procedencia, digest/candidato cambiado, replay, límite de roles y bloqueo REAL. La política/TTL para clientes reales sigue requiriendo aprobación operativa.

Un paso `approval` se autoriza con `POST /v1/conversations/:id/commands` y `{type:"approve_step",expected_workflow_version_id:"versión fijada",expected_node_id:"nodo pendiente",reason:"Justificación"}`. Sólo usuarios con `sales:operate` y acceso a esa conversación. El worker compara ambos IDs con su ejecución vigente antes de avanzar; un cambio posterior invalida la solicitud. Esta aprobación no reemplaza autorización de envío REAL.

## Campañas y correcciones — receipt_sales_v1

[API de rendimiento, clasificación, Insights e historia](campaign-receipt-sales.md#api-y-permisos). Revisión y clasificación requieren owner/operator/reconciler, motivo y versión; el reporte es agregado para analyst/viewer. Un 202 es aceptación del comando, no aprobación aplicada: consultar /commands/:id. Las clasificaciones no envían mensajes ni conversiones. `counts.reconciled` permanece como alias de compatibilidad de ventas por comprobante; los consumidores nuevos usan `counts.sales`.


## Token personal owner

El owner puede administrar los endpoints de `/v1` mediante un token personal `cos_pat_`. `/v1/me` devuelve `authentication_method: personal_access_token`, owner vigente, entornos y caducidad. No es un token de servicio ni una sesión/cookie. Consultar [decisión, emisión y recuperación](adr-owner-personal-api-tokens.md).

- `GET /v1/personal-access-tokens`: metadatos sin secreto.
- `POST /v1/personal-access-tokens`: `environment`, `name`, `allowed_environments`, `expires_at`, `reason`, `confirmation: CREATE_OWNER_API_TOKEN`. Máximo 90 días; clave idempotente.
- `DELETE /v1/personal-access-tokens/:id`: versión vigente, motivo y `confirmation: REVOKE_OWNER_API_TOKEN`.
- `POST /v1/personal-access-tokens/:id/rotate`: nueva configuración, versión vigente, motivo y `confirmation: ROTATE_OWNER_API_TOKEN`; reemplazo y revocación atómicos.

Alta/rotación devuelven el secreto sólo en su respuesta privada con `Cache-Control: no-store`; los replays disponibles se cifran. Rotar el token utilizado invalida inmediatamente el anterior: si se pierde la respuesta, detenerse y recuperar mediante otra sesión owner/administración, nunca emitir repetidamente. Guardar sólo en directorio 0700 y archivo 0600. Un PAT no emite otro con entornos o plazo superiores al suyo. El cambio de contraseña y su recuperación mantienen las verificaciones propias de `/api/auth`; no aceptan Bearer.

El MCP existente acepta el PAT desde `COMMERCE_MCP_TOKEN_FILE`. Sus herramientas publicadas mantienen sus argumentos y restricciones; los endpoints administrativos sin herramienta específica se operan mediante HTTPS. Emitir el PAT no inicia QR, sesiones, warm-up, campañas, gasto ni mensajes.

La rotación explícita de un token propio permite renovar su plazo hasta 90 días desde la solicitud, sin ampliar entornos. Crear otro token conserva el límite de plazo del emisor. Esto permite renovar el acceso desde la propia API mientras el token siga vigente, con confirmación y auditoría. No hay renovación automática.

## Permisos internos para gestionar números

La migración0048 habilita las columnas que utilizan los contratos existentes de conciliación, congelamiento de ownership, reconocimiento de alertas y apertura de incidentes. No concede ejecución de comandos, transferencia/renovación de leases ni borrado de historial al rol de base de datos de la API. Se verifica el recorrido HTTP completo con PAT owner y `commerce_api`, logout con `commerce_channel` y un proveedor sintético aislado. [Decisión y límites](adr-channel-api-runtime-permissions.md).
