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

## V7.1 (25-oct-2026): digests neutrales a la codificación y continuidad de actualización

**Problema.** La readopción del 21-oct (`v7_infra_adoption.py observe`) se
detuvo en `V7_ADOPTION_DEFINITION_CHANGED:api`. Al reiniciar el daemon de
Docker, los contenedores que no se recrean pasan de `null` a `[]` en esas tres
listas. Así cambia su `definition_digest`, aunque nada cambió. La regla de
arriba sólo cubría las comparaciones de `HostConfig`, no los digests guardados.

**Medido en la copia de producción.** Los digests guardados por la V7
(`preserved_runtime`) están **mezclados**:

- api, web, ingress y los dos workers, recreados por el instalador, se guardaron con `null`;
- caddy, portal, waha-01 y waha-03, preservados de antes, se guardaron con `[]`.

Normalizar todo a `null` habría roto esos cuatro servicios. Con el inspect real,
la única diferencia de `HostConfig` antes y después del reinicio son las tres
listas (`tests/fixtures/docker-hostconfig-dns-encoding.json`).

**Decisión.**

- `definition_digest(row)` escribe el digest **canónico**: listas vacías como
  `null`. Coincide con los digests ya guardados de los contenedores
  recreados.
- `definition_digest_matches(row, stored)` acepta un digest guardado si
  describe al contenedor bajo cualquier codificación de sus listas vacías
  (`null`, `[]` o ausente). Un valor no vacío nunca varía.
- `preserved_digest` y `preserved_definitions` **conservan** el digest guardado
  de un contenedor sin cambios mientras siga coincidiendo. Así, las demás
  referencias guardadas (recibos de gateways y plan de B02) siguen iguales byte
  por byte. Sólo un contenedor nuevo recibe el canónico.
- Lo usan:
  - el inventario del instalador (`validate_inventory`);
  - el recibo de gateways;
  - el estado y el recibo de adopción del instalador;
  - el arranque durable (`runtime_boot_host.py`);
  - la readopción (captura, servicios sin cambio y digests nuevos);
  - B02 (`projection_matches` en `runtime_guard` y en la instalación de
    herramientas, proyección v2).

  La proyección v1 de B02 y las comparaciones entre dos lecturas vivas de la
  misma operación no cambian.

**Pruebas de continuidad** (`tests/ci/test_v7_engine_neutral_digest.py`):

- El estado que escribió la versión anterior (digests mezclados, calculados con
  la función de f0d71880), leído por esta versión después de un reinicio (todo
  `[]`, todo `null` o ausente):
  - la readopción es una identidad y conserva los digests;
  - el inventario del instalador lo acepta;
  - la guarda de B02 lo acepta.
- Un DNS real en api o caddy se rechaza.
- La función anterior falla igual que el 21-oct.

## V7.1: lo que además adopta la readopción (25-oct-2026)

Ensayo de `observe` en la copia del laboratorio, con el estado real de
producción.

| Código | Resultado |
|---|---|
| f0d71880 | `V7_ADOPTION_DEFINITION_CHANGED:api` (DNS) |
| V7.1 sólo con el arreglo de DNS | `V7_ADOPTION_COMPOSE_FILES_CHANGED:postgres` |
| V7.1 completo | `PROPOSED` |

Faltaban dos adopciones:

- **PostgreSQL de la fundación.** El PostgreSQL de producción lo creó el 6-oct
  la fundación inicial, con un archivo de composición propio. `v7_pitr.py
  enable` lo recreó dentro de la cadena de composición del release, igual que
  los servicios de aplicación, más la capa PITR al final.
  `foundation_pitr_labels` acepta ese cambio sólo si archivos, carpeta de
  trabajo y archivos de entorno son exactamente los de api (por
  `/opt/commerce-os/current` o por la carpeta del release) más
  `postgres-pitr.yaml`. Cualquier otro proyecto se rechaza.
- **Proxy de entrada.** El 21-oct, `update-identity-proxy.py` reescribió el
  Caddyfile (`/v2/*`), y V7.1 añade `/healthz/platform`. Cambiaron
  `caddy_config_ref` y `active_proxy_sha256`, y sin adoptarlos fallan el
  instalador, el arranque durable y la readopción. `proxy_decision` sólo los
  adopta si se cumplen las dos condiciones:
  - el respaldo privado del Caddyfile registrado
    (`caddy-backups/identity-proxy-*/original.Caddyfile`) y el archivo actual
    convergen bajo la reescritura revisada, es decir, sólo difieren en encabezados
    y rutas propias;
  - Caddy ejecuta exactamente ese archivo (`caddy adapt` = `/config/`).

En la copia, `observe` propuso:

- `PITR_ENABLED`;
- la red `commerce-os_pitr-edge`;
- el proxy (`IDENTITY_PROXY_REWRITE`, estado intermedio con sólo `/v2`);
- los otros 9 servicios sin cambios.

`apply` escribió el par. Con una captura nueva, después de reiniciar el daemon
de Docker y levantar los gateways, `observe` dio una propuesta identidad.

**Gateways y reinicios.** Los gateways tienen `restart: no`. Después de
reiniciar el daemon o la VM no vuelven, y `observe` falla con
`COPY_RUNTIME_NETWORK_FOREIGN_ENDPOINT` hasta que se levantan. El supervisor
de gateways los reinicia; la readopción posterior a un reinicio se hace con
los gateways arriba.
