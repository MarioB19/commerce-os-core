# Verificación integrada de Ventas

El release r3 ya está instalado en el VPS y publicado en `https://commerce-os.inovaris.online`: seis contenedores del núcleo saludables, certificado TLS válido, raíz y `/readyz` con respuesta 200, y `/v1/products` con 401 sin sesión. La verificación autenticada r3 aprobó 19 comprobaciones HTTPS. También se verificó una copia manual externa de backup, configuración y claves, y se restauró en PostgreSQL del Mac sin modificar producción. No hay cuentas WhatsApp vinculadas ni envíos reales.

Las pruebas de negocio usan datos sintéticos y proveedores de prueba identificados. PostgreSQL es real; la web se sirve desde el build de producción y los procesos tienen entrypoints independientes. Las mediciones locales no acreditan sesiones reales, capacidad final del VPS ni resultados comerciales.

## Versiones y regresiones

El cierre r2 aprobó typecheck y lint, **18/18 unitarias**, **51/51 integraciones en 12 archivos** y migraciones 0001–0014. Evidencia y huellas: [verification-backend.json](evidence/verification-backend.json). No se suman repeticiones como pruebas diferentes.

R3 corrige los estados de instalación y monitor que estaban fijados en código, y hace que `dispatch_frozen` incluya el flag del proceso además del control del workspace. Las declaraciones ausentes o inválidas se muestran como UNKNOWN; desplegar la aplicación no declara integración WhatsApp ni salud actual del monitor. Pasaron **23/23 unitarias**, incluidas **5 regresiones nuevas** en `tests/unit/system-status.test.ts`, además de typecheck y build de las imágenes runtime y maintenance. La imagen web conserva la versión r2 previamente comprobada. Referencias: [release-r3-validation.json](evidence/release-r3-validation.json), [release-images-r3.json](evidence/release-images-r3.json), [image-source-parity-r3.json](evidence/image-source-parity-r3.json) y [release-package-r3.json](evidence/release-package-r3.json).

**Las 51 integraciones, los 7 E2E funcionales, las mediciones de carga/UI y las 41 comprobaciones Docker descritas a continuación son snapshots del cierre r2. No se afirma que se hayan repetido sobre r3.** El cambio r3 no modifica el runtime de negocio ni el esquema.

Las integraciones r2 cubren dos productos/conversaciones concurrentes hasta entrega/comprobante/revisión/conciliación/reporte, referencias históricas, comandos idempotentes, payload distinto, consentimiento y bajas, takeover durante IA, timers, campañas, import/export con procedencia, permisos por recurso y rol PostgreSQL, cifrado/media, fallo de DB antes de ACK, cuenta caída, ownership antiguo vivo y aceptación incierta sin reenvío.

Durante el cierre se corrigieron dos defectos de causalidad: seleccionar predecesor por UUID cuando varios efectos comparten timestamp, y adquirir locks en orden inverso entre control humano y despacho. La migración 0014 fija un orden durable; la regresión concurrente comprueba que una cancelación aplicada mientras dispatch espera impide el HTTP.

## Web y latencia · r2

Siete E2E funcionales pasan sobre la web compilada: acceso/ruta protegida, navegación y responsive, catálogo/versiones, inbox/cobro/conciliación, flujo publicado y aprobación humana de la versión/nodo exactos. Las capturas están en `evidence/screenshots/`; los resultados individuales en [web-e2e.json](evidence/web-e2e.json).

La métrica durable→visible toma `received_at` de PostgreSQL y el instante en que el mensaje exacto aparece renderizado en el navegador, en el mismo host. Perfil: 30 muestras, una pestaña activa, polling de 1 segundo en primer plano, sin tráfico WAN ni gateway real.

