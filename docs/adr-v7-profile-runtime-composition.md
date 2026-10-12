# Composición HTTP V2 de perfiles y consumidores V7

Fecha:2026-10-12. Estado: implementación local; instalación y corte V1 pendientes.

`profileRuntimeRoutes` registra un catálogo fijo de los quince plugins revisados
(de identidad/alta/aceptación y doce familias de perfil). Cada familia conserva
su límite de autorización/transacción y los hooks se encapsulan con Fastify.
`createApp` lo registra junto al contrato actual, con las dos cabeceras CAS en CORS.
No hay selector de perfil de respaldo, traducción de PAT a Owner ni recuperación
por una ruta antigua cuando falla V2. La identidad inicial consume exclusivamente
los dos puertos SQL cerrados020; no consulta memberships directamente.

Esta composición no acredita el corte V1 ni despliegue. `authenticate` legado
sigue siendo una frontera que hay que reemplazar antes de publicar el candidato;
su inventario, las cinco rutas con I/O externo y los workers no pueden quedar
ocultos bajo una única transacción. La UI debe enlazar su selección CAS al cliente,
y las migraciones RLS/FK/ACL y guards030 deben pasar pruebas compuestas. En
particular, el selector fuera de perfil y el guard genérico de escritores030
requieren un cierre compatible; no se excluye ese gate por registrar las rutas.

Las pruebas de composición deben demostrar rutas reales presentes, rechazo antes
de SQL sin identidad/fence, cabeceras privadas encapsuladas, scopes exactos y
ninguna invocación del autenticador antiguo para V2. Los ensayos de los lectores
individuales y PostgreSQL se conservan como evidencia distinta.
