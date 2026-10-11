# Publicación manual canónica con FULL de Cloud Build

Estado: código local y pruebas de contrato; instalación y validación nativa del
commit integrado pendientes. No representa cierre de F0 ni CI automático.

La ruta conserva el instalador `copy-runtime`, sus migraciones revisadas,
backups, custodia Root, holds y locks. Cloud Build prueba FULL; el publicador
local construye el paquete. Esa distinción queda registrada en `RELEASE.json`
y GitHub como `package_origin=canonical-local`. El portal conserva su SHA
anterior y su imagen real en el manifiesto de componentes del informe Root.

## Preparar sin instalar

Trabajar desde el commit limpio exacto que aprobó FULL, después de integrar
estos cambios. Un FULL de `cd4527b` prueba sólo ese commit y no autoriza instalar
el nuevo código. Conservar el manifiesto de admisión del bootstrap bajo
`~/.local/share/commerce-os-release-custody` (directorio 0700, archivo 0600,
ancestros propios/Root sin escritura de grupo u otros, sin symlinks/hardlinks).
La ruta de custodia es fija para mantener un único lock del publicador.

```sh
python3 scripts/cloudbuild-prepare-local-release.py \
  --verification-manifest "$HOME/.local/share/commerce-os-release-custody/full.json"
```

Sin `--package` sólo revalida evidencia nativa y fuente local. Para construir
las cuatro imágenes Linux/amd64 y sellar el paquete, añadir `--package` y
`--admission-output "$HOME/.local/share/commerce-os-release-custody/release.json"`.
La salida debe ser nueva; no se sobrescriben admisiones existentes. El límite
local es 30 minutos. No se envían credenciales como build args ni mounts.

El resultado es `release/commerce-os.tar`, su checksum y una admisión protegida
que enlaza FULL, SHA/tree, hash del packager, bytes/hash del tar y hash de
`PACKAGE.sha256`. El lector compara además todos los bytes fuente enviados con
el árbol Git del commit, vuelve a leer FULL nativo y rechaza el árbol sucio.

## Revisión Root e instalación

Usar las operaciones de observación y sellado de
`copy-runtime-approvals.py` descritas en [publicación](publishing-changes.md).
La identidad es `cv-<UUID-FULL>-<intento-positivo>`; no se utiliza
`GITHUB_RUN_ID`. La igualdad de lectores incluye `ci_provider_evidence.py`.
Los permisos, revisión explícita del digest observado y custodia del paquete
siguen siendo obligatorios; los hashes no emiten aprobaciones por sí mismos.

El transporte existente reconoce `COMMERCE_CLOUD_RELEASE_ADMISSION` y
`COMMERCE_INSTALLATION_ATTEMPT`. Exige `COMMERCE_DEPLOY_PAUSED=false` explícito,
scope `copy-runtime` y el destino autorizado de `deployment_scope.py`. No admite
variables `GITHUB_SHA`, `GITHUB_RUN_ID` o `GITHUB_RUN_ATTEMPT` mezcladas. Conservar
`RUNNER_TEMP` privado para su clave SSH efímera. El transporte revalida FULL y
el paquete antes de transferir y conserva el rechazo de un main superado.

Este documento no activa la publicación. La despausa y la ejecución sólo
ocurren cuando el orquestador haya completado los gates del SHA integrado.

## Registrar una instalación ya terminada

```sh
python3 scripts/cloudbuild-publish-installation.py \
  --admission "$HOME/.local/share/commerce-os-release-custody/release.json" \
  --attempt 1
```

Reconsulta FULL, el tar local y el informe protegido mediante IAP/Root. El
collector exige unidad systemd terminal, release actual, imágenes Docker
instaladas, recibo `SUCCEEDED/OPERATING` y portal preservado. Relee HTTPS del
core y del portal. El acceso IAP usa una sola clave efímera que limpia por sus
bytes exactos; no concede IAM ni instala software. Sin `--publish` no escribe
en GitHub. Con `--publish`, crea Deployment y status con URL del UUID real de
Cloud Build, luego verifica ambos por API. Un resultado parcial se concilia;
no se repite automáticamente una publicación incierta.

`ci-changes.py` sólo reconoce ese baseline mediante su callback de verificación
nativa/custodia. Sin él devuelve baseline desconocido y conserva FULL. El
worker verificador no recibe acceso a la VM para resolver el baseline. Un JSON
del workspace, un payload GitHub o un estado verde aislado no bastan.

La rama de paquete nativo `cloud-build` conserva su contrato y lector para un
incremento posterior. Aún requiere workflow productor, generación/hash reales
del artefacto y validación de ambos UUID. La admisión y Root rechazan su
publicación con `NATIVE_CLOUD_PACKAGE_PUBLICATION_NOT_ENABLED`.

Véanse [ADR de procedencia](adr-v7-cloud-build-release-provider.md),
[bootstrap](cloudbuild-bootstrap.md) y [CI/CD](ci-cd.md). La protección de rama
privada que respondió 403, los triggers PR/main y la prueba PR fallido/bueno
siguen pendientes; esta publicación manual no los sustituye.
