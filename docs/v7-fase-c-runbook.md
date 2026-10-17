# V7 Fase C — Guía de la ventana única

Agente: Claude · 14-oct-2026, revisada el 16-oct-2026 · rama `claude/v7-f2-cutover`.
Orden obligatorio de la ventana que lleva producción de `80a6d6ea`
(68 migraciones) a la V7 (117 migraciones) con un solo despliegue. Complementa
`docs/adr-v7-f1-infrastructure.md` (§1–4g), `docs/adr-v7-profile-deletion.md`
y `docs/adr-v7-health-retention.md`.

**Revisión del 16-oct (ensayo sobre una copia de producción):** la base mide
9 GB por la telemetría de salud sin purgar, B02 falla desde el 13-oct (volcado
mayor a 1 GiB) y las 49 migraciones tardan 850 s contra el límite de 300 s del
instalador. Por eso el respaldo previo al primer cambio es el snapshot frío
restaurado y verificado (§1), sigue el corte de telemetría (§2) y sólo después
el B02 fresco (§3).

**Revisión del 17-oct:** la retención interina de telemetría corre en
producción desde el 17-oct (8 días, temporizador
`commerce-health-retention-interim.timer`), así que B02 vuelve a caber en
1 GiB. La cuota de 37 corridas en 30 días no deja slot del 1 al 3 de noviembre
(se libera el 6-nov 12:01): el respaldo lógico previo es el último B02 natural
con su restauración aislada (§3). La renovación de B02 hasta el 2026-12-04 se
aplica en §6.6 (`docs/adr-v7-b02-renewal.md`).
**HA multizona y BD HA siguen diferidas (D-16)**: la ventana entrega
recuperación medida, nunca failover.

Reglas que gobiernan toda la ventana:

- Una sola ventana. Ningún paso se repite a ciegas: cada operador es
  idempotente o se reanuda desde su recibo; un resultado incierto se concilia
  leyendo, nunca reenviando.
- Nunca se restaura una base anterior sobre ingresos nuevos. Después del
  primer cobro o mensaje REAL posterior a la instalación, el único regreso es
  hacia adelante (corrección o reinstalación compatible).
- No se envía outbound, no se crean asignaciones y no se toca gasto (AGENTS.md,
  regla 2 con el ajuste V7 de D-01/D-17).
- Ningún comando imprime secretos; la evidencia guarda nombres, digests,
  conteos y tiempos.

## 0. Precondiciones (todas en verde o no se abre la ventana)

| Gate | Fuente |
|---|---|
| SHA congelado = SHA del FULL de `main` = SHA del paquete publicado y atestado | Fase B (bitácora) |
| FULL local de 21 etapas y FULL PR/`main` en Cloud Build `SUCCEEDED` | `scripts/cloudbuild-verify.py`, recibos |
| Ensayo de restauración en laboratorio con la imagen V7 (PITR + archivos) | `tests/recovery/pitr_gcs_lab.py`, `v7_pitr.py rehearse` |
| Revisión económica con Billing real: bruto GCP del mes + extra ≤ techo | «💵 Revalidación económica V7» |
| Último B02 natural `SUCCEEDED` (31-oct 06:45 UTC) y renovación de B02 hasta el 2026-12-04 en el código instalado | custodia Root B02, `docs/adr-v7-b02-renewal.md` |
| Credenciales vigentes: token `claude-cowork` (vence 14-dic-2026), GitHub, ADC | `~/claude-v7-acceso` (sólo lectura) |
| Lista de acciones físicas de Brandon vacía o no bloqueante | bitácora |

## 1. Mantenimiento, snapshot frío y restauración verificada (antes del primer cambio)

1. Tomar los cuatro candados Root (instalador, B02, arranque, adopción).
2. `scripts/v7_infra_adoption.py capture` (definiciones de contenedores con
   valores reemplazados por SHA-256; sin secretos).
3. Retención de REAL (`release_hold`) y detener productores: ingress,
   automation-worker y channel-worker, en ese orden; esperar cero claims
   activos y cero efectos `INTENT` sin recibo.
4. Conteos de todas las tablas y lista de migraciones (68) de la base viva.
   Parada limpia de PostgreSQL (checkpoint) con el volumen intacto.
5. Snapshot del disco de arranque (100 GB) de `commerce-os-test`; esperar
   `READY`. Es el punto de regreso del §4 e incluye las sesiones y medios de
   WhatsApp (cobertura W01/medios).
