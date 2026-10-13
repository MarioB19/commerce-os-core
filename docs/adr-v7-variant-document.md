# V7 F4 — Documento de variante, publicación por partes y modelo de IA por variante

13-oct-2026. Agente: Claude. Desarrolla ADR-V7-05 (versiones por variante y
contexto fijado) y ADR-V7-06 (IA por capacidades y key del perfil). Cubre RF-05,
RF-06, RF-08, RF-13.d, RF-14.a/c/d, RF-15 y la parte de F4 de RF-17. No instala
nada en producción: la adopción de productos existentes corre en la ventana de
Fase C con `scripts/v7-variant-migration.ts`.

## Decisión

Un **producto padre** agrupa **variantes** por mercado (país, moneda, idioma y
zona horaria). Cada variante es un único documento editable en cinco secciones:
Venta, Oferta y materiales, Cobro, Remarketing y Números. El documento vive en
`market_variants.document`; el cobro va cifrado aparte en
`market_variants.collection_ciphertext`, y la vista sólo devuelve banco y los
últimos cuatro dígitos de la CLABE, o proveedor y dominio de cada enlace.

Guardar una sección sólo cambia el borrador. **Publicar** materializa las piezas
que cambiaron (perfil de cobro, vendedor, flujo y oferta) reutilizando las
existentes cuando su hash no cambió, valida la configuración completa con el
mismo validador de `market-variants`, crea una versión (`market_releases`) y la
marca como actual. La publicación aplica a **conversaciones nuevas**: cada
conversación fija la versión con la que empezó (`market_journey_snapshots`).

Un número vende una o varias variantes (N:M) mediante
`commercial_assignments.variant_id`. La asignación sigue a la variante: publicar
no cambia la revisión de la asignación ni pide autorización nueva. Asignar un
número a una variante es una decisión humana: un token personal o el MCP reciben
`HUMAN_ASSIGNMENT_REQUIRED` (D-01); quitarla sí está permitido.

## Modelo

| Elemento | Dónde | Regla |
|---|---|---|
| Documento | `market_variants.document` (jsonb validado por `variantDocumentSchema`) | `schema_version` 1; secciones `sale`, `offer`, `collection`, `remarketing`, `ai`, `locale`; `pending_review` tras duplicar |
| Cobro | `collection_ciphertext` + `collection_revision` | SPEI (CLABE con dígito verificador, pesos 3/7/1, sólo MXN) y/o enlaces HTTPS; nunca en claro en la vista, el MCP ni los registros |
| Publicado | `published_document_sha256`, `materialized`, `current_release_id` | El guard sólo deja cambiar el hash publicado en una transición de versión con borrador intacto |
| Archivo | `archived_at` | Bloqueado con números activos (`VARIANT_HAS_ACTIVE_NUMBERS`) |
| Historial | `market_variant_events` (+ `detail`) | SECTION_SAVED, REVIEWED, ARCHIVED, RESTORED, DUPLICATED, MIGRATED además de los eventos previos |
| Números | `commercial_assignments.variant_id` | FK compuesta, trigger `guard_assignment_variant` (`ASSIGNMENT_VARIANT_NOT_SELLABLE`) |

Estados visibles: Por configurar, Falta cobro, Listo para asignar, Vendiendo y
Archivada. Una variante completa que nunca se publicó sigue en «Por configurar»
con el botón de publicar activo.

Precios en unidades menores con una tabla ISO fija compartida por servidor y web
(0 decimales para COP, CLP, JPY y similares; 3 para BHD, KWD y similares; 2 por
defecto). La tabla evita que el número de decimales dependa de la versión de ICU.

### Duplicar a otro mercado

`duplicateVariantDocument` copia venta, oferta y remarketing, ajusta idioma y
moneda, **borra el cobro, la política de comprobantes y los números**, y marca
las seis secciones como pendientes de revisión. No copia autorizaciones, keys ni
asignaciones (ADR-V7-05).

### Flujos de venta

