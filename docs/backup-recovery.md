# Backup y recuperación

> Estado actualizado al 28-sep-2026: ver [respaldo operativo y ensayos actuales](evidence/operational-backup-20260928/README.md). El registro de septiembre temprano que sigue conserva su alcance histórico; sus cantidades y pendientes no describen el snapshot actual de 380 archivos. La prueba de restauración y el respaldo de autenticación WhatsApp se acreditan por separado.

> Actualización de cierre2026-09-08 (local, sin publicar): el scheduler B02/copia externa y los controles ampliados de restore están en [operational-runbook.md](operational-runbook.md). [recovery.json](evidence/recovery.json) acredita sólo datos sintéticos actuales con assets, tokens revocados y pools/alertas detenidos. Las descripciones de r3 que siguen son históricas; no acreditan frescura productiva ni un schedule instalado.


`pnpm backup` genera COMOSB02: un dump de PostgreSQL dentro de un snapshot exportado, un manifiesto de hashes y los archivos privados cifrados a los que apuntan los assets READY de ese snapshot. El paquete completo se cifra con AES-256-GCM. Un archivo faltante o inválido aborta el backup; no se entrega un paquete parcial como válido. Los archivos de catálogo son inmutables. La eliminación concurrente por retención puede obligar a repetir el backup.

`pnpm restore /ruta/archivo.backup.aes commerce_restore_nombre_unico` autentica el paquete completo antes de crear una base. Sólo admite rutas y archivos de su manifiesto, sin enlaces simbólicos ni duros. Nunca reemplaza una base existente. Restaura los archivos en un directorio privado nuevo, congela los workspaces y ownership, convierte SENDING en UNKNOWN, revoca autorizaciones y elimina sesiones de acceso. Los timers conservados requieren la reconciliación operativa antes de descongelar.

## Ejecución en el VPS

### Requisito para un clúster vacío

El destino es una base nueva dentro de un clúster PostgreSQL preparado para Commerce OS. Los roles de PostgreSQL pertenecen al clúster y no viajan en el dump de una base. Aunque backup y restore usan `--no-owner --no-acl`, las políticas RLS de `integration_secrets` siguen haciendo referencia a `commerce_api`, `commerce_ingress`, `commerce_automation` y `commerce_channel`. Esos grupos y `commerce_maintenance` se crean normalmente durante las migraciones 0002/0009 antes de instalar los logins del runtime. El ensayo sintético previo restauraba otra base en ese mismo clúster ya preparado; no demostraba restauración en un clúster sin roles.

Para una prueba en un clúster aislado vacío, preparar primero únicamente esos cinco grupos `NOLOGIN`, sin contraseña, membresías, superusuario, creación de roles/bases, replicación ni bypass de RLS. Comprobar su identidad y atributos antes y después de restaurar, además de las cinco políticas exactas y RLS ENABLE+FORCE. No copiar logins productivos, cambiar roles existentes ni omitir políticas para hacer pasar el ensayo. El destino aislado debe carecer de workers y acceso externo; la transacción canónica posterior conserva congelamiento, revocación de permisos y conciliación obligatoria. `--no-acl` también omite GRANT/REVOKE. Para reanudar un runtime real hacen falta su aprovisionamiento de accesos y una revisión separada de logins, permisos mínimos y propiedad del esquema: crear estos grupos no lo habilita.

El ensayo aislado del 28-sep a las 05:05 UTC omitió este requisito y falló por rol ausente antes del freeze. Se conservaron el fallo y su limpieza; por sí mismo no demuestra corrupción del B02 ni un defecto del flujo de mensajes. Véase [resultado y diagnóstico](evidence/operational-backup-20260928/restore-attempt3/README.md). La [validación correctiva posterior](evidence/operational-backup-20260928/restore-role-prerequisites/README.md) preparó esos grupos en un clúster nuevo y terminó PASS: datos, 380 archivos, congelamiento/revocaciones, atributos de grupos y políticas RLS exactas. La base productiva se conservó; el destino y su plaintext se retiraron después del ensayo.

El mantenimiento requiere Node 24, dependencias del release, Docker CLI, acceso al socket Docker y a la carpeta privada del release. No se publica el puerto de PostgreSQL. Cuando `DATABASE_URL` usa el alias `postgres`, los scripts resuelven su dirección actual con una inspección acotada de `PG_CONTAINER` y `PG_NETWORK` en el host Linux. No se guardan direcciones efímeras en notas ni se imprime la URL con credenciales.

Desde la carpeta del release, con el archivo privado generado por `production:prepare` y sus rutas adaptadas al host:

```sh
node --env-file=/ruta/privada/backup.env scripts/backup.mjs
node --env-file=/ruta/privada/backup.env scripts/restore.mjs /ruta/privada/backup.backup.aes commerce_restore_ensayo
```

Si el host no tiene Node, el target `maintenance` empaqueta Node y Docker CLI. Tras cargar su imagen y fijar `COMMERCE_MAINTENANCE_IMAGE=sha256:…` en el archivo privado:

```sh
sh scripts/maintenance.sh backup /ruta/privada/release.env
sh scripts/maintenance.sh restore /ruta/privada/release.env /ruta/privada/backups/archivo.backup.aes commerce_restore_ensayo
```