6. **Restauración aislada del snapshot**: disco pd-standard desde el snapshot,
   adjunto como disco *secundario* a una VM COS sin IP externa, sin cuenta de
   servicio y en una red sin NAT (ningún servicio del clon arranca y no hay
   salida a internet). PostgreSQL 17.11 sobre el volumen copiado: lista de
   migraciones y conteos iguales a los del paso 4; volúmenes de sesiones y
   medios presentes. Borrar VM y disco. Sin esta verificación no se continúa.
   (Ensayado el 16-oct: arranque en 8 s, 9.5 GB, 68 migraciones.)
7. Volver a levantar PostgreSQL (sin productores).

## 2. Corte de telemetría de salud (ADR de retención)

1. `scripts/v7_health_retention.py plan` y `cutover` con una configuración de
   `keep_days: 2` (productores detenidos; el operador lo exige): una sola
   transacción, verificación de referencias por conjuntos y borrado sin
   disparadores por fila. Conserva la última observación de cada llave.
2. `scripts/v7_health_retention.py compact`: `VACUUM (FULL, ANALYZE)` de
   `health_observation_index`, `record_versions` y `records`.
3. Registrar conteos, segundos y tamaño de la base.

## 3. Último B02 natural y su restauración aislada

La cuota de 37 corridas en 30 días está llena del 1 al 6 de noviembre: no se
puede lanzar un B02 fuera de horario sin quitarle el slot a un diario. El
respaldo lógico previo es el **último B02 natural** (31-oct 06:45 UTC, con la
retención interina el volcado cabe en 1 GiB); el punto de regreso exacto es el
snapshot frío del §1.

1. Confirmar ese B02 `SUCCEEDED` con su atestación `gcp-` y custodia.
2. **Archivos**: inventario de `<private>/assets` comparado con la copia.
3. **Restauración aislada**: restaurar ese B02 en un contenedor y volumen
   temporales y comprobar la lista de migraciones (68) y los conteos de todas
   las tablas (iguales a los de su hora de corte); borrar el temporal.
4. Registrar en evidencia: ids de corrida, sha del volcado, conteos y tiempos.

## 4. Plan de regreso a `80a6`

- **Antes de reanudar REAL** (§1–§7): regreso
  completo. Se restaura el snapshot frío del disco de la VM (§1.5, estado
  previo al corte) o, si sólo falló la aplicación, se reinstala el paquete
  `80a6` con el instalador canónico sobre la base restaurada del B02 del §3.
  No hay ingresos nuevos que perder porque REAL sigue retenido.
- **Después de reanudar REAL** (§8 en adelante): no se restaura ninguna
  base. Se corrige hacia adelante con otro paquete del mismo linaje, o se
  detienen productores (retención) y se decide con Brandon.
- Disparadores de regreso: instalador `FAILED`/`ROLLED_BACK`, SHA instalado
  distinto, `/api/version` distinto, migraciones ≠117, `/healthz/platform`
  503 que no se resuelve en 15 min, pérdida de conteos respecto al §3.

## 5. Instalación canónica Root del paquete V7

- El instalador canónico, con el paquete atestado del SHA congelado:
  - exporta los módulos retirados con la imagen candidata y `admin.env` en
    `<private>/v7-retirement-export/` (≤300 s; sin recibo, `0109` revierte
    toda la publicación y la base queda en 68);
  - crea `<assets>/number-lab` (0700) y aplica las migraciones 0069→0117;
  - recrea los servicios de aplicación; `automation-worker` añade el montaje
    `/data/laboratory`;
  - al llegar a `OPERATING` instala `commerce-runtime-boot.service`.
- Gate: estado `SUCCEEDED`, 117 migraciones con hash, recibo de exportación.
  La transacción de migraciones V7 tiene 600 s (las demás publicaciones, 300 s)
  dentro del plazo total de 1500 s del instalador. Ensayo sobre la copia de
  producción después del corte del §2: 90–270 s (sin el corte: 850 s).

## 6. Infraestructura F1 (orden fijo)

1. **Recursos declarativos** (`v7_gcp_foundation.py plan` → `apply`,
   `infra/gcp/v7-foundation.json`): cuentas `commerce-v7-vm`,
   `commerce-v7-ingress` y `commerce-v7-mail`; cubeta de recuperación
   (us-central1) y del correo; los tres secretos; tema, cola de muertos y
   suscripción ordenada del ingress; presupuesto con umbrales 50/80/90/100 % y
   pronóstico; relay de Cloud Run (`relay-deploy`, `relay-public`) y App Engine
   (`appengine-create` y `gcloud app deploy` del directorio de
   `v7_mail_appengine.py stage`).
