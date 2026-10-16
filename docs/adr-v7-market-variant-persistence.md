# Persistencia de variantes dentro de la autoridad F2

Decisión previa al código, 12-oct-2026. Rama de integración privada desde F2
`d75310e` más el núcleo F4 revisado `6478d1c`; el único conflicto documental
conserva ambas entradas de progreso. No cambia el candidato público 51f72.

La transición aditiva `008_market_variants.sql` permanece fuera del directorio
de migraciones instaladas. Las tablas nuevas tienen FORCE RLS por perfil; el
repositorio añade siempre entorno y perfil explícitos. Únicamente commerce_api
recibe permisos acotados. No se concede acceso global a automation/channel.
La API preparada consume withProfileRequest: sesión seleccionada o PAT de
perfil, scope específico y revalidación de autoridad/reloj antes de COMMIT.
No se monta en createApp en este incremento.

Una familia preserva el ID del producto existente. Adoptarla requiere leer ese
producto en el perfil/entorno; no crea productos ni cambia historias V5. Las
variantes tienen borrador por CAS y versiones comerciales inmutables. Cambiar
un borrador invalida la revisión previa. Publicar exige versión y hash exactos,
la revisión explícita de los seis campos del contrato y referencias históricas
auténticas. Cada escritura HTTP exige una clave UUID de operación; el recibo inmutable se
guarda en la misma transacción, ligado a perfil, entorno, actor y hash de la
solicitud. Una repetición explícita con contenido idéntico devuelve ese recibo;
cambiar contenido se rechaza. Una operación concurrente devuelve ocupado sin
espera ni retry. Una respuesta incierta se consulta por su clave; el cliente
no reintenta automáticamente ni toma un CAS fallido como éxito. La copia
conserva en SQL el ID de versión origen, sin arrastrar asignaciones ni campañas.

En el esquema V5 vigente, oferta y remarketing pertenecen a la misma versión de
oferta; cobro referencia bank_profile, flujo workflow, vendedor agent y material
asset. La publicación valida tipo, perfil, entorno, revisión y hash de cada
record_versions; exige oferta/flujo publicados, producto de la familia, moneda
y precio exactos de la oferta, banco de la misma moneda y las referencias de
flujo/vendedor/cobro de esa oferta. Los materiales de fulfillment deben estar
en el conjunto fijado. Este enlace explícito evita inventar tipos nuevos de
configuración y no convierte importes ni publica borradores V5 indirectamente.
La lista de variantes requiere una familia del perfil/entorno y usa cursor UUID
con máximo 100 filas, sin búsqueda sobre cuerpos secretos. Sólo se devuelven referencias y metadatos del mercado, nunca cuerpos de banco,
credenciales o instrucciones privadas de las configuraciones.

El snapshot se inserta una sola vez para un journey existente y verifica dentro
de la transacción las identidades de conversación, cuenta, contacto y binding,
además de las referencias comerciales fijadas. El repositorio no decide que un
cliente está autorizado a abrir un journey: ese acto permanece en F3/worker.
El montaje futuro usará esta misma función después de la resolución común,
con las protecciones y autorización actuales; guardar el snapshot no autoriza
envíos. Snapshots y versiones no admiten UPDATE/DELETE, tampoco del runtime.

Los gates locales incluyen PostgreSQL real con login sin SUPERUSER/BYPASSRLS,
FK de perfil/entorno, CAS concurrente, rollback al vencer la credencial y
versiones antiguas conservadas después de publicar cambios. Una prueba aislada
no acredita migración productiva, W01, QR, proveedor ni instalación. Quedan el
montaje comercial completo, interfaz/MCP, asignaciones F3, equivalencia del
worker/laboratorio y adopción del mapa histórico producto→México; no se omiten.

La retención V5 puede redactar versiones de assets bajo una excepción controlada.
La publicación toma SHARE del records padre (el mismo que retención toma UPDATE),
sin ampliar permisos sobre record_versions. Un guard aditivo impide marcar como
RETAINED un material fijado por una versión comercial publicada; un índice GIN
acota esa consulta. El guard se ejecuta dentro de la transacción de retención: un
rechazo revierte también su redacción previa. No cambia políticas/TTL ni permite
borrar material usado. Borradores sin publicar no adquieren esta protección.

El consumidor compartido usa un origen HTTPS fijo (HTTP sólo loopback local) y
una identidad inmutable de cookie seleccionada o PAT. No acepta overrides de
perfil/origen/bearer en los comandos. Cada escritura es una sola petición con
UUID explícito; cualquier respuesta no confirmada conserva ese estado y obliga
a consultar la operación, sin retry automático. Las lecturas/respuestas tienen
15 segundos y 2 MiB de cota; el aborto del cliente no afirma rollback servidor.
Decodifica esquemas cerrados, IDs/entorno, páginas y coherencia release/puntero.
El transporte no convierte una publicación de catálogo en permiso de envío.

Decisión previa del consumidor MCP: un servidor preparado registra una herramienta
por operación del mismo contrato cerrado. Su cliente ya posee la identidad fija;
los argumentos no pueden cambiar perfil, token, origen ni ruta. Adoptar, copiar,
editar y publicar exigen el UUID de operación explícito y las mismas revisiones
de la API. Las anotaciones distinguen consulta y escritura; ningún callback
repite una petición. Ante incertidumbre devuelve la clave para consultar el
recibo durable. Conserva la redacción de secretos/enlaces temporales del MCP
actual. Se valida el protocolo con el SDK real y el transporte local autorizado,
sin registrar este servidor en el entrypoint comercial ni afirmar uso desde Codex.

Decisión previa de interfaz: la vista preparada recibe la selección de perfil y
el producto del catálogo actual; crea su cliente de sesión sin credenciales en
props. Cambiar perfil, versión de selección, entorno o producto descarta la vista
anterior y aborta sólo su transporte, sin atribuir rollback. Un controlador local
serializa acciones, conserva el UUID y el contenido inmutables de una escritura
incierta y ofrece consulta explícita. Sólo después de un GET 404 permite un
reenvío humano del mismo UUID/contenido; 404 no se presenta como prueba de que
nunca hubo COMMIT, y la idempotencia/autorización del servidor siguen gobernando.
Las respuestas tardías de una vista desmontada no repueblan la nueva.

La edición muestra mercado, idioma, moneda, zona, importe en unidades menores y
selectores de versiones del catálogo, sin pedir hashes manuales ni mostrar cuerpos
privados. Las opciones son presentación; la API reautentica todas las referencias.
La revisión de los seis campos es explícita y se borra con cualquier edición.
Guardar borrador precede a publicar; no se publica contenido local sin confirmar.
Copiar una versión abre un borrador independiente que exige revisar esos campos.
La vista no activa asignaciones/campañas ni se monta en navegación comercial.
