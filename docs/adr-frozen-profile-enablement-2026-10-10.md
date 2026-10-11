# Habilitar un perfil conservado bajo congelamiento

Fecha: 2026-10-10. Decisión previa a la implementación; publicación pendiente.

El PUT de integraciones rechaza una habilitación sin cambios cuando la cuenta
conserva un estado histórico WORKING, aunque su sesión esté detenida, pausada y
con ownership congelado. Consultar salud o desconectar con el perfil deshabilitado
no resuelve ese estado: el proveedor exige un perfil habilitado. No se corregirá
el estado almacenado por SQL ni se repetirá el intento fallido como si hubiera
tenido éxito.

Se permite una excepción estrecha al guard de desconexión: un perfil WAHA/Cloud
REAL existente pasa de disabled a enabled con la misma revisión, etiqueta y
configuración, sin secretos enviados ni eliminados. La política ya debe conservar
dispatch_frozen=true, real_sends_enabled=false y allow_real_operations=false.
Todas las cuentas asociadas deben tener sending_enabled=false, sesión no
archivada STOPPED/paused/recovery=false, ownership congelado y sin lease vigente,
sin lectura de salud en curso, comandos pendientes o inciertos ni efectos
SENDING/UNKNOWN, media pendiente, pools de grupo activos o consultas de número
no terminales. La transacción y los bloqueos canónicos conservan CAS e historial.
Los valores y metadatos de secretos no cambian; el guardado existente vuelve a
cifrarlos para la nueva revisión, como exige su contrato.

No basta con modificar el PUT: collectHealth actualmente consulta también las
sesiones detenidas. El segundo cambio excluye de la selección automática sólo
perfiles REAL habilitados cuyas sesiones estén STOPPED/paused/recovery=false y
ownership congelado, bajo la misma política comercial congelada. No reclama una
plaza de lectura ni escribe salud. SIMULATION, los demás lectores elegibles y el
check_health explícito con sus pruebas de ownership permanecen sin cambios.
Esta exclusión no afirma salud ni autenticación y no habilita envíos.

Las pruebas deben acreditar habilitación conservadora con estado histórico,
preservación de cuentas/sesiones/ownership/secretos e idempotencia; rechazo de
rotaciones, cambios de configuración, actividad e incertidumbre; y cero llamadas
automáticas al proveedor, sin impedir lecturas normales o SIMULATION. El rechazo
debe dejar intactas las revisiones. No se cambia el esquema, el contrato B02 ni
el presupuesto. El nuevo SHA requiere validación y publicación canónicas y
continuidad de respaldo/restore; los recibos del intento original se conservan.

La revisión de permisos encontró que `commerce_api` no puede leer
`consumer_receipts`. La guarda usa los eventos terminales del consumidor de
medios: `channel.media.stored` o `channel.media.download_failed` con
`terminal=true`, vinculados por causación, cuenta, workspace y entorno. El
consumidor escribe ese evento y su recibo `media-v1` en la misma transacción;
ningún otro productor operativo escribe ese recibo. Un fallo no terminal no
libera la guarda. Se conserva el esquema y se prueba el HTTP completo con el rol
`commerce_api`, incluidos sus bloqueos de filas y la falta de acceso a recibos.
