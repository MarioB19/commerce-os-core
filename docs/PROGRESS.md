# Estado de publicación

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
