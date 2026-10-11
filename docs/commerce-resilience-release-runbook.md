# Runbook manual — Commerce resilience UX

Este runbook publica sólo F0–F9. No escanea QR, no cambia identidad ni sesión, no inicia campañas, no envía mensajes, no autoriza REAL, no modifica gasto y no amplía capacidad física. F10 requiere otra autorización.

## 1. Preflight y baseline actual

Usa el worktree limpio y la toolchain fijada; no uses el checkout `commerce-os-app` si está rezagado o sucio.

```sh
: "${RELEASE_WORKTREE:?Set the isolated release worktree path}"
cd "$RELEASE_WORKTREE"
export PATH="/Users/example-user/.local/share/commerce-os-toolchain/node_modules/.bin:$PATH"
node --version
pnpm --version
git status --short
git rev-parse HEAD
git merge-base HEAD origin/main
```

No ejecutes `pnpm local:setup` sobre el volumen compartido: la protección detectó `MIGRATION_CHANGED:0046_channel_session_continuity.sql`. Para integración usa `node scripts/test-isolated.mjs ...`; para revisión de campañas usa `COMMERCE_CONFIG_DIR` temporal con `scripts/setup-campaign-review.mjs`.

Captura la línea base REAL sólo por GET. El PAT debe estar en almacenamiento protegido y tener rol owner; no se pasa como argumento ni se imprime.

```sh
umask 077
export COMMERCE_API_URL='https://commerce-os.inovaris.online'
IFS= read -r COMMERCE_SERVICE_TOKEN < /Users/example-user/.config/commerce-os-production/owner-api-20260915/decrypted/service-token
export COMMERCE_SERVICE_TOKEN
BASE_SHA="$(curl -fsS https://commerce-os.inovaris.online/api/version | node -e 'let body="";process.stdin.on("data",part=>body+=part);process.stdin.on("end",()=>{const sha=JSON.parse(body).sha;if(!/^[a-f0-9]{40}$/.test(sha))process.exit(1);process.stdout.write(sha)})')"
node scripts/commerce-resilience-readback.mjs snapshot > "/private/tmp/commerce-resilience-before-${BASE_SHA}.json"
unset COMMERCE_SERVICE_TOKEN
```

Revisa que el JSON diga `read_only: true`, que las siete rutas sean 200/HTML, que la política REAL esté congelada y que listas con 200 elementos queden `complete: false`. `provider_calls: NOT_OBSERVABLE_FROM_CORE_API` es un límite deliberado.

## 2. Gates focalizados y completos

Pruebas focalizadas de F7–F9:

```sh
pnpm exec vitest run --config vitest.config.ts tests/unit/version-route.test.ts
node --test scripts/tests/commerce-resilience-readback.test.mjs
python3 -m unittest tests.ci.test_install_vps tests.ci.test_core_version_readback
node scripts/test-isolated.mjs tests/integration/resilience-fault-injection.test.ts
pnpm exec playwright test tests/e2e/resilience-seven-routes.spec.ts --project=chromium
```

