# Verificaciones posteriores al despliegue r4

Preparación para el coordinador autorizado. Estos auxiliares no modifican el paquete sellado, imágenes ni runtime. Se revisó `audit-vps-readonly.py`; sus consultas son de lectura y su salida filtra configuración, sesiones y cuentas. No usar `audit-qr-production.mjs` para este paso porque consulta la ruta QR. `verify-deployment.mjs` conserva la expectativa original de cero cuentas REAL y no representa el piloto actual.

## HTTPS y contratos

Desde la raíz del repositorio local, con el login protegido ya existente:

```sh
env PATH="$HOME/.local/share/commerce-os-toolchain/node_modules/.bin:$PATH" \
  EXPECTED_META_MODE=configured \
  node --env-file="$HOME/.config/commerce-os-production/login.env" \
  scripts/verify-audit-r4.mjs > docs/evidence/deployment-r4-https.json
```

El archivo de entorno se lee mediante Node, no se imprime ni se carga como código de shell. La salida contiene sólo estados HTTP, booleanos y conteos; cookies y cuerpos permanecen en memoria. Verifica TLS, readiness, rechazo anónimo, sesión owner Secure/HttpOnly, revocación al salir, OpenAPI r4/scopes/versiones, GET de productos/ofertas/flujos REAL, piloto conservado sin envío habilitado, workers recientes y despacho congelado. No crea recursos, tokens de servicio, comandos, sincronizaciones Meta ni QR. Login/logout son las únicas escrituras de autenticación.

Elegir el modo Meta según el paso efectivamente completado:

| `EXPECTED_META_MODE` | Resultado requerido |
|---|---|
| `unconfigured` | NOT_CONFIGURED, configured false, sin portafolios; para comprobar despliegue antes del aprovisionamiento autorizado. |
| `configured` | Configuración vinculada al workspace, estado NOT_SYNCED o snapshot fresco SYNCED/PARTIAL. NOT_SYNCED no acredita vigencia del token. |
| `synced` | Snapshot almacenado SYNCED/PARTIAL vigente y al menos una credencial verificada vigente; usar después de la sincronización autorizada. |

El verificador nunca sincroniza por su cuenta ni llama a Graph. Un estado UNAVAILABLE/STALE se informa como fallo de la expectativa; los errores/cuerpos privados no se imprimen. `passed:true` acredita estas comprobaciones concretas, no una prueba de mutaciones remotas o de pairing.

## Inventario de la VM y banderas de QR

La API HTTPS no expone migraciones ni `ALLOW_CHANNEL_ONBOARDING`. Obtener evidencia con el acceso Cloud Shell/IAP existente, una vez autorizado su uso:

```sh
gcloud compute ssh vibe-conversa-prod \
  --project=vibe-conversa-prod --zone=us-east1-d --tunnel-through-iap \
  --command='sudo python3 /opt/commerce-os/current/scripts/audit-vps-readonly.py' \
  -- -T > /tmp/commerce-r4-vps.json
```

Guardar la salida sanitizada como `docs/evidence/deployment-r4-vps.json` en el repositorio local y ejecutar:

```sh
python3 scripts/check-audit-vps-report.py docs/evidence/deployment-r4-vps.json \
  > docs/evidence/deployment-r4-vps-checks.json
```

Comprueba current r4, 16 migraciones, seis servicios sanos, `DISPATCH_FROZEN=true`, `REAL_SENDS_ENABLED=false`, `ALLOW_REAL_OPERATIONS=false`; onboarding habilitado únicamente en channel-worker; overlay/red del piloto conservados; gateway privado y accesible por GET de estado; cuenta REAL con referencia esperada; cero efectos SENDING/UNKNOWN. La pausa del workspace se registra como observación: no sustituye ni es requisito de las tres banderas de proceso. Si onboarding aún no se habilitó, ese check debe fallar: el verificador no cambia la bandera.

Comparar además imágenes contra el manifiesto aprobado, volúmenes contra el inventario previo y fecha/tamaño del B02 contra la hora anterior a la actualización. El conteo 16 no sustituye los checksums comprobados por el runner de migraciones. El inventario sólo registra metadata del backup; no crea otro ni acredita por sí mismo una restauración.

## Referencia del piloto en la cuenta existente

El inventario previo SSH comunicado a las 12:01:25Z mostró una cuenta REAL WAHA DISCONNECTED, envío deshabilitado, cero comandos/efectos, gateway sin sesiones y referencia distinta de `WAHA_01`. Tras instalar r4, la preparación autorizada cambia sólo `gateway_ref` mediante API; no crea otra cuenta ni conecta la sesión.

