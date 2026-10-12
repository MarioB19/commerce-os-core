# CI/CD de Commerce OS

La [adaptación manual V7 con FULL de Cloud Build](cloudbuild-canonical-local-release.md)
añade procedencia explícita sin simular un run Actions. Está en validación local;
no activa despliegues ni acredita triggers/protección de rama. El SHA integrado
requiere sus propios gates nativos antes de instalar.

Para el trabajo cotidiano: [introducir cambios y publicarlos paso a paso](publishing-changes.md). Incluye preparación, pruebas, publicación, seguimiento por commit, reintentos y un texto para iniciar futuras tareas.

**Contrato vigente: V5.** La selección por impacto, retiro de producción creativa y operación de credenciales se describen en «Contrato V5 vigente». El [registro de entrega](v5-delivery-matrix.md) distingue validación local y publicación comprobada.

La [primera publicación de API/web sobre la copia recuperada](copy-api-web-publication.md)
añade selección cerrada `COMMERCE_DEPLOY_SCOPE`, adopción inicial autenticada y
backups frescos sin arrancar consumidores. Su preparación local no es un recibo
de seis servicios ni una transición comercial. El tuple legado conserva el flujo
full; la copia exige api-web y su estado privado comprobado.
La [transición inicial de portal](adr-copy-portal-initial-transition-2026-10-07.md)
ofrece `portal-copy` sólo para esa copia. Completa API/web y portal en un mismo
run, conserva el recibo nativo de cada fase y exige ambos resultados antes de
aceptar éxito. No habilita full ni consumidores. El estado posterior v2 conserva
el portal durante API/web y requiere continuidad de cinco runtimes en B02.

La [publicación acotada de consumidores](adr-copy-runtime-deployment-2026-10-08.md)
extiende la adopción a Root v3 y B02 plan3 mediante `copy-runtime`. Una primera
preparación de cinco servicios no es una instalación completa ni un baseline de
software exitoso. Tras cancelación y cuarentena canónicas, la continuación del
mismo paquete adquiere un hold comprobado por imagen y pruebas concurrentes,
repite los gates y verifica ocho servicios antes de liberar sólo ese hold.
La [cápsula cifrada del portal](b02-portal-capsule-contract.md) agrega env, hashes
de códigos y SQLite mediante snapshot nativo y valida sus diez PDFs de imagen.
Root liga state/plan con CAS y cuatro locks; los recibos de backup/credenciales
y CORE_PREPARED no cuentan como software OPERATING. Implementación local;
instalación, backup real de la nueva cobertura y ensayo de restauración pendientes.

Actualización09-oct: la transición `7af948a3` a OPERATING está instalada y leída
nativamente. El candidato correctivo de
[métricas del monitor](adr-operational-metric-writer-2026-10-09.md) conserva
65→67/CORE_PREPARED y añade sólo67→68 desde OPERATING. El publicador comprueba
el RELEASE instalado contra DB y perfil privado, sella sólo0068 y conserva la
procedencia original de la red. La transacción SQL va después de hold, parada
de ambos workers y ausencia de operaciones en vuelo; requiere68 hashes antes
de activar. Un fallo conserva hold y reporte de reconciliación, sin inventar
rollback de datos ni éxito. B02 y Root se actualizan juntos con los controles
vigentes. La corrección aún requiere su propio paquete e instalación.

Incremento local Números/grupos (19-sep): `verify` dispone de hasta 90 minutos para incluir el recorrido completo por MCP hasta el día 15, recuperación y E2E. Es un timeout, no una duración prometida. La prueba MCP tiene un máximo de 45 minutos y respeta rate limits. El banco sintético de dos horas se ejecuta por separado siguiendo [la guía de Números](numbers-operations.md); conservar su informe y evaluación junto al candidato. No dispara publicación ni sustituye la comprobación del cliente Codex instalado.

## Baseline de software separado de respaldos y credenciales · 07-oct-2026 UTC

