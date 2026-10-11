# Cápsula privada de recuperación del portal — PREPARED

Fecha: 2026-10-08 UTC. La implementación integra código público y pruebas
sintéticas al controlador diario. No contiene controles privados, claves ni datos
reales. No se ha instalado en la VM, ejecutado backup Cloud ni demostrado recovery
productivo. La prueba local no habilita por sí sola la cobertura operativa.

## Decisión

Agregar `portal.backup.aes` al mismo run de respaldo diario, preservando el
COMOSB02 existente y `restore.mjs`. La cápsula protege el runtime env, current,
manifiesto privado, los diez PDF y un snapshot consistente del rate-limit SQLite.
No autoriza reanudación de consumidores, envíos o promoción productiva.

`COMOSP01` usa AES256GCM con un IV aleatorio nuevo y la cabecera autenticada como
AAD. La clave original B02 entra exclusivamente por stdin, en RAM. El mínimo
aceptado son exactamente87 bytes ASCII:
`BACKUP_ENCRYPTION_KEY=<64 caracteres hexadecimales>\n`.
No se aceptan argumentos, variables de entorno ni archivos nuevos de clave.
El caller Root lee el mínimo original con su guardia de custodia y lo entrega
directamente mediante `Popen(..., stdin=PIPE).communicate(input=minimum_bytes)`.
No registrar el input ni excepciones nativas. El helper sólo emite códigos
constantes y recibos públicos sin hashes de perfiles/claves/códigos.

