# Bootstrap manual de Cloud Build y publicación verificable del estado

Estado 10-oct-2026: implementación local, sin corrida cloud ni estado GitHub
publicado. Este bootstrap permite probar Cloud Build antes de conectar GitHub.
No cierra F0: ADR-V7-11 también exige triggers PR/main, una sola admisión/publicación
y demostración de PR fallido bloqueado y correcto aprobado. Actions mantiene USD 0.

## Ruta mínima sin entregar credenciales GitHub al worker

1. Superar primero el control económico total: infraestructura existente, transición,
   CI, almacenamiento, tráfico e impuestos dentro de USD 100 mensuales, con créditos
   suficientes. Ni habilitar una API ni tener créditos prueba ese control.
2. Desde la identidad Google autorizada, habilitar Cloud Build y preparar una SA
   dedicada `commerce-v7-verify`, repositorio Artifact Registry `commerce-ci` y bucket
   privado de fuentes CI. No reutilizar el bucket B02. La SA de verificación necesita
   logging, lectura del repositorio del verificador y lectura del bucket de fuentes;
   permisos en esos recursos, sin Editor/Owner, Secret Manager, Compute, IAP ni GitHub.
   Revisar también permisos heredados. El constructor de la imagen confiable usa
   otra identidad con escritura sólo en ese repositorio. Son cambios de bootstrap,
   no concesiones que deban repetirse por release.
3. Construir y probar la imagen de `infra/cloudbuild/Dockerfile.verify` desde código
   revisado, registrar su digest y el SHA256 del runner incluido. El código de una PR
   no elige ni reconstruye su verificador. El daemon y la red del worker son accesibles
   por los tests; no constituyen aislamiento frente a código hostil. Esta configuración
   sólo admite candidatos revisados/confiables hasta disponer de admisión apropiada.
4. Resolver el SHA candidato mediante GitHub y conservar su `tree.sha`. Preparar en
   un directorio privado desechable un checkout superficial **autocontenido** del
   commit real, con `.git/objects`, HEAD y checkout concordantes. Puede hacerse con
   `git init` y `git fetch --depth=1` desde el repositorio local ya actualizado; no se
   necesitan credenciales en ese checkout. Desactivar hooks/configuración heredada.
   No copiar el checkout de trabajo, su `.git` de worktree, configuraciones globales,
   hooks, logs, homes, `.env` ni archivos ignorados. Comprobar SHA/tree y estado limpio.
5. Generar un `.tgz` explícito de ese directorio, incluyendo el `.git` saneado, y sellar
   su SHA256. El `.gcloudignore` predeterminado excluye `.git`; enviar `.` sin preparar
   esta fuente no sirve. Un `git archive` tampoco contiene metadatos Git. Registrar
   antes del submit los hashes del TAR, workflow candidato, runner confiable y la
   configuración JSON revisada con las sustituciones reales. No fabricar un commit
   distinto con el contenido de un archive.
6. Ejecutar una sola vez `gcloud builds submit ARCHIVO.tgz --config CONFIG.json
   --region REGION --gcs-source-staging-dir gs://BUCKET-CI/source --async`, con proyecto
   y cuenta explícitos. `CONFIG.json` es `verify.yaml` convertido fielmente a JSON,
   con `_VERIFY_IMAGE` por digest y `COMMIT_SHA` exacto. El SDK soporta ese built-in
   mediante `--substitutions` o la configuración; no usar nombres/URLs inventados
   de Actions. Guardar UUID y `source.storageSource` devueltos. El SDK crea un objeto
   staged nuevo y fija su generación, incluso cuando la entrada era otra URL GCS.
7. Releer el objeto staged, comprobar su hash contra el TAR sellado y completar el
   manifiesto local con UUID/bucket/objeto/generación. No reconstruir el manifiesto
   confiable desde un JSON producido por el candidato. Preservar intent, respuesta y
   hashes ante resultado incierto; consultar el UUID antes de volver a enviar.
8. Cuando termine, ejecutar el publicador sin `--publish`: lee proyecto, commit/tree
   de GitHub, Build nativo y recibo FULL en Cloud Logging. Sólo tras una validación
   completa, repetir con `--publish` para publicar el Commit Status del SHA exacto.
   El proceso local usa la autenticación existente de `gh`; no exporta su token al
   TAR, imagen, Cloud Build, logs ni Secret Manager.

