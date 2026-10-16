# V7 — Aislamiento global y bootstrap de identidad (020)

12-oct-2026. Preparación local, sin migración ni montaje nativos.

La transición final requiere inventario exacto del esquema completo 001–019 y
adopción de perfiles, roles y cuotas. El catálogo histórico de 68 migraciones
contiene 133 tablas y 174 FK; sirve para investigar, no sustituye ese inventario
nuevo ni acredita que todas las relaciones tengan perfil/entorno.

Se clasificará cada tabla como identidad global, datos compartidos por perfil,
datos de perfil y entorno, o hijo con identidad derivada de su padre autenticado.
Una tabla, FK, función privilegiada, vista o trigger no revisados bloquean el
cierre. Las referencias JSON necesitan validadores de consumidor explícitos;
no se consideran cubiertas por añadir FK a otras columnas.

El bootstrap de sesión necesita listar sus propias membresías y cambiar su
selección antes de fijar el contexto comercial. Se reemplaza ese acceso por dos
funciones SQL cerradas: reciben sólo la sesión ya validada por Better Auth y su
usuario; la selección además recibe el perfil explícito y la versión CAS. Nunca
eligen la primera membresía. Las funciones verifican otra vez la sesión nativa,
rol/versiones actuales y el reloj de PostgreSQL. Los locks de selección conservan
el orden sesión → contexto → membresía → perfil y duran hasta COMMIT. La lista
sólo devuelve los campos del selector de las membresías activas de ese usuario,
con límite de tres perfiles y comprobación de expiración al finalizar. También
bloquea las membresías y perfiles devueltos hasta COMMIT, de modo que una
revocación o suspensión concurrente no se confirma antes de esa frontera.

Las funciones son propiedad de un rol NOLOGIN/NOBYPASSRLS exclusivo, sin membresía
para los roles runtime. Ese rol tiene sólo las columnas y operaciones necesarias
para estos dos protocolos; las políticas específicas lo permiten. Su EXECUTE se
concede únicamente a commerce_api. Las aplicaciones conservan SELECT comercial
sólo dentro del perfil mediante las políticas de la transición final, sin volver
a dar un SELECT global a los workers o al pool de la API.

El componente bootstrap de 020 se prepara por separado del cierre de tablas
comerciales. Sus pruebas instalan RLS estricta en una base sintética y ejercen el
puerto real; no afirman que la política global esté completa. Los consumidores
históricos no se sustituyen hasta instalar el conjunto revisado. No hay fallback
al SELECT antiguo cuando falta una función o devuelve un error.

## Hijos históricos sin columnas de alcance

El componente de hijos deriva `workspace_id` y `environment` exclusivamente de
una FK padre fija revisada (18 tablas históricas). No infiere el perfil desde el
actor, el primer registro o un valor por defecto. Antes de alterar datos bloquea
las tablas afectadas y sus padres, rechaza huérfanos y exige que cada padre ya
pertenezca a un perfil adoptado. Conserva una comparación relacional exacta de
todas las columnas originales, incluidas duplicadas; no imprime sus contenidos.

Cinco tablas tienen triggers que impiden toda actualización. Dentro de la misma
transacción, y sólo bajo el migrador, se sustituye cada trigger exacto revisado
por una guarda temporal que permite únicamente rellenar las dos columnas nuevas
si antes eran nulas y todas las columnas históricas permanecen iguales. Se
restaura su definición original exacta antes de finalizar. No se usa DISABLE
TRIGGER ni un cambio general de `immutable_row`; un fallo revierte el componente.
Los triggers que permiten actualizaciones ordinarias permanecen activos.

Después del backfill se exige NOT NULL, FK compuesta a padre/perfil y una guarda
de inserción que deriva las dos columnas desde ese mismo padre bajo el contexto
vivo. Las actualizaciones no pueden mover la fila de padre, perfil o entorno.
Así los consumidores antiguos que omiten esas columnas siguen usando su padre
explícito y quedan sujetos a RLS. La política requiere ambos contextos y no
permite un SELECT global. Estas transformaciones son un componente local de020;
no autorizan una migración nativa ni sustituyen la auditoría de los otros FK,
funciones privilegiadas, tablas compartidas e identidad global.

## Referencias secundarias

`planProfileForeignKeys` prepara un delta a partir de un catálogo autenticado y
una clasificación completa explícita. Una tabla nueva, una columna de perfil
nula, una FK no validada o un hijo compartido que referencia datos de entorno
sin haber derivado su entorno bloquean la propuesta. No trata esas excepciones
como globales para hacer pasar la revisión.

