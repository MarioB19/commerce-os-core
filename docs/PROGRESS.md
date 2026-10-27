# Estado de publicación

## 27-oct-2026 — V7.1.1: el worker registra el código con que el servicio de correo rechaza un envío (Agente: Claude)

Con `BETTER_AUTH_SECRET` en el automation worker (ver abajo) la invitación de
prueba ya pasa del worker al servicio de correo de App Engine, que responde
`409`. El worker descartaba la respuesta y la invitación quedaba `UNCERTAIN`
sin causa visible. El diario de entregas no existía (primer `409`); se creó
vacío con `ifGenerationMatch=0` (aprovisionamiento F1 pendiente) y el segundo
intento siguió en `409` antes de registrar intención alguna: no se envió
correo.

- `appEngineTransport` escribe `mail_service_rejected <estado> <código>` en el
  log del worker. Sólo se acepta un código cerrado `MAIL_*` (el servicio nunca
  pone destinatarios, enlaces ni tokens en él); cualquier otro cuerpo queda
  como `MAIL_CODE_UNREADABLE`.
- Pruebas: `apps/automation-worker/src/mail-service-code.test.ts`; integración
  `profile-invitation-mail.test.ts` 19/19. Fusionar no instala.

## 27-oct-2026 — V7.1.1: el orden de los binds de Compose es neutral (Agente: Claude)

Al preparar la readopción de producción con el código de #22, `observe` paró con
`V7_ADOPTION_HOST_CONFIG_CHANGED:automation-worker`. El único cambio era el orden
de `HostConfig.Binds`: el instalador de V7.1 creó el contenedor con
`[/data/private:ro, /data/laboratory:rw]` y un `up --force-recreate` de la
misma versión lo creó con `[/data/laboratory:rw, /data/private:ro]` (Compose no
fija el orden; el laboratorio salió en el orden original). La comparación de
fronteras del instalador (`application_boundary_equal`) habría rechazado la
siguiente publicación al azar por lo mismo.

- `engine_neutral_host` compara los binds como conjunto: cada cadena se
  conserva completa y una de más, de menos o con otro modo sigue siendo un
  cambio. El digest de definición no cambia.
- Pruebas: `tests/ci/test_v7_binds_order.py` (2, fallan con el código
  anterior); suite Python 1,936 OK (2 omitidas). Fusionar no instala.

## 27-oct-2026 — V7.1.1: Resultados, laboratorio de números, invitaciones y gateways del supervisor (Agente: Claude)

La verificación de V7.1 en producción (instalada el 27-oct, `098395726e`)
encontró cuatro defectos; este cambio corrige los tres que requieren código y
habilita los dos de configuración.

- Resultados (503 `RESULT_SNAPSHOT_FAILED`): una conversación sin publicación,
  oferta ni pedido con precio no tiene moneda y el lector cerrado emite su
  contribución con `currency: null`, que el esquema canónico rechaza y tumbaba
  la proyección de todo el perfil. `pricedResultFacts` la deja fuera (no se
  estima nada); cualquier otra contribución inválida sigue fallando.
- Gateways del supervisor: su primer ciclo (EXPAND canónico `SUCCEEDED`,
  `VERIFIED`, 0 sesiones) agregó `waha-02` y `waha-04` y reescribió el overlay
  compartido al que apunta el recibo de `waha-03`. Desde entonces el host tenía
  12 contenedores y 9 redes, y el instalador, B02, el arranque durable y la
  readopción lo rechazaban (cotas de 11 contenedores, 8 redes, 3 gateways).
  - `GATEWAYS` = `waha-01`…`waha-06`; las cotas siguen (14 contenedores, 11
    redes) en el instalador, el arranque durable y el contrato de B02.
  - `v7_infra_adoption.py` adopta los gateways que agregaron operaciones
    canónicas: recibo del único slot REAL que los nombra, verificado como lo
    hace el instalador (`verify_gateway_provisioning`,
    `gateway_rendered_bindings`); ingress y channel-worker sólo pueden ganar
    los puentes de esos gateways y la línea base de redes sólo esos puentes.
  - Cada recibo que apuntaba al overlay compartido (mutable) se fija a una
    copia root-only de los bytes que atestiguó
    (`v7-infra-adoption/gateway-overlays/<sha256>.overlay`).
  - El diario registra `gateways_added` y `readoption_confirms` acepta
    exactamente el recibo más esos gateways.
  - `capture` tolera esas adiciones; los comandos corren en la versión actual,
    también cuando la copia del candidato revisado corre antes de instalarse.
