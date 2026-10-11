# Operación diaria y recuperación del cierre

Estado: software publicado en `376f675` por CI/CD 34197160928; warm-up apagado y cierre operativo pendiente. Consultar `operational-closure.md` y sus evidencias antes de habilitar operación real. REAL es el contexto normal. Preparar datos, publicar catálogo, habilitar canal y enviar son operaciones distintas. La clave API vive únicamente en almacén privado. Ejemplos ejecutables y permisos: [api-client.md](api-client.md).

## Rutina diaria

1. Abrir Configuración y revisar Preparación. Cada comprobación muestra su fuente y fecha. CONFIGURED no equivale a prueba con proveedor. Consultar también `GET /v1/readiness?environment=REAL` y `/v1/system/status`.
2. Revisar Números: conexión, identidad, exclusividad de sesión, pausa, estado de warm-up, última observación de salud y resultados inciertos. En un pool activo o una cuenta enrolada sin graduar se bloquea el uso comercial. El módulo apagado antes de enrolar conserva la operación anterior; apagarlo después no gradúa la cuenta.
3. Revisar Inbox y comprobantes. La respuesta normal usa un permiso operativo vigente; el dispatcher verifica alcance, vigencia, salud, consentimiento y cuotas. El comprobante validado registra ingreso; Prueba/Falso no son ingresos. No existe un paso bancario adicional.
4. Preparar producto, oferta, vendedor, materiales y flujo mediante UI/API. Comprobar versiones y hash/MIME de archivos. Publicar la versión sólo cuando esté revisada. Crear snapshot desde Configuración → Pruebas para ensayar; salir devuelve a REAL, descarta las cachés y detiene las consultas periódicas del laboratorio.
5. Revisar los trabajos diarios, los de cada 15 minutos y los de cada hora, la cola con más de 30 minutos de espera, el plan frente a los ACK y el disco del almacenamiento privado. El disco es una medición del sistema de archivos montado, no una estimación de capacidad del gateway. Observar copia externa y restore por separado.

## Incidentes

| Señal | Acción exacta | Criterio para continuar |
|---|---|---|
| Canal FAILED/desconectado | Pausar el número, revisar salud, exclusividad de sesión y diagnóstico en Números. Preparar recuperación con la autorización aplicable al ciclo de conexión y al QR. No borrar sesión ni pedir QR repetidamente. | WORKING e identidad correcta observados, exclusividad verificada, causa resuelta y reanudación autorizada. FAILED no prueba baneo. |
| WARMUP_REGISTERED_IDENTITY_CHANGED | Pausar y comparar la identidad observada con la registrada. Reconectar el número original o crear otra cuenta para el número nuevo y registrarlo desde día cero con autorización nueva. | La identidad actual vuelve a coincidir con la identidad propia registrada. No reescribir identidad o progreso históricos para retirar el bloqueo; una graduación no se transfiere a otro número. |
| Efecto UNKNOWN | Consultar comando, efecto y observaciones/ACK por sus IDs. Mantener detenido el sucesor. No cambiar la clave ni crear una copia para reenviar. | Evidencia del resultado remoto y procedimiento de reconciliación vigente; no basta la ausencia de ACK. |
| Perfil UNKNOWN | El propietario solicita `POST /v1/warmup/accounts/:id/profile-review`, revisión esperada y motivo, o «Revisar perfil» en Configuración. El worker vuelve a consultar identidad y nombre; nunca repite los PUT. | Identidad y nombre observados. La aceptación de la descripción o el avatar no equivale a observación del destinatario. Si persiste, revisar manualmente antes de otro cambio autorizado. |
| Sin otra cuenta propia, identidad o contenido | Registrar identidad real propia verificada, agregar cuentas propias mediante el endpoint de miembros y cargar material propio aprobado. Agregar miembros o cambiar el perfil revoca el permiso previo y requiere uno nuevo acotado. | Reconciliador recupera automáticamente dependencias. No inventar antigüedad ni contenido para evitar bloqueos. |
| Breaker abierto | Parar pool; revisar cuentas distintas de las últimas 24 h. Usar control de propietario `reset_breaker` con revisión y motivo sólo tras resolver la causa. | Permiso vigente y controles correctos. El reconciliador no rearma. |
| Sin contenido suficiente | Cargar conversaciones propias que quepan enteras en presupuesto de ambos extremos. Se conserva content_hash por número. | Plan factible; agotamiento visible AWAITING_CONTENT. No reutilizar o regenerar textos para ocultar automatización. |
| MP3/PDF/acceso incorrectos | Pausar entrega, fijar asset/oferta/flujo exactos, verificar bytes y contrato del motor. Corregir creando versión nueva. | Prueba receptora autorizada; SENT sólo acredita aceptación del proveedor; DELIVERED, un ACK de entrega; READ, la lectura informada por el proveedor. El portal exige apertura independiente. |
| Alerta ACCEPTED/UNKNOWN | ACCEPTED significa HTTP aceptado, aún sin recepción humana. UNKNOWN nunca se reintenta ciegamente. Revisar receptor por el ID idempotente. | Confirmación registrada con evidencia humana; no configurar correo de recuperación como alertas implícitamente. |
| Disco/backup obsoleto | Revisar `PRIVATE_STORAGE_DISK_LOW` (menos de 1 GiB o del 5 %) y reporte cifrado externo. No borrar assets ni backups sin política de retención. | Espacio medido y copia/restore vigentes. Monitor externo debe detectar caída total del host. |

