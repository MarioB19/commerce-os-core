# Campañas y ventas por comprobante — publicado

Implementación de H1–H6 del plan de Commerce OS, 06-sep-2026 (verificaciones en 07-sep UTC). Implementado en `codex/campaign-receipt-sales` e integrado a `main`. Brandon autorizó después la publicación: `6e62fc4` instalado el 07-sep-2026 UTC, CI/CD 34080526415 correcto. [Evidencia productiva](evidence/campaign-production-publication.json). Decisión: [[adr-receipt-sales]].

## Verdad comercial y transiciones

`receipt_sales_v1` reconoce el importe positivo aceptado de un comprobante privado READY. La aprobación humana y la política automática llaman a la misma función transaccional. El precio de la oferta no sustituye un importe ausente; la moneda conserva procedencia documental, humana o de configuración del pedido. Los importes usan unidades menores ISO, con sumas enteras y rechazo de desbordamiento.

`sale_id = order_id`. `payment_contributions` conserva pago, documento, importe, moneda, fecha efectiva, procedencia y revisión. Un pedido puede tener aportes adicionales explícitos y sigue siendo una venta. `payment_key` vacío selecciona el pago principal; otra clave representa otro pago. `replaces_receipt_id` sustituye evidencia de ese pago conservando la fecha original. Una imagen ya utilizada permanece protegida contra reuso incluso después de sustituirse.

Prueba es clasificación del pedido completo. Falso invalida la contribución del comprobante. Las consultas derivan la exclusión desde los hechos vigentes: no hay descuentos acumulativos. Restaurar requiere rol autorizado, motivo, versión y evidencia original. Actor, motivo e historia permanecen en eventos; las correcciones recalculan el periodo original y cambian la revisión de exportación. El gasto de Meta se conserva.

La primera aprobación operativa cancela cobros y libera los beneficios configurados una vez. Los nodos históricos `reconcile` y condiciones `reconciled` satisfacen la aprobación del comprobante sin escribir una conciliación ficticia. El dedupe de entrega abarca ambas condiciones. Nuevas plantillas, receta Preescolar y fallback `default-sales-v2` terminan con comprobante/beneficio; las versiones publicadas permanecen selladas. Revisión de importe, clasificación, restauración y backfill no disparan nuevas entregas.

## Rendimiento y atribución

Corrección del dashboard de 08-sep-2026: [[adr-dashboard-meta-efficiency]]. `groups.products` separa productos confirmados (`source: EXPLICIT_MAPPING`, `product_id` UUID), etiquetas extraídas (`source: CAMPAIGN_NAME`, `id: campaign-name:<clave>`, `product_id: null`) y gasto sin clasificar. La extracción acepta `WA | etapa | producto | creativo` o sin etapa; sólo consolida el alias explícito Costura → Costura que Vende si no existe una extensión competidora. Otros prefijos no se fusionan. Un nombre contradictorio entre anuncios de una campaña queda sin extracción. Esto no crea catálogo ni touchpoints, y no transforma una venta desconocida en atribuida.

`options.products` conserva sólo catálogo; `options.extracted_products` contiene `{id, name, source}` y `options.ads` cuenta/anuncio/campaña. El filtro `extracted_product=<clave>` funciona en rendimiento, ventas y exportación, y es incompatible con `product_id`. La clasificación explícita manda: su gasto deja el grupo extraído al confirmar la relación versionada. La diferencia de control de gasto sigue sin etiqueta asignada. `quality.spend_control.unassigned_spend_minor` continúa midiendo gasto sin relación confirmada de catálogo, aunque exista una etiqueta visible.

Las filas de campaña/anuncio incluyen `extraction` y `product_resolution`. Una coincidencia de nombre normalizado exacta y única sólo devuelve `EXACT_NAME_CANDIDATE`/`candidate_product_id` para confirmación; duplicados devuelven `AMBIGUOUS`. `EXPLICIT_MAPPING` y `MIXED` describen los productos efectivamente presentes en el rango. El producto vendido sigue siendo el del pedido y el ingreso sigue requiriendo comprobante aprobado.

