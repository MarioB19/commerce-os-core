# D18 — Validación local de respaldo y restore para el atestador031

12-oct-2026. Decisión previa. Este adaptador puro no ejecuta SQL, restaura, obtiene
credenciales ni concede permiso para purgar. El operador nativo de Root conserva
la adquisición y custodia de originales; un JSON coherente del solicitante nunca
es evidencia de adquisición. El lector inyectado admite únicamente referencias
previamente autenticadas por ese operador, incluso si se recuperaron bytes tras
un reinicio. No se siguen rutas incrustadas en documentos.

Se reutiliza sin modificar runtime_boot_restore_gate para los16 originales B02,
la copia externa y el restore. Su resultado sigue histórico, con frescura e
instalación falsas. Una capa distinta exige cuatro originales adicionales: mapa
completo de fuentes desplegadas V7 adoptado, topología nativa anterior al backup,
topología nativa posterior y topología leída del clúster restaurado. Cada lectura
queda ligada al mismo run, ciphertext, manifiesto y consulta canónica. Los targets
source/restored deben ser distintos y venir del operador, nunca del documento.
La envoltura de custodia se puede sellar después de terminar el backup: conserva
el resultado y timestamp originales de la consulta, y lo enlaza al ciphertext
posterior. Su fecha de creación nunca reemplaza la observación nativa. El lector
confiable debe comprobar esa procedencia; el adaptador no la deduce del JSON.

La edad se calcula desde createTime nativo del Job autenticado, anterior a la
creación de la autorización y al snapshot PostgreSQL. Es una cota conservadora,
no la hora exacta de pg_export_snapshot. No se usa created_at del manifiesto,
completionTime ni el momento del restore para renovar24h. Source-before precede
esa cota, source-after sucede al Job y el readback restaurado pertenece al período
original del restore. Fechas futuras o una ventana agotada rechazan.

La fuente esperada debe contener todas las migraciones históricas, los ocho
scripts verificados del restore y el conjunto exacto de transiciones/componentes
V7 adoptado (incluidos024/025/028/029/030/031/032). No se inventa un registro de
migraciones aplicadas: la custodia del manifiesto confirma bytes desplegados;
la huella nativa confirma estructura, funciones, triggers, RLS, ACL y roles.
Ambas pruebas son necesarias. Cualquier diferencia source-before/source-after/
restored rechaza. La consulta031 incluye nombres de roles, sin OIDs, y TODOS sus
flags/configuración/connlimit/validuntil y membresías. El adaptador también
compara ese inventario explícito sin quitar roles ni normalizar permisos. El
restore debe reproducir esos metadatos en un clúster aislado, sin copiar secretos;
una ejecución con logins locales distintos no puede suplirlos con la huella viva.
Se fijan por separado las revisiones de backup, restore y despliegue. Además,
el contrato de consultas de seguridad del restore necesita un hash adoptado
independientemente; su presencia dentro del manifiesto histórico no basta para
afirmar cobertura de los nuevos estados V7. La ampliación y captura nativa de
esas consultas queda pendiente del operador revisado. Los scripts actuales
usan --no-owner/--no-acl, por lo que una restauración V7 necesita reaplicar los
metadatos autenticados en aislamiento y obtener una huella nativa exacta antes
de usar este puerto. Este módulo no ejecuta esa reaplicación ni crea roles.

El resultado contiene únicamente argumentos preparados para import_privacy_backup,
hashes y fechas conservadoras; import_authorized y erasure_authorized siguen false.
031 relee la topología viva y la vigencia desde su propio reloj al importar y al
preparar/applicar jobs. Este módulo no aporta política Owner, legal holds,032,
agregados, inventario028 ni permisos de archivos. Los originales históricos
actuales carecen del conjunto V7/topología nuevo y no habilitan ese puerto.