Pausar pool: `PATCH /v1/warmup/pools/:id` con `action:pause`, `expected_version`, `reason` y entorno REAL. Detener nuevas propuestas: `action:disable`. Pausa por cuenta: `PATCH /v1/warmup/accounts/:id`. Los efectos ya iniciados conservan su resultado; no se promete retirarlos del proveedor. Reanudar no cambia los días efectivos ni saca una cuenta de cuarentena. Consultar `GET /v1/warmup/backfill` antes de cualquier interpretación histórica: es una consulta sin cambios, y los datos desconocidos permanecen desconocidos. El backfill y las comprobaciones de preparación de identidad están implementados y probados localmente.

## Copia externa y restore

Propuesta para aprobación: B02 diario, RPO de 24 h, objetivo de RTO de 2 h y retención de 30 días en bucket propio cifrado. Son objetivos propuestos, no mediciones ni configuración activa. Faltan bucket, custodios de ambas claves, identidad de servicio, retención y aprobación. El backup incluye snapshot consistente y assets cifrados; el restore también requiere custodiar la clave de aplicación.

```sh
node scripts/prepare-backup-schedule.mjs /ruta/privada/preparacion /opt/commerce-os/private/release.env gs://BUCKET_APROBADO/commerce 'daily' 24
# Revisar backup-schedule.json, units y lifecycle del bucket. Genera enabled:false; no instala.
# Tras aprobar: instalar archivos privados en /opt/commerce-os/private, fijar enabled:true
# e instalar los dos units mediante el administrador del host.
node scripts/scheduled-backup.mjs /opt/commerce-os/private/backup-schedule.json
sh scripts/maintenance.sh restore /opt/commerce-os/private/release.env /opt/commerce-os/private/backups/ARCHIVO.backup.aes commerce_restore_INCIDENTE
```

El host requiere Node 24, gcloud autenticado para el bucket aprobado, Docker y el release fijado. `scheduled-backup` verifica los metadatos remotos de SHA-256 y tamaño; no acredita restore. El reporte privado queda en `backup-schedule-last.json`. Capturar la evidencia sanitizada y registrarla como `backup_external` sólo si pasó; `restore_assets` exige además ejecutar y revisar el restore. El temporizador usa `flock` y `Persistent`; los trabajos no dependen del chat.

