# Auditoría integral de Commerce OS — 2026-09-06

Estado: correcciones verificadas localmente y en CI de `main`; r4 instalado y comprobado en el VPS el 06-sep-2026. Meta productivo funciona con inventario parcial y QR llegó a SCAN_QR_CODE; faltan escaneo humano e identidad vinculada. Este informe distingue código, pruebas locales, consultas oficiales reales y operación productiva. No se enviaron mensajes reales ni se alteraron campañas o anuncios externos, conversiones, presupuestos o gasto.

## 1. Diagnóstico inicial y causas demostradas

Se leyeron AGENTS, índice del proyecto, visión, arquitectura, brief WhatsApp y documentación de contratos, seguridad, API, proveedores y operación. El repositorio estaba limpio antes de editar. Se conserva React/Vite, Fastify, PostgreSQL 17/pg-boss, API v1 y los servicios independientes; no se importó código legado de Vibe Conversa o del dashboard Meta.

| Problema reproducido | Evidencia y causa | Corrección |
|---|---|---|
| Lateral fuera de pantalla | En Chromium 1280×720, Ventas extendía el lateral a 1050 px; Cerrar sesión quedaba entre y995 y y1024. `position:fixed` con hijos flex de mínimo intrínseco y sin región de overflow acotada. | Lateral limitado a `100dvh`, cabecera/usuario estables, nav con `min-height:0` y su propio desplazamiento. |
| `NOT_FOUND` al pedir QR REAL | Crear cuenta enviaba REAL; QR/connect omitían el entorno. `scopedRecord` aplicaba SIMULATION y devolvía 404 antes del worker. Reproducido localmente y por HTTPS productivo. | Todas las acciones conservan el entorno; también los enlaces de descarga de evidencia privada. Se mantiene el aislamiento del servidor. |
| Preparación QR bloqueada después de corregir entorno | La petición productiva con REAL devolvió 403 `QR_UNAVAILABLE`; el worker tenía la preparación deshabilitada y el error ocultaba el motivo. | Permiso separado `ALLOW_CHANNEL_ONBOARDING`, errores correlacionados y seguros; flags de envío siguen congelados. |
| API de automatización incompleta | Con auth y PostgreSQL reales, versiones/transiciones devolvían 404; la publicación interna por servicio devolvía 403 aunque se concedieran todos los scopes disponibles. | Endpoints de versiones, linajes, validación, transiciones y scopes explícitos de publicación interna. |
| Formularios y estados ambiguos | Campos opcionales y técnicos ocupaban el recorrido principal; faltaban errores enlazados, se perdían valores y una respuesta inválida podía convertirse en objeto vacío. | Campos condicionales/avanzados, validación accesible, conservación de borrador, errores seguros y reintento idempotente. |
| Contexto Meta inexistente en Commerce | No había inventario oficial ni selector de portafolio dentro de Commerce. | Inventario oficial previo a la UI; módulo separado en Campañas, contexto y asociaciones con historial. |
| Revisión de comprobante aceptada que terminaba en VERSION_CONFLICT | La API aceptó una revisión v1; el análisis automático subió a v2 antes de aplicar el comando. La E2E de pago y la reproducción aislada demostraron el orden. | API, análisis, aplicación y recuperación comparten el lock de conversación. Se reserva la revisión aceptada, se descarta análisis tardío y se conserva el 409 si la evidencia cambió antes de aceptar. |

El diagnóstico se registró antes de implementar en [decisiones de auditoría](audit-architecture.md), [ADR API](adr-api-first-2026-09-06.md) y ADR-006/007 del vault. La evidencia productiva no incluye el log histórico original del intento del usuario; reproduce la misma condición con solicitudes controladas.

## 2. Navegación, responsive y simplificación

