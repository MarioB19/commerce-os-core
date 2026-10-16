# D18 — Autoridad nativa de archivos y composición de borrado

12-oct-2026. Decisión previa a036. La implementación se integrará con031–035;
esta nota no concede permisos ni acredita la composición.

El servidor deriva candidatos desde las referencias de registros actuales y
todas sus versiones propias. No acepta del cliente asset IDs, storage keys,
hashes, fechas ni una lista de archivos a borrar. La clasificación examina los
propósitos activos de cada asset en el catálogo completo fijado por028, incluidas
copias opacas autenticadas035. Una referencia desconocida bloquea. Un producto,
flujo, portal u otro recorrido con finalidad independiente conserva su material;
una referencia financiera mínima de032 no prolonga por sí sola el ciphertext
del comprobante durante cinco años. Las retenciones legales prevalecen.

El asset debe tener ámbito y cuerpo auténticos, clave privada canónica ligada a
su UUID y SHA, historia continua y fechas anteriores al snapshot031. Alias de
storage key en otro registro o ámbito bloquean. Se retienen hashes de fuentes y
referencias; no nombres de cliente, texto de mensajes o nombres originales.
Antes de autorizar, un lector interno mide los bytes cifrados reales mediante
O_NOFOLLOW/fstat/sha256 bajo el lock del namespace. Nunca sustituye este hash por
el del plaintext. Revalida candidato y autoridad al terminar la lectura.
La fecha del archivo tampoco prueba que estuviera en el backup: cada candidato
requiere el hash y tamaño del ciphertext importados por el verificador del
respaldo restaurado, ligados a su backup_id y restore_sha256. El capturador
compara esos bytes con el archivo actual; no acepta pins aportados por el cliente.
La adquisición nativa enumera todo `assets/` con el UID dueño del volumen y lock
EX, no una lista seleccionada. Rechaza temporales, nombres desconocidos, aliases
y hardlinks. Todos los lectores/escritores runtime deben usar el mismo lock;
ningún advisory lock prueba por sí solo la ausencia de procesos no cooperantes. Tres originales
nuevos (fuente antes/después y volumen restaurado) se autentican junto a los20
originales del validador031. Se comparan todos los ciphertexts y tamaños; no se
modifican originales antiguos para fabricar estas lecturas. El puerto de
importación036 queda limitado al atestador privado, y su lector no recibe grants
runtime hasta el ensamblado final. La adquisición no descifra contenido.

El commit SQL final captura029/032/034, minimiza registros033, copias035 y los
cuerpos actuales e históricos de assets exclusivamente propios. Instala marcas
permanentes contra nuevas referencias o reintroducción y verifica igualdad de
agregados antes del COMMIT. Cada excepción a los guards históricos debe validar
su fuente exacta y la transición autorizada; no se desactiva ningún trigger.

Los archivos se eliminan después mediante el journal durable existente, con
namespace EXCLUSIVE durante toda su operación y relectura nativa antes de cada
efecto. Se registra una fase pendiente de archivos entre ambos pasos; sólo la
ausencia verificada de todos los ciphertexts permite un recibo completo.
Un fallo conserva la identidad del job y concilia su journal; nunca recrea el
contenido SQL para fingir rollback ni repite una publicación o un envío.

Si la autoridad vence o aparece una retención legal durante la fase de archivos,
se conserva lo restante. Reanudar requiere autoridad nueva autenticada ligada a
la misma operación y un respaldo restaurado que pruebe la imagen SQL actual y
los archivos aún presentes. El backup original vencido no se extiende editando
fechas. La renovación y la protección frente a restaurar copias anteriores son
gates explícitos de la composición, además de la purga normal.
