# Interruptor REAL y continuidad de publicación

Decisión: [ADR](adr-real-launch-continuity-2026-09-23.md). Alcance: Ventas por WhatsApp, permisos vigentes y worker de canal. La publicación inicial de este cambio usa el congelamiento anterior; el mecanismo compatible opera a partir de la siguiente publicación si tanto la imagen instalada como la candidata soportan `release_hold` y la migración 0062 está presente.

## Operación del dueño

**Sistema → Configuración → Interruptor de ventas REAL** muestra revisión comercial, política, pausa general y estado por número. `GET /v1/settings/launch?environment=REAL` devuelve `OPERANDO`, `NECESITA_ATENCION` o `BLOQUEADO`, causa, siguiente acción, vencimiento de autorización y cantidades de efectos retenidos o inciertos. La vista se actualiza cada 30 segundos mientras está abierta.

`POST /v1/settings/launch/switch` requiere owner humano, `Idempotency-Key`, `environment=REAL`, `expected_version`, `action=OPEN|PAUSE`, motivo y `confirmation=CONFIRM_REAL_SWITCH`. `PAUSE` usa el control de workspace y conserva revisión y permisos; también funciona durante un release hold. `OPEN` retira ese control; si la política comercial estaba cerrada, abre las tres banderas y **crea una nueva revisión**. Los permisos anteriores ya no cubren esa revisión: hay que revisar y autorizar cada asignación en Ventas. Abrir puede terminar con cero números `OPERANDO`; la lectura posterior debe decidir si se anuncia el lanzamiento. El interruptor nunca inicia campañas, amplía contactos, extiende vencimientos ni reenvía efectos inciertos.

La autorización continúa por asignación: destinatarios seleccionados o nuevas entradas, tope total de mensajes, vencimiento explícito y permiso de automatización. El dueño puede elegir hasta 366 días; operadores y tokens de servicio conserva el máximo de siete días. Una renovación de nuevas entradas conserva la fecha original de inicio sólo si siguen iguales asignación, revisión, identidad y configuración, para que las conversaciones entrantes de ese permiso puedan continuar en su ventana. Una cuenta sin identidad, salud, propiedad, permiso o alcance vigente queda bloqueada individualmente. [Decisión de vigencia y continuidad](adr-annual-assignment-authorization-2026-09-23.md).

## Publicación compatible

1. El instalador comprueba el marcador de capacidad en ambas imágenes y las columnas de la migración. Si cualquiera falta, usa el congelamiento anterior.
2. Con compatibilidad comprobada, pone `release_hold=true` bajo el mismo lock de política que usa el dispatcher. Toda lectura de política devuelve `dispatch_frozen=true`; la revisión y el cuerpo comercial no cambian. Marca únicamente las propiedades que estaban libres como `release_frozen` y detiene los writers.
3. Instala, verifica aislamiento del contenedor anterior y registra recibos de transferencia. Si falla, el hold permanece y genera alerta. No hay reintentos de efectos `SENDING/UNKNOWN`.
4. Tras servicios sanos y recibos, retira el hold. Expira el lease del owner anterior sólo cuando hay un recibo de aislamiento de esta ventana y crea un `check_health` de lectura por cuenta. La nueva generación verifica salud, identidad, controles humanos, incidentes, resultados inciertos y autorización vigente antes de liberar cada `release_frozen`.
5. El smoke exige `release_hold=false`, paridad HTTPS y, para una publicación compatible, revisión/cuerpo comercial idénticos a los previos. El reporte registra si la política terminó abierta o congelada. Releer `/v1/settings/launch` tras la publicación: seis servicios sanos no acreditan números operando.

Rollback compatible usa el mismo hold y relevo; rollback a un binario anterior vuelve al congelamiento antiguo. Un fallo de salud en una cuenta conserva su propiedad congelada y produce `RELEASE_RECOVERY_PENDING` tras cinco minutos; las otras pueden continuar.

## Alertas

Inicio muestra REAL congelado, hold sin cerrar, propiedad pendiente, autorizaciones próximas a vencer o vencidas, efectos `UNKNOWN` y bloqueos. Números y el interruptor muestran la causa por cuenta. El monitor duradero crea una sola alerta activa por cuenta para recuperación pendiente, autorización por vencer o vencida, efectos inciertos y cola bloqueada; la resuelve cuando desaparece la condición. `RELEASE_HOLD_OVERDUE` se eleva tras cinco minutos. Las notificaciones externas dependen de `alerts:default` configurado; `PENDING`, `ACCEPTED` y `UNKNOWN` no equivalen a lectura humana.

## Verificación antes de declarar continuidad

- Probar publicación compatible con REAL abierto: revisión igual antes/después, política abierta, propiedad nueva con aislamiento, salud vigente, permisos sin extensión y outbox sin duplicados.
- Probar caída antes del relevo, rollback, autorización vencida, identidad distinta, cuenta fallida, controles humanos y efectos inciertos. La cuenta afectada debe quedar bloqueada, con alerta y sin llamada de envío.
- Medir la indisponibilidad en una ventana real y hacer prueba física de entrada → cinco mensajes → aceptación → entrega → cobro por cada número. Las pruebas sintéticas no validan recepción física ni garantizan disponibilidad de WAHA.

## Transporte a evaluar

Meta documenta la [WhatsApp Business Platform](https://whatsappbusiness.com/developers/developer-hub/) y la [Cloud API](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api), con números de prueba y webhooks. Commerce OS ya aísla el transporte tras un adaptador. Evaluar primero una cuenta de prueba oficial, consentimiento, plantillas, webhooks, costes y requisitos de incorporación; migrar un número existente exige un proyecto aparte y validación humana de la cuenta. Este release conserva WAHA/QR como transporte experimental.
