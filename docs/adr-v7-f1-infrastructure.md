# ADR V7 F1 — Infraestructura bajo el techo, recuperación y alertas

Agente: Claude · 13-oct-2026 · rama `claude/v7-f2-cutover`. Decisiones de
implementación de F1 dentro de la arquitectura ya decidida (ADR-V7-08, 10, 12,
13 y 14; anexo de infraestructura). No rediscute la topología: una VM
`commerce-os-test` (us-east1-d, hoy e2-standard-2 con IP estática
`commerce-copy-https`), PostgreSQL 17 propio, GCS y Cloud Run/Pub/Sub/App Engine
sólo donde aportan. **HA multizona y BD HA siguen DIFERIDAS (D-16)**: la VM y la
base son puntos únicos de falla; F1 entrega recuperación medida, no failover.

## 1. PITR con pgBackRest (RNF-03.e)

- **Imagen.** `infra/postgres/Dockerfile`: la misma base que corre hoy
  (`postgres:17.11-bookworm` por digest de índice) más `pgbackrest=2.59.3-1.pgdg12+1`
  fijado. Se construye en la VM dentro de la ventana (`v7_pitr.py build-image`),
  que verifica `pgBackRest 2.59.3` y PostgreSQL 17.11. La imagen anterior queda
  para rollback.
- **Repositorio.** GCS `commerce-v7-pitr-1065291779811` en **us-central1** (otra
  región que la VM), cifrado AES-256-CBC por pgBackRest, `zst`, retención por
  tiempo de 7 días (`pitr_repository_policy.configuration`, sin
  `archive-push-queue-max`: nunca se descarta WAL). La clave del repositorio se
  genera en la VM (`render`), vive en un `env_file` 0600 de root y nunca toca
  stdout, evidencia, argv ni Git; además se custodia fuera del host (Secret
  Manager, versión añadible por la cuenta de la VM, lectura sólo del dueño) para
  poder restaurar en otra VM.
- **Archivado.** `archive_mode=on`, `archive_timeout=60s`,
  `archive_command=pgbackrest … archive-push %p` (síncrono). PostgreSQL entra a
  la red `commerce-os_pitr-edge` (puente con salida NAT, sin tráfico entre
  contenedores, puertos sólo en loopback) además de `core` (interna). Las
  guardas de topología del instalador (`api_web_deployment.topology_guard`,
  `copy_runtime_deployment.topology`) aceptan esa membresía sólo para
  PostgreSQL y sólo con esas propiedades.
- **Composición.** `infra/compose/postgres-pitr.yaml` se añade al final de todas
  las capas en `scripts/compose-release.sh` únicamente cuando existe
  `<private>/pitr/enabled`. Mismo volumen `pg`, misma red `core`.
- **Operador.** `scripts/v7_pitr.py` (Root): `preflight`/`status` de lectura;
  `render`, `build-image`, `enable`, `backup full|incr`, `rehearse`, `disable`.
  `enable` toma los cuatro locks, exige cero clientes, recrea sólo PostgreSQL
  con el mismo volumen, comprueba el `system_identifier` antes y después,
  `stanza-create`, `check` (fuerza y verifica un WAL archivado) y el primer full.
  Si algo falla después de recrear, vuelve sola a la configuración anterior.
  `rehearse --create-restore-point` (ventana, productores detenidos) restaura en
  un contenedor y volumen temporales hasta un punto nombrado, exige conteos
  idénticos de todas las tablas y la misma lista de migraciones, mide tiempos y
  borra ambos; sin la bandera restaura lo último archivado y reporta.
- **Calendario.** `commerce-pitr-full.timer` (domingo 08:20 UTC) e
  `commerce-pitr-incr.timer` (lunes–sábado 08:20 UTC), después de la ventana
  B02 de las 06:45. Cada respaldo deja un diario privado y una fila en
  `platform_backup_runs` (migración 0111, sólo el dueño escribe).
