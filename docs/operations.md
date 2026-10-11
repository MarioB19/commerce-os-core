# Manual operativo y despliegue

**Actualización 06-sep-2026:** el incremento de Campañas está preparado localmente, sin despliegue. Usar [operación de comprobantes, revisión y migración](campaign-receipt-sales.md); los estados r3 de abajo son históricos. El estado productivo previo vigente está en [[PROGRESS]].

Estado: `20260905-ventas-r3` está instalado y `current` apunta a r3, con los seis servicios del núcleo sanos. `https://commerce-os.inovaris.online` tiene TLS público válido de Let's Encrypt y aprobó 19 comprobaciones de acceso y estado. El POC y Caddy conservan su arranque del 15 de agosto. El gateway GOWS está iniciado en una red privada, con API verificada y cero sesiones. Consultar [release-review.md](release-review.md) antes de operar. La configuración mantiene `DISPATCH_FROZEN=true`, `REAL_SENDS_ENABLED=false` y `ALLOW_REAL_OPERATIONS=false`. Ninguna definición de diez slots acredita capacidad o sesiones reales.

## Arranque local

Node 24.20.0 + pnpm 10.34.5, Docker. Desde commerce-os-app: `pnpm install --frozen-lockfile`, `pnpm local:setup`, `pnpm db:migrate`, `pnpm bootstrap`, `pnpm dev`. Credenciales y archivos locales viven en `~/.config/commerce-os-local` (0700, archivos 0600); no copiar al vault. En este host el runtime está en `~/.local/share/commerce-os-toolchain/node_modules/.bin`.

La instalación local actual ya está preparada y sirve el build compilado en `http://127.0.0.1:5173`. La base activa `commerce` tiene 14 migraciones, el usuario owner y 10 cuentas SIMULATION; no contiene productos, conversaciones ni cuentas REAL. La base de desarrollo anterior, con 553 registros sintéticos, se renombró y preservó junto con sus archivos. Se comprobó el login y un backup B02 nuevo. Evidencia: `evidence/local-startup.json`. No es necesario repetir setup/bootstrap para utilizar esta instalación.

## Separación y permisos

API administra catálogo, miembros, tokens, controles y comandos; automation aplica transiciones; ingress sólo persiste ingreso; channel es el único emisor. Producción requiere URL PostgreSQL con rol mínimo por servicio, claves de cifrado sólo para consumidores autorizados y secretos de gateway sólo en channel. Web nunca recibe clave de gateway. No usar el usuario migrador para runtime. Alta pública cerrada; cada operador tiene sesión. Los tokens de servicio crean borradores y simulan, no concilian ni autorizan operación.

## Release instalado y siguiente actualización

1. La verificación local aprobó typecheck, lint, build, 18 pruebas unitarias, 51 de integración, 7 E2E funcionales y una medición de UI de 30 muestras con p95 1367 ms. Las evidencias y límites están en [verification.md](verification.md).
2. Se construyeron imágenes Linux/amd64 fuera de la VM con los targets runtime, web y maintenance de `infra/Dockerfile`. R2 se instaló desde el paquete con checksum e IDs inmutables de `evidence/release-images.json`, mediante `docker load` sin registry. R3 lo sustituyó correctamente; su integridad y paridad de fuentes están comprobadas en `evidence/release-package-r3.json` y `evidence/image-source-parity-r3.json`. La evidencia de instalación remota está en [vps-r3-install.json](evidence/vps-r3-install.json).
3. Se inspeccionaron VM, red y Caddy existentes. El inventario de 2 vCPU, 7432 MiB de RAM y disco aprovisionado de 30 GB es una muestra de reposo, documentada en [vps-readonly-inventory.md](vps-readonly-inventory.md).
4. La configuración de secretos, almacenamiento privado, migraciones y roles está instalada fuera del repositorio. El ensayo Docker local aprobó 41 comprobaciones, incluido restore con archivos legibles por UID1000. En el VPS también se restauró un backup B02 en una base nueva, con la base principal intacta. La actualización a r3 ejecutó su backup automático previo y conservó la configuración anterior en `release-history`. El backup final se copió al Mac junto con la configuración y las llaves, se verificó su integridad y se restauró en una base nueva de PostgreSQL 17; es una copia manual única.
5. El sitio separado `infra/caddy/commerce.Caddyfile` utiliza el dominio y DNS confirmados. El Caddy existente ya sirve Commerce y conserva el POC, sus volúmenes y los puertos 80/443. No se publican PostgreSQL, gateways ni ingress WAHA.
6. R3 y el piloto individual GOWS están instalados con despacho congelado. La prueba de la API del gateway en el VPS aprobó autenticación, versión y ausencia de sesiones. La vinculación de una cuenta y la integración de mensajes, medios y webhooks siguen pendientes; no hay sesiones WhatsApp creadas o vinculadas.