El informe devuelve `cache: {status: MISS|HIT|COALESCED, ttl_ms: 30000, expires_at}` y conserva `measured_at` del cálculo original. La clave incluye workspace, entorno, filtros y revisión de hechos/catálogo/metadata/cobertura/cuentas; cambios y vencimiento de frescura invalidan el corte. Exportaciones siempre recalculan. La UI no consulta Meta al abrir el informe: sólo sigue el job solicitado con `GET /meta/insights/status?job_id=<uuid>` mientras esté `PENDING`/`RUNNING` y refresca el corte una vez al terminar. `next_attempt_at` permite espaciar seguimiento durante un reintento.

Campañas abre `/campaigns`: Rendimiento, Ventas e Histórico reportado. Sistema → Integraciones contiene Meta; las asociaciones operativas históricas se conservan en configuración. Ventas y Campañas comparten el mismo detalle de pedido/comprobante.

El modelo `conversation_first_observed_v1` fija el primer touchpoint publicitario observado anterior al pedido. Exige identificador de tipo anuncio; un POST ID, un nombre parecido o el número receptor no acreditan origen. Metadata de Meta resuelve cuenta/anuncio/conjunto/campaña incluso sin gasto reciente. Una cuenta ambigua permanece sin resolver. La corrección manual exige ID conocido, evidencia y motivo, y queda distinguida de origen observado.

El producto vendido sale del pedido. La clasificación ligera y versionada de campaña/anuncio identifica el producto promocionado. El anuncio prevalece sobre la campaña; dentro de cada relación se usa vigencia y revisión. El comparativo por producto promocionado conserva las ventas cruzadas. El detalle muestra producto vendido y promocionado sin duplicar gasto. Gasto sin clasificación o diferencia de control se conserva separado.

Los reportes agregan en PostgreSQL y paginan el detalle (30 filas predeterminadas, máximo 100). Fechas inclusivas de validación, zona America/Mexico_City; la cohorte por inicio de conversación se mantiene en Resultados con su propia etiqueta. Monedas y cuentas con otra zona se separan. Impuestos se estiman con tasa explícita por cuenta; no se presupone 16%.

CPA usa gasto / ventas atribuidas; ROAS usa ingreso atribuido / gasto; balance usa ingreso del ámbito − gasto. La pantalla distingue ingreso total/atribuido, fuente, cobertura, última lectura, pruebas, falsos, duplicados y pendientes. Sin fuente comparable los ratios son nulos; cero ingreso con gasto confirmado produce ROAS cero. Impresiones, clics o conversaciones ausentes no se inventan. Las conversaciones de Meta conservan la definición `onsite_conversion.messaging_conversation_started_7d` y pueden incluir pruebas; no se descuentan arbitrariamente del dato oficial.

## Lectura oficial de Meta

`meta_insight_jobs` tiene lease, intentos acotados y recuperación. El proceso de producción ejecuta un ciclo independiente de Insights cada cinco segundos para recoger jobs pendientes; la frecuencia de consulta es la configurada en el job, inicialmente una hora con ventana reciente. Se habilita al solicitar una sincronización con `recurring:true`; `recurring:false` en la última solicitud detiene nuevas programaciones. Parámetros: `interval_minutes` 15–1440, `lookback_days` 1–31; rango manual máximo 32 días inclusivos (reportes hasta 366 días de diferencia).

Sólo GET oficial v26.0. Descubrimiento por `me/adaccounts`, sin depender de portfolios. Se consulta gasto diario por anuncio y campaña, resultados y metadata sin filtrar sólo anuncios activos. Cada cuenta reemplaza atómicamente su rango sólo al completar ambas lecturas. Cobertura incluye días vacíos verificados. Fallos preservan la lectura válida anterior con calidad parcial/vencida; no se suman snapshots. La diferencia campaña versus anuncios permanece visible y sin producto asignado.

