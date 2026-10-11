# Inventario comprobado · 5 de septiembre de 2026

Lectura inicial realizada mediante la sesión existente de Google Cloud y Cloud Shell → IAP SSH, antes del despliegue. Esa inspección no cambió configuración, gasto, imágenes, procesos, sesiones ni contenido del POC. Los valores siguientes son muestras históricas del momento de lectura, no una medición continua ni el consumo posterior a la instalación. Los cambios autorizados posteriores figuran al final.

| Recurso | Lectura observada |
|---|---|
| VM / proyecto / zona | `vibe-conversa-prod` / `vibe-conversa-prod` / `us-east1-d` |
| Estado / plataforma | RUNNING; Ubuntu 24.04 x86_64; n1-standard-2 |
| CPU / RAM | 2 vCPU; 7432 MiB RAM; 6594 MiB disponibles en la muestra |
| Disco raíz | `29G` mostrados por el filesystem; `11G` usados, `18G` libres (36%); disco aprovisionado de 30 GB |
| Carga | 0.00 / 0.00 / 0.00; uptime de 23 días y 6 horas en la muestra |
| POC | `vibe-conversa-app-1` healthy, activo durante 3 semanas; release `5851ce66c5cc24364000d14ceffcf03228b370d4`; aproximadamente 119 MiB y 0.06% CPU en la muestra |
| Proxy | `vibe-conversa-caddy-1`, activo durante 3 semanas; Caddy 2.11.4; aproximadamente 12.15 MiB |
| Red existente | `vibe-conversa_default` |
| Rutas POC | `reverse_proxy app:8787` y `app:3000` |
| Caddyfile montado | `/opt/vibe-conversa-deploy/releases/5851ce66c5cc24364000d14ceffcf03228b370d4/deploy/Caddyfile` → `/etc/caddy/Caddyfile` |
| Protección | Deletion protection activa; snapshot diario visible entre 11 p. m. y 12 a. m.; Backup and DR plan no configurado |

La RAM y el disco libres son una muestra en reposo, no capacidad demostrada para diez gateways. El Compose preparado tiene volumen, base y red core propios; conecta web, API e ingress a la red existente del proxy. Preserva el POC y sus volúmenes. La configuración combinada de Caddy debe validarse antes del reload. No se imprimieron variables de entorno, secretos ni archivos de sesión.

## Estado posterior a la inspección

Brandon autorizó el despliegue de Commerce OS. El dominio confirmado es `commerce-os.inovaris.online`: el registro A hacia `34.26.170.26` ya se aplicó y se verificó en ambos servidores DNS autoritativos y en el resolver 1.1.1.1. Los valores y TTL de registros ajenos se conservaron. Evidencia: `evidence/dns.json`. Esta modificación DNS no instala la aplicación ni acredita HTTPS.

R2 se instaló en `/opt/commerce-os/releases/20260905-ventas-r2` y se actualizó correctamente a `20260905-ventas-r3`; `current` apunta a r3. Los seis servicios del núcleo están sanos: PostgreSQL, API, ingress, automation-worker, channel-worker y web. El Caddy existente conserva las rutas del POC y sirve `https://commerce-os.inovaris.online` con certificado público válido de Let's Encrypt. El POC y Caddy mantienen su arranque del 15 de agosto. El estado remoto se mantiene en `release-review.md`.

La verificación HTTPS del 6 de septiembre de 2026 a las 03:17:16 UTC aprobó 19 comprobaciones de readiness, login de owner, cookies Secure/HttpOnly, alta pública rechazada con 403, catálogo sin sesión rechazado con 401 y accesible con sesión, diez cuentas SIMULATION y cero REAL, estado del núcleo, congelamiento, monitor y logout. La configuración conserva `DISPATCH_FROZEN=true`, `REAL_SENDS_ENABLED=false` y `ALLOW_REAL_OPERATIONS=false`. Evidencias remotas: [vps-r3-install.json](evidence/vps-r3-install.json) y [vps-authenticated-r3.json](evidence/vps-authenticated-r3.json).

El Caddyfile continúa montado desde el release antiguo del POC indicado en la tabla. Un despliegue futuro de Vibe Conversa que cambie ese archivo o su mount debe preservar o incorporar de nuevo el sitio Commerce, validar la configuración combinada antes del reload y comprobar ambos sitios. La preservación verificada durante esta instalación no garantiza la conservación automática en futuros despliegues del POC.

