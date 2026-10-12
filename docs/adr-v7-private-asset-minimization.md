# D18 — Minimización de assets y candidatos nativos (038)

12-oct-2026. Decisión previa a la implementación. Complementa031–037 y no
concede autoridad de borrado a una API o a un manifiesto del solicitante.

El lector035 deriva assets desde registros propios y toda su historia y busca
referencias en el catálogo global bajo el fence035. Una clasificación BLOCKED
impide preparar; SHARED conserva contenido y archivo. Sólo OWNED puede pasar a
un cuerpo mínimo sin nombre, URL, credenciales, clave de almacenamiento o texto.
Los enlaces y accesos propios también se minimizan, aunque no tengan archivo.
Todos los cuerpos/versiones se verifican por hash de fila completo y contra la
cobertura restaurada037; ninguna fecha sustituye esos pins.

038 conserva un lote privado e inmutable de hashes, identidades técnicas y
mínimos. Los descriptores de archivo proceden exclusivamente del restore036,
con clave canónica y hash de ciphertext medido. La API privada recibe job y
leases, nunca listas de assets, paths, hashes de fuente ni clasificaciones.
Una relectura completa035 debe reproducir el lote antes de cada captura y antes
de crear la admisión del commit final. El contador del fence es una condición
nativa de cada transacción, no forma parte de un hash que cambie sólo por leer.

Las marcas permanentes se insertan en la misma transacción que la minimización.
Cada UPDATE conserva versión/fechas/identidad y coincide exactamente con hashes
previo y posterior del lote. No crea snapshots de contenido original. Los
guards históricos se extienden sólo desde sus fuentes exactas; no se desactivan.
Las referencias nuevas a assets minimizados se rechazan incluso anidadas. Las
referencias técnicas ya retenidas por032 sólo pueden persistir mediante su
corrección auditada nativa, sin conceder acceso al material.

El método apply permanece privado, sin grant a runtime ni puerto de admisión.
Su admisión futura debe tener el backend, transacción, los dos leases y el hash
del lote revalidado antes de modificar registros033 o copias035. Así puede
consumir el preimage validado dentro del mismo fence después de esos cambios,
sin pretender que un reescaneo posterior reproduzca referencias ya borradas.
El ensamblador verificará también agregados034 y pins037 de los demás objetos.

La captura de archivos mantiene el namespace EX durante la medición y el commit
SQL, sin I/O dentro de la transacción. El borrado durable de ciphertext ocurre
después de ese commit mediante su journal. Una fase SQL minimizada no equivale a
archivos ausentes, y038 no cierra por sí solo el job, la renovación de autoridad,
la protección de restores antiguos ni los plazos separados de logs y TEST.
