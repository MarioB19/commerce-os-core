# V5: producción en Codex, tiers y archivo

Implementación: 2026-09-13. Publicación se acredita por separado con el SHA y el informe de despliegue. Decisión previa: [ADR](adr-v5-platform-retirement.md).

La plataforma ya no monta Studio, voz, recetas, lotes ni dispositivos de render. Las rutas anteriores responden `410 PLATFORM_PRODUCTION_RETIRED`; no existe un productor oculto por API/MCP. El código de fábrica local de Codex permanece en el checkout y en Vibe Marketing. Las cuatro páginas exclusivas del productor web se eliminaron después de comprobar su respaldo y restauración. El paquete servidor sólo contiene servicios compartidos; `scripts/stage-runtime.mjs` excluye motor, scripts de render y montajes retirados. El build inspecciona su grafo y rechaza importar estos productores. API, ingress, automation-worker (WhatsApp/Intelligence) y channel-worker se conservan.

## Recuperación antes y después del retiro

El respaldo [pre-V5 y prueba de restauración](evidence/v5-retirement-backup.json) enumera 49 fuentes, hash de cada archivo y del tar privado fuera de Git. La restauración de todas las fuentes fue comprobada en un directorio temporal antes del cambio. Para recuperar: verificar SHA del tar, extraer a un directorio nuevo y comparar todos los hashes del manifiesto. Esto recupera fuentes, no permisos de producción ni despliegue automático.

La migración `0042_v5_platform_retirement.sql` no borra tablas, activos, pedidos, mensajes, comprobantes ni accesos. Registra snapshots de trabajos/voz y compromisos anteriores en `platform_retirement_ledger`. Cancela jobs QUEUED/RETRY, deja RUNNING en revisión y conserva las operaciones pagadas/UNKNOWN y sus reservas. Revoca los dispositivos remotos y expira pairings pendientes. Los efectos terceros READY/BLOCKED se cancelan; SENDING/UNKNOWN siguen conciliables. Un resultado incierto requiere consulta de evidencia existente: nunca una nueva solicitud al proveedor para adivinar el resultado.

Los triggers rechazan nuevas filas de render, voz, patrocinio y outbox de patrocinio incluso si se restaura una versión antigua de oferta. Los accesos ya concedidos y la historia son excepciones conservadas; no se inventa su cumplimiento ni se envían avisos. El rollback de software usa los respaldos y el procedimiento CI existente; nunca se revierte la base borrando historia. Volver a habilitar un componente retirado exige una nueva decisión técnica y migración revisada.

## Archivo y cliente neutral

Rutas GET, con workspace/entorno/permisos y cursores:

- `/v1/archive/production/projects?product_id=…&cursor=…&limit=50`
- `/v1/archive/production/assets?project_id=…&cursor=…&limit=50`
- `/v1/archive/production/assets/:id/access`: acceso temporal al archivo existente.
- `/v1/archive/production/projects/:id/backup`: metadata sanitizada, hashes y cursor; restauración local sin replay.
- `/v1/provider-budgets/global`: presupuesto agregado compartido; PUT con revisión e idempotencia conserva reservas, costos confirmados y límites existentes.

`packages/commerce-client/src/index.ts` implementa `request(route,{method,body,idempotencyKey,expectedRevision})`: retorna envoltura completa `{data,meta,…}`, conserva errores/cursores y no reintenta escrituras inciertas. `call()` se conserva sólo por compatibilidad. `pages()` sigue el cursor y bloquea ciclos. MCP empaqueta este cliente sin incluir el worker de render ni configuración de dispositivos.

## Producir desde Codex

La fábrica local se conserva en `packages/creative-engine`, `packages/creative-contracts`, `apps/commerce-worker` y `scripts/creative-engine-*`; las fuentes y entrega final de Vibe Marketing son referencias de producción. El CLI local existente recibe archivos aprobados y binarios explícitos:

```sh
pnpm exec tsx scripts/creative-engine-render.ts \
  --plan /ruta/absoluta/plan.json --assets /ruta/absoluta/assets \
  --work-root /ruta/absoluta/salida --ffmpeg /ruta/absoluta/ffmpeg \
  --ffprobe /ruta/absoluta/ffprobe --browser /ruta/absoluta/chromium
```

Requiere el contrato, aprobación y derechos del plan local; no crea jobs web. Tras QA técnico y revisión editorial independientes, registrar los archivos finalizados por assets/API con producto/oferta, hash, origen y derechos. La eliminación de Studio no exige producir otro video ni volver a aprobar un video sólo por mencionar Madrina.

## Mi Ciclo Listo: tier genérico