Contrato: sesión owner, `Origin` válido e `Idempotency-Key`; GET `/v1/channel-accounts?environment=REAL` obtiene la cuenta y su versión actual. PATCH `/v1/channel-accounts/{id}?environment=REAL` recibe `{expected_version:version_observada,gateway_ref:"WAHA_01"}`. Devuelve 200, mismo ID y estado/envío preservados; 409 VERSION_CONFLICT requiere consultar el estado y revisar antes de otro intento. La API comprueba exclusividad global de la referencia del gateway.

El auxiliar `scripts/assign-pilot-gateway.mjs` implementa ese único PATCH con precondiciones: r4 identificado por OpenAPI, una sola cuenta REAL WAHA DISCONNECTED, envío false, versión explícita igual a la recién consultada y cero comandos/efectos antes y después. La API omite `gateway_ref` por diseño; comprobar su valor previo y posterior con el inventario SSH. Sólo ejecutar después del aviso del coordinador y proporcionar la versión concreta observada:

```sh
env PATH="$HOME/.local/share/commerce-os-toolchain/node_modules/.bin:$PATH" \
  node --env-file="$HOME/.config/commerce-os-production/login.env" \
  scripts/assign-pilot-gateway.mjs --apply --expected-version "$OBSERVED_ACCOUNT_VERSION" \
  > docs/evidence/deployment-r4-gateway-assignment.json
```

No hace reintentos, lifecycle ni petición QR. Si el inventario SSH ya confirma la referencia, no ejecutar el auxiliar. La versión explícita impide repetir inadvertidamente la operación con la versión nueva. Una respuesta incierta se informa como tal; revisar GET y SSH antes de decidir otro intento.

No se cambia el control global del workspace. `gateDispatch` deniega REAL antes de invocar proveedores si cualquiera de las tres banderas de proceso lo impide; la pausa del workspace también afectaría SIMULATION porque ese control no tiene columna environment. Si en otro alcance se requiere una pausa amplia, su contrato es POST `/v1/system/controls?environment=REAL`, owner + idempotencia, `{paused:true,scope_type:"workspace",reason:"Motivo concreto"}`, respuesta 202. Este recorrido no lo ejecuta ni escribe directamente a la base.

## Evidencia de preparación

Se validó sintaxis Node/Python y diff check de los auxiliares durante su preparación; entonces no hubo ejecución remota. Tras el aviso de instalación se ejecutó una sola asignación y las comprobaciones HTTPS autorizadas. El primer auxiliar asumió erróneamente que `gateway_ref` aparecía en la respuesta; conservó el resultado como UNKNOWN y no repitió el PATCH. GET posterior confirmó versión 3 y metadatos seguros; inventario SSH de 12:14:46Z confirmó la referencia esperada. El auxiliar corregido exige versión explícita y separa la confirmación API de la referencia privada por SSH. Véanse `evidence/deployment-r4-gateway-assignment-resolution.json`, `evidence/deployment-r4-gateway-readback.json` y `evidence/deployment-r4-https.json`.

Posteriormente, con autorización específica ya confirmada, el ensayo productivo de onboarding pasó a las 12:20:41Z: un connect APPLIED, sesión SCAN_QR_CODE, QR PNG temporal validado sólo en memoria, cero outbox y escaneo humano pendiente. La evidencia y los pasos exactos para Brandon están en [QR productivo r4](qr-production-onboarding-r4.md). Este ensayo separado sí crea una sesión; los verificadores HTTPS/VPS de lectura descritos arriba siguen sin hacerlo.

## Provisión Meta autorizada

Brandon autorizó la custodia productiva el 06-sep-2026. La transferencia local está preparada en `~/.config/commerce-os-production/meta.env` con modo 0600 y padre 0700. Contiene dos credenciales y el workspace productivo comprobado; nunca incluirla en el paquete versionado, Git o capturas.

Una vez disponible el acceso autorizado, transferir el archivo mediante el canal privado a `/opt/commerce-os/private/meta-transfer.env` con modo 0600. Copiar también el helper sin secretos `scripts/merge-meta-env.py`, que es un auxiliar posterior al paquete sellado. Ejecutarlo con el propietario de la configuración o root:

```sh
sudo python3 /ruta/al/helper/merge-meta-env.py \
  /opt/commerce-os/private/meta-transfer.env \
  /opt/commerce-os/private/api.env
```

El helper comprueba workspace, rechaza configuración Meta inesperada, conserva las variables restantes, crea backup 0600 y sustituye el archivo de forma atómica. No imprime valores ni hashes de tokens. Se verificó con ocho pruebas sintéticas. Usa el contrato `process.env` ya existente: sin montar archivos nuevos ni modificar Compose; sólo la API recibe las variables.

Recrear únicamente API mediante `scripts/compose-release.sh`, comprobar `EXPECTED_META_MODE=configured`, ejecutar una sincronización interna autorizada (sólo GET externos) y después `EXPECTED_META_MODE=synced`. Eliminar la copia de transferencia remota únicamente tras verificar la lectura. La copia local privada y api.env conservan la custodia autorizada; los workers no reciben credenciales Meta.
