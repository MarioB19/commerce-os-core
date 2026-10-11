# Inventario Meta real de solo lectura — 2026-09-06

Inventario inicial local de lectura oficial; la verificación productiva posterior figura al final de esta nota. Origen: Graph API v26.0, credenciales privadas existentes. Hora UTC de inicio: **2026-09-06T03:59:02.425Z**. Evidencia [JSON sanitizado](evidence/meta-readonly-inventory.json). 36 resultados de consulta por edge, más diagnóstico GET de cada token; ninguna mutación Meta. Una comprobación adicional confirmó el mensaje de error de datasets sin almacenar payload sensible.

| Portafolio | ID opaco | Cuentas Ads | Páginas | Apps | WABA | Números | Píxeles | Campañas | Conjuntos | Anuncios |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Inovaris | `2195776957851137` | 1 | 1 | 2 | No disponible | No disponible | 5 | 26 | 32 | 86 |
| Inovaris México | `1072067198677388` | 1 | 1 | 2 | 2 | 2 | 2 | 25 | 25 | 74 |

Las dos cuentas publicitarias tienen el mismo nombre **Inovaris Ads MX**: `act_1481348446832254` pertenece a Inovaris; `act_1626906345611961` pertenece a Inovaris México. Se mantiene siempre ID/portafolio en la UI para evitar confundir nombres idénticos. `/me/businesses` respondió vacío con ambas credenciales SYSTEM_USER; los dos portafolios se descubrieron desde `/me/adaccounts` y su campo `business{id,name}`. No se emplearon los IDs configurados en el legado.

## Activos y operación que requieren atención

- **Inovaris México:** WABA `1639609357792313`, nombre Inovaris México, número `1272049759321402`, terminación **3117**, estado devuelto **BANNED**. Revisión en WhatsApp Manager y recurso/revisión oficial de Meta; no se intenta sustituir, evadir ni activar la cuenta.
- **Inovaris México:** WABA `1031833176287218`, llamada **Test WhatsApp Business Account**, número `1237654099436595`, terminación **0684**, estado **PENDING**. Es una cuenta denominada de prueba por Meta y no acredita operación lista. Los dos números se consultaron desde sus respectivas WABA; no se dedujo esa asociación desde QR.
- **Inovaris:** GET `/{portfolio}/owned_whatsapp_business_accounts` y `/client_whatsapp_business_accounts` devolvieron **403, código 200**. Su credencial carece de `whatsapp_business_management`; si se requiere este inventario, conceder ese permiso y verificar las asignaciones del usuario de sistema desde el gestor seguro antes de reintentar. La consulta rechazada no demuestra por sí sola que falte una asignación concreta. Cuentas Ads, página, apps, campañas, conjuntos, anuncios y píxeles permanecen consultables. No reportar “0 WABA”: su existencia no se pudo verificar.
- **Datasets:** GET `/{portfolio}/ads_dataset?fields=id,name` devolvió en **ambos portafolios 400, código 1, subcódigo 1349004**, mensaje sanitizado **“An unknown error occurred”**. `business_management` sí está concedido; no existe evidencia para declarar un scope faltante concreto. Requiere revisar elegibilidad/asignación y contrato del edge con Meta usando los trace IDs conservados en el JSON. La consulta de píxeles funciona (5 y 2), pero no se presentan como inventario de datasets ni se afirma su elegibilidad CAPI.

Páginas verificadas: Inovaris `114082580153388`; Inovaris México `1355577314301349`. Apps y píxeles con nombres/IDs aparecen en JSON. Se conservan campañas→conjuntos→anuncios por sus IDs de respuesta, y página/píxel de promoción cuando Meta los devuelve. Un vínculo a producto/oferta/flujo Commerce sigue requiriendo una decisión interna evidenciada, no se infiere de nombres de campaña.

## Credenciales y scopes

Ambas fueron **is_valid=true**, **SYSTEM_USER**, `expires_at=0` y `data_access_expires_at=0`. Se muestra “sin fecha programada”, no “nunca expira”: revocación, cambios de permisos y restricciones siguen siendo posibles. No se almacenaron tokens, app secrets ni identificadores personales del usuario de sistema.

- **anterior**: `ads_management`, `ads_read`, `business_management`, `public_profile`.
- **inovaris_mx**: `pages_show_list`, `ads_management`, `ads_read`, `business_management`, `whatsapp_business_management`, `pages_read_engagement`, `pages_manage_ads`, `whatsapp_business_messaging`, `public_profile`.

Que el primer token no tenga pages_show_list no impidió owned_pages en la consulta real; los scopes nominales y el resultado por activo se muestran separados. Que el segundo tenga whatsapp_business_messaging no habilita envíos en Commerce OS. No se modificaron scopes, usuarios ni asignaciones en Meta.

## Verificación y pendientes

