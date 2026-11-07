# Migración incremental 117→118 sobre la base V7 — 7-nov-2026

El ensayo aislado del paquete de main V7.2 (`0c288fa5`) se detuvo en
`copy-runtime-approvals.py observe` con `COPY_RUNTIME_68_MIGRATION_BASELINE_REQUIRED`.
`migration_stage_guard` sólo admitía el corte V7 completo (68→117) o un esquema ya
aplicado; V7.2 es la primera publicación que añade una migración después del corte,
y ninguna prueba cubría ese caso. El paquete no podía instalarse sobre V7.1.1.

Decisión: `V7_INCREMENTAL_MIGRATION_NAMES` declara la cola exacta
`0118_v72_group_library_warmup.sql`. En OPERATING se admite únicamente una base de
117 migraciones idénticas a las del paquete a la que le falta exactamente esa cola.
El plan acotado aplica sólo esa migración, en la misma transacción y con su propio
perfil cerrado del script (`baseline 117 → total 118`), monta sólo su SQL y no
repite trabajo del corte: ni la exportación previa a 0109 ni el cambio de versión
de tokens de 0072. El resultado es `APPLIED_BOUNDED_INCREMENTAL`, por lo que la
comparación de credenciales de dueño sigue la histórica. Las aprobaciones Root
siguen sellando el conjunto completo revisado; `observe` y el instalador comparten
el mismo guardia. Cualquier otro faltante, deriva de hash o etapa sigue rechazado.

Pruebas: `tests/ci/test_copy_runtime_v72_incremental.py` cubre el guardia, la
detección exacta, el perfil del script y la ejecución sin trabajo del corte. La
evidencia real es el ensayo aislado sobre una copia de producción antes de instalar.
