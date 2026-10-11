# Progreso del worker de canales

El heartbeat de ownership se ejecuta independientemente del descubrimiento de sesiones y la conciliación de comandos/efectos. Una lectura o cuenta bloqueada no debe retrasar la renovación de otras cuentas: la consulta de renovación usa `FOR UPDATE SKIP LOCKED` y vuelve a evaluar las cuentas omitidas en el siguiente intervalo.

La renovación sólo admite owner/generación adquiridos por el proceso actual. Después de perder la lease, ese proceso puede renovarla si conserva esa misma generación, la cuenta no está retirada, la sesión sigue RUNNING y no hay pausa ni freeze. `recovery_enabled=false` sigue impidiendo la reconexión automática del proveedor; no impide mantener la propiedad ya adquirida. Una renovación no cambia permisos, flags comerciales, frozen ni generación. Recuperar una lease vencida registra `channel.ownership_lease_recovered` una vez por episodio. Otro owner/generación sigue necesitando el protocolo de aislamiento vigente; no se deduce aislamiento de un vencimiento.

## Señales

- `/livez` acredita proceso HTTP vivo.
- `/readyz` exige DB disponible y progreso reciente de todos los loops críticos; devuelve 503 para STARTING, FAILED, STALLED, STALE o STOPPED. Una promesa bloqueada se observa, pero no se cancela ni se inicia otra ejecución superpuesta: hacerlo podría duplicar operaciones remotas.
- `/metrics`, autenticado con el token interno existente, publica disponibilidad, ejecución activa, último éxito y fallos consecutivos por loop. Nunca incluye mensajes de error del proveedor, PII o secretos.
- `service_heartbeat` con source `CHANNEL_LOOP_PROGRESS` conserva detalle de loops y status OK/BLOCKED. Su evidencia vence a los 45 segundos si deja de publicarse; la vista de preparación existente diferencia BLOCKED de STALE.

`/v1/readiness` usa el mismo evaluador de progreso que el resumen y el monitor operativo. Rechaza timestamps inválidos o futuros, heartbeat vencido y status distinto de OK. Para `CHANNEL_LOOP_PROGRESS` también vuelve a verificar el éxito reciente de los loops requeridos: un publicador activo no convierte un loop FAILED o detenido en saludable. Durante la publicación escalonada, los heartbeats anteriores conservan la validación de estado y frescura.

La preparación de cada cuenta REAL consulta su ownership persistido. Una lease ausente, vencida o con menos de dos segundos disponibles, un freeze explícito o `release_frozen` impiden marcar la configuración lista. Esto incluye Cloud porque pasa por el mismo gate del dispatcher. La vista SIMULATION declara este control NOT_APPLICABLE; no acredita control de una sesión REAL. La consulta respeta los IDs visibles del principal y no expone owner/generación, cambia autorizaciones ni libera mensajes.

El heartbeat de leases tiene un límite de progreso de 45 segundos; reconciliación, 60. Dispatch, observaciones, salud y operaciones, 180; medios, 300; comandos, 360. Los límites de medios/comandos permiten los lotes y timeouts del proveedor. Un fallo marca FAILED inmediatamente y se limpia sólo tras éxito. Los loops de preparación/grupos/descubrimiento se observan sin bloquear todo el worker comercial. Las métricas conservan su condición degradada.

Readiness no significa que todas las cuentas estén listas para vender: los controles por cuenta siguen verificando ownership, salud, autorización y estado comercial. Una cuenta aplazada o bloqueada no debe inutilizar a las otras. Si todas las filas de ownership están ocupadas, el loop puede completar sin renovarlas; el preflight y la alerta `SESSION_OWNER_UNAVAILABLE` siguen detectando su vencimiento. La lectura DB usa un presupuesto de 2 segundos que incluye adquisición de conexión y consultas. Si falla, se cierra esa conexión para cancelar su transacción; el presupuesto no representa un tiempo de respuesta HTTP garantizado si el event loop del proceso está bloqueado.

## Validación local del 27-sep

`channel-worker-progress.test.ts` prueba recuperación con reconexión deshabilitada, concurrencia, preservación exacta de grants, cero outbox, fencing de owner/generación, freeze, pausa, stop, archivo, retirada y filas bloqueadas. También verifica 503 con DB sana y heartbeat BLOCKED→OK usando el rol productivo `commerce_channel`. `channel-loop-monitor.test.ts` cubre trabajo bloqueado, no superposición, independencia, fallo, recuperación y evidencia sanitizada. `service-progress.test.ts` y `readiness-worker-progress.test.ts` comprueban la interpretación compartida y el resultado de la API ante un publicador fresco con trabajo fallido.

Las pruebas son locales con PostgreSQL aislado y proveedores falsos. No acreditan el estado de producción, recepción física ni entrega externa de alertas. No reiniciar procesos, transferir ownership o despachar efectos por el mero resultado de estas pruebas; seguir los controles de despliegue y recuperación existentes.