La oferta versionada `mcl-receipt-total-v5` conserva Método del Acuerdo: 9700 centavos, 10700 **totales** y cualquier total aprobado superior a 10700 como Madrina. Los tiers son `acuerdo`, `kit`, `madrina`, mostrables por listas genéricas. `credited_tier` se calcula desde comprobantes aprobados únicos. `sale_amount_minor` se registra una sola vez; `payment_extra_minor` sólo desglosa el extra incluido, nunca se suma al ingreso. `madrina` en snapshots antiguos es compatibilidad de lectura, sin efecto de patrocinio.

Los parciales conservan la política vigente; 9700+1000=10700 (Kit) y +1=10701 (Madrina). Reclasificar Falso elimina su contribución de la acreditación; restaurar conserva el mismo pago sin duplicar entregas. Pruebas TEST permanecen excluidas del ingreso. `ORDER_CONVERSATION_MISMATCH`/`ORDER_PRODUCT_MISMATCH` bloquean un comprobante vinculado a otro recorrido/producto.

El importador transforma copias: excluye cinco textos exclusivos de terceros y reemplaza WA18 por la explicación del tier; limpia las promesas del conocimiento del vendedor. Los originales/hashes se conservan y `retired_material_review` identifica exactamente los textos afectados. Una referencia a Madrina no descarta un audio: sólo medios que realmente prometen entrega a terceros requieren reemplazo y revisión.

## Ensayo con comprador único

En Producto → Pruebas, elegir relación vigente, comprador propio, propósito y vigencia. Guardar persiste y relee el alcance sin enviar. Conserva draft por producto/entorno, revisión de relación, claves idempotentes, revocación e historial. No pide una beneficiaria.

API/MCP: POST `/v1/launch-tests` con `account_id`, `offer_version_id`, `assignment_id`, `product_id`, `participants:[{contact_id,role:"buyer",own_phone_confirmed:true}]`, `purpose` y `expires_at`. El servicio requiere `simulations:run`; el vendedor efectivo usa `workflows:read`. El ensayo debe preceder el pedido. El backend bloquea relación ambigua, oferta distinta, contactos duplicados, alcance vencido o un pedido ya abierto de esa oferta. Declarar TEST no habilita envíos; el permiso operacional es independiente.

## Verificación del subalcance

- 54 integraciones pasaron en PostgreSQL aislado con migraciones 0001–0042: tiers, parciales, revisión duplicada, Falso/restauración, comprador único, archivo/backup, guards de retiro, scopes, importador reanudable y presupuesto compartido.
- 45 unitarias: cliente neutral, umbrales y corpus de 28 casos de vendedor; sin evaluación de modelo real.
- 74 pruebas Python CI/publicación; staging del runtime comprobado con un test que verifica ausencia del renderer y presencia de bootstrap/migración/backups/servicios.
- Ninguna prueba de este subalcance consumió APIs de pago ni envió WhatsApp. Estas cifras se refieren a validación local y no prueban publicación.

## Materiales terminados, sin generación en plataforma

Producto → Oferta y materiales incorpora archivos de 1 byte a 500 MiB mediante partes de 8 MiB. Se calcula SHA-256 de forma incremental en el navegador y el verificador remoto confirma bytes, tipo y hash antes de sellar. La ficha conserva producto, oferta opcional, origen CODEX, referencia de entrega, derechos y evidencia de revisión. `HUMAN_APPROVED` es una declaración atribuida a la persona autenticada; un servicio puede registrar revisión pendiente/asistida, pero no afirmar aprobación humana.

Contratos de ingesta:

- POST `/v1/assets/uploads`: reserva con `product_id`, `offer_id?`, `name`, `size_bytes`, `sha256`, `content_type`, `purpose`, `source:"CODEX"`, `origin_reference`, `rights` y `review`. Requiere `assets:write`, Idempotency-Key y alcance del producto/oferta. Reservar no llama a R2.
- POST `/v1/assets/uploads/:id/initialize`, `/complete`, `/abort`: misma sesión, idempotencia y estados durables. Un inicio incierto se concilia por su clave remota sin repetir creación. Las partes incompletas y los hashes falsos no se registran READY.
- POST `/v1/assets/uploads/:id/parts/:part`: firma sólo la parte de staging del tamaño esperado. El browser reintenta explícitamente el mismo upload, nunca crea un objeto final directamente.
- GET `/v1/assets/uploads/:id`: metadatos del upload y lectura real de la ficha registrada. El identificador de catálogo sólo aparece si esa ficha existe.
- GET `/v1/products/:id/materials?cursor=…&limit=30`: biblioteca del producto con `meta.next_cursor`; GET `/v1/assets/:id/access`: acceso temporal a la ficha registrada, autorizado por asset o por su producto comprobado en la tabla de ingesta.