- **Laboratorio.** `tests/recovery/pitr_gcs_lab.py` ejecuta el operador real a
  través de `compose-release.sh` contra un repositorio con protocolo GCS
  (fake-gcs-server), incluida la función de salud de 0111, la verificación de
  que ningún texto plano llega al repositorio y el rollback de `disable`.
  Evidencia: `docs/evidence/v7-f1-pitr-gcs-lab-20261013.json`. No acredita GCS
  real, RPO/RTO de producción ni capacidad: eso se mide en la ventana.

## 2. Salud de plataforma y alertas (RNF-03.h, RNF-02.g)

- `GET /healthz/platform` responde 200 sólo si la base contesta, el archivado
  está activo y al día (≤2 segmentos pendientes, ninguno >5 min, sin fallo
  posterior al último éxito) y hay un respaldo base ≤36 h y un full ≤8 días.
  Si no, 503 con códigos (`ARCHIVING_DISABLED`, `ARCHIVE_BACKLOG`,
  `ARCHIVE_FAILING`, `BACKUP_STALE`, `FULL_BACKUP_STALE`,
  `RECOVERY_STATUS_UNAVAILABLE`). Sin fechas, tamaños, nombres ni conteos. Lee
  `platform_recovery_status()` (SECURITY DEFINER, EXECUTE sólo para
  `commerce_api`).
- El uptime check existente («Commerce OS production HTTPS readiness», 60 s,
  tres regiones, canal de correo verificado) se reapunta de `/readyz` a
  `/healthz/platform` después de `enable`. No se crea otro uptime check: el
  costo de checkers adicionales no está reservado.

## 3. Ingress durable (ADR-V7-08)

- **Dos rutas, una inserción.** WAHA conserva su callback al ingress del host
  (`http://ingress:3002/webhooks/waha/<perfil>/<cuenta>`) y suma uno al relay
  de Cloud Run (`https://…/relay/<token>/waha/<perfil>/<cuenta>`) con la misma
  llave HMAC. Las dos terminan en el mismo `INSERT … ON CONFLICT DO NOTHING`
  de `inbound_envelopes`; la segunda copia es un duplicado sin efecto.
- **Relay** (`infra/ingress-relay/relay.mjs`, un archivo sin dependencias):
  valida el token del camino en tiempo constante, exige cuerpo JSON ≤1 MiB y
  encabezados HMAC sha512, publica los bytes exactos con perfil, cuenta y HMAC
  como atributos y clave de orden `<perfil>/<cuenta>`, y responde 200 sólo con
  `messageId` confirmado; si no, 503 y WAHA reintenta. No ve secretos de cuenta,
  base de datos ni contenido decodificado. Cloud Run us-east1, mínimo 0/máximo
  2, identidad propia con sólo `pubsub.publisher` sobre su tema.
- **Consumidor** (`apps/automation-worker/src/ingress-relay-consumer.ts`, ciclo
  `ingress_relay`): sólo con `INGRESS_PUBSUB_SUBSCRIPTION`. Jala hasta 20
  mensajes con la identidad de la VM, los reenvía al ingress del host (que
  verifica el HMAC con el secreto de la cuenta) y confirma en 200 o rechazos
  definitivos (400/401/404/413/415); cualquier otro resultado es nack, con
  reintento de Pub/Sub y cola de mensajes muertos tras 10 intentos. Dentro de
  una clave de orden nada se confirma después de un reintento.
- **Sin reinicios extra.** `reconcileWebhook` añade el relay; la salud sólo
  exige el callback principal (`relay_matches` es informativo). Una sesión
  viva nunca se reinicia para añadirlo: se añade cuando la sesión estaba
  detenida y va a arrancar (por ejemplo, al reanudar tras la ventana).
- **Reversible.** Sin `INGRESS_RELAY_URL` en el channel-worker no se configura
  el relay; sin `INGRESS_PUBSUB_SUBSCRIPTION` el ciclo no hace nada.

## 4. Correo transaccional en App Engine (ADR-V7-13)