- Identidad Commerce OS, módulo, ruta, entorno, rol y logout siguen disponibles. Contraer conserva nombres accesibles y títulos; el activo tiene texto y marca visual. Al cambiar ruta, tamaño o abrir el menú se revela el enlace activo sin mover la página principal.
- Móvil usa un diálogo Radix con foco contenido, Escape y retorno al botón Abrir menú. El contenido conserva su ancho; las tablas tienen región desplazable accesible.
- Inicio prioriza conversaciones recientes, pendientes y métricas consultables. Las capacidades futuras viven en una ficha desplegable marcada Planificado. Se eliminaron el banner dominante y la cuadrícula de módulos futuros.
- Catálogo elimina portadas decorativas. Números usa filas compactas en lugar de grandes tarjetas. Filtros secundarios del inbox aparecen bajo Más filtros. Los errores, evidencia y acciones operativas permanecen disponibles.
- Las métricas se adaptan al ancho disponible; la revisión visual detectó y corrigió un icono recortado en tablet. Los datos ausentes muestran Sin datos y los no verificables No disponible; el entorno REAL/SIMULATION es visible y se aísla en consultas y mutaciones.
- Inicio y navegación consultan únicamente las capacidades del rol. La prueba visual de seis roles usa fixtures de sesión; la seguridad efectiva se prueba además en el servidor.

## 3. Formularios y accesibilidad

El componente compartido ahora presenta labels visibles, campos obligatorios/opcionales, instrucciones breves, tipos apropiados, errores por campo y resumen enlazado. Los valores se conservan al cerrar o fallar mientras se permanece en el recorrido; no se promete persistencia tras recargar o abandonar la página. Guardar se bloquea mientras hay una petición. Un fallo de red conserva la clave idempotente del mismo payload; no hay reintento automático de escrituras.

| Recorrido | Cambio concreto |
|---|---|
| Producto | Nombre obligatorio; descripción inmediata e identificador opcional bajo opciones. El detalle por ID funciona fuera de la primera página de resultados. |
| Oferta | Precio, moneda y nombre primero; relaciones de cobro, política y entrega bajo opciones. Las reglas de publicación siguen en la API. |
| Flujos y agentes | Configuración opcional agrupada; grafo, validación y publicación siguen disponibles por UI/API. |
| Cuenta WhatsApp | Proveedor según entorno; engine GOWS sólo para WAHA; estados de preparación y QR accionables. |
| Materiales | Se muestran los campos del tipo seleccionado; no se pide simultáneamente archivo y acceso. |
| Inbox | Búsqueda y número visibles; filtros secundarios desplegables y label explícito en composición. |
| Meta | Selector de portafolio y filtros; vínculo interno compacto reutiliza producto y jerarquía conocida. |
| Credenciales de servicio | Se elimina la generación/revelación del token en el DOM. La consola consulta vigencia/scopes y revoca con confirmación; el cliente seguro de API crea la credencial. |

Se corrigieron contraste de estados, selector de entorno, links, avatares y textos; encabezados de estados vacíos, nombres accesibles, tablas con `scope`, regiones y foco visible. Diálogos recuperan el foco al cerrar. La prueba de teclado cubre Tab, Shift/retorno a disparadores, Enter, Escape, enlaces inferiores y el drawer. El reporte final de axe enumera las rutas y estados comprobados; cero violaciones en esa muestra no equivale a certificación WCAG.

Capturas antes/después en ocho tamaños y variante compacta: [galería](evidence/ui-audit/README.md). [Inspección visual del agente](evidence/ui-audit/manual-review.md). La prueba 640×360 comprueba el viewport CSS equivalente a 1280×720 al 200%, y existe una prueba separada de aumento de texto. **Zoom nativo del navegador y lector de pantalla siguen pendientes de verificación manual.** El Mac estaba bloqueado durante el ensayo inicial; el acceso posterior resuelto no acredita esas pruebas. No se presentan esas equivalencias como un ensayo nativo aprobado.

## 4. QR: estado del recorrido

El ensayo con imagen real GOWS 2026.8.2 fijada por digest recorrió API → HTTP interno channel-worker → adaptador → gateway y llegó a **SCAN_QR_CODE**, devolviendo PNG efímero. Pasaron 7 comprobaciones con PostgreSQL aislado. No se escaneó: no existe todavía identidad real vinculada como resultado de esta auditoría. El contenedor y sus sesiones tmpfs se destruyeron; no hay un QR guardado esperando al usuario.

Se verificaron mediante fixtures creación antes de start, sesión ausente/pendiente/conectada, expiración, autenticación, timeout, PNG inválido, reintento, conflicto de gateway, cambio de identidad y aislamiento entre cuentas. Un fallo congela su cuenta; no afecta otra. WORKING sin identidad observada no acredita conexión; se conserva únicamente huella de identidad. El QR viaja autenticado con no-store y nunca se guarda en eventos, logs o capturas. La cuenta permanece sujeta a controles deterministas.

