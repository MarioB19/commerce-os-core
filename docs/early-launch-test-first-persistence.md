# Ensayos propios TEST desde la primera conversación

Un ensayo declarado antes de la entrada se clasifica al crear su conversación,
antes de crear mensajes o pedidos y antes del primer tick de workflow. Reportes
excluye esa conversación y sus contactos, pedidos, comprobantes y touchpoints,
también cuando el espacio está pausado. Se mantiene el filtro de órdenes TEST
para registros anteriores.

La clasificación requiere una ruta resuelta y un scope activo con workspace,
ambiente, cuenta, oferta y contacto exactos. Reutiliza los campos
`commercial_classification`, `launch_test_scope_id`, `launch_test_role` y
`analytics_excluded_from_creation`; no añade una tabla o permiso de envío. Dos
scopes coincidentes provocan rollback de la transacción. Una ruta sin oferta
exacta o de historial importado no recibe esa clasificación.

La declaración y la primera creación usan el mismo bloqueo de cuenta. Inbound
conserva el orden chat → cuenta; una declaración pendiente se confirma antes de
clasificar el primer INSERT. El endpoint de scope rechaza una conversación OPEN
ya persistida para la misma cuenta, oferta y contacto, incluso sin pedido.

Una conversación clasificada TEST mantiene su exclusión histórica cuando el
scope expira o se revoca; el pedido posterior conserva el mismo vínculo exacto.
Eso no autoriza efectos: el guard de scope activo sigue siendo obligatorio al
despachar. Una conversación previa sin clasificación, incluida una CLOSED que
el router reutiliza, no se convierte retrospectivamente en TEST. El matcher
compara su fecha canónica en PostgreSQL; el draft inicial usa el reloj del
servidor después del bloqueo, evitando pérdida de precisión en fechas JS.

El receptor propio debe ser inequívoco y el recorrido nuevo debe ser elegible.
El scope no cierra, borra ni importa conversaciones anteriores. Registrar TEST
no inicia gateways, workers, autorización comercial o mensajes.

La regresión vive en [mcl-launch-api.test.ts](../tests/integration/mcl-launch-api.test.ts):
primer inbound con workspace pausado y sin pedido/outbox, ambigüedad con rollback,
cuenta/oferta/contacto/ambiente incorrectos, ruta sin oferta, declaración tardía,
expiración/revocación, CLOSED reutilizado y carrera de declaración. Se conserva
el caso de pedido que espera un scope nuevo, comprobando que no reclasifica su
conversación anterior.

La fixture de [commercial-configuration.test.ts](../tests/integration/commercial-configuration.test.ts)
declara los dos scopes antes del inbound compartido y comprueba la primera marca
TEST; mantiene aislamiento de cuentas, pedidos, timers, outbox, atribución y
baja global. La verificación local focal aprobó 74 pruebas de ocho suites,
además de tipos y lint, con PostgreSQL y llaves sintéticas aislados.

Las pruebas locales no demuestran publicación ni una entrada física WhatsApp.
El [procedimiento de publicación](publishing-changes.md) exige el CI/CD del commit
final y readback del comportamiento instalado.
