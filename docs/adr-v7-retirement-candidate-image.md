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
