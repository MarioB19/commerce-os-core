# V7 F2 — perfil explícito y aislamiento de datos

Decisión registrada antes de implementación, 11-oct-2026. Adopta el ADR-V7-02 del
vault y el alcance F2. Trabajo aislado desde `80a6d6e`; no acredita instalación.
La producción requiere el cierre F1, integración F0 y el CI nativo del commit.

## Identidad y migración

`profiles.id` conserva exactamente el `workspace_id` textual existente; no se
convierte a UUID ni se crea una tabla `workspaces`. Los nuevos perfiles tendrán
ID generado por el servidor. El inventario previo consulta el catálogo real,
clasifica cada tabla como identidad global, plataforma o dominio de perfil y
recoge claves foráneas, políticas, funciones privilegiadas y roles. Una tabla o
relación desconocida impide aceptar el inventario. El informe no incluye filas,
correos, tokens ni contenido comercial.

Los hijos sin tenant reciben el tenant de su padre inequívoco. Una contradicción
bloquea la migración; no se escoge un padre arbitrario ni se borra evidencia.
Las FK privadas incorporan tenant y claves existentes. Los índices/IDs, dinero,
conversaciones, pausas y escritor de cada tabla se conservan. D-23 se decide con
el inventario real de seller/reconciler inmediatamente antes de la migración:
presencia implica Operador; ausencia conserva su mapeo anterior. No se inventan
conteos ni se modifica una migración histórica.

## Contexto de ejecución

Cada acceso comercial usa un executor ligado a un único perfil y a una
transacción PostgreSQL. Se instala `app.workspace_id` con
`pg_catalog.set_config(..., true)` después de BEGIN, equivalente parametrizado
a SET LOCAL. El executor no expone conexión, release ni cambio de perfil.
Se invalida al terminar; no puede reutilizarse desde un callback tardío. Commit,
rollback y liberación se centralizan. Un rollback fallido descarta la conexión.
Las pruebas comprueban separación concurrente, errores y reutilización del pool.

La primera pieza se añade como API explícita sin cambiar todavía el pool legado.
La activación de FORCE RLS y su integración se entregan sólo después de adaptar
lecturas, mutaciones, autenticación, workers, archivos, exports y recuperación.
No se declara aislamiento efectivo por añadir un helper sin consumidores.

El contexto de perfil no concede membresía. Autenticación resuelve usuario y
membresía vigente; autorización intersecta alcance del token, membresía y acción.
La sesión interactiva conserva selección por sesión. PAT/MCP permanece ligado a
un perfil y rechaza cambios por argumento, header o cookie. Identidad global y
enumeración de IDs de trabajo usan interfaces separadas, explícitas y de mínimo
privilegio; no reciben acceso genérico a contenido multitenant.

## Política de base y compatibilidad

FORCE RLS, USING y WITH CHECK protegen cada tabla de dominio. Ausencia de contexto
niega acceso. Ningún runtime es propietario ni tiene BYPASSRLS; se conservan
`WRITE_OWNER_*`, funciones de escritura y controles de concurrencia actuales.
Las funciones SECURITY DEFINER se registran en inventario y se revisan con search_path fijo antes
de permitirlas. El catálogo ejecutable comprueba tablas nuevas y permisos, para
que un cambio futuro no omita aislamiento silenciosamente.

Los loops enumeran únicamente IDs/límites de perfiles elegibles y trabajan dentro
de un perfil por transacción, con cuotas y fairness. No se mantiene una conexión
abierta mientras se espera a un proveedor externo. Claims, leases/fences e
idempotencia siguen siendo durables y un envío incierto no se reintenta.

## Verificación y límites

Las pruebas unitarias de contratos no sustituyen PostgreSQL con roles reales.
La suite de DB verifica contexto ausente, dos perfiles, FK cruzadas, cascadas,
funciones privilegiadas, rollback, pool reutilizado y writers separados. API/UI/
MCP/files/jobs deben coincidir en permisos, incluido rol degradado y token revocado.
Se ensaya migración/restore en copia aislada antes de migrar datos comerciales;
PAY compara IDs/conteos/montos reales antes y después. Rollback lector compatible
conserva RLS. No se crean otra VM, invitaciones ni envíos reales para estas pruebas.

