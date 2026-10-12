# V7 — Perfil de worker con transacciones separadas

12-oct-2026. Preparación local; no scheduler montado ni migración productiva.
La transición 018 queda reservada para descubrimiento de perfiles de workers.

El ciclo recibe una selección emitida por el puerto SQL de descubrimiento. No
acepta un identificador obtenido de HTTP ni objetos reconstruidos por el caller.
Cada selección pertenece a una instancia del worker, a su rol y a su entorno;
su uso termina al cerrar ese ciclo. El puerto no concede SELECT global sobre
`profiles`: sólo devuelve id, estado y versión de hasta tres perfiles.

La selección no es un ejecutor SQL. Cada fase abre una transacción nueva con
`withProfileTransaction`, comprueba el rol nativo y bloquea la fila del perfil.
La versión y el estado ACTIVE deben coincidir con el descubrimiento; los cambios
requieren un ciclo nuevo. La autoridad se vuelve a comprobar antes de confirmar.
Sólo dentro de esa transacción se instala `withProfileQueryRouting`.

Así PREPARE confirma su INTENT antes del I/O, y la respuesta del proveedor se
reconcilia en otra transacción. Los helpers anidados dentro de una fase se unen
a la misma transacción; fuera de ella, una consulta del pool obtiene una fase
corta propia. Esto conserva el autocommit anterior de escritores de una sola
sentencia, ahora con RLS y perfil: no se interpreta todo SELECT como libre de
efectos ni se hace una transacción alrededor del ciclo completo. Los sitios con
varias sentencias atómicas siguen necesitando `withTransaction` explícito.

El pool de aplicación rechaza `connect` y métodos administrativos dentro del
ciclo. No hay fallback global, cambio de perfil, uso de selección ajena o uso
tardío. Las fases olvidadas sin await se drenan y rechazan antes del COMMIT. Una
fase que ya confirmó no se deshace por un error posterior del ciclo: su evidencia
durable obliga a conciliar, nunca a repetir automáticamente la llamada externa.

El mantenimiento que cancela efectos vencidos de perfiles suspendidos conserva
su puerto específico revisado; este núcleo operativo sólo admite perfiles ACTIVE.
El scheduler deberá ejecutar ese mantenimiento mediante una frontera separada,
antes de intentar un ciclo operativo. La política final RLS por entorno, el
catálogo exhaustivo de consumidores y los oráculos de I/O siguen siendo requisitos
de montaje. Este cambio no los afirma resueltos.

## Contexto SQL de entorno de la API

El adaptador HTTP fija `app.environment` dentro de las transacciones canónicas
de sesión/PAT, antes de entregar el ejecutor al handler. Una sola sentencia
comprueba el perfil y sólo permite el primer valor o el mismo valor ya fijado;
un intento de cambiar de entorno falla antes de ejecutar negocio. No sustituye
la comprobación de allowedEnvironments del token. Es la precondición para las
políticas RLS por entorno futuras; no afirma que ya estén instaladas.
