# Inventario de retiro V7 (F8) — antes y después

Agente: Claude · 13-oct-2026 · rama `claude/v7-f2-cutover` (commits `fda314b`,
`f3ff29e`, `2750823`, `1daeb9a`, `5e59943`, `8dddb3b`). Referencia «antes»:
producción V5 `80a6d6e` (rama `main`) y el árbol V7 antes de F8.

## Conteos

| Medida | Antes | Después | Cómo se midió |
|---|---|---|---|
| Herramientas MCP vivas | 153 (121 con token de servicio + 32 de perfil/plataforma) | 34 (registro de 40; 6 sin acciones servidas no se anuncian) | `docs/v7-mcp-map.md`; `profile-server.test.ts`, `v7-mcp-stdio.test.ts` |
| Operaciones HTTP publicadas | 554 (árbol V7 antes de F8; producción V5: 386) | 179 | `app.swagger()` sobre `createApp()` |
| — de negocio (meta ≤180) | — | 160 | criterio de `docs/v7-api-surface.md` |
| — identidad / salud y docs / archivos | — | 9 / 6 / 4 | ídem |
| Relaciones del catálogo compuesto | 227 (hasta 0108) | 188 (0109 en adelante) | `commerceProfileRowPolicy` sobre el catálogo migrado |
| Tablas retiradas con exportación | — | 39 + 4 funciones | `packages/db/src/retired-tables.ts`, `0109_v7_retire_modules.sql` |
| Ciclos del automation-worker | 15 (árbol V7 antes de F8; V5 en producción: 12) | 12 | `apps/automation-worker/src/index.ts` (la lectura de Meta V7 corre dentro del ciclo de insights) |
| Apps | 8 | 6 | se retiran `commerce-desktop` y `commerce-worker` |
| Paquetes | 12 | 9 | se retiran `creative-contracts`, `creative-engine`, `intelligence`, `provider-broker`; se añade `ai-providers` |
| Fuente web (sin pruebas) | 62 archivos, 15 428 líneas | 51 archivos, 7 537 líneas | `apps/web/src` |

## Qué se retiró y qué lo sustituye

| Módulo V5 | Estado V7 | Datos |
|---|---|---|
| Inteligencia (búsquedas, corridas, ofertas, análisis, lotes, corpus) | Retirado; sin sustituto comercial | 8 tablas exportadas cifradas y borradas por 0109 |
| SearchAPI y biblioteca R2 | Retirados; los materiales de venta viven en `/v2/materials` | `creative_settings`/`creative_uploads`/`finished_asset_intakes` exportadas; objetos de R2 no se borran aquí |
| Estudio creativo, voz, dispositivo de escritorio | Retirados; `/creative-device/*` y `/v1/studio/*` responden 410 | 27 tablas `creative_*` exportadas y borradas |
| Diagnósticos de proveedor/integración, presupuesto global creativo | Retirados; la IA la paga cada negocio con su llave (RF-14) | `provider_diagnostics`, `integration_diagnostics` exportadas; `read_profile_global_budget` borrada |
| Patrocinios MCL | Retirados (ya bloqueados desde 0042) | `mcl_sponsorships` exportada; el guardia de `outbox` sigue |
| Campañas de mensajes V5 (salientes) | Retiradas; sin productor V7 | un efecto con `campaign_id` se cancela con `V5_CAMPAIGN_RETIRED` sin enviar |
| Servidor MCP de token de servicio (121 herramientas) | Un solo MCP V7 con token personal o de plataforma | — |
| CRUD genérico `/v1`, administración de números V5, calentamiento V5, Meta V5, reportes | Superficie V7 (`docs/v7-api-surface.md`) | — |
| Web anterior | Una aplicación V7; direcciones anteriores redirigen y las funciones retiradas lo dicen sin datos | — |
| Scripts de operador V5 que llamaban rutas retiradas | Retirados (lista en `docs/v7-api-surface.md`) | — |

## Exportación (F8-E)

- `scripts/v7-retirement-export.ts status|export|verify`, incluido en la
  imagen. En la ventana: productores detenidos → `status` → `export <dir>`
  (fuera del repositorio, junto a la llave de datos) → `verify <dir>` → publicar
  V7 (0069–0110 en una transacción; 0109 aborta todo si falta o cambió una
  exportación).
- Recibos en `platform_retirement_ledger` (`@v7-retirement`,
  `V7_RETIREMENT_EXPORT`, `EXPORTED_VERIFIED`), con conteo, columnas,
  SHA-256 del texto plano y del archivo, huella de llave y manifiesto.
- Detalle: `docs/adr-v7-module-retirement-export.md`.

## Pendiente para Fase C

- Ejecutar la exportación con la conexión del dueño antes de la publicación y
  guardar el directorio cifrado con la llave de datos.
- Revisar en lectura si `release.env`/`admin.env` de producción conservan
  variables de R2 o SearchAPI y quitarlas en la instalación (el código V7 no
  las lee; la configuración vivía en `creative_settings`).
- El perfil adoptado de V5 debe pegar su token de Meta en Integraciones para
  que la lectura V7 continúe (`docs/adr-v7-meta-profile-read.md`).
