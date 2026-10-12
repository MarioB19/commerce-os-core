# D18 — Autoridad, respaldo y preparación de jobs

12-oct-2026. Decisión previa a031. La preparación no acredita una purga.

La aplicación no acepta `restore_verified`, `legal_hold=false` ni un inventario
enviado por el navegador como autoridad. Un importador privado, separado del
worker y sin membresía del API, incorpora únicamente evidencia obtenida por el
operador nativo: política adoptada por un Owner actual, retenciones legales y
respaldo cifrado con copia externa y restore autenticados. Conserva UUIDs,
versiones, hashes y fechas; no guarda los documentos, datos públicos inventados
del negocio, secretos ni rutas de archivos. La adopción de la política técnica
no certifica avisos jurídicos ni sustituye los datos confirmados del responsable.

Las atestaciones son append-only e idempotentes por UUID. Reusar un UUID para
contenido distinto falla. Las revocaciones son eventos nuevos. El importador
no puede redactar contenido ni preparar jobs; el worker no puede importar
atestaciones. Todos los roles son NOLOGIN, NOINHERIT, sin BYPASSRLS ni membresía
del owner. La conexión de importación es una credencial privada distinta del
runtime de ventas; no habrá endpoint público para aportar estos hashes.

La vigencia del respaldo termina como máximo24h después de la instantánea,
no después del import. Restore debe ser posterior a la instantánea y anterior
al reloj nativo; se exige la misma huella de esquema, funciones, triggers, RLS,
ACL y roles que se observó al restaurar. Un receipt histórico compatible no se
convierte por sí solo en respaldo fresco. El adaptador nativo debe autenticar
los originales B02/restore y obtener la huella del sistema restaurado antes de
invocar el importador; el puerto SQL es la frontera de confianza de ese adaptador,
no un verificador criptográfico de documentos arbitrarios.

Preparar exige la lease exclusiva030 adquirida antes de REPEATABLE READ y vuelve
a leer Owner/membresía, última política, todas las retenciones, respaldo no
revocado, cierre025 debido e inventario028 instalado. Guarda esas versiones y
hashes en un job inmutable, sin PII. Las clasificaciones desconocidas u opacas
impiden prepararlo. No espera locks ni inventa permiso cuando falta evidencia.
Una nueva revisión de política/retención o un cambio de membresía invalida jobs
anteriores incluso si el cambio después se revierte.

La salida es INVENTORIED, `erasure_authorized=false`: aún debe componerse con
032, preservación y comparación de agregados, política cerrada para cada copia,
manifest de archivos y puerto de redacción. Ninguna función de031 modifica
records ni record_versions. Apply deberá revalidar las fuentes bajo una nueva
lease y conservar tombstones/re-borrado después de restore. No se reutiliza el
borrado parcial de0009 ni se renueva un gate por reintentar el mismo job.
