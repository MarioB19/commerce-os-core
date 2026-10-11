# ADR — Procedencia Cloud Build para publicaciones canónicas

Estado: implementación local; no habilita despliegues ni concede IAM. Fecha: 2026-10-10.

El verificador FULL de `cd4527b` no construye el paquete de publicación. Un build
verde, un status GitHub o un JSON del workspace no prueban una instalación.
La adaptación mantiene separadas verificación, paquete e instalación y exige el
mismo commit y árbol Git en sus enlaces. Un FULL de un commit anterior no sirve
para aprobar cambios posteriores del instalador o de estos lectores.

## Identidad y compatibilidad

Cloud Build conserva su UUID nativo. La primera publicación manual usa
`cv-<uuid-del-FULL>-<intento>` con `package_origin=canonical-local`. No contiene
`package_build_id`: el paquete fue construido y sellado localmente. La ruta de
paquete nativo futura usa `cb-<uuid-del-build-de-paquete>-<intento>`; el intento identifica una ejecución
del instalador, no un retry de Cloud Build. No se convierte el UUID a un número,
no se rellena `GITHUB_RUN_ID` y no se fabrica una URL de Actions. Un helper central
reconoce este namespace y la rama histórica numérica por separado.

La revisión de los consumidores encontró strings en rutas, nombres de systemd,
informes y metadata. `install-vps.sh` limita el run a 80 caracteres y
`apps/api/src/version.ts` limita el identificador público a 128. El UUID con
prefijo e intento acotado cabe en ambos. La conversión `int(job_link[1])` de
`ci-changes.py` pertenece exclusivamente al lector histórico de Actions. Los IDs
de simulaciones en PostgreSQL no son identificadores del instalador. Los
contratos de backups, credenciales y operaciones de gateways no se amplían.

La primera ruta Cloud Build acepta solamente `copy-runtime` en el destino ya
permitido por `deployment_scope.py`. No modifica el portal: el manifiesto de
componentes registra su SHA anterior, imagen, contenedor y referencias protegidas
de su instalación. Las cuatro imágenes del paquete siguen vinculadas al SHA
candidato; el portal empaquetado no se declara instalado.

## Cadena de evidencia

1. Un manifiesto de admisión bajo custodia del publicador fija el SHA/tree,
   configuración e imagen inmutable del verificador antes de ejecutar FULL.
   El lector reconsulta GitHub y Cloud Build, sourceProvenance y logs nativos.
2. Para el bootstrap manual, el publicador construye las cuatro imágenes con
   revisión OCI después de revalidar FULL; sella un tar y compara cada script,
   archivo de infraestructura y migración extraídos con el árbol Git exacto.
   El manifiesto local queda 0600 en
   `~/.local/share/commerce-os-release-custody`, con ancestros no escribibles por
   otros. Un lector nativo se vuelve a ejecutar antes de instalar o publicar.
   Para la futura ruta automática, un build de paquete separado recibe la misma fuente exacta y enlaza el UUID
   FULL. Construye las cuatro imágenes con revisión OCI y empaqueta los bytes.
   Su configuración e imagen/driver también deben estar admitidos. El worker no
   recibe acceso al destino, secretos productivos ni credenciales de GitHub.
3. En esa futura ruta, Cloud Build exporta el tar y su recibo al bucket privado de artefactos. El
   publicador verifica el resultado nativo, manifiesto de artefactos, generación,
   hash nativo y SHA256 de los bytes descargados. No acepta una ubicación ni un
   hash suministrados únicamente por el candidato.
4. Root conserva su revisión del paquete completo, igualdad de lectores,
   migraciones, respaldo, preservación del portal, locks y CAS. El contexto de
   proveedor se incluye en el manifiesto del paquete y se reconcilia con el ID
   de la instalación antes de cualquier mutación.
5. El publicador vuelve a leer el informe final bajo custodia Root y HTTPS. Sólo
   `SUCCEEDED` + `OPERATING` con los mismos SHA/paquete/componentes puede generar
   una instalación GitHub. FULL por sí mismo nunca produce ese registro.
6. El lector del baseline necesita una verificación autenticada del proveedor y
   del recibo de instalación. Sin ella devuelve baseline desconocido/FULL; un
   payload GitHub o archivo JSON del workspace no concede confianza.

Se conserva un único publicador y el lock canónico `ci-deploy.lock`. Preparar
admisión no autoriza instalar; `COMMERCE_DEPLOY_PAUSED=true` permanece vigente
hasta que el orquestador complete los gates y active la publicación autorizada.

## Comprobación y limitaciones

Las pruebas locales deben rechazar identidad cruzada, SHA/tree distinto,
paquete/recibo alterado, generación distinta, FULL incompleto, falso proveedor,
portal atribuido al SHA nuevo y recibos sin custodia. La ruta histórica conserva
sus pruebas. Ningún fixture demuestra un build o despliegue real.

Validación local del 2026-10-10: suite Python completa, 759 pruebas en 44,623 s,
`OK (skipped=2)`, incluidas 19 del contrato del proveedor y los guards históricos.
Los skips corresponden al límite Linux/Root del verificador y al caso Docker
Linux con opt-in; se deben cubrir en sus entornos correspondientes. Los cinco
módulos nuevos compilan y `git diff --check` pasa. Esto valida el código local;
el FULL nativo y la instalación del SHA final integrado siguen pendientes.

La rama `canonical-local` es la prioridad de esta adaptación. El lector puro
del paquete `cloud-build` queda como incremento, sin workflow productor ni
afirmación de disponibilidad. La admisión y Root lo rechazan explícitamente con
`NATIVE_CLOUD_PACKAGE_PUBLICATION_NOT_ENABLED`; sólo `canonical-local` puede
continuar por los nuevos hooks. La integración nativa de FULL, del formato real del manifiesto de artefactos y
de la publicación/lectura protegida debe comprobarse con ejecuciones auténticas
antes de declarar esta ruta operativa. Los triggers PR/main y la prueba de PR
fallido/bueno siguen siendo parte de F0.

El orquestador comprobó el 2026-10-10 que GitHub devuelve HTTP 403 al consultar
protección de `main`: el repositorio privado requiere un plan que admita esa
protección. No se contrató un plan ni se hizo público el repositorio. Por ello,
un status manual y el lock de publicación no satisfacen el requisito F0 de que
un PR fallido no pueda fusionarse. Esa dependencia sigue abierta. Tampoco se
aplicó el grant project-wide de Secret Admin rechazado por revisión automática;
la ruta manual FULL no depende de él.

Referencias: [Build API](https://docs.cloud.google.com/build/docs/api/reference/rest/v1/projects.builds),
[artefactos en Cloud Storage](https://docs.cloud.google.com/build/docs/building/store-artifacts-in-cloud-storage),
[ADR del verificador](adr-v7-cloud-build.md), [bootstrap](cloudbuild-bootstrap.md).
