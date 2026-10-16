# Reducción prospectiva de la reserva mensual de CI

Fecha: 2026-10-11. Estado: decisión técnica adoptada; aplicación nativa pendiente de evidencia y CAS protegido.

La lectura de facturación de las 20:32 UTC exige mantener el mismo criterio fiscal de la revisión 8: el incremento facturado en MXN se convierte al tipo de cambio conservado y se añade la reserva de IVA. Con las demás reservas íntegras, la proyección antes del ajuste es USD 100.22282246686234811677679811982547090383461664234. Reducir sólo 30 minutos dejaría USD 100.01402246686234811677679811982547090383461664234 y no cumple el límite.

Se reduce exclusivamente capacidad de CI aún no ejecutada: de 480 a 420 minutos por mes UTC (28800 a 25200 segundos). El ahorro bruto conservador es 60 × USD 0.006 × 1.16 = USD 0.4176. La proyección resultante es USD 99.80522246686234811677679811982547090383461664234. Los 74 minutos ya consumidos permanecen; la secuencia completa estimada de 239 minutos y todos sus gates caben, dejando 107 minutos. FULL conserva sus 5700 segundos. No se reduce una función, no se usa el crédito promocional como descuento, no se descuenta ninguna otra reserva ni se modifica el medidor de solicitudes.

## Contrato de transición

El ledger puro acepta una única transición `reduce_monthly_limit`, de 28800 a 25200 segundos. La invoca exclusivamente el operador protegido después de autenticar la decisión económica, los originales nativos, la ausencia de trabajo activo y la generación vigente. Un hash y `native_verified` enlazan esa evidencia; por sí solos no son autoridad ni se aceptan de una solicitud HTTP pública.

La transición requiere que no exista intento activo ni bloqueo, y que el consumo confirmado más toda reserva de cada mes registrado sea menor o igual a 25200 segundos. Conserva byte-equivalentes los mapas de eventos, intentos y builds externos, incluidos el plan de 95 minutos abortado antes de despacho y su evidencia histórica. Añade `limit_reduction` con los límites anterior y nuevo, el hash de evidencia y el instante; sólo cambian además el límite, la revisión y `updated_at`. No altera estados de ejecución, no crea un UUID de Build y no devuelve permiso para ningún efecto.

La misma evidencia ya aplicada produce un replay sin escritura; otra evidencia, un incremento, otro destino o un ledger manipulado se rechazan. La persistencia sigue siendo un único CAS con readback de generación y bytes, sin reintentos. Ante una respuesta incierta sólo procede conciliación GET del documento propuesto exacto. Una generación competida no autoriza reconciliar ni reescribir de forma ciega.

El validador por defecto exige 420 minutos, por lo que todos los consumidores operativos existentes rechazan el ledger de 480. Sólo las funciones explícitas `validate_historical_ledger`, `budget_usage_historical` y `transition_historical_abort` interpretan los originales anteriores; esta última permite exclusivamente reproducir el aborto histórico ya adoptado para compararlo, nunca reservar ni despachar. La reducción autentica el ledger anterior y produce un recibo durable en el resultado de 420. Una inicialización nueva explícita parte de 420, pero el runtime no inicializa una ausencia. El código histórico no se convierte en una autorización para volver a operar con 480. La aplicación nativa ocurre con el control pausado, antes de activar esas imágenes; no existe un selector de límite en HTTP ni en configuración proporcionada por el llamador.

## Verificación y alcance

Las pruebas deben cubrir conservación del histórico, meses cruzados, cuota exacta y excesos, trabajo activo o bloqueado, replays, modificación de recibos, CAS competido o incierto, reconciliación de bytes exactos, y rechazo operativo del límite anterior. La prueba económica y la aplicación nativa son requisitos separados. Esta decisión y las pruebas locales no acreditan que el ledger de producción ya haya cambiado.
