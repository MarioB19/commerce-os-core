# Lectura completa de salud con historial cubierto y fallback fiel

El readback de `5f1299147f164125077b26e70ecdbbf9a866af15` resolvió capacidad (124 ms) e Inicio (189 ms, sin parcialidad), pero salud devolvió 503 al agotar cuatro segundos. PostgreSQL identificó la consulta de historial de siete días como la cancelada: MD5 `54da665a02527db2dbf87aaeb9dd4521`, 528 caracteres. El EXPLAIN sin ANALYZE estima sólo 20 filas con el límite inferior COALESCE de un InitPlan; el rango real tiene 13.239 y 13.193 observaciones por cuenta. La tabla proyectada contiene aproximadamente 2,016 millones de filas y 39.741 de 39.741 páginas all-visible, además de inserciones recientes todavía no aspiradas.

## Decisión

La reescritura inicial separaba rango de siete días y predecesor. El EXPLAIN productivo mejoró la estimación a 2.973 filas, pero conservó accesos al heap y añadió un ordenamiento. No se adopta esa reescritura: la evidencia no acredita que por sí sola resuelva el timeout.

0065 añade un índice con las mismas claves de cuenta, ambiente, dimensión y fecha e INCLUDE de record_id, status, source y expires_at. La proyección conserva textos históricos sin un límite contractual; incluirlos sin condición podría abortar la migración o escrituras posteriores por el límite de tupla B-tree. Por ello la cobertura sólo aplica a fechas finitas cuya suma de bytes de **todos** los textos de claves e INCLUDE no supera 1.024. Se usa octet_length, COALESCE para NULL y suma bigint; el margen restante cubre UUID, timestamps y cabeceras. No se truncan ni normalizan valores.

Un segundo índice parcial usa las mismas claves originales para el complemento de más de 1.024 bytes, sin INCLUDE. Evita examinar todas las filas normales para hallar las excepciones y no añade anchura frente al índice existente. La consulta UNION ALL recorre ambas particiones exhaustivas y disjuntas dentro del mismo snapshot. Conserva el rango anterior, el máximo previo compartido y **todos sus empates**, filtros de alcance, fechas finitas y CASE de expiración. La elección del máximo previo sigue usando 0063; no se cambia la semántica de fechas no finitas.

No cambia fuente de verdad, permisos, interpretación de métricas, presupuesto de cuatro segundos ni error 503. El orden de fuentes dentro de empates temporales ya era indefinido; las verificaciones comparan todas las filas como multiset y métricas exactas normalizando únicamente ese orden de fuentes. 0063 y 0064 permanecen inmutables.

## Validación y despliegue

La regresión migra textos incomprimibles largos existentes, escribe y actualiza nuevos a través de commerce_channel, y lee mediante commerce_api. Cubre status/source libres, UTF-8, NULL, suma exacta 1.024/1.025 bytes, borde anterior empatado, comienzo/fin de ventana, futuro, fechas inválidas/no finitas y expiraciones inválidas/no finitas, para session y transport. Compara las tres ventanas contra la consulta previa.

El benchmark usa 500.000 observaciones sintéticas con proyección completa y 13.239 puntos de ventana objetivo intercalados en el heap; añade predecesores y fuentes de 10 KB. Compara salida exacta, planes y tiempos, incluyendo buffers PostgreSQL fríos mediante reinicio exclusivo del servidor local propio, escrituras posteriores sin VACUUM y la ruta HTTP completa. La caché de macOS no se vacía; no se extrapolan tiempos locales al VPS. Las otras tablas de efectos/recepción quedan vacías en esa fixture y el límite se declara en la evidencia.

CREATE INDEX transaccional puede bloquear escrituras mientras construye ambos índices: se publica mediante el instalador controlado con hold y respaldo previo. No se sustituye por DDL manual ni se cambia la migración ya aplicada. El gate final sigue siendo SHA instalado exacto, HTTP 200 completo con las tres ventanas y conservación del outbox productivo. Evidencia: [health-history-readback-20260928](evidence/health-history-readback-20260928/).
