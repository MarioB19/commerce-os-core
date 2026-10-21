# Frontera de aplicación: DNS sin configurar en contenedores recreados (Agente: Claude)

21-oct-2026. La segunda ventana del día (`beb7d23d`, `cv-5c2fecaf-…-1`)
exportó, migró a 117 y levantó los seis servicios sanos; la comparación del
dueño ya pasó ([ADR](adr-v7-owner-auth-token-scopes.md)). El instalador se
detuvo en la verificación siguiente de `stage_continuity` con
`COPY_RUNTIME_APPLICATION_BOUNDARY_CHANGED`. Producción regresó al snapshot
frío `commerce-os-test-boot-v7-cold-20261021d`.

## Causa

`application_boundary_equal` exige `HostConfig` idéntico entre el contenedor
anterior y el recreado (salvo el montaje del laboratorio en
`automation-worker`). Con el `docker inspect` real de los diez contenedores
antes (V5) y después (V7), la única diferencia en `HostConfig`, `Mounts` y
redes de `api`, `web`, `ingress`, `automation-worker` y `channel-worker` es:

- `Dns`, `DnsOptions` y `DnsSearch` valen `[]` en los contenedores creados el
  10-oct (y en PostgreSQL, del 6-oct);
- valen `null` en los que el mismo host (Docker 29.8.1, compose 5.6.0) crea
  ahora.

Los dos valores significan «sin DNS propio». `Config` sólo difiere en lo
esperado (imagen, hostname y rutas de compose).

## Decisión

`engine_neutral_host(HostConfig)` lee como `[]` una lista de DNS nula o
ausente, sólo para `Dns`, `DnsOptions` y `DnsSearch`. Se usa en:

- `application_boundary_equal` (las dos comparaciones de `HostConfig`);
- la comparación equivalente de la transición inicial v2→v3;
- `v7_infra_adoption.compare_recreated`, porque `v7_pitr.py enable`
  recrea PostgreSQL (creado el 6-oct con `[]`) y la readopción lo compara.

Cualquier valor no vacío se conserva y sigue contando como cambio. Ningún otro
campo se normaliza.

## Validación

- Con el `docker inspect` real: el código anterior rechaza los cinco servicios
  y el nuevo los acepta.
- Pruebas: `[]`, `null` y ausente son iguales; un DNS, una opción o un dominio
  de búsqueda real sigue siendo distinto, también junto con el montaje del
  laboratorio; `CapAdd` `[]` contra `null` sigue siendo distinto; PITR sobre un
  PostgreSQL con `[]` se readopta y con un DNS real se rechaza.