- Medición inicial: p95 **1862 ms**, máximo 1873 ms, objetivo 2000 ms.
- Repetición durante construcción Docker: p95 **2010 ms**, máximo 2022 ms; **falló**. Se conserva en [ui-latency-during-build.json](evidence/ui-latency-during-build.json).
- Repetición final sin build ni carga simultánea: p95 **1367 ms**, máximo 1371 ms, p50 857 ms; **aprobada**. Evidencia: [ui-latency.json](evidence/ui-latency.json). Los demás procesos del host no fueron controlados ni medidos por el perfil.

No se cambió el objetivo ni se eliminaron aserciones. Un resultado local bajo un perfil declarado no demuestra un SLO de producción ni de carga simultánea.

## Carga · r2

Diez cuentas simuladas, 500 conversaciones, 2500 ingresos y 2500 salidas, admisión de 20/s en ráfagas concurrentes de 20 solicitudes. El 5% de cada dirección transporta un PNG real de 68 bytes: se cifra/lee del almacenamiento privado, pero su tamaño mínimo no representa medios habituales.

El harness usa funciones del runtime, HTTP y PostgreSQL reales, bucles concurrentes en un proceso y respuesta sintética que sustituye deliberación comercial/IA. La ejecución con la migración 0014 procesó los 5000 mensajes en 124.96 segundos, sin pendientes ni fallos HTTP. ACK p95 **32.68 ms**, materialización p95 **224.65 ms** y aproximadamente 40 mensajes/s agregados. Evidencia: [load-profile.json](evidence/load-profile.json). Los fallos y resultados antes de índices/orden causal se preservan con nombres explícitos. No se usa esta prueba para afirmar que diez gateways caben en la VM.

## Recuperación y contenedores locales · r2

COMOSB02 contiene dump PostgreSQL y archivos privados de un snapshot consistente, cifrados con AES-256-GCM. La prueba crea una base nueva y verifica bytes, UNKNOWN, ownership congelado, revocación de autorizaciones y timers conservados. Rechaza corrupción criptográfica y tar autenticado con enlaces antes de crear la DB destino. Evidencia: [recovery.json](evidence/recovery.json).

El ensayo de contenedores utiliza las imágenes Linux/amd64, los roles limitados, filesystem raíz de sólo lectura, UID1000 y colas por schema del despliegue. Las **41 comprobaciones pasaron**, incluidos TLS local, login con cookies Secure/HttpOnly, roles, ingreso/media, monitor UP→DOWN→UP y mantenimiento con Docker CLI. La restauración se leyó como UID1000. Evidencia: [production-rehearsal.json](evidence/production-rehearsal.json). Un archivo con `passed:false` es fallo pendiente, no evidencia aprobada.

No se afirma RPO ≤15 minutos, WAL/PITR, recuperación externa o RTO productivo por esta restauración local. Los pasos remotos se distinguen en la siguiente sección.

## Instalación y recuperación en el VPS · r2

La transferencia se verificó por SHA256 y se cargaron tres imágenes. Los seis contenedores Commerce quedaron saludables, con 14 migraciones y 10 cuentas simuladas; el POC siguió sano y Caddy continuó funcionando. El nuevo sitio se validó antes del reload. Evidencia: [vps-initial-install.json](evidence/vps-initial-install.json).

El backup B02 cifrado del VPS se restauró en **`commerce_restore_first_release`**, una base nueva: **12 registros, 10 eventos, 0 efectos, 1 control congelado y 0 assets**. El restore revocó autorizaciones y dejó propietario UID/GID1000 para su almacenamiento. La base principal quedó intacta. Este ensayo inicial no contenía archivos de clientes; la verificación de bytes de assets pertenece a los ensayos locales descritos arriba. La copia/recuperación manual fuera del VPS se verificó después con el backup final y se documenta abajo.

Desde el exterior se validó TLS normalmente, sin desactivar la comprobación de certificado: TLS 1.3 con certificado de Let's Encrypt, raíz y `/readyz` con HTTP 200, y catálogo anónimo con HTTP 401. Esta primera comprobación r2 no incluyó login; la comprobación autenticada r3 se registra abajo. Evidencia: [vps-public-https.json](evidence/vps-public-https.json).

## Actualización y acceso HTTPS · r3

