# ADR V7 — Instalación canonical-local con arranque durable diferido

Agente: Claude · 17-oct-2026 · rama `claude/v7-b02-renewal`. Autorizado por
Brandon en el chat el 17-oct-2026 (opción A). Complementa
`docs/cloudbuild-canonical-local-release.md`, `docs/adr-v7-durable-host-boot.md`
y la guía de la ventana `docs/v7-fase-c-runbook.md` (§5 y §6.9).

## Contexto

`docs/publishing-changes.md` y `docs/cloudbuild-canonical-local-release.md` fijan
la publicación `canonical-local` como la ruta del arranque V7. Esa ruta consiste
en un FULL nativo de Cloud Build, un paquete armado localmente desde el árbol
exacto, las aprobaciones Root (`observe`/`seal`) y el transporte
`deploy-ci-client.py`. El código integrado en `7e59446` la cerró sin quererlo:

1. `deploy-ci-client.py`: con admisión de nube exigía siempre el adaptador del
   publicador nativo (`CANONICAL_WORKER_BOOT_ADMISSION_REQUIRED`) y su archivo
   `release/host-boot-inputs.json`.
2. `deploy-ci-vps.py`: `copy-runtime` exigía un id `cb-` (paquete nativo). Un
   paquete `canonical-local` usa `cv-<UUID del FULL>-<intento>`.
3. Al terminar en `OPERATING`, `commit_stage` instala siempre el arranque
   durable (`runtime_boot_install.install`). Su compuerta exige:
   - un paquete nativo (`package_origin == 'cloud-build'`);
   - una restauración histórica de B02 con las mismas migraciones y las mismas
     8 herramientas de restauración que el candidato
     (`runtime_boot_restore_gate.validate_candidate_compatibility`).

   La restauración histórica sale de una corrida B02 cuyo `source_sha` es la
   versión instalada. Para la V7, que añade 49 migraciones (68 → 117) y cambia
   `b02_backup_contract.py` y `b02-backup-root.py`, esa restauración no puede
   existir antes de instalarla.

La cadena nativa (paquete y publicador en Cloud Build) nunca se ha ejecutado.
Le faltan:
- el compositor de tareas PACKAGE/PUBLISH;
- el IAM del publicador sobre la VM;
- la cubeta de artefactos;
- la custodia del publicador.

Aun con todo eso, chocaría con el punto 3.

## Decisión

- Un paquete `canonical-local` (`cv-`) se instala con `copy-runtime` sin entrada
  de arranque:
  - el cliente lo transporta sin adaptador nativo y sin `host-boot-inputs.json`;
  - el VPS lo acepta con 7 argumentos.
- Un paquete nativo (`cb-`) conserva todos los requisitos: adaptador del
  publicador, archivo de arranque con su hash y 8 argumentos. Un id heredado de
  GitHub Actions sigue rechazado para `copy-runtime`.
- En `OPERATING`, si el reporte trae `provider_evidence.package_origin ==
  'canonical-local'` y un id `cv-` válido, `commit_stage` no llama al
  instalador del arranque. Registra
  `host_boot = {status: HOST_BOOT_DEFERRED_CANONICAL_LOCAL,
  installation_verified: false, reason: NO_NATIVE_PACKAGE_BOOT_ADMISSION,
  run_id, units_changed: 0}`. El resto del contrato no cambia:
  - par Root aplicado con CAS;
  - marca nativa de B02;
  - guardia final;
  - reporte `SUCCEEDED` solo al final.
- No se instala, cambia ni habilita `commerce-runtime-boot.service`. La máquina
  conserva el arranque de la versión anterior.

## Lo que se conserva

- El FULL nativo y su atestación sobre el SHA exacto de `main`.
- La revalidación del árbol fuente, el hash del paquete y la admisión protegida
  bajo `~/.local/share/commerce-os-release-custody`.
- Las aprobaciones Root (`copy-runtime-approvals.py observe` y `seal`).
- Los cuatro candados, el respaldo previo, las migraciones revisadas, el regreso
  y el rechazo de un `main` superado.

## Costo y riesgo aceptados

- Producción confía en un paquete armado por el operador y no por Cloud Build.
  Es exactamente lo que ya permitía la ruta `canonical-local`. La revisión del
  digest en las aprobaciones Root sigue siendo obligatoria.
- El arranque durable (parte de RNF-03.c, ya diferida por D-16) queda pendiente.
  Tras un reinicio, la VM se comporta como con `80a6`.

## Cómo se cierra lo diferido

- Después de la V7, el primer B02 con las herramientas V7 y su restauración
  aislada dejan la restauración histórica compatible.
- Una publicación nativa posterior (`cb-`) sin migraciones nuevas instala el
  arranque.
- Si esa publicación añade migraciones, el mismo problema reaparece. Hace falta
  una operación Root separada de «instalar arranque para la versión actual».
  Queda como trabajo posterior a la V7.

## Verificación

- `tests/ci/test_copy_runtime_pair_cas.py`:
  - `canonical-local` registra el arranque diferido sin llamar al instalador;
  - una falla de la guardia final nunca publica `SUCCEEDED`;
  - el diferido exige origen local e id `cv-` a la vez.
- `tests/ci/test_cloudbuild_release_provider.py`:
  - el cliente transporta `cv-` sin archivo de arranque;
  - una admisión `cb-` sin adaptador falla antes de crear la llave;
  - el VPS acepta `cv-` con 7 argumentos y rechaza `cv-` con 8, `cb-` sin
    archivo de arranque y un id heredado.
- Suite Python de CI completa: 1,816 pruebas.