- Configuración que la readopción ahora acepta: `LAB_ENGINE_SHA256` en la API
  («Probar número» respondía `LAB_NOT_INSTALLED`) y `BETTER_AUTH_SECRET`/
  `BETTER_AUTH_URL` en el automation worker (la invitación quedaba en cola con
  `IDENTITY_SECRET_REQUIRED`: el destinatario y el enlace usan ese secreto).
- Pruebas: `tests/ci/test_v7_gateway_readoption.py` (13),
  `packages/db/src/result-projection-worker.test.ts` y un caso nuevo de
  integración en `profile-result-source-collector.test.ts` (falla con el código
  anterior con el mismo ZodError de producción); suite Python 1,934 OK (2
  omitidas). Fusionar no instala.

## 26-oct-2026 — `backup.env` sigue al PostgreSQL de PITR, respaldo previo de 2 GiB y republicación 117→117 (Agente: Claude)

El ensayo de la ventana V7.1 en laboratorio (paquete `cv-5aa41553-…-1` de
`c3f6df5c`) pasó la readopción y `observe`/`seal`, y la instalación se detuvo
en el respaldo previo del instalador:

- `POSTGRES_NETWORK_INSPECTION_FAILED`: `backup.env` fija `PG_CONTAINER` al
  contenedor de PostgreSQL anterior a PITR (`v7_pitr.py enable` lo reemplazó
  el 21-oct sin actualizarlo) y la readopción rechazaba cualquier cambio en ese
  archivo. Nuevo `v7_infra_adoption.py rebind-backup-env` (Root, una vez, con
  copia 0600) y la readopción acepta exactamente ese cambio: con el valor
  anterior restaurado, el archivo debe dar el hash registrado.
- `COPY_BACKUP_CIPHERTEXT_BOUND`: con 8 días de telemetría de salud el volcado
  cifrado mide 1,089,064,996 bytes, sobre el límite de 1 GiB. El respaldo
  previo del instalador sube a 2 GiB (`PREDEPLOY_BACKUP_MAX_BYTES`). El límite
  de B02 (1 GiB, atado a su sobre financiero) queda para la sesión B.
- Con ambos cambios, en el laboratorio la instalación pasó el respaldo, las
  117 migraciones, la recreación de servicios y el smoke HTTPS (contra el Caddy
  local) y se detuvo en `COPY_RUNTIME_V7_TOKEN_VERSION_UNEXPLAINED`: el
  instalador trataba la republicación del mismo esquema V7 (117→117,
  `ALREADY_APPLIED`) como la publicación de perfiles 68→117 y exigía el +1 de
  versión de token que sólo hace la migración 0072. La comparación del dueño
  V7 se usa ahora sólo cuando la publicación aplicó esas migraciones
  (`v7_tokens_migrated`); la vista comercial V7 se conserva.
- Pruebas: `tests/ci/test_v7_backup_env_pitr.py` (10, fallan con el código
  anterior); suite Python 1,921 OK (2 omitidas). Fusionar no instala.

## 26-oct-2026 — la readopción extiende el recibo de la instalación (Agente: Claude)

El ensayo de la ventana V7.1 en un laboratorio copiado de producción (paquete
`cv-5465e553-…-1` de `d3916298`) encontró un bloqueo antes de instalar: después
de la readopción Root (`v7_infra_adoption.py apply`: PITR, proxy, variables
V7), `copy-runtime-approvals.py observe` paraba con
`COPY_RUNTIME_CURRENT_PAIR_NOT_CONFIRMED`. El recibo de la instalación del
21-oct conserva el PostgreSQL anterior a PITR; la readopción cambia el
inventario del estado Root, pero no el recibo. B02 y el arranque durable
hacían la misma comparación.

- `b02_backup_contract.readoption_confirms`: acepta la diferencia sólo con el
  diario de readopción `APPLIED` de exactamente este estado y plan, sobre el
  mismo recibo y con el mismo conjunto de servicios.
- El diario de `apply` registra `base_receipt_ref`.
- Lo usan el instalador canónico (`snapshot`), B02 (`gcp_pair`) y el
  arranque durable.
