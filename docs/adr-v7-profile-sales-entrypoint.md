# V7 — Conversaciones y decisiones comerciales en el perfil seleccionado

La entrada comercial conserva los handlers SQL de conversaciones, pedidos,
comprobantes y comandos, registrados con una acción fija de perfil. La sesión
020 o el PAT nativo resuelven perfil, rol y entorno; la respuesta se materializa
antes del COMMIT y sólo se entrega después. No existe selección por primera
membresía ni elevación de PAT. Las lecturas de pedidos/comprobantes respetan el
rol V7 de solo lectura; la restricción histórica permanece en rutas históricas.

La conversación incluye mensajes, contacto y contexto comercial. Los pedidos y
ofertas anidados requieren sus acciones de lectura adicionales en la misma
transacción. Un token limitado puede usar la lista o las lecturas separadas sin
recibir campos de otro dominio por una autorización implícita.

Las decisiones usan el comando e idempotencia canónicos: aceptar un comando no
equivale a aplicarlo ni a enviar un mensaje. En el puerto de perfil, send_message
rechaza authorization_id y conserva la intención sin buscar una autorización
temporal. El worker V7 resuelve continuidad, pausa y todos los gates existentes
antes de proponer/emitir el efecto. El handler histórico conserva su contrato de
autorización temporal mientras se ejecuta el retiro previsto por F8.

La lectura de una operación incierta se liga al actor nativo, recurso, tipo de
operación, perfil, entorno y UUID original. Sólo una ausencia canónica explícita
permite al consumidor proponer el mismo UUID; no hay retry automático. Los
archivos de comprobantes y mensajes requieren un puerto con SH y fases separadas
antes de montar su I/O. Este incremento SQL no certifica ese montaje, los workers,
el corte global, ni una acción real de venta.


## Consumidor de sesión y entrada web

La navegación del perfil monta Conversaciones, Pedidos y Comprobantes bajo Ventas.
El cliente fija la selección, la versión de selección y las rutas; no acepta
origen, bearer, proveedor ni autorización temporal. El transporte acota tiempo y
respuesta y conserva una única petición por acción. Los controles y comprobantes
usan los comandos existentes; PENDING no se presenta como mensaje enviado ni
como revisión aplicada. La consulta posterior puede actualizar su estado sin
volver a mutar.

El navegador conserva sólo actor/perfil/entorno, recurso, tipo, UUID y SHA-256 del
cuerpo canónico; no persiste mensajes, motivos, respuestas ni datos del cliente.
Ante un resultado incierto, toda acción posterior requiere consultar la operación.
Sólo el 404 con error SALES_OPERATION_NOT_FOUND exacto del puerto de conciliación
permite reenviar, explícitamente, el mismo UUID y los mismos datos. Tras recargar,
el usuario vuelve a introducir el cuerpo; su hash debe coincidir. Una respuesta
POST confirmada cuyo recibo desaparezca no habilita reenvío. La selección nueva
aborta solicitudes y descarta resultados tardíos; cada perfil conserva sólo sus
propias referencias pendientes. Los roles de lectura y perfiles suspendidos no
muestran formularios de escritura; el servidor vuelve a comprobar la autoridad.

El estado durable de outbox.cancel es 202, aunque su handler HTTP histórico retorna
200. La consulta de recuperación autentica el estado durable; una regresión real
cubre cancelación, idempotencia y lectura del comando original.

Validación: 34 PostgreSQL/HTTP con createApp y rol LOGIN restringido sobre 43
componentes reales más RLS, incluidos ámbito, PAT, CAS, expiración y cancelación;
el adaptador de cookie es sintético. Las pruebas del navegador montan el componente
real con respuestas loopback sintéticas. Archivos/adjuntos, emisores y consumidores
worker, mejoramiento del listado SQL y otras familias V1 permanecen por montar;
este incremento no acredita envío real ni el corte final de V7.