Restore crea exclusivamente una base de datos nueva, valida autenticidad y archivos antes de usarla, congela los espacios de trabajo y la exclusividad de las sesiones, revoca autorizaciones, tokens y sesiones, pausa pools y cancela la revisión pendiente de perfil. SENDING pasa a UNKNOWN; alertas pendientes quedan detenidas y las integraciones de alertas y correo quedan apagadas. Verificar hash de assets, conteos, acceso y controles antes de modificar el destino productivo. No restaurar sobre la base de datos activa. La prueba local sintética no acredita RTO ni RPO productivos.

## Staging de 24 h y publicación

Con la publicación nocturna aprobada, CI/CD ejecuta `scripts/start-staging-soak.py` después de verificar el núcleo. Crea el proyecto independiente `commerce-closure-soak` sólo con al menos 1 GiB disponible de RAM y disco, base y claves nuevas, red interna, sin puertos, sin credenciales productivas y con la imagen exacta instalada. Su configuración privada está en `/opt/commerce-os/private/staging-soak`; continúa en el VPS aunque el Mac esté apagado. `deployment.json.staging_soak` distingue `STARTED`, `EXISTING_OBSERVATION`, `DEFERRED_CAPACITY` y `SETUP_PENDING`. Ninguno significa 24 h completadas.

Consultar en el VPS el estado persistido y los tres tipos de trabajo:

```sh
sudo docker compose -p commerce-closure-soak --env-file /opt/commerce-os/private/staging-soak/compose.env -f /opt/commerce-os/private/staging-soak/compose.yaml exec -T postgres psql -U commerce_owner -d commerce_staging_soak -Atc 'SELECT row_to_json(s) FROM staging_soak_state s'
sudo docker compose -p commerce-closure-soak --env-file /opt/commerce-os/private/staging-soak/compose.env -f /opt/commerce-os/private/staging-soak/compose.yaml exec -T postgres psql -U commerce_owner -d commerce_staging_soak -Atc 'SELECT kind,status,count(*) FROM warmup_schedule_runs GROUP BY kind,status'
```

Un despliegue posterior conserva el ensayo original y su SHA, sin reiniciar su contador. Un setup parcial requiere inspección; el helper no lo sobrescribe. Al alcanzar `COMPLETED`, el observador conserva el resultado y deja de generar trabajo sintético. Para aprobar otra imagen, preparar otro ensayo con configuración/volumen propios y guardar el anterior. La evidencia del ensayo de una imagen no acredita automáticamente otra. La base compatible se puede publicar apagada; habilitación/piloto siguen pendientes de observación y autorización concreta.

`infra/compose/staging-soak.yaml` usa una base de datos, red y secretos propios, sin puertos ni gateways, red interna y fetch externo denegado. Cuenta intervalos observados de reloj real; saltos mayores de 120 s no se acreditan y su duración máxima queda visible. Un estado COMPLETED exige 24 h observadas, 96 ventanas health, 24 reconcile y dos fechas daily sin fallos. Los comandos de transporte y restore se verifican en las suites separadas; este observador acredita la ejecución de los trabajos.

```sh
node scripts/prepare-staging-soak.mjs /ruta/privada/staging sha256:DIGEST_RUNTIME_REVISADO
# Tras cargar la imagen construida del release:
docker compose --env-file /ruta/privada/staging/compose.env -f infra/compose/staging-soak.yaml up -d
# Estado sin secretos:
docker compose --env-file /ruta/privada/staging/compose.env -f infra/compose/staging-soak.yaml exec -T postgres psql -U commerce_owner -d commerce_staging_soak -Atc 'SELECT row_to_json(s) FROM staging_soak_state s'
```

### Histórico de ensayos locales detenidos

El prototipo local registró 31 muestras durante 1811 s sin fallos y se detuvo conservando el volumen. El ensayo revisado arrancó el **08-sep-2026 a las 05:05:07 UTC** con otra base y otro volumen; su imagen coincidía con 254 archivos versionados de código. [Paridad](evidence/operational-closure-image.json) y [estado inicial](evidence/staging-soak-reviewed.json). También quedó detenido: 103 muestras, 6138.96 s y cero fallos. No alcanzó 24 h y su tiempo no se suma al del VPS.

