# Inteligencia: separación de rutas y procesamiento

La API conserva autenticación, permisos creativos, contexto de workspace/entorno e idempotencia en `apps/api/src/intelligence.ts`. La normalización, los límites de evidencia, el parser de análisis y el procesador durable viven en `packages/intelligence/src/index.ts`, compartido con el worker mediante imports relativos. No requiere un paquete/dependencia adicional.

`automation-worker` importa directamente ese módulo compartido. El dominio depende de Zod, DB y el broker; no importa rutas, contexto ni autenticación de la API. Así el worker arranca con su configuración de servicio y rol `commerce_automation`, sin recibir `BETTER_AUTH_SECRET`. La API reexporta las funciones públicas anteriores para conservar compatibilidad con sus consumidores y pruebas. Las rutas, consultas, locks, claves de operaciones y reglas de recuperación de proveedor permanecen iguales.

La regresión detectada en el despliegue del 2026-09-08 era una inicialización de Better Auth durante el arranque del worker: `automation → api/intelligence → context → auth`. Pasaba desapercibida cuando las pruebas heredaban el secreto de la API. Las nuevas comprobaciones excluyen ese secreto explícitamente y usan `NODE_ENV=production`.

Verificación local:

- 14 pruebas unitarias: 12 contratos actuales de Inteligencia y dos verificaciones de dependencias/importación. El bundle completo de automation no contiene Better Auth, inicialización de autenticación ni rutas API. Conserva únicamente el cliente Meta GET-only ya existente como dependencia sin contexto HTTP.
- 11 pruebas de integración PostgreSQL aislado: contratos API, búsquedas/análisis/seguimiento con roles mínimos y arranque completo del bundle. El proceso nuevo usa `commerce_automation`, una base vacía migrada y schema `pgboss_automation` propio; verifica que no puede leer contraseñas, sirve `/readyz`, continúa sano tras un segundo tick y termina con SIGTERM. Ninguna llamada externa se permite en esta prueba de arranque.
- TypeScript global/web, lint, diff-check y build de los cuatro servicios/web completados.

Estas pruebas son evidencia local de regresión; el cierre publicado todavía exige el run exacto de CI y la salud real del deployment instalado.
