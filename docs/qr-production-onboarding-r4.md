# QR productivo r4: preparado hasta el escaneo humano

Medición final: 2026-09-06 12:20:41Z, sobre el núcleo r4 instalado. La cuenta REAL existente llegó a `SCAN_QR_CODE`. Se ejecutó un único comando `connect`, resultado `APPLIED`, y una consulta autenticada QR devolvió HTTP 200. Se validaron firma PNG, vigencia temporal y Cache-Control no-store únicamente en memoria. No se guardó ni mostró el QR, ni se escaneó.

Evidencia: [qr-production-onboarding-r4.json](evidence/qr-production-onboarding-r4.json). Diagnóstico del comando: `bb1d5cd1-ef1c-4649-8b65-72649bed8e7e`. Comandos REAL pasaron de 0 a 1; outbox REAL permaneció en 0. La cuenta siguió con `sending_enabled=false`; el proceso conservó el despacho congelado. La referencia del gateway ya había sido confirmada por inventario SSH y no se creó otra cuenta.

## Paso pendiente de Brandon

1. Abrir [Canales · WhatsApp en producción](https://commerce-os.inovaris.online/sales/channels/whatsapp) e iniciar sesión si hace falta.
2. Seleccionar el entorno **Real** y abrir la cuenta WAHA existente.
3. Pulsar **Solicitar QR efímero**. El QR usado en la comprobación fue temporal; este botón obtiene uno vigente. No repetir **Conectar** mientras el estado siga `SCAN_QR_CODE`.
4. En el WhatsApp del teléfono que se quiere vincular: **Dispositivos vinculados → Vincular un dispositivo** y escanear el QR mostrado en su propia sesión de Commerce OS.
5. Confirmar en Commerce OS el estado de sesión y la identidad verificada. Si el QR expira antes de escanearlo, volver a solicitarlo desde el mismo botón.

La vinculación no habilita envíos ni vincula activos de Meta por sí sola. Se mantienen `DISPATCH_FROZEN=true`, `REAL_SENDS_ENABLED=false`, `ALLOW_REAL_OPERATIONS=false`; únicamente onboarding está habilitado en channel-worker. No pulsar **Reanudar controles** como parte de este paso. Los transportes QR continúan siendo experimentales y aislados.

La comprobación llegó hasta el último punto que no requiere escaneo humano. La sesión aún no acredita una identidad conectada ni una prueba de entrega; esos resultados no se atribuyen al QR preparado. Este documento registra la observación fechada, no un monitoreo permanente del estado.
