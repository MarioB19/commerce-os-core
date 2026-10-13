# Superficie HTTP V7 (F8-D)

Agente: Claude · 13-oct-2026 · rama `claude/v7-f2-cutover`.

Objetivo del inventario V7: **≤180 operaciones HTTP de negocio públicas**, con
presupuestos separados y explícitos para identidad, salud/documentación,
webhooks y archivos, medidas sobre la misma definición.

## Definición y medición

La cuenta es el documento OpenAPI que genera la propia API (`app.swagger()`
sobre `createApp()`): una operación es un par método + ruta publicada. Las
rutas `/creative-device/*` y `/v1/studio/*` responden 410 y están ocultas del
documento; no se cuentan como superficie viva. Los webhooks de WhatsApp viven
en `apps/ingress` (otro servicio) y no forman parte de este documento.

| Presupuesto | Criterio | Operaciones |
|---|---|---|
| Identidad | `/api/auth/*`, `/v1/me`, `/v2/me*`, `/v2/invitation-acceptance*`, `/v2/invitation-registration` | 9 |
| Salud y documentación | `/livez`, `/readyz`, `/health/live`, `/health/ready`, `/api/version`, `/v1/openapi.json` | 6 |
| Archivos (bytes) | `/v2/materials/{id}/content`, `/v2/materials/{id}/parts/{n}`, `/v2/receipts/{id}/document`, `/v2/help/download` | 4 |
| Webhooks | (en ingress, fuera de este documento) | 0 |
| **Negocio** | todo lo demás, incluidas las rutas de plataforma y de operación | **160** |
| Total publicado | | 179 |

Antes de F8: 554 operaciones (F0, producción V5: 386; las rutas V7 se sumaron
a las V5 durante F2–F7). Tras F8-B/C: 457. Tras F8-D: 178 (159 de negocio). Con la
lectura de Meta por perfil (RF-11, `POST /v2/campaigns/sync`): **179 (160 de negocio)**.

## Lo que queda en `/v1`

Sólo lo que llama la aplicación V7, el MCP V7, el agente de capacidad del
host o un control de operación del dueño sin equivalente V7 todavía:

- **Números (RF-07):** `GET /v1/numbers/overview`, `POST /v1/numbers/quick`,
  `GET|POST /v1/numbers/{id}/link`, `POST /v1/numbers/{id}/pause`,
  `GET|POST /v1/numbers/{id}/removal`, `GET /v1/numbers/{id}/preparation`,
  `GET /v1/numbers/{id}/episodes`, `GET /v1/channel-accounts/{id}/qr`.
- **Ventas (RF-08/09):** `GET /v1/conversations[/{id}]`, `GET /v1/orders[/{id}]`,
  `POST /v1/conversations/{id}/commands|controls`, `GET /v1/sales-operations/{key}`.
- **Remarketing (RF-10.c):** `GET /v1/remarketing-cycles`,
  `POST /v1/remarketing-cycles/{id}/reprogram[/preview]`.
- **Agente de capacidad del host (cos_cap_):** `/v1/number-capacity*` (9) y
  `GET|PUT|POST /v1/settings/integrations*` (3), que usa
  `scripts/number-capacity-administrator.py` para registrar gateways WAHA.
- **Controles del dueño sin equivalente V7 aún:** `GET|PATCH /v1/settings/operations`,
  `GET /v1/settings/launch`, `POST /v1/settings/launch/switch` (abrir/pausar REAL;
  `profile_settings_manage.pausar_operacion/reanudar_operacion` sigue pendiente),
  `POST /v1/system/controls`, `GET /v1/system/status`, `GET /v1/readiness`,
  `GET|POST /v1/retention/policies` (`privacy_manage` pendiente),
  `GET|DELETE /v1/service-tokens` (listar y revocar tokens históricos; crear se retiró).
- **Puertos de recuperación del dueño (estados UNKNOWN):** `GET /v1/outbox/{id}` y
  `POST /v1/outbox/{id}/resolve` (entrega incierta; bloquea eliminar el número),
  `GET /v1/channel-accounts/{id}/session` y `POST .../session/recovery`
  (reconciliar un comando de ciclo de vida UNKNOWN, que si no bloquea todo
  vincular/desvincular de ese número), `POST /v1/warmup/accounts/{id}/profile-review`
  (revisión de sólo lectura de un perfil de calentamiento UNKNOWN),
  `GET|POST /v1/channel-accounts/{id}/source-isolation[/confirm]` (copias aisladas).