## Roles y credenciales V7

Los identificadores internos conservan `owner`, `operator` y `viewer`, mostrados
como Dueño, Operador y Solo lectura. El catálogo de scopes será cerrado y común
para UI/API/MCP. No se acepta wildcard en un PAT. Dueño administra empleados,
credenciales y perfil; Operador conserva catálogo, atención, revisión de pagos y
números; Solo lectura no recibe exportación masiva ni mutaciones. Los scopes de
plataforma forman un dominio distinto y no entran en un token de perfil. La
seguridad de la cuenta propia sigue disponible para Solo lectura y para un
perfil suspendido; esto no concede ninguna mutación comercial.

La comprobación determinista recibe membresía/credencial/perfil leídos por el
servidor, vuelve a comprobar usuario, perfil, estado, vencimiento y versión de
membresía y exige cada scope de la acción. Una degradación aplica de inmediato;
una sesión debe refrescar la versión y un PAT mantiene su perfil y scopes, sin
recibir permisos nuevos por la promoción del usuario. Las acciones de cambio de
perfil son exclusivas de sesión interactiva. Ni el permiso ni el token sustituyen
consentimiento comercial, pausa humana o autorización de un efecto externo.

## Primeros consumidores compatibles

La mutación común de API instala el contexto del principal autenticado antes de
leer autoridad, idempotencia, barreras o contenido. Conserva todas las validaciones
existentes y el namespace de replay. Su callback recibe únicamente el executor
transaccional; no recibe la conexión PostgreSQL. La lectura común de un registro
abre contexto propio cuando el caller no aporta una transacción. Cuando lo aporta,
permanece dentro de ella para conservar locks y atomicidad.

El tipo compartido de executor acepta SQL parametrizado y resultado Promise; los
consumidores no necesitan las sobrecargas de streaming ni callbacks de `pg`.
Esto permite revisar estáticamente todas las mutaciones existentes, manteniendo
las rutas legadas operativas mientras se adaptan los lectores restantes. Todavía
no se habilita RLS, no se cambia la autenticación ni se amplían permisos.

## Catálogo de privilegios y prueba PostgreSQL

El inventario incluye miembros de los roles runtime y todos los roles que éstos
pueden heredar o asumir, privilegios de columna, defaults, vistas, relaciones
fuera de `public` y triggers. Una vista o relación adicional sin revisión queda
como hallazgo; no se presupone que hereda RLS de sus tablas. TRUNCATE, concesiones
a PUBLIC, privilegios de servidor y capacidad de crear roles quedan señalados.
Los hashes de política, función y trigger requieren revisión explícita.

La primera prueba PostgreSQL usa únicamente una base sintética, las migraciones
históricas intactas y un login efímero sin superuser/BYPASSRLS, miembro de
`commerce_api`. Las tablas de adversario creadas por la prueba son identificadas
como fixtures; validan la primitiva de aislamiento y las FK, sin representar el
catálogo comercial ni acreditar su migración. Se verifica el inventario real de
las 68 migraciones por separado y se conservan sus hallazgos.

