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
   borra en una pasada sobre todas las llaves (perfil, entorno, número,
   dimensión), en bloques de `batch` filas (modo `sweep`), las señales
   observadas antes de `now − keep_days` (mínimo 2, configurado 8), **siempre
   conservando la última observación de cada llave**, junto con su fila de
   proyección y sus versiones (`scripts/v7_health_retention_batch.sql`). Cada
   bloque es una transacción con candados de fila sólo sobre sus señales
   viejas y joins hash (lectura secuencial), así que los productores siguen
   corriendo. No toca filas con número o dimensión vacíos ni instantes no
   finitos. `plan` sólo cuenta. Imprime conteos, bloques y segundos; un error
   de PostgreSQL se reporta por su SQLSTATE.
   - **Por qué no llave por llave (medido el 17-oct en producción):** las
     señales están dispersas por todo el heap, así que el modo `key` (sondeos
     por índice) borró ~25 filas/s con el disco ocupado; se detuvo a los
     8 min con 12,764 filas borradas. El modo `key` queda para limpiar un
     número y dimensión puntuales.
2. **Excepción acotada a la inmutabilidad (ADR-005).** Sólo el superusuario
   de la instalación, sólo `kind='health_signal'` y sólo dentro de la
   transacción de cada lote (ver «Cómo se borra»). `immutable_versions` nunca
   se desactiva para nadie. Una señal referenciada por cualquier llave foránea
   aborta su lote. La telemetría de salud es evidencia operativa, no comercial:
   órdenes, comprobantes, mensajes, conversaciones y versiones de cuentas no se
   tocan.
3. **Ventana de la Fase C.** Después del snapshot frío verificado y antes del
   B02 fresco: corte que conserva 2 días (más la última por llave) en una sola
   transacción (`cutover`, exige productores detenidos) y `VACUUM FULL` de las
   tres tablas (`compact`). Las estadísticas de 168 h muestran historia
   parcial durante la primera semana después de V7; desde el día 8 el
   temporizador mantiene 8 días.
4. **Límite de la transacción de migraciones V7: 600 s** (las demás
   publicaciones siguen en 300 s), dentro del mismo plazo total de 1500 s del
   instalador (`scripts/copy_runtime_deployment.py`, `migration_deadline`).

### Cómo se borra (sin cargar la producción)

Cada lote (`sweep` o `key`) bloquea con `FOR UPDATE` sólo sus filas (el corte, con productores
detenidos, toma candados `SHARE` sobre las tablas que referencian), verifica
por conjuntos que ninguna llave foránea apunte a ellas (y que ninguna esté
minimizada por privacidad) y sólo entonces borra con
`session_replication_role=replica` en esa transacción: sin `immutable_versions`
y sin sondeos de llave foránea fila por fila, que en pd-standard cuestan horas.
No toma candados de tabla en los modos `sweep` y `key`, así que nunca detiene a los
escritores. Al terminar vuelve a `origin` y comprueba que no quede nada del
conjunto y que los conteos coincidan.

### Ensayo sobre la copia de producción (16-oct)

| Paso | Resultado |
|---|---|
| Corte (conserva 2 días) | 3.33 M señales, proyección y versiones en 295–372 s |
| `VACUUM FULL` | índice 33–38 s · versiones 248–981 s · records 83–134 s |
| Base | 9.06 GB → 2.13 GB |
| Volcado `pg_dump -Fc` (B02) | 212 MB en 97 s (límite 1 GiB) |
| Exportación de retirados | 6 s, 529 filas |
| Migraciones 68→117 | 90–270 s según caché (antes del corte: 850 s) |

Los discos restaurados desde snapshot se hidratan bajo demanda: las primeras
lecturas del laboratorio son más lentas que en el disco de producción.

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
  lo reciente, aplica el corte a todas las llaves, el barrido diario llega al
  mismo resultado en bloques, exige superusuario, rechaza
  cortes de menos de dos días, aborta ante una referencia foránea y deja
  `immutable_versions` y `session_replication_role` como estaban.
- `tests/ci/test_copy_runtime_operating_migration.py`: sólo el corte V7 tiene
  600 s.
- Laboratorio sobre la copia de producción: tabla anterior.
