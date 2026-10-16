# V7 F5 — Venta de variante con comprobante, cola de revisión y remarketing por variante

13-oct-2026. Agente: Claude. Continúa el documento de variante
(`docs/adr-v7-variant-document.md`) y conecta piezas que ya existían por
separado: la política de comprobantes, su captura y evaluación en workers
(`adr-v7-receipt-policy*.md`), la extracción con admisión
(`adr-v7-receipt-ai-admission.md`), el registro de pagos
(`adr-v7-payments-register.md`) y los ciclos de remarketing. Cubre RF-08.a/c,
RF-09.a–l, RF-10.b–f, RF-04.b y RF-17.g. No instala nada en producción.

## Venta de extremo a extremo

1. Un número asignado a la variante recibe el primer mensaje. La conversación
   fija la versión publicada vigente (`market_journey_snapshots`).
2. El flujo de venta por conversación ofrece, pide el acuerdo, registra el
   compromiso y envía las instrucciones de cobro: SPEI (banco, beneficiario y
   CLABE) y/o enlaces, descifrados sólo para ese mensaje.
3. El pedido captura la política de comprobantes vigente en su creación. Cada
   perfil recibe una **política por defecto con aprobación humana** al crear su
   primer producto, o al migrarlo. Es una escritura versionada normal
   (revisión 1, CAS, historial), con una operación determinista por perfil y
   entorno. Una edición posterior de la Dueña nunca se sobrescribe.
4. El comprobante se lee con el permiso `receipt.document` de la variante y la
   key del negocio (lo emite la Dueña al confirmar la IA de la variante):
   - Sin ese permiso, o sin el login `commerce_ai` en el host, el comprobante
     queda para una persona (`RECEIPT_AI_GRANT_REQUIRED` /
     `RECEIPT_AI_019_REQUIRED`). Nunca cae a un proveedor de plataforma.
   - El modelo sólo extrae datos; la política decide.
   - El destino que se compara es la CLABE y el titular del cobro V7. Un cobro
     sólo con enlaces no tiene destino bancario y queda por confirmar.
5. Aprobado, sea por la regla automática de la variante o por una persona, se
   reconoce el pago una sola vez, se entregan los materiales y se envía el
   agradecimiento.

Los comandos de conversación, la revisión de comprobantes, la entrada de
mensajes, los temporizadores y las programaciones actúan **dentro del perfil
del registro**. Los efectos bajo autorización permanente sólo cambian en el
contexto de su perfil (`CONTINUITY_PROFILE_CONTEXT_REQUIRED`). Antes de este
cambio, cancelar un cobro pendiente al recibir un comprobante podía fallar.

## Cola de comprobantes (RF-09.g/h/l, RF-17.g)

| Ruta | Alcance | Uso |
|---|---|---|
| `GET /v2/receipts?view=pending\|all` | `receipts:read` | Pendientes primero (el más antiguo arriba), luego el resto |
| `GET /v2/receipts/:id` | `receipts:read` | Reglas revisadas con su resultado, datos leídos, decisión previa y fallo de la última decisión |
| `GET /v2/receipts/:id/document` | `receipts:read` | Imagen o PDF del almacén privado cifrado, verificado por SHA-256, `private, no-store` y CSP `sandbox` |
| `POST /v2/receipts/:id/decision` | `receipts:review` + `Idempotency-Key` | `APPROVED` o `REJECTED` con `expected_version`; 202 y la aplica el worker |

Los cinco resultados son los mismos que la hoja de pagos: Aprobado, Por
revisar, Rechazado, Prueba y Falso.

Aprobar registra el monto leído del comprobante. Si no se pudo leer, la persona
lo confirma (`amount_minor`) y queda como observación humana. Una misma
operación repetida devuelve el mismo comando. Una segunda decisión distinta se
rechaza (`RECEIPT_DECISION_PENDING`, `RECEIPT_ALREADY_DECIDED`).

