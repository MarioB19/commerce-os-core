# D18 — Huellas nativas de filas restauradas (037)

Decisión previa, 12-oct-2026. Este componente no borra filas ni concede autoridad
para033/035/036. El atestador privado conserva una cobertura inmutable ligada al
backup031, al recibo de restore y a los originales autenticados. Una fecha de
creación o modificación nunca sustituye la prueba de los bytes restaurados.

Un generador usa el catálogo completo028 (columnas, tipos, nulabilidad y claves
primarias exactas). Instala lectores cerrados por perfil REAL, incluidas filas
sin entorno o con entorno nullable cuando el catálogo las clasifica así. Se
capturan TODAS las filas de cada relación inspeccionada, sin lista pública de
IDs ni exclusiones del solicitante. Cada entrada contiene únicamente relación,
SHA256 de la PK JSONB nativa y SHA256 de `to_jsonb(fila)::text`, incluyendo todas
las columnas. Registros actuales y todas sus versiones están incluidos. Un
cambio de catálogo, una tabla nueva o ausencia de PK bloquea la captura.

El kit autentica20 originales031 y tres lecturas completas nuevas: fuente antes,
fuente después y base restaurada. Comprueba catálogo, fuente del capturador,
ámbito, run, tiempos de adquisición y binding del restore. La cobertura es la
intersección triple exacta por relación, PK y hash de fila. Actividad ajena al
recorrido puede agregar o cambiar filas; esas filas quedan sin pin, sin fingir
que fueron respaldadas. No se acepta una lista de cobertura del cliente.

El importer sólo admite el rol atestador privado ya instalado031. No interpreta
JSON arbitrario como observación nativa: el operador deberá verificar el kit y
sus originales antes de llamar al importer, igual que036. Sus recibos inmutables
no renuevan expiración y un replay requiere la misma evidencia y contenido.
Revocación, ámbito ajeno y drift de topología bloquean incluso el replay.

Antes de cualquier minimización, el lector de aserción recibe el job y su lease
nativo030, revalida la autoridad031 y calcula otra vez PK y FULLrow desde la
relación fijada. Deben coincidir el candidato, el pin restaurado y la fila actual.
No acepta fechas ni booleanos de backup como autoridad. No se concede EXECUTE a
runtime para esa aserción hasta el ensamblado revisado. El job conserva su
propósito, retenciones, políticas y marcas independientes.

La evidencia histórica contiene más de2,6 millones de registros. La captura usa
páginas de2000 filas en un cursor nativo RR y cierra count/digest encadenado.
No trunca el conjunto ni lo materializa en un JSON gigante. Cada fila fuente
tiene una cota explícita de12MiB; excederla rechaza toda captura. El verificador
acepta hasta100000 páginas, además de las cotas de manifiestos de originales,
y usa SQLite en un spool
privado nuevo para derivar la intersección completa. Su límite es explícito y
nunca convierte un prefijo en evidencia completa.

La cobertura se conserva en tabla hija indexada, importada por páginas
inmutables y habilitada sólo al sellar el conjunto exacto. La captura es lectura
privada del atestador en una sola transacción RR, sin lease de purga de30s.
La aserción final por lote exige job031+lease030: hasta20000 pins/8MiB, una sola
validación de autoridad y búsqueda agrupada por relación. Así038 puede verificar
actuales y10000 versiones sin revalidar la topología por cada fila. Las relaciones
usan nombre calificado public.records, public.record_versions, etc. El capturador
no concede permiso de purga ni realiza llamadas HTTP. Las páginas y el spool
son evidencia técnica privada, sin payloads ni claves primarias.

Para evitar crecimiento recursivo, el lector037 no incluye sus cuatro tablas de
pruebas sets/pages/entries/seals en la cobertura derivada. Permanecen dentro del
catálogo028 y del respaldo físico completo; ningún consumidor037 puede usarlas
como candidatos de purga. Esta exclusión fija del instalador no omite registros
de negocio ni copias. La expiración futura de esta evidencia necesita su propio
contrato de conservación del sello mínimo, todavía no implementado. El kit
repagina la intersección; no importa la página terminal vacía que puede producir
un cursor nativo con un múltiplo exacto de2000 filas.

`capturePrivacyBackupRows` fija el rol atestador y una sola conexión RR, valida
cada página antes de entregarla al almacén privado de originales y termina con
ROLLBACK de su estado temporal. Comprueba secuencia, ámbito, catálogo, orden,
count y root; un error conserva las páginas ya recibidas pero no entrega cierre.
El almacén sólo devuelve la referencia de los mismos bytes. El operador futuro
liga estos originales al manifiesto nativo del respaldo y al restore; esta
función por sí sola no autentica un backup ni importa sus huellas.

Los hashes de fila de captura y comprobación se calculan con TimeZone UTC fijado
en sus funciones. Los consumidores que derivan candidatos deben usar la misma
configuración; una fecha preservada no es criterio de equivalencia de bytes.
