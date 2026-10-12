# Cancelación de efectos vencidos antes del despacho

12-oct-2026. D-01 exige cancelar con registro sin enviar. El gate de despacho
puede detenerse antes del vencimiento por un perfil suspendido, una cuenta
retirada o una pausa; por ello la cancelación usa un recorrido de mantenimiento
separado, dentro de la transacción del perfil y con rol channel restringido.

Sólo considera REAL, con reloj PostgreSQL, estado READY/BLOCKED, cero intentos,
sin claim ni identificador del proveedor y sin antecedentes de intento distintos
de NOT_SENT. Un resultado incierto conserva sus barreras y exige conciliación.
Los registros SIMULATION conservan su reloj virtual. Un timer vencido no se
infiere de due_at: ese campo expresa cuándo ejecutarlo, no hasta cuándo es válido.

El lock de outbox con SKIP LOCKED excluye un claim concurrente. Estado terminal,
proyección de remarketing y evento se confirman juntos; repetir la tarea después
de perder una respuesta no genera otro evento. Se conserva el resultado previo,
la fecha de vencimiento y el hecho de que no hubo intento externo. No se modifica
ninguna autorización histórica ni se devuelve cuota consumida o reservas de rate.
La tarea se monta antes del dispatcher cuando exista el WorkerScope definitivo;
guardar este módulo no acredita su instalación en producción.
