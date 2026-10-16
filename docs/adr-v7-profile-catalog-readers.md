# F2 — lectores de catálogo dentro de la autoridad de perfil

Decisión del 11-oct-2026, antes de implementar. El middleware V1 todavía elige
una membresía implícita y varios lectores usan el pool directamente. No se
monta un selector comercial sobre ese comportamiento ni se habilita RLS global
antes de adaptar a sus consumidores.

El primer consumidor comercial V2 será la lectura de categorías, productos,
ofertas, materiales, flujos y vendedores. Cada ruta tiene un scope cerrado y
utiliza `withProfileRequest`: sesión nativa más selección vigente, o PAT ligado
al perfil. Lista, detalle y versiones reciben únicamente el executor de la
misma transacción y nunca un pool, tenant adicional o credencial global.
Perfil y entorno se aplican también a las versiones históricas. Una referencia
de otro perfil o entorno se responde como inexistente.

Filtros, búsqueda por nombre/descripción y paginación se ejecutan en SQL con
parámetros. Se leen como máximo 101 filas por página (100 y un indicador de
continuación); no se carga el catálogo completo para filtrarlo en memoria ni
se busca en secretos serializados. No se introduce exportación masiva. La
presentación pública reutiliza exactamente el saneamiento existente.

Las rutas se ensamblan como plugin explícito con la identidad y los ajustes
preparados, para el ensayo HTTP real. El entrypoint productivo no lo registra
todavía: identidad, permisos, writers, archivos, workers, MCP, cuotas, FK y RLS
de los demás dominios siguen siendo requisitos del corte completo. Este
incremento no recorta funciones V1 ni convierte una prueba local en migración.

La prueba PostgreSQL usa las tablas `records` y `record_versions` de las
migraciones históricas, con políticas RLS explícitas sólo en su base sintética
aislada. El login real no es propietario, superusuario ni BYPASSRLS. Comprueba
ausencia de contexto, dos perfiles, dos entornos, detalle y versiones ajenas,
revocación, cambio de selección y reutilización de la conexión. La política
de prueba es evidencia del consumidor, no una aprobación para aplicar RLS
sobre el catálogo comercial sin revisar sus otros escritores.
