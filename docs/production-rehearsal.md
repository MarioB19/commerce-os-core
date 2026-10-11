# Ensayo de producción en Docker local

`node scripts/rehearse.mjs` ejecuta las imágenes Linux amd64 con `infra/compose/production.yaml` y un override local. Conserva los límites de CPU/memoria, raíz de sólo lectura, capacidades eliminadas, roles PostgreSQL separados, esquemas pg-boss separados y permisos de los mounts. Usa una base y una red propias; el proxy de HTTPS escucha sólo en localhost:18443 con una CA local de prueba.

El cierre registró 41 comprobaciones correctas en `docs/evidence/production-rehearsal.json`: acceso anónimo denegado, login con cookies Secure/HttpOnly, catálogo con roles mínimos, archivo cifrado, ingreso durable e idempotente, consumo de comandos por ambos workers, monitor UP/DOWN/UP, backup cifrado con snapshot y archivo privado, restore en otra base congelada y lectura del archivo recuperado como UID 1000.

El target administrativo `maintenance` incluyó Docker CLI 29.8.0 y utilizó el socket únicamente durante backup/restore. La fuente sensible de runtime, aprobación UI, migración causal y recuperación coincidió con diez hashes registrados en `docs/evidence/image-source-parity.json`.

Las imágenes y sus IDs de manifest/config están en `docs/evidence/release-images.json`. La distinción importa al transportar un Docker archive entre un almacén containerd y uno clásico. El instalador verifica el hash del archivo antes de cargarlo y fija los IDs observados en el destino.

Este ensayo valida funcionamiento y permisos; no mide capacidad del VPS. Linux amd64 se ejecutó bajo emulación en el Mac. Durante los procesos adicionales de inspección se observó un timeout transitorio de health check de ingress; el flujo funcional de recepción y deduplicación pasó. No hubo mensajes reales, gateways vinculados ni acciones remotas. Los contenedores, volúmenes y red del ensayo se retiraron al terminar; los archivos cifrados de la prueba permanecen en su directorio privado externo al vault.
