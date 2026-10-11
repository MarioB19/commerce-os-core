# Periodos, cobertura y gasto estimado

Decisión del 08-sep-2026, antes de implementar la corrección de Campañas solicitada por Brandon. Base publicada `376f675`, documentación `946f74e`.

La reproducción autenticada devolvió HTTP 200 en los cuatro casos: siete días sin impuestos con cobertura completa; treinta días con cobertura parcial; ambas ventanas con impuestos sin tasa configurada. El reporte aplicaba la disponibilidad global a todos los días y ocultaba incluso datos observados. Cambiar filtros consultaba PostgreSQL pero no solicitaba a Meta los días faltantes.

La UI solicitará una sola sincronización no recurrente por ventana/cuenta cuando falte cobertura, dentro del límite existente de 32 días. Seguirá únicamente su job, conservará el corte con sus fechas y base originales durante la carga y volverá a consultar al terminar. Cambios de producto, base fiscal o gráfica no crean consultas externas redundantes. Errores y límites detienen el intento automático; el usuario conserva un reintento explícito. Periodos mayores mantienen la consulta histórica sin ocultar el límite de descarga.

El API conserva el gasto neto observado y los puntos cuya cobertura sí esté completa. Un total incompleto y sus ratios siguen sin presentarse como definitivos. Cobertura de fuente y posibilidad de calcular impuestos se exponen por separado.

La referencia `Projects/Vibe Marketing/dashboard-wa/lib/meta-accounts.ts` usaba una tasa predeterminada de 0.16 y `lib/dashboard-data.ts` multiplicaba gasto por `(1 + tasa)`. Se recupera esa comparación como **estimación de consulta**, visible y editable, inicialmente 16 % para MXN. No afirma el impuesto efectivamente cobrado ni modifica la configuración de las cuentas. Una tasa guardada por cuenta tiene prioridad. El parámetro opcional `fallback_tax_bps` sólo suple tasas ausentes; el API no asume ninguna tasa cuando no se recibe. Para otras monedas se requiere elegirla.

El gasto se obtiene mediante lecturas oficiales de Meta. Ingresos y ventas siguen dependiendo de comprobantes aprobados, con exclusión auditada de Prueba/Falso. No se cambia gasto publicitario, catálogo, permisos de envío ni conexión de WhatsApp.

Verificación requerida: siete y treinta días, vuelta entre bases, tasa guardada y estimada, varios perfiles, huecos diarios/semanales, respuestas demoradas, error sin bucle y conservación de contexto. CI/CD del commit y recorrido HTTPS posteriores a la publicación.

## Contrato de lectura

Los tres GET `/v1/reports/campaign-performance`, `/campaign-sales` y `/campaign-export` aceptan `fallback_tax_bps` opcional, entero de 0 a 10000. No hay valor predeterminado en el servidor. Sólo interviene con `cost_basis=estimated_tax`; una tasa guardada de la cuenta, incluido cero, tiene prioridad. El parámetro forma parte de la clave privada de caché y no crea configuración, jobs ni efectos externos.

El reporte y el export exponen:

| Campo | Significado |
| --- | --- |
| `summary/groups/series.net_spend_observed_minor` | Subtotal neto conocido dentro del filtro. Es `null` sin observación comparable y cero únicamente cuando existe cobertura verificada. En grupos de campaña/anuncio con cuenta, exige observación de esa cuenta. No sustituye el gasto total del período. |
| `quality.spend_control.unassigned_spend_minor/net_unassigned_spend_observed_minor` | El primero requiere costo completo comparable; el segundo conserva el neto sin vínculo al catálogo observado. Una tasa ausente o cobertura incompleta no transforma el primero en cero. |
| `quality.coverage_days_count` | Número de días cubiertos por todas las cuentas comparables seleccionadas. |
| `quality.observed_days_count` | Número de días con observación de al menos una cuenta comparable. |
| `quality.missing_days` | Fechas `YYYY-MM-DD` sin cobertura completa de las cuentas seleccionadas. |
| `quality.blockers` | `NO_COMPARABLE_ACCOUNTS`, `INCOMPLETE_COVERAGE`, `TAX_RATE_MISSING`, `INCOMPATIBLE_TIMEZONE` o `SOLD_PRODUCT_COST_UNAVAILABLE`, según corresponda. |
| `quality.tax_status` | `NOT_REQUESTED`, `CONFIGURED`, `ESTIMATED` o `MISSING`. `CONFIGURED` tampoco acredita el impuesto cobrado: sólo indica que las cuentas tienen una tasa guardada. |
| `quality.tax_estimate` | `{fallback_bps: number \| null, applied_accounts: string[]}`. Las cuentas son IDs `act_…`; la lista identifica dónde se aplicó la estimación de consulta. |
| `series[].complete/coverage_days_count/days` | Cobertura del bucket diario, semanal o mensual, recortado al período solicitado. Sus ratios sólo se calculan si todos sus días están cubiertos y no hay otro bloqueo de costo. |

`quality.status` describe la fuente Meta. Puede ser `SYNCED` y coexistir con `tax_status=MISSING`: los datos llegaron, pero falta la tasa para la comparación solicitada. `quality.available` y `summary.spend_minor` conservan la exigencia de cobertura completa y costo comparable. Ingresos y ventas mantienen la definición `receipt_sales_v1`, independientemente de la disponibilidad de gasto. El export conserva las mismas reglas y el detalle de ventas mantiene paginación.

La regresión local usa snapshots sintéticos, comprobantes aprobados y PostgreSQL aislado: compara siete y treinta días; conserva un día conocido de 47958 unidades menores sin convertir huecos en cero; cubre semanas incompletas, varias cuentas y una venta de una cuenta sin cobertura; valida tasas ausentes, cero, 500 y fallback 1600; comprueba export, paginación, aislamiento REAL/SIMULATION y ausencia de lecturas externas desde el reporte. Esta evidencia local no sustituye CI ni la verificación HTTPS posterior.

Las consultas puntuales de la pantalla envían `recurring:false, preserve_schedule:true` a POST `/v1/meta/insights/sync`. `preserve_schedule` es opcional y vale false por omisión; true con recurring true es inválido. El scheduler excluye las consultas preservadas al buscar la última configuración: mantiene la cuenta, intervalo y lookback previos, sin crear programación donde no existía. Espera cualquier job pendiente/en ejecución y la restricción única evita duplicados. Un cliente anterior que envíe `recurring:false` sin preservar sigue cancelando la programación como antes. La regresión comprueba ambos comportamientos y conserva la reutilización de solicitudes activas previas al campo nuevo.

## Publicación comprobada

`fdca43c` instalado por [CI/CD 34233366458](https://github.com/MarioB19/commerce-os/actions/runs/34233366458) el 08-sep-2026 a las 08:01:39 México. [Evidencia](evidence/campaign-filter-production.json): seis selecciones HTTPS con cobertura completa y UI/API coincidentes, un job para completar treinta días, cero jobs por impuestos, cero lecturas adicionales del reporte en 45 segundos de reposo. Las estimaciones se redondean a unidades menores por registro de gasto y después se suman, por lo que pueden diferir unos centavos de multiplicar el total neto una sola vez. No modifican las tasas guardadas ni acreditan el impuesto cobrado.
