# ADR V7 F8-E — Exportación cifrada y retiro de módulos V5

Agente: Claude · 13-oct-2026 · rama `claude/v7-f2-cutover`.

## Contexto

La autorización V7 §2 incluye retirar V5/Inteligencia/SearchAPI/R2 «con
exportación cifrada y legible». F8-A…D ya quitaron sus rutas, herramientas MCP,
bucles y paquetes. Quedaban 39 tablas: 8 `intelligence_*`, 27 `creative_*`,
`finished_asset_intakes`, `provider_diagnostics`, `integration_diagnostics` y
`mcl_sponsorships` (lista única en `packages/db/src/retired-tables.ts`).

## Decisión

1. **Exportación previa obligatoria.** `scripts/v7-retirement-export.ts`
   (`status`, `export <dir>`, `verify <dir>`) corre con la conexión del dueño de
   migraciones (superusuario de la instalación) dentro de la ventana, con los
   productores detenidos. Escribe un `<tabla>.jsonl.enc` por tabla (una fila por
   línea: `to_jsonb(fila)::text`, cifrada con la llave de datos de la
   aplicación, modo 0600) y `manifest.json` con conteos, columnas, SHA-256 del
   texto plano y del archivo y la huella no secreta de la llave. Relee y
   descifra todo antes de registrar un recibo por tabla en
   `platform_retirement_ledger` (`workspace_id='@v7-retirement'`,
   `kind='V7_RETIREMENT_EXPORT'`, `disposition='EXPORTED_VERIFIED'`). Nunca
   imprime datos de filas.
2. **0109 sólo borra lo exportado.** `0109_v7_retire_modules.sql` recalcula,
   para cada tabla con filas, el conteo y el SHA-256 de los textos ordenados
   sobre las columnas que vio el último recibo (las columnas que una migración
   V7 añadió después, como los alcances derivados de 0083, quedan fuera). Si no
   coincide, aborta con `RETIREMENT_EXPORT_REQUIRED:<tabla>` y no cambia nada.
   Exige superusuario o BYPASSRLS (`RETIREMENT_OWNER_BYPASS_REQUIRED`) para que
   la seguridad por filas nunca haga parecer vacía una tabla. Fija TimeZone,
   DateStyle, IntervalStyle, extra_float_digits y bytea_output igual que el
   exportador. `DROP TABLE` sin CASCADE; también retira
   `creative_immutable_row()`, `v5_block_new_sponsorship()`,
   `v5_block_remote_production()` y `read_profile_global_budget(text)`.
3. **Orden en la ventana (Fase C).** La publicación V7 aplica 0069–0109 en una
   sola transacción (migración acotada de copy-runtime). Por eso la exportación
   se toma sobre el esquema V5 (68 migraciones) *antes* de publicar; si faltara
   o cambiara una fila, toda la publicación se revierte y la base sigue en 68
   (probado en `tests/integration/v7-retirement-export.test.ts`). También vale
   exportar sobre 0108 y luego aplicar 0109 con el migrador normal.
4. **D-21 (assets útiles):** lectura de producción del 13-oct (sólo GET): los 38
   materiales REAL son archivos del almacenamiento privado (34) o accesos (4);
   ninguno vive en R2 (`storage_provider`), así que el retiro no deja entregas
   sin bytes. Los objetos de R2 y las filas exportadas permiten reimportar si
   apareciera otro uso.
5. **Se conserva:** el libro `platform_retirement_ledger` con los recibos, el
   rol `commerce_global_budget_reader` (sin permisos), los objetos de R2 (no se
   borran aquí) y `warmup_simulation_runs`/`number_simulation_groups` (los usa
   el simulador del channel-worker).
6. **Campañas de mensajes V5.** No hay productor V7 de campañas. Un efecto que
   aún lleve `campaign_id` se cancela con motivo `V5_CAMPAIGN_RETIRED` antes de
   cualquier envío, y un `campaign_schedule` en cola falla con ese motivo;
   `campaign_cancel` sigue disponible. Nada sale fuera de D-17.

## Consecuencias

- Las clasificaciones de aislamiento (filas y llaves compuestas) aceptan el
  catálogo completo hasta 0108 (227 relaciones) o el actual (188), nunca uno a
  medias (`COMMERCE_ROW_RETIREMENT_PARTIAL`). La prueba de 0098 compara contra
  una base migrada hasta 0108.
- Los guardas de despliegue (`BARRIERS_SQL`, `in_flight_guard`,
  `commercial_snapshot`) consultan las tablas retiradas sólo si existen
  (`retired_count`/`retired_rows`); una tabla ausente cuenta como vacía.
- El ensayo de recuperación (`scripts/recovery-fixture.ts`,
  `scripts/verify-recovery.mjs`) ya no siembra ni verifica filas creativas; la
  restauración (`scripts/restore.mjs`) sigue protegida con `to_regclass` para
  respaldos antiguos.
- Los scripts de ventana V7 (`v7-retirement-export`, `v7-variant-migration`,
  `v7-continuity-adoption`, `v7-number-lab-install`) se incluyen en la imagen.
- La exportación debe guardarse fuera del repositorio, junto con la llave de
  datos que la abre; `verify` no necesita la base.
