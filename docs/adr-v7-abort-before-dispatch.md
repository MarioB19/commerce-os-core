# ADR V7 — Conciliar una reserva sin despacho nativo

Fecha: 2026-10-11. Estado: decisión adoptada para implementación; ninguna
conciliación de producción queda acreditada por este documento.

Una solicitud del controlador puede terminar durante la adquisición de fuente,
después de reservar CI y antes de persistir `submit_intent`. Exigir un UUID de
Build para conciliar ese caso obligaría a inventar una ejecución. Liberar la
reserva sólo por un error, vencimiento o ausencia de UUID permitiría despachos
ambiguos. Conservamos ambas fronteras mediante un estado terminal específico.

`abort_before_dispatch` admite únicamente un intento `full` en `RESERVED`, con exclusión
global propia y sin intención de envío, UUID, observación terminal ni resultado
de ejecución. El adaptador protegido debe autenticar originales que prueben una
solicitud terminada bajo un fence que impida continuar, diario de adquisición de
fuente sin resultado ni upload, objeto de fuente ausente y un inventario nativo
global completo sin despacho correspondiente. Una ausencia parcial o un resultado
incierto conserva íntegramente la reserva y la exclusión. El parser común
`cloudbuild_source_recovery.validate_evidence` liga originales, intento, plan,
solicitud, generaciones y hashes del ledger/medidor, y una ventana fresca.

El comando puro conserva el contrato `native_verified` de las conciliaciones
existentes. Este indicador y el hash de evidencia **no autentican** al invocador:
la ruta HTTP no acepta comandos, recibos ni pruebas del cliente. El adaptador
protegido verifica las generaciones y hashes actuales, vuelve a validar fence y
vigencia al final de las lecturas y ejecuta una sola CAS. Una confirmación perdida
se reconcilia mediante GET y comparación exacta de la propuesta conservada, sin
volver a ejecutar la CAS ni convertir un conflicto en autorización nueva.

El estado `ABORTED_BEFORE_DISPATCH` conserva plan, aprobación, admisión, fecha de
reserva y clave del evento. Añade `abortion` con el hash de evidencia, fecha de
conciliación y segundos históricos reservados. Libera exclusivamente la reserva
no ejecutada y `active_attempt`; nunca crea un Build, un intervalo de consumo o
un PASS. El mismo evento e intento permanecen consumidos: redescubrirlos no
permite reservar ni despachar de nuevo. Los intentos ya enviados siguen usando
las transiciones nativas existentes.

El pool mensual permanece en 480 minutos; los 74 minutos históricos consumidos
y las filas del medidor, incluidos sus 920 segundos reservados, se conservan.
La reserva de 95 minutos continúa visible en el historial del intento abortado,
aunque deja de ocupar capacidad futura. El medidor sólo libera su exclusión
después de autenticar el readback de esta transición; sus importes no disminuyen.
Esta conciliación no reabre un ledger bloqueado ni modifica controles de pausa,
cuotas, costes, permisos, fuente o presupuesto.

Validación requerida: rechazo de todos los estados posteriores a envío y de
pruebas no autenticadas por el adaptador; preservación de consumo/historial y
fronteras de mes; no reactivación del evento; CAS concurrente contra envío; CAS
incierta sin efecto ni repetición; validación estricta de la forma durable del
nuevo estado. Una prueba sintética acredita esas invariantes, no la ausencia de
un Build real.
