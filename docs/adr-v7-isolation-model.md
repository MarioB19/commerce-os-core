# V7 F2 — Modelo de aislamiento del corte de perfiles

Fecha: 2026-10-12. Estado: aceptado para el corte F2 (rama `claude/v7-f2-cutover`).
Sustituye como decisión operativa a las propuestas locales de `adr-v7-row-isolation-plan.md`
y `adr-v7-profile-isolation-cutover.md`, que siguen siendo antecedentes de diseño.

## Contexto

Las transiciones de Codex (`packages/db/profile-transition/`) creaban perfiles, identidad,
PAT por perfil, cuotas, autorización continua, IA, resultados, laboratorio, pagos y privacidad,
pero nada las instalaba. El código ya exigía contexto de perfil (rutas V2, rutas SQL V1,
productor de efectos) y la suite heredada fallaba. El corte debía ser conservador y reversible:
aislamiento real en la superficie expuesta (la API) sin romper los bucles globales actuales de
los workers.

## Decisión

### 1. Migraciones (0069–0097)

Las fuentes de `profile-transition/` se promovieron a migraciones numeradas en el orden canónico
que fijaban las pruebas compuestas. Cada bloque promovido conserva su texto y lleva el sha256 de su
fuente. El único cambio mecánico es que la creación de roles usa `v7_ensure_reviewed_role`: los
roles son de clúster y pueden existir por otra base del mismo clúster (bases de prueba aisladas,
copia restaurada); se adoptan sólo si tienen exactamente los atributos revisados (NOLOGIN,
NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION, INHERIT según la fuente) y
ninguna membresía en un rol privilegiado o ajeno; en otro caso la migración falla.

Quedan fuera de las migraciones de la base de aplicación, y por eso `profile-transition/` se
conserva como fuente histórica: los componentes del motor dedicado del laboratorio
(`021_number_lab_engine`, `_materialization`, `_driver`, `_transport`), que se instalan en su
propia base `commerce_lab_engine_*`, y los planes generados de privacidad (cercos de escritura,
referencias, filas de respaldo) con `038_private_asset_authority`, que dependen del catálogo vivo
y pertenecen a la activación de borrado (fase posterior).

Adopción de datos (dentro de las migraciones, sin entradas externas):

- 0069 verifica antes de cambiar nada: ≤3 workspaces con datos, un solo workspace con owners
  activos, ≤20 números REAL vigentes. Registra el inventario de tablas históricas.
- 0071 crea un perfil por `workspace_id` con datos (el id se conserva byte a byte). El que tiene
  owners activos (o el único workspace) es «Operación Brandon», ACTIVE, `America/Mexico_City`,
  20 números menos los de cuarentena, productos max(actuales, 200), 300 conversaciones/día. Los
  demás quedan SUSPENDED como «Datos en cuarentena N», con límites iguales a su uso actual; nunca
  se fusionan con el principal. Roles D-23: owner→owner, operator→operator, analyst/viewer→viewer,
  seller/reconciler→operator sólo si hay membresías activas de ese rol (en producción se leyeron
  0), si no viewer. El rol histórico queda en `profile_role_adoptions` (inmutable) y cada perfil en
  `profile_adoption_receipts` con sus conteos. Se añaden `memberships_v7_role` y FK a `profiles`
  para membresías, tokens de servicio y PAT. Conteos verificados antes del COMMIT.
- 0072 fija en los PAT heredados el conjunto cerrado de scopes de owner (todo menos
  `profiles:switch`), su capacidad efectiva previa; sigue intersectado con el rol vigente.
- 0083 mueve a `profile_adoption_quarantine` (inmutable, sólo owner) los controles manuales y
  filas de propiedad de sesión cuyo registro exacto no existe (ya eran inertes) y construye el mapa
  de idempotencia: entorno de la respuesta guardada, luego el de `data`, y si no se puede probar,
  REAL. Ese valor sólo decide dónde se reproduce la respuesta antigua; la PK sigue abarcando ambos
  entornos, así que un reintento desde el otro entorno falla con conflicto y nunca ejecuta dos
  veces. 0085 inserta la política de plataforma (3 perfiles, 20 números, 300 conversaciones/día,
  calendario `America/Mexico_City`) y sella la línea base de cada perfil.

### 2. Aislamiento de la API (`commerce_api`)

