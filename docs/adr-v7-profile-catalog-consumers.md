# F2 — consumidores web y MCP del catálogo por perfil

Decisión del 12-oct-2026, antes del código. Los lectores `/v2/catalog` ya
autorizan la sesión o el PAT dentro de una transacción. El siguiente incremento
une esa misma superficie a dos consumidores preparados, sin habilitar el
entrypoint comercial ni mantener una alternativa V1 dentro de ellos.

Un cliente compartido acepta sólo operaciones de lista, detalle e historial,
con recursos y filtros cerrados. Cada llamada emite un GET único, sin redirección
ni reintento, limita bytes y tiempo, valida el sobre y comprueba entorno/IDs y
paginación. El navegador usa cookie y el fence de la selección; MCP usa un PAT
fijo capturado al construir el transporte, sin cookie ni selector de perfil en
los argumentos de herramienta. Ninguno expone una ruta HTTP arbitraria.

La vista de catálogo mantiene lista, detalle e historial bajo la misma clave de
selección, versión, entorno y recurso. Un cambio oculta los resultados previos
inmediatamente; abortar es una optimización, y la clave/época también descarta
respuestas tardías cuando el transporte ignora la cancelación. Las lecturas
fallidas vacían su resultado y requieren una acción explícita para reconsultar.

El servidor MCP preparado registra tres herramientas de sólo lectura con el
SDK real. No se conecta automáticamente al servidor V1 ni amplía los scopes
del PAT. La prueba de protocolo recorre SDK → HTTP local → plugin V2 y el ensayo
PostgreSQL utiliza el login restringido y las políticas RLS sintéticas ya
existentes. El navegador se valida con fixture HTTP aislado; esos resultados
no acreditan un usuario productivo ni una migración de la aplicación.

Quedan pendientes escritores, archivos, workers, otros consumidores, gestión
de credenciales y el corte completo de RLS. La vista y el servidor se ensamblan
explícitamente, todavía sin registrar rutas comerciales de producción.