Referencias consultadas: [RLS PostgreSQL 17](https://www.postgresql.org/docs/17/ddl-rowsecurity.html)
y [membresía de roles](https://www.postgresql.org/docs/17/role-membership.html).

## Superficies SQL fuera del dominio declarado

El catálogo también recoge tablas foráneas de `public`, relaciones y colas de
cualquier schema de aplicación (incluido `pgboss` si existe), secuencias, vistas y
vistas materializadas. Su existencia, permisos y propietario se obtienen de
PostgreSQL; el inventario estático no supone que haya cero objetos ni los asigna
arbitrariamente a un perfil. Permanecen pendientes de clasificación hasta revisar
su consumidor y su modelo de autorización.

Los grants de relación, columna y schema se leen en todos esos schemas. Además
se registra quién puede ejecutar funciones de aplicación y qué rol las posee,
incluidas las SECURITY DEFINER. Un runtime con CREATE sobre un schema, concesión
transferible o ejecución de una función privilegiada sin revisar constituye un
hallazgo. Las políticas de API no se aceptan como prueba de protección contra
acceso SQL directo. Las referencias de funciones y triggers conservan el schema
para evitar confundir objetos homónimos.

## Selección de perfil por sesión y cambio concurrente

El siguiente incremento añade un esquema de transición fuera del directorio de
migraciones automáticas. Crear sus tablas vacías en una copia sintética no migra
la operación comercial ni satisface el gate PAY. Antes de promoverlo a una
migración canónica se necesita el inventario actual, el mapa explícito de IDs y
«Operación Brandon», el recibo D-23, las cuotas agregadas y todos los consumidores.
No se usa el primer workspace ordenado como fallback ni se concede acceso por
crear contexto SQL.

La selección reside en una fila por sesión Better Auth, ligada por FK compuesta
al usuario de esa sesión y a su membresía. El selector requiere una sesión
vigente del servidor y CAS de versión; un PAT o un ID recibido del cliente no
puede sustituirla. Sin selección se muestra la lista de membresías propias. Una
selección eliminada o degradada requiere confirmar de nuevo el contexto; no
salta silenciosamente a otro perfil. Los cambios de rol/activo incrementan la
versión en PostgreSQL incluso si los hace un consumidor legado.

Cada solicitud comercial conserva el ID de perfil y la versión de selección con
que se creó. La API los compara con la sesión actual; una pestaña o solicitud
anterior al cambio falla antes de consultar contenido. Las mutaciones repiten la
comprobación bajo locks sobre sesión, selección, membresía y perfil hasta commit.
El selector toma los mismos locks en orden estable y no espera a servicios
externos durante la transacción. La suspensión permite leer metadatos propios y
seguridad de cuenta, pero deniega mutaciones comerciales. Tokens siguen ligados
al perfil original y a una intersección cerrada de permisos vigentes.

La primera entrega de este bloque mantiene el resolver como consumidor explícito
sin sustituir aún el middleware legado: la conexión API/UI se hará junto con su
esquema, revisión de todos los callers y pruebas integrales. No se habilita un
selector que cambie sólo la UI mientras la API conserva otro workspace.

PostgreSQL exige privilegio UPDATE para adquirir un lock de fila FOR SHARE.
El API recibe únicamente UPDATE(id) sobre `profiles`; un trigger con search_path
fijo rechaza cualquier cambio del ID. No recibe UPDATE sobre estado, cuotas,
nombre o versión. El ensayo con login real debe demostrar tanto la adquisición
del lock como la denegación de esas escrituras; un mock no acredita esos grants.

## Contrato HTTP y selector explícito

El bootstrap de identidad usa `GET /v2/me/profiles` y el cambio usa
`POST /v2/me/profile-selection`. Ambos obtienen el ID de sesión y usuario de
Better Auth en el servidor, sin aceptar Authorization, IDs de usuario/sesión,
entorno ni workspace implícito. El POST exige Origin conocido, cuerpo cerrado y
la versión CAS observada. Un timeout se concilia leyendo el bootstrap: no se
reenvía automáticamente una selección incierta. El servidor audita el cambio en
la misma transacción. Ninguna respuesta contiene el ID o token de sesión.

Una membresía cuya versión cambió deja de aparecer como seleccionada, aunque la
respuesta conserva la versión CAS necesaria para confirmar el acceso vigente.
La UI identifica nombre, rol y estado del perfil, exige una selección explícita
y descarta el contexto visual anterior mediante recarga sólo tras confirmación
del servidor. No elige automáticamente el primer perfil ni almacena la selección
como autoridad en localStorage.

El plugin HTTP y el componente se prueban de forma aislada antes de registrarlos
en el arranque. Se conectarán junto con el middleware, las rutas globales y los
headers de versión para todas las solicitudes comerciales. Su existencia no
significa que la UI publicada ya pueda cambiar de perfil ni que RLS esté activo.

## Autoridad de sesión en la transacción comercial

El siguiente adaptador une el executor de perfil con la selección y autorización
vigentes. La solicitud conserva un fence observado de perfil/versión; el servidor
obtiene la sesión de Better Auth y comprueba ese fence bajo locks antes de ejecutar
el callback. Instalar el contexto SQL a partir del fence no concede autoridad: si
la selección o membresía no coinciden, no se invoca el callback comercial.

Se mantiene el orden sesión → selección → membresía → perfil durante toda la
transacción. Antes del commit se vuelve a comprobar vencimiento con el reloj de
PostgreSQL y la misma autoridad; si la sesión expiró durante el trabajo se revierte
la mutación. Un cambio concurrente de selección, rol o suspensión espera el lock
o se observa antes de comenzar. Los callbacks sólo hacen trabajo SQL acotado;
las llamadas externas se ejecutan mediante intentos durables fuera del lock.

Este adaptador es explícito y se prueba antes del corte de middleware. No usa
estado global de proceso ni AsyncLocalStorage para introducir un tenant en
consultas legadas silenciosamente. Los lectores restantes y los consumidores
de workers, tokens y archivos siguen siendo gates pendientes de integración.

## Localización y autoridad de PAT con RLS

Un bearer no elige perfil por header o argumento. Su hash completo localiza una
ruta de identidad mínima: ID de credencial, usuario y perfil. Esa ruta vive en
una tabla global de identidad sin acceso directo para runtimes. Una función
SECURITY DEFINER con search_path fijo y un único lookup por hash permite al API
obtener esos tres IDs; no retorna secretos, scopes ni contenido comercial. El
hash conserva la entropía del PAT existente. El índice tiene FK compuesta al
token y se mantiene mediante trigger; no se permite editarlo desde la API.

Después del lookup se abre la transacción de ese perfil. Se comprueban membresía,
perfil y token, en ese orden de locks, incluyendo el hash y la identidad original.
Los scopes guardados son cerrados, sin wildcard ni cambio de perfil, y se
intersectan con el rol vigente. Una promoción no amplía un PAT; una degradación o
revocación reduce/deniega inmediatamente su autoridad. El vencimiento se vuelve
a comparar con clock_timestamp después de esperar locks y antes de commit.

Las identidades, hash y scopes de una credencial emitida son inmutables: cambiar
su alcance requiere rotación explícita, con nuevo secreto y revocación atómica.
Los tokens legados sin scopes adoptados fallan cerrados en este lector nuevo;
el corte no se admite hasta que la migración canónica haya fijado y comprobado
sus scopes conservando su perfil y capacidades autorizadas. No se impone este
lector al middleware legado durante el desarrollo. El SQL de transición está
fuera de migraciones automáticas y sólo se ensaya sobre datos sintéticos.


El lector de PAT conserva además la restricción de entorno REAL/SIMULATION y
exige el formato completo del secreto antes del lookup. La función de localización
no recibe workspace ni devuelve información de usuario. Tras los locks, una
lectura adicional evalúa el reloj de PostgreSQL; filtrar vencimiento antes de
esperar FOR SHARE no sería suficiente. La misma validación se repite antes del
commit y revierte cualquier escritura si el token venció durante el trabajo.

El trigger de identidad de tokens se ejecuta con privilegios del invocador. Sólo
el propietario nativo de la tabla puede adoptar una vez scopes NULL de un token
legado; la API no puede usar esa excepción. La sincronización del índice es una
función SECURITY DEFINER separada, sin excepciones basadas en current_user del
definer. Identidad, entornos, vencimiento y scopes emitidos no se amplían; una
revocación no vuelve a NULL. La futura gestión de tokens debe serializar cambios
de autoridad antes de sus locks para evitar ciclos entre dos PAT que se revocan
mutuamente; ese controlador sigue siendo parte del corte pendiente.


## Adaptador HTTP de perfil y primeras lecturas

Las rutas V2 de negocio comparten un adaptador que recibe una acción constante
del servidor y entrega un executor SQL dentro de la misma transacción de
autorización. La sesión interactiva envía los headers x-commerce-profile-id y
x-commerce-profile-version del último bootstrap; son un fence de concurrencia,
no la autoridad. El resolver nativo vuelve a ligar sesión, selección y membresía.
El PAT no admite esos headers ni un selector: su índice determina el único perfil.
No se acepta Authorization inválido como invitación a usar la cookie.

GET /v2/profile y GET /v2/employees son los primeros consumidores de este
adaptador. Ambos retornan después del commit. Perfil retorna estado y límites
propios; empleados exige employees:read, exclusivo de Dueño. Las consultas
admiten únicamente environment y siempre filtran por el ID autorizado, además
del futuro RLS. El control de plataforma y los actores técnicos siguen siendo
rutas distintas, sin fallback a un Dueño o a un primer perfil. Estos endpoints
se registrarán en el mismo corte completo que el selector y no habilitan el
middleware legado parcialmente. Las mutaciones administrativas requieren una
orden de locks común para la autoridad del actor y los empleados objetivo;
se implementan aparte, sin efectos de proveedor dentro de la transacción.


## Serialización de cambios de autoridad

Las acciones administrativas del perfil (`employees:write`, `tokens:write` y
`profile:write`) toman un lock transaccional exclusivo por perfil antes de los
locks de sesión, membresía, perfil o credencial. Su clave deriva en PostgreSQL
de un namespace fijo y del perfil ya ligado a la solicitud. Sólo las acciones
constantes del servidor activan esta guarda; no se acepta un flag del cliente.
Una colisión del hash sólo produce contención conservadora, nunca acceso a datos.
Antes de intentar ese lock se comprueba la autoridad sin locks de fila para
impedir que un fence ajeno o un actor no autorizado sondee la contención de otro
perfil. La comprobación bajo locks posterior sigue siendo la autoridad definitiva.

Se usa `pg_try_advisory_xact_lock`: si otra administración tiene el lock, la
solicitud falla antes de leer autoridad o ejecutar su callback. No queda esperando
mientras retiene locks de otra persona ni se reintenta una mutación de resultado
incierto. El servidor conserva las comprobaciones normales de autoridad antes y
después del trabajo. Las lecturas comerciales no toman ese lock administrativo.

Esto serializa dos Dueños que modifican empleados o dos PAT que revocan al otro,
y evita que ambos retengan sus propios locks de autoridad esperando al contrario.
El lock se libera con commit/rollback de la misma conexión; no hay un mutex de
proceso. Los controladores administrativos deben usar este adaptador común y
conservar auditoría, CAS y las restricciones de último Dueño. Las mutaciones
propias de autoridad requieren semántica explícita: este incremento no las hace
válidas omitiendo la comprobación final de credenciales.

## Edición de datos propios del negocio

Dueño puede cambiar únicamente el nombre del negocio y la zona horaria de su
perfil mediante `PATCH /v2/profile`, con versión esperada, cookie seleccionada o
PAT del mismo perfil y scope `profile:write`. Es una operación de identidad del
negocio en REAL: no recibe un override de entorno ni trata una petición SIMULATION
como modificación simulada de la membresía o del perfil real. Suspensión y cuotas
quedan fuera de este contrato y requieren la autoridad de plataforma separada.

El executor conserva la serialización administrativa y la autorización antes y
después del trabajo. PostgreSQL guarda la versión y fecha del cambio; el rol API
recibe sólo UPDATE sobre nombre/zona, sin UPDATE de estado, cuotas ni versión. Un
trigger exige contexto SQL del mismo perfil para cambiar estos datos. No sustituye
el RLS final que sigue pendiente. Dos cambios con la misma versión no se fusionan
silenciosamente. Un cambio nulo no genera otra revisión ni otro evento.

La auditoría inmutable registra el actor y la revisión anterior/nueva dentro de
la misma transacción. No guarda el nombre del negocio ni un secreto de sesión o
PAT. La zona se valida como identificador reconocido por Intl/ICU del runtime;
no se acepta una abreviatura inventada o un offset para evitar horarios ambiguos.
La nueva transición SQL permanece fuera de las migraciones automáticas y la ruta
no se registra hasta el corte completo del perfil.

El formulario de datos del negocio se prepara sin montarlo en la aplicación. Consume únicamente la selección confirmada por el servidor, envía su fence en cada GET/PATCH y no usa el transporte heredado que añade `/v1` o un entorno implícito. Después de un resultado incierto exige una lectura nueva antes de permitir otro guardado; cambiar la selección invalida cualquier respuesta pendiente del perfil anterior. El rol que oculta o habilita la edición en UI no concede permisos: la autorización de SQL sigue siendo definitiva. No se almacenan perfiles ni borradores en localStorage.
