# Recuperación de órdenes de canal sin ejecutar · 7-oct-2026

Una orden durable puede quedar PENDING sin que channel-worker esté disponible. La conexión posterior devuelve LIFECYCLE_COMMAND_PENDING y el alta muestra IN_PROGRESS indefinidamente. El heartbeat existente permite distinguir la cola de la ejecución observada.

La proyección del alta mostrará el bloqueo del servicio y las órdenes que aún pueden cancelarse. Una acción `cancel_pending`, compartida por web/API/MCP, cancelará exclusivamente una orden PENDING de la misma cuenta, workspace y entorno cuyo resultado siga exactamente vacío. La transacción mantiene el mismo advisory lock que el claim del worker y valida las revisiones de cuenta y sesión. Una orden reclamada, completada o incierta no se puede cancelar por esta vía.

La cancelación conserva el historial y registra FAILED / NOT_ATTEMPTED, actor y motivo; no representa un readback del proveedor. Las órdenes de ciclo de vida conservan la sesión pausada y STOPPED como intención para evitar recuperación automática. No se alteran credenciales, identidad observada, permisos comerciales ni otros números. Cancelar no conecta el teléfono: el servicio y gateway deben estar disponibles, y el QR requiere escaneo humano.

Las solicitudes durables mantienen su semántica 202; no se arranca infraestructura durante esta reparación. Publicación de software y recuperación física requieren su autorización propia.


La migración 0066 preserva el límite SQL del rol `commerce_api`: sigue sin poder actualizar genéricamente `commands.status`. La API llama a `public.cancel_pending_channel_command`, una función `SECURITY DEFINER` limitada a una orden PENDING con resultado exactamente `{}`, tipo de canal permitido y cuenta/workspace/entorno vinculados. Revalida las versiones esperadas de cuenta y sesión bajo el mismo advisory lock del claim, con bloqueo de la cuenta y sesión. Sólo el rol API puede ejecutarla; los permisos HTTP, actor, idempotencia y auditoría siguen en la ruta canónica.

La función usa tablas calificadas y `search_path=pg_catalog,public,pg_temp` para que los triggers existentes puedan resolver `records`; `public` no es escribible por el rol API y `pg_temp` queda al final. No concede UPDATE de estado, permisos de bootstrap ni acceso a consumidores. Su instalación debe preceder a la publicación de la API que la invoca y a la reanudación de workers.

La prueba de integración crea una base propia derivada del `DATABASE_URL` desechable de CI, aplica las migraciones y carga el pool API bajo `commerce_api`. Un proceso separado ejecuta el claim real como `commerce_channel` con proveedor sintético sin conexión externa y bloqueo de `fetch`. Observa la cola real de advisory locks en ambos órdenes: si gana cancelar no hay llamada al proveedor; si gana reclamar, se rechaza cancelar y se conserva UNKNOWN. También verifica replay de la misma clave y rechazo de payload cambiado sin repetir la mutación. La prueba retira únicamente su propia base al finalizar; no requiere `DATABASE_URL_OWNER` ni archivos fuera del repositorio.
