# V7.3 — Meta por portafolio y cuenta

Candidato de software para revisión y release. Brandon encargó a Codex la
implementación y validación local, a Claude la publicación y a Codex la conexión
posterior de sus dos portafolios. Este cambio no instala software ni configura
credenciales reales.

## Comportamiento entregado

- Hasta cinco portafolios **seleccionados** por perfil; todas sus cuentas
  publicitarias accesibles. Las conexiones cifradas son independientes de ese
  límite. Un acceso compartido no duplica una cuenta ni sus cifras.
- Descubrimiento paginado de cuentas y su negocio propietario; complemento de
  `/me/businesses` cuando el permiso esté disponible. Los nombres iguales se
  distinguen por ID. El propietario actual usado para datos anteriores se etiqueta
  como supuesto inicial; cambios posteriores conservan su fecha observada.
- Histórico inicial fijo de 90 días por calendario de cuenta, en bloques de siete
  días recientes primero. Relectura horaria de siete días y diaria de treinta;
  estas ventanas no borran el histórico anterior. Se conservan cursores, avance,
  leases y reintentos. Los errores y respuestas tardías de una revisión de token
  no afectan su reemplazo.
- Campañas muestra portafolio → cuenta → campaña → anuncio, filtros persistentes,
  detalle por producto, avance y CSV. Una respuesta tardía de otro perfil o una
  consulta fallida con filtros nuevos no reaprovecha un reporte incorrecto.
- Meta aporta gasto, impresiones, clics **todos** y conversaciones reportadas.
  Commerce aporta pagos aprobados. Las ventas sin una coincidencia inequívoca
  anuncio/cuenta permanecen sin atribución. ROAS/CPA se calculan desde totales,
  por moneda y calendario compatibles, con cobertura por cuenta.

## Contratos

| Ruta | Autoridad y uso |
|---|---|
| `GET /v2/meta` | `integrations:read`: conexiones sin secretos, portafolios, cuentas y operaciones. |
| `PUT /v2/meta/connections/:id/token` | Dueño en sesión interactiva; alias, token y `expectedRevision`. Secreto cifrado y versionado. |
| `POST /v2/meta/connections/:id/state` | `integrations:write`, `expectedRevision`, `enabled`. Desactivar conserva historia. |
| `POST /v2/meta/connections/:id/discover` | `integrations:write`, `operationId` UUID. Lectura de cuentas. |
| `PATCH /v2/meta/portfolios/:id` | `integrations:write`, `expectedVersion`, `selected`; límite transaccional de cinco. |
| `POST /v2/meta/sync` | `integrations:write`, UUID de operación, ámbito opcional y rango inclusivo de hasta 90 días. |
| `GET /v2/meta/operations/:id` | `integrations:read`, avance del mismo trabajo. |
| `POST /v2/meta/operations/:id/retry` | `integrations:write`, reanuda bloques recuperables. |
| `GET /v2/campaigns` y `/v2/campaigns/export` | `campaigns:read`; mismo reporte, filtros y definiciones que web/MCP. |

Las rutas Meta aceptan sólo entorno REAL; los headers de perfil, membresía,
scopes y restricciones de sesión siguen vigentes. El PAT de Commerce no es el
token de Meta. La entrada/rotación de secretos permanece interactiva según el
plan aprobado; las acciones permitidas de inventario, selección, sincronización
y reportes sí están disponibles por API/MCP.

MCP amplía acciones de las herramientas existentes; no ofrece una ruta alternativa
de cálculo ni revela tokens. Los contratos generados están en
[API y MCP](reference/api-mcp-v7.md). El bundle instalado debe corresponder al
release antes de utilizar las nuevas acciones.

## Migración y recuperación

`0119_v73_meta_portfolios.sql` es aditiva; ninguna migración 0001–0118 cambia.
Añade ocho relaciones con aislamiento por perfil, permisos de columna para los
secretos y clasificación en inventarios de filas, claves y privacidad. Las
credenciales V7 existentes se adoptan mediante la revisión exacta anterior; el
worker verifica el sobre antiguo y crea uno ligado a perfil/conexión/revisión.

El instalador admite la cola incremental exacta **118→119** desde la instalación
V7.2 comprobada. No acepta saltarse 0118 ni vuelve a ejecutar el retiro histórico
de módulos o la migración de tokens del corte V7. Se conserva la ruta inicial
68→119 y sus barreras anteriores para los destinos a los que corresponde.

Con conexiones nombradas, el worker cierra trabajos legados pendientes y usa la
cola nueva. El camino singular sigue disponible para compatibilidad. Los datos
ya guardados, pagos, catálogo, números, sesiones, autorizaciones y configuración
comercial se conservan.

No hay migración inversa ni rollback automático a V7.2: esa versión no conoce las
conexiones nuevas. Ante fallo, conservar el hold/estado y los recibos y corregir
hacia adelante mediante el procedimiento canónico. No borrar 0119, restaurar
sobre producción ni degradar credenciales sin un procedimiento revisado.

## Verificación local

