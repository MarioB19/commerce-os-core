# V7 — Montaje gradual de consumidores SQL anteriores

2026-10-12. Preparación local, sin corte productivo.

Las rutas V1 revisadas como SQL materializado se registran con acción V7 y aliases
exactos definidos por código. El registro crea una marca opaca de servidor que
permite al hook global omitir únicamente la autenticación V1 de esa misma ruta;
la función registrada resuelve sesión/selección o PAT nativos dentro de la
transacción de perfil. Headers, URL o payload no pueden fabricar esa marca.
No se hereda la primera membresía ni se convierte un PAT en Owner.

Cada handler conserva su lógica de negocio, consultas y presentación. El ALS
redirige su pool al ejecutor real de la transacción; la respuesta materializada
se entrega después de confirmar COMMIT. El registro no acepta schema/serializador
posterior que pueda fallar después de confirmar una escritura. El primer conjunto
son las doce lecturas de lista/detalle de categorías, productos, ofertas,
materiales, flujos y vendedores. Se mantienen los filtros y nombres V1.

Las escrituras con autorizaciones múltiples, archivos, snapshots, diagnósticos y
proveedores requieren revisiones específicas. Los cinco flujos de I/O identificados
no deben recibir una transacción exterior: PREPARE, I/O y RECONCILE conservan sus
límites. Las rutas V1 todavía no clasificadas continúan como bloqueo explícito del
corte global y de publicación; este incremento no acredita una migración completa.

## Escrituras materializadas del catálogo

El siguiente incremento monta las escrituras SQL de categorías, productos,
ofertas, materiales (metadatos e intención de carga), flujos y vendedores, junto
con versiones, validaciones y configuración de ventas. Conserva los handlers,
CAS, idempotencia y auditoría. La carga/finalización de archivos y vistas previas
requieren otro límite de I/O y siguen fuera de este adaptador.

Cada registro fija el scope de su recurso y sólo su alias heredado. Crear un
producto con `initial_offer` exige además `offers:write`, validado sobre la misma
autoridad nativa bloqueada y el ejecutor vivo; el campo HTTP nunca elige un scope.
Una denegación invalida la transacción incluso si una capa captura la excepción.
Los handlers incluidos no cambian membresías, tokens ni selección: esos registros
permanecen bloqueados, y el límite exterior revalida autoridad y reloj antes de
COMMIT. La mutación y el recibo de idempotencia se confirman juntos; la respuesta
queda retenida hasta ese COMMIT. No se introduce wildcard ni PAT con rol implícito.
