# Commerce resilience UX — matriz F0–F10

Actualización: 2026-09-22. La primera publicación fue `8f275b487b4ab0f91b60221c55e1bd26f91c80d2`; la corrección posterior de ownership y lectura comercial es un candidato distinto y exige sus propias pruebas, paquete y readback. Un archivo existente en `docs/evidence/` no demuestra por sí solo el estado de ese nuevo SHA.

## Estado de ejecución

| Frente | Implementado en candidato | Probado en candidato | Publicado | Configurado en producción | Operación física |
| --- | --- | --- | --- | --- | --- |
| F0 base limpia y límites | Worktree aislado `codex/commerce-resilience-zero-effect-stability` desde `cce0582a3954d47b43d6411a5413abf07c938e81`; checkout concurrente intacto | Base productiva y `origin/main` comparados; `git diff --check` pasó | Primera publicación `8f275b`; segundo candidato pendiente | No aplica | No aplica |
| F1–F6 dominio y siete módulos | Dominio, persistencia, API, MCP, workers y UI; corrección adicional de ownership tras reemplazo de worker y de la consulta comercial de simulaciones incompletas | Segundo candidato: typecheck, lint, build, 510/510 unitarias, integración completa de 92 archivos con 542 aprobadas y una omitida; dirigidas 26/26. Benchmark sintético: 542→17 queries y mediana 491.275→13.169 ms para página de tres | Primera publicación `8f275b`; segundo candidato pendiente | Primera publicación: restricción `OK` en tres cuentas, pero lease congelada y configuración comercial lenta; se corrigen en segundo candidato | QR, identidad, teléfonos y capacidad física no autorizados |
| F7 fallas y trazabilidad | Fixtures para proveedor, disco, worker y gateway; fronteras durables y causalidad conservadas | Python CI 195/195, readback 8/8 y restauración cifrada local PASS en PostgreSQL 17 aislado, incluidos respaldo alterado y entrada symlink; no prueba RTO/RPO productivo | Primera publicación `8f275b`; segundo candidato pendiente | Efectos REAL preservados con comparación estricta en primera publicación; repetir antes de nuevas lecturas operativas | Sin envío, campaña ni cambio de política REAL |
| F8 QA de siete rutas | Matrices de 1440/1024/768/640/360/320, claro/oscuro, axe, overflow, teclado, foco y movimiento reducido; botones móviles con separación y área táctil | Segundo candidato: E2E completa 144 aprobadas, una omisión; 16 muestras sin overflow y 18 estados axe sin violaciones. VoiceOver humano y zoom nativo siguen pendientes | Primera publicación `8f275b`; segundo candidato pendiente | Primera publicación instalada | No aplica |
| F9 release/readback | `/api/version`, smoke SHA, snapshot/compare sanitizado, labels OCI, paquete con rechazo por SHA y rollback integral documentado | Primera publicación: paquete amd64, instalación `SUCCEEDED`, 6 servicios sanos, 61 migraciones, HTTPS core y portal con SHA exacto, `ZERO_MATERIAL_EFFECT_DELTA`. Segundo candidato aún sin paquete | Primera publicación `8f275b`; segundo candidato pendiente | Producción leída el 22-sep con `8f275b`; REAL sigue congelado. CI de GitHub bloqueado por presupuesto antes de ejecutar jobs; publicación manual verificada no equivale a CI verde | No aplica |
| F10 piloto físico | Fuera de alcance | No ejecutar | No autorizado | No autorizado | **Pendiente de nueva autorización específica** |

## Siete módulos y tarea primaria

