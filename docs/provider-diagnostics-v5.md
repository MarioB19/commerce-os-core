# Diagnósticos de Integraciones V5

Guardar o consultar configuración no realiza peticiones externas. La UI muestra un paso de revisión de capacidad y consumo antes de la confirmación. La verificación nunca habilita uso comercial. Las credenciales siguen cifradas y el resultado público contiene sólo metadatos.

| Perfil | Capacidad mínima | Ruta de verificación | Alcance |
| --- | --- | --- | --- |
| `creative:searchapi` | `search.meta_ad_library` | `POST /v1/provider-diagnostic-profiles/:key/verify` | Una búsqueda sintética, una unidad, reserva estimada máxima 0.004 USD |
| `creative:r2` | `storage.object_roundtrip` | Misma ruta | Objeto sintético de 64 bytes bajo prefijo de diagnóstico, lectura exacta, eliminación confirmada; hasta 4 solicitudes |
| Meta | Lectura de activos | `/v1/meta/sync` existente | Snapshot oficial versionado, idempotente y cacheado; sin mutaciones Meta |
| SMTP | Conexión/autenticación TLS | `/v1/identity/mail/diagnose` existente | `verify()` sin DATA; no acredita recepción |
| WhatsApp | Transporte/sesión/capacidad | `/v1/channel-accounts/:id/health` | Evidencia persistida actual, sin llamadas al proveedor al consultar |

Los perfiles adicionales se consultan en `GET /v1/provider-diagnostic-profiles`; el resultado persistido en `GET /v1/provider-diagnostics/:id`. Servicios requieren `integrations:read` o `integrations:verify` con el perfil exacto en su allowlist y el entorno permitido. La prueba externa de SearchAPI/R2 exige REAL explícito; SIMULATION se rechaza antes del transporte.

La verificación requiere `Idempotency-Key`, `expected_version`, la capacidad exacta y `confirmation: VERIFY_THIS_PROFILE_ONLY`. SearchAPI exige además `max_cost_usd: 0.004` y reutiliza presupuestos de proveedor y agregado existentes. Una clave repetida recupera la misma operación; cambiar su petición produce conflicto. Otra clave no reinicia una revisión con RUNNING/UNKNOWN. Cambiar versión o vencer 24 h convierte la evidencia en STALE.

SearchAPI usa el broker existente y conserva reservas monetarias cuando el proveedor no reporta costo. Una respuesta HTTP 200 sin estructura válida tampoco valida la conexión y conserva la operación incierta. Las operaciones fallidas antes del transporte se distinguen de las ya registradas por el broker. El perfil puede comprobarse con uso deshabilitado y permanece deshabilitado.

R2 reserva 64 bytes en la cuota existente antes de la petición y no crea proyectos ni equipos. Si la eliminación es incierta, conserva objeto, operación UNKNOWN y cuota. `POST /v1/provider-diagnostics/:id/reconcile` con la versión y `confirmation: RECONCILE_TEMPORARY_OBJECT_ONLY` elimina y comprueba sólo ese mismo objeto; nunca repite PUT. Sólo la ausencia confirmada libera cuota. La prueba y reconciliación comparten un bloqueo por operación: no se puede eliminar ni liberar cuota mientras una escritura siga activa; tras interrupción sólo se reconcilia el estado pendiente cuando ese bloqueo esté libre. R2 no proporciona un costo monetario confirmado en esta respuesta y no se muestra como gratis.

Verificación local: siete contratos de API con PostgreSQL y transportes fetch/S3 explícitamente aislados; veinte regresiones del broker y almacenamiento. La UI muestra capacidad y límite máximo antes del botón. Un solo clic inicia la prueba y conserva la misma clave al recuperar una respuesta incierta; no hay confirmación intermedia rutinaria. E2E verifica ese clic único, una solicitud acotada, acción de reconciliación, accesibilidad AA y ausencia de consumo al leer. Las capturas en `docs/evidence/v5-ui` contienen fixtures, no datos ni resultados reales de proveedores. No se ejecutaron proveedores reales ni mensajes.

## Tarifas contrastadas antes de la verificación de producción

Consultadas el 2026-09-13 (México): [OpenAI GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), USD0.75/4.50 por millón de tokens de entrada/salida; [GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini), USD0.40/1.60. Las tarifas se aplican sólo al modelo efectivo de cada perfil; no implican que exista una clave o saldo. [SearchAPI](https://www.searchapi.io/pricing) publica USD4 por1000 búsquedas en su plan Developer; el intento mínimo conserva la estimación existente de USD0.004, sin afirmar el plan real de la cuenta.

[R2 Standard](https://developers.cloudflare.com/r2/pricing/) publica USD4.50/millón de operacionesA y USD0.36/millónB; DeleteObject no tiene cargo. PUT+GET+HEAD del objeto temporal equivalen aproximadamente a USD0.00000522 a tarifa proporcional, más almacenamiento breve. No es factura: hay nivel gratuito, redondeo por unidad facturable y consumo compartido de cuenta. El diagnóstico informa solicitudes/bytes, integridad y eliminación, y mantiene el costo facturado como no reportado. No cambia suscripción ni cuotas.