En la web, Inicio lleva a la cola en un clic aunque la guía inicial siga
activa. La cola abre sola el comprobante pendiente más antiguo y aprobarlo es
el segundo clic. Medido en el recorrido local: 2 clics y 4 s hasta la
confirmación.

El MCP `receipts_manage` ofrece listar, leer, archivo y revisar. El archivo
devuelve sólo la disponibilidad y el enlace a la aplicación: la imagen de un
pago nunca entra a un contexto de IA.

## Hoja de pagos (RF-09.i/j)

- Muestra el nombre de la variante (antes, un fragmento del UUID).
- Muestra el método ofrecido. Las ofertas V7 guardan `collection_methods`
  (`spei` y/o `link`), y la minimización financiera lo conserva. Con ambos
  métodos, la transferencia se afirma sólo si el destino del comprobante
  coincidió; si no, queda «Sin dato».
- La exportación CSV/XLSX enlaza a rutas de la aplicación
  (`/sales/receipts?receipt=…`) y no a URLs firmadas.

## Remarketing por variante (RF-10.b/c/d/f)

- **Mensajes:** hasta tres seguimientos por etapa («si aún no acepta» y «si aún
  no paga»). Cada uno puede ser de sólo texto (nuevo), o de audio o video con
  texto; estos dos siguen exigiendo su archivo.
- **Esperas:** 2/8/24 h editables.
- **Máximo:** compartido entre ambas etapas; es el número de seguimientos
  activos por persona.
- **Horario:** `window` con la hora de inicio y fin locales. Al publicar se
  completa con la zona horaria de la variante. Por defecto va de 09:00 a 21:00
  en las variantes nuevas; las políticas anteriores sin horario conservan su
  comportamiento.
  - Al programar, cada seguimiento cae en el siguiente momento permitido.
  - Si al despacharse está fuera de horario, el temporizador se reprograma sin
    enviar (`remarketing.rescheduled_to_window`) y todas las guardas se vuelven
    a revisar en ese momento.
  - Los cambios de horario de verano se resuelven en la zona de la variante.
- **Paradas** (sin cambios): compra, respuesta, baja, rechazo, pausa humana,
  ventana de 24 h cerrada sin plantilla aprobada, máximo alcanzado.
- **MCP:** `remarketing_manage` permite leer, guardar, validar, publicar y ver
  el historial. Los ciclos, la reprogramación y los resultados siguen
  declarados como pendientes (F7).

## Verificación local (sin FULL)

- `v7-variant-sale` (PostgreSQL con roles restringidos y RLS FORCE) recorre
  cuatro ventas sobre una variante:
  - sin permiso de IA, pasa a una persona;
  - con permiso y la política por defecto, se lee con un proveedor de contrato,
    se revisa en la cola y se aprueba en un clic;
  - con la regla automática de la variante, se aprueba solo;
  - con el monto equivocado, queda por revisar con la regla fallida.
  
  Además verifica la entrega de materiales, la cola, el archivo privado, la
  idempotencia y la doble decisión, el monto confirmado por la persona, la hoja
  de pagos y que las políticas capturadas no cambian.
- `v7-remarketing`: programación dentro del horario, máximo compartido, espera
  fuera de horario sin envío, envío de sólo texto y cancelación al responder.
- Unitarias de la ventana (incluido el cambio de horario de verano), del
  contrato de remarketing, de la exportación de pagos y del MCP (11 en el
  servidor de perfil).
- Chromium local:
  - cola de comprobantes en escritorio y 390 px, con aprobación desde Inicio
    en 2 clics;
  - sección Remarketing en escritorio y 390 px, sin desbordamiento.

## Pendiente fuera de F5

- Transcripción de notas de voz (`audio.transcribe`) en el tiempo de
  ejecución: F6/F7.
- Métricas de remarketing (enviado, respondido, venta recuperada), cruce de
  ingresos con Campañas y filtro por oferta en la vista inversa: F7.
- Login `commerce_ai` y réplica GCS del almacén privado en producción: F1.
- Retiro de la vista genérica anterior de comprobantes: F8.