Se confirmó la API en la documentación oficial de
[Node24.20 SQLite](https://nodejs.org/download/release/v24.20.0/docs/api/sqlite.html#sqlitebackupsource-db-path-options):
`backup()` utiliza la API de backup de SQLite; `readOnly` abre la fuente en lectura.
La operación puede reiniciarse ante un escritor concurrente. Por ello producción
debe ejecutar el CLI como un hijo acotado; no usar un import sin supervisor.

## SQLite y custodia

La única tabla admitida es `attempts` STRICT, con client TEXT PRIMARY KEY,
count INTEGER NOT NULL y reset_at INTEGER NOT NULL. Client debe ser SHA256,
count1–10, timestamp positivo seguro y máximo50000 filas. Las consultas de filas
están limitadas a50001; no se carga una tabla arbitrariamente grande.

El source y los sidecars permanecen en el mismo directorio de estado. El helper
abre la fuente `readOnly:true`, prohíbe extensiones, habilita defensive/query_only
y llama a `node:sqlite backup()`. Normaliza sólo la copia nueva a journal DELETE,
valida integridad/esquema y cierra antes de cifrar. Nunca solicita checkpoint de
la fuente ni modifica su journal_mode. Un directorio vacío se registra como
NOT_INITIALIZED; no inventa una base. WAL huérfano, archivo extraño, corrupción o
esquema ajeno bloquean. Sólo los nombres DB/WAL/SHM están permitidos.

La fuente mutable es UID1000/dir0700 en producción. Sus archivos deben ser
regulares, nlink1, sin escritura de grupo/otros y <=16MiB cada uno. Se admite644
dentro del directorio0700 porque SQLite crea así los sidecars por defecto; el
snapshot recuperado siempre es0600. Se verifican inode/custodia de fuente y
directorio antes/después. Estas comprobaciones no sustituyen el aislamiento del
contenedor ni constituyen defensa contra un atacante que ya controle Root o el
proceso UID1000 del portal. El caller debe montar la fuente readonly en el helper
y conservar los locks y guards del runtime instalado.

PostgreSQL y SQLite tienen snapshots consistentes separados. Este formato no
afirma una transacción atómica global ni RPO/PITR. SQLite sólo guarda contadores
de seguridad de15min; regenerarlo puede ser legítimo, pero debe declararse como
reset de rate-limit. La custodia de los códigos y el secreto requiere el env.

## Formato cerrado

Exterior: `COMOSP01`(8) + IV(12) + ciphertext + tag(16).
Interior: `PORTALC1`(8) + longitud JSON uint32BE(4) + manifiesto JSON privado +
bytes de los miembros en el orden de nombres ASCII del manifiesto.

No hay tar, tipos de entrada, rutas arbitrarias ni enlaces. La lista exacta es:
current/env/manifiesto, diez PDF por nombre fijo y SQLite sólo cuando PRESENT.
El parser rechaza campos JSON duplicados, campos extra, duplicados de miembros,
traversal, tamaño incorrecto y bytes sobrantes. Se verifica el tag de toda la
cápsula antes de interpretar el manifiesto o escribir cualquier plaintext.
El manifiesto y hashes de perfiles sólo existen dentro del ciphertext o de un
destino Root privado de recovery; nunca son recibos públicos.

## Recuperación y limpieza

`verify` autentica todos los bytes, valida perfiles y PDF, y usa únicamente un
sandbox privado nuevo para comprobar el snapshot SQLite. Lo elimina mediante
identidad de inode, bytes/hash y conjunto exacto.

`restore` verifica todo antes de crear el destino nuevo. Restaura archivos0600 y
directorios0700, lee cada miembro de vuelta y devuelve `production_promoted:false`.
El CLI reserva exclusivamente la receta hermana Root0600 antes de crear
plaintext; si ya existe un archivo o enlace, se detiene preservándolo. Al terminar
verifica su inode y bytes antes de publicar el recibo; su contenido es privado. `cleanup` exige la ref sellada de esa receta y comprueba todo el árbol
antes de borrar archivos exactos. No hace rm recursivo; un archivo alterado, inode
reemplazado, enlace o miembro ajeno conserva el árbol y produce STOP_PRESERVE.
Un fallo después de alguna eliminación puede ser parcial: no se revierte ni se
declara cleanup completo. El journal externo debe mantener esa incertidumbre.

`current.json` restaurado es evidencia histórica. No es una identidad Docker
vigente y no debe copiarse directamente al current productivo. El instalador
normal debe recuperar env/documentos y producir una nueva identidad/recibo,
HTTPS y adopción con sus nuevos CIDs. No se activa por restaurar esta cápsula.

## Integración exacta pendiente

1. Instalar este helper como tercer source público Root sellado en plan2; usar
   la imagen de mantenimiento existente por ID. No requiere que D36 incluya el
   helper: montarlo readonly por ruta fija verificada.
2. Plan2 incluye identidad/ref3 del portal y state_uid1000. No incluir ref/hash
   de api-web-adoption.json: ese archivo contiene el hash del plan y sería un
   ciclo. Comparar su subconjunto portal en RAM y guardar los refs propios.
3. El Root controller prepara un control privado fresco bajo su propio run,
   verifica las referencias/adopción/inventario antes y después y entrega stdin.
   PDF provienen del contenedor exacto por copia local acotada, regular600,
   comprobada contra el manifiesto, no de una ruta arbitraria del host.
4. Montajes: source-root/states readonly; únicamente sandbox/output de este run
   writable. Red none, sin socket Docker, sin nuevas cuentas/claves/privilegios.
   Reserva sugerida256MiB para buffers acotados; supervisión del deadline global.
5. Deadline del control = min(deadline global B02, ahora+120s). El CLI no concede
   un nuevo presupuesto1500s. Expiración fuerza STOP_PRESERVE y deja cualquier
   plaintext no reconocido para conciliación exacta del controller.
6. No pasar LOCAL_CUSTODY_PENDING hasta que B02 y cápsula estén íntegros y cleanup
   propio probado. Plan1 permite exactamente los tres exports antiguos; plan2
   exige exactamente cuatro, añadiendo portal.backup.aes con cabeceraCOMOSP01.
7. Transporte mantiene límite agregado1GiB y las precondiciones/generaciones,
   cuatro descargas completas, ACK y cleanup exacto. No crear otro scheduler.
   El source.json público puede registrar la identidad no secreta del portal
   para que recovery tenga un expected_portal independiente. Nunca env/ref hashes.
8. Usar campos explícitos backup_decryption_key_exported=false,
   plaintext_exported=false, portal_credentials_archived_encrypted=true.
9. Restore físico posterior: ambos ciphertext del mismo run descargados de sus
   generaciones; B02 en DB nueva congelada, cápsula en directorio nuevo, portal
   aislado, ambos códigos y archivos verificados y limpieza de ensayo acreditada.
   Las pruebas locales o una descarga íntegra no sustituyen ese ensayo.

No se tocaron los archivos del WT ni se cambió el formato de backup/restore B02.


## Integración del controlador y actualización revisada

Plan1 sigue exportando exactamente COMOSB02 + source.json + backup.json. Plan2
requiere `portal_backup` (las ocho refs/identidades de adopción más state_path
fijo `/opt/mcl-portal/state` y UID1000) y exactamente cuatro exports al agregar
COMOSP01. Plan3 usa el mismo contrato de cuatro exports y exige runtime_stage
CORE_PREPARED (5 contenedores) u OPERATING (8–11), runtime_projection_version=2.
La proyección estable incluye Id/Image/Name/Config/HostConfig/Mounts y redes
NetworkID/Aliases ordenados/GwPriority. Cada operación además registra en privado
el digest completo v1 (State5 y NetworkSettings enteros) antes/después: permitir
reinicios legítimos entre runs no autoriza un cambio durante el backup.

Root mantiene los cuatro locks existentes y comparte un deadline total1500s;
las llamadas Docker consumen lo que quede, la cápsula tiene además máximo120s.
Verifica refs Root y adopción/plan, CID/Image/name/network/env/bindstate, hace probe
inmutable de los diez PDF antes de copiarlos, y revalida bytes e identidad. Corre
el helper fijado por hash como archivo RO, mantenimiento existente, UID0,
network none/read-only/cap-drop ALL + sólo DAC_READ_SEARCH/no-new-privileges,
state y tres refs RO. DAC_READ_SEARCH permite que UID0 lea state UID1000/0700
y SQLite600 sin conceder DAC_OVERRIDE; debe verificarse en Linux real. El único
stdin contiene el mínimo RAM; no monta el socket, no usa env-file ni pasa clave
por argumentos. El report privado sella el sandbox propio para cleanup limitado
por conjunto/bytes/hash/inode; una preparación incompleta incierta se conserva.

`prepare_reviewed_controllers(...)` y alias `install_reviewed_controllers(...)`
requieren manifest Root600 con ref3 bajo private/controller-approvals, candidato
RELEASE.json ligado al SHA, hashes CAS de la pareja anterior y refs3 exactas de
los tres tools revisados. Nunca acepta calculando automáticamente nuevos pins.
El manifest cerrado contiene schema_version=1/source_sha/before_plan_sha256/
before_adoption_sha256/runtime_stage/tools. Los nombres exactos son
b02-backup-root.py, b02_backup_contract.py, b02-portal-capsule.mjs. Source SHA del
B02 canónico, imágenes, claves/refs/storage/bucket/schedule quedan preservados.

La función instala tools con histórico/journal y retorna plan_bytes/adoption_bytes
exactos sin escribir la pareja. El publisher conserva los cuatro FD-locks hasta
CAS/journal/readback y llama `mark_pair_applied(...)`; no reserializa esos bytes.
Una instalación parcial deja la pareja anterior intacta y rechaza nuevos backups
por drift, hasta reconciliación explícita. Esta función no restaura snapshots ni
habilita consumidores por sí misma.

El transporte verifica exactamente cuatro downloads completos por generación,
la cápsula y COMOSB02 con cabeceras distintas, y suma todos los exports <=1GiB.
El custody receipt liga ambas piezas al mismo run/plan, versión2 y metadatos
públicos cerrados del portal. Root ACK requiere ese receipt y bytes exactos antes
de marcar SUCCEEDED. restore_verified sigue false hasta recuperación externa real.

La integración debe añadir en CI `node --disable-warning=ExperimentalWarning
--test tests/ci/test_b02_portal_capsule.mjs` después de setup-node para FULL, y los
nuevos paths a BACKUP_DELIVERY. La instalación Root y los pins de transporte se
actualizan mediante un candidato revisado y el publisher; no mediante Cloud
Shell editando tools ni copiando archivos sueltos sin manifest autorizado.
