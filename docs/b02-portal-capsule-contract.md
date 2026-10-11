# Contrato CLI/API — COMOSP01

Todos los controles se guardan privados0600 en padre privado0700 del owner del
proceso. En producción ese owner es Root; las pruebas reales usan el UID del
usuario local sin mocks de metadatos. `custody_root` es un ancla física, propiedad
del owner y sin escritura de grupo/otros. Los padres interiores tienen esa misma
custodia; state_directory es la excepción explícita del state_uid. El caller
Root verifica también los padres exteriores del ancla y el ámbito autorizado.
No hay un modo de test que relaje estos controles.

Uso: `node b02-portal-capsule.mjs create|verify|restore|cleanup CONTROL_PATH`.
Sólo create/verify/restore leen el mínimo87bytes de stdin; debe cerrarse stdin.
Cleanup no necesita clave. Un argumento extra falla. No usar key/env en argv.
El import exporta createCapsule/verifyCapsule/restoreCapsule/cleanupOwned/
cleanupRestored/readMinimum/uniqueJson; los tokens de cleanup son datos privados.

## Create (campos exactos)

- schema_version:1
- run_id: GitHub run-attempt, ambos enteros positivos
- plan_sha256:64hex, pin del plan externo
- deadline_epoch_ms: timestamp entero, futuro y máximo120s restante
- custody_root: directorio físico absoluto
- scratch_parent, output_parent, pdf_directory: directorios físicos privados0700
  dentro del ancla; output_parent debe carecer de portal.backup.aes
- state_directory: directorio físico privado0700 dentro del ancla
- state_uid: UID esperado de estado, entero0–2147483647; producción1000
- portal: source_sha40hex, run_id, image sha256:64hex, proxy_network y tres ref3
  report_ref/runtime_env_ref/manifest_ref

Ref3 tiene exactamente path absoluto físico, bytes entero positivo y sha256.
Files son regulares, owner del proceso,600 y nlink1, con lectura NOFOLLOW por FD
y firma estable dev/inode/tamaño/tiempos/owner/mode/nlink. La referencia se relee
antes del éxito. Los tres perfiles deben concordar en SHA/run/image/red.

Runtime env es el formato ordenado exacto del instalador existente. Campos
admitidos: MCL_ACCESS_DB, MCL_RELEASE_SHA, MCL_SESSION_SECRET,
MCL_CORE_CODES_SHA256, MCL_KIT_CODES_SHA256, NEXT_PUBLIC_SITE_URL y los cuatro
contactos públicos opcionales. Se exige secreto64hex, listas de hashes64hex
disjuntas/sin duplicados, origen ciclo.inovaris.online y ruta de SQLite fija.
El reporte debe ser ORIGIN_READY, conservar otros contenedores/sitios,
private_pdfs_verified10 y vincular el digest privado del manifiesto.

## Verify/restore (campos exactos)

- schema_version:1, run_id, plan_sha256, deadline_epoch_ms
- custody_root, scratch_parent
- ciphertext_ref: ref3 del ciphertext completo, privado600/nlink1
- expected_portal: exactamente source_sha/run_id/image/proxy_network,
  procedentes de source/custody externos verificados
- destination: exactamente scratch_parent/portal-restore-<run_id>

Verify no crea ese destino. Restore rechaza un destino existente y nunca cambia
current real, proxy, Docker, PostgreSQL ni autorizaciones. El CLI guarda una receta
hermana `portal-restore-<run>.cleanup.private.json`600 y devuelve sólo su ruta;
el controller lee/sella la ref en privado, sin publicar sus hashes internos.

## Cleanup (campos exactos)

- schema_version:1, run_id, deadline_epoch_ms, custody_root, scratch_parent
- cleanup_record_ref: ref3 sellada del archivo hermano anterior

La receta debe tener un root exacto, los dos directorios exactos y los miembros
permitidos. Firma de nacimiento de cada archivo, bytes/hash y conjunto entero
deben concordar antes de borrar. La receta se conserva si algo cambió.

## Bounds

| Límite | Valor |
|---|---|
| Suma de archivos privados |32MiB|
| Snapshot SQLite / cada source DB-WAL-SHM |16MiB|
| Cada PDF |8MiB|
| Runtime env |16384bytes|
| Reporte/manifiesto/control |1MiB|
| Manifiesto interno cifrado |256KiB|
| Ciphertext máximo |32MiB+256KiB+48bytes|
| JSON profundidad |24|
| SQLite filas |50000; lectura limitada a50001|
| Deadline restante máximo |120s, dentro del deadline externo|

Miembros exactos: current.json, runtime.env, portal-manifest.json, los diez nombres
de PDF incluidos en PDF_NAMES y, si PRESENT, access-attempts.sqlite. Restore añade
un capsule-manifest.json privado para readback. Se obtienen14 miembros privados
cuando SQLite está presente o13 cuando no está inicializado; ninguno es público.

Las salidas CLI contienen únicamente estado, run, referencia del ciphertext,
conteos/booleanos y ruta de receta privada. No imprimir el retorno interno de
restoreCapsule ni sus tokens. Error CLI: STOP_PRESERVE + código constante, sin
stack ni valores de entrada. Código1 para error y2 para deadline forzado.

Los buffers de clave del helper se ponen a cero. Las cadenas transitórias del
parser permanecen en RAM gestionada por JavaScript; no se afirma borrado seguro
de todas las copias internas ni protección frente a Root/memory dump.


## Cierre operativo pendiente

El helper local pasa pruebas auténticas de create/verify/restore/cleanup con WAL;
los tests de Root/IAP/GCS son contratos con fronteras simuladas. No prueban que
Cloud guardó cuatro objetos ni que un mount Linux RO funciona con la SQLite viva.
La aprobación operativa exige instalar los hashes revisados, ejecutar un run con
plan2/3, recuperar por generación los cuatro exports y custody.json, validar
custodia coetánea y ejecutar COMOSB02 restore existente + COMOSP01 verify/restore
con la llave original leída en RAM en un host/sandbox privado externo. Ambos
resultados deben referir el mismo run/plan. Comparar PostgreSQL/assets y los diez
PDF/env/current/manifest y SQLite restaurados; demostrar limpieza propia. No
promover current/env/CID históricos: la reinstalación legítima deriva un nuevo
runtime y aprueba su nueva identidad. SQLite NOT_INITIALIZED o reset de
rate-limit se reporta como tal; no sustituye recuperar códigos/secreto.

La receta de limpieza CLI se reserva O_EXCL antes del plaintext. Una receta ya
existente, symlink o hardlink bloquea antes de restaurar y queda preservada. Toda
la cápsula se autentica/valida antes de extraer sus datos; una reserva vacía propia
se elimina por inode sólo si sus bytes están comprobados tras un fallo.