La propuesta conserva todas las FK originales y añade una clave compuesta sólo
cuando falta perfil o entorno. Los nombres se derivan del contenido; una clave
del padre se comparte entre las relaciones que la necesitan. El SQL bloquea las
tablas y coteja el tipo y NOT NULL del contexto, además de las columnas y destino
de cada FK original antes de crear las nuevas. Todo ocurre en una sola sentencia atómica y no altera filas, elimina
restricciones, concede permisos ni deshabilita triggers. Un dato histórico
cruzado hace fallar la validación; su corrección necesita adopción aparte.

El catálogo incluye acciones, tipo MATCH y diferibilidad. Se conservan NO ACTION
o RESTRICT y el timing IMMEDIATE/DEFERRED de cada FK. CASCADE, SET NULL/DEFAULT,
MATCH FULL o metadatos de timing ausentes bloquean una ampliación hasta su
revisión específica: conservar la FK anterior no prueba por sí solo que una
segunda FK mantenga el comportamiento de borrado o el momento de validación.

Este generador es puro y su salida es una propuesta local. El catálogo completo
de las transiciones actuales, su clasificación, los puertos DEFINER y las
políticas siguen siendo requisitos separados de ejecución. Una prueba con dos
tablas sintéticas acredita el comportamiento de DDL/rollback del generador,
no una revisión del esquema comercial completo.

## Catálogo conjunto de preparación

El ensayo local de 12-oct instaló001–019 más bootstrap/hijos020 en una sola
transacción:169 tablas,285 FK y28 funciones DEFINER. Conservó los hashes de68
migraciones históricas y no creó perfiles, credenciales, metas ni concesiones.
El lector convierte arrays nativos `name[]` a `text[]` antes de entregarlos a
node-pg; no confunde una cadena de catálogo con una lista de columnas/roles.

Nueve casos PostgreSQL comprueban DDL atómico, rechazo de drift de tipo/nulabilidad
y timing, conservación de filas/constraints y validación diferida hasta COMMIT;
cinco casos adicionales ejercen el catálogo conjunto. Los originales y sus
hashes están referidos en `docs/evidence/v7-profile-fk-catalog-20261012.json`.
La clasificación y las nuevas021/022 requieren cierre posterior; este recibo no
convierte el esquema de ensayo en un inventario de datos nativos.


## Custodia de sesiones y recibos de aislamiento

Las dos tablas históricas `session_ownership` y `ownership_isolation_receipts`
conservan perfil pero no entorno. El componente siguiente deriva el entorno
exclusivamente del `channel_account` exacto existente y del perfil ya adoptado.
Una cuenta ausente, otro tipo de registro o un perfil divergente abortan toda la
transacción; no se asigna REAL por defecto. `account_id` textual se conserva
byte a byte y se acompaña de un UUID generado para la FK compuesta, con igualdad
canónica al identificador original.

Se comparan todas las columnas históricas antes y después, se conservan los
consumos, generaciones, freezes y leases, y se añaden claves compuestas, RLS
forzada y una guarda de contexto/identidad para las inserciones y actualizaciones.
Las lecturas y escrituras siguen necesitando el WorkerScope autorizado; el
backfill de columnas no concede control del canal ni permite enviar mensajes.

## Puertos de lectura privilegiados históricos

El siguiente componente 020 conserva las firmas de los lectores de autorización
temporal y de aislamiento de origen, pero exige que los argumentos coincidan
con `app.workspace_id` y `app.environment` antes de consultar o bloquear filas.
El segundo puerto sólo admite REAL. No crea aprobaciones ni recibos. Los cuerpos
históricos y sus ACL se autentican antes del reemplazo, en una única transacción;
un cambio previo o un rol propietario ya existente hacen fallar el componente.

Cada función pertenece a un rol NOLOGIN dedicado, sin membresías de runtime,
sin propiedad de tablas y con columnas mínimas de lectura y bloqueo. Las ACL
de llamada no se amplían. Las políticas de sus propietarios respetan el contexto
actual; no otorgan SELECT de membresías a los workers. La autorización temporal
se vuelve a comprobar con el reloj de PostgreSQL después de adquirir el lock.
El aislamiento conserva todos los predicados históricos y bloquea sus vínculos
de desafío, sesión, cuenta y membresía antes de la comprobación final de tiempo.

Esto prepara dos puertos para el corte completo. No sustituye la adopción de
perfiles, el montaje WorkerScope ni la clasificación de las demás funciones
DEFINER. Dieciséis casos PostgreSQL locales pasaron con datos REAL/SIM y perfiles
distintos, roles restringidos, revocación y vencimiento durante espera, además
del rechazo de drift, replay y ACL incompleta sin reintroducir permisos. El recibo
`docs/evidence/v7-profile-privileged-read-scopes-20261012.json` conserva los hashes
de fuentes y originales; no acredita montaje ni migración nativa.

