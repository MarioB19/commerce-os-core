# ADR V7.1 — Presupuesto de los bucles de los workers y crecimiento de la base

Agente: Claude · 25-oct-2026 · rama `claude/v7-1-release`. Complementa
`docs/adr-v7-dispatch-rls-index.md` (mismo problema, otra consulta) y
`docs/adr-v7-health-retention.md`. No cambia la arquitectura, las políticas ni
los roles.

## Contexto (medido el 25-oct-2026)

Producción (`commerce-os-test`, e2-standard-2) llevaba cuatro días con la
**CPU ocupada al 89 %** y PostgreSQL en ~155 %. El administrador de capacidad
exige CPU ≤ 70 % para crear gateways, así que el supervisor no podía preparar
plazas. Además, en esos cuatro días se archivaron 6,634 segmentos de WAL
(~106 GB sin comprimir) y la base pasó de 4.0 GB a 7.39 GB.

Laboratorio aislado: snapshot en caliente del disco de producción
(`commerce-os-test-boot-v7-lab-20261025`), VM del mismo tipo sin IP externa,
sin NAT, sin Private Google Access y sin cuenta de servicio. Arrancaron los
mismos contenedores (los gateways sin sesiones y sin salida a internet).
`pg_stat_statements` se activó sólo en la copia. Muestra de 300 s con los
workers corriendo: **CPU ocupada 89 %**, igual que producción.

| Consulta (300 s) | Llamadas | Media | % del tiempo de BD |
|---|---|---|---|
| `materializeEffectResults` (efectos terminales sin proyección) | 183 | 1,591 ms, 150k buffers | 40.9 % |
| `INSERT` de `health_signal` (disparadores) | 855 | 176 ms (disco frío del laboratorio) | 21.2 % |
| `isIsolatedNumberFlowTest` (compuerta de despacho) | 1,728 | 29 ms | 7.0 % |
| `newWorkflows` | 576 | 52 ms | 4.2 % |
| `outbox_gate_schedule` upsert | 8,910 | 3 ms | 4.0 % |

## Causas

1. **`materializeEffectResults` bajo RLS forzado.** Como `commerce_automation`,
   las tres subconsultas correlacionadas (mensaje por `body->>'effect_id'`,
   mensaje con otro estado y entrega por `id::text`) no pueden usar índices de
   expresión: `->>` y `uuid::text` no son leakproof. Cada efecto terminal (470)
   recorría todos los mensajes (577) y todas las entregas de su perfil. La
   vuelta tardaba más que su periodo (250 ms), así que el bucle corría sin
   pausa: un núcleo completo de PostgreSQL. Como `commerce_owner` (sin RLS) la
   misma consulta tarda 18 ms, por eso nunca se vio en pruebas.
2. **Efectos imposibles reevaluados cada 500 ms.** 15 efectos de SIMULATION
   bloqueados desde el 20-sep (`ASSET_SCOPE_INVALID`,
   `CAUSAL_PREDECESSOR_UNRESOLVED`) tenían recheck a 0 s: cada vuelta corría la
   compuerta completa (incluida `isIsolatedNumberFlowTest`, con el workspace en
   pausa) y reescribía su fila de `outbox_gate_schedule`. Eran 30 escrituras
   por segundo, sin HOT, más su WAL.

## Decisión

1. `PENDING_EFFECT_RESULTS` (`apps/automation-worker/src/effect-results.ts`):
   CTE materializadas.
   - `terminal`: los efectos terminales, con `fulfillment_id` convertido a uuid.
   - `messages`: los mensajes agrupados por `(perfil, entorno, effect_uuid)`.
   - `fulfillments`: sólo las entregas de esos efectos, por llave primaria.

   Después se cruzan con hash joins por `uuid = uuid` y `text = text`. Sólo se
   convierten cadenas en la forma canónica en minúsculas, las mismas que produce
   `uuid::text`; cualquier otra nunca coincidía. El resultado es el mismo
   conjunto en el mismo orden.
