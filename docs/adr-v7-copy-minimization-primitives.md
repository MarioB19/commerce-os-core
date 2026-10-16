# D18 — Copias SQL terminales y barreras de repetición (035)

Decisión previa, 12-oct-2026. Alcance local preparado, posterior a031/032/033;
ningún permiso de borrado se concede a runtime. El ensamblador final todavía
requiere034, archivos, inventario completo, respaldo/restauración nativos y
revalidación de autoridad bajo el fence030 antes de admitir una mutación.

## Decisión y límites

Una clave de idempotencia, logical_key, provider_event_id, actor o texto de error
puede contener PII. No se convierte en dato técnico por conservarlo fuera del
payload. Para copias terminales exclusivamente propias se usa DELETE con CAS de
la fila completa y su PK nativa, seguido de una barrera permanente que conserva
únicamente hashes y mínimos cerrados. La PK original permanece sólo en la memoria
transaccional: no aparece en manifests, recibos, errores ni tombstones durables.
La sustitución de records e historia sigue siendo033;035 no reescribe ese contrato.

El componente0009 y scripts/retention.ts se leen como antecedentes y no se usan
como autoridad. Redactan campos sueltos y no cubren todas las copias, referencias
opacas ni barreras permanentes. Las68 migraciones históricas no se editan.

## Puertos previstos

1. `capturePrivacyOpaqueCopies` realiza una lectura autenticada y acotada de PK,
   fuente cifrada y revisión nativas. Abre AES-256-GCMv1 en RAM con clave entregada
   por custodia; nunca busca claves en disco ni las devuelve. Comprueba el esquema
   de cada operación/origen mediante una lista cerrada. El cifrado histórico no
   tiene AAD de perfil: se liga explícitamente la observación al PK/hash nativo,
   perfil/entorno y referencias verificadas; no se afirma una propiedad que no
   tiene el formato histórico. Produce un pase sin plaintext sólo para el
   importador privado que adopta los hashes de fuentes/implementación exactos.
2. `prepare_privacy_copy_minimization(job,retention,record_batch,opaque_pass,lease)`
   deriva desde SQL todas las filas candidatas, dependencias, estados, fechas y
   hashes. La firma no acepta tablas, PK, cuerpos, reloj ni booleanos de permiso.
   Retorna `PREPARED`, UUID/hash del batch, conteos y `erasure_authorized:false`.
3. `apply_privacy_copy_minimization(batch,lease)` exige además una admisión privada
   del mismo job/backend/xid/lease, creada exclusivamente por el ensamblador que
   cerró inventario,033,034 y archivos. Nadie recibe INSERT ni EXECUTE mutador en
   esta entrega. Reread exacto + CAS, no retry tras resultado incierto.
4. `privacy_idempotency_erased(workspace,environment,actor,operation,key)` calcula
   el hash canónico en PostgreSQL; es un lector acotado al contexto autenticado,
   no acepta hash del cliente. El adaptador API debe llamarlo después de fijar
   autoridad y mutex canónico, **antes de fn**. Coincidencia devuelve410 y jamás
   ejecuta el handler. El trigger contra reINSERT es la última barrera, no un
   sustituto del preflight. El montaje de ese lector se revisa por separado conF0.

## Familias, propiedad y dependencias

La primera lista cerrada comprende commands/domain_events/consumer_receipts,
outbox/effect_attempts/outbox_gate_schedule, timers, inbound_envelopes,
sales_command_proposals, idempotency y sales_history_imports. Los caches de IA
comercial están en records/record_versions y corresponden a033. El ledger019
contiene costes, uso, estados y hashes; no guarda prompt/respuesta y no se borra
como si fuera un cache. Las copias privadas RF19 tienen autoridad, DB y TTL
propios; no se declara cubierto su borrado por una operación REAL031.

La pertenencia se deriva de relaciones nativas y referencias admitidas, no de una
subcadena arbitraria ni de una lista de IDs del caller. Se capturan metadatos
exactos de columnas, PK, FK entrantes/salientes y triggers bajo locks, y se
revalidan al preparar/aplicar. Cada relación tiene DELETE estático o una rama de
SQL generada exclusivamente desde esa lista cerrada. Nuevo schema/columna/FK o
trigger desconocido bloquea. No hay CASCADE general, DISABLE TRIGGER ni cambio de
session_replication_role.

consumer_receipts y outbox_gate_schedule se incluyen y se borran explícitamente
antes de sus padres; la FK CASCADE histórica no autoriza omitirlos del inventario.
Los predecesores outbox se eliminan en orden derivado del grafo, con detección de
ciclo. Una dependencia externa viva o compartida bloquea toda la transacción.
warmup_turns/reservations/group_receipts, mcl_sponsorships, autorías QR y otros
puertos de autoridad no se borran por seguir una FK: requieren clasificación
explícita compatible, o el trabajo queda bloqueado sin cambios.

