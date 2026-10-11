# Auditoría de alta QR — 6 septiembre 2026

## Causa demostrada de NOT_FOUND

La UI creaba la cuenta en REAL mediante `ResourceForm`, pero `ChannelsPage.command()` y `getQr()` omitían el entorno en sus peticiones siguientes. `scopedRecord()` interpretaba SIMULATION por defecto y rechazaba el recurso REAL con 404 `NOT_FOUND`. El fallo ocurría dentro de la API antes de HTTP interno, worker o WAHA. Se mantiene esa comprobación de aislamiento; la corrección consiste en enviar el entorno seleccionado desde la web.

Evidencia anterior a la corrección: Fastify real y PostgreSQL temporal reprodujeron GET QR y POST connect sin entorno → 404; el mismo POST con `?environment=REAL` → 202 PENDING, con cero outbox. Después se confirmó contra HTTPS productivo: GET sin entorno → 404 `NOT_FOUND`, GET con REAL → 403 `QR_UNAVAILABLE`. El segundo código corresponde al rechazo del worker con la preparación real deshabilitada; la API antigua ocultaba el motivo en una respuesta genérica. El endpoint interno existe y responde. No se afirma disponer del request/log histórico original del usuario.

El inventario productivo de sólo lectura observó una cuenta REAL WAHA, DISCONNECTED, sin envíos habilitados, sin comandos lifecycle y con despacho congelado. No se cambió su cuenta ni se creó una sesión productiva. Evidencia sanitizada: [qr-production-readonly.json](evidence/qr-production-readonly.json).

## Correcciones

- UI conserva REAL/SIMULATION en QR y comandos; refresca la cuenta desde el polling, descarta el QR al expirar/cambiar de cuenta y presenta errores accionables.
- `ALLOW_CHANNEL_ONBOARDING=true` permite preparar una sesión y recuperar su QR sin habilitar salidas. Está desactivado por defecto en los generadores de configuración. `resume` conserva `ALLOW_REAL_OPERATIONS`; el dispatcher mantiene sus tres flags, controles, aprobación y autorización.
- API y worker distinguen configuración ausente, autenticación interna/proveedor, sesión inexistente, QR pendiente, sesión ya conectada, conflicto, timeout y respuesta inválida. El error incluye operación, acción, reintento, intervención técnica, referencia, hora y estado conocido. El evento interno conserva el HTTP original del proveedor separado del HTTP del worker.
- WAHA consulta la sesión, crea la ausente antes de start y no vuelve a iniciarla si ya está STARTING, SCAN_QR_CODE o WORKING. Una petición QR exige SCAN_QR_CODE y una imagen PNG válida, con máximo de tamaño y vida de 15 segundos.
- El sondeo de salud actualiza estado. WORKING sin identidad observada no acredita conexión. Sólo se guarda una huella de identidad y su verificación, nunca el JID/teléfono de `me`. Un cambio de identidad congela su cuenta y mantiene la huella anterior para revisión.
- Registro concurrente y edición rechazan un gateway REAL ya asignado. El worker también bloquea alias de configuración que apunten al mismo URL y sesión. La puerta determinista de envío revalida aislamiento e identidad vigente antes de cualquier HTTP.
- Fallar un lifecycle congela únicamente su ownership y conserva diagnóstico; no se reintenta automáticamente una acción cuyo resultado remoto sea incierto.

## Seguridad del diagnóstico

El QR sólo atraviesa una respuesta autenticada con `Cache-Control: no-store,private,max-age=0`; nunca entra en un comando, evento, registro o caché. Los códigos y estados provienen de listas permitidas. No se propagan bodies ni mensajes libres del proveedor, cabeceras, cookies, claves, sesiones, nombres personales o teléfonos. El evento `channel.qr_failed` conserva una referencia correlacionada, etapa, código seguro y HTTP; `channel.qr_requested` únicamente acredita la consulta y `qr_persisted=false`.

