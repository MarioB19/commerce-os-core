# RF19 — driver canónico y recibos de operación

Decisión previa, 12-oct-2026. El factory privado fija control, seed, runtime,
identidad instalada, clave de control y broker de materiales. Su entrada pública
contiene sólo perfil, run y operación. Después del COMMIT del materializador,
relee acción y snapshot autenticados desde el control INTENT; nunca recibe un
comando, executor o selector de entorno del cliente.

La acción se convierte en un comando canónico en la base aislada. Creación de
simulación, inbound y avance de workflow siguen sus funciones existentes. La
selección consulta el resolvedor F4 sobre el snapshot capturado y verifica el
remapeo resultante. Cada acción y su recibo ACTION_APPLIED cifrado se confirman juntos; el resultado identifica si produjo un comando canónico. Una selección sola no inventa texto. Si falta selección, se conserva un mensaje pendiente en la base aislada protegida y no se pierde su operación original. La
ejecución posterior de timers/workflows tiene un recibo SETTLED; no se simula una máquina
de estados comercial nueva. Un recibo de comando no acredita respuesta de IA,
entrega, comprobante ni el reporte automático completo.

Los recibos nativos son inmutables, ligados a ejecución, snapshot, hash de acción
y etapa. Una repetición no aplica el comando: sólo devuelve observación. Tras un
ACK perdido se consulta la etapa persistida; la conciliación explícita puede
cerrar el control con progreso parcial, pero nunca repite comandos, IA ni efectos.
Antes del settlement se cierra la ejecución del motor bajo su lock, impidiendo
que otro lease reutilice el intento antiguo. El recibo conserva el run_state para
reconciliar una respuesta perdida sin reinterpretarlo desde el estado actual.

Este incremento conecta acciones de texto/selección/reloj/continuación. Los
adjuntos, extracción IA, transporte de prueba y ejecución automática son fases
posteriores autenticadas; su ausencia queda en resultados como dependencia,
sin aprobar escenarios incompletos ni cambiar el vendedor a deterministic.
No monta rutas, credenciales, egress, procesos ni almacenamiento productivo.

El inicio produce un evento canónico nuevo `number.flow_test_started` causado por
la operación de control y enlaza las asignaciones remapeadas leídas nativamente.
No reconstruye un evento antiguo ni atribuye aprobación humana. El lector MCL que
inbound consulta antes de ligar la simulación recibe sólo una proyección RLS
siempre vacía, sin permiso de escribir ni recuperar autoridad histórica. Los
gates originales de aislamiento y clasificación siguen ejecutándose.

Las precondiciones conocidas de una acción se cierran con resultado FAILED y
DEPENDENCY_REQUIRED, sin comando. En particular, continue/advance sin una
conversación previa conservan el reloj y permiten enviar después el primer
mensaje. No se convierten en incertidumbre de transporte ni requieren una
intervención manual sobre el control. Los fallos de una transacción canónica
siguen preservando INTENT y sus originales para diagnóstico.

La autoridad del control se conserva durante cada fase SQL del motor dedicado:
primero se adquieren FOR SHARE de perfil/run/operación y luego comienza la
transacción del motor. El puerto privado fijado en el factory revalida el reloj
nativo del control antes del COMMIT del motor; sus locks se liberan después de
ese COMMIT. Una suspensión que gana antes impide la fase, y una concurrente
espera hasta terminarla. Este puerto no se selecciona desde HTTP ni desde una
acción, no altera el kernel comercial y no sostiene una transacción durante
copia de materiales ni llamadas de proveedor. Una lectura posterior a COMMIT
no pretende revertirlo; una pérdida de ACK se concilia desde el recibo nativo.
