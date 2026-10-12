# V7 — Cierre de consumidores antes del montaje

Fecha: 2026-10-12. Estado: integración local; sin publicación ni operación.

La integración conserva los cambios F0, F2, RF14, F4 y F3 revisados. El candidato
público `51f72e0ce43620a88195cb796997dd8c051c47ef` permanece inmutable. Las pruebas
focales de cada componente no prueban que sus entrypoints estén montados ni que
la migración nativa se haya realizado.

## Autoridad y transacciones

El inventario estático inicial encontró 41 módulos registrados directamente por
`createApp` y 107 archivos con consumidores API/worker relevantes. Sus cantidades
son sitios AST, no un número de rutas HTTP ni una demostración dinámica de RLS.
Incluyen 167 consultas al pool, 103 llamadas a `withTransaction`, cuatro usos de
`pool.connect` y productores de archivos o llamadas externas. Las dependencias
indirectas y rutas generadas necesitan su propio catálogo exhaustivo.

Cada ruta V1 requiere acción V7 fija, entorno validado, membresía/credencial
vigentes y ejecutor de perfil. Un Principal por ruta conserva el rol real y sólo
aliases explícitos de esa acción. No se conserva selección por primera membresía,
PAT como Dueño, wildcard de permisos ni fallback a pool global. La compatibilidad
SQL de `profile-query-routing` no otorga autoridad: se abre dentro de la transacción
canónica y rechaza conexiones nuevas/administración, perfiles distintos y uso
tardío. La respuesta HTTP se materializa y entrega después del COMMIT.

`context.mutate` contiene una segunda verificación PAT antigua. Su adaptación
requiere un registro interno asociado al mismo request, Principal y executor V7;
ningún flag recibido por HTTP o campo fabricable de Principal puede desactivarla.
El registro no sustituye la validación de autoridad al finalizar la transacción.

No se envuelve un dispatcher entero con ALS. PREPARE, la autorización final y
RECONCILE son transacciones separadas; el INTENT se confirma antes de HTTP. Los
workers obtienen únicamente perfiles permitidos mediante puertos de descubrimiento
acotados, nunca mediante `SELECT` global añadido para eludir RLS.

## Sitios que requieren adaptación explícita

| Sitio | Tratamiento requerido |
| --- | --- |
| `account-security.ts` | Identidad global autenticada; separado del perfil y de su pool restringido. |
| `catalog.ts` upload/complete y `receipt-access.ts` | Mantener permisos de archivo, hash, tamaño, cifrado y entrega posterior a autoridad; no convertir el directorio privado en salida pública. |
| `integration-diagnostics.ts`, `provider-diagnostics.ts` | Separar red de transacciones, conservar intent/fence/readback y no autorizar efectos por el wrapper SQL. |
| `intelligence-corpus-evaluations.ts` | Reemplazar préstamo de conexión por protocolo explícito; el rechazo ALS de `connect` no se relaja. |
| `simulation-snapshots.ts` | Custodia de archivos y fronteras del laboratorio; conservar separación REAL/SIMULATION. |
| `campaign-performance.ts` | Aislamiento REPEATABLE READ se declara antes de cualquier consulta; no intentar cambiarlo después del bloqueo de autoridad. |

## Componentes integrados y montaje pendiente

F5 ya incluye el registro de pagos con filtros, CSV/XLSX, cliente/MCP/UI, política
por perfil o variante y snapshots por pedido. Los workers canónicos capturan y
aplican023; el puerto RF14/019 separa PREPARE, INTENT confirmado, petición y
RECONCILE. Tras borrado declarado, la lectura usa el contexto financiero024 y
omite máscaras/materiales borrados. El broker físico de medios, las raíces del
host y el montaje no se deducen de estos ensayos locales.

RF19 ya conserva captura nativa cifrada, compilación completa, control021, vínculo
AI019, motor en una base dedicada, workflows canónicos, materialización atómica y
custodia cifrada de archivos. Las migraciones de motor/materialización se aplican
únicamente a esa segunda base: no se incorporan al catálogo comercial. El driver,
los entrypoints, el acceso físico y las invocaciones de proveedor siguen siendo
fronteras explícitas, sin convertir SIMULATION en permiso de salida.

F7 incluye metas, opciones, resultados persistidos, proyecciones/sello, coste IA
atribuido y no atribuido, contexto financiero mínimo, prueba durable de cierre,
rebuild y percentiles exactos. El borrado real D18 y el montaje no están cerrados
por la existencia del lector o de la reconstrucción derivada. Los componentes
posteriores de privacidad preservan los contratos y se incorporan por deltas
revisados, sin modificar las68 migraciones históricas.

## Aislamiento pendiente de corte

Los componentes020 ya preparan identidad, entorno de hijos y propietarios, Meta,
idempotencia con adopción explícita, controles manuales, lectores privilegiados,
cuotas globales, presupuesto creativo compartido e historial de dispositivos
retirados. FK y RLS tienen planificadores con locks y comprobación de metadata;
la clasificación comercial es exhaustiva y rechaza cualquier tabla desconocida.

Nada de ello convierte los grants históricos, funciones SECURITY DEFINER o
identidad global en revisiones implícitas. Antes del corte se requiere el catálogo
completo actual, adjudicación explícita de cada autoridad y prueba conjunta de
la matriz de acceso. La configuración de BetterAuth permanece global y separada
de la selección de perfil; las rutas antiguas no pueden conservar como fallback
la primera membresía ni tratar un PAT como propietario.

El siguiente FULL debe usar el árbol consolidado completo con todos los gates,
fuentes, rutas y consumidores realmente montados. Se conserva el candidato
público previo y toda evidencia de intentos fallidos; ningún resultado local
acredita por sí mismo despliegue ni operación real.