- Pruebas: `tests/ci/test_v7_readoption_receipt.py` (9, fallan con el código
  anterior); suite Python 1,911 OK (2 omitidas). Fusionar no instala.

## 26-oct-2026 — audit de dependencias del FULL de V7.1 (Agente: Claude)

El FULL de `main` `a34914b6` (Build `5ba058ed`) pasó las 20 etapas de prueba,
incluidas integración, recuperación y e2e. Falló sólo en `pnpm audit
--audit-level high`: después del 21-oct se publicaron avisos altos para `zod`
< 4.6.6 (GHSA-mrhx-c7xc-m3w5) y `body-parser` 2.0.0–2.3.x
(GHSA-27r3-jxmh-p828, vía `@modelcontextprotocol/sdk` → `express`).

- `zod` 4.5.4 → 4.6.7 (raíz y `@commerce/mcp`).
- Override `body-parser@>=2.0.0 <2.4.0` → 2.4.0 (dentro del rango `^2.3.0` de
  `express` 5.3.0).
- `pnpm audit --audit-level high`: sin avisos altos. Sin migraciones ni cambios
  de código de aplicación. Fusionar no instala.

## 26-oct-2026 — bolsa de CI a 1,800 min y medidor a 70,000 s (Agente: Claude)

Rama `claude/v7-1-ci-pool` ([ADR](adr-v7-ci-pool-third-extension.md)). Brandon
autorizó el deploy de V7.1 antes del 1-nov y la ampliación de la bolsa. Octubre
estaba en 81,780 de 90,000 s del ledger y en 49,150 de 50,000 s del medidor del
controlador, así que el FULL de `main` no cabía.

- **Ledger:** transición `raise_monthly_limit_third` (90000 → 108000 s), sólo
  desde el pool de 1,500 con su recibo, sin intento activo ni bloqueo, con el
  recibo inmutable `limit_third_extension`.
- **Medidor:** 70,000 s vCPU y 140,000 GiB-s al mes. Se conservan filas, cargos
  y los límites por solicitud.
- **Costo:** techo adicional de USD 2.76 al mes con IVA, sólo si se usa.
- **Pruebas:** suite Python 1,902 OK (2 omitidas). Seis pruebas nuevas de la
  bolsa (también con la forma del ledger vivo) y una regresión del medidor con
  las reservas reales del 26-oct.
- **Aplicación:** imágenes derivadas del controlador y del atestador por
  digest; sólo cambian estos dos módulos. Revisión de Cloud Run y triggers con
  los controles en pausa, y luego el CAS Root. Fusionar no instala.

## 25-oct-2026 (noche) — release correctiva V7.1 (Agente: Claude)

Rama `claude/v7-1-release`, sobre `4001db8d` con el arreglo del administrador
de capacidad (entrada siguiente). Se midió en un laboratorio aislado copiado de
producción (snapshot en caliente, sin IP externa, sin NAT ni cuenta de
servicio).

- **CPU de PostgreSQL** ([ADR](adr-v7-1-worker-loop-budget.md)). Bajo RLS
  forzado, `materializeEffectResults` recorría todos los mensajes y entregas
  por cada efecto terminal en cada vuelta de 250 ms: 1.6–2.3 s y 150k buffers,
  un núcleo completo. Ahora usa CTE materializadas con cruces por uuid: 11 ms,
  mismas filas y mismo orden. Además, los efectos con el mismo bloqueo desde
  hace más de 10 minutos esperan más entre chequeos (hasta 30 s). Con los
  workers parcheados, la CPU ocupada del laboratorio bajó de 89 % a 37 %.
- **Crecimiento de la base** (mismo ADR). 4.0 → 7.39 GB es, sobre todo, el
  relleno de la ventana de 8 días de telemetría de salud. Quedan ~70 MB/día sin
  purga en versiones de `channel_account` y heartbeats; pendiente para V8.
- **Digests neutrales a la codificación del motor**
  ([ADR](adr-v7-engine-neutral-dns.md)). Los digests guardados están mezclados
  (`null` en los recreados, `[]` en los preservados). Ahora se acepta cualquier
  codificación vacía y se conserva el digest guardado mientras coincida. Lo usan
  el instalador, la readopción, el arranque durable y B02. Hay pruebas de
  continuidad con el estado de la versión anterior y el inspect real.
