# Biblioteca privada: recuperación de subidas

El API reserva dos veces el tamaño antes de crear multipart: staging y final durante promoción. Las claves contienen SHA256(workspaceId), entorno e IDs opacos; nombres y rutas de equipos no forman parte de la clave. El cliente sólo recibe UploadPart; servidor cierra, verifica, copia y promueve. GET y HEAD tienen firmas separadas. Las URLs duran como máximo su TTL anunciado; revocar permisos impide emitir nuevas, pero no invalida una ya emitida hasta su caducidad.

Una sesión advisory de Postgres serializa las operaciones remotas por upload. La conexión dedicada se utiliza también para consultas y transacciones cortas, evitando agotar el pool esperando una conexión adicional. No se mantiene una transacción de base durante transferencias remotas.

| Interrupción | Recuperación |
|---|---|
| CreateMultipart tuvo respuesta perdida | UNKNOWN conserva reserva. Reintentar initialize lista multipart del mismo staging key y enlaza el único ID observado. Nunca repite CreateMultipart. Cero o varios IDs mantiene incidencia y reserva. |
| Partes incompletas/exceso observado | No se cierra el multipart. Regresa a UPLOADING para completar o cancelar. Ningún asset READY. |
| CompleteMultipart con resultado incierto | CLOSING comprueba si existe staging cerrado antes de repetir finalización; jamás crea otra subida. |
| Verificador rechaza SHA/tipo/bytes | Permanece VERIFYING, sin final aprobado. Puede cancelarse la sesión no aprobada y liberar reserva tras confirmar limpieza. |
| CopyObject completó pero falló commit READY | Staging y final se conservan. Reintentar verifica bytes del final existente y registra READY sin repetir CopyObject. |
| READY registrado y delete staging falla | El archivo final permanece accesible. `STAGING_CLEANUP_PENDING` conserva una reserva del tamaño de staging; reintentar complete confirma eliminación con HEAD y libera sólo esa reserva. No duplica used_bytes. |
| Resultado de worker viejo | Fence/attempt/lease se comprueban antes de verificación y dentro de la transacción de promoción; nunca se publica como resultado del attempt vigente. |

No cancelar un multipart CLOSING incierto sin reconciliar primero: puede haber finalización remota aún en curso. UNKNOWN sin ID observado requiere reconciliación del proveedor; la reserva no se transforma en cero por falta de respuesta. No se borran assets READY para recuperar cuota. Un aborto sólo elimina staging/final aún no aprobado perteneciente a esa sesión.

El verificador Cloudflare calcula SHA incremental sobre los bytes reales en R2. No confía en ETag/metadata como digest. Comprueba tamaño/tipo por firmas de archivo, UTF8 completo y JSON completo para artefactos textuales, con1MiB de límite textual. Petición2KiB y respuesta8KiB se limitan mientras se leen; no sólo después de cargar buffers. El chequeo de firma de medios es identificación básica del tipo, no decodificación audiovisual completa; render y QA del worker siguen siendo obligatorios para masters. No transfiere los masters por VPS. El token bearer se configura privadamente y observabilidad del verificador permanece apagada.

`pnpm test:integration tests/integration/creative-storage.test.ts` pasa8/8 con Postgres real y un fixture S3/verificador **explícito**, incluidas concurrencia, respuesta perdida, fallo de commit tras copia, delete fallido, hash falso y aislamiento. Esto valida la máquina de estados; no acredita bucket real, CORS, Range, vencimiento ni facturación de R2. Sus pruebas reales se registran en la evidencia general de la V1.

La promoción READY vuelve a bloquear y validar dispositivo, membresía activa, permiso admin actual/proyecto y finalmente job/intento/lease con el mismo orden del protocolo de dispositivos. Una revocación que ocurra durante la verificación remota deja el material VERIFYING y conserva la reserva.11 pruebas PostgreSQL incluyen revocar dispositivo, desactivar membresía y retirar permiso durante ese intervalo; ninguna permite READY.