El worker de automatización puede descifrar únicamente el token Meta requerido, mediante el registro cifrado de conexiones de su workspace. Channel/ingress no reciben ese permiso. HTTP no mantiene abierta una transacción. Paginación, timeout, cuota y reintentos usan el lector existente.

Lectura real acotada: [[meta-insights-live-verification]] registra dos credenciales y dos cuentas para **05-sep-2026**. Gasto devuelto cero: una cuenta sin filas y otra con una fila cero a nivel anuncio/campaña. Esto acredita acceso y coherencia de ese rango; el caso con gasto positivo se verificó con fixtures, no con una campaña real. No se consultaron clientes, enviaron conversiones ni modificaron anuncios.

## API y permisos

Todas las mutaciones usan Idempotency-Key; `environment` separa REAL/SIMULATION. Owner/operator/reconciler revisan y clasifican; analyst/viewer consultan agregados sin documento privado. Tokens de catálogo no obtienen permisos financieros ni Meta.

| Ruta | Contrato |
|---|---|
| POST `/receipts/:id/review` | `decision`, `reason`, `expected_version`; opcionales `amount_minor`, `currency`, `payment_key`, `replaces_receipt_id`. Devuelve comando durable; comprobar APPLIED/FAILED. |
| POST `/orders/:id/classification` | `classification: TEST|COMMERCIAL`, motivo y versión esperada. |
| POST `/receipts/:id/classification` | `classification: FALSE|GENUINE`, motivo y versión esperada. |
| POST `/orders/:id/attribution` | Cuenta/anuncio conocido, observed_at, evidencia/motivo y versión; touchpoint opcional del mismo pedido/conversación. |
| GET `/orders/:id/contributions`, `/sale-history` | Hechos, revisiones y auditoría del detalle autorizado. |
| GET `/receipts/:id/access` | URL de documento firmada por 60 s, ligada a usuario/workspace/entorno; el documento vuelve a exigir sesión y permiso, con no-store. |
| GET `/reports/campaign-performance`, `/campaign-sales` | `from`, `to`, `currency`, base de costo, cuenta, campaña, anuncio, producto promocionado/vendido; clasificación/offset/limit en detalle. |
| GET `/reports/campaign-export`, `/campaign-revision` | Corte JSON minimizado con definición, filtros y revisión. Comparar revisión antes de reutilizar un cierre; un cambio indica corte sustituido. |
| POST `/campaign-products` | Cuenta, tipo campaign/ad, ID, product_id (null permite quitar asignación), valid_from, expected_revision y motivo. |
| POST `/meta/insights/sync`, GET `/meta/insights/status` | Solicitud acotada, recurrencia opcional y salud durable. |
| POST `/meta/insights/tax` | Cuenta, tax_bps y motivo. Sólo estimación de costo; no modifica Meta. |

`/orders/:id/reconcile` se conserva deprecado para compatibilidad histórica; ningún consumidor interno lo invoca para registrar una venta. `RECONCILED` no se convierte artificialmente. Los nombres antiguos `counts.reconciled` del resumen son alias de compatibilidad de `counts.sales`; el embudo identifica `RECEIPT_SALE`. La preparación de conversiones usa comprobante validado, conserva blockers y no envía nada.

## Histórico y preparación de migración

La migración SQL 0019 agrega esquema/permisos/índices: no reconoce historia ni ejecuta workflows. Aplicada también en producción con runner y validación de hashes: 19 migraciones verificadas por el instalador. Para futuras instalaciones: backup B02, migración con runner existente, servicios congelados, revisión autenticada y control de jobs. Rollback a imagen anterior conserva tablas nuevas; nunca ejecutar DROP o restaurar encima de la única base válida. Un rollback de código no revierte decisiones comerciales ya registradas.