2. `scheduleGateRecheck` (`apps/channel-worker/src/dispatch.ts`): si la misma
   razón se repite sobre un efecto que lleva **al menos 10 minutos** bloqueado
   por ella (`outbox.updated_at` sólo se mueve cuando cambian su estado o su
   resultado), el siguiente chequeo espera el doble del tiempo desde el
   anterior (mínimo 1 s, máximo 30 s). Una razón nueva, un bloqueo reciente o
   una contención transitoria (`CHAT_LOCK_BUSY`, `DISPATCH_CAPACITY_BUSY`,
   `GROUP_OBSERVATION_FAILED`, `LOCAL_OWNERSHIP_DEADLINE`) conservan el
   intervalo base (SIMULATION 0 s, REAL 1 s). Así los flujos vivos y las
   simulaciones con reloj virtual avanzan igual que antes; la primera versión,
   sin el umbral de 10 minutos, rompía `mi-ciclo-listo-runtime` (un audio que
   espera a su predecesor). Consecuencia: un efecto en REAL bloqueado por pausa
   más de 10 minutos sale a lo sumo 30 s después de levantarse la pausa.

No hay migración: los índices existentes bastan con la forma nueva.

## Verificación

- **Laboratorio, consulta nueva como `commerce_automation`:** 11 ms y 1.2k
  buffers (antes 2,365 ms y 150k). Los mismos conjuntos que la forma anterior,
  también con divergencias sintéticas dentro de una transacción revertida
  (mensaje con otro estado, entrega sin versión de proyección, mensaje sin
  `effect_id`): 3 = 3 filas, mismo orden.
- **Laboratorio, workers parcheados** (bundles de esta rama en contenedores
  derivados, misma configuración): **CPU ocupada 37 %** en 300 s (antes 89 %).
  PostgreSQL bajó de 143 % a 36 % y `materializeEffectResults` de 1,591 ms a
  13.7 ms de media. Cumple el ≤ 70 % obligatorio y el ≤ 50 % objetivo. Todas
  las consultas de bucle quedan bajo 2 s; las más lentas son la de
  `isIsolatedNumberFlowTest` (15 ms) y `newWorkflows` (19 ms).
- **Pruebas:**
  - `tests/integration/effect-results-rls.test.ts`: mismas filas y orden que la
    forma anterior en siete casos, también con límite. Además, ningún recorrido
    de `records` queda dentro de un SubPlan por efecto.
  - `tests/integration/gate-recheck-backoff.test.ts`: base, duplicación, tope,
    reinicio por razón nueva, bloqueo reciente sin espera y contención sin
    espera. Los flujos de integración de canal y automatización (automation-runtime,
    catalog-simulator, mcl-sales-flow-v2, preschool-operational, warmup-runtime,
    mi-ciclo-listo-runtime, group-release-hold, expired-effects, dispatch-rls-index)
    pasan con los dos cambios.

## Crecimiento de la base (C)

Medido en la copia (`record_versions` por día, `records` por tipo):

- **Esperado y acotado (la mayor parte de 4.0 → 7.39 GB).** El corte de la
  ventana del 21-oct dejó 2 días de telemetría de salud, y la retención oficial
  conserva 8 días. Se vuelve a llenar la ventana: 56 cuentas × 3 dimensiones
  cada ~60 s, unas 196k `health_signal` al día, con su versión y su fila en
  `health_observation_index`. Hoy hay 1.74 M de señales (471 MB de cuerpo).
  `records` ocupa 2.67 GB (2.0 GB son índices) y `health_observation_index`
  1.39 GB. Se estabiliza al llegar a 8 días (≈29-oct). Después, el borrado
  diario deja espacio que se reutiliza; los archivos no se encogen.
- **Sin purga (~70 MB/día, ≈2 GB/mes).**
  - Cada versión de `channel_account` es un cambio sólo de `health_checked_at`:
    4,020 por hora, cada ~45 s por cuenta.
  - Los `service_heartbeat`: 808 por hora, ~1 KB cada uno.

  `record_versions` es evidencia inmutable y la retención de salud no toca
  versiones de cuentas.
  - **No se corrige en esta release.** Saltar el snapshot rompería la
    invariante «la versión vigente existe en `record_versions`», que leen
    `number-lab-snapshot`, `variant-workspace` y `number-lab-material-custody`.
    El warmup necesita `health_checked_at` con menos de 90 s.
  - **V8:** mover la vivacidad (`health_checked_at`, heartbeats) a tablas sin
    versionar, como `channel_sessions`.
  - Con 42 GB libres hay más de un año de margen.
- **Mantenimiento:** nada destructivo. `records` tiene 4 índices únicos
  idénticos sobre `(id, workspace_id, environment, kind)` y 3 sobre
  `(id, workspace_id, environment)`, que suman ~900 MB. Los sostienen llaves
  foráneas compuestas de migraciones distintas. Consolidarlos exige reescribir
  esas FK: plan para V8, con medición del tiempo de migración en la copia.