| Módulo | Ruta | Tarea automatizada sin efectos | Evidencia visual del candidato |
| --- | --- | --- | --- |
| Inicio | `/home` | Abrir la tarea prioritaria | `docs/evidence/commerce-resilience-ux-20260921/ui/home-{light,dark}-{1440,320}.png` |
| Inteligencia | `/intelligence` | Preparar una búsqueda local sin enviarla al proveedor | `.../ui/intelligence-{light,dark}-{1440,320}.png` |
| Productos y ofertas | `/catalog` | Abrir el producto sintético y su preparación | `.../ui/catalog-{light,dark}-{1440,320}.png` |
| Campañas | `/campaigns` | Cambiar el periodo; sólo lecturas con fixture | `.../ui/campaigns-{light,dark}-{1440,320}.png` |
| Ventas | `/sales` | Abrir la cola de conversaciones | `.../ui/sales-{light,dark}-{1440,320}.png` |
| Resultados | `/results` | Cambiar agrupación del corte | `.../ui/results-{light,dark}-{1440,320}.png` |
| Configuración | `/settings` | Abrir la categoría estable `?section=audit` | `.../ui/settings-{light,dark}-{1440,320}.png` |

Las capturas usan `closureFixture`: nombres, contenido y cuentas son sintéticos; el transporte intercepta `/v1/*` y la prueba falla si una tarea genera una solicitud distinta de `GET`. Las capturas no acreditan por sí solas comportamiento productivo ni cumplimiento WCAG.

## Matriz de fault injection

| Falla | Frontera ejercitada | Resultado exigido | Prueba |
| --- | --- | --- | --- |
| Timeout remoto | Notificación durable ya reclamada | `UNKNOWN`; no reintento ciego | `tests/integration/operations-monitor.test.ts` — “keeps a timed out notification UNKNOWN…” |
| Evento duplicado | Ingress autenticado antes del ACK | Una sola envolvente; segundo ACK indica duplicado | `tests/integration/dispatch-faults.test.ts` — “persists authenticated envelopes…” |
| Resultado tardío | Outbox recuperado mientras llega la respuesta anterior | `UNKNOWN`, intento y recibo conservados | `tests/integration/dispatch-faults.test.ts` — “records in-flight result on late return” |
| Worker caído/stale | Heartbeat expirado | `STALE`, nunca `READY` | `tests/integration/resilience-fault-injection.test.ts`; cobertura adicional en `real-api-contract.test.ts` |
| Conflicto DB | Compare-and-set por `expected_version` | HTTP 409 `VERSION_CONFLICT` y formulario preservado | `tests/integration/api-security.test.ts` y suites de configuración existentes |
| Provider 400 | Entrega de alerta con fetch inyectado | `FAILED`; no reintento | `resilience-fault-injection.test.ts` |
| Provider 408/429/500/503 | Entrega remota ambigua/transitoria | `UNKNOWN`; no reintento automático | `resilience-fault-injection.test.ts` |
| Disco bajo | Métrica `MOUNTED_PRIVATE_STORAGE_STATFS` fresca por debajo de 1 GiB/5 % | `BLOCKED` | `resilience-fault-injection.test.ts` |
| Gateway no disponible | Cuenta WAHA en `FAILED` | conexión `BLOCKED` con fuente de sesión | `resilience-fault-injection.test.ts` |

## Límites de evidencia

- Históricos: todos los JSON/PNG previos fuera de `docs/evidence/commerce-resilience-ux-20260921/` sirven como referencia, no como validación del candidato.
- Actual: sólo una ejecución registrada con SHA, fecha, comando y resultado puede pasar una celda a “Probado”.
- Actions: el último bloqueo observado fue de presupuesto, antes de ejecutar jobs; no debe describirse como CI verde. Debe releerse al cierre.
- El bootstrap local compartido se detuvo correctamente con `MIGRATION_CHANGED:0046_channel_session_continuity.sql`. No se borra, recrea ni modifica ese volumen; integración usa bases aisladas.
- `provider_calls=0` necesita una frontera independiente del proveedor. Los contadores del core y el recibo del instalador no pueden demostrar por sí solos ausencia de llamadas externas; ambos deben conservar `NOT_OBSERVABLE`.
- La capacidad física queda “No medida” si no existe una observación vigente; nunca se convierte en cero.
- F10 permanece fuera de alcance aunque F0–F9 queden publicados.
