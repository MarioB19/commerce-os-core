# ADR — Turnos durables entre cuentas del dispatcher

Fecha: 2026-09-08. Estado: aceptado para implementación local.

Con más cuentas bloqueadas que plazas del lote, ordenar siempre por la secuencia original seleccionaba las mismas cabezas en cada tick. Una cuenta saludable posterior podía esperar indefinidamente aunque el backlog de cada cuenta tuviera prioridad por rango.

Se conserva `row_number` por cuenta ordenado por `dispatch_sequence`. Entre efectos del mismo rango se elige primero el que lleva más tiempo sin actualizarse (`updated_at`), con secuencia como desempate. Cada denegación ya persiste una nueva fecha; por ello cede su plaza en el próximo tick, también después de reiniciar el worker. Se mantienen guard, predecesores, secuencia inmutable, cuotas y ownership. `UNKNOWN` sigue fuera de las candidatas.

El índice parcial existente `outbox_account_sequence_pending(account_id, dispatch_sequence)` conserva utilidad para ordenar dentro de cada cuenta. El orden global por rango ya requiere una ordenación calculada; añadir `updated_at` al desempate no justifica un índice separado que no puede representar ese rango. Se revisará el plan SQL sobre una base de pruebas retenida, sin modificar índices ni migraciones existentes.

La regresión fija 21 cuentas pausadas anteriores y una saludable con lotes de 20. En el segundo tick se debe enviar la saludable y ninguna pausada debe iniciar HTTP. Las fechas de ese fixture representan un backlog antiguo para coexistir con efectos de otras suites; no se filtra el dispatcher por workspace. Las pruebas causales existentes verifican que el cambio de equidad no altera la secuencia de una conversación.

Validación local: 15/15 integraciones de automatización y orden causal. EXPLAIN ANALYZE sobre 135 candidatas sintéticas utilizó WindowAgg, ordenación por cuenta/secuencia y top-N por rango/fecha/secuencia en 5.611 ms. El optimizador eligió lectura secuencial para ese conjunto pequeño; no es una medición de carga productiva.

El perfil de carga existente volvió a pasar con este dispatcher: 10 cuentas simuladas, 500 conversaciones, 2500 entradas y 2500 salidas aceptadas por el simulador, sin fallos HTTP ni cola pendiente. Incluye 125 imágenes pequeñas por dirección. El p95 de aceptación HTTP fue 67.55 ms y de ingreso persistido a materialización 273.21 ms; duración 125.42 s y pico del harness 243859456 bytes. [Evidencia](evidence/load-profile.json). No mide sesiones WAHA reales, latencia IA, MP3 grandes ni capacidad del VPS.