El instalador conservó un backup previo a la actualización (`commerce-2026-09-06T03-15-07.052Z.backup.aes`) y el release anterior. R3 terminó con seis servicios saludables, recreó API para cargar el estado DEPLOYED y dejó `/opt/commerce-os/current` apuntando al nuevo release. El POC permaneció saludable y conservó su arranque previo, igual que Caddy. La muestra posterior observó 12.66 GB de disco libres.

A las **03:17:16 UTC del 06-sep-2026**, el verificador HTTPS remoto aprobó **19 comprobaciones**, sin imprimir credenciales ni cookies: login owner 200, cookies Secure/HttpOnly, signup cerrado 403, acceso anónimo 401, rol owner, catálogo autenticado 200, 10 cuentas SIMULATION y 0 REAL, heartbeats frescos, estado DEPLOYED, congelamiento por proceso activo y monitor VERIFIED con `current_health=NOT_OBSERVED`. Logout respondió 200 y la cookie anterior recibió 401 al reutilizarla.

Evidencias descargadas: [vps-authenticated-r3.json](evidence/vps-authenticated-r3.json) y [vps-r3-install.json](evidence/vps-r3-install.json). Estas comprobaciones HTTP verifican la instalación real y el acceso autenticado. No se presentan como repetición remota de los E2E gráficos o de todos los recorridos comerciales.

## Copia externa y recuperación del backup final

El backup B02 final se creó en el VPS a las **03:19:13 UTC del 06-sep-2026**: cifrado, snapshot consistente y cero assets. Su registro [vps-final-backup.json](evidence/vps-final-backup.json) todavía indica copia externa no verificada porque describe ese momento de creación; la verificación posterior está en [vps-offsite-recovery.json](evidence/vps-offsite-recovery.json).

El bundle se descargó fuera del vault, se comprobó su SHA256 y se verificaron sus **22 miembros**, incluidos backup, configuración y claves. Los archivos privados conservaron permisos 0600. A las **03:28:17 UTC**, el backup se restauró en PostgreSQL 17 del Mac, en la nueva base **`commerce_restore_vps_offsite_20260905`**: **14 registros, 10 eventos, 0 efectos, 1 control congelado y 0 assets**. La comprobación posterior encontró 0 sesiones de login, 0 autorizaciones activas, 0 registros REAL y ningún producto o conversación. La base de producción no se modificó.

El restore local de esa copia tardó 2256 ms. Es un ensayo de una base inicial pequeña, **no un RTO de operación real**. Se verificó una sola copia manual fuera del VPS; no hay una garantía de réplica continua, frescura, RPO ≤15 minutos, WAL/PITR o recuperación de sesiones QR. La recuperación de bytes de archivos se cubre por separado con los assets sintéticos del ensayo r2, porque el backup inicial de producción no contenía assets ni efectos comerciales que reconciliar.

## Monitor externo

El uptime check Google Cloud **`commerce-os-https-25R2MQFfLP4`** ya está instalado. El coordinador observó **3/3 `check_passed=true`** desde Virginia, Oregon e Iowa: muestra de las **03:06:40 UTC del 06-sep-2026**, consultada a las **03:07:12 UTC**. No se configuraron notificaciones. El check utiliza HTTPS `/readyz` con certificado validado, HTTP 200 y coincidencia JSON de `status=ready`, periodo de 60 segundos y timeout de 5 segundos. Evidencia: [vps-external-monitor.json](evidence/vps-external-monitor.json). La API r3 declara este monitor como VERIFIED sin afirmar una salud actual permanente.

Esta observación externa es distinta del monitor probado dentro de Docker. Tres checks correctos no demuestran disponibilidad continua ni un tiempo de detección ante pérdida total; tampoco comprueban sesión o calidad de WhatsApp. El estado configurado del servidor debe reflejar la verificación externa sin presentarla como salud actual permanente.

## Repetir y CI