## Rollout y rollback

Crear volumen/base independientes. Migrar con runner único y backup verificado. Subir core congelado; comprobar readiness DB/API/ingress/workers, login y lectura del catálogo. Validar la configuración combinada de Caddy antes del reload. El 6 de septiembre de 2026 a las 03:17:16 UTC, r3 aprobó 19 comprobaciones HTTPS: readiness, login de owner, cookies Secure/HttpOnly, alta pública rechazada con 403, catálogo sin sesión rechazado con 401 y accesible con sesión, identidad owner, diez cuentas SIMULATION y cero REAL, estado de servicios, congelamiento, monitor y cierre de sesión. Evidencia: [vps-authenticated-r3.json](evidence/vps-authenticated-r3.json). Estas lecturas no crearon productos, conversaciones ni cuentas.

El `install-vps.sh` de r3 ejecuta un backup con la imagen de mantenimiento anterior antes de cargar una actualización y conserva el `release.env` previo en el directorio privado de historial. La actualización instalada ejecutó ese backup el 6 de septiembre de 2026 a las 03:15:07 UTC y guardó la configuración anterior en `release-history`. Una llamada directa a `release.sh deploy` no ejecuta ese backup: en ese caso hay que hacerlo y verificarlo manualmente antes de migrar. La verificación de restore se registra por separado.

Con el piloto ya iniciado, toda actualización del núcleo debe conservar `production.yaml` + `pilot.yaml`, ambos archivos privados y el perfil `waha-pilot`. La auditoría corrigió `install-vps.sh`/`release.sh` mediante `compose-release.sh`: detecta el piloto existente, conserva sus referencias/red y bloquea un modelo incompleto. La corrección está preparada; no se atribuye a r3 ya instalado. Secuencia exacta, verificaciones y rollback: [Actualización auditada r4](deployment-audit-r4.md).

El Caddyfile del proxy sigue montado desde `/opt/vibe-conversa-deploy/releases/5851ce66c5cc24364000d14ceffcf03228b370d4/deploy/Caddyfile`. Un futuro despliegue del POC que cambie ese archivo o su mount debe conservar o incorporar de nuevo el sitio de Commerce, validar la configuración combinada y verificar ambos sitios después del reload. La conservación comprobada en este despliegue no garantiza que un reemplazo futuro la mantenga.

Rollback de aplicación: congelar primero, detener nuevos claims, listar SENDING/UNKNOWN y timers; volver a digest previo compatible y fichero Caddy previo. No ejecutar migración destructiva inversa. Si el esquema ya no es compatible, restaurar en una nueva base, nunca sobre el único volumen válido. Un rollback no deshace mensajes ni entregas externas.

## Incidentes

Alta QR: las peticiones de una cuenta REAL deben incluir `?environment=REAL`. La versión auditada separa `ALLOW_CHANNEL_ONBOARDING=true` de las tres banderas que mantienen congeladas las salidas. La configuración privada productiva no se modificó durante esta auditoría. Para diagnóstico, códigos, evidencia local/productiva y pasos del escaneo, consultar [qr-audit.md](qr-audit.md).

- UNKNOWN: conservar intento; bloquear sucesores y reenvíos. Revisar IDs/acuses disponibles; nunca probar reenviando. Registrar decisión humana y evidencia de aislamiento antes de cualquier liberación.
- Ownership: lease vencido no demuestra proceso detenido. Congelar, aislar dueño previo de gateway/red, comprobar aislamiento y registrar evidencia; sólo entonces transferir generación. No failover automático del mismo material de sesión.
- Cuenta caída: congelar esa cuenta y conservar pendientes. Revisar dimensión/fuente/vigencia. No mover destinatarios a otro número ni reiniciar cuentas sanas.
- Comprobante: aprobar con importe positivo reconoce ingreso y completa beneficios configurados. Owner/operator/reconciler pueden clasificar Prueba/Falso/restaurar con motivo y versión. No se requiere banco; conservar evidencia privada e historial.
- Takeover: las propuestas pendientes se invalidan; mostrar efectos ya en vuelo. Retomar con acción explícita.
- Restricción: registrar ámbito (cuenta/WABA/portfolio/destinatario), pausar acciones aplicables. No pausar ni editar Ads sin autorización.

## Backup y restore

En el VPS, `commerce-2026-09-06T02-50-34.197Z.backup.aes` se restauró correctamente en la base nueva `commerce_restore_first_release`; la base principal permaneció intacta. Los seis servicios del núcleo están sanos. Esta prueba acredita recuperación funcional del backup ensayado, no recuperación ante pérdida del host.

