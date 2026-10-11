# Meta: inventario, gasto oficial y preparación interna

**Actualización 06-sep-2026:** Insights y dashboard implementados localmente; [contrato, sincronización y límites](campaign-receipt-sales.md). Credenciales actuales en conexiones cifradas por workspace (migración 0018); 0019 permite lectura del token Meta al worker de automatización para Insights. El resto de esta nota conserva el historial de inventario r4; su configuración por env no describe la custodia vigente. Dos cuentas verificadas en GET oficial para 05-sep, gasto cero; [evidencia](meta-insights-live-verification.json). No se desplegó este incremento.

Decisión: [[🏗️ ADR-007 — Meta de solo lectura y vínculos históricos — 2026-09-06]]. La referencia funcional fue `Vibe Marketing/dashboard-wa`: selector contextual, tabla y filtros. No se reutilizó su código, sus IDs configurados ni la versión v24.0.

El módulo utiliza exclusivamente GET de Graph/Marketing API con versión fija **v26.0**. Se verificó esa versión en el [SDK oficial de Meta](https://raw.githubusercontent.com/facebook/facebook-nodejs-business-sdk/main/src/api.js) y en la cabecera `facebook-api-version` de consultas reales. El [changelog oficial](https://developers.facebook.com/docs/graph-api/changelog/versions/) devolvió 429 en esta sesión: no se inventa fecha de lanzamiento. Los edges Business/Ads/WhatsApp se contrastaron con el [modelo Business oficial](https://raw.githubusercontent.com/facebook/facebook-nodejs-business-sdk/main/src/objects/business.js).

## Configuración protegida

La API requiere `META_WORKSPACE_ID` igual al workspace autenticado y credenciales en su entorno (`META_ACCOUNT_KEYS` más `META_ACCOUNT_<ALIAS>_ACCESS_TOKEN`) o `META_CREDENTIAL_ENV_FILE` apuntando al archivo privado existente que contiene esas variables. También admite `META_ACCESS_TOKEN` para una única credencial. No copia secretos, no admite credenciales desde el navegador y no usa los business/account IDs configurados en archivos legados. No versionar ese archivo ni incluirlo en imágenes. Montar sólo en API; los workers de mensajería no necesitan esta credencial de inventario. El archivo privado preexistente del legado no fue trasladado ni publicado.

`META_WORKSPACE_ID` es obligatorio para habilitar nuevas consultas; otro workspace no puede usar ese conjunto de credenciales. Una instalación con múltiples workspaces necesita un registro protegido por workspace antes de extender esta configuración. El inventario ya persistido conserva su ámbito incluso si la configuración se desconecta.

Roles owner/operator/analyst pueden leer; owner/operator pueden sincronizar y crear relaciones internas. Los tokens de servicio del catálogo no acceden a Meta. Una credencial externa puede tener permisos de escritura; el cliente del producto sólo expone GET y ninguna ruta permite ejecutar esos permisos. No se crearon anuncios PAUSED, conversiones ni acciones comerciales.

## API

Todas las rutas requieren autenticación. `environment=REAL` es explícito: SIMULATION no consulta Graph ni devuelve inventario real.

| Método y ruta | Resultado |
|---|---|
| GET `/v1/meta/status?environment=REAL` | Estado, origen, versión, vigencia, portafolios, scopes confirmados, errores por consulta y números que requieren atención. |
| POST `/v1/meta/sync?environment=REAL` `{}` | `201`, snapshot local inmutable; sólo GET externos, Idempotency-Key obligatoria, límite 2/min. Un resultado parcial no se transforma en éxito completo. |
| GET `/v1/meta/portfolios/{id}/assets?environment=REAL&q=&kind=&ad_account_id=&limit=50&offset=0` | `{data,meta:{total,source,sync_id,synced_at,valid_until,stale}}`; portafolio no accesible: 404. |
| GET `/v1/meta/links?environment=REAL&portfolio_id={id}` | Historial, actor, revisión, ventana original, `effective_valid_to` derivada de la siguiente revisión y `superseded_by`. |
| POST `/v1/meta/links?environment=REAL` | `201`, asociación interna; idempotencia y bloqueo por cuenta/origen. Nunca activa ventas ni modifica Meta. |

Ejemplo de asociación (IDs de ejemplo; sustituir por resultados API, sin teléfonos):

```json
{
  "portfolio_id":"business_from_meta",
  "ad_account_id":"act_from_meta",
  "campaign_id":"campaign_from_meta",
  "ad_set_id":"adset_from_meta",
  "ad_id":"ad_from_meta",
  "asset_ids":[],
  "acquisition_account_id":"00000000-0000-4000-8000-000000000001",
  "closing_account_id":"00000000-0000-4000-8000-000000000002",
  "product_id":"00000000-0000-4000-8000-000000000003",
  "offer_version_id":"00000000-0000-4000-8000-000000000004",
  "workflow_version_id":"00000000-0000-4000-8000-000000000005",
  "valid_from":"2026-09-06T00:00:00Z",
  "source":"manual",
  "evidence_ref":"decision:review-id",
  "status":"ACTIVE"
}
```

`asset_ids` permite páginas/WABA/números/píxeles/apps adicionales sólo del mismo portafolio. `source` distingue manual, provider_experimental e inferred; el componente Meta de la evidencia queda registrado separadamente como META_API y el `sync_id`. No existe opción cliente para fabricar una asociación completa “verificada por Meta”. La oferta/flujo deben ser versiones publicadas internamente y pertenecer al producto/workspace/entorno. Una revisión incorpora `supersedes_id`, `expected_revision` y nuevo `valid_from` posterior. Una revisión RETIRED cierra la anterior sin borrarla. No se sobrescriben filas.

Conflictos de jerarquía, ventanas solapadas, versiones desactualizadas y snapshots vencidos devuelven 409 con código/mensaje accionable. Catálogo/flujo de otro workspace/entorno devuelve 404. Falta de rol: 403. Payload inválido: 400. La vigencia del snapshot es una hora; la caducidad conocida del token se comprueba además al asociar. Revocaciones ocurridas después del último GET sólo pueden conocerse en una nueva sincronización: UI muestra el momento del dato, no una garantía de disponibilidad actual.

La relación persiste `attribution_status=NOT_PROVEN`: destino no prueba procedencia. Estos vínculos no alimentan silenciosamente bindings del runtime ni alteran conversaciones históricas. No hay asociación automática QR→WABA/Ads. Número de captación y cierre son referencias independientes.

## Fallos y minimización

La paginación reconstruye cursores para el mismo path/version y jamás sigue `paging.next` arbitrario ni conserva su token. Límite 25 páginas por edge; resultado explícitamente PARTIAL al alcanzar límite. GET tiene timeout 12 s y máximo tres intentos para red/429/5xx; Retry-After se acota a 5 s. Rate limits repetidos no generan loops ni escrituras externas. Los errores persisten únicamente clasificación, HTTP/code/subcode/trace y permiso esperado por el edge; no payload, URL con query, mensaje externo arbitrario o credenciales. Los números se reducen a cuatro dígitos antes de persistir. Textos se minimizan y redactan patrones de teléfonos/tokens/correos. No se consultan clientes, contactos, mensajes o contenido de conversiones.

Scopes listados en errores son requisitos de la operación, no prueba de que ese scope sea la causa concreta. Código 190 distingue credencial expirada; 200/10 permisos; 100/803 recurso/campo inaccesible; 4/17/32/613/429 límite. Se bloquea una respuesta con otra versión de Graph.

## Evidencia y límites reales

Ver [inventario sanitizado](evidence/meta-readonly-inventory.json) y [informe Meta](meta-inventory.md). Las pruebas unitarias `meta-client.test.ts` (7) e integración `meta.test.ts` (5) pasaron localmente; fixtures sólo en la suite, PostgreSQL aislado con migraciones 0001–0016. No demuestran acceso remoto: ese acceso se registra separadamente en inventario real. El smoke de aplicación local y revisión visual se reportan en la auditoría global.

## Custodia productiva — autorización y estado

El intento inicial de preparar la custodia productiva fue rechazado por la revisión automática antes de ejecutarse; en ese intento no se copiaron secretos ni se eludió el rechazo. Brandon autorizó expresamente esta provisión el 06-sep-2026. Se preparó `~/.config/commerce-os-production/meta.env` (0600, padre 0700), y sus cuatro variables se fusionaron después en `/opt/commerce-os/private/api.env` con backup privado 0600 y verificación del workspace productivo. La API se recreó y quedó saludable. Sólo ese servicio recibe `META_WORKSPACE_ID`, `META_ACCOUNT_KEYS` y las dos variables de token por alias mediante el contrato existente `process.env`; no necesita `META_CREDENTIAL_ENV_FILE`, otro mount, cambios de Compose o una imagen diferente. La comprobación HTTPS confirmó configuración ligada al workspace y acceso oficial real; no se imprimieron valores privados.

## Resultado final API/UI local

El smoke real inicial pasó login, configuración ligada al workspace, POST interno `/v1/meta/sync` (201) y persistencia de dos portafolios. La última verificación del build en 2026-09-06T04:22:01.812Z reutilizó ese snapshot, sin nuevas consultas Graph: selector, aislamiento de cuentas homónimas, búsquedas sin datos, contexto al navegar, móvil 390×844 y foco por teclado pasaron. Axe con reglas WCAG 2 A/AA y 2.1 AA devolvió **0 violaciones** en ambos portafolios. Revisión visual de capturas desktop/móvil realizada; tabla horizontal en región accesible, controles y advertencias conservados. El fallo inicial de contraste del selector global fue corregido y vuelto a comprobar. Las esperas iniciales del script con label demasiado exacto se corrigieron en el verificador, sin transformar un error de Meta en éxito.


## Verificación operativa privada

Los inventarios reales, identificadores de cuentas y resultados de revisiones productivas se conservan fuera del repositorio público. Esta documentación describe el contrato de la integración; los fixtures públicos son sintéticos y no acreditan resultados ni permisos de un portafolio real.