Los errores incluyen operación, explicación, acción, posibilidad de reintento, intervención técnica, referencia, hora y estado conocido. Los registros preservan etapa y HTTP original sanitizados; no conservan bodies libres del proveedor. [Causa y runbook detallado](qr-audit.md), [ensayo real](evidence/qr-real-gateway.json), [reproducción HTTPS](evidence/qr-production-readonly.json).

El ensayo productivo terminó el 06-sep a las **12:20:41 UTC**: un connect APPLIED, estado SCAN_QR_CODE y GET QR HTTP 200 con firma PNG, TTL y no-store válidos. El QR se comprobó sólo en memoria, sin persistirlo ni emitirlo. Los comandos REAL pasaron de 0 a 1 y el outbox permaneció en 0; el envío sigue deshabilitado. [Evidencia productiva](evidence/qr-production-onboarding-r4.json).

Para completar el pairing: mantener `DISPATCH_FROZEN=true`, `REAL_SENDS_ENABLED=false`, `ALLOW_REAL_OPERATIONS=false`; onboarding ya está habilitado únicamente en channel-worker. Abrir [Ventas → Números](https://commerce-os.inovaris.online/sales/channels/whatsapp), elegir Real y la cuenta WAHA existente, y solicitar un QR fresco. Brandon debe escanear desde WhatsApp → Dispositivos vinculados → Vincular dispositivo. Después se verifica identidad estable, salud y recepción/recuperación autorizada, conservando congelada la salida. QR es experimental, sustituible y separado de Meta; no configura una WABA ni atribución publicitaria.

## 5. Meta: inventario oficial y límites

Graph/Marketing API **v26.0**, fijada y contrastada con el SDK oficial y la respuesta HTTP. `/me/businesses` estuvo vacío con los usuarios de sistema; `/me/adaccounts.business` permitió descubrir ambos portafolios sin copiar IDs del legado. No se ejecutan métodos de escritura externos. Los IDs de esta tabla son evidencia, no constantes de implementación.

| Portafolio | ID opaco | Ads / páginas / apps | Campañas / conjuntos / anuncios | WhatsApp | Datasets |
|---|---|---|---|---|---|
| Inovaris | `2195776957851137` | 1 / 1 / 2 | 26 / 32 / 86 | No disponible: falta `whatsapp_business_management` | No disponible: 400, código1, subcódigo1349004 |
| Inovaris México | `1072067198677388` | 1 / 1 / 2 | 25 / 25 / 74 | 2 WABA / 2 números; uno BANNED y otro PENDING | Mismo error; causa no demostrada |

Se consultaron 5 y 2 píxeles respectivamente; **no se confunden con datasets**. Las dos cuentas Ads tienen el mismo nombre y diferentes IDs, preservados por portafolio. Ambos tokens eran válidos durante el inventario, SYSTEM_USER, sin fecha programada (`expires_at=0`), lo que no garantiza validez permanente. Los scopes completos, IDs de activos, edges rechazados y qué sigue disponible constan en el [inventario sanitizado](meta-inventory.md) y [evidencia oficial](evidence/meta-readonly-inventory.json).

La UI permite cambiar portafolio, buscar/filtrar, consultar origen, última sincronización y vigencia, ver permisos/errores parciales y activos relacionados. No conserva activos del portafolio anterior mientras carga. La sincronización real de la aplicación local guardó un snapshot y el smoke UI/API pasó 22 comprobaciones, incluidas las cuentas homónimas y axe sin violaciones en ambos portafolios. [Evidencia](evidence/meta-local-verification.json). Un inventario accesible parcial no prueba que no existan otros activos.

Los vínculos internos conservan portafolio y cuenta Ads, campaña/conjunto/anuncio, captación y cierre separados, producto y versiones de oferta/flujo, vigencia, actor, evidencia e historial inmutable. Se rechazan conflicto temporal, referencias ajenas y ambigüedad. Un vínculo manual no demuestra atribución; se etiqueta como no probada. Las relaciones no cambian destinos ni activos de Meta.

El cliente maneja paginación acotada, rate limits y reintentos GET seguros, permisos, expiración, timeout, recursos inaccesibles y snapshots parciales. La configuración restringe las credenciales al workspace autorizado. La lectura local reutiliza el archivo privado preexistente del legado, ubicado dentro del vault, sin copiar sus valores al repositorio de Commerce. Brandon autorizó la nueva custodia productiva el 06-sep y se preparó el archivo privado local fuera del vault. La configuración privada está instalada en el VPS. La verificación productiva pasó 63 comprobaciones API/UI sobre el primer snapshot, con axe sin violaciones en ambos portafolios, y 10 comprobaciones API en una segunda sincronización explícita. El primer snapshot conservó un HTTP 500 de anuncios Inovaris; el segundo recuperó los 86 anuncios. Persisten cuatro edges inaccesibles: dos WABA de Inovaris por `whatsapp_business_management` faltante y dos datasets rechazados pese a contar con `business_management`. Las tres capturas pertenecen al primer snapshot; no se repitió navegador tras el segundo. Son dos ensayos, no una suite de 73 casos. [Evidencia productiva](evidence/meta-production-r4.json). La limpieza eliminó las copias temporales de transferencia local, Cloud Shell y VM; preservó las dos credenciales en api.env 0600 y confirmó workers sin credenciales Meta. Se conservaron la custodia local autorizada y los backups privados. [Evidencia de custodia](evidence/deployment-r4-credential-cleanup.json). [Contrato y operación](meta.md).

## 6. Catálogo completamente operable por API

Todas las rutas llevan `/v1`. Workspace se deriva de la identidad autenticada, con aislamiento por entorno y autorización del servidor. La UI usa los mismos contratos. Hay scopes distintos para leer, crear borradores y publicar internamente; credenciales de catálogo no pueden operar números, enviar, leer secretos bancarios, conciliar, autorizar REAL o administrar Meta.

| Recurso | Operaciones |
|---|---|
| Productos | `GET/POST /products`, `GET/PATCH /products/:id`, `POST /products/:id/duplicate`, `GET/POST /products/:id/versions`, `POST /products/:id/transition`; assets/referencias y búsqueda/filtros. |
| Ofertas | `GET /offers`, `POST /products/:id/offers`, consulta por ID, `GET/POST /offers/:id/versions`, `POST /offers/:id/publish`; precio/moneda/entrega y preservación de pedidos fijados. |
| Flujos | `GET/POST /workflows`, consulta/edición por ID, validación de definición y `/workflows/:id/validate`, `GET/POST /workflows/:id/versions`, `duplicate`, `publish`, `rollback`; nodos, agentes y relaciones compartidas. |
| Credenciales | Creación por sesión owner, scopes mínimos, expiración configurable, hash protegido, consulta sanitizada y revocación inmediata. |

Publicar internamente no crea outbox ni efectos comerciales. Ofertas y flujos publicados son inmutables; rollback crea otra versión del mismo linaje. Idempotencia y locks evitan duplicados/concurrencia; versiones obsoletas y referencias cruzadas se rechazan. La corrección también preserva fulfillment y condiciones omitidas al revisar, y admite linajes heredados sin aceptar otro flujo.

OpenAPI `GET /v1/openapi.json` y [guía curl funcional](api-automation.md) incluyen payloads, respuestas, HTTP, permisos, validación, versiones, idempotencia y revocación sin credenciales reales. La E2E obtiene un servicio limitado, crea producto/oferta/flujo, valida y publica, verifica visibilidad en UI, repite claves, confirma 403/401 y compara efectos antes/después. Las pruebas de integración añaden caducidad, publicación restringida, linaje, concurrencia e inmovilidad de pedidos/ejecuciones previas.

## 7. Archivos, decisiones y migraciones

- Web: `main.tsx`, `styles.css`, `lib/api.ts`, `lib/workspace.ts`, componentes compartidos/dialog y páginas home/catalog/sales/flows/operations; `pages/meta.tsx` y CSS nuevos con carga diferida.
- API: `catalog-versions.ts`, `openapi-catalog.ts`, catalog/context/system/contracts; `qr.ts`, channel-worker y messaging/onboarding; `meta-client.ts`, `meta.ts`.
- Automatización: agents/commands/runtime/shared y ruta API review coordinan análisis de comprobante y decisión humana; 7 pruebas controlan órdenes concurrentes, duplicados y recovery. [Reproducción y verificación](evidence/receipt-review-concurrency.json). Los recibos legados ya revisados se excluyen antes del límite de lote para no impedir el análisis de documentos nuevos. Sin migración adicional.
- Pruebas/scripts: `tests/e2e/audit.spec.ts`, integración API-first/QR/Meta, unitarias y release-overlay, auditorías de UI/axe/QR/Meta, saneamiento de artefactos.
- Despliegue: helper común Compose, instalador/release y `production.yaml`; preservan overlay/red/volúmenes del piloto y fuerzan congelamiento. [Plan r4](deployment-audit-r4.md).
- **0015** añade integridad de referencias del catálogo; **0016** añade snapshots y asociaciones Meta con historial. Aplicadas en base local, bases aisladas y VPS. El inventario independiente productivo confirma 16 migraciones. Son aditivas, sin borrar datos anteriores. QR no requiere migración propia.
- Decisiones: [auditoría UI](audit-architecture.md), [API-first](adr-api-first-2026-09-06.md), [[🏗️ ADR-006 — Alta QR y diagnósticos seguros — 2026-09-06]], [[🏗️ ADR-007 — Meta de solo lectura y vínculos históricos — 2026-09-06]].

## 8. Verificación y seguridad de la evidencia

El resumen final de ejecuciones se registra en [audit-verification.json](evidence/audit-verification.json). Incluye fechas, cantidades, omisiones y repeticiones fallidas; debe leerse junto con la evidencia específica. No se suman ensayos parciales como si fueran casos independientes de la suite completa.

La ejecución final pasó lint, typecheck y build; **44 pruebas unitarias, 78 de integración y las 13 E2E completas**. Una integración optativa de gateway real quedó omitida en la suite general y se ejecutó por separado: **7/7 con GOWS real**. Axe registró **cero violaciones en 18 estados**; Meta tuvo 22 comprobaciones de aplicación con inventario oficial. Las E2E incluyen el ciclo API-first, revisión de comprobante, conciliación y descarga de evidencia: HTTP 200 en su entorno y 404 desde el otro. La latencia local tuvo p95 **1.377 ms** y máximo **1.379 ms** en 30 muestras; excluye WAN y gateway real, sin acreditar un SLO productivo. La suite completa duró 6,1 minutos, incluidas esperas previas para respetar la cuota HTTP.

El commit previo al despliegue, `40f9cf04f8a89adcfdbd18224865a987f040b970`, pasó además [CI en Ubuntu 24.04](https://github.com/MarioB19/commerce-os/actions/runs/34030150949): 44 unitarias, 78 integraciones y 1 QR optativa omitida, 13 E2E en 6,2 minutos, recuperación y auditoría sin vulnerabilidades conocidas. La ejecución anterior `e370479` también pasó. Son repeticiones del mismo conjunto; no incrementan la cantidad de casos.

Se detectó una exposición de **contraseña bootstrap local** en un reporte de Playwright: snapshot DOM y títulos `.fill(...)` dentro del ZIP base64 de HTML. La contraseña se rotó y las sesiones locales se revocaron; se sanearon los artefactos, incluidos miembros embebidos. Login limpia el input antes de HTTP; las E2E obtienen sesión por API para no serializar la contraseña como nombre de paso. `test:e2e` sanea reportes al finalizar incluso si falla. La evidencia conserva sólo conteos. No se declara que los secretos nunca estuvieron en un artefacto; el hallazgo y su remediación son parte de la auditoría. Las credenciales productivas y Meta no se rotaron ni se expusieron por este hallazgo.

El saneamiento de la suite final encontró cero ocurrencias sensibles; eliminó preventivamente 21 títulos de valores introducidos, incluidos datos sintéticos. La revisión busca coincidencias de credenciales disponibles en texto y ZIP y patrones QR/teléfonos; sus límites están documentados en [audit-secret-review.json](evidence/audit-secret-review.json). No garantiza ausencia de secretos desconocidos. Las imágenes QR no se conservaron; las capturas de UI usan datos sintéticos o inventario Meta sanitizado.

Los primeros E2E intensivos alcanzaron el límite de 300 peticiones/minuto y expusieron contraste de avatares con datos ya existentes. Se conservan como fallos previos a la corrección. La suite ahora espera el reset **antes** de cada escenario según las cabeceras del servidor, manteniendo el límite productivo y sin reintentar mutaciones para ocultar fallos. Un 429 dentro del recorrido sigue haciendo fallar el caso; la UI informa el tiempo de espera en español.

## 9. Producción, intervención y pendientes

La autorización del núcleo/VPS/HTTPS y la confirmación específica de Cloud Shell están resueltas. El acceso Google Cloud → Cloud Shell → IAP SSH permitió instalar r4: PASS del instalador a las **12:08:37 UTC del 06-sep-2026**, con `current` en `/opt/commerce-os/releases/20260906-audit-r4`. El Mac bloqueado y el rechazo automático inicial del botón Authorize se conservan como antecedentes resueltos. No fue necesario crear acceso GCP local. La comprobación independiente de las 12:14 UTC confirma seis servicios del núcleo sanos, 16 migraciones y congelamiento obligatorio, con onboarding habilitado sólo en channel-worker. Pasaron 13 checks de inventario, 9 de comparación del release y 23 de HTTPS. Los manifest IDs coinciden con el paquete; PostgreSQL, WAHA, POC y Caddy conservaron sus tiempos de arranque. [Inventario](evidence/deployment-r4-vps.json) · [Checks](evidence/deployment-r4-vps-checks.json) · [Comparación](evidence/deployment-r4-release-comparison.json) · [HTTPS](evidence/deployment-r4-https.json). El inventario es anterior al ensayo QR de las 12:20 UTC, que tiene evidencia propia.

El paquete r4 instalado contiene 197.632.000 bytes, tres imágenes Linux/amd64, 146 hashes runtime, cinco artefactos web y 56 entradas del manifiesto verificados. SHA256 exterior comprobado de nuevo por el coordinador; [ruta y checksum](evidence/release-package-r4.json). Conserva el piloto existente, verifica checksums y toma un B02 nuevo antes de migrar. El B02 nuevo `commerce-2026-09-06T12-07-21.100Z.backup.aes`, 358.436 bytes, está fechado a las 12:07:22 UTC antes de la migración. Se verificaron metadatos y secuencia del instalador; este B02 no se restauró en este despliegue. La restauración/offsite histórica es evidencia separada. El instalador no ejecuta `compose down` ni recrea el gateway. [Acceso y limitaciones](deployment-access-audit.md).

| Prioridad | Pendiente | Intervención exacta |
|---|---|---|
| Bloqueante para vincular WhatsApp | Escaneo humano de QR fresco. | El recorrido productivo ya llegó a SCAN_QR_CODE. Solicitar QR en Ventas → Números → Real → cuenta existente y escanear desde Dispositivos vinculados; después verificar identidad real. Nunca pegar OTP o sesión en la consola. |
| Bloqueante para afirmar operación oficial WhatsApp | Estados BANNED/PENDING y permisos por activo. | Revisar en WhatsApp Manager/soporte oficial, asignaciones y elegibilidad; conceder el scope faltante sólo si se requiere ese inventario. No afecta la lectura Ads ya disponible. |
| Pendiente de exactitud del inventario | `ads_dataset` rechazado en ambos portafolios. | Revisar asignación/contrato con Meta usando el diagnóstico sanitizado; no se conoce un scope adicional demostrado. |
| Verificación humana pendiente | Zoom nativo 200%, lector de pantalla y prueba con equipo. | Ejecutar con Mac accesible. Los ensayos automáticos y la inspección visual no sustituyen esas comprobaciones. |
| Opcional | Inventarios muy grandes y métricas adicionales. | Job durable de sincronización, configuración multi-workspace protegida, insights con ventana/definición acordadas. |
| Opcional/prepiloto | Operación sostenida. | Verificar copia externa/restore del B02 r4; calibrar capacidad con sesiones reales, SLO, alertas y backup externo continuo. No se inventa capacidad por el ensayo local. |
| Opcional/prepiloto multioperador | Cuota API compartida por IP. | El límite actual de 300 solicitudes/minuto puede compartirse detrás de una misma salida de red. Dimensionar o particionar por identidad con protección de acceso según concurrencia real; la suite respeta la cuota vigente y no demuestra capacidad de muchos operadores simultáneos. |

Las suites local y CI están aprobadas; núcleo, HTTPS, Meta de lectura y preparación QR están verificados en producción. Permanecen pendientes el escaneo humano, la identidad/operación WhatsApp, los accesos parciales de Meta y las comprobaciones manuales indicadas. Todo despacho real y acción publicitaria siguen sujetos a autorización específica.
