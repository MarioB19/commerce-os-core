# Acceso y despliegue de auditoría

El despliegue del núcleo en el VPS existente cuenta con autorización vigente documentada en [PROGRESS.md](PROGRESS.md). Los envíos y la actividad publicitaria siguen fuera de esa autorización. **El instalador r4 terminó con PASS el 06-sep-2026 a las 12:08:37 UTC** y `current` apunta a `/opt/commerce-os/releases/20260906-audit-r4`. La autorización específica de Cloud Shell y el acceso IAP están resueltos. El núcleo, HTTPS y Meta de lectura están verificados. El ensayo QR llegó a SCAN_QR_CODE sin escaneo; quedan la intervención humana y los accesos parciales de Meta.

## Histórico del acceso previo al despliegue

- HTTPS autenticado existente operativo: se verificó una cuenta REAL WAHA DISCONNECTED, cero comandos lifecycle y despacho congelado. GET QR sin entorno devuelve 404 NOT_FOUND y con REAL devuelve 403 QR_UNAVAILABLE. [Evidencia actual](evidence/qr-production-readonly.json).
- El host local no dispone de `gcloud`, ADC ni clave `google_compute_engine` en las ubicaciones revisadas. El SSH configurado es ajeno a GCP. No se ha creado acceso nuevo.
- El acceso técnico anterior fue la sesión existente de Google Cloud → Cloud Shell → IAP SSH a proyecto/VM `vibe-conversa-prod`, zona `us-east1-d`.
- El intento de descubrir esa sesión mediante CUA informó que el Mac estaba bloqueado y no pudo desbloquearse automáticamente. Ese bloqueo se resolvió mediante intervención humana. La autorización específica de Cloud Shell también se obtuvo después del rechazo automático inicial; el instalador ejecutado confirma el acceso vigente. No se intentó eludir esos controles.

## Rutas confirmadas en la copia privada histórica

La copia offsite existente confirma las rutas, sin mostrar sus valores privados. Su snapshot es anterior a la nueva cuenta REAL; no sustituye el inventario ni el B02 del despliegue r4. Se conserva la referencia histórica y se añade el destino actual confirmado. El B02 r4 nuevo es `commerce-2026-09-06T12-07-21.100Z.backup.aes`, 358.436 bytes, fechado a las 12:07:22 UTC. Se verificaron sus metadatos y la secuencia previa a migración; no se restauró este backup durante el despliegue.

| Elemento | Ruta |
|---|---|
| Enlace activo actual | `/opt/commerce-os/current` → `/opt/commerce-os/releases/20260906-audit-r4` |
| Enlace previo histórico | `/opt/commerce-os/releases/20260905-ventas-r3` |
| Configuración del núcleo | `/opt/commerce-os/private/release.env` |
| Configuración del piloto | `/opt/commerce-os/private/pilot/pilot-release.env` |
| Directorio declarado del piloto | `/opt/commerce-os/private/pilot` |
| Configuración privada del piloto | `waha-01.env`, `channel-pilot.env`, `ingress-pilot.env` |
| Datos privados del núcleo | `/opt/commerce-os/private/assets` |
| Copias cifradas | `/opt/commerce-os/private/backups` |
| Red del proxy existente | `vibe-conversa_default` |
| Red exclusiva de WAHA | `commerce-os_gateway-01` |

El modelo debe preservar `infra/compose/production.yaml` + `infra/compose/pilot.yaml`, ambos archivos privados de entorno y el perfil `waha-pilot`. El instalador anterior recreaba channel/ingress con sólo el modelo base, por lo que el nuevo helper de release debe conservar el overlay.

Backup conocido localmente antes del despliegue r4: `commerce-2026-09-06T03-19-13.376Z.backup.aes`, 184.356 bytes. No se interpreta como backup actualizado del estado de esta auditoría.

## Procedimiento de inventario remoto

`scripts/audit-vps-readonly.py` sólo lee: current, configuración permitida, Docker inspect filtrado, flags booleanos, migraciones y conteos PostgreSQL, estado/versionado del gateway por GET, fecha/tamaño del backup más reciente y disco libre. No genera QR, crea sesiones, hace backups, imprime logs completos ni muestra credenciales o teléfonos. Se verificó su sintaxis local. El inventario de las 12:14:46 UTC pasó 13 checks: seis servicios del núcleo sanos, 16 migraciones, flags congelados, onboarding sólo en channel-worker y cuenta REAL asignada a su gateway. Nueve comparaciones del release confirman imágenes, backup y preservación de redes/arranque; HTTPS pasó 23 checks. [Inventario](evidence/deployment-r4-vps.json) · [Comparación](evidence/deployment-r4-release-comparison.json) · [HTTPS](evidence/deployment-r4-https.json).

Desde Cloud Shell con el archivo disponible, la lectura se ejecuta así:

```sh
gcloud compute ssh vibe-conversa-prod --project=vibe-conversa-prod --zone=us-east1-d --tunnel-through-iap --command='sudo python3 -' -- -T < scripts/audit-vps-readonly.py
```

## Procedimiento de instalación y comprobaciones

1. Obtener inventario remoto actual y confirmar core/piloto, cero SENDING/UNKNOWN y congelamiento. Registrar imágenes anteriores y preservar POC/Caddy.
2. Verificar checksum del paquete concreto y su paridad de fuentes. Generar un backup B02 nuevo con la imagen maintenance anterior antes de cargar/migrar la versión nueva. Conservar configuración e imágenes anteriores para reversión compatible.
3. Aplicar las migraciones no destructivas de la auditoría con el usuario migrador; mantener perfiles mínimos runtime.
4. Habilitar únicamente `ALLOW_CHANNEL_ONBOARDING=true` en el entorno privado de channel-worker. Mantener `DISPATCH_FROZEN=true`, `REAL_SENDS_ENABLED=false`, `ALLOW_REAL_OPERATIONS=false` en todos los servicios. No modificar ni transferir secretos Meta mediante este flujo QR.
5. Instalar el núcleo con el modelo combinado y verificar redes, volúmenes, gateway y sus referencias. Mantener intacto el contenedor del piloto si no requiere actualización y conservar el POC/proxy.
6. Confirmar HTTPS, login/roles, migraciones, API-first, navegabilidad responsive, permisos y congelamiento con la versión instalada. Actualizar current sólo después de comprobar salud.
7. Conservar la cuenta REAL existente y su asignación exclusiva de gateway. El ensayo autorizado ya aplicó un único connect y verificó SCAN_QR_CODE/PNG efímero a las 12:20 UTC. Para el escaneo humano, pedir un QR fresco en [Ventas → Números](https://commerce-os.inovaris.online/sales/channels/whatsapp), entorno Real. El QR no entra en capturas, logs ni notas; no enviar mensajes.

El inventario continúa siendo de sólo lectura. La instalación del núcleo r4 sí se ejecutó con autorización; no se atribuye a este script de inventario. El PASS del instalador y el destino de `current` están confirmados. Los manifest IDs coinciden con el paquete y los tiempos de arranque de PostgreSQL, WAHA, POC y Caddy permanecieron iguales al inventario previo. Meta pasó 63 comprobaciones API/UI y una segunda verificación API de 10; cuatro accesos siguen parciales. QR productivo pasó a las 12:20:41 UTC con outbox REAL 0, envío deshabilitado y sin guardar/emitir PNG. El inventario de las 12:14 es previo a ese ensayo; [QR tiene su evidencia posterior](evidence/qr-production-onboarding-r4.json). El escaneo humano permanece pendiente. [Resumen vigente](evidence/audit-verification.json).