- **Por conversación** (base nueva): oferta → acuerdo → compromiso → entrega
  de núcleo → cobro (con `{{bank_instructions}}`) → comprobante → pagado →
  posventa. Las anclas de remarketing quedan en «esperando acuerdo» y «esperando
  pago». El clasificador contextual de compromiso sólo se activa en español.
- **Guiado**: `salesAgreementWorkflowV1` con audios y textos del negocio.
- **Existente**: conserva un flujo publicado del mismo producto (para productos
  migrados).

## Migración producto → México

`scripts/v7-variant-migration.ts plan` calcula, sin escribir, para cada producto
existente su oferta vigente (la más fijada por asignaciones activas o, si no hay,
la última publicada), su flujo, vendedor, cobro y materiales, las excepciones y
un digest. `apply <sha256>` exige ese digest y, por perfil, crea la variante
«México» en modo `existing`, una versión 1 que **fija los registros actuales**
(sin rematerializar), el `seller_mode` del agente heredado y `variant_id` en las
asignaciones de esa oferta. Es idempotente y conserva IDs, conteos e historia.
Debe correr en Fase C **antes** de `scripts/v7-continuity-adoption.ts`.

## Materiales privados

Enlaces (listos al crear) o archivos de hasta 20 MB subidos en partes de 4 MiB.
Cada parte se cifra al recibirla; al completar se verifica tamaño, SHA-256 y
firma, y el archivo final se guarda cifrado en el almacén privado. Un material
fijado por una versión vigente no se puede archivar. `sweepMaterialUploads`
limpia subidas abandonadas. La réplica GCS del almacén privado es trabajo de F1.

## IA por variante

- Catálogo revisado `official-2026-10-13` (migración 0106), vigente hasta
  2027-04-01, en microUSD por millón de tokens, con los precios oficiales de
  contexto corto de OpenAI, Anthropic y Google. Después de esa fecha la admisión
  responde `PRICE_EXPIRED` hasta instalar una versión revisada; nunca se infiere
  un precio.
- Tareas: `sales.chat` (chat), `receipt.document` (visión) y
  `audio.transcribe` (audio). Cada variante elige modelo principal y alternativo;
  si no, usa el predeterminado del perfil. El alternativo sólo puede ser de una
  key del mismo perfil ya configurada; si nada cubre la tarea, la atiende una
  persona (`CAPABILITY_NOT_CONFIGURED`).
- La persona Dueña autoriza la IA de la variante al publicar con su sesión o con
  la acción explícita `POST /v2/variants/:id/ai-authorization`. Se emite un
  permiso por tarea que vence con la versión de precio. Una publicación de una
  persona Operadora deja la IA en `NEEDS_OWNER`.
- El vendedor con proveedor `profile` usa `ProfileSellerAi`: busca el permiso,
  admite y reserva contra el presupuesto mensual del perfil, llama con la key
  del negocio y registra el intento imputado a variante y conversación. Sin
  permiso falla con `AI_AUTHORITY` y la conversación pasa a una persona.
- `open_ai_budget_periods` (migración 0107) abre cada hora el mes en curso y,
  en sus últimos tres días, el siguiente, con el límite que fijó la Dueña. No
  cambia periodos abiertos ni sube límites.
- Las pruebas usan un proveedor de contrato simulado; no se consumió ninguna key
  de negocio.

## API

Todas las mutaciones exigen `Idempotency-Key` (UUID) y `expected_version`.

| Ruta | Uso |
|---|---|
| `GET/POST /v2/products` | Listar y crear producto con su primera variante |
| `PATCH /v2/products/:id`, `GET …/dependencies`, `POST …/archive`, `POST …/restore` | Editar, ver dependencias, archivar y restaurar |
| `POST /v2/products/:id/adopt` | Adoptar un producto existente como variante «México» |
| `GET/POST /v2/variants` | Listar y crear variante |
| `GET /v2/variants/:id`, `GET …/history` | Vista con estado, faltantes, cambios sin publicar, números e historial |
| `GET/PUT /v2/variants/:id/:section` | Secciones `sale`, `sales-flow`, `seller`, `offer`, `collection`, `remarketing`, `ai`, `market` |
| `POST /v2/variants/:id/review`, `…/publish`, `…/duplicate`, `…/archive`, `…/restore` | Revisar, publicar, duplicar, archivar y restaurar |
| `GET/POST /v2/variants/:id/numbers`, `GET …/numbers/:account_id/impact` | Números de la variante, asignar o quitar, e impacto previo |
| `GET /v2/variants/:id/ai-status`, `POST …/ai-authorization` | Estado de IA por tarea y confirmación de la Dueña |
| `GET /v2/number-variants`, `GET …/:id/history` | Vista inversa: qué vende cada número |
| `GET /v2/variant-operations/:id` | Consultar una operación incierta por su `Idempotency-Key` |
| `/v2/materials` | Listar, crear, subir partes, completar, cancelar, archivar y vista previa |