Desde el repositorio con Node 24, pnpm 10 y Docker: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`, `pnpm test:load`, `pnpm test:recovery`. La prueba UI requiere el build y servicios activos; carga y recuperación crean bases aisladas. Medir rendimiento separadamente de compilación u otras cargas incidentales.

La auditoría de dependencias reportó 0 vulnerabilidades info/low/moderate/high/critical: [dependency-audit.json](evidence/dependency-audit.json).

CI está configurado para instalación reproducible, tipos/lint/build, unitarias/integración/recuperación/E2E y audit. No se ha ejecutado en un servicio GitHub remoto desde esta tarea; ejecutar localmente no acredita un run remoto. La búsqueda de coincidencias exactas de secretos generados no encontró valores privados en los archivos de código, documentación y evidencia revisados; el alcance y las exclusiones figuran en [secret-scan.json](evidence/secret-scan.json). No equivale a una auditoría de seguridad completa.

## Integración externa

WAHA, Cloud API y proveedor IA configurable tienen adaptadores y fixtures propios. También se ejecutó localmente la imagen real GOWS 2026.8.2 CORE, Linux/amd64, fijada por digest: API autenticada correcta, claves ausentes/incorrectas rechazadas, dashboard y Swagger deshabilitados, cero sesiones y mensajes. El contenedor se probó en una red Docker interna sin puertos publicados y se retiró al terminar. Evidencia: [waha-gows-smoke.json](evidence/waha-gows-smoke.json). La muestra en reposo fue de 467.4 MiB con un límite de 768 MiB bajo emulación local; no dimensiona sesiones activas ni el VPS.

GOWS ya se instaló y probó en el VPS a las **03:19:11 UTC del 06-sep-2026**: versión 2026.8.2 CORE, API autenticada 200, claves ausentes/incorrectas 401, listado de sesiones 200 con **0 sesiones**, y dashboard/Swagger 404. Utiliza la red exclusiva `commerce-os_gateway-01` y no publica puertos. Los flags conservaron congelamiento=true, envíos reales=false y operaciones reales=false. La muestra en reposo registró 392.3 MiB de 768 MiB, 0.05% CPU y 19 PIDs; no dimensiona sesiones activas.

Evidencia descargada: [vps-gows-smoke.json](evidence/vps-gows-smoke.json). Esto verifica la API de un gateway desplegado, no una cuenta o el proveedor de mensajería WhatsApp. Vinculación QR, webhooks, medios y calidad de cuenta siguen pendientes. NOWEB sigue como comparador pendiente de prueba propia. No hay cuenta real conectada, llamada IA remota ni envío real en estas pruebas. Elegibilidad Meta, escaneo QR, referencias de entrega, información bancaria y autorizaciones comerciales se verifican en un piloto concreto. Estado por requisito: [RF01–28](requirements.md).

## Arranque local limpio

La base local de desarrollo se conservó íntegra con 553 registros bajo `commerce_development_evidence_20260905_1788660993366`. La base de uso quedó nueva con 14 migraciones, acceso individual, 10 cuentas simuladas, 0 cuentas reales y 0 productos/conversaciones. Se verificaron login y backup cifrado de la base nueva; la aplicación compilada quedó ejecutándose en localhost:5173. Evidencia: [local-startup.json](evidence/local-startup.json). No se eliminaron datos ni archivos anteriores.

Revisión final r3: lint de los archivos modificados, sintaxis del instalador y `git diff --check` correctos. La búsqueda exacta de 48 valores sensibles conocidos en 221 archivos no encontró coincidencias (`evidence/secret-scan-r3.json`); no sustituye una auditoría completa. Salud final tras aplicar el gateway: seis servicios sanos, gateway activo y POC conservado (`evidence/vps-final-health.json`).

Monitor externo final: tres regiones correctas con muestras de 34 s de antigüedad; consulta de 15 min con 261 puntos y dos páginas completas (`evidence/vps-external-monitor-final.json`). La consulta inicial sin paginación omitía una región; se corrigió la consulta y no se interpretó esa omisión como caída del servicio.
