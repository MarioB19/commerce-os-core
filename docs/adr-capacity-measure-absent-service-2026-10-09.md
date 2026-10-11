# Medición con plazas aún no configuradas

Fecha: 2026-10-09. Estado: decisión previa a la implementación; publicación y
medición instalada pendientes.

`measure` consulta todas las plazas persistidas. Con sólo el piloto configurado,
`compose ps waha-02` rechaza el servicio inexistente; no devuelve la lista vacía
que `snapshot` interpreta como `GATEWAY_NOT_PROVISIONED`. La medición termina
antes de publicar inventario y métricas.

Se consultará primero la lista de servicios de la composición canónica. Para
un servicio ausente, o configurado sin CID, se comprobará el inventario Docker
completo, incluidos los contenedores detenidos. Una coincidencia por etiqueta
de servicio, nombre canónico o volumen del slot impedirá declarar ausencia:
requiere reconciliar configuración y contenedor, aunque pertenezca a otro
proyecto. No se adopta ni se toca ese contenedor.

Sólo la ausencia comprobada se convierte en `GATEWAY_NOT_PROVISIONED`. Los
errores de Compose/Docker, inventarios incompletos, volúmenes/redes alterados y
gateways detenidos conservan su fallo; `measure` no publica un éxito parcial.
No se crean credenciales, servicios, sesiones, redes o volúmenes. Las APIs de
inventario y medición y sus permisos permanecen iguales.

Pruebas: piloto único y dos plazas no configuradas; servicio configurado sin
contenedor; gateway detenido; contenedor histórico/ajeno por etiqueta, nombre
o volumen; errores de configuración, Docker e inventario. La reproducción usa
dobles de CLI fieles al rechazo de servicio desconocido, sin mutaciones Docker
ni acceso API. Las pruebas locales no acreditan medición productiva.

Referencias: [Docker ps](https://docs.docker.com/reference/cli/docker/container/ls/),
[Compose config](https://docs.docker.com/reference/cli/docker/compose/config/),
[piloto y capacidad](adr-initial-pilot-and-capacity-reuse-2026-10-08.md).