| Comprobación | Resultado |
|---|---|
| Tipos, lint y build | Aprobados. |
| Unitarias | 2,211 aprobadas, 178 archivos. |
| PostgreSQL | 1,528 casos aprobados en 152 archivos, consolidando la ejecución completa y la repetición dirigida descrita abajo. |
| CI Python | 1,959 casos: 1,957 aprobados y 2 omitidos por entorno. |
| Contratos Node | 45 aprobados. |
| Contratos de navegador | 14 aprobados; Meta incluye filtros, CSV, accesibilidad, móvil y respuestas tardías. |
| Aplicación montada | 11 E2E aprobados. Los 2 casos con baselines visuales Linux corresponden al FULL nativo pendiente. |
| Recuperación | Backup/restore local conserva dos conexiones cifradas, dos portafolios e historial; verificaciones comerciales, sesiones y rechazo de alteraciones incluidas. |
| Dependencias | Sin hallazgos high/critical; 26 moderate y 5 low. No se añaden dependencias. |

La ejecución completa final de integración terminó con **1,527 aprobadas y un
fallo del fixture de remarketing**: elegía un día distinto al calendario SQL de
esa consulta legada. Se corrigió sólo el fixture y su archivo volvió a pasar
(1/1). El resultado consolidado es 1,528/1,528; no se presenta la salida original
del comando como exitosa ni como un FULL nativo de release. Los demás casos se
completaron sobre la misma implementación de aplicación.

Comandos de navegador locales: los 14 contratos canónicos, más
`pnpm test:e2e tests/e2e/account-security.spec.ts tests/e2e/v7-application.spec.ts tests/e2e/v7-variant-journey.spec.ts --update-snapshots=none`.
No se modifican ni regeneran baselines Linux. El FULL canónico debe ejecutar la
suite sin esa selección en su entorno Linux.

La carga sintética final cubrió 5 portafolios, 15 cuentas y 1,350 días de cuenta:
15,208 ms para drenar la carga, 571 ms para consultar el reporte, 198 MiB RSS y
40,895 consultas DB medidas por el fixture. Es una ejecución local sin esperas
del programador ni red de Meta; no predice tiempo de carga o capacidad productiva.
La evidencia resumida está en [verificación local](evidence/v73-meta-local-verification.json).

Entorno: Node 24.20.0, pnpm 10.34.5, PostgreSQL 17.11 nativo en un clúster privado
exclusivo y Chromium local. Las lecturas de Graph y los datos comerciales de las
pruebas son sintéticos. Ninguna cifra de fixtures acredita portafolios reales ni
estima tiempos del proveedor. Los logs privados quedan fuera del repositorio.

Las correcciones de fixtures existentes comparan el mismo instante de backup
normalizado a UTC, solicitan remarketing en el calendario de su consulta SQL
legada y fechan las declaraciones sintéticas según la zona del perfil. Mantienen las mismas assertions de comportamiento y permisos; no cambian
la aplicación de WhatsApp.

## Release a cargo de Claude

1. Leer AGENTS, índice del proyecto, este documento, ADR, publicación, CI/CD y
   el procedimiento canónico vigente. Releer `origin/main`, el SHA instalado,
   migraciones, presupuesto y custodia. No reutilizar un FULL de otro commit.
2. Completar revisión y FULL nativo del candidato. Integrar por el mecanismo
   autorizado y ejecutar los gates propios del main exacto, incluida comparación
   visual Linux y auditoría. Registrar fallos; no omitir ni marcar verde un check.
3. El último techo documentado es US$155 brutos mensuales. Releer la decisión
   y proyección vigentes antes de reservar recursos. Esta implementación no lanzó
   builds remotos ni reservó gasto; no acredita disponibilidad presupuestal.
4. Construir/sellar el paquete del commit admitido, con procedencia real; revisión
   Root, ensayo de actualización 118→119, backup fresco, locks/hold y readback
   conforme al publicador existente. Preservar portal, infraestructura y sesiones.
5. Instalar sólo tras esas barreras. Verificar SHA instalado = servido por HTTPS,
   119 migraciones y sus hashes, servicios sanos, endpoints/API/MCP, preservación
   comercial y recibo terminal SUCCEEDED/OPERATING. Registrar el release y
   actualizar el índice con evidencia real. No añadir espera arbitraria de días.
6. Entregar a Brandon el SHA, recibos, resultado y ubicación de evidencia. La
   configuración de los dos portafolios queda para Codex tras ese readback.

La autorización de este release de software no cambia gasto publicitario,
campañas, publicaciones, asignaciones humanas de números ni otros permisos
comerciales. Mantener las autorizaciones ya existentes sin ampliarlas.

## Conexión posterior a la instalación

Codex verificará primero que el servidor y el bundle MCP corresponden a V7.3.
Después, en el perfil Brandon y mediante sesión del Dueño, registrará dos
conexiones separadas con las credenciales bajo custodia privada, revalidará su
acceso, descubrirá los activos y seleccionará los dos negocios confirmados en la
nota privada de planificación. Los secretos nunca se copian a notas, Git o logs.

La aceptación operativa exige conteos reales de conexiones/portafolios/cuentas,
90 días por cuenta o errores recuperables explícitos y comparación de una muestra
con Meta usando fechas, zona, moneda y parámetros idénticos. Una cuenta sin
actividad puede tener cobertura completa y gasto cero; una métrica ausente sigue
siendo desconocida. Conectar no autoriza cambios de anuncios ni gasto.

Referencias: [ADR](adr-v7-3-meta-portfolios.md),
[publicación](publishing-changes.md), [CI/CD](ci-cd.md),
[publicación canónica](cloudbuild-canonical-local-release.md).
