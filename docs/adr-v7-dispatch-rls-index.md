# Despacho de canal bajo el RLS forzado de V7 (Agente: Claude)

21-oct-2026. La segunda ventana de instalación de `3ebedd57`
(`cv-3dd6b366-…-2`) migró a 117 y se detuvo en `install-consumers`:
`channel-worker` nunca quedó sano (`/readyz` 503, `CHANNEL_LOOPS_NOT_READY`).
Su loop `channel_dispatch` ejecutaba la consulta de candidatos durante más de
9 minutos con los datos reales: 726k registros y 15 efectos bloqueados. El
`ANALYZE` completo y el reinicio no cambiaron nada. Producción regresó al
snapshot frío.

## Causa

La migración 0096 fuerza RLS en toda tabla con `workspace_id`, incluidas
`records`, `outbox` y las de warmup. Bajo RLS, un predicado del usuario sólo se
evalúa antes que la política (y por lo tanto como condición de índice) si es
leakproof.

- `texteq` y `uuid_eq` son leakproof.
- `uuid::text` (`uuid_out`) y `text::uuid` no lo son.

La consulta cruzaba `records c ON c.id::text=o.conversation_id` y
`records s ON s.id::text=c.body->>'simulation_id'`. Ninguno de los dos cruces
podía usar el índice `records_id_text_lookup`, que V5 sí usaba: el plan
escaneaba todos los registros por cada efecto candidato y evaluaba la política
en cada fila. Con el conjunto pequeño de las pruebas el costo no se nota, por
eso el FULL salió verde.

## Decisión

Los identificadores de texto se convierten a uuid dentro de CTE
materializadas:

- `base`: los efectos `READY`/`BLOCKED`.
- `conversations`: las conversaciones de esos efectos.

Sólo se convierten las cadenas en la forma canónica en minúsculas, las mismas
que produce `uuid::text`; cualquier otra no cruza, igual que antes. Después se
cruza por `uuid = uuid` y `text = text`. Así `records`, `warmup_conversations` y
`outbox_gate_schedule` se leen por su llave primaria.

La semántica no cambia: mismas filas, mismo reloj efectivo, mismo orden justo
por cuenta y mismo filtro del laboratorio de números. No hay migración ni
cambio de políticas o roles.

## Verificación

Laboratorio aislado (sin red externa) con una copia del disco de la ventana:
PostgreSQL 17 con 117 migraciones y datos reales.

- Como `commerce_channel_login`, la consulta baja de más de 9 min a 0.51 s.
  Las dos lecturas de `records` son `Index Scan` con `id = …`.
- La consulta original y la nueva devuelven exactamente las mismas 15 filas,
  en el mismo orden.
- El `channel-worker` del paquete, con el bundle parcheado de la misma forma,
  queda `READY` en menos de un minuto, con sus 15 loops `OK`.

Regresión de integración: bajo el rol `commerce_channel` y con
`enable_seqscan=off`, las dos lecturas de `records` de la consulta nueva usan
`id`. La forma antigua no puede hacerlo.

## Pendiente

Otras consultas cruzan con `::text` tablas con RLS. En el arranque y los loops
observados no bloquean, pero pueden degradarse con volumen. Se revisan aparte.
