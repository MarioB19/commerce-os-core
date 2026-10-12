# D18 — Primitivas nativas para minimizar registros e historia (033)

Decisión previa, 12-oct-2026. Componente separado desde031+032. No monta un job,
no borra archivos y no concede permiso de purga a roles de aplicación.

`prepare_privacy_record_minimization(job,retention,lease)` deriva las imágenes de
la conversación y sus registros propios. order/receipt/fulfillment usan la misma
allowlist032; message/touchpoint/ai_run conservan solamente un stub y referencia
técnica. Contactos y assets compartidos no son inferidos como propiedad exclusiva.
Un tipo propio desconocido bloquea. El plan conserva hashes de TODAS las versiones
1..N y del registro actual, incluidos metadatos y fechas, y exige que cada fuente
sea anterior al snapshot conservador del backup031. No se conserva texto original.

La versión actual, IDs, ámbito, kind y fechas no cambian. Se reescribe cada cuerpo
histórico, sin append de una copia del contenido eliminado ni duplicación de la
versión actual. La imagen mínima financiera coincide exactamente con032.

`apply_privacy_record_minimization(batch,lease)` es una primitiva cerrada. Además
del job031 y su autoridad actual, exige una fila privada de admisión ligada al
mismo batch/job/backend/transaction/lease. Nadie recibe INSERT en esa tabla ni
EXECUTE de los puertos. El ensamblador final de Root debe validar inventario,
copias, agregados y archivos y crear esa admisión en su misma transacción antes
de adoptar estos permisos. Un recibo preparado o un booleano no habilita apply.

Los guards históricos se extienden sólo después de autenticar su fuente exacta;
las68 migraciones permanecen intactas. La excepción033 acepta únicamente el hash
fuente→mínimo previamente derivado, con admisión/fence activos. snapshot_record
omite el append sólo para esa sustitución exacta. immutable_row conserva su
comportamiento histórico para otras tablas y filas. No se desactivan triggers.

Una marca inmutable por identidad vuelve permanente la prohibición de reponer
contenido: INSERT/UPDATE/DELETE ordinarios de records y record_versions rechazan.
Una nueva identidad tampoco puede adjuntar contenido a una identidad marcada mediante
conversation_id/order_id/receipt_id/fulfillment_id/message_id/ai_run_id/touchpoint_id,
incluso anidados. No se extiende esa propiedad a assets/contact compartidos.
Sólo la corrección032 conserva su puerto auditado: versión+1, recibo nativo y hash
del cuerpo exacto, sin añadir campos personales. No se usa una GUC como permiso.
Los predicados de triggers exponen sólo clasificación de la transición y ninguna
mutación; la identidad efectiva del invocador se toma dentro del trigger.
El ámbito GUC debe coincidir antes de consultar la marca: una GUC ausente o ajena
no puede ocultarla mediante RLS y convertir una resurrección en una fila ordinaria.
El eraser recibe EXECUTE sólo del predicado histórico read-only
`retention_context_valid()` que evalúa `enforce_sealed_versions`; no recibe el
puerto de aplicación de retención ni autoridad adicional para purgar.

La transacción termina con confirmación032, nuevas verificaciones de autoridad
031 y lease030 y un recibo inmutable. Cualquier cambio, expiración, prueba ausente
o fallo revierte imágenes, marcas y recibos juntos. La respuesta siempre distingue
minimización de registros de purga completa: no acredita ni ejecuta el ensamblado
de copias, archivos y agregados que corresponde al aplicador final.
