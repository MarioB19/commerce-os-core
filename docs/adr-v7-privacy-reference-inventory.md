# D18 — Inventario de referencias previo a borrar

12-oct-2026. Decisión previa a implementar028; no autoriza por sí sola un borrado.

El cierre025 autentica el reloj y024 conserva el contexto financiero; ninguno
prueba que todas las copias de contenido estén identificadas.028 instala un
lector cerrado desde el catálogo completo revisado. El generador exige una
clasificación explícita de cada relación, columnas y clave primaria; fija ese
catálogo en SQL y rechaza cualquier deriva posterior. Los nombres y consultas
proceden de ese catálogo, nunca de parámetros enviados por una petición.

Un recorrido acotado empieza en la conversación/version exacta. Identifica las
filas que contienen sus UUID técnicos y los de sus descendientes, incluso en
JSON y claves/valores anidados. Expande sólo identidades de contenido reconocidas;
no convierte una referencia a producto, cuenta, contacto o material compartido
en permiso para recorrer/borrar todo su grafo. Versiones, comandos, eventos,
outbox/intentos, timers, snapshots, propuestas, IA y cachés se inspeccionan en la
misma instantánea. Toda coincidencia no clasificada queda como bloqueo explícito.
Una coincidencia textual conservadora puede bloquear de más; no se elimina para
obtener una aparente completitud. Límites de tamaño, profundidad o cardinalidad
aborten, nunca trunquen la evidencia.

El puerto devuelve sólo identidades UUID técnicas cuando existen, hashes de
clave primaria/fila, categoría y conteos. No devuelve cuerpos, claves de
idempotencia, teléfonos, actores, credenciales, ciphertext ni rutas. El propietario
NOLOGIN/NOBYPASSRLS/NOINHERIT tiene SELECT explícito, contexto REAL y perfil,
search_path fijo, sin acceso a la identidad global ni permiso de escritura.
El llamador dedicado no recibe SELECT directo a las tablas inventariadas.

Las categorías de inventario no son acciones de borrado. FINANCIAL conserva su
finalidad de cinco años y requiere minimización por campo; SHARED necesita prueba
de uso exclusivo; OPAQUE necesita vinculación autenticada o vencimiento separado
de logs; UNCLASSIFIED bloquea. El plan de borrado deberá ligar estos hashes a
cierre, obligación, autoridad, proyección sellada y backup/restore auténticos,
fijar los escritores y revalidar todo en la transacción de redacción. Los archivos
requieren manifest autenticado con hash/tamaño del ciphertext observado, journal
privado durable y lectura posterior. No se deduce ninguna de estas autorizaciones
de un booleano enviado por un usuario.

Las tablas de identidad del operador y configuración global se clasifican fuera
del contenido de conversaciones de forma explícita. Se valida su estructura pero
no se leen sus credenciales. No hay fallback al borrado incompleto0009/0011.

El pin de acceso captura además RLS/ACL/propietarios de tablas, metadata de la
función (owner, ACL, SECURITY DEFINER y search_path), flags y membresías de owner
y worker. Se calcula con search_path pg_catalog igual al lector; cualquier deriva
bloquea antes de leer filas. El instalador privilegiado recibe prepare_sql y
seal_sql: configura la identidad de servicio entre ambas fases. Antes de seal
ninguna lectura funciona. No existe una RPC de re-sellado accesible al runtime.
La definición final y sus grants deben cotejarse con el artefacto de instalación.