Después de instalar r3 y probar el gateway, se generó el backup B02 final `commerce-2026-09-06T03-19-13.376Z.backup.aes`, con cero assets. [vps-final-backup.json](evidence/vps-final-backup.json) registra su creación antes de la copia externa; la verificación posterior está en [vps-offsite-recovery.json](evidence/vps-offsite-recovery.json).

La copia privada del Mac está en `/Users/example-user/.config/commerce-os-production`, con directorio 0700 y archivos 0600; contiene `login.env`, configuración, llaves de producción y el backup final. Se verificaron los 22 miembros del paquete y sus SHA256. El 6 de septiembre de 2026 a las 03:28:17 UTC se restauró en la base nueva `commerce_restore_vps_offsite_20260905`, sobre PostgreSQL 17 del Mac: 14 registros, 10 eventos, cero efectos, un control congelado y cero assets. La comprobación posterior encontró cero sesiones de acceso, autorizaciones vigentes, registros REAL, productos y conversaciones. La base principal del VPS permaneció intacta.

Esta copia manual única y su restore verifican la recuperación del estado inicial en otro host. No hay copia continua ni prueba de recuperación de sesiones QR o archivos productivos: el backup ensayado contiene cero assets. Para RPO ≤15 min se requiere archivado continuo WAL y backup base externo con monitor de frescura. No declarar RPO/RTO o PITR cumplidos a partir de este ensayo.

Restaurar con consumidores detenidos, flags de congelamiento y control duradero por workspace/cuenta. Inventariar efectos y conciliaciones desde el punto recuperado, cotejar con evidencia externa y resolver UNKNOWN. Las autorizaciones expiradas y campañas canceladas no se reactivan. Sesiones QR pueden requerir escaneo nuevo.

Guía ejecutable de copia cifrada y restauración con permisos: [backup-recovery.md](backup-recovery.md). La imagen de mantenimiento incluye Node y Docker CLI; no exige instalar Node en el VPS ni publicar PostgreSQL. El socket Docker se monta únicamente en la tarea administrativa, jamás en los servicios.

## Monitor externo

El monitor externo de Google `commerce-os-https-25R2MQFfLP4` comprueba HTTPS `/readyz`, valida TLS y exige estado `ready`, desde tres regiones cada 60 segundos, con timeout de 5 segundos. La consulta del 6 de septiembre de 2026 a las 03:07:12 UTC confirmó `check_passed=true` en `usa-virginia`, `usa-oregon` y `usa-iowa`, con muestras de las 03:06:40 UTC: 3/3 regiones. Evidencia: [vps-external-monitor.json](evidence/vps-external-monitor.json). Esta observación verifica disponibilidad desde fuera del VPS; no constituye una garantía continua. No hay alertas ni notificaciones configuradas.

Por separado, `scripts/external-monitor.mjs` es un helper preparado para comprobar HTTPS `/livez` desde otro host cada 30 segundos, con timeout de 5 segundos. Registra cambios, confirma caída tras dos fallos y retorna código 2. Su ensayo Docker verificó servicio disponible, caída y recuperación contra HTTPS local, sin notificaciones; no es el monitor de Google instalado. El heartbeat local mide procesos, pero no detecta por sí solo la pérdida total del VPS.

## Retención propuesta para validar antes de datos reales

Separar mensajes/media/comprobantes/envelopes, auditoría y backups. Valores iniciales de prueba: mensajes 90 días, medios 30, envelopes 7, borradores IA 30; evidencia financiera y auditoría según política aprobada. Mantener mínimo identificador de supresión protegido mientras sea necesario respetar bajas. Exportaciones auditadas sin secretos; no incluir códigos de acceso o perfiles bancarios en portabilidad. Antes de incorporar datos reales, falta registrar en el producto la política concreta, su vigencia y aprobación por un owner. Las pruebas utilizaron datos sintéticos.

## Mediciones y cuentas reales

La carga final procesó 500 conversaciones, 2500 entradas y 2500 salidas, con cero fallos HTTP y cero pendientes. El p95 de ACK fue 32.68 ms y el de durable→materializado, 224.65 ms. El perfil declara diez cuentas simuladas, 20 entradas por segundo y un 5% de media de un píxel por dirección; no representa archivos grandes ni tráfico real de WhatsApp. La medición de UI se ejecutó por separado. Una medición durante un build Docker llegó a p95 2010 ms y falló el objetivo de 2000 ms; se conserva esa evidencia y no se presenta el resultado final como garantía bajo cualquier carga.

