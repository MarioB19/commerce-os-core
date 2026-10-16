# ADR V7 — Retención de la telemetría de salud de los números

Agente: Claude · 16-oct-2026 · rama `claude/v7-f2-cutover`. Complementa
`docs/adr-v7-f1-infrastructure.md` (§1 PITR, §4e B02) y la guía de la ventana
`docs/v7-fase-c-runbook.md`. No cambia la arquitectura: añade un operador Root,
un temporizador y un paso de la ventana.

## Contexto (medido el 16-oct-2026)

- El channel-worker guarda una observación de salud por número y dimensión en
  cada sondeo (~25 s): ~234 mil filas `health_signal` al día. Nada las purgaba.
- Producción: 3.77 M señales (desde el 6-sep), base de 9 GB; `records`
  3.6 GB, `record_versions` 3.0 GB y `health_observation_index` 2.7 GB. Disco
  de arranque pd-standard de 100 GB al 76 % (~0.5 GB/día de crecimiento).
- **B02 falla desde el 13-oct**: el volcado cifrado pasó el límite de 1 GiB
  por archivo (`BACKUP_EXPORT_CUSTODY_INVALID`). Último B02 bueno: 12-oct.
  Mitigación interina: snapshot del disco (16-oct), restaurado y verificado en
  un laboratorio aislado.
- **Ensayo de la instalación sobre una copia de producción** (VM de laboratorio
  sin red, disco pd-standard desde ese snapshot, imagen V7 `690e0d8`): la
  exportación de módulos retirados tarda 6 s, pero las 49 migraciones
  0069→0117 tardan **850 s** en una transacción (0071 272 s, 0069 241 s,
  0098 205 s). El instalador las acota a 300 s: la publicación se revertiría.
- La aplicación sólo lee siete días de esta telemetría (salud del número y
  estadísticas operativas de 1 h, 24 h y 168 h).

## Decisión

1. **Retención diaria (8 días).** `scripts/v7_health_retention.py run` (Root,
   `commerce-health-retention.timer`, 05:30 UTC, antes de B02 a las 06:45)
   borra, por llave (perfil, entorno, número, dimensión) y en transacciones
   pequeñas, las señales observadas antes de `now − keep_days` (mínimo 2,
   configurado 8), **siempre conservando la última observación de cada
   llave**, junto con su fila de proyección y sus versiones
   (`scripts/v7_health_retention_batch.sql`). No toca filas con número o
   dimensión vacíos ni instantes no finitos. `plan` sólo cuenta. Imprime
   conteos y segundos.
2. **Excepción acotada a la inmutabilidad (ADR-005).** `record_versions`
   conserva `immutable_versions`; el superusuario de la instalación la
   desactiva sólo dentro de la transacción de cada lote y la reactiva antes del
   COMMIT, así que ninguna otra sesión la ve desactivada (esperan el candado,
   con `lock_timeout` de 5 s del lote). Sólo `kind='health_signal'`. Las llaves
   foráneas y los demás disparadores (guardas de privacidad V7, cuotas) siguen
   activos: una señal referenciada aborta su lote. La telemetría de salud es
   evidencia operativa, no comercial: órdenes, comprobantes, mensajes,
   conversaciones y versiones de cuentas no se tocan.
3. **Ventana de la Fase C.** Después del snapshot frío verificado y antes del
   B02 fresco: purga de corte que conserva 2 días (más la última por llave) y
   `VACUUM FULL` de las tres tablas. Así el B02 vuelve a caber y las
   migraciones quedan dentro de 300 s. Las estadísticas de 168 h muestran
   historia parcial durante la primera semana después de V7; desde el día 8
   el temporizador mantiene 8 días.

## Alternativas descartadas

- Subir el límite de B02 o el de las migraciones: no detiene el crecimiento ni
  el llenado del disco.
- Espaciar las escrituras (guardar sólo cambios): cambia la vigencia de la
  salud actual (detección de un gateway caído) y queda como incremento
  posterior con su propia revisión.
- Borrar versiones de `channel_account` (1.77 M) o de `service_heartbeat`
  (0.67 M): son historia de entidades del negocio o requieren otra decisión.
  Siguen creciendo más despacio y quedan registradas como pendiente.

## Verificación

- `tests/ci/test_v7_health_retention.py`: configuración cerrada, lotes por
  llave hasta agotar, presupuesto de tiempo, resultados inconsistentes y
  errores sin datos de filas.
- `tests/integration/v7-health-retention.test.ts` sobre el esquema V7
  completo: borra sólo la llave pedida y sus versiones, conserva la última y
  lo reciente, exige superusuario, rechaza cortes de menos de dos días, aborta
  con una referencia foránea y deja `immutable_versions` activa.
- Laboratorio sobre la copia de producción: tiempos de purga, compactación,
  B02 y migraciones en la evidencia de la Fase B.