Las importaciones mixtas se resuelven con reported_sales.batch_id/order_id y
TODOS los miembros de la captura autenticada. Ausencia de UUID en un ciphertext
o en un JSON descifrado no prueba que sea ajeno. Esquema no reconocido,
referencia ambigua, plaintext que pertenece a otra finalidad o importación
compartida quedan OPAQUE/SHARED y bloquean; no se convierten en EXCLUDED por un
flag. Las respuestas privadas de credenciales se clasifican por contrato exacto
de identidad y no se imprimen ni purgan como contenido comercial.

## Caducidades y pruebas mínimas

Las políticas son diferentes: transcript TEST30d, conversación/adjuntos180d desde
cierre auténtico salvo obligación/hold, logs **sinPII**90d y pagos/auditoría5años.
Los logs y sus copias con PII se minimizan/eliminan a90 días; no se extiende su
plazo a180 por contener texto de una conversación. Este puerto035 ligado al job031
ya debido a180 también cumple90, pero NO implementa todavía el worker autónomo
de logs90 antes de que venza la conversación. Ese gate permanece explícito y
requiere025/029/032 previos cuando los logs soportan prueba financiera/cierre.
TEST30 y copias RF19 requieren su autoridad separada; no se aplica30 aREAL ni se
convierte toda copia en retención financiera.

Antes de eliminar commands/events/attempts que sirven de evidencia,025 y029/032
capturan resolución de TODOS los pedidos y cierre auténtico. Se conservan mínimos
financieros y contabilidad019; no se usa estado de body como prueba. Cambiar
contribución, clasificación o versión invalida la custodia pendiente y obliga a
reconciliar; FALSE/TEST posteriores siguen el puerto032. El respaldo debe cubrir
cada fila fuente antes del snapshot conservador031, no una fecha de manifest
posterior. Una fila no terminal, UNKNOWN/SENDING, nueva tras snapshot, PK o cuerpo
cambiado, dependencia compartida, hold o prueba ausente revierte el batch entero.

## Verificación exigida antes del commit de implementación

Unitarias de schemas cerrados, tipos de fecha/TTL, límites y descifrado auténtico
sin secretos; PostgreSQL restringido con todos los cuerpos y dependencias,
rollback después de delete, preflight410 antes de fn, reINSERT/referencia nueva,
replay, perfiles/entornos, FK desconocida, cierre financiero tras logs ausentes,
importación mixta, ciphertext incorrecto y drift tras captura. No se considera
este ADR evidencia de implementación, montaje ni borrado productivo.

## Pase opaco ya implementado; alcance de su evidencia

035_privacy_opaque_copies.sql y el capturador cerrado acreditan el conjunto nativo
completo y cada miembro del import; no conceden borrado.16 PostgreSQL restringidos,
32 unitarias y6 pruebas de custodia pasan en el corte opaque-attempt2. El primer
intento detectó la adopción de implementación global sin perfil; se conserva y la
implementación ahora tiene workspace_id/RLS. Los timestamps originales se usan
como condición necesaria, nunca como prueba de que bytes actualizados estén en un
respaldo. El futuro apply exige también fila/PKhash exactos contrastados con la
restauración autenticada: un created_at antiguo no acredita un UPDATE posterior.

## Barrera global de referencias, aditiva a030

Una referencia a un archivo puede aparecer desde otro perfil o SIMULATION. Por
eso el lector035/036 requiere una sesión dedicada que primero toma EX global,
después EX030 del perfil y finalmente inicia REPEATABLE READ. El nuevo componente
035_privacy_reference_fence.sql no cambia030. Su lease nativo dura30s, está ligado
al backend y a un nonce TEMP cuyo dueño NOLOGIN no puede asumir el caller. Ambos
epochs avanzan en la misma transacción al terminar; el socket se destruye incluso
ante COMMIT desconocido, sin retry ni devolución de la sesión al pool.

El generador usa el catálogo completo de tablas públicas y privadas y añade SH
transaccional a INSERT/UPDATE/DELETE, incluidos perfiles nuevos, identidad ySIM.
Sólo excluye su singleton y leases técnicos. FOR SHARE del epoch global impide
que un escritor REPEATABLE READ anterior publique una referencia tras el avance.
El lector exige todos los triggers habilitados, incondicionales y sin filtro de
columnas, más catálogo exacto. Una tabla nueva o trigger condicional bloquea antes
del callback. No hay bypass por entorno o lista de perfiles proporcionada.

Esta exclusión global reduce disponibilidad durante la transacción acotada; no
se promete coste nulo. El callback es únicamente SQL. No se permite mantener EX
mientras se ejecuta I/O externo ni extender el lease30s. Las lecturas de ficheros
036 necesitan su propio protocolo autenticado de captura/revalidación antes del
commit final y no reciben autoridad de este módulo por sí solo.
