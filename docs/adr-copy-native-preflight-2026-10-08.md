# Diagnóstico nativo manual de la copia por la identidad CI existente

Fecha: 2026-10-08. Estado: PREPARED; sólo fuentes públicas y pruebas propias.
No hay consulta GCP/VM real, credencial nueva, permiso IAM, backup ni instalación acreditados.

## Decisión y alcance

Añadir `copy-preflight` al mismo `.github/workflows/ci.yml`. Sólo dispatch manual,
main, MarioB19/commerce-os, environment production y concurrencia canónica
commerce-os-production. Changes/ci-gate excluyen el modo; sus dependencias
verify/package/deploy quedan omitidas. Backup/credential y schedules mantienen
sus condiciones. Contents read e id-token write reutilizan WIF/IAP autorizados.
No recibe comandos ni paths. Rechaza otros inputs de credential.

Antes de auth, el runner valida expected_sha=GITHUB_SHA=main/checkout, target
cerrado project-c6f43813-9ac9-47ab-9fe/commerce-os-test/us-east1-d, provider
projects/1065291779811/locations/global/workloadIdentityPools/commerce-copy-cd/providers/github-production
y commerce-copy-deploy@project-c6f43813-9ac9-47ab-9fe.iam.gserviceaccount.com.
Provider/SA fueron releídos por Root en GitHub production el8-oct; VM6334472381123916728
y zona están en el recibo nativo sanitizado del7-oct. El preflight local declara
Cloud_calls=0. No acredita permisos efectivos ni estado del servidor.

Tras auth, comprobar account activo y VMID/zone/name, y exigir enable-oslogin
TRUE efectivo (override VM, o metadata del proyecto). Si no existe, parar antes
de SSH; no permitir fallback gcloud a escritura de SSH keys en metadata.
No se modifican IAM, OAuth, billing, firewall, proyecto o instancia.

## Transporte y custodia

El código del collector debe coincidir con git show del SHA exacto y el checkout.
Se envía únicamente ese Python público por stdin al comando literal:
`sudo /usr/bin/env PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -`.
No scp, staging, script remoto persistente, wrapper, systemd-run ni comando de input.
La llave OS Login ed25519 del runner vence15min. Finalmente se usa
remove_ephemeral_key con lectura/remove/relectura canónicos y conservación de
otras llaves; sin cleanup confirmado no se publica éxito del diagnóstico.
Las lecturas tienen presupuesto total300s y cleanup reservado190s; preflight
local90s. Job15min, collector Linux120s, cada Docker read≤15s, output≤1MiB y
reporte≤256KiB. Timeout/volumen excesivo mata únicamente el hijo de esa consulta.
La expiración SSH es protección adicional, no sustituto de removal/readback.
SSH/auditoría e identidad temporal son efectos normales del transporte existente;
no se afirma que una conexión no produzca logs del sistema.

## Datos técnicos permitidos

VMID/zone/name/status/tipo esperado; CIDs/ImageIDs/servicios core conocidos,
PID/running, puertos numéricos, hash de Env y definición; redes/IPAM/endpoints y
volúmenes por hash de nombre/definición; disco disponible; hash/tamaño/UID/mode/nlink
de archivos canónicos fijos y metadata Root/B02; estados reconocidos de journals.
Se conserva el SHA instalado separado del SHA del diagnóstico: D961/65 es válido
como observación aunque main contenga herramientas nuevas.

Los nombres/labels desconocidos y valores Env sólo contribuyen a hashes. No
imprimir contenidos .env, RootJSON privado, claves, QR, teléfonos, clientes,
mountpaths, razones libres ni stderr de procesos. No leer backup-key.env,
backup.env ni sesiones/documentos comerciales. Los archivos privados requieren
Root600/nlink1, padres Root700, NOFOLLOW y FD/stat estable; públicos Root sin
escritura group/others. El collector no crea locks/archivos ni solicita SQL,
HTTP, backup, start, stop, pull, instalación o cambios de configuración.

El runner valida de nuevo la salida con allowlist de keys/valores antes de logs.
Falta, custodia, drift, bounds o formatos ajenos son UNKNOWN/OBSERVED_PARTIAL,
nunca counts0 inventados. El resultado siempre readiness_proven=false,
snapshot_atomic=false, installed=false y backup_executed=false. Los snapshots
Docker/archivos son lecturas separadas; no autorizan CAS ni una transición Root.
No prueban owner/auth DB, 65 hashes SQL, política REAL, aislamiento del origen,
B02 externo/restore, permiso comercial, WhatsApp o venta física.

## Validación y ejecución futura

Tests propios del runner/collector, stdin/errores/output bounds con procesos
locales reales y mocks de Cloud/Docker/Root; no son una consulta Linux productiva.
Integrar sólo tras review/FULL verde con COMMERCE_DEPLOY_PAUSED=true y sin override.
Invocar copy-preflight con expected_sha del main exacto; leer el resultado y
cleanup. No usar backup/credential como sonda ni ampliar roles si IAP falla.
Un UNKNOWN preserva el bloqueo y el consentimiento SDK pendiente. Root todavía
necesita observaciones/definiciones/aprobaciones privadas reales para instalar.