La imagen GOWS 2026.8.2 CORE pasó una prueba local de API autenticada y está iniciada en el VPS, en `commerce-os_gateway-01` sin puertos públicos. La prueba remota del 6 de septiembre de 2026 a las 03:19:11 UTC verificó versión `2026.8.2` CORE/GOWS, acceso autenticado 200, rechazo 401 con clave ausente o incorrecta, listado de cero sesiones y respuestas 404 para dashboard/Swagger. La muestra del VPS observó 392.3 MiB de un límite de 768 MiB, 0.05% CPU y 19 PIDs. Es una muestra de un gateway vacío; no acredita capacidad con sesiones activas. Evidencia: [vps-gows-smoke.json](evidence/vps-gows-smoke.json).

No se vinculó ninguna cuenta ni se enviaron mensajes reales. Las pruebas de API no cubren escaneo QR, medios, webhooks de una cuenta o calidad del canal. Cloud y OpenAI mantienen contratos verificados mediante fixtures, sin integración remota. Diez cuentas simuladas o un gateway vacío no acreditan diez sesiones reales.

## Decisiones de cierre — 05-sep-2026

La aprobación de un nodo desde Inbox usa `approve_step` con motivo, versión de workflow y nodo observados. El servidor rechaza una revisión obsoleta. No se interpreta esta aprobación comercial como autorización de mensajes externos.

El release admite imágenes de registry con digest o IDs de imagen `sha256:…` cargados mediante `docker load`. En ambos casos valida identidad y arquitectura amd64 antes de desplegar; un ID local nunca se resuelve con una etiqueta mutable ni se intenta descargar del registry. Esto permite transportar el paquete verificado sin agregar una dependencia de registry.

El target `maintenance` añade el cliente Docker oficial al runtime de Node para ejecutar backup/restore donde el host sólo dispone de Docker. Requiere root y socket Docker durante la tarea; no forma parte de Compose ni permanece activo. Los directorios privados conservan su ruta absoluta del host dentro del contenedor para que sus subprocesos Docker monten los mismos archivos.

## Acceso y seguridad

[Modelo de amenazas y permisos](security.md), [matriz de requisitos](requirements.md) y [verificación integrada](verification.md). Los riesgos y controles descritos se basan en el código probado; la ausencia de cuenta real no sustituye validación remota de medios, plantillas, calidad u ownership.

## Estado de instalación declarado por el servidor — r3 instalado

La corrección instalada en r3 hace que `GET /v1/system/status` separe disponibilidad observada, controles de despacho y hechos de instalación declarados en el archivo privado `api.env`. La verificación HTTPS de r3 aprobó los indicadores de despliegue, congelamiento y monitor. El contrato no infiere el despliegue a partir de `NODE_ENV`, del dominio o de que un proceso responda. La consola muestra estos datos en Sistema.

| Variable de API | Valores y significado |
|---|---|
| `COMMERCE_DEPLOYMENT_STATUS` | `PREPARED`: paquete/configuración preparada, `production_modified=false`. `DEPLOYING`: instalación en curso, `production_modified=true`. `DEPLOYED`: el instalador terminó y comprobó la salud del núcleo, `production_modified=true`. |
| `COMMERCE_EXTERNAL_MONITOR_STATUS` | `NOT_INSTALLED`: no instalado. `INSTALLED`: instalado, aún sin verificación. `VERIFIED`: se registró una verificación externa efectiva. Esto no informa de la salud actual del monitor. |

Una variable ausente o inválida produce `UNKNOWN` y booleans `null`, evitando afirmar un hecho no declarado. Ambas respuestas identifican `source=SERVER_CONFIGURATION`; el monitor conserva `current_health=NOT_OBSERVED`, incluso después de una verificación histórica. Estos estados no cambian permisos, flags de operación ni la integración de WAHA/Cloud.

`prepare-production.mjs` genera `PREPARED` y `NOT_INSTALLED`. El instalador debe establecer `DEPLOYING` antes de arrancar el núcleo, y `DEPLOYED` sólo después de comprobar sus servicios. Una modificación del archivo necesita recrear el contenedor API para que el proceso reciba los valores nuevos. No marcar el monitor `VERIFIED` por un ensayo local: debe existir evidencia desde un host externo.

`dispatch_frozen` combina `DISPATCH_FROZEN=true` con una pausa duradera del workspace. `dispatch_frozen_sources` expone ambas fuentes: el flag del proceso aplica a REAL y el control del workspace también gobierna la simulación. Que no exista congelamiento no equivale a habilitación: permisos, las demás banderas de operación y las condiciones de cada despacho siguen siendo obligatorios.

La consulta final de métricas externas leyó ambas páginas REST y confirmó las tres regiones con muestras recientes a las 03:37:50 UTC. `pageSize` limita puntos: hay que recorrer `nextPageToken` antes de interpretar una región ausente como falta de datos. Evidencia: [vps-external-monitor-final.json](evidence/vps-external-monitor-final.json).
