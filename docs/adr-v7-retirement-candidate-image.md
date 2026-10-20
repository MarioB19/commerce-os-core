# Exportación previa a V7 con la imagen candidata

19-oct-2026. La instalación de `a7558dc1` se detuvo antes del SQL de V7:
`V7_RETIREMENT_EXPORT_FAILED`. La imagen indicada por `release.env` sigue
siendo la versión instalada durante la preparación y no contiene
`scripts/v7-retirement-export.ts`. El respaldo previo terminó; el intento
fallido y su hold se conservan hasta reconciliar el estado real.

El exportador debe ejecutarse con el ID inmutable de la imagen candidata
cargada. Se obtiene mediante `loaded_candidate_image`, que compara el
manifiesto del paquete con la imagen Docker: fuente, capas, plataforma e ID.
La validación ocurre antes de crear el directorio de exportación o ejecutar
una tarea. No se cambia `release.env` para seleccionar temporalmente otra
imagen, ni se modifica la versión anterior.

Se conserva el usuario Root, el contenedor de sólo lectura, los límites de
tiempo, la conexión administrativa, el directorio privado y la comprobación
de los recibos cifrados antes de migrar. Una imagen que no coincide con el
paquete se rechaza sin exportación ni SQL.

La regresión reproduce `release.env=old-image` y una candidata distinta;
exige que el comando del exportador use el ID verificado. También cubre una
candidata de otra fuente y la ausencia de efectos ante ese rechazo.

## Adenda 20-oct-2026 — lectura de la imagen V7 (Agente: Claude)

La instalación de `59768f73` (paquete `cv-fd09b802-…-1`) volvió a terminar
`V7_RETIREMENT_EXPORT_FAILED` antes del SQL, ahora con
`EACCES: permission denied, open '/app/package.json'`. La imagen V7 guarda
`/app` como archivos `0600` del usuario `node` (1000) y el exportador corre
como Root con `--cap-drop ALL`: sin `CAP_DAC_OVERRIDE` ni
`CAP_DAC_READ_SEARCH`, Root no puede leerlos. La imagen V5 no tenía ese
endurecimiento, por eso no apareció antes.

Decisión: añadir sólo `--cap-add DAC_READ_SEARCH` a esa ejecución, el mismo
patrón de `b02-backup-root.py`. Root lee el código de la imagen y escribe
únicamente en el directorio privado de exportación, que es suyo (0700); el
contenedor sigue de sólo lectura, sin red externa, con
`no-new-privileges` y sin otras capacidades. No se cambian permisos de la
imagen ni el usuario del exportador (un usuario `node` no podría escribir en
el directorio privado de Root).

Verificación: en producción, con la candidata cargada y el modo `status`
del exportador (sólo lectura), la llamada actual falla con `EACCES` y la
llamada con la capacidad lista las tablas a exportar. La regresión exige
exactamente esa capacidad adicional y falla con el código anterior.

## Adenda 20-oct-2026 (tarde) — llave de datos del exportador (Agente: Claude)

La instalación de `c629c27f` (paquete `cv-e028f78f-…-1`) pasó la lectura de
la imagen y terminó `V7_RETIREMENT_EXPORT_FAILED` con
`PRIVATE_DATA_KEY_REQUIRED`, otra vez antes del SQL. El exportador sella cada
tabla con la llave de datos de la aplicación, pero el instalador sólo le pasa
`admin.env`, que en producción contiene únicamente la conexión del dueño. La
llave vive, idéntica, en los `.env` de los servicios.

Decisión: el instalador lee `PRIVATE_DATA_KEY` de `api.env` (64 hex o base64
de 32 bytes; cualquier otra forma detiene la exportación antes de crear
archivos o ejecutar tareas), la escribe sola en un archivo `0600` del
directorio del reporte, lo pasa como segundo `--env-file` y lo borra al
terminar la tarea, también si falla. La llave nunca va en argv ni en el
reporte. `admin.env` no cambia.

Verificación: ensayo de punta a punta en la VM temporal de empaquetado, sin
producción: PostgreSQL desechable en red interna, esquema V5 (0001–0068), el
exportador con exactamente las banderas y archivos del instalador corregido
(manifiesto escrito y `verify` correcto) y después 0069–0117 con sus recibos
(117 migraciones). En producción, la imagen V5 que aplica las migraciones lee
su código como Root sin capacidades. Regresiones: contenido y modo del archivo
de llave, orden de `--env-file`, ausencia de la llave en argv, borrado tras
éxito y tras fallo, y rechazo sin llave válida.

## Adenda 20-oct-2026 (noche) — comparación comercial de la publicación V7 (Agente: Claude)

La instalación de `727623e0` (paquete `cv-471e9e64-…-1`) exportó los módulos
retirados y aplicó las 49 migraciones (117), y se detuvo con
`COPY_RUNTIME_COMMERCIAL_CONFIGURATION_CHANGED` sin activar V7; producción
regresó al snapshot frío. La comparación hashea filas completas de
`manual_controls`, `integration_settings`, `commercial_assignments`,
`operation_authorizations` y de las tablas retiradas: con V7 cambia siempre,
porque 0109 elimina las tablas retiradas ya exportadas (en producción
`creative_budgets` 3 filas e `intelligence_searches` 4) y las migraciones
agregan columnas (`manual_controls.environment`/`scope_record_id`,
`commercial_assignments.variant_id`).

Decisión: sólo en la publicación del perfil V7 la comparación proyecta cada
fila sobre las columnas que existían antes de migrar y deja las tablas
retiradas a los recibos del exportador (0109 los verifica). Cualquier fila
cambiada, añadida o eliminada sigue deteniendo la instalación. Las demás
publicaciones conservan la consulta histórica byte a byte.

Verificación con datos reales: la proyección de la base migrada del disco del
intento fallido (117) y la de producción en V5 (68) dan el mismo hash
(`801e43f6…`; 27/6/49/21 filas). Regresiones de la consulta y de las columnas.
