# D18 — Lector global de referencias de activos (035)

Decisión de 12-oct-2026. Este incremento es una primitiva privada de lectura;
no concede autoridad de minimización, purga o acceso a archivos. Reutiliza el
catálogo y las claves primarias nativas de028, la admisión031, los hashes de
actuales y **todas** las versiones de033, el pase opaco035 y la exclusión global035.

## Contrato y exclusión

`read_privacy_asset_references(record_batch, opaque_pass, profile_lease,
reference_lease)` sólo recibe cuatro identidades. Deriva los candidatos de los
cuerpos actuales e históricos autenticados por033; no admite listas de activos,
hashes, clasificaciones ni declaraciones de ausencia de referencias del llamador.
El puerto TypeScript `readPrivacyAssetReferences` exige una respuesta cerrada,
perfil/lote exactos, historia consecutiva y `erasure_authorized:false`.

La sesión adquiere EX global035 antes del EX030 y antes de REPEATABLE READ. Antes
y después de la lectura se verifican admisión, lease/epoch/backend, catálogo y
triggers globales. Un nuevo perfil, tabla, columna, trigger condicionado o escritor
sin la guarda exacta invalida la prueba. La lease conserva30s; no hay reintentos.
La transacción sólo consulta SQL y devuelve pruebas técnicas, sin hacer I/O de
archivos o proveedor.

El resultado incluye `asset_id`, hash de fila actual, todos los hashes/versiones
históricos, `reference_sha256`, clasificación OWNED/SHARED/BLOCKED y causa cerrada.
El hash del conjunto se deriva exclusivamente de esos hechos: no incluye epoch,
conteos globales ni filas técnicas creadas para custodiar la propia operación.
Los conteos nativos completos permanecen en `coverage` como información separada.

## Capacidad y memoria

No hay límite de población total de la base. Cada relación del catálogo aporta
un COUNT nativo exacto. El predicado SQL usa tipos y columnas del mismo catálogo
para descartar escalares numéricos/temporales y etiquetas de ámbito, que no pueden
codificar una referencia material. UUID, texto, JSON, tipos restantes y bytea se
inspeccionan; únicamente los candidatos pasan a conversión JSON/PLpgSQL. Bytea no
nulo se trata como opaco. Una fila descartada por el predicado no se materializa
ni se almacena como evidencia individual.

La prueba **relevante a una conversación** sigue acotada:1000 activos,10000 filas
relevantes/64MiB,8MiB por fila y10000 hechos/8MiB, además de10000 versiones totales
en la respuesta. Se rechaza por completo si supera esos límites; no se trunca.
La lectura relevante usa LIMIT10001 para detectar y rechazar el exceso. Esas cotas
no certifican automáticamente cualquier cardinalidad futura por conversación.

El gate de escala local usa2,603,204 filas sintéticas adicionales y los demás
componentes/roles nativos. Se mide tiempo bajo la lease real y tamaño de tabla.
No sustituye la medición de una copia restaurada con la distribución productiva.
El primer ensayo usó256MiB tmpfs/384MiB RAM y produjo OOM; se archivó la base
recuperada antes de retirar sólo su contenedor. El sucesor usa overlay privado,
1GiB RAM y memoria temporal acotada; ninguna prueba cambia daemon ni volúmenes
existentes. Los resultados se documentan tras finalizar, incluidos fallos.

## Propiedad y límites explícitos

Sólo033 actual/historia, outbox de esa conversación, comandos de recursos propios
y eventos de esos recursos acreditan propiedad. Otra referencia por perfil,
entorno o propósito queda SHARED. Alias de storage_key en otro activo también
se detecta, aunque su UUID o perfil sea diferente. Se validan adaptadores cerrados
y toda la historia; para private_file, las claves existentes deben ser estándar,
coherentes con UUID/hash e idénticas. El historial UPLOAD_PENDING sin clave no
inventa un archivo. Link sin clave se admite por su esquema; access cifrado no
adquiere propiedad por el nombre del adaptador.

**Todo cifrado sin binding de propósito autenticado queda BLOCKED**, incluso el
propio activo, credenciales, ingress, mensajes/eventos, evidencia de recibo,
identidad warmup y ajustes bancarios. El único pase disponible en este corte cubre
idempotency/imports bajo esquemas cerrados y hashes nativos actuales. No se infiere
que una clave, un prefijo o la ausencia de UUID visible prueben ausencia de activos.
Por ello esta primitiva aún bloqueará bases reales con otras familias cifradas:
la extensión del pase por propósito y descifrado RAM autenticado sigue pendiente.
No se declara privacidad operativa ni purga completa.

El pase read-only tampoco acredita que bytes actuales estén en backup por su
created_at/committed_at. Apply requiere037 con pins completos restaurados de cada
fila y el ensamblador final debe componer031/032/033/034, copias y archivos. Los
mínimos financieros032 no autorizan conservar archivos adjuntos cinco años.
La marca privada038 impedirá nuevas referencias tras minimización; este lector
no crea esa marca ni concede acceso a su función.