El ensayo activo está instalado y autorizado en el VPS desde la primera muestra del 08-sep a las 06:41:40 UTC; usar las consultas del VPS indicadas arriba. Exigir `COMPLETED`, cero fallos, `max_gap_seconds <= 120` y conteos de jobs. El simple transcurso del plazo no basta. Conservar los volúmenes y evidencias locales como historial; no reiniciar sus contadores ni presentarlos como continuidad del observador del VPS.

No usar secretos, base de datos ni red de producción en staging. Conservar volumen y logs; al fallar, conservar evidencia y comenzar otra instalación aislada, sin resetear contadores para simular aprobación. En un servidor continúa con el equipo personal apagado; una ejecución local depende del Mac. No hay seguimiento continuo del chat configurado.

Publicación por CI/CD: [publishing-changes.md](publishing-changes.md), [ci-cd.md](ci-cd.md). Fijar commit/release y aprobación, comprobar su run, `deploy=success`, `Deployment SUCCEEDED`, migraciones y HTTPS. La base nueva se publica con warm-up apagado. `release.sh rollback` rechaza imágenes sin compatibilidad warm-up; no revierte el esquema ni restaura la base de datos automáticamente. No cambiar a una imagen antigua para eludir los controles.

El piloto comercial exige número elegible y receptor controlado, materiales, límites, vigencia y permiso específico. Warm-up exige además dos o tres cuentas propias verificadas, capacidades comprobadas para el digest y motor elegidos, contenido suficiente, concentración aceptada y alcance temporal. El perfil estándar necesita 30 días efectivos; la fase 3 comienza desde el día 8. Entre tandas de despliegue gradual hay 48 h reales. El cierre permanece abierto hasta esas evidencias.


## Estado de publicación — 08-sep-2026

Release vigente `ci-34197160928-1-376f675144d5`, SHA `376f675144d576e8ca6dc7734f6b8f17e45ade79`, instalado por [CI/CD 34197160928](https://github.com/MarioB19/commerce-os/actions/runs/34197160928) a las **07:19:42 UTC / 01:19:42 México**. Artefacto SUCCEEDED: seis servicios sanos, 28 migraciones, REAL congelado; 66/66 E2E aprobadas. La corrección móvil 320/390 está instalada y comprobada por CI/HTTPS, con nueve controles de al menos 240 × 44 px y sin desbordamiento. Sesión REAL nueva: un GET/45 s y cero errores; Actualizar produjo un POST 202, seguimiento del job nuevo hasta SYNCED y un informe posterior con revisión cambiada. Catálogo y metadatos SMTP versión 2 preservados; la recepción humana sigue pendiente. [Entrega](operational-release-verification.md).

Se conserva el release anterior `ci-34194173542-1-17a7340ab746` y [su evidencia](evidence/operational-closure-production-17a7340.json). El observador `commerce-closure-soak` continúa como `EXISTING_OBSERVATION`, con imagen y `source_sha` de `17a7340ab7468d0bbcce4e28e0440209d49b1b6f`; primera muestra a las **06:41:40 UTC**. El backend es idéntico entre ambos commits; el único cambio de aplicación es CSS del dashboard. No llamar al ensayo una observación de la imagen `376f675` ni declarar completadas sus 24 h. Revisar el estado persistido con las consultas de este runbook. Primera finalización posible: 09-sep a las 06:41:40 UTC, condicionada a continuidad y contadores. No sumar el ensayo local d00e1b3, ya detenido, ni habilitar el pool a partir de la fecha solamente.

## Sesiones QR · continuidad por cuenta

Usar el [procedimiento de continuidad](channel-session-continuity.md) para principal, salud, alertas, conciliación y reemplazo de almacenamiento. El supervisor respeta deseo/pausas y no habilita envíos. No repetir mutaciones con resultado remoto UNKNOWN.
