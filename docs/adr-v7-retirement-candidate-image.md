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
