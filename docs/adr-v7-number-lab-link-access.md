# RF19 — Entregas link/access restringidas al laboratorio

Diseño previo, 12-oct-2026. Incremento siguiente al transporte canónico de
texto/archivo. Implementación local en verificación; no hay montaje acreditado.

El laboratorio conservará el tipo y la versión de cada material capturado. Un
broker privado autenticará el registro y su versión REAL desde la configuración
fijada del run. La salida será un descriptor cerrado LAB_ONLY ligado al run,
variante, asset remapeado y hash de fuente. No tendrá URL externa, código de
acceso REAL ni configuración de proveedor seleccionable por una acción pública.
La lectura del origen y del namespace usará la custodia compartida con D18 y
ocurrirá fuera de una transacción larga del motor.

Un link se representa mediante una ruta interna de prueba ligada al descriptor.
Su handler de lectura y la entrada UI siguen pendientes de montaje. Un access
mantendrá dos efectos canónicos: concesión simulada y notificación dependiente.
La concesión conservará un recibo cifrado con clave LAB y su identidad durable;
la notificación sólo podrá abrir ese recibo con el mismo run, efecto, material
y conversación. No invocará webhook, portal, adaptador de fulfillment REAL ni
proveedor seleccionado desde un documento. No se presentará ese recibo como
acceso concedido a un portal real.

La materialización validará exactamente el conjunto de archivos y descriptores
antes de READY. No usará un archivo falso como sustituto de link/access. Cualquier
tipo sin adaptador se mantendrá pendiente con diagnóstico específico. La ruta
comercial predeterminada, sus secretos y su proveedor permanecerán en la
implementación canónica compartida y no cambiarán de comportamiento.

Las pruebas deben acreditar bindings cruzados rechazados, versión REAL alterada,
cifrado/AAD inválido, grant incierto sin repetición, notificación causal y cero
acceso HTTP. El controlador UI no abrirá destinos externos para fingir paridad.
La fidelidad del flujo y sus estados se acreditará por separado de la existencia
o disponibilidad de un portal remoto.

La proyección canónica conserva su consulta y transacción. Sólo en el puerto LAB
revalida descriptor, receipt cifrado y predecesor dentro de esa misma transacción
para mostrar el enlace interno cuando la entrega está SENT/DELIVERED/READ.
UNKNOWN no se presenta como acceso disponible. El camino REAL no incorpora
esta proyección y las aserciones anteriores permanecen intactas.

Verificación local: 94 pruebas host, tipos/lint y39 PostgreSQL PASS. Peer Restore
leyó el delta completo y ejecutó94 host independientes. El primer ensayo quedó
38/39 por preparación UNKNOWN sin GUC; se conserva y la única corrección fue
el contexto nativo del fixture. Cinco contenedores y65 volúmenes previos quedaron
exactos. No se ejecutó proveedor externo ni se montó la ruta de lectura/UI.
