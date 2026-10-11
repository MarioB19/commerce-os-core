# ADR — Revisión y sellado Root de la continuidad de la copia

Fecha: 2026-10-08. Estado: implementado localmente; no acredita observaciones,
aprobaciones, respaldo ni instalación productivos.

La vía SSH autorizada vuelve a estar disponible. Los consumidores de aprobación
ya existen, pero no hay un emisor canónico. Se agrega un comando Root acotado
`copy-runtime-approvals.py` con dos operaciones separadas: `observe` y `seal`.
No se cambia el transporte CI, los instaladores ni sus guardas.

`observe ARCHIVE HASH SHA RUN-ATTEMPT REVIEW-ID` verifica el paquete completo en
un staging privado, distinto de la futura release. Los propios módulos cargados
deben coincidir byte por byte con ese paquete. El SHA y run del manifest, las
67 migraciones y los tres controllers B02 se ligan al paquete inmutable. Bajo
los cuatro locks canónicos, en su orden existente, se leen la pareja Root/B02,
journals, owner, perfiles, política, barreras, historial de migraciones y el
`edge_preflight` completo: todas las redes/endpoints, rutas IPv4 main y
definiciones/estado vivo de contenedores. Se conserva una observación privada
inmutable y sólo se devuelve un resumen sanitizado con su digest. Observar no
aprueba automáticamente lo observado.

Root revisa el candidato y ese resumen/recibo mediante la sesión autorizada.
`seal REVIEW-ID OBSERVATION-SHA256` constituye una decisión explícita distinta;
no acepta hashes de infraestructura, CIDs, cuerpos de aprobación, comandos ni
observaciones aportadas por el cliente. Verifica custodia y digest de la
observación, vuelve a leer paquete y estado nativo bajo los cuatro locks y
rechaza cambios. Sólo entonces escribe las dos aprobaciones cerradas existentes
y activa `copy-runtime-migrations.json` mediante CAS y lectura posterior. Los
refs B02 apuntan al `candidate_root` futuro exacto del run/attempt; no se extrae
anticipadamente en esa ruta, pues el instalador exige que aún no exista.

La fase inicial aprueba únicamente CORE_PREPARED, la red técnica fija vacía y
0066/0067. La continuación exige el mismo paquete preparado, las barreras de
cancelación/cuarentena y conserva la aprobación de red original; sólo sella
herramientas B02 nuevas para el candidate_root de OPERATING. No toma un hold,
arranca contenedores, crea redes, instala herramientas, ejecuta migraciones,
escribe SQL, altera Root/B02 o emite aislamiento/ownership. La aprobación no
sustituye el backup fresco ni ninguna comprobación del publicador.

Archivos privados nuevos usan Root600 y directorios Root700; escrituras
inmutables, NOFOLLOW, comprobación de inode/nlink, fsync y reemplazo atómico del
único puntero existente. Un fallo conserva staging y recibos parciales. La
repetición exacta verifica bytes; nunca sobrescribe una aprobación diferente.
Los procesos nativos tienen límites de tiempo y un fuse total. No hay backend
de fixtures seleccionable desde la CLI ni un modo de autoaprobación.

El archivo tar de entrada requiere también Root600 y un padre Root700. Se copia
por descriptor estable, con límites, fstat/lstat y hash, al staging privado; la
extracción posterior usa esa copia inmutable. Los readers ejecutados admiten
Root600/644 sin escritura group/others y deben coincidir con el paquete.
No se deben ejecutar los comandos desde un checkout propiedad de otro usuario.
Los recibos viven en `private/copy-runtime-reviews/REVIEW-ID/`; ni ese staging ni
las aprobaciones son artefactos públicos. La observación caduca a los30min antes
de sellar; un nuevo diagnóstico usa otro REVIEW-ID y conserva el anterior.

Antes del CAS se conserva `seal-intent.json` inmutable. Si una interrupción ocurre
después del CAS del puntero y antes de `seal.json`, sólo puede completarse el
recibo cuando intent, observación, paquete, nueva lectura nativa y puntero exacto
coinciden. No reescribe el puntero aplicado. Sin ese linaje o con drift se detiene;
no se presenta como sellado terminado ni se repone el puntero anterior.
Una repetición de un sellado ya confirmado verifica
refs y devuelve `SEALED_REPLAY_HISTORICAL`, sin afirmar vigencia del runtime.

Las regresiones usan datos sintéticos y archivos temporales: no se publican sus
recibos ni se consideran observaciones Root reales. Cubren drift, hashes,
custodia/TOCTOU, locks, límites, el preflight completo y escrituras fuera de
alcance. La ejecución productiva debe registrar por separado SHA, paquete,
observación revisada, sellos efectivos e instalación posterior.