## Retirado en F8-D (sin consumidor V7)

| Familia V5 | Sustituto V7 |
|---|---|
| CRUD genérico `/v1/{categories,products,offers,assets,workflows,agents,bindings,bank-profiles,receipt-policies,contacts,leads,touchpoints,fulfillments,imports,incidents,health-signals,conversions,simulations,message-campaigns,acquisition-campaigns,ad-sets,ads,channel-accounts}` | `/v2/products`, `/v2/variants/{id}/{section}`, `/v2/materials`, `/v2/payments/policies`; conversaciones y pedidos siguen en `/v1` |
| Versiones/validación de catálogo, flujo de venta por oferta, vendedor visual y evaluaciones | Secciones versionadas de la variante (`/v2/variants/{id}/sales-flow|seller|offer`) y laboratorio de números (`/v2/number-tests`) |
| Asignaciones producto↔número, inventario de canales, selección de producto en conversación | `/v2/variants/{id}/numbers` (`elegir_variante` sigue pendiente en el registro MCP) |
| Autorizaciones de operación V5 | Continuidad D-17 (`/v2/continuity`) |
| Administración de números V5 (alta con dispositivo, edición, lote, identidad, acceso al enlace, programas, biblioteca, grupos, política, simulador, operaciones) | Recorrido V7 de Números (arriba); la lectura de operaciones queda en `/v2/operations/{id}` |
| Calentamiento V5 (pools, perfiles, contenido, simulación, backfill, preflight) | Calentamiento automático por número (`warmup_manage`) |
| Canales V5 (alta, edición, borrado, setup, activación, comandos, salud, recepción, uso del primario) | Vincular/desvincular/pausar/eliminar en Números; recuperación del dueño (arriba) |
| Meta V5, insights, impuestos estimados, productos de campaña | `/v2/integrations/meta`, `/v2/campaigns` y `POST /v2/campaigns/sync` (lectura con el token del perfil, RF-11) |
| Reportes, costos, importaciones y backfill de ventas | `/v2/results`, `/v2/usage`, registro de pagos |
| Usuarios V5, tokens personales `/v1`, creación de tokens de servicio | `/v2/employees`, `/v2/invitations`, `/v2/tokens`, `/v2/platform/capacity/agent-tokens` |
| Comandos genéricos, eventos, temporizadores, bandeja de salida (aprobar/editar/cancelar) | `/v2/operations/{id}`; envíos humanos por `conversations_manage` |
| Revisión y clasificación de comprobantes `/v1/receipts*` | Cola de comprobantes `/v2/receipts` |
| Resumen operativo de inicio, guía de lanzamiento | `/v2/home`, `/v2/help` |
| Atestación de evidencia operativa (`POST /v1/operational-evidence`) | Registro por script de operador con la conexión del dueño (Fase C) |
| `/v2/catalog/*` (F2) y borradores `/v2/market/*` (F4) | `/v2/products`, `/v2/variants`; queda `GET /v2/market/releases/{id}` para `variants_manage.version` |

## Consecuencias operativas registradas

- Tras instalar V7, los comandos de ciclo de vida que la ventana necesite
  (por ejemplo `resume` tras transferir la propiedad de sesiones) se encolan con
  un script de operador sobre la conexión del dueño; ya no hay ruta HTTP V5.
- `scripts/verify-deployment.mjs` verifica ahora con lecturas V7
  (`/v1/conversations`, `/v1/numbers/overview`).
- Se retiraron los scripts de operador V5 que llamaban rutas retiradas
  (`assign-pilot-gateway`, `audit-qr-production`, `closure-inventory`,
  `commerce-resilience-readback`, `verify-audit-r4`, `verify-meta-local`,
  `verify-production-qr`, `verify-session-continuity-production`, `rehearse`,
  `benchmark-numbers-list`, `commerce-client.mjs`). Sus documentos en `docs/`
  quedan como historia V5.
- `docs/contracts/numbers-*` describen el servidor MCP de números retirado en
  F8-A; se conservan como historia.
- El encabezado CSP de Caddy para `/v1/assets/*/content` y la verificación del
  410 de `/creative-device` se revisan con el ingress de F1.
