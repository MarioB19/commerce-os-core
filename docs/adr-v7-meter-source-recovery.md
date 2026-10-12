# ADR V7 — Conservar el consumo del controlador al conciliar SOURCE

Fecha: 2026-10-11. Estado: implementación acotada, pendiente de originales
nativos y admisión del adaptador para cualquier efecto.

Una solicitud SOURCE que termina antes del upload puede dejar la exclusión del
medidor activa. La respuesta HTTP y el vencimiento, por separado, no prueban que
los efectos terminaron. La recuperación usa el parser común de originales
`cloudbuild_source_recovery`, que vincula la solicitud única, su término nativo,
la pausa, el diario sin upload, la ausencia de fuente y el inventario completo.

La recuperación ocurre en dos CAS independientes. Primero se confirma y relee
el ledger en `ABORTED_BEFORE_DISPATCH`. Después el módulo puro
`cloudbuild_meter_recovery` compara ese documento íntegro con la transición
canónica desde el ledger original. Una CAS incierta del ledger no habilita la
CAS del medidor. Se conservan los mismos hashes de evidencia en ambas etapas.

El medidor conserva cada fila, fecha, meses, techo y consumo: en el incidente
actual permanecen 920 segundos, incluidos los 450 de SOURCE. Únicamente la fila
activa acreditada pasa de RESERVED o UNKNOWN a COMPLETED y recibe el hash del
recibo de recuperación. Se elimina su exclusión global; no se devuelve dinero,
tiempo, cuotas ni bytes. Tampoco se crea una ejecución exitosa o se autoriza un
nuevo intento de SOURCE. El evento y la adquisición anteriores siguen consumidos.

El módulo recibe bytes originales, generaciones y un recibo del parser común;
no interpreta HTTP, no escribe, no incorpora credenciales ni modifica el
medidor existente. El adaptador protegido debe autenticar el origen de esos
bytes, releer metadata/media/current del ledger y medidor, revalidar el parser
y la admisión al final, y enviar exactamente una CAS con la generación prevista.
Un hash o un recibo que aporte un cliente no constituye esa autoridad. La ruta
HTTP del controlador no acepta esta operación. Ante confirmación perdida sólo
se compara por GET el documento exacto propuesto, sin reenviar la CAS.

Pruebas exigidas: historial/consumo idénticos, fronteras de mes, rechazo de
generaciones o bytes distintos, término de ledger distinto, evidencia distinta,
fila/fecha/techo distintos, JSON duplicado o no finito, recibo caducado y reloj
revertido. Las pruebas sintéticas no acreditan el estado de producción.

La aceptación estructural de una fila UNKNOWN se prueba sólo con un recibo
sintético. El parser nativo actual emite recibos exclusivamente para RESERVED;
este módulo no amplía esa frontera ni habilita recuperación UNKNOWN genérica.

## Compatibilidad de los originales previos a la reducción del pool

El incidente ya conciliado ocurrió bajo el límite de 480 minutos. La validación
operativa posterior exige 420 minutos. Este lector usa exclusivamente
`validate_historical_ledger` y `transition_historical_abort` para reconstruir
el aborto histórico exacto; no habilita `discover`, `reserve`, despacho ni
ninguna bandera que seleccione el límite desde HTTP. Los 920 segundos del
medidor y todos los originales permanecen íntegros.