Las imágenes runtime, web y maintenance Linux/amd64 de r2 se construyeron fuera del VPS y se instalaron desde el paquete verificado. El archivo tiene SHA256 verificado y cada imagen conserva sus IDs inmutables en `evidence/release-images.json`; no se requiere publicar en un registry. El ensayo local de esa configuración pasó 41 comprobaciones, incluidas sesiones HTTPS, roles restringidos, backup/restore y acceso del runtime UID1000 a los archivos recuperados (`evidence/production-rehearsal.json`). Estas pruebas no certifican capacidad del VPS. R3 también se instaló desde un paquete con integridad y paridad de fuentes comprobadas (`evidence/release-package-r3.json`, `evidence/image-source-parity-r3.json`).

También se ejecutó localmente la imagen GOWS 2026.8.2 CORE en una red Docker interna y sin puertos publicados. Se verificaron autenticación de API, versión y listado vacío de sesiones; no se creó ninguna sesión ni se vinculó una cuenta WhatsApp. La muestra con límite de 768 MiB observó 467.4 MiB en reposo bajo emulación local; no se extrapola a diez sesiones activas ni al VPS. Evidencia y límites: `evidence/waha-gows-smoke.json`.

El gateway GOWS fijado por digest está iniciado en el VPS, en `commerce-os_gateway-01` y sin puertos públicos. La prueba remota del 6 de septiembre de 2026 a las 03:19:11 UTC aprobó versión `2026.8.2` CORE/GOWS, API autenticada 200, clave ausente o incorrecta 401, listado de cero sesiones y dashboard/Swagger 404. La muestra del VPS registró 392.3 MiB de un límite de 768 MiB, 0.05% CPU y 19 PIDs; no demuestra capacidad con cuentas activas. Evidencia: [vps-gows-smoke.json](evidence/vps-gows-smoke.json). La vinculación de una cuenta y la integración real de mensajes, medios y webhooks siguen pendientes.

En el VPS se generó el backup B02 `commerce-2026-09-06T02-50-34.197Z.backup.aes` y se restauró correctamente en la base nueva `commerce_restore_first_release`, con la base principal intacta. La actualización a r3 ejecutó su backup automático previo a las 03:15:07 UTC y conservó la configuración anterior en `release-history`. El backup B02 final es `commerce-2026-09-06T03-19-13.376Z.backup.aes`, con cero assets; [vps-final-backup.json](evidence/vps-final-backup.json) registra su creación, anterior a la verificación de copia externa.

La copia privada de producción del Mac está en `/Users/example-user/.config/commerce-os-production`, con directorio 0700 y archivos 0600. Contiene `login.env`, configuración, llaves y el backup final; los 22 miembros del paquete y sus SHA256 están verificados. Las credenciales y los bytes privados permanecen fuera del vault.

El restore externo del 6 de septiembre de 2026 a las 03:28:17 UTC aprobó en una base nueva de PostgreSQL 17 del Mac, `commerce_restore_vps_offsite_20260905`: 14 registros, 10 eventos, cero efectos, un control congelado y cero assets. La comprobación posterior encontró cero sesiones de acceso, autorizaciones vigentes, registros REAL, productos y conversaciones. La base principal del VPS permaneció intacta. Evidencia: [vps-offsite-recovery.json](evidence/vps-offsite-recovery.json). Se trata de una copia manual única; no demuestra copia continua, RPO/RTO, PITR o recuperación de sesiones QR.

El monitor de Google `commerce-os-https-25R2MQFfLP4` está instalado y verificado en tres regiones con intervalo de 60 segundos. Comprueba HTTPS `/readyz`, valida TLS y exige estado `ready`, con timeout de 5 segundos. La consulta del 6 de septiembre de 2026 a las 03:07:12 UTC devolvió `check_passed=true` en `usa-virginia`, `usa-oregon` y `usa-iowa`, con muestras de las 03:06:40 UTC: 3/3. Evidencia: [vps-external-monitor.json](evidence/vps-external-monitor.json). No hay alertas ni notificaciones configuradas. La observación externa no cambia el carácter histórico de las muestras de recursos de la tabla.
