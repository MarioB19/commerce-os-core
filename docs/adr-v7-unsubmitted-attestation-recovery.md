# Cerrar una atestación reservada antes de aprobar — 6-nov-2026

Durante la publicación autorizada de V7.2, Google rechazó `ApproveBuild` con
429. La conciliación conservó el cargo y consumió permanentemente esa compuerta.
Una segunda reserva que apuntaba a ese UUID fue rechazada antes de persistir
una intención. El ledger no dispone de una salida para una atestación RESERVED
sin intención; su aborto anterior sólo cubre FULL.

Se añade `abort_before_approval`, exclusivamente para esa etapa y estado. El
operador protegido debe comprobar request terminado, controles pausados,
ausencia de intención y de aprobación/ejecución nativas, y vincular la evidencia
revisada. El resultado `ABORTED_BEFORE_APPROVAL` conserva plan, admisión,
aprobación y reserva; cobra los 120 segundos completos y libera sólo la
exclusión global. No inventa un UUID, intención, resultado ni éxito de pruebas.
Repetir la misma evidencia es sólo lectura; otra evidencia se rechaza.

Las atestaciones con intención o ejecución posible conservan su conciliación
anterior. Las compuertas consumidas siguen siendo inutilizables. Una nueva
ejecución exige evento, compuerta, inventario y admisión nuevos. El conductor
local comprueba ese UUID antes de admitir y observa el ledger en GCS durante
la aprobación para no consumir la cuota de lecturas de Cloud Build.

Se instala sólo el módulo de admisión probado en los runtimes confiables, con
controles pausados y comparación del resto de archivos. La recuperación se
registra por separado de la instalación. El techo permanece en US$150; un FULL
adicional y la conciliación caben en la reserva revisada. No cambia el producto
ni el comportamiento del calentamiento.
