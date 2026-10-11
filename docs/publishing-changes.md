# Introducir cambios y publicarlos

Para el bootstrap V7 con Actions sin presupuesto, consultar la
[publicación manual canónica con FULL de Cloud Build](cloudbuild-canonical-local-release.md).
Registra el paquete local y el UUID nativo por separado y mantiene la revisión
Root. La adaptación sigue en validación: no representa CI automático ni cierre
de la dependencia de protección de rama privada.

Guía de trabajo de Commerce OS. Contrato V5 comprobado contra el workflow, los scripts y el release139af485 el14-sep-2026. Los antecedentes de publicación se conservan en CI/CD.

**Recorrido habitual:** implementar en una rama `codex/...` → probar → revisar y llevar a `main` → esperar CI/CD → comprobar el cambio en producción. GitHub construye y transfiere las imágenes; el Mac sólo necesita permanecer disponible mientras se trabaja localmente.

Accesos: [producción](https://commerce-os.inovaris.online) · [ejecuciones de CI/CD](https://github.com/MarioB19/commerce-os/actions/workflows/ci.yml) · [pull requests](https://github.com/MarioB19/commerce-os/pulls) · [arquitectura y recuperación](ci-cd.md).

La copia recuperada requiere la [selección api-web y adopción inicial comprobada](copy-api-web-publication.md)
antes de su primera publicación. El CI omite secreto/instalación de portal y
conserva consumidores apagados. Comprobar `deployment_scope` en el reporte:
`SUCCEEDED` api-web acredita ese alcance y no readiness full o comercial.
La [transición inicial del portal](adr-copy-portal-initial-transition-2026-10-07.md)
añade `portal-copy` para el destino recuperado: API/web seguido del portal, con
recibos y backup/locks preservados. Sólo tras su éxito, volver a api-web y leer el
nuevo hash B02. Full permanece bloqueado; no cambiar selección ni usar esta
opción como sustituto de autenticación, conciliación o prueba física.

La [continuidad de consumidores en la copia](adr-copy-runtime-deployment-2026-10-08.md)
agrega `copy-runtime`, sujeto a revisión FULL, paquete exacto y aprobaciones Root
privadas. Primero instala API/web con cinco servicios y las migraciones nuevas
revisadas; `CORE_PREPARED`/`PREPARED_ACTION_REQUIRED` permite ejecutar cancelación
y cuarentena mediante API y conserva los consumidores apagados. La continuación
del mismo SHA toma hold compatible, revalida las barreras y adopta ocho servicios.
Sólo `OPERATING` con readback completo acredita ese alcance técnico. La provisión
posterior de gateways requiere el administrador canónico y reconciliación CAS
explícita de Root/B02; tampoco acredita vinculación, entrega o venta física.
Esta ruta está implementada localmente y pendiente de instalación en este corte.
Actualización09-oct: `7af948a3` ya completó `OPERATING` mediante el procedimiento
de incidente, separado del workflow fallido por financiación. La
[corrección del monitor](adr-operational-metric-writer-2026-10-09.md) permite
únicamente67→68 desde OPERATING: historial instalado exacto, revisión Root del
nuevo SHA, backup fresco, captura/hold, parada y drain antes de aplicar0068,
readback completo antes de activar y conservación del approval de red original.
No reutiliza la aprobación de un SHA anterior ni modifica migraciones aplicadas.
La [revisión Root del paquete](adr-copy-runtime-root-approvals-2026-10-08.md)
separa observación de sellado explícito; sus recibos privados no son prueba de
instalación. El [primer gateway y reutilización](adr-initial-pilot-and-capacity-reuse-2026-10-08.md)
conservan identidad e historial y requieren lectura física autenticada, CAS y
backup posteriores. Un gateway nuevo vacío no recupera autenticación histórica.
La [aprobación de adopción del piloto](adr-initial-pilot-adoption-approvals-2026-10-08.md)
observa el arranque, HTTP local y PROVISION verificados, y sella por separado el
manifest Root/B02 con el hold nuevo. Su aprobación no ejecuta la reconciliación
ni sustituye el backup y restore posteriores.

## 1. Pedir un cambio al asistente

Copiar y completar este texto cuando el cambio deba publicarse:

> En Commerce OS, implementa [cambio concreto]. El resultado esperado es [comportamiento y criterios de aceptación]. Lee el índice del proyecto, AGENTS.md, docs/publishing-changes.md y docs/ci-cd.md. Revisa la rama y el trabajo en curso; conserva los cambios ajenos. Implementa y verifica con pruebas proporcionales al riesgo. Autorizo publicar este cambio de software mediante el CI/CD existente en main. Sigue la ejecución de su commit hasta comprobar el resultado en producción y actualiza la documentación. La operación comercial conserva sus autorizaciones propias.

Si sólo se necesita preparar el cambio, sustituir la autorización de publicación por «Déjalo implementado y probado en una rama para revisión».

## 2. Preparar el trabajo

El repositorio local es `commerce-os-app/`, dentro del proyecto Commerce OS. Ejecutar los comandos siguientes desde esa carpeta. Sustituir `mi-cambio` por un nombre breve y único.

```sh
git status --short
git branch --show-current
git fetch origin
```

Con el árbol limpio, empezar desde el `main` remoto:

```sh
git switch -c codex/mi-cambio origin/main
```

Si hay otro trabajo en curso, conservarlo y usar una carpeta independiente:

```sh
git worktree add -b codex/mi-cambio ../commerce-os-mi-cambio origin/main
cd ../commerce-os-mi-cambio
```

Para desarrollo y pruebas locales: Node según `.node-version`, pnpm según `package.json`, Docker y GitHub CLI autenticado. En el Mac actual, el Node configurado para este proyecto se selecciona así:

```sh
export PATH="$HOME/.local/share/commerce-os-toolchain/node_modules/.bin:$PATH"
node --version
pnpm --version
gh auth status
pnpm install --frozen-lockfile
```

Primera preparación local, con Docker funcionando:

```sh
pnpm local:setup
pnpm db:migrate
pnpm bootstrap
pnpm exec playwright install chromium
```

Los worktrees comparten la configuración local privada de este Mac: coordinar procesos y puertos si ya hay otra aplicación o E2E en marcha. Los comandos locales anteriores preparan desarrollo; la publicación productiva la ejecuta GitHub.

## 3. Implementar y verificar

Durante la edición, ejecutar las comprobaciones relacionadas con el cambio. Para un cambio de aplicación, esta es la secuencia de referencia antes de publicarlo:

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm test:integration
pnpm test:e2e
```

Cuando se modifiquen publicación, base de datos o recuperación, incluir también las verificaciones correspondientes:

```sh
python3 -m unittest discover -s tests/ci -p 'test_*.py'
pnpm test:recovery
pnpm audit --audit-level high
```

V5 selecciona por impacto: narrativa/borradores ligeros, portal propio, web o regresión amplia. El gate final estable exige conclusión exitosa de los checks requeridos sobre el commit. `pnpm verify` agrupa tipos, lint, build, unitarias, integración y E2E; recuperación, pruebas Python y auditoría son pasos adicionales del workflow.

Las migraciones nuevas se añaden en `packages/db/migrations/` con el siguiente número libre. Los nombres y hashes de las ya aplicadas son inmutables: el instalador rechaza su modificación o eliminación. Actualizar la documentación y los criterios de prueba del comportamiento afectado.

Para documentación exclusivamente, comprobar contenido, enlaces y `git diff --check`; no es necesario reconstruir imágenes localmente.

## 4. Publicar el cambio revisado

Revisar y añadir sólo los archivos del cambio. `git add -p` permite seleccionar modificaciones de archivos existentes; los nuevos se añaden con `git add -- ruta/del/archivo`.

```sh
git diff --check
git diff
git add -p
git diff --cached
git commit -m "feat: describir el cambio"
git push -u origin HEAD
```

En GitHub, crear un pull request de esa rama hacia `main`, indicando comportamiento y validación. Esperar los checks, revisar el diff final y fusionar cuando la publicación esté autorizada. Es un recorrido recomendado para revisión, no una protección de rama afirmada por esta guía. Un push autorizado directamente a `main` activa el mismo pipeline; no hace falta ejecutarlo manualmente además.

| Cambio/evento | Resultado del workflow actual |
|---|---|
| Push a rama sin PR | No dispara suite. |
| PR borrador / PR listo | Ligero / validación por impacto; sin publicación. |
| Aplicación, dependencias, scripts, infraestructura o workflow pendientes en `main` | Verificación y paquete en paralelo; después despliegue. |
| Sólo documentación o tests, con la aplicación ya desplegada | Verificación; `package` y `deploy` quedan omitidos. |
| Documentación en `main` con aplicación aún pendiente, o sin historial productivo disponible | Puede desplegar: se compara con el último despliegue exitoso. |
| Run workflow `mode=verify` | Verifica sin desplegar, incluso en main. |
| Run workflow `mode=release` en main | Publica sólo cambios pendientes desde el último deploy exitoso; dedupe por SHA. |

La selección exacta vive en [ci-changes.py](../scripts/ci-changes.py). No usar `[skip ci]` en cambios de aplicación. No usar `[skip ci]`: los cambios narrativos reciben comprobaciones ligeras y el gate estable.

## 5. Seguir la ejecución correcta y comprobar el resultado

Después de integrar el cambio, consultar el SHA que llegó a `main` y buscar su ejecución, en vez de elegir cualquier ejecución reciente:

```sh
deploy_sha=$(gh api repos/MarioB19/commerce-os/commits/main --jq .sha)
gh run list --workflow ci.yml --branch main --commit "$deploy_sha" \
  --limit 5 --json databaseId,headSha,status,conclusion,url
```

Elegir el `databaseId` devuelto y asignarlo a `run_id` (sustituir `RUN_ID` por ese número):

```sh
run_id=RUN_ID
gh run view "$run_id" --web
gh run watch "$run_id" --exit-status --interval 20
gh run view "$run_id" --json headSha,conclusion,jobs
```

Un CI correcto de una rama no acredita publicación. Para un cambio de aplicación, comprobar que **deploy terminó en success** y que el resumen muestra `Deployment SUCCEEDED` para el SHA esperado. El transporte privado usa el draft tag `ci-deployment-<run>-<attempt>` y el asset `deployment.tar.gz`, que contiene `release/deployment.json`: release, SHA, migraciones, servicios, paridad HTTPS y conservación de infraestructura.

Abrir producción, iniciar sesión y probar el recorrido específico que cambió. Registrar SHA, enlace del run, resultado de esa prueba y cualquier limitación en `docs/PROGRESS.md`; guardar sólo evidencia sanitizada en `docs/evidence/` y actualizar el índice del vault cuando corresponda. Un `readyz` correcto verifica disponibilidad, no toda la funcionalidad nueva.

**Operación tras publicar:** la primera publicación del [contrato de continuidad](real-launch-continuity.md) usa el congelamiento anterior e invalida autorizaciones. Las publicaciones posteriores compatibles emplean un hold transitorio sin cambiar la revisión comercial; sólo se recupera cada número tras recibo de aislamiento, salud e identidad. Comprobar `/v1/settings/launch?environment=REAL` después del deploy y resolver cada cuenta que no diga `OPERANDO`. Publicar software no vincula teléfonos ni inicia campañas o mensajes.

La primera ejecución completa validada tomó **13 min 33 s**: pruebas 8 min 16 s, paquete paralelo 2 min 27 s y job deploy 5 min 9 s. Es una referencia medida, no un tiempo garantizado. [Evidencia](evidence/ci-cd-production-validation.json).

## 6. Resolver un fallo sin rehacer pasos innecesarios

```sh
gh run view "$run_id" --log-failed
```

| Señal | Siguiente acción |
|---|---|
| Falla `verify` | Corregir el test o comportamiento, comprobarlo y publicar el nuevo commit por el mismo recorrido. |
| Falla `package` | Revisar Docker/build/manifiesto. El paquete todavía no se instaló. |
| `SUPERSEDED_COMMIT` o «Reject a superseded commit» | Seguir el nuevo SHA de `main`; el job antiguo se protege de publicar una versión superada. |
| Google rechaza la condición OIDC | Comparar los IDs, subject, `main`, workflow y entorno con la configuración documentada; corregir el desajuste sin ampliar permisos. |
| Fallo/timeout de SSH después de iniciar systemd, o estado remoto desconocido | Consultar unidad e informe remoto antes de reintentar: el instalador puede haber continuado. |
| `INSUFFICIENT_FREE_DISK`, hashes o migraciones incompatibles | Resolver la causa indicada; no borrar respaldos ni alterar migraciones para forzar el paso. |
| `IDENTITY_PROXY_*` o `HTTPS_IDENTITY_HEADERS_FAILED` | Revisar la política del bloque Commerce y cualquier divergencia entre Caddy activo y archivo. El helper se detiene ante ambigüedad, conserva otros sitios y revierte si falla la recarga; no forzar el cambio sobre configuración ajena. |
| `HTTPS_DEVICE_ROUTE_*` | Comprobar que `/creative-device/v1/*` conserva su prefijo y llega a `commerce-api:3001`. Un GET debe responder410JSON `PLATFORM_PRODUCTION_RETIRED`; HTML200 indica que cayó en el sitio web. El smoke no crea pairing ni jobs. |
| `INSTALLER_FAILED` o comprobación posterior fallida | Consultar el log privado y la configuración anterior; seguir la recuperación documentada. No hay rollback de base automático. |

Si sólo falló infraestructura temporal, se corrigió la causa, `main` sigue en el mismo SHA, el paquete de esa ejecución sigue disponible y se comprobó que no hay instalación en curso, reintentar los jobs fallidos:

```sh
gh run rerun "$run_id" --failed
gh run watch "$run_id" --exit-status --interval 20
```

GitHub conserva el SHA y la referencia originales al reintentar; por eso un run antiguo no publica un `main` nuevo. [Documentación oficial de reintentos](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).

Si el SHA cambió o el artefacto expiró, usar el run del nuevo commit. Para volver a publicar deliberadamente el `main` vigente:

```sh
gh workflow run ci.yml --ref main -f mode=release
```

`mode=credential` es una operación administrativa distinta y acotada al issuer V5 del SHA ya desplegado. Omite changes/verify/ci-gate/package/deploy, conserva el workflow_ref OIDC de ci.yml y nunca equivale a `mode=release`. Input y recibo cifrado siguen el [procedimiento privado de credenciales](v5-credential-bootstrap.md).


Seguir el ID de la nueva ejecución. Los artefactos de verificación de PR duran 7 días. Los paquetes e informes privados usan drafts y no expiran automáticamente; conservar release vigente, rollback y respaldo antes de retirar un draft. Las instrucciones de acceso excepcional al VPS, logs y recuperación están en [CI/CD: fallos y recuperación](ci-cd.md#fallos-y-recuperación).

## Cómo ahorrar tiempo en los siguientes cambios

- Usar el pipeline existente. La construcción productiva, transferencia, respaldo e instalación ya están automatizados.
- Agrupar un cambio coherente por publicación; los pushes sucesivos pueden cancelar pruebas o paquetes anteriores y sustituir su despliegue pendiente. Una instalación iniciada no se cancela.
- Reutilizar las cachés de pnpm/BuildKit del workflow. No actualizar dependencias o invalidarlas sin que el cambio lo requiera.
- Probar el caso afectado durante la edición y ejecutar la validación completa sobre la versión final. No repetir pruebas locales ya aprobadas si no hubo cambios relevantes.
- Reservar Cloud Shell y el instalador manual para configuración inicial o diagnóstico de incidentes. No repetir la creación de identidad OIDC en cada publicación.

Fuentes de verdad: [workflow](../.github/workflows/ci.yml), [selección de cambios](../scripts/ci-changes.py), [cliente de despliegue](../scripts/deploy-ci-client.py) y [verificación en VPS](../scripts/deploy-ci-vps.py). Esta guía describe el comportamiento implementado; actualizarla cuando esos contratos cambien.

### Historial de ownership antes de publicar OPERATING

El publicador prepara ownership-attestations bajo el directorio privado antes
de prepare y de los cambios de runtime. Sólo acepta0700 y propietario del
controlador Root; rechaza enlaces y entradas inseguras sin repararlas. Este
prerrequisito previene el fallo de atestación posterior a activate, pero no
reconcilia por sí mismo una publicación fallida ni libera el hold.