- **Proxy como código.** `@health` incluye `/healthz/platform` en las
  plantillas, y `update-identity-proxy.py` lo añade o lo exige exacto. Una
  prueba nueva cruza cada ruta que usa la web y cada ruta de salud de la API
  con el Caddy, en la plantilla y en el sitio de producción reescrito. Nuevo
  `scripts/v7_public_smoke.py`: revisa estado y `content-type` de cada ruta
  pública. Hoy detecta `/healthz/platform` como HTML.
- **B02 después del 4-dic** ([ADR](adr-v7-b02-renewal.md)). Renovación
  recurrente acotada por periodos de 30 días: sólo hacia `MANUAL`, como mucho 7
  días antes del fin y al siguiente periodo. Misma cuota de 37 y un solo
  Scheduler. El transporte rechaza vinculaciones con más de 37 días de
  anticipación.
- **Supervisor de gateways.** Omite los perfiles no `ACTIVE` antes de pedir su
  token, porque el token de un perfil suspendido se rechaza en cada llamada con
  `PROFILE_SUSPENDED`. Lo registra una sola vez.
- **Portal Mi Ciclo Listo.** Los exit 137 eran OOM del cgroup: next-server
  llegaba a ~287 MiB y el healthcheck de node completaba los 320 MiB. La próxima
  publicación del portal usa 512 MiB y `--max-old-space-size=256`. El
  contenedor actual se conserva (Docker lo reinicia solo).

Pruebas locales: Python CI 1,879 (2 omitidas), typecheck, lint de lo tocado e
integración de los flujos de canal y automatización. FULL, paquete e
instalación pendientes.

## 25-oct-2026 — el administrador de capacidad leía una ruta retirada (Agente: Claude)

`scripts/number-capacity-administrator.py` (que también usa
`gateway_supervisor.py`) leía cada operación con `GET /v1/number-operations/:id`,
retirada en F8-D. En V7 ninguna operación PROVISION, EXPAND o DRAIN podía
aplicarse en el host: el supervisor medía y reiniciaba gateways, pero no
creaba ninguno. Ahora la operación se toma de la cola propia del agente
(`GET /v1/number-capacity/administration`); si no está pendiente se detiene
con `OPERATION_NOT_PENDING` antes de reclamar, y una cola ambigua o malformada
no se usa. Nueva prueba de contrato `tests/ci/test_capacity_agent_routes.py`:
cada ruta que llaman el administrador y el supervisor debe existir en la API
(falla con el código anterior). Python CI local: 1,863 pruebas, 2 omitidas.
FULL, paquete e instalación pendientes; el supervisor sigue sin instalarse en
producción.

## 21-oct-2026 (noche) — V7 instalada; ruta `/v2/*` en el proxy de entrada (Agente: Claude)

`f0d71880` (paquete `cv-b723d978-…-1`) quedó instalada: instalador `SUCCEEDED`,
117 migraciones, `/api/version` = `f0d71880`. PITR habilitado (full
`20261021-205216F`, ensayo de restauración OK). Al entrar, la web mostraba «No
se pudo confirmar tu acceso»: la web V7 lee su identidad y sus datos en `/v2/*`
(`/v2/me`), pero el Caddy de entrada de producción sólo enviaba `/v1/*` a la
API, así que `/v2/me` caía en el fallback de la web (HTML). Se añadió en caliente
con `update-identity-proxy.py` (validación, recarga y respaldo). Este cambio deja
esa ruta en las plantillas y en la herramienta, que ahora inserta y exige un único
`handle /v2/*` hacia `commerce-api:3001` antes del fallback. Queda pendiente
adoptar en el estado Root el proxy nuevo junto con la readopción de F1.

## 21-oct-2026 (tarde, 2) — DNS sin configurar en la frontera de aplicación (Agente: Claude)

FULL `5c2fecaf` de `beb7d23d`: SUCCESS. La ventana `cv-5c2fecaf-…-1` migró a
117, levantó los seis servicios y pasó la comparación del dueño; se detuvo en
`COPY_RUNTIME_APPLICATION_BOUNDARY_CHANGED`. Producción regresó al snapshot frío
`…20261021d`. Con el `docker inspect` real, la única diferencia es
`Dns`/`DnsOptions`/`DnsSearch`: `[]` en los contenedores del 10-oct y `null`
en los recreados. Corrección: esas tres listas sin valor se leen como `[]` en
la frontera de aplicación y en la readopción de PITR
([ADR](adr-v7-engine-neutral-dns.md)). FULL, paquete e instalación del nuevo
commit siguen pendientes.