- **Servicios reales:** inventario oficial GET parcial, con dos portafolios y errores precisos arriba. Los conteos describen únicamente activos visibles a las credenciales consultadas; no prueban la ausencia de activos no asignados o inaccesibles. Este inventario inicial no modificó producción; la comprobación productiva posterior se registra separadamente abajo.
- **Fixtures locales:** 7 pruebas unitarias (paginación, paths, GET, redacción, reintentos, timeout, versiones, credenciales, aislamiento) y 5 integraciones PostgreSQL/API (scope/workspace/entorno, ventanas, revisiones, idempotencia, ausencia de efectos) pasaron; no se presentan como consultas reales.
- **Aplicación local con servicios reales:** [evidencia de API/UI](evidence/meta-local-verification.json), capturas y resultados axe deben leerse por su estado explícito. La auditoría global contiene el último resultado de build/lint/typecheck/E2E.
- **Intervención humana bloqueante para operación oficial:** resolver BANNED/PENDING, confirmar WABA/elegibilidad, conceder el permiso faltante del primer portafolio si se requiere su inventario WhatsApp y revisar datasets. El modo de inventario Ads de sólo lectura sigue disponible.
- **Mejoras opcionales:** sincronización durable fuera del request para inventarios muy grandes; configuración protegida multi-workspace; detalle de insights/gasto con definición y ventana acordadas. No se añadieron métricas ni atribución inventadas.

**Configuración productiva:** el intento inicial fue rechazado antes de ejecutar y no se eludieron los controles. La autorización explícita posterior de Brandon permitió preparar la custodia privada y fusionar las cuatro variables Meta en `api.env` del VPS, únicamente para API y con permisos 0600. La configuración ligada al workspace y el inventario oficial productivo quedaron verificados el 06-sep; se conserva `process.env`, sin secretos en Git ni cambios de Compose.

## Resultado final API/UI local

El smoke real inicial pasó login, configuración ligada al workspace, POST interno `/v1/meta/sync` (201) y persistencia de dos portafolios. La última verificación del build en 2026-09-06T04:22:01.812Z reutilizó ese snapshot, sin nuevas consultas Graph: selector, aislamiento de cuentas homónimas, búsquedas sin datos, contexto al navegar, móvil 390×844 y foco por teclado pasaron. Axe con reglas WCAG 2 A/AA y 2.1 AA devolvió **0 violaciones** en ambos portafolios. Revisión visual de capturas desktop/móvil realizada; tabla horizontal en región accesible, controles y advertencias conservados. El fallo inicial de contraste del selector global fue corregido y vuelto a comprobar. Las esperas iniciales del script con label demasiado exacto se corrigieron en el verificador, sin transformar un error de Meta en éxito.


## Verificación productiva posterior — r4

[Evidencia productiva con ambas ejecuciones](evidence/meta-production-r4.json). La primera sincronización y su recorrido API/UI aprobaron 63 comprobaciones; axe registró cero violaciones en los dos portafolios. El inventario inicial productivo también conservó un HTTP 500 de Meta en los anuncios de Inovaris: en ese snapshot estaban **No disponibles**, no en cero. Las capturas pertenecen a ese momento.

Una segunda sincronización explícita, sólo API, aprobó 10 comprobaciones y recuperó los **86 anuncios de Inovaris**. El snapshot de las 12:17:40 UTC confirmó los mismos conteos de la tabla inicial: Inovaris 26 campañas/32 conjuntos/86 anuncios e Inovaris México 25/25/74. Su vigencia registrada termina a las 13:17:40 UTC; después debe mostrarse vencido hasta una nueva sincronización. El primer fallo no se elimina ni se transforma retrospectivamente en éxito.

Quedan **cuatro edges rechazados**: WABA owned/client de Inovaris por falta de `whatsapp_business_management`, y datasets en ambos portafolios con 400/código 1/subcódigo 1349004. Este último no demuestra un scope faltante: `business_management` continúa concedido. Los dos tokens fueron válidos y sin expiración programada; BANNED/PENDING de los números oficiales permanecen sin resolver. Continúan disponibles cuentas Ads, páginas, apps, campañas, conjuntos, anuncios y píxeles accesibles. No hay garantía sobre activos no asignados, disponibilidad futura ni atribución.

La preparación de vínculos conserva las pruebas locales/API de historial, versiones y conflictos; este smoke productivo no creó vínculos ni objetos comerciales para demostrarla. No envió mensajes ni conversiones y mantuvo el despacho congelado. La UI se comprobó sobre el primer snapshot; la recuperación posterior se verificó exclusivamente por API, sin volver a sincronizar desde el navegador.
# Control de lecturas — 08-sep-2026

[[adr-dashboard-meta-efficiency]]: peticiones GET idénticas comparten trabajo y resultado completo durante60s, con una petición activa por credencial dentro del proceso. Un429 no se reintenta inmediatamente; `retry_at` y `retry_after_seconds` conservan `Retry-After` numérico o fecha HTTP (mínimo60s). Los jobs de Insights persisten la espera y el programador recurrente la respeta. Las páginas incompletas, errores y cuentas no disponibles siguen explícitas, conservando lecturas válidas anteriores.

`POST /meta/sync` puede devolver200 con `reused:true` y `cache_expires_at` para un snapshot de la misma configuración de menos de60s, o durante el enfriamiento indicado por Meta. Una sincronización nueva devuelve201. La reutilización se comprueba después del bloqueo por workspace para evitar repetir un inventario que otra solicitud acaba de completar. Las revisiones de credenciales se comprueban otra vez antes de persistir; si cambian se devuelve409 `META_CONFIGURATION_CHANGED`.

La caché Meta y su cola son de proceso; no prometen coordinación global entre réplicas. Los jobs de Insights y los snapshots/bloqueos por workspace siguen siendo durables. Esta corrección no aumenta el límite global API de300 peticiones/IP/minuto ni el de dos solicitudes manuales de sincronización por minuto. La inspección productiva de45s no reprodujo429; la reducción corrige amplificadores verificados en código.
