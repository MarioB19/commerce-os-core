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

## 3. Pendiente de esta ADR (se completa en las siguientes entregas de F1)

Identidad de la VM, recursos GCP declarativos, presupuesto, ingress durable
(ADR-V7-08), correo App Engine (ADR-V7-13), arranque durable y orquestación de
la ventana (Fase C).