## 21-oct-2026 (tarde) — identidad del dueño en la publicación V7 (Agente: Claude)

FULL `7f04216a` de `36231cb1`: SUCCESS. La ventana `cv-7f04216a-…-1` exportó,
migró a 117 y levantó los seis servicios sanos, `channel-worker` incluido. Se
detuvo en `commit_stage` con `COPY_OWNER_AUTH_IDENTITY_CHANGED` y producción
regresó al snapshot frío `…20261021c`.

Causa: 0072 asigna los alcances de perfil a cada token personal y su trigger
sube la `version` en uno; la comparación del dueño incluye esa versión.
Corrección: sólo para la publicación V7, la comparación exige los mismos tokens
con exactamente +1 de versión y después aplica la comparación histórica
([ADR](adr-v7-owner-auth-token-scopes.md)). FULL, paquete e instalación del
nuevo commit siguen pendientes.

## 21-oct-2026 — despacho bajo RLS y atestación sin aprobación (Agente: Claude)

FULL `3dd6b366` de `3ebedd57`: SUCCESS. Dos ventanas de instalación se
detuvieron en `install-consumers` y regresaron al snapshot frío.
- Ventana 1: el paquete local se armó con `umask 077` y `web` no podía leer su
  Caddyfile. Se corrigió en el empaquetador de Root (`umask 022`).
- Ventana 2: la consulta de candidatos de `channel_dispatch` no usa índices
  bajo el RLS forzado de V7 (cruces `uuid::text`) y tardaba más de 9 min con
  datos reales.

Corrección: cruces por uuid dentro de CTE materializadas
([ADR](adr-v7-dispatch-rls-index.md)). Con la base real migrada tarda 0.5 s, da
resultados idénticos y `channel-worker` queda READY.

La atestación `4821d6ef` quedó UNKNOWN por un 503 de Cloud Build antes de
`ApproveBuild` y retenía el bloqueo del CI. Con aprobación de Brandon,
`abandon_without_native` se extiende a atestaciones sin aprobación nativa: cobra
los 120 s y la compuerta queda consumida
([ADR](adr-v7-abandon-unknown-without-native.md)).

## 21-oct-2026 (madrugada UTC) — audit de dependencias y bolsa de CI (Agente: Claude)

El FULL de `main` `f3b7f05d` (Build `93788e93`) pasó todas las etapas de prueba,
incluidas integración y e2e. Falló sólo en `pnpm audit`: ese día se publicaron
avisos altos para `@modelcontextprotocol/sdk` < 1.32.0 y `vite` 8.2.0–8.2.3.
Se suben a 1.32.1 y 8.2.4. Octubre quedó en 67,980 de 72,000 s; por eso Brandon
aprobó ampliar la bolsa a 1,500 minutos (≤ USD 2.09/mes)
([ADR](adr-v7-ci-pool-second-extension.md)). FULL, atestación, paquete e
instalación del nuevo commit siguen pendientes.

## 20-oct-2026 (noche, 2) — medidor del controlador y DISPATCH incierto (Agente: Claude)

El FULL de `main` `785b9d37` se detuvo antes de existir un Build. Primero, el
medidor del controlador agotó su techo de octubre (40,000 s). Brandon aprobó
subirlo a 50,000 s vCPU y 100,000 GiB-s (≤ USD 0.34/mes). La imagen derivada
cambia sólo el medidor ([ADR](adr-v7-controller-runtime-pool-2026-10-20.md)).
Después, el DISPATCH persistió su intención y terminó `UNKNOWN`: un 429 de
`ListLocations` en el fence. Nunca hubo `CreateBuild` y el inventario nativo
quedó idéntico al de la admisión. Ese estado bloqueaba el CI para siempre.
Corrección: transición `abandon_without_native`, que cobra los 95 minutos, no
reembolsa y sólo libera el bloqueo
([ADR](adr-v7-abandon-unknown-without-native.md)). FULL, atestación, paquete e
instalación del commit que la incluya siguen pendientes.

## 20-oct-2026 (noche) — comparación comercial de la publicación V7 (Agente: Claude)

