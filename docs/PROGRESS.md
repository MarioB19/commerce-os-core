# Estado de publicación

## 20-oct-2026 — lectura de la imagen V7 en el exportador (Agente: Claude)

`main` `59768f73` pasó FULL `fd09b802` y su atestación `6ecf3514`; el
paquete `cv-fd09b802-25bc-4f0e-80e5-b9012d51de0d-1` (`ab161b4f…`) se observó
y selló. La instalación terminó `FAILED` en `reviewed-migrations`, otra vez
antes de cualquier SQL: el exportador, ya con la imagen candidata, corre como
Root con `--cap-drop ALL` y no puede leer `/app/package.json` (archivos
`0600` del usuario `node` en la imagen V7). Producción se reconcilió el mismo
minuto: `80a6d6ea`, 68 hashes de migración sin cambio, hold liberado,
workers arriba, REAL congelado, cero envíos.

Corrección: `--cap-add DAC_READ_SEARCH` sólo en esa ejecución (patrón de
`b02-backup-root.py`). Probada en producción con el modo `status` del
exportador: sin la capacidad, `EACCES`; con ella, lista de tablas. La
regresión falla con el código anterior y pasa con el nuevo; 117 pruebas
`test_copy_runtime*` en verde. FULL, atestación, paquete e instalación del
nuevo commit siguen pendientes.

Decisión: [adenda del ADR](adr-v7-retirement-candidate-image.md).

## 19-oct-2026 — corrección del exportador previo a V7

La instalación canónica de `a7558dc1` terminó `FAILED` antes del SQL de V7:
el exportador se ejecutaba con la imagen instalada, que no contiene el
archivo de V7. Producción conserva `80a6d6ea` y sus 68 hashes de migración.
El respaldo local previo terminó y las dos credenciales personales siguen
válidas. El intento fallido requiere reconciliación; no acredita instalación.

La selección del exportador usa ahora el ID inmutable de la candidata,
verificado contra fuente, capas y plataforma del paquete. La regresión falla
con el código anterior y pasa con la corrección; una imagen de otra fuente
se rechaza antes de crear archivos o ejecutar tareas. El test sintético de
B02 fija su disponibilidad de disco para no depender del espacio de la Mac;
la guarda de espacio de producción no cambia.

Validación local: 14 pruebas de migración operativa; suite Python completa
con Node 24: 1,835 pruebas, 2 omitidas, sin fallos. FULL y atestación del
nuevo commit, instalación y comprobación productiva siguen pendientes.

Decisión: [imagen candidata para exportar](adr-v7-retirement-candidate-image.md).