El selector compara contra una instalación de software comprobada. Un estado
`success` del entorno `production` también puede proceder de `backup` o
`credential`, y por sí solo no acredita que se haya instalado una aplicación.
Los registros automáticos requieren la URL productiva y el job `deploy`
completado con éxito del workflow Commerce OS CI/CD, del mismo repositorio,
run y SHA. `changes` dispone de `actions: read` para comprobar ese job, además
de sus permisos de lectura de contenido y deployments.

Las instalaciones canónicas de incidentes conservan elegibilidad cuando su
payload incluye `installer_status=SUCCEEDED`, SHA del origen, hash del archivo,
run/attempt de instalación y verificación; el enlace debe corresponder al run
del mismo repositorio. Esto conserva recibos de instalación independientes de
un run Actions fallido por financiación. Ante evidencia ausente, malformada o
no observable se usa baseline desconocido y verificación/release conservadores.

El run37685513423 terminó SUCCESS pero no construyó ni instaló: había elegido
el respaldo exitoso37677791719 como baseline del mismo SHA. Se conserva ese
resultado como NO INSTALLATION. La corrección pasó316 pruebas Python CI; una
consulta de sólo lectura del historial real descartó el respaldo, recuperó el
recibo de software9418cf57 y seleccionó FULL/deploy para la aplicación pendiente.
CI del cambio e instalación siguen pendientes en este corte.

## Pausa temporal de publicación y reparación de auditoría · 07-oct-2026 UTC

`COMMERCE_DEPLOY_PAUSED` es una variable de repositorio con valores cerrados: vacío/`false` conserva los gates habituales; `true` omite sólo `package` y `deploy`. Un valor distinto falla en `changes` antes de leer el evento, consultar GitHub o producir outputs. La selección conserva diff completo, alcance FULL y necesidad de release; el resumen distingue publicación pausada de publicación comprobada. `verify`, auditoría, `ci-gate`, `backup` y `credential` conservan sus condiciones.

Root estableció y releyó `true` en GitHub a08:45:46UTC; `production` no tiene override. El gate sigue local en esta revisión. Sólo Root libera la pausa tras main FULL/audit verde, primer B02 CI con custodia, transición SMTP deshabilitada y adopción efectiva con scope `api-web`; después ejecuta release del main exacto y comprueba paquete, instalación y HTTPS/API. La pausa no autoriza omitir auditoría ni modificar pauta o inventar publicación.

El arreglo mantiene la versión mayor de cinco dependencias: MCP SDK1.31.0 (root y app), Nodemailer10.0.6, proxy-addr2.0.8, brace-expansion5.0.11 y source-map-js1.2.2. El override acotado de Nodemailer también sustituye10.0.0 fijado por smtp-server. Lock congelado y auditoría local `--audit-level high` pasan: cero high/critical, ocho moderate pendientes. Tipos/lint/build,249PythonCI y535unitarias/65archivos pasan; las integraciones dirigidas account-security, numbers-mcp-retirement (SDK STDIO) y v5-launch-api-mcp (InMemory) pasan22pruebas/3archivos. El banco STDIO de15d fue interrumpido localmente con salida130 y no recibe crédito de PASS; su cobertura FULL permanece en CI. Ambos FULL CI anteriores terminaron FAILURE sólo por auditoría, después de aprobar integración/recovery/E2E. No acredita nuevo FULL CI verde, publicación o backup CI.

## Incidente Actions y publicación Flujo/Calentamiento v2 · 20-sep-2026 UTC

Brandon aceptó expresamente la validación local completa como gate de este release. El SHA `3de8b13fd3451e034847f9bfbe0c92b5a5642793` se integró por fast-forward para conservar exactamente el árbol validado. El run `35525885616` de `main` no inició runners por el presupuesto de Actions; verify/package/deploy quedaron omitidos y el workflow permanece FAILURE.