El cuarto intento (`727623e0`, paquete `cv-471e9e64-…-1`) exportó y migró
(117) y se detuvo en `COPY_RUNTIME_COMMERCIAL_CONFIGURATION_CHANGED`;
producción regresó al snapshot frío `…20261020d` (`80a6d6ea`, 68). La
comparación por filas completas cambia siempre con V7 (tablas retiradas
eliminadas por 0109 y columnas nuevas). Corrección: proyección sobre las
columnas previas y tablas retiradas a cargo de los recibos, sólo para la
publicación V7. Validada con la base migrada real contra producción (mismo
hash). Incluye la estabilización de dos pruebas con carreras de tiempo que
tumbaron 3 de 8 FULL. FULL, atestación, paquete e instalación pendientes.

## 20-oct-2026 (tarde) — llave de datos del exportador (Agente: Claude)

`main` `c629c27f` pasó FULL `e028f78f` (el primer FULL `6a121cd1` falló por
una carrera de `profile-privacy-writer-fence.test.ts`, ajena al cambio) y su
atestación `b2aeea77`. El paquete `cv-e028f78f-c407-4268-8afa-db919303e2d3-1`
(`840657c3…`) se observó y selló; la instalación terminó `FAILED` antes del
SQL con `PRIVATE_DATA_KEY_REQUIRED`: `admin.env` no trae la llave de datos que
el exportador usa para sellar las tablas. Producción se reconcilió al minuto
(`80a6d6ea`, 68 migraciones, hold liberado, workers arriba, cero envíos).

Corrección: la llave se toma de `api.env` y viaja sola en un `--env-file`
`0600` temporal, borrado al terminar. Ensayo de punta a punta en la VM de
empaquetado (exportador con las banderas exactas, `verify`, 0069–0117 con
recibos: 117) y regresiones nuevas. FULL, atestación, paquete e instalación
del nuevo commit siguen pendientes.

## 20-oct-2026 — lectura de la imagen V7 en el exportador (Agente: Claude)

`main` `59768f73` pasó FULL `fd09b802` y su atestación `6ecf3514`; el
paquete `cv-fd09b802-25bc-4f0e-80e5-b9012d51de0d-1` (`ab161b4f…`) se observó
y selló. La instalación terminó `FAILED` en `reviewed-migrations`, otra vez
antes de cualquier SQL: el exportador, ya con la imagen candidata, corre como
Root con `--cap-drop ALL` y no puede leer `/app/package.json` (archivos
`0600` del usuario `node` en la imagen V7). Producción se reconcilió el mismo
minuto: `80a6d6ea`, 68 hashes de migración sin cambio, hold liberado,
workers arriba, REAL congelado, cero envíos.

Corrección: `--cap-add DAC_READ_SEARCH` sólo en esa ejecución (patrón de
`b02-backup-root.py`). Probada en producción con el modo `status` del
exportador: sin la capacidad, `EACCES`; con ella, lista de tablas. La
regresión falla con el código anterior y pasa con el nuevo; 117 pruebas
`test_copy_runtime*` en verde. FULL, atestación, paquete e instalación del
nuevo commit siguen pendientes.

Decisión: [adenda del ADR](adr-v7-retirement-candidate-image.md).

## 19-oct-2026 — corrección del exportador previo a V7

La instalación canónica de `a7558dc1` terminó `FAILED` antes del SQL de V7:
el exportador se ejecutaba con la imagen instalada, que no contiene el
archivo de V7. Producción conserva `80a6d6ea` y sus 68 hashes de migración.
El respaldo local previo terminó y las dos credenciales personales siguen
válidas. El intento fallido requiere reconciliación; no acredita instalación.

La selección del exportador usa ahora el ID inmutable de la candidata,
verificado contra fuente, capas y plataforma del paquete. La regresión falla
con el código anterior y pasa con la corrección; una imagen de otra fuente
se rechaza antes de crear archivos o ejecutar tareas. El test sintético de
B02 fija su disponibilidad de disco para no depender del espacio de la Mac;
la guarda de espacio de producción no cambia.

Validación local: 14 pruebas de migración operativa; suite Python completa
con Node 24: 1,835 pruebas, 2 omitidas, sin fallos. FULL y atestación del
nuevo commit, instalación y comprobación productiva siguen pendientes.

Decisión: [imagen candidata para exportar](adr-v7-retirement-candidate-image.md).
