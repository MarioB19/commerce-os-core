# Release de Ventas · 0.1.0 · r3

Commerce OS está publicado en https://commerce-os.inovaris.online, VM/proyecto `vibe-conversa-prod`, zona `us-east1-d`. Versión activa `/opt/commerce-os/releases/20260905-ventas-r3`; `/opt/commerce-os/current` apunta allí. Brandon autorizó el despliegue el 5-sep-2026 tras confirmar el dominio. La consola y sus diez cuentas de simulación están disponibles; no hay teléfono vinculado ni operación comercial real habilitada.

## Cambios e impacto

- Web, API, ingress, automation y channel independientes; PostgreSQL 17 con volumen propio, esquema 14 y roles limitados. Los seis servicios están sanos. Los contenedores del POC y Caddy conservaron su arranque del 15-ago.
- DNS A `commerce-os` → `34.26.170.26`, TTL 300. Se conservaron los valores/TTL de los 30 grupos anteriores. Caddy añadió sólo el sitio de Commerce, con copia exacta previa, validación y reload. El dominio tiene certificado público válido.
- R3 corrige el estado operativo de API: despliegue `DEPLOYED`, monitor `VERIFIED` como hecho de instalación y salud externa actual `NOT_OBSERVED`. El congelamiento efectivo combina flags y controles duraderos. Estos metadatos no conceden permisos.
- El instalador ejecutó backup previo a la actualización y guardó `release.env` anterior en `/opt/commerce-os/private/release-history`. La web y el esquema comercial conservan los de r2.
- Un gateway GOWS 2026.8.2 CORE corre aislado en `commerce-os_gateway-01`, sin puertos públicos. API autenticada verificada, cero sesiones y mensajes. Despachos reales y lifecycle real permanecen deshabilitados hasta configurar una cuenta concreta.
- Las imágenes Linux/amd64 se construyeron fuera de la VM. Paquete r3 de 251.658.240 bytes, SHA256 `b1ad70d0e298e08c5ddeb069b36b8b1db58b9274078050438a0e9d8333083147`; 45 archivos y 8 comparaciones de paridad verificados. IDs observados tras cargar y estado de contenedores en `evidence/vps-r3-install.json`.

## Verificación de la instalación

El verificador pasó 19 comprobaciones en HTTPS: certificado normal, readiness 200, anónimo 401, alta pública 403, login owner, cookie Secure/HttpOnly, catálogo autenticado, 10 cuentas SIMULATION y 0 REAL, DB/API/workers listos, flags efectivos, estado del despliegue/monitor y logout con cookie anterior revocada 401. Evidencia: `evidence/vps-authenticated-r3.json`.

Monitor externo Google Cloud `commerce-os-https-25R2MQFfLP4`: HTTPS `/readyz`, SSL válido, 200 y JSON `status=ready`, cada 60 s desde Iowa/Oregon/Virginia. Las tres regiones reportaron éxito. No se configuraron políticas de alerta ni canales de notificación. Evidencia: `evidence/vps-external-monitor.json`.

El primer B02 se restauró en una base separada del VPS. El backup final `commerce-2026-09-06T03-19-13.376Z.backup.aes` se copió al Mac junto con configuración y llaves, con checksum y 22 miembros verificados. Restore offsite correcto en la base nueva `commerce_restore_vps_offsite_20260905`: 14 registros, 10 eventos, 0 efectos, 1 control congelado, 0 assets y sesiones de acceso revocadas. Producción intacta. Evidencia: `evidence/vps-offsite-recovery.json`.

La muestra del gateway sin sesiones fue 392,3 MiB de 768 MiB, 0,05% CPU y 19 pids; no dimensiona sesiones activas. La VM conservaba 12,66 GB libres después de instalar r3. No se amplió la VM ni se modificó gasto publicitario.

## Acceso y custodia

Abrir la URL pública. El acceso inicial está en `~/.config/commerce-os-production/login.env`, archivo 0600 dentro de carpeta 0700. Configuración/llaves y backup cifrado están en esa misma carpeta privada del Mac y en `/opt/commerce-os/private` del VPS. No copiar sus valores al repositorio, notas o chat. El registro público está cerrado.

## Rollback y actualizaciones

Conservar configuración e IDs anteriores. Ejecutar `scripts/release.sh rollback /ruta/privada/release-previo.env` únicamente con esquema compatible y despachos congelados. R3 no añadió migraciones. No ejecutar migraciones destructivas inversas; recuperar DB en una base nueva y reconciliar UNKNOWN antes de operar.

El instalador aplica el núcleo. En futuras actualizaciones se debe volver a aplicar también `infra/compose/pilot.yaml`, sus dos archivos de entorno y el perfil `waha-pilot`, para conservar la red/configuración del gateway en channel e ingress. Ver [manual operativo](operations.md).

El Caddyfile está montado desde un release antiguo del POC; cualquier despliegue futuro de ese proyecto debe conservar el sitio de Commerce y verificar ambos sitios. Para retirar esta instalación, detener únicamente sus servicios, conservando volúmenes y configuración; restaurar la copia exacta de Caddy y validar antes de reload. Un rollback no revierte mensajes externos.

## Evidencia y dependencias

23 unitarias y compilación/typecheck/lint de r3 correctos; los 51 tests de integración, 7 E2E funcionales, 41 checks Docker y la carga sintética corresponden al cierre funcional anterior y no se presentan como repetidos en r3. Ver [verificación](verification.md), [matriz RF01–28](requirements.md) y `evidence/release-r3-validation.json`.

Faltan la cuenta y escaneo QR, pruebas reales de recepción/envío/media/ownership, proveedor IA evaluado, oferta/assets/banco reales y responsables del equipo. Cloud API necesita onboarding y elegibilidad propios. GOWS sigue experimental y sustituible; NOWEB conserva su papel de comparador. No hay llamadas IA ni envíos reales acreditados. Los datos de Ads o conversiones preparadas no acreditan integración remota Meta.

La copia offsite es manual y puntual: no acredita copia continua, WAL/PITR, RPO/RTO productivo ni recuperación de sesiones QR. El monitor detecta disponibilidad desde fuera; aún no hay notificaciones configuradas. CI está preparado, sin ejecución ni push a un servicio remoto en esta tarea.