Los efectos de almacenamiento externo (inicio, partes, finalización, cancelación y acceso firmado) requieren REAL. SIMULATION puede conservar la reserva de metadata y se rechaza antes de llamar al almacenamiento. La interfaz ofrece ingesta desde el producto operativo. Si la transferencia se interrumpe o se recarga la página, conserva el upload y pide el mismo archivo (tamaño/hash), con opción de consultar o cancelar. La cancelación no borra un asset READY. El registro no publica campañas ni activa WhatsApp.

La ficha queda `usage:MARKETING_REFERENCE` y `delivery_eligible:false`. Las referencias comerciales y `gateDispatch` impiden usarla como entrega por WhatsApp antes de reclamar o llamar al adaptador. Una futura entrega compatible requeriría un contrato explícito de canal; no se hace una conversión oculta ni se intenta leer R2 como archivo local cifrado.

## Configuración y presupuesto compartidos

Ajustes → Integraciones conserva perfiles R2, SearchAPI y OpenAI, edición de presupuestos globales/por proveedor y autorización CORS del origen de la plataforma. GET/PUT de configuración y presupuesto usan `integrations:read`/`integrations:write` con recursos `creative:r2`, `creative:searchapi`, `intelligence:openai` y `provider-budget:global`. No requieren `studio:*`. El servicio limitado sólo ve sus perfiles/presupuestos; los miembros siguen siendo administrativos. Las revisiones, idempotencia, vencimientos, reservas y prohibición de bajar del total comprometido permanecen vigentes. Recuperar una operación OpenAI exige `integrations:verify` para `intelligence:openai` y REAL; no crea otra inferencia.

Evidencia adicional: 19 integraciones en PostgreSQL aislado (migraciones 0001–0044), más 9 de la máquina de almacenamiento; 7 E2E con API/S3 explícitamente simulados pasaron, incluidos archivo de 22 MiB real en navegador, interrupción/recarga, lectura de procedencia, permisos, draft de comprador, revocación y accesibilidad/reflow 320/390/768/1440. Typecheck web y lint de este alcance pasaron. La integración general debe volver a ejecutar la suite de repositorio y acreditar el despliegue por su SHA; estos resultados no prueban R2 ni WhatsApp reales.


## Retirada de fuentes y distribución remota

Las páginas `studio.tsx`, `studio-recipe.tsx`, `studio-voice.tsx` y `creative-settings.tsx` ya no existen en la aplicación web. Se conserva `creative-shared.tsx` porque aporta formularios comunes a Inteligencia e Integraciones. El [manifiesto de páginas](evidence/v5-web-retirement-backup.json) acredita los hashes y la restauración previa. Los workflows `creative-desktop.yml` y `creative-worker-operation.yml` son avisos manuales de retirada; no tienen push, cron, checkout, secretos, construcción, descarga ni publicación de installers. Sus originales se conservan en el [respaldo de workflows](evidence/v5-desktop-retirement-backup.json). Dos pruebas de CI verifican estas condiciones y la conservación de la fábrica local.

El archivo usa `assets:read` para credenciales nuevas y `catalog:read` para personas. Un token histórico `studio:read` conserva sólo lectura con su membresía vigente. Siempre se intersectan los límites de proyectos del actor y los recursos de la credencial; una credencial acotada al producto sólo puede leer proyectos de ese producto. Los respaldos no habilitan replay ni ejecución.


## Verificación final de recuperación y fábrica local

`pnpm test:recovery` pasó el 2026-09-14 UTC con respaldo AES-GCM, restauración en una base PostgreSQL 17 nueva, comprobación de asset privado y rechazo de alteraciones/links antes de crear una base. La fixture importa dos registros históricos de producción sólo con una bandera explícita y nombre de base aislada, dentro de una transacción. La restauración conserva USD0.024 en reservas de proveedor y 84 bytes sintéticos de almacenamiento, marca como UNKNOWN los requests/diagnósticos/corpus/uploads pendientes, detiene lotes en cola y elimina las autorizaciones de asignaciones. Conserva historial de asignación y metadata de materiales terminados. [Resultado medido](evidence/recovery.json).

La comprobación local de fábrica compiló cuatro entradas (CLI de render, worker, engine y MCP neutral) y el bundle de composición Remotion en un directorio temporal. Pasaron 88 pruebas en diez archivos de fábrica/worker. No se generó video ni se firmó un instalador. La distribución del servidor excluye por lista explícita 18 scripts productores en `package-ci.py`; los originales siguen disponibles para la fábrica local y se conservan scripts compartidos de archivo/Inteligencia.