Los tokens de servicio de catálogo no obtienen `channels:manage`; una sesión humana autorizada sigue siendo necesaria. SIMULATION no genera QR real. Conectar WAHA sigue siendo experimental y no vincula Meta, WABA, página, portafolio ni anuncios.

## Verificación ejecutable y resultados

`tests/integration/channel-onboarding.test.ts` reproduce el fallo original, verifica el recorrido API→worker con errores de proveedor en fixtures, autorización, no almacenamiento de QR, colisiones de gateway, aislamiento de cuentas y bloqueo ante identidad incierta. La variante remota sólo corre cuando el script siguiente proporciona un gateway local desechable; un skip normal no se declara integración remota aprobada.

```sh
node scripts/test-isolated.mjs tests/integration/channel-onboarding.test.ts
node scripts/verify-qr-onboarding.mjs
node scripts/audit-qr-production.mjs
```

El ensayo real utiliza una base temporal y `devlikeapro/waha:gows-2026.8.2` fijado por digest, bajo emulación Linux/amd64 local. Crea un contenedor nuevo con acceso HTTP sólo en loopback y sesiones/media en tmpfs. API→HTTP channel→adaptador→gateway alcanzó SCAN_QR_CODE y devolvió un PNG efímero. No se escaneó ni vinculó identidad y el outbox permaneció vacío. Se retiraron el contenedor y su memoria de sesión al finalizar. [qr-real-gateway.json](evidence/qr-real-gateway.json) registra el resultado actual; el QR no forma parte de esta evidencia.

Pruebas de contratos WAHA verifican creación antes de start, no reinicio de sesión activa, estado previo al QR, PNG efímero, límites y ausencia de identidad. Las fixtures HTTP no equivalen a escaneo, recepción real, reconexión, medios o elegibilidad oficial.

## Último punto humano y producción

El QR de ensayo expiró y fue destruido; no es un QR operativo pendiente de escanear. No se desplegaron cambios ni se habilitó preparación en la configuración privada.

Para completar una vinculación productiva después de una instalación autorizada:

1. Preservar los overlays de producción/piloto y la referencia privada existente `WAHA_01`; comprobar URL, API key y webhook secret dentro de channel-worker, y token compartido con API. No copiar valores a notas o al navegador.
2. Mantener `DISPATCH_FROZEN=true`, `REAL_SENDS_ENABLED=false`, `ALLOW_REAL_OPERATIONS=false`; habilitar exclusivamente `ALLOW_CHANNEL_ONBOARDING=true` en channel-worker. Reiniciar sólo el servicio requerido por la configuración aprobada.
3. En Ventas → Números, seleccionar Real y la cuenta WAHA con su gateway exclusivo. Pulsar Conectar y esperar SCAN_QR_CODE; solicitar QR. Si expira, solicitar otro sin reiniciar cuentas ajenas.
4. Brandon escanea desde WhatsApp → Dispositivos vinculados → Vincular dispositivo. Si WhatsApp solicita passkey/confirmación, completar únicamente el flujo legítimo permitido por el proveedor; no pegar OTP/passkeys en Commerce OS.
5. Verificar WORKING e identidad observada estable; revisar estado, salud y webhooks manteniendo congelados los envíos. Un escaneo exitoso no autoriza mensajes reales ni constituye configuración Meta.

Pendientes humanos: escaneo, identidad después del escaneo, webhooks de una cuenta vinculada y reconexión de esa sesión. Producción conserva el release anterior y sus bloqueos hasta una instalación/configuración autorizada. No hay migración de base específica del QR.

Decisión previa: [[🏗️ ADR-006 — Alta QR y diagnósticos seguros — 2026-09-06]]. Contratos oficiales consultados: [sesiones y QR de WAHA](https://waha.devlike.pro/docs/how-to/sessions/) y [seguridad de WAHA](https://waha.devlike.pro/docs/how-to/security/).