Se reconstruyeron cuatro imágenes `linux/amd64` desde el checkout limpio, el empaquetador canónico selló SHA, 59 migraciones y siete archivos web, y `deploy-ci-client.py`/`deploy-ci-vps.py` se ejecutaron sin modificaciones con la identidad Google existente. No se cambió presupuesto, IAM, scopes, checks o branch protection. El paquete no se subió a GitHub: se transfirió únicamente al VPS productivo. Resultado `SUCCEEDED`, release `ci-35525885616-1-3de8b13fd345`: seis servicios, migraciones 0058/0059 por hash, paridad HTTPS, infraestructura/tres gateways preservados, REAL congelado y cero llamadas a proveedor.

La relectura pública confirmó API lista, OpenAPI 3.0.3 con 307 paths y portal del mismo SHA con 480 actividades. GitHub Deployment `6555681531` registra la instalación manual canónica separada del run fallido. La revisión MCL v4 quedó regenerada, pero el catálogo y los assignments REAL no se aplicaron sin una aprobación específica de publicación de contenido. [Recibo](evidence/sales-flow-warmup-v2-publication.json).

## Incidente Actions y publicación Números · 20-sep-2026 UTC

GitHub no inició Commerce CI gate porque agotó el presupuesto de Actions; deploy quedó SKIPPED. Se resolvió como incidente con la autorización Google existente, el paquete sellado de ese run y los instaladores canónicos sin modificar. Resultado SUCCEEDED: seis servicios, 57 migraciones, HTTPS por hash y sesiones/gateways conservados. El workflow sigue FAILURE por presupuesto; no se alteró ningún check, presupuesto, rol o scope. El despliegue real quedó registrado separadamente en GitHub (6549461250), exigiendo los checks verify/package exitosos.