`POST /sales-backfill/preview {}` devuelve candidatos, elegibilidad, digest y límite de 200. `POST /sales-backfill/commit {digest,confirmation:"ANALYTICS_ONLY"}` revalida la vista y encola el lote analítico. Cada candidato conserva versión y fecha previa, registra excepciones y nunca envía mensajes/beneficios. Repetir no duplica contribuciones. Revisar excepciones antes de continuar lotes; no inventar importes ni fechas ausentes.

`scripts/prepare-receipt-versions.ts SIMULATION|REAL /ruta/privada/propuestas.json`, con WORKSPACE_ID y entorno de base cargado, genera propuestas de nuevas versiones publicadas de oferta/workflow que aún contienen reconcile. Sólo lee; no altera snapshots, asignaciones ni conversaciones. Su salida privada debe aplicarse posteriormente mediante las APIs versionadas. La publicación no necesita ejecutar importación histórica ni aplicar esas propuestas automáticamente.

ClickChat usa `/sales-imports/preview` con `source`, `date_format: DMY|MDY`, moneda opcional y filas (máximo 1000). Preview conserva fechas, tipos de ID, producto, errores y duplicados; el payload normalizado está cifrado. ID de origen estable o fingerprint privado identifican una fila sin depender de su posición. Colisiones o cambios de revisión requieren resolver el origen. Commit exige `IMPORT_REPORTED_HISTORY`, guarda filas reportadas separadas y no crea pedidos ni mensajes. `/sales-imports/reported/:id/link` une la fila a una venta interna ya verificada; no duplica el ingreso. Sin archivo no se llama comprobante verificado. No se importó historia productiva ni se modificó el cierre/Personal Tracker legado.

## Revisión local

Requisitos: Node 24.20, pnpm 10.34 y PostgreSQL local de `pnpm local:setup`. Preparar una base nueva con `node scripts/setup-campaign-review.mjs /ruta/privada/campaign-review`. El script rechaza sobrescribir configuración existente y sólo permite PostgreSQL localhost. `COMMERCE_CONFIG_DIR` selecciona esta base en los comandos de la aplicación.

En este Mac ya existe `~/.config/commerce-os-campaign-review/runtime.env`, privado y fuera del vault, con el acceso local, también separado en `review-login.txt` (0600). Ejecutar `COMMERCE_CONFIG_DIR="$HOME/.config/commerce-os-campaign-review" pnpm serve:build` desde el código y abrir `http://127.0.0.1:5173/campaigns`. Seleccionar Simulación, fecha 06-sep-2026 y Preescolar Listo · demo. El ejemplo contiene $100 de gasto, $97 + $107 válidos, $50 de prueba y un documento pendiente. Si se recrea en otra fecha, usar la fecha guardada en campaign-demo.json. El setup no usa clientes ni conectores reales.

La suite CI prepara esta base independiente antes de E2E. Comandos: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test`, `pnpm test:integration`, `COMMERCE_CONFIG_DIR=... pnpm test:e2e`, `pnpm test:recovery`, pruebas Python de CI y auditoría de dependencias. Evidencia final: [[evidence/campaign-receipt-verification]]. Paquete local sellado: [commerce-os.tar](../release/commerce-os.tar), [checksum](../release/commerce-os.tar.sha256), [[evidence/campaign-release-package]]. Tres imágenes Linux/amd64, 19 migraciones, fuentes del commit `525df41`; los cambios posteriores de documentación no alteran esas imágenes.

Pendientes externos: primera lectura productiva de Insights (botón Actualizar; GET oficial, con recurrencia configurada por la aplicación), nuevo piloto con referral/comprobante reales, prueba de gasto positivo real y disponibilidad de archivos históricos. Zoom nativo y lector de pantalla requieren revisión humana; axe y screenshots no acreditan esos ensayos.