2. **Identidad de la VM** (`v7_gcp_foundation.py vm-identity`): asigna
   `commerce-v7-vm`, que sólo tiene `storage.objectAdmin` en la cubeta de
   recuperación, `secretVersionAdder` en sus tres secretos (nunca lectura) y
   `pubsub.subscriber` en `commerce-v7-ingress-vm`. Cambiar la cuenta exige
   detener y arrancar la VM: se hace aquí, con productores detenidos.
3. **Variables V7** (`v7_runtime_env.py`): `logins`, `merge` de `LAB_*`,
   `generate` de `MAIL_ENVELOPE_KEY` y del token del relay (primero Secret
   Manager, después el `.env`), `set` de orígenes y suscripción. Recrear sólo
   los servicios afectados.
4. **PITR** (`v7_pitr.py`): `preflight` → `render` → `build-image` →
   `enable` (recrea sólo PostgreSQL, mismo volumen, `system_identifier`
   igual, `stanza-create`, `check`, primer full) → `rehearse
   --create-restore-point` (productores detenidos; conteos idénticos).
5. **Readopción Root** (`v7_infra_adoption.py observe` → `apply <sha>`): sólo
   acepta las variables V7 y el PostgreSQL del recibo PITR.
6. **B02: re-vinculación y renovación** (`docs/adr-v7-b02-renewal.md`). Los
   archivos Root de B02 cambiaron, así que:
   1. Construir el transporte con el SHA instalado
      (`infra/b02-cloud-run.Dockerfile`, misma base del SDK por digest) en la
      VM temporal de empaquetado y subirlo a `commerce-b02/transport`.
   2. Actualizar el Job a esa imagen (nueva generación, sin ejecutarlo).
   3. Condición IAM del invocador: `request.time < 2026-12-03T23:30Z`.
   4. Pausar el Scheduler.
   5. `setup-b02-gcp-scheduler.py` `readback`/`bind` con `valid_until`
      2026-12-04 y el plan nuevo, luego `gcp-observe` → `gcp-seal` →
      `gcp-apply` en `MANUAL`.
   6. Fase D: en el primer slot libre (desde el 6-nov 12:01), corrida manual
      genuina, restauración aislada, `gcp-propose-scheduled` y
      `observe`/`seal`/`apply` en `SCHEDULED`; reanudar el Scheduler.
7. **Temporizadores**: `commerce-pitr-full/incr.timer`,
   `commerce-files-backup.timer` (primera corrida manual y `restore` de
   prueba), `commerce-lab-retention.timer` (config `operator.json`) y
   `commerce-health-retention.timer` (config
   `<private>/health-retention/operator.json` con `keep_days: 8`; primera
   corrida `plan`). Al activarlo, deshabilitar y retirar
   `commerce-health-retention-interim.timer` y su servicio (17-oct).
8. **Alertas**: reapuntar el uptime check existente a `/healthz/platform`
   después de `enable`; canal de correo verificado. No se crean checks nuevos.
9. **Arranque durable**: reinicio controlado de la VM; comprobar que
   `commerce-runtime-boot.service` valida la custodia y deja gateways sanos
   sin iniciar sesiones.

## 7. Verificación de identidad del software

`SHA probado = SHA empaquetado = SHA instalado = SHA servido por HTTPS`
(`/api/version`), más el digest de cada imagen y la lista de 117
migraciones. Cualquier diferencia dispara el §4.

## 8. REAL continuo (D-01, RNF-01)

1. La tarea de vencidos cancela con registro, sin enviar, los mensajes,
   seguimientos y remarketing que vencieron durante la retención (sólo
   READY/BLOCKED sin intento ni claim; los inciertos se concilian).
2. Liberar la retención. Se reanudan únicamente las asignaciones humanas
   vigentes y elegibles (autorización continua sin pausa humana, número
   conectado, perfil activo). Nada se envía en ráfaga; la cuota consumida no
   se repone.
3. Calentamiento (D-17) sólo entre números del mismo perfil con su
   autorización QR.

## 9. Cierre de la ventana

- Evidencia sanitizada en `00 — Dirección/V7/evidencia/<fecha>/fase-c/`.
- Bitácora, índice y matriz actualizados con «Agente: Claude».
- Lista única de acciones de Brandon (QR físicos, buzón de prueba del correo).

## 10. Fase D (después de la ventana)

Verificación F9 sobre las 171 filas y 7 días de observación: PITR al día,
copias diarias, B02 natural, alertas, costos reales contra el techo y
continuidad de ventas.