El helper monta el socket Docker únicamente durante esta tarea administrativa y conserva las rutas absolutas privadas. Los servicios de negocio nunca reciben ese socket. El archivo privado generado fija `RESTORE_ASSET_UID=1000` y `RESTORE_ASSET_GID=1000`: el restore asigna ese dueño a su directorio y a los archivos nuevos, conservando 0700/0600. Añadir ambos valores a configuraciones anteriores; si se omiten, los archivos conservan el dueño del proceso de mantenimiento. Configurar la ruta exacta devuelta como nuevo mount del runtime, siempre con despacho congelado.

El archivo `backup.env` debe incluir `COMMERCE_CONFIG_DIR`, `PRIVATE_STORAGE_DIR`, `BACKUP_DIR`, `PG_CONTAINER`, `PG_NETWORK`, `DATABASE_URL`, `POSTGRES_USER`, `POSTGRES_DB`, `BACKUP_ENCRYPTION_KEY` y `DISPATCH_FROZEN=true`. Los secretos se conservan fuera del repositorio con permisos 0600, en directorio 0700. La clave de cifrado de datos de aplicación se conserva por separado: recuperar bytes cifrados no sustituye custodiar esa clave.

## Evidencia y límites

R3 está instalado y `current` apunta a `20260905-ventas-r3`. Durante la instalación inicial de r2 en el VPS se generó el backup B02 `commerce-2026-09-06T02-50-34.197Z.backup.aes` y se restauró correctamente en una base nueva, `commerce_restore_first_release`. La base principal permaneció intacta y los seis servicios del núcleo están sanos. Este resultado corresponde al backup y al destino ensayados; no se sustituyó la base activa ni se habilitaron despachos.

La actualización a r3 ejecutó el backup automático previo `commerce-2026-09-06T03-15-07.052Z.backup.aes` y conservó el archivo privado `release.env` anterior en `release-history`. Después de la verificación HTTPS de r3 y de la API del gateway, se generó el backup B02 final `commerce-2026-09-06T03-19-13.376Z.backup.aes`, con cero assets. Evidencias: [vps-r3-install.json](evidence/vps-r3-install.json) y [vps-final-backup.json](evidence/vps-final-backup.json). Esta última registra la creación antes de verificar la copia externa; la evidencia posterior de copia y restore se conserva por separado.

La copia externa está en `/Users/example-user/.config/commerce-os-production` del Mac, con directorio 0700 y archivos 0600. Incluye `login.env`, configuración, llaves de producción y el backup final. Se verificaron los 22 miembros del paquete privado y sus SHA256; los secretos y bytes privados permanecen fuera del repositorio y del vault.

El 6 de septiembre de 2026 a las 03:28:17 UTC, el backup final se restauró correctamente sobre PostgreSQL 17 del Mac, en la base nueva `commerce_restore_vps_offsite_20260905`: 14 registros, 10 eventos, cero efectos, un control congelado y cero assets. La comprobación posterior confirmó cero sesiones de acceso, autorizaciones vigentes, registros REAL, productos y conversaciones. La base principal del VPS no se modificó. La evidencia sanitizada está en [vps-offsite-recovery.json](evidence/vps-offsite-recovery.json).

`pnpm test:recovery` utiliza dos bases sintéticas nuevas y PostgreSQL real; verifica datos, bytes de un archivo privado, controles congelados, autorizaciones revocadas y rechazo de un paquete alterado antes de crear la base destino. También rechaza un tar autenticado que intenta introducir un enlace simbólico. El resultado sanitizado vive en `docs/evidence/recovery.json`.

Se verificó una copia externa manual y la recuperación del estado inicial en otro host, con la configuración y las llaves copiadas. No existe copia continua ni evidencia de RPO ≤15 minutos, RTO productivo o PITR. La recuperación de archivos está cubierta por la prueba sintética local; este backup productivo contiene cero assets. Tampoco existen sesiones WhatsApp ni efectos comerciales que permitan probar recuperación o conciliación real. Un restore de prueba no habilita mensajes ni resuelve resultados externos inciertos.

El `install-vps.sh` de r3 incorpora backup previo a una actualización utilizando la imagen de mantenimiento anterior y conserva el archivo privado `release.env` anterior; ambos pasos se comprobaron en esta actualización. Una llamada directa a `release.sh deploy` no incluye ese backup. Generar un backup y probar su restore son comprobaciones separadas.

## Continuidad WAHA · 15-sep-2026

[Respaldo de sesiones y recuperación de almacenamiento](channel-session-continuity.md#respaldo-específico-de-waha): COMOSW01 independiente, captura fría GOWS, cuarentena, identidad persistente y límites de autenticación. Restaurar COMOSB02 desactiva explícitamente la recuperación de sesiones y expira salud. La copia de PostgreSQL no incluye por sí sola las credenciales WAHA.
# Daily offsite B02

The [existing CI identity transport](daily-b02-offsite.md) runs canonical B02 from
an authenticated explicit private plan and verifies complete immutable GCS object
downloads. Manual custody and a prepared scheduler remain distinct from an actual
scheduled run. Installation, effective IAM/bucket/budget and the first real receipt
are required before enabling the daily trigger.