[Informe](evidence/numbers-publication.json) · [Causa del fallo remoto](evidence/numbers-actions-budget-incident.json). La API de [deployments](https://docs.github.com/en/rest/deployments/deployments) conserva el registro de la instalación real; no modifica el resultado del workflow. El baseline productivo vuelve a ser 2a6e4fbd para seleccionar correctamente futuros cambios narrativos. Presupuesto Actions pendiente; no se aumentó ni se contrataron recursos.

La limpieza canónica de llaves intentó un fingerprint distinto del ID OS Login. Se conciliaron las claves exactas y se retiraron por ID; ambas ausencias verificadas y claves ajenas preservadas. [Recibo de limpieza](evidence/numbers-incident-access-cleanup.json). No reutilizar una identidad incierta para borrar llaves.

El transporte de respaldo y publicación usa ahora el ID leído del perfil OS
Login de su identidad autenticada, tras una coincidencia única de material
público. Verifica después ausencia y conservación de las otras claves; no
recalcula fingerprints desde el archivo original. El cierre B02 distingue
errores de discard-export y OS Login; no reintenta operaciones inciertas.

## Antecedentes de publicación anteriores a V5

Estado al 07-sep-2026 UTC: operativo y validado. **Publicado y verificado el 07-sep-2026:** [CI/CD 34138553520](https://github.com/MarioB19/commerce-os/actions/runs/34138553520) instaló `637a94c` como `ci-34138553520-1-637a94c385f3`. Pasaron 80 unitarias, 164 integraciones (+1 QR optativa omitida), 37/37 E2E en una ejecución completa, 39 pruebas Python, tipos/lint/build, recuperación y auditoría. Se comprobaron seis servicios sanos, 22 migraciones, infraestructura preservada, paridad HTTPS y cabeceras de identidad `no-store`/`no-referrer`. El recorrido productivo confirmó Ventas, Mapa/Pasos, vendedores y confirmaciones de desvincular/eliminar; catálogo y configuración SMTP versión 2 se conservaron. REAL permanece congelado; la recuperación por correo conserva la activación autorizada en su tarea de seguridad. [Evidencia productiva](evidence/integrated-production-publication.json).

Antecedente histórico de instalación inicial: La [ejecución 34074099013](https://github.com/MarioB19/commerce-os/actions/runs/34074099013) publicó `03461af9fd5c84a13452f0db63f1cd9258cdee5b`; el release de esa ejecución fue `ci-34074099013-1-03461af9fd5c`. Pasaron pruebas, empaquetado, identidad temporal, transferencia IAP, respaldo B02 e instalación. Se comprobaron seis servicios sanos, 18 migraciones, cinco archivos web por HTTPS y conservación exacta de los contenedores de infraestructura observados. Ocho comprobaciones HTTPS posteriores verificaron también catálogo y acceso administrativo. [Evidencia productiva](evidence/ci-cd-production-validation.json) · [Verificación de acceso](evidence/ci-cd-account-verification.json).

Duración observada de esta ejecución: 13 min 33 s en total; verificación 8 min 16 s, empaquetado paralelo 2 min 27 s y job de despliegue 5 min 9 s. Dentro de ese último job, el instalador del VPS tomó aproximadamente 1 min 57 s. Son mediciones de esta ejecución, no garantías para las siguientes.

Cada push con cambios de aplicación a `main` ejecuta **Commerce OS CI/CD**. Las ramas sin PR no disparan la suite; los PR verifican por impacto. Los cambios únicamente de documentación no generan despliegue. En Run workflow seleccionar verify o release; release deduplica el main ya publicado.

La comparación se hace contra el último despliegue productivo exitoso, no contra el push anterior. Si llega documentación mientras hay aplicación pendiente, el nuevo commit conserva esa publicación pendiente. Sin historial productivo conocido, se construye conservadoramente. Los jobs de verificación/empaquetado superados se cancelan; una instalación en curso no se cancela.

1. Verificación: tipos, lint, build, unitarias, integración, recuperación, E2E y auditoría de dependencias.
2. En paralelo se construyen las cuatro imágenes Linux/amd64, incluido el portal Mi Ciclo Listo, con caché de dependencias y BuildKit. Cada build recibe el SHA exacto y lo conserva en el label OCI `org.opencontainers.image.revision`; el empaquetador rechaza las cuatro imágenes si el label falta o no coincide con `HEAD`/`GITHUB_SHA`. También se comprueban plataforma, migraciones y archivos web; el artefacto privado lleva commit y checksums.
3. Sólo si ambos jobs pasan, el job production obtiene identidad temporal de Google, transfiere el paquete por IAP y verifica que `main` no lo haya superado.
4. El VPS valida el archivo y su manifiesto, crea respaldo B02 mediante el instalador existente y actualiza el núcleo. systemd mantiene el proceso aunque se corte SSH. Un lock local y la concurrencia de GitHub evitan instalaciones superpuestas.
5. El helper `update-identity-proxy.py` conserva las políticas de identidad y el prefijo retirado de dispositivo en el proxy existente; compara, respalda, valida y recarga sin recrear infraestructura ni otros sitios. El smoke V5 exige410 JSON `PLATFORM_PRODUCTION_RETIRED` en ese prefijo. Se verifican imágenes, seis servicios, migraciones, hold REAL retirado, revisión comercial preservada si aplica, archivos web por HTTPS y cabeceras de identidad. El portal se comprueba por separado mediante su `/api/version`. El reporte se conserva en el draft privado `ci-deployment-<run>-<attempt>` con manifiesto y hashes.

No hacen falta Docker en el Mac, subir archivos a Cloud Shell ni iniciar manualmente el instalador para cada cambio. La primera compilación llena la caché; las siguientes reutilizan capas. Los tiempos se deben tomar de las ejecuciones reales, no se promete una duración fija.

### Aislamiento del ensayo de calendario en integración

`pnpm test:integration` sin argumentos ejecuta dos grupos secuenciales: todos los
archivos salvo `numbers-mcp-stdio.test.ts`, y después ese archivo. Cada grupo
recibe una base nueva con sus migraciones; todos los archivos se ejecutan una
vez. Así, los workers globales del ensayo de quince días no vuelven a procesar
pools y outbox que dejaron otras pruebas. El ensayo conserva su API HTTPS/MCP,
cuotas reales, calendario, assertions y límite de 45 minutos. Un fallo de
cualquier grupo conserva su base y hace fallar el comando, aunque el otro pase.
Las invocaciones con argumentos conservan su selección en una sola base nueva.
Esta separación requiere validación FULL del SHA candidato; una muestra local
parcial no acredita el calendario completo ni un ahorro de tiempo en la nube.

### Evidencia de pruebas fuera del árbol versionado

El gate FULL vuelve a leer `git status --porcelain --untracked-files=all` al
terminar todas las etapas. Una prueba que escribe en una ruta versionada hace
fallar el candidato con `SOURCE_TREE_NOT_CLEAN`, aunque todas sus assertions
pasen. Eso ocurrió en el FULL de `51f72e0`: E2E e integración escribían capturas
y JSON en `docs/evidence/`.

- Las pruebas escriben evidencia sólo con `tests/support/evidence.ts`
  (`evidencePath`, `evidenceLocation`). La raíz por defecto es `test-evidence/`,
  ignorada por Git y Docker. `COMMERCE_TEST_EVIDENCE_DIR` la cambia: una ruta
  absoluta, o relativa al repositorio bajo un prefijo ignorado
  (`test-evidence`, `test-results`, `.runtime`, `.local`). Cualquier otro destino
  dentro del repositorio se rechaza con `TEST_EVIDENCE_DIR_VERSIONED`.
- `tests/ci/test_test_evidence_contract.py` (etapa `python-ci`) falla si un
  archivo de `tests/` escribe con ruta literal en un destino no ignorado o vuelve
  a mencionar `docs/evidence`.
- `scripts/source-tree-guard.mjs` compara el estado Git antes y después de
  `pnpm test:integration` y `pnpm test:e2e`; si una suite deja archivos nuevos o
  modificados, el comando falla con `TEST_WROTE_VERSIONED_PATHS` y lista las
  rutas. Cubre también destinos dinámicos que el contrato estático no ve.
- `scripts/sanitize-test-artifacts.py` y el transporte privado de verificación
  incluyen la nueva raíz. La imagen verificadora no cambia: su driver ya exige el
  árbol limpio y la raíz por defecto queda ignorada sin variables nuevas.

## Contrato V5 vigente (2026-09-13)

Push sólo en main; las ramas reciben checks por PR, sin duplicar push+PR. PR borrador y narrativa: ligero. PR listo: impacto portal/web/full. Dependencias, base, auth, workflows, rutas desconocidas y diff incompleto siempre amplían. Los renombres cuentan ambos lados. `Commerce CI gate` es el check terminal estable: fallo, cancelación, missing o scope desconocido nunca pasan.

Dispatch tiene `mode=verify` (predeterminado, nunca despliega), `mode=release` (sólo main) y `mode=credential` (issuer V5 fijo, manual, sólo main ya desplegado; sin verificar, empaquetar ni desplegar). Selección de release compara último deployment success → candidato, preservando código pendiente antes de un push docs. El cliente comprueba main antes de instalar; el VPS deduplica el SHA bajo lock contra un informe exitoso del release actualmente instalado. Ante incertidumbre consulta informe/unidad remotos, nunca repite el instalador a ciegas. Verificaciones tienen contents:read; package/deploy poseen escritura; deploy y el job credential acotado usan OIDC desde el mismo ci.yml permitido por el trust existente. Credential tiene contents:write únicamente para custodiar el recibo cifrado en un draft privado `v5-credential-<run>-<attempt>`; verifica la descarga y no ejecuta publicación de software. Checks/paquetes obsoletos se cancelan; instalaciones se serializan y no se cancelan.

La fábrica web se retiró. [Contrato y recuperación](v5-platform-retirement.md). El smoke comprueba 410 JSON `PLATFORM_PRODUCTION_RETIRED` en el antiguo prefijo de dispositivo; archivo, almacenamiento compartido, identidad y portal permanecen. Runtime se prepara con lista explícita y prueba de que no incluye engine/productores.

Retención: artifacts de diagnóstico de PR fallidos 7 días; logs de main según la retención del repositorio; paquetes e informes de deploy en drafts privados, sin vencimiento automático. La consulta de manifests/hashes permite retirar manualmente un draft antiguo sólo después de respaldarlo y verificar que no sea release vigente, rollback o parte de una instalación incierta. No se añade limpieza recurrente. No se cambia protección ni se usa skip-ci.

Medición anterior observada de nuevo: run 34765290436, 1 run de main; verify 1127s, package 202s, deploy 313s (suma de jobs 1650s incluyendo changes8s), paquete 230430720 bytes. V5 final139af485, run34808456586:29min06s de duración total; verify1259s, package205s, gate8s, changes9s y deploy444s (suma de jobs1925s; parte corre en paralelo). Paquete230225920bytes:204800bytes menos que la base y30720 más que la primera V5053dd437. No demuestra un ahorro general ni menor duración. [Recibo posterior](evidence/v5-release-production-139af485.json). [Muestra](evidence/v5-ci-baseline.json).

## Acceso inicial

`scripts/setup-ci-identity.py` se ejecuta una vez desde Cloud Shell con los permisos ya autorizados. Configura el pool `commerce-os-cd`, proveedor `github` y cuenta `commerce-os-deploy`. La confianza exige IDs de repositorio y propietario, rama `main`, el archivo exacto de workflow y entorno `production`. OS Admin Login e IAP se limitan a la VM existente; el rol de consulta de proyecto sólo agrega los cuatro permisos de descubrimiento requeridos por gcloud. No se concede modificación de IAM a la identidad del pipeline.

El entorno GitHub `production` acepta sólo `main`. Sus variables son `GCP_PROJECT_ID`, `GCP_INSTANCE`, `GCP_ZONE`, `GCP_WORKLOAD_IDENTITY_PROVIDER` y `GCP_DEPLOY_SERVICE_ACCOUNT`. Son identificadores, no secretos. Las credenciales de Commerce, la llave de cifrado y los perfiles Meta/WhatsApp permanecen protegidos en el VPS. La llave SSH del runner caduca y se elimina al cerrar el job.

Configuración existente de referencia; se consulta en Settings → Environments → production del repositorio:

| Variable | Valor |
|---|---|
| `GCP_PROJECT_ID` | `vibe-conversa-prod` |
| `GCP_INSTANCE` | `vibe-conversa-prod` |
| `GCP_ZONE` | `us-east1-d` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/567993342760/locations/global/workloadIdentityPools/commerce-os-cd/providers/github` |
| `GCP_DEPLOY_SERVICE_ACCOUNT` | `commerce-os-deploy@vibe-conversa-prod.iam.gserviceaccount.com` |

El subject esperado es `repo:MarioB19@133941077/commerce-os@1359063164:environment:production`. La condición completa y el mapeo viven en [setup-ci-identity.py](../scripts/setup-ci-identity.py); no hay una llave de cuenta de servicio que copiar al repositorio.

Los repositorios nuevos usan [subjects OIDC con IDs inmutables](https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens/). La condición de este proveedor exige ese subject exacto, además de validar por separado ambos IDs, rama y workflow. El helper rechaza una configuración remota diferente en lugar de ensancharla automáticamente. La corrección inicial se aplicó y verificó en Google Cloud: cambió exclusivamente el subject antiguo por el formato observado de este repositorio. El [fallo inicial](evidence/ci-cd-initial-validation.json) se conserva como antecedente resuelto.

## Fallos y recuperación

Desde la corrección del incidente del 27-sep, preparación y activación tienen límites separados de 1200 segundos. La preparación carga imágenes y completa el respaldo antes de habilitar cualquier compensación del runtime. Cada fase conserva un journal `task-<fase>.json` y un log privado; un timeout termina el grupo de procesos y concilia sólo los contenedores y sesiones PostgreSQL identificados con ese intento. Si no puede probar su terminación, la recuperación queda bloqueada para evitar dos administradores compitiendo sobre la base. No restaura datos ni deshace migraciones. La compensación admite API detenida o retirada cuando existe evidencia privada de su imagen y conserva tanto la captura original como la del candidato. [Incidente, decisión y validación](deployment-recovery-20260927.md).

El log completo permanece en `/opt/commerce-os/private/deployments/<run>-<attempt>/install.log`; el informe sanitizado en `report.json`. El mismo directorio conserva `previous-release.env`. La release instalada queda en `/opt/commerce-os/releases/ci-<run>-<attempt>-<sha>`. Si falla el transporte después de iniciar systemd, consultar esa unidad y el informe antes de repetir; no borrar un paquete en uso.

Un reporte leído antes de consultar systemd puede quedar obsoleto mientras termina el instalador. El cliente debe confirmar que la unidad terminó, releer `report.json` y exigir estado `SUCCEEDED` o `FAILED`, además del SHA y run esperados. `RUNNING` no es un resultado terminal; `deactivating` sigue indicando trabajo de recuperación. Si el cliente falla pero el servidor terminó, conservar ambos informes y conciliar el SHA por HTTPS antes de decidir cualquier nueva instalación. [Incidente y regresión del reporte obsoleto](deployment-recovery-20260927.md#reporte-obsoleto-del-cliente--28-sep-2026-utc).

Para diagnóstico excepcional, desde una sesión autorizada de Google Cloud:

```sh
gcloud compute ssh vibe-conversa-prod --project=vibe-conversa-prod \
  --zone=us-east1-d --tunnel-through-iap
```

Dentro del VPS, sustituir `RUN_ID` y `ATTEMPT` por los valores del run afectado:

```sh
deployment_id=RUN_ID-ATTEMPT
sudo systemctl show "commerce-ci-$deployment_id.service" \
  --property=ActiveState,SubState,Result
sudo cat "/opt/commerce-os/private/deployments/$deployment_id/report.json"
sudo readlink -f /opt/commerce-os/current
```

El informe se actualiza al entrar a cada fase y al terminar; su ausencia no prueba que la instalación no se inició. systemd puede recoger la unidad al finalizar. Si falta el informe o indica error, inspeccionar `prepare.log`, `install.log`, `rollback.log`, los journals `task-*.json` y, cuando exista, el journal de esa unidad en la sesión privada; conservar los datos sensibles fuera de Git y notas.

Un fallo de hash, historial de migraciones, espacio o configuración bloquea antes de instalar. Un fallo posterior requiere inspección; puede conservar el `release_hold` activo o ejecutar rollback y dejar cuentas congeladas. No hay restauración destructiva ni rollback de esquema automático. Para regresar a imágenes compatibles se usa `scripts/release.sh rollback` con la configuración anterior desde su release original; r4 o anteriores están bloqueadas por incompatibilidad de política. El respaldo B02 no equivale a una nueva prueba de restauración.

La primera publicación del [relevo compatible](real-launch-continuity.md) usa el comportamiento r5 y requiere reautorización. A partir de una instalación que ya tenga el marcador y la migración 0062, el release instala un hold de despacho sin aumentar la revisión comercial; sólo recobra una cuenta con aislamiento, salud, identidad y permiso comprobados. Un binario incompatible conserva el congelamiento r5. El despliegue no inicia campañas ni modifica gasto publicitario. Gateway, sesiones, PostgreSQL y proxy quedan fuera de la recreación del núcleo.

No se poda automáticamente Docker ni se eliminan respaldos históricos: se exige espacio libre antes de instalar y se conservan releases para recuperación. La retención vigente se describe en el contrato V5 y en el transporte privado de artefactos; revisar almacenamiento del VPS conforme crezca.

Decisión: [ADR de CI/CD](adr-ci-cd-2026-09-07.md).

## Portal Mi Ciclo Listo · ampliación 13-sep-2026

La misma ejecución verifica `portals/mi-ciclo-listo`, empaqueta cuatro imágenes y aplica el portal después de verificar Commerce. `MCL_PORTAL_ENV` es configuración privada de ejecución (dos hashes de códigos, secreto de sesión y datos confirmados de soporte/privacidad); nunca entra en el build ni artefactos. El instalador valida entorno, hashes, capacidad y conservación de contenedores. La API `/api/version` del portal permite cotejar el SHA después del corte DNS. `ORIGIN_READY` en el reporte sólo acredita el origen, no el HTTPS del dominio; ese recorrido requiere verificación posterior.

Recuperación del portal: `/opt/mcl-portal/releases/<run>/previous.json` identifica contenedor e imagen anterior; cada `runtime.env` y copia Caddy se conserva privada. Un fallo al recargar el proxy revierte sus bytes únicamente si nadie más lo modificó. Se conserva el despliegue Vercel durante el traslado inicial y un respaldo local de sus nueve PDFs. No restaurar bases de Commerce ni modificar otros bloques DNS/Caddy para recuperar este portal.

La transición inicial desde el mantenimiento de la copia exige la opción bool
`allow_migration_maintenance=True` del instalador. Sólo permite reemplazar el
bloque 503 exacto `managed-mi-ciclo-listo-maintenance-20261006`; una diferencia
detiene la operación. El entorno privado debe incluir valores humanos confirmados
para `MCL_SUPPORT_EMAIL`, `MCL_PRIVACY_NAME`, `MCL_PRIVACY_ADDRESS` y
`MCL_PRIVACY_EMAIL`. La opción no omite validaciones de imagen, PDFs, capacidad,
conservación o rollback, ni acredita por sí sola acceso HTTPS y entrega física.


## Transporte privado de artefactos — 13-sep-2026

La cuota de Actions retrasó el cierre aun después de respaldar y retirar artefactos antiguos. En main el mismo CI guarda paquete e informe en releases draft del repositorio privado existente. V5 conserva la verificación en logs y elimina su duplicado pesado; los PR fallidos intentan conservar los artifacts de navegador durante 7 días; las verificaciones exitosas quedan en los logs obligatorios y el gate. Conserva verificación obligatoria, SHA/run, hashes de lectura posterior, OIDC, revisión de main vigente, respaldo e instalación. Los IDs y SHA256 del manifiesto aparecen en el resumen del job. Para recuperar: `gh release list --repo MarioB19/commerce-os`, elegir `ci-package-<run>-<attempt>`, y `gh release download <tag> --repo MarioB19/commerce-os`. Verificar `transport-manifest.json` y `commerce-os.tar.sha256` antes de usar. No hay caducidad automática de estos drafts; no retirarlos sin copia comprobada y conservar el último despliegue válido. [Decisión y permisos](adr-ci-private-release-transport-2026-09-13.md). Los PR fallidos mantienen Actions artifacts para diagnóstico. Desde el 20-sep, una verificación exitosa no duplica esos informes en la cuota de adjuntos; tipos, lint, build, pruebas, recuperación y auditoría siguen siendo obligatorios. Un fallo al ejecutar pruebas nunca se convierte en éxito por esta política de retención.

## Preservación de gateways · continuidad QR

El verificador compara IDs, imágenes, configuración por hash, arranque, políticas de reinicio y montajes de todos los gateways antes y después del deploy, incluidos los detenidos. Conserva autostart apagado. Instala el timer de respaldo frío; su lectura inicial no detiene gateways. El recibo añade `session_continuity` y `waha_backup`. El override privado de almacenamiento sólo existe después de una recuperación administrativa explícita. [Procedimiento](channel-session-continuity.md).
# Encrypted backup mode

`mode=backup` retains the legacy manual WIF/IAP path. The workflow has no cron;
the separate finite keyless B02 trigger is documented below. Manual backup skips
verify/package/deploy/credential, never reads
portal secrets, and serialize with production operations. A complete backup-only
push is verified FULL without incidental application installation; mixed/unknown
diffs and explicit release retain the existing behavior. See the [private plan,
custody and activation procedure](daily-b02-offsite.md). The implementation alone
does not enable the job, provision its bucket or prove a backup run.
