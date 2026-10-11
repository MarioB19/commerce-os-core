# ADR · ampliación táctica del VPS · 21-sep-2026

## Decisión

Ampliar la VM existente `vibe-conversa-prod`, en `us-east1-d`, de `n1-standard-2` (2 vCPU, 7.5 GB) a `n1-standard-4` (4 vCPU, 15 GB) y el disco raíz `pd-standard` de 50 GB a 100 GB. Se preservan la misma VM, IP, disco, volúmenes y adaptadores; no se crea otra topología.

Aplicar después el perfil de contenedores versionado en `infra/compose/production.yaml`:

| Servicio | CPU anterior → nueva | RAM anterior → nueva | Ajuste interno |
|---|---:|---:|---|
| PostgreSQL | 0.8 → 1.6 | 1200 MiB → 2 GiB | `shared_buffers` 256 → 512 MiB; `shm_size` 256 → 512 MiB |
| API | 0.4 → 0.6 | 384 → 512 MiB | pool conserva 5 |
| Ingress | 0.3 → 0.4 | 256 → 384 MiB | pool conserva 3 |
| Automation worker | 0.5 → 0.8 | 512 → 768 MiB | pool conserva 5 |
| Channel worker | 0.4 → 0.7 | 384 → 512 MiB | pool conserva 5 |

PostgreSQL conserva `max_connections=80`. La lectura previa observó 15 conexiones cliente; aumentar pools o conexiones sin espera demostrada sólo elevaría la contención. Los tres gateways conservan 768 MiB y 0.3 CPU cada uno porque no mostraron presión de memoria ni forman parte de este ajuste.

## Evidencia que dispara la decisión

La muestra previa a la ventana confirmó `n1-standard-2`, carga de `4.34 / 2.80 / 2.83`, cola ejecutable de hasta 6 y espera de I/O de 0–1 %. PostgreSQL consumió aproximadamente 80.7 % de CPU con límite de 0.8 CPU. La VM conservaba cerca de 4.6 GB de RAM disponible, por lo que el cuello inmediato es CPU y no memoria.

El filesystem raíz mostraba 48 GB, 42 GB usados y 5.5 GB libres (89 %). El disco de Compute Engine es `pd-standard` de 50 GB; llevarlo a 100 GB recupera margen para paquetes sellados, releases y respaldos sin borrar evidencia.

## Ventana y aplicación

1. Confirmar respaldo, política REAL congelada, ausencia de instalación en curso e inventario exacto de contenedores/gateways.
2. Detener la VM, cambiar el tipo a `n1-standard-4`, ampliar el disco a 100 GB y arrancar. Confirmar 4 vCPU, RAM, partición/filesystem y HTTPS.
3. Los gateways tienen `restart=no`: arrancar únicamente los tres contenedores inventariados y verificar sus sesiones; no crear ni vincular cuentas.
4. Publicar el mismo árbol integrado en `main`. Mientras Actions siga bloqueado por presupuesto, construir las cuatro imágenes `linux/amd64`, sellar el paquete con `package-ci.py` y ejecutar los instaladores canónicos manualmente, sin presentar el workflow fallido como CI verde.
5. Ejecutar `scripts/apply-production-resource-profile.sh /opt/commerce-os/private/release.env`. Conserva el volumen de PostgreSQL, congela REAL, recrea PostgreSQL/API/ingress/workers y deja cualquier reactivación para una aprobación owner separada.
6. Verificar límites efectivos, seis servicios sanos, tres gateways/sesiones preservados, release/SHA, HTTPS, disco y una muestra comparable de carga/latencia.

Rollback de cómputo: detener y volver a `n1-standard-2` si la VM no arranca o falla la verificación. El disco no puede reducirse; 100 GB se conserva. La aplicación mantiene el rollback de release existente y nunca restaura automáticamente la base.

## Resultado de la ventana · 22-sep-2026 UTC

La ampliación quedó aplicada: VM `RUNNING` en `n1-standard-4`, 4 vCPU, 14 GiB visibles, disco de 100 GB y ext4 de 96 GiB con 54 GiB libres. `/readyz` respondió `ready`; PostgreSQL y los cuatro procesos de aplicación quedaron `healthy` con los límites de esta ADR. PostgreSQL reportó `shared_buffers=512MB` y `max_connections=80`.

Se usó el bypass manual autorizado porque Actions no inició runners por presupuesto. No se reconstruyeron imágenes ni se cambió el release activo: fue una aplicación de configuración sobre el árbol integrado en `main` (`2dceb83bc0a17580155e1a6b11397675f2319bed`). El archivo completo no era válido como overlay sobre el release anterior por listas Compose acumulativas; la validación lo rechazó antes de detener servicios. Se aplicó después un overlay privado mínimo, sólo con CPU, RAM, `shm_size` y comando de PostgreSQL. El siguiente release normal hereda los mismos valores desde el archivo base versionado.

Los tres contenedores WAHA existentes se arrancaron sin recrearlos y conservan identidad almacenada, pero las sesiones permanecieron `STOPPED` después de estabilizar. No se eludió el control de lifecycle ni se inició una sesión directamente contra el proveedor: `DISPATCH_FROZEN=true`, `REAL_SENDS_ENABLED=false`, `ALLOW_REAL_OPERATIONS=false`, cuatro ownerships congelados y cero operaciones en vuelo. Su reconexión requiere autorización owner separada. [Recibo sanitizado](evidence/tactical-vm-resize-2026-09-22.json).

## Oportunidad futura, fuera de este cambio

Si después de medir con 4 vCPU persisten saturación, colas o necesidad de alta disponibilidad, evaluar separar PostgreSQL administrado y gateways/workers en nodos independientes con métricas y alertas. Esta ADR no aprueba ni implementa esa arquitectura.
