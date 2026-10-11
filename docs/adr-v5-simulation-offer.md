# V5: oferta explícita al copiar un flujo al laboratorio

Fecha: 2026-09-13 (America/Mexico_City). Decisión previa a implementación.

Un lanzamiento aprobado puede guardar la relación en `offer.workflow_version_id` sin modificar la versión publicada del flujo. El laboratorio admite por ello `offer_version_id` junto con `expected_offer_version` en `POST /v1/simulation-snapshots`. Ambos campos son opcionales como pareja; omitirlos conserva el contrato de `workflow.offer_version_id`. Nunca se elige la primera oferta ni se infiere una por precio, nombre o fecha.

La oferta explícita debe estar publicada, pertenecer al mismo workspace y entorno REAL, compartir el producto explícito del flujo y apuntar a esa versión exacta mediante `workflow_version_id`. Un flujo que ya fija otra oferta rechaza la selección. Las referencias y revisiones se leen de nuevo bajo bloqueo SHARE dentro de la transacción idempotente; retiro y edición concurrentes no pueden cambiar el paquete entre validación y copia. La selección explícita exige además permiso de lectura de ofertas, conservando la alternativa existente de catálogo `products:read`.

Sólo el cuerpo preparado de la copia recibe la oferta seleccionada. La fuente REAL, el importador aprobado, sus precios, sus versiones y los permisos operativos permanecen intactos. El snapshot reescribe todas las referencias al grafo SIMULATION y conserva en `source` los IDs y revisiones exactos de flujo y oferta, junto con el origen de la selección. MCP `simulation_snapshot` usa el mismo endpoint, revisiones y clave de idempotencia y fuerza SIMULATION. No crea mensajes, pedidos, recibos, llamadas al proveedor ni autorización comercial.