- **Servicio** (`infra/mail-appengine/`): Python 3.12 estándar, F1, 0–1
  instancias, un solo hilo (los plazos usan señales), identidad propia
  `commerce-v7-mail@`. Usa los módulos ya revisados
  `scripts/gcp_mail_dispatch.py`/`gcp_mail_native.py`: verifica el token de
  identidad Google de la cuenta de la VM (audiencia = URL del servicio), abre
  el sobre AES-GCM con la llave de Secret Manager, deduplica en un diario GCS
  con CAS de generación y hace una sola llamada a la Mail API desde
  `invitations@<proyecto>.appspotmail.com`. Un control `mail/control.json`
  (`enabled:true`) permite detenerlo sin redeploy. `scripts/v7_mail_appengine.py
  stage` arma el directorio de despliegue con configuración cerrada (sin
  valores secretos) y hashes.
- **Despachador** (ciclo `invitation_mail` del automation-worker): con
  `MAIL_DISPATCH_DATABASE_URL` (login del rol `commerce_mail_dispatch`),
  `MAIL_SERVICE_ORIGIN` y `MAIL_ENVELOPE_KEY`. Descubre sólo identificadores
  de trabajos en cola (`queued_profile_invitation_mail`, migración 0112) y usa
  `dispatchProfileInvitationMail` (reserva con cuotas 8/min, 100/día y
  presupuesto mensual, reclamo, un POST, cierre). Una respuesta perdida queda
  `UNCERTAIN` y nunca se reenvía. Aceptación del API no es recepción: se
  verifica en un buzón controlado.
- **Avisos al dueño (RF-07.e, migración 0116):** cada incidente de número
  abierto y su recuperación generan un trabajo propio (`owner-alert-v1`,
  versión 1 = abierto, 2 = resuelto) con la misma reserva, cuotas y
  presupuesto que las invitaciones; el aviso en la app y el MCP no cambia.

## 4b. Retención de «Probar número» (RF-19.o, D-18)

- Una prueba se guarda 30 días (`runs.expires_at`). Mientras tanto se exporta
  como JSON (`GET /v2/number-tests/:id/export`, MCP `exportar`).
- `commerce-lab-retention.timer` (diario 09:10 UTC) ejecuta como Root
  `scripts/v7_lab_retention.py run /opt/commerce-os/private/lab-retention/operator.json`:
  1. `commerce_number_lab.purge_expired_runs()` (sólo superusuario, migración
     `0114`) reemplaza captura, acciones y resultados por cifrado ilegible y
     borra los comprobantes; deja un recibo por prueba. Corridas, operaciones y
     ligas de IA quedan sin contenido porque la contabilidad de IA las
     referencia.
  2. `commerce_number_lab_engine.purge_run()` borra todo lo de la prueba en la
     base del laboratorio.
  3. Borra los archivos de comprobante en la custodia del laboratorio.
  Cada paso es idempotente y se reanuda desde el recibo.
- La configuración (`compose`, `workdir`, servicio de Postgres, usuario dueño,
  base principal, servicio del trabajador y carpeta del laboratorio dentro del
  contenedor) se escribe en la ventana de la Fase C.

## 4c. Arranque durable (RNF-03.c)

- `commerce-boot.service` (Root, `WantedBy=multi-user.target`, después de
  Docker) ejecuta `scripts/v7_boot.py run /opt/commerce-os/private/boot/operator.json`.
- Sólo hace `compose-release.sh <release.env> up -d --no-recreate --no-build
  --pull never <servicios>` con la release instalada (respeta el overlay PITR),
  espera `running`/`healthy` y deja un recibo 0600. Nunca recrea, descarga ni
  construye; nunca inicia sesiones de WhatsApp (eso es del supervisor de
  gateways y del channel worker) y nunca toca datos.
- Un archivo de retención (`hold`) escrito por una ventana de mantenimiento
  mantiene la plataforma detenida aunque la VM reinicie (`HELD_FOR_MAINTENANCE`).
