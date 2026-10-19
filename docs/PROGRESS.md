# Estado de publicación

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