## Inventario Meta e idempotencia histórica

`meta_syncs` tiene un contrato histórico exclusivamente REAL: fuente META_API,
links REAL y endpoint que rechaza SIMULATION. Su entorno será una columna
constante generada, con contexto REAL obligatorio al insertar y RLS por perfil;
no se ejecutará un UPDATE que desactive su evidencia inmutable. Se comprobarán
perfiles, contenido/fuente, vínculos y equivalencia de todos los campos previos.

La respuesta de `idempotency` no permite inferir siempre el entorno: puede estar
cifrada, ser un tombstone o no incluirlo. El componente exige una tabla temporal
propiedad del instalador con una adopción explícita por cada clave histórica,
hash SHA256 nativo de la fila completa y hash de evidencia protegida que sustenta
su entorno. Faltantes, duplicados, extras, otra fila o perfiles sin adoptar hacen
fallar toda la transacción. El operador nativo deberá autenticar esos originales;
el SQL no transforma un hash declarado en prueba de contenido externo.

Se conservan las claves originales y cada valor anterior; la clave primaria no
se amplía para permitir repetir una operación antigua en otro entorno. Nuevas
filas ligan entorno al contexto transaccional exacto, nunca al cuerpo de respuesta.
La referencia de adopción histórica es inmutable y no puede fabricarse mediante
el INSERT de runtime. RLS protege lecturas y escrituras; el corte nativo y la
retención DEFINER deberán usar el mismo contexto antes de activar consumidores.

Dieciocho casos PostgreSQL locales pasaron con metadatos sintéticos, respuestas
cifradas/tombstone y roles restringidos. Verifican conservación, rechazo del mapa
incompleto o divergente, lecturas cruzadas, enlace de contexto y replay. El recibo
`docs/evidence/v7-profile-meta-idempotency-scopes-20261012.json` liga fuentes y
originales; la revisión independiente leyó los componentes y casos sin repetir PG.

## Pausas globales y controles de registro

`manual_controls` mezcla un stop global del perfil con controles de cuenta,
conversación, contacto y workflow. Los segundos derivan su entorno únicamente
del registro exacto (incluido tipo), bajo lock y FK compuesta. La clave textual,
los flags de pausa/opt-out/takeover, versión, actor y razón se conservan; un
huérfano o perfil ausente bloquea el componente. No se normalizan UUID históricos.

El stop de perfil mantiene su alcance global de seguridad y se ve en REAL y
SIMULATION dentro de ese perfil. Se representa con entorno NULL exclusivamente
para `scope_type=workspace` y `scope_id=workspace_id`; eso no es una excepción
para controles comerciales. Cambiarlo exige contexto REAL: un ensayo SIMULATION
no puede reanudar o modificar la pausa que protege tráfico REAL. Los permisos
humanos y la autoridad V7 del endpoint siguen siendo requisitos adicionales.
No se renombra ni elimina la clave primaria, ni se concede un permiso nuevo.

Este componente requiere clasificación especial en el catálogo global: la
columna entorno es nullable sólo para el stop de perfil revisado. No debe pasar
por un generador que suponga NOT NULL uniforme ni convertir todos sus datos en
compartidos. Las fixtures legacy que cambian el stop global desde SIMULATION
necesitan una preparación REAL explícita; no se admite un fallback al patrón viejo.

Catorce casos PostgreSQL locales verificaron la conservación y estas fronteras,
con lectura independiente del componente, fixture y restricciones históricas.
El recibo `docs/evidence/v7-profile-manual-control-scopes-20261012.json` liga
fuentes y originales; no prueba todavía consumidores montados ni corte nativo.


## Claves entre esquemas revisados

El puente021 introduce una FK de `public.ai_attempts` a
`commerce_number_lab.ai_bindings`. El catálogo de sólo tablas públicas no basta
para evaluar esa relación. La lectura de metadatos ahora conserva columnas y FK
de todas las tablas no públicas dentro de la misma instantánea, sin consultar
filas. El planificador exige que coincidan exactamente con el inventario de
relaciones y que cada tabla tenga clasificación explícita `schema.table`.

Se aplican los mismos predicados de perfil, entorno, validez, acciones y timing
a ambos sentidos de referencia. Un nombre de columna como `budget_environment`
se declara expresamente; nunca se cambia REAL por SIMULATION ni se declara global
un destino desconocido. El SQL cita ambos identificadores, bloquea ambas tablas
y revalida el esquema y columnas de la FK original antes de añadir restricciones.
No retira ni cambia una FK previa. Esta extensión sigue siendo un generador de
propuestas locales; no adopta políticas ni aplica DDL en la base nativa.