Después ejecuta la secuencia completa del repositorio, sin convertir fallos u omisiones en aprobado:

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm test:integration
pnpm test:e2e
python3 -m unittest discover -s tests/ci -p 'test_*.py'
pnpm test:recovery
node scripts/audit-ui.mjs
node scripts/audit-accessibility.mjs
```

Registra comando, inicio/fin, conteo, duración, resultado y omisión justificada en el manifiesto de evidencia. Las bases de `test:integration` son efímeras; nunca apuntan a producción ni al volumen local compartido.

## 3. QA visual y accesible manual

La suite crea capturas sintéticas durables en `docs/evidence/commerce-resilience-ux-20260921/ui/` para 1440 y 320, claro y oscuro. Revisa además cada ruta a 1024, 768 y 360.

Para cada ruta:

1. Completa la tarea primaria de la matriz sólo con fixture local.
2. Revisa jerarquía en un segundo, escala de grises, agrupación, espacio, tangencias, copy, loading, empty, error y stale.
3. A 200 % y 400 % de zoom verifica reflow sin pérdida ni scroll bidireccional.
4. Recorre por teclado desde “Saltar al contenido”; foco siempre visible, orden lógico y diálogos sin fuga.
5. Con VoiceOver verifica título, regiones, nombres, estados y cambios relevantes. Axe no acredita lector de pantalla.
6. Activa movimiento reducido y confirma que ninguna transición esencial dependa de animación.
7. Registra hallazgos y correcciones en el manifiesto; no declares WCAG completo.

## 4. SHA final, paquete e imágenes

Sólo después de gates verdes crea el commit/merge autorizados y fija la igualdad de SHA. Desde el checkout exacto:

```sh
FINAL_SHA=$(git rev-parse HEAD)
test -z "$(git status --porcelain)"
GITHUB_SHA="$FINAL_SHA" python3 scripts/package-ci.py --source-preflight
docker buildx build --platform linux/amd64 --load --provenance=false --build-arg SOURCE_SHA="$FINAL_SHA" --target runtime -t commerce-os:release -f infra/Dockerfile .
docker buildx build --platform linux/amd64 --load --provenance=false --build-arg SOURCE_SHA="$FINAL_SHA" --target web -t commerce-os-web:release -f infra/Dockerfile .
docker buildx build --platform linux/amd64 --load --provenance=false --build-arg SOURCE_SHA="$FINAL_SHA" --target maintenance -t commerce-os-maintenance:release -f infra/Dockerfile .
docker buildx build --platform linux/amd64 --load --provenance=false --build-arg SOURCE_SHA="$FINAL_SHA" -t mi-ciclo-listo-portal:release -f portals/mi-ciclo-listo/Dockerfile portals/mi-ciclo-listo
GITHUB_SHA="$FINAL_SHA" GITHUB_RUN_ID="$MANUAL_RUN_ID" python3 scripts/package-ci.py
sha256sum --check release/commerce-os.tar.sha256
```

`MANUAL_RUN_ID` debe ser el run de `main` asociado al SHA, aunque Actions esté bloqueado antes de ejecutar. Cada imagen debe llevar `org.opencontainers.image.revision=$FINAL_SHA`; el empaquetador rechaza labels ausentes o distintos antes de crear el tar. El manifiesto `RELEASE.json` y `/api/version.sha` son la autoridad; `release` es sólo un identificador humano.

## 5. Snapshot B02 y despliegue bajo lock

Antes de instalar captura B02 sanitizado: release actual, imágenes, servicios, migraciones, volúmenes/gateways, sesiones, política y contadores REAL. No guardes nombres de sesión, teléfonos, llaves ni mounts privados sin sanitizar.

La release anterior reescribe `updated_at` de efectos `BLOCKED` aun estando congelada: dos lecturas GET separadas por 47 s conservaron payload, estado e intentos, pero cambiaron el hash de fila completa. Por eso la línea base de la sección 1 sirve para diagnóstico, no para el gate estricto del corte. Con paquete, credenciales y SHA ya validados, detén **sólo** el `channel-worker` anterior bajo el mismo lock, conserva API y gateways, y captura entonces la línea base final. Esta pausa es parte del corte; no escanea QR ni reintenta efectos.

```sh
export PATH="/Users/example-user/.cache/commerce-v5-gcloud/google-cloud-sdk/bin:/Users/example-user/.local/share/commerce-os-toolchain/node_modules/.bin:$PATH"
export CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE="/Users/example-user/.config/gcloud/application_default_credentials.json"
export CLOUDSDK_CORE_ACCOUNT='operator@example.invalid'
gcloud compute ssh vibe-conversa-prod --project=vibe-conversa-prod --zone=us-east1-d --tunnel-through-iap --ssh-key-expire-after=30m --quiet \
  --command="sudo sh -c 'cd /opt/commerce-os/current && flock -n /opt/commerce-os/private/ci-deploy.lock sh scripts/compose-release.sh /opt/commerce-os/private/release.env stop channel-worker'"
