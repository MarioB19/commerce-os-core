# Integración de los incrementos pendientes — 07-sep-2026

Brandon autorizó pushear a `main` todo el trabajo de Commerce OS pendiente. Se integran `codex/channel-lifecycle-controls`, `codex/sales-visual-seller` y la corrección del proxy de `codex/account-security` sobre el `main` publicado `81a3e5b`, conservando su historial. El CI/CD existente verificará e instalará el resultado; esta autorización no activa correo, WhatsApp, campañas o gasto.

Antes de completar la integración se acuerdan estos contratos:

- El controlador de identidad transaccional vigente conserva todas las rutas de autenticación. Se registran además los endpoints de eliminación de números y del vendedor; no se reintroduce el handler anterior de Better Auth.
- Las categorías nuevas mantienen los permisos de catálogo y el bloqueo de números eliminados se conserva en lecturas/escrituras operativas. Las rutas de Mi cuenta y Resend conviven con la navegación simplificada de Ventas.
- La migración de Ventas visuales, sólo aplicada en su base local aislada como `0020_sales_visual_seller.sql`, se publica como `0022_sales_visual_seller.sql`. Las migraciones productivas `0020_account_security.sql` y `0021_identity_runtime_grants.sql` permanecen byte a byte intactas. Las bases aisladas anteriores no se reutilizan para esta comprobación conjunta.
- Recuperación verifica conjuntamente credenciales preservadas, enlaces/sesiones invalidados, correo deshabilitado, categorías, vendedor y snapshot del editor. La evidencia conjunta se genera con una prueba nueva; no se combinan mediciones históricas como si fueran una ejecución.
- La configuración local admite `API_PROXY_TARGET` explícito y, en su ausencia, `API_PORT`. E2E conserva el SMTP loopback de identidad y sólo reutiliza un servidor por elección explícita. Las pruebas se ejecutan en una base y puertos separados.

Verificación: tipos, lint, build, unitarias, integración PostgreSQL, E2E, recuperación y pruebas Python de publicación/proxy; comparación de migraciones publicadas y revisión de secretos antes del push. Evidencia y resultado productivo en `PROGRESS.md`.

La primera ejecución conjunta descubrió que las fixtures de integración compartían la IP de inyección y agotaban el límite persistente de login entre suites. Cada suite funcional utiliza ahora una dirección sintética distinta de `192.0.2.0/24`; los escenarios de límite de identidad conservan sus IP y verificaciones explícitas. No se modifica ni vacía el limitador productivo. El SMTP de E2E permite `IDENTITY_TEST_SMTP_PORT` (por defecto 2527) para coexistir con otras revisiones locales, manteniendo escucha y allowlist loopback y rechazo en producción.