Los formatos se basan en [builds submit](https://docs.cloud.google.com/sdk/gcloud/reference/builds/submit),
[gcloudignore](https://docs.cloud.google.com/sdk/gcloud/reference/topic/gcloudignore),
[Build/SourceProvenance](https://docs.cloud.google.com/build/docs/api/reference/rest/v1/projects.builds)
y [SA dedicada](https://docs.cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts).
El SDK local también fija `StorageSource.generation` del objeto staged; no se infiere
la generación de una fecha, filename o SHA.

## Contrato del publicador

`scripts/cloudbuild-publish-status.py` se ejecuta desde una copia revisada y confiable
fuera del worker. El manifiesto JSON es una entrada de confianza controlada por ese
publicador; su hash detecta cambios accidentales, no firma ni autentica a su autor.
No ejecutar el publicador procedente de una PR no revisada junto a credenciales.

Campos del manifiesto schema 1:

| Campo | Origen confiable |
|---|---|
| `repository`, `project`, `region` | Destino autorizado; repo/proyecto están fijados en código. |
| `source_sha`, `source_tree` | Commit auténtico y tree comparados de nuevo con GitHub. |
| `archive_sha256` | Bytes del TAR local sellados antes del submit. |
| `verifier_image`, `runner_sha256` | Imagen revisada por digest y runner incluido, no valores elegidos por el candidato. |
| `workflow_sha256` | `.github/workflows/ci.yml` del commit candidato revisado. |
| `build_config` | JSON completo enviado: steps, serviceAccount, timeout, queueTtl, options, substitutions. |
| `build_config_sha256` | SHA256 de JSON con keys ordenadas y separadores `,`/`:`; función `canonical_hash`. |
| `build_id`, `storage_source` | UUID y bucket/object/generation del submit, cotejados con el archivo staged. |

La configuración conserva placeholders `$PROJECT_ID`/`$BUILD_ID` y escapes `$$` de
Cloud Build. Las sustituciones son exactamente `COMMIT_SHA` y `_VERIFY_IMAGE` con
valores reales. El validador acepta el template nativo o su expansión equivalente;
rechaza pasos adicionales, env distinta, `allowFailure`, secretos, otra SA, máquina
mayor, trigger o configuración no contemplada. Una respuesta nativa nueva se debe
examinar y cubrir con un test; no relajar validación para conseguir verde.

Para `success` exige estado y paso nativos SUCCESS, generación resuelta idéntica,
SHA256 del TAR en `sourceProvenance.fileHashes` (bytes base64, no MD5/CRC32C), imagen,
runner, workflow y SHA/tree esperados, y los 21 gates FULL PASSED/exit 0 en orden.
Lee un único recibo terminal del build en Cloud Logging. El recibo de workspace por
sí solo nunca basta; tampoco se considera una atestación resistente a un candidato
hostil con acceso al daemon. La confianza en la admisión y el código revisado sigue
siendo necesaria, como se explica en el [ADR del runner](adr-v7-cloud-build.md).
La consulta usa una ventana explícita de 90 días para evitar el límite predeterminado
de un día de `gcloud logging read`; no cambia ni acredita la retención configurada.
Si el recibo ya no existe, el publicador falla cerrado.

Sin `--publish` todas las llamadas externas son lecturas. Con ese flag, un build
nativo fallido/cancelado/timeout produce `failure`, uno en curso `pending`, y sólo
la reconciliación completa produce `success`. Un desajuste de identidad/procedencia
no publica nada. Después del POST se relee el estado creado; una respuesta incierta
se declara `OUTCOME_UNKNOWN` y no se reintenta automáticamente.

```bash
python3 scripts/cloudbuild-publish-status.py --manifest /RUTA-PRIVADA/manifest.json --gcloud /RUTA-SDK/gcloud
python3 scripts/cloudbuild-publish-status.py --manifest /RUTA-PRIVADA/manifest.json --gcloud /RUTA-SDK/gcloud --publish
```

Es un **Commit Status** llamado `Commerce V7 Cloud Build gate`, no el check de
Actions ni un Check Run de GitHub App. Usuarios con push pueden crearlo; GitHub
permite exigir commit statuses al proteger ramas. Antes de afirmar bloqueo de merge,
comprobar que el plan y permisos del repo privado permiten protección, instalar la
regla autorizada y demostrar su comportamiento. No pagar un plan nuevo por inferencia.
[Statuses API](https://docs.github.com/en/rest/commits/statuses#create-a-commit-status)
· [Protección de ramas](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

## Automatización pendiente y límite de este bootstrap

La conexión nativa GitHub de Cloud Build necesita una instalación de su GitHub App
y autorización de la cuenta. Si ya existe instalación y secreto autorizador válidos,
`gcloud builds connections create github` permite completar la conexión por CLI con
esas referencias. Si no existen, el propio comando devuelve enlaces de autorización
e instalación en el navegador. Un 403 de `gh api user/installations` con un token de
otra clase no prueba que la App no esté instalada. Inspeccionar el estado real antes
de declarar dependencia humana.

El token autorizador de esa conexión pertenece al control plane/service agent; la
SA que ejecuta tests no recibe acceso a ese secreto. Seleccionar únicamente este
repositorio. Configurar los triggers desde una configuración confiable, fuera del
contenido de la PR, con control de duplicados/concurrencia/presupuesto. Si la UI exige
conceder acceso nuevo, seguir la política de esa herramienta en el punto concreto
de autorización; no convertir la investigación o bootstrap CLI en un bloqueo previo.
[Conexión GitHub](https://docs.cloud.google.com/build/docs/automating-builds/github/connect-repo-github?generation=2nd-gen)
· [CLI de conexión](https://docs.cloud.google.com/sdk/gcloud/reference/builds/connections/create/github).

La publicación nativa de estados de triggers y el envío opcional de logs a GitHub
tienen configuración propia; observar su nombre/app/resultado real antes de fijar
el required check. No activar sharing de logs indiscriminadamente: Google documenta
que habilitar data sharing no es reversible. El bootstrap local no acredita ese
trigger ni debe convertirse silenciosamente en un CI dependiente del Mac.
[Integración de triggers/status](https://docs.cloud.google.com/build/docs/automating-builds/github/build-repos-from-github).

El siguiente incremento canónico de release requiere un contrato por proveedor
para `ci-changes.py:software_installation`, `ci_private_artifact.py:identity` y
`deploy-ci-client.py`, además de sus pruebas: UUID nativo, selección/baseline,
artefactos e instalación con identidad explícita. No mapear UUID a un run Actions
ficticio ni modificar los instaladores para saltar sus guardas. Este bootstrap
no cambia esos archivos ni publica software productivo.

Validación local: 16 pruebas del publicador aprobadas el 10-oct; respuestas nativas
sintéticas, sin llamadas cloud ni estados reales publicados. La compatibilidad con
un build auténtico sigue pendiente y debe quedar evidenciada antes de uso operativo.
