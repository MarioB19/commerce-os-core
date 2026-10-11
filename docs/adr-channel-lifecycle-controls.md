# Controles de conexión y desvinculación — 07-sep-2026

El error `QR_OPERATION_NOT_AUTHORIZED` se produce cuando la revisión operativa tiene `allow_channel_onboarding=false`. El worker aplicaba ese permiso tanto a conectar/reconectar como a detener/cerrar la sesión. Además, el monitor de comandos descartaba el mensaje y la acción correctiva ya disponibles.

La preparación de canales seguirá siendo obligatoria para conectar, reconectar y obtener QR. Desconectar y desvincular podrán reducir la actividad con la preparación deshabilitada, conservando permisos de usuario, aislamiento de gateway, ownership y fencing. La API pausará el número antes de encolar ambas acciones. Desvincular se expondrá con confirmación y eliminará la identidad verificada después del cierre de sesión confirmado; requerirá un nuevo QR para volver a vincularse. No borra conversaciones, ventas ni eventos.

El monitor mostrará el mensaje y la acción correctiva sanitizados del worker, con el código como referencia secundaria. El fallo de autorización anterior a la llamada remota no se interpretará como una desconexión observada.

Validación prevista: PostgreSQL aislado para bloqueo de conectar/reconectar, desconexión/desvinculación con onboarding apagado, permisos y aislamiento; pruebas de interfaz con API sintética para mensaje accionable y confirmación. Ninguna prueba vincula teléfonos o envía mensajes reales.

## Eliminación desde la interfaz

Brandon solicitó una interfaz para borrar números. `DELETE /v1/channel-accounts/:id` marcará el número como eliminado y lo retirará de los selectores operativos. La lectura histórica directa y las relaciones con conversaciones, ventas y eventos se conservan. La confirmación muestra esta consecuencia.

Sólo se elimina un número detenido, sin comandos pendientes ni despachos en curso o inciertos. WAHA requiere desvinculación confirmada si llegó a tener ownership. Los números recién creados pueden eliminarse sin crear una sesión. La eliminación pausa controles, congela ownership, revoca alcances que incluyan el número y bloquea nuevos comandos, QR, activación, despacho e ingreso. La reserva del gateway se libera únicamente después de cumplir estas condiciones. Un nuevo registro recibe un ID nuevo. No se eliminan credenciales de la conexión compartida.