El MCP expone las mismas acciones en `products_manage`, `variants_manage`,
`offers_manage`, `sales_flows_manage`, `sellers_manage`, `collections_manage`,
`materials_manage` y `number_assignments_manage` (asignar devuelve
`HUMAN_ASSIGNMENT_REQUIRED`).

### Errores

| Código | HTTP | Significado |
|---|---|---|
| `VERSION_CONFLICT` | 409 | Otra persona guardó cambios; el formulario conserva los tuyos |
| `VARIANT_INCOMPLETE` | 409 | Faltan secciones para publicar (lista en `problems`) |
| `VARIANT_NOT_PUBLISHED` | 409 | Se intentó asignar una variante sin versión publicada |
| `NUMBER_SELLS_OTHER_VARIANT` | 409 | El número ya vende otra variante del mismo producto |
| `VARIANT_HAS_ACTIVE_NUMBERS`, `PRODUCT_HAS_ACTIVE_NUMBERS` | 409 | Archivar con números activos |
| `VARIANT_CURRENCY_LOCKED` | 409 | Cambiar la moneda de una variante ya publicada |
| `COLLECTION_*` | 400 | Cobro incompleto, SPEI fuera de MXN, enlace vacío o repetido |
| `VARIANT_FLOW_*`, `VARIANT_GUIDED_CONTENT_REQUIRED`, `VARIANT_SALE_MESSAGES_REQUIRED` | 400 | Flujo no publicado, de otro producto o contenido faltante |
| `VARIANT_CONFIGURATION_CHANGED` | 409 | La configuración cambió durante la publicación |
| `MARKET_OPERATION_CONFLICT`, `MARKET_OPERATION_BUSY` | 409 | La misma `Idempotency-Key` con otros datos o aún en curso |
| `PRODUCT_NOT_FOUND`, `VARIANT_NOT_FOUND`, `NUMBER_NOT_FOUND`, `VARIANT_NUMBER_NOT_ASSIGNED` | 404 | No existe en este perfil y entorno |
| `HUMAN_ASSIGNMENT_REQUIRED`, `PROFILE_INTERACTIVE_SESSION_REQUIRED` | 403 | Acción reservada a una persona con sesión |

## Verificación local (sin FULL)

- Dominio: 8 pruebas del documento de variante; 5 del catálogo de precios
  (incluida la igualdad exacta con la migración 0106).
- PostgreSQL con roles restringidos y RLS FORCE: `v7-variants`,
  `v7-variant-migration`, `v7-materials` y `v7-variant-ai` (recorridos completos),
  más `market-variants` (15), llaves compuestas (538) y catálogo de transición
  (107 migraciones).
- MCP: 10 pruebas del servidor de perfil, incluidas las nuevas acciones.
- Chromium (Playwright, local): crear producto, guardar venta, oferta con
  material, cobro SPEI, publicar y vender en un número en 11 s automatizados;
  sin desbordamiento horizontal en 390 px.

## Pendiente fuera de F4

- Transcripción de notas de voz en tiempo de ejecución y lectura de
  comprobantes con IA V7 (`receipt.document`): F5.
- Réplica GCS del almacén privado y usuario `commerce_ai` de producción para
  `AI_DATABASE_URL`: F1.
- Tiempo de RF-17 con personas reales: F7/F9 (acción de Brandon).
- Retiro del stack anterior de variantes de mercado en web, MCP y cliente: F8.