0096 habilita y fuerza RLS en **toda** tabla pública con `workspace_id` y en `profiles`, y añade
`v7_api_profile_guard`: política RESTRICTIVE `TO commerce_api` que exige
`workspace_id = NULLIF(current_setting('app.workspace_id', true), '')`. Sin contexto no hay filas.
Las tablas que no tenían RLS reciben además una política permisiva equivalente para la API y para
cada rol revisado con privilegios y sin política propia. Ningún rol `commerce_*` tiene BYPASSRLS ni
es superusuario (se verifica en la migración). Las conexiones de producción
(`commerce_<servicio>_login`) asumen su rol de grupo al conectar, para que las políticas y guardas
que comparan `current_user` vean `commerce_api`.

Cada request autenticada resuelve **una** autoridad de perfil en el servidor:

- Sesión interactiva: la selección explícita con CAS (`profile_session_context`). Las cabeceras
  `X-Commerce-Profile-Id/-Version` se verifican siempre que llegan y son obligatorias con dos o más
  membresías activas (409 `PROFILE_REQUEST_FENCE_REQUIRED`). Con exactamente una membresía activa,
  si no hay selección vigente se selecciona por el puerto cerrado `select_authenticated_profile` y
  se audita (`identity_audit` `profile.selection.automatic`); nunca «la primera» de varias.
- PAT `cos_pat_`: su perfil por `locate_personal_profile_token`.
- Tokens de servicio (incluidos `cos_v5_`): siguen en uso por el MCP V5, así que se **ligan** al
  perfil de su workspace (FK) y se localizan por `locate_service_profile_token` (0097). Conservan
  su autorización histórica por scopes; no son identidad interactiva ni administran personas o
  credenciales; un perfil suspendido no admite sus mutaciones.

Las rutas SQL V1 y V2 corren en una sola transacción (`withProfileRequest`). Las rutas históricas
corren dentro de un *request profile scope*: cada sentencia o transacción del pool enrutado toma una
conexión con `app.workspace_id` (y `app.environment` una vez parseado) y la restablece antes de
devolverla; `withProfileTransaction` instala el mismo contexto con SET LOCAL y rechaza otro perfil.
Las mutaciones vuelven a bloquear y validar la credencial dentro de su transacción. Los flujos de
identidad previos a elegir perfil usan dos puertos cerrados (`identity_active_membership`,
`revoke_identity_personal_tokens`).

### 3. Workers: frontera transitoria explícita

`commerce_ingress`, `commerce_automation`, `commerce_channel` y `commerce_maintenance` son miembros
de `commerce_worker_global` (la API no lo es; se verifica). En las tablas **históricas** (las que
existían en 0068) ese rol tiene una política permisiva: sin contexto, el bucle global histórico;
con `app.workspace_id`, sólo ese perfil. Las políticas restrictivas V7 sobre tablas históricas y las
guardas de alcance (hijos derivados, propiedad de sesión, controles manuales, privacidad de registros
y materiales, cuota) aceptan una transacción de worker **sin ningún contexto** derivando el alcance
del registro padre o del propio registro, como antes de V7; con contexto siempre exigen coincidencia
exacta. Las tablas creadas por V7 conservan su semántica V7 (contexto obligatorio o WorkerScope).
Los límites de cuota y plataforma se siguen aplicando a los workers.

El productor de efectos REAL con autorización continua instala el contexto del registro explícito
(la conversación bloqueada) con `bindRecordProfile`; no elige perfil y nunca cambia un contexto ya
establecido. La semántica de congelamiento por release no cambia (F3).

### 4. Pruebas

Cada archivo de integración recibe su propia base migrada: las cuotas de plataforma son por
instalación (3 perfiles, 20 números) y ya no pueden acumularse perfiles de cien archivos en una base.

## Reversibilidad

Todo es aditivo y reversible sin pérdida de datos: los perfiles conservan el id histórico, el rol
anterior queda registrado y nada se borra salvo la cuarentena explícita (copiada byte a byte).
Desactivar el aislamiento de la API es retirar `v7_api_profile_guard`/`FORCE` en una migración
nueva; volver a cerrar a los workers es retirar la membresía de `commerce_worker_global`.

## Endurecimiento posterior (pendiente)

1. Montar `createDatabaseWorkerRuntime` (WorkerScope) en todos los bucles de automation, channel,
   ingress y mantenimiento, por perfil y entorno; después retirar `commerce_worker_global`, sus
   políticas y las excepciones sin contexto de las guardas.
2. Aplicar entorno además de perfil en la política de la API para las tablas históricas.
3. Instalar los planes generados de privacidad con el catálogo de producción (fase de borrado).
4. Configurar explícitamente en el instalador el rol asumido por cada login (hoy lo hace la
   aplicación al conectar).