BASELINE_FILE="/private/tmp/commerce-resilience-before-install-${FINAL_SHA}.json"
export COMMERCE_API_URL='https://commerce-os.inovaris.online'
IFS= read -r COMMERCE_SERVICE_TOKEN < /Users/example-user/.config/commerce-os-production/owner-api-20260915/decrypted/service-token
export COMMERCE_SERVICE_TOKEN
node scripts/commerce-resilience-readback.mjs snapshot > "$BASELINE_FILE"
unset COMMERCE_SERVICE_TOKEN
```

Exige API actual, colecciones completas y política REAL congelada antes de iniciar el helper. Si el helper falla **antes** de iniciar la instalación, devuelve únicamente ese contenedor anterior a su estado previo con `compose-release.sh … start channel-worker` bajo el lock y registra la incidencia. Si el instalador alcanzó el corte, deja que su compensación termine y consulta el recibo; no arranques servicios manualmente a ciegas.

El transporte canónico manual usa la misma identidad y lock del deploy CI:

```sh
export PATH="/Users/example-user/.cache/commerce-v5-gcloud/google-cloud-sdk/bin:/Users/example-user/.local/share/commerce-os-toolchain/node_modules/.bin:$PATH"
# La CLI local no tiene una cuenta activa en `gcloud auth list`; usa el ADC
# existente sin copiar su contenido al repo ni imprimir tokens.
export CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE="/Users/example-user/.config/gcloud/application_default_credentials.json"
export CLOUDSDK_CORE_ACCOUNT='operator@example.invalid'
export GITHUB_SHA="$FINAL_SHA"
export GITHUB_RUN_ID="$MANUAL_RUN_ID"
export GITHUB_RUN_ATTEMPT="$(gh api "repos/MarioB19/commerce-os/actions/runs/$MANUAL_RUN_ID" --jq '.run_attempt|tostring')"
test "$(gh api "repos/MarioB19/commerce-os/actions/runs/$MANUAL_RUN_ID" --jq .head_sha)" = "$FINAL_SHA"
umask 077
PRIVATE_RUNNER_TEMP="$(mktemp -d /private/tmp/commerce-release.XXXXXX)"
export RUNNER_TEMP="$PRIVATE_RUNNER_TEMP"
export GITHUB_STEP_SUMMARY="$PRIVATE_RUNNER_TEMP/summary.md"
: > "$GITHUB_STEP_SUMMARY"
chmod 600 "$GITHUB_STEP_SUMMARY"
export GCP_PROJECT_ID='vibe-conversa-prod'
export GCP_INSTANCE='vibe-conversa-prod'
export GCP_ZONE='us-east1-d'
export MCL_PORTAL_ENV_SOURCE='server-current'
test ! -e "$RUNNER_TEMP/mcl-portal.env"
python3 scripts/deploy-ci-client.py
```

Prerrequisitos privados: ADC/OIDC válido, acceso IAP/SSH efímero, owner bootstrap en el VPS y el overlay de gateways existente. En el modo manual `server-current`, el instalador deriva el env del portal activo dentro del VPS y bajo el lock del despliegue; elimina `MCL_ACCESS_DB` y `MCL_RELEASE_SHA` para regenerarlos y nunca exporta los demás valores. CI conserva el modo `local` con su secreto efímero en `RUNNER_TEMP`. Nunca reconstruyas esos valores en Git.

Ante transporte incierto, no reinicies el instalador. Consulta primero la unidad y el recibo privado `report.json`; el lock remoto y `source_sha/run_id` deciden si se recupera o se falla.

## 6. Readback y cero efectos

El deploy sólo pasa si el recibo `SUCCEEDED` y HTTPS devuelven el mismo SHA:

```sh
curl --fail --silent --show-error https://commerce-os.inovaris.online/readyz
curl --fail --silent --show-error https://commerce-os.inovaris.online/api/version
for route in home intelligence catalog campaigns sales results settings; do
  curl --fail --silent --show-error --output /dev/null "https://commerce-os.inovaris.online/$route"
