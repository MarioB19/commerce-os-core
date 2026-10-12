# ADR V7 — Borrado verificable y contexto financiero

12-oct-2026. Complementa022 y D-18; no acredita borrado en producción.

El borrado debe preservar las contribuciones ya proyectadas sin depender del
texto ni de las relaciones de cliente. Se ejecutará por perfil, mediante un
job privado con política vigente, fuente inmovilizada, respaldo restaurable y
comprobación de ausencia de obligaciones, retención legal y efectos pendientes.
El plazo comercial se cuenta desde cierre, nunca desde una edición incidental.

Cuando existe un pedido o comprobante,024 conserva el contexto mínimo necesario
para las correcciones financieras durante la retención separada de cinco años:
fecha de inicio/respuesta y dimensiones comerciales, indicadores observados y
una identidad técnica del recorrido. Su forma cerrada no admite texto, teléfono,
contacto, prompt, contenido de mensajes ni datos del comprador. No es un archivo
de conversaciones. La relación técnica queda privada y no forma parte de los
agregados públicos; el ledger financiero conserva su finalidad y plazo propios.

Ese contexto se captura en la misma transacción que el borrado futuro, con
versión y fingerprint de fuente comprobados. No sustituye una captura distinta
ni usa configuración actual del producto para reescribir la historia. Mientras
la conversación existe, manda su evidencia; después del borrado, el contexto
reemplaza únicamente las dimensiones y etapas estáticas. Comprobantes aprobados,
parcialidades, FALSE/TEST y fecha de primera venta siguen calculándose desde el
ledger retenido. Esto permite corregir importes y denominadores sin recuperar
contenido del chat. El contexto no es permiso para efectuar el borrado.

Las conversaciones sin historia financiera sellan las contribuciones de cohorte,
financieras vacías y uso IA antes de borrar; la deduplicación impide replay.
Las que tienen historia financiera mantienen fuentes anónimas revisables hasta
el vencimiento financiero para no congelar una clasificación que pueda corregirse.
Los agregados se reconstruyen desde esos sellos y fuentes vigentes, no desde el
contenido borrado. El restore debe reaplicar el registro de borrados antes de
reabrir lectura o proyección; una fuente reaparecida no autoriza duplicar métricas.

El siguiente incremento implementa primero el contexto y verifica correcciones
posteriores con un stub sintético. Sólo acredita la independencia de métricas.
El gate PAY-RETENTION sigue abierto hasta eliminar y comprobar todo el contenido,
versiones, mensajes, snapshots, adjuntos, copias derivadas y cachés de la operación,
con fencing de escritores, retención de obligaciones y readback de almacenamiento.

025 acredita el cierre mediante comando canónico APPLIED, evento y versión del
registro confirmados en la misma transacción. Usa el reloj de PostgreSQL; una
fecha escrita en el body o un workflow FINISHED no inician el plazo. Exige el
historial continuo1..versión actual, identidad de cierre intacta y ausencia de
reapertura posterior. Una edición incidental no reinicia el plazo. El kernel
de admisión fija30/180d,90dlogs y5años financieros; autoridad, obligaciones,
hold legal, fuentes pendientes, inventario, proyección y backup restaurado son
condiciones independientes, no parámetros que el solicitante pueda omitir.

La constancia mínima privacy_closure_receipts conserva versión, fecha DB y hashes
de evidencia, sin texto, contacto, teléfono, actor ni motivo. Sólo el owner
privado puede insertarla desde evidencia autenticada; la API no puede fabricarla.
Debe capturarse antes de purgar los logs90d. Después, la prueba valida esa
constancia contra el historial de conversación restante, sin leer los logs.
Un cierre distinto o una reapertura no reutilizan el recibo anterior. El job de
captura periódica y la purga todavía deben instalarse y verificarse; implementar
esta constancia no acredita esos pasos ni la eliminación de contenido.