- Los servicios ya tienen `restart: unless-stopped`; la unidad cubre los huecos
  de un reinicio (contenedores creados sin iniciar y el orden de dependencias).

## 4d. Copia diaria de archivos privados (RNF-03.e)

- PITR cubre la base. Los archivos privados (materiales, comprobantes y
  medios, ya sellados `*.enc` con la llave de datos) se copian sin descifrar
  con `commerce-files-backup.timer` (diario 08:50 UTC) a la misma cubeta de
  recuperación en otra región, prefijo `private-assets`, con la identidad de
  la VM (sin llave en disco). Se omite `uploads/` (temporal).
- Espejo: sube lo nuevo o cambiado (sha256 en metadatos); lo que desaparece
  localmente se marca y se borra de la copia a los 35 días (`grace_days`), así
  el borrado de privacidad alcanza la copia (D-18).
- `restore <config> <carpeta-vacía>` verifica sha y tamaño de cada archivo.
- La sesión de WhatsApp (W01) mantiene su copia existente
  (`commerce-waha-backup.timer`).

## 4e. B02 diario después de V7 (decisión conservadora y reversible)

B02 (volcado cifrado diario + custodia, Cloud Scheduler/Cloud Run Job) valida
identificadores exactos de contenedor y proyecciones con Pid/StartedAt de la
topología adoptada. La topología V7 (overlay PITR, arranque durable, reinicios
por mantenimiento) cambia esos valores por diseño, así que B02 rechazaría cada
corrida después de un reinicio. Su autorización financiera además termina
antes del 2026-11-04.

Decisión: en la ventana de la Fase C se ejecuta un B02 fresco final (con
cobertura W01/medios) y su restauración aislada verificada antes del primer
cambio. Después de instalar V7 y verificar PITR (respaldo completo + WAL +
restauración de ensayo) y la primera copia de archivos, el Scheduler de B02 se
**pausa** (no se borra). Reanudarlo es un solo cambio en Google. El Job, la
imagen, los respaldos B02 y su custodia se conservan; la limpieza de recursos
de B02 queda para la fecha de vencimiento de su autorización, como ya prevé
su ADR. Respaldo vigente después de V7: PITR (base), copia de archivos
privados y W01.

## 4f. Credenciales de ejecución nuevas (V7)

- `scripts/v7_runtime_env.py logins <config>` crea una vez, por rol revisado,
  un LOGIN propio sin privilegios (`commerce_ai_v7_login` → `commerce_ai`,
  `commerce_results_v7_login` → `commerce_results`, ambos NOINHERIT con
  `SET ROLE` al conectar; `commerce_mail_v7_login` hereda
  `commerce_mail_dispatch`) y escribe `AI_DATABASE_URL`,
  `RESULTS_DATABASE_URL` y `MAIL_DISPATCH_DATABASE_URL` sólo en los `.env`
  de los servicios que los usan (0600, copia previa con fecha). Un login ya
  configurado se conserva; no hay rotación silenciosa.
- `merge` copia sólo las llaves `LAB_*` que escribe el instalador del
  laboratorio; `generate` crea en la VM la llave de sobres del correo
  (`MAIL_ENVELOPE_KEY`, 32 bytes) y el token del relay (dentro de
  `INGRESS_RELAY_URL`), primero los custodia como versión nueva de Secret
  Manager (la cuenta de la VM sólo puede añadir versiones, nunca leerlas; App
  Engine y Cloud Run leen la suya) y luego los escribe; si ya existen no se
  rotan. `set` escribe valores no secretos (orígenes, suscripción de
  ingress). Ningún comando imprime valores; `generate` imprime la versión y
  el sha256 para que el dueño compare.

## 5. Pendiente de esta ADR (se completa en las siguientes entregas de F1)

Identidad de la VM, recursos GCP declarativos, presupuesto y orquestación de
la ventana (Fase C, `docs/v7-fase-c-runbook.md`).