done
```

Luego compara contadores sanitizados:

```sh
export COMMERCE_API_URL='https://commerce-os.inovaris.online'
IFS= read -r COMMERCE_SERVICE_TOKEN < /Users/example-user/.config/commerce-os-production/owner-api-20260915/decrypted/service-token
export COMMERCE_SERVICE_TOKEN
node scripts/commerce-resilience-readback.mjs compare "$BASELINE_FILE" > "/private/tmp/commerce-resilience-after-${FINAL_SHA}.json"
unset COMMERCE_SERVICE_TOKEN
```

Exige: SHA exacto, servicios sanos, migraciones completas, REAL congelado y fingerprints idénticos para assignments, comandos, filas completas del outbox, campañas, órdenes, comprobantes, conversiones y autorizaciones. El veredicto positivo se llama `ZERO_MATERIAL_EFFECT_DELTA`: no afirma que el scheduler interno o los heartbeats no avancen. Tanto el fingerprint completo del outbox —incluido `updated_at`— como el fingerprint material deben permanecer exactos; cualquier churn de timestamps impide ese veredicto. La equidad de selección usa metadatos de reintento por efecto en una tabla operativa separada y no reescribe `updated_at` ante un bloqueo idéntico. Sólo el conteo derivado de autorizaciones activas puede bajar por expiración natural del reloj sin mutación del registro; cualquier borrado, revocación o cambio de cuerpo/versión debe fallar el gate. Para afirmar `provider_calls=0`, se necesita una frontera independiente del proveedor; ni el core ni el recibo del instalador lo pueden demostrar por sí solos y deben devolver `NOT_OBSERVABLE`.

Registra GitHub Deployment manual con el SHA y el recibo, indicando que Actions estaba bloqueado por presupuesto; un Deployment exitoso no convierte CI en verde.

Después del gate estricto, la verificación operativa de los números puede crear comandos de lectura `check_health` mediante `/v1/numbers/:id/setup/commands`, usando versiones recién leídas. En un reemplazo del worker, ese comando primero reclama la generación de ownership sólo si existe un recibo de aislamiento vigente, no consumido y coincidente; luego hace la lectura fresca y puede cerrar únicamente el incidente `CHANNEL_HEALTH_BLOCKED` propio cuando identidad, salud y ausencia de incertidumbre lo permiten. Un recibo ausente o vencido deja la lease congelada y el comando fallido sin consulta al proveedor. No edites `session_ownership` ni insertes recibos manualmente para pasar el gate. Esta verificación debe ocurrir **después** de comparar los fingerprints previos al corte, pues añade comandos y auditoría aunque no envíe mensajes.

## 7. Rollback

Si falla SHA, servicio, migración, política, rutas o cero-efectos, conserva REAL congelado. No ejecutes `release.sh rollback` como procedimiento principal: sólo restaura el core y dejaría sin acreditar el proxy de identidad, el proxy/contenedor del portal y las unidades de respaldo WAHA.

El rollback soportado es la compensación del mismo helper de despliegue. Déjalo finalizar bajo su lock y valida su recibo privado antes de intervenir de nuevo:

```sh
ROLLBACK_REPORT="/opt/commerce-os/private/deployments/$MANUAL_RUN_ID-$GITHUB_RUN_ATTEMPT/report.json"
sudo test -f "$ROLLBACK_REPORT"
sudo python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(json.dumps({"status":r.get("status"),"error":r.get("error"),"rollback":r.get("rollback"),"portal_rollback":r.get("portal_rollback")},sort_keys=True))' "$ROLLBACK_REPORT"
```

El recibo sólo acredita rollback integral cuando:

1. `rollback.status` es `SUCCEEDED` y `rollback.core.status` es `SUCCEEDED`.
2. `rollback.identity_proxy.status` es `RESTORED`, `NOT_REQUIRED` o `NOT_APPLIED`, con `other_sites_preserved: true`.
3. `rollback.waha_backup_timer.status` es `RESTORED` o `NOT_APPLIED`; si fue `RESTORED`, exige `units_restored: true` y `runtime_state_restored: true`.
4. Si el instalador alcanzó el portal y falló, `portal_rollback.status` es `SUCCEEDED`, su `proxy.status` es `RESTORED`, `UNCHANGED` o `NOT_APPLIED`, `current_restored` es verdadero cuando llegó a escribirse `current.json`, el contenedor candidato quedó detenido y el contenedor anterior volvió a iniciar cuando había sido detenido.
5. `database_restored` permanece `false`: nunca se restaura ni rebaja PostgreSQL automáticamente.

`previous-release.env` queda como insumo privado del helper, no como prueba suficiente por sí solo. Si el proceso fue terminado antes de escribir un recibo concluyente, o si un readback posterior a un recibo `SUCCEEDED` exige volver atrás, no ejecutes un rollback parcial ni lo declares completado: conserva REAL congelado y escala el incidente para recuperar desde los recibos exactos del proxy/portal bajo el lock de despliegue.

Después de un recibo integral, repite `/readyz`, `/api/version` cuando la release anterior lo soporte, servicios, migraciones, política, gateways/volúmenes, portal y comparación de contadores. Un rollback de una release anterior al endpoint se acredita con `RELEASE.json`, imagen instalada y recibo, no inventando `/api/version`.
