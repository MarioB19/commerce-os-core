# Flujo de venta versionado, routing y remarketing compartido

Fecha: 20-sep-2026.

Estado: aceptado, implementado, validado localmente y publicado como software en `3de8b13fd3451e034847f9bfbe0c92b5a5642793`; configuración comercial REAL y piloto físico pendientes de autorización propia.

## Contexto

El flujo directo anterior omitía la presentación completa y el seguimiento heredado estaba fijado a dos toques. Además, una afirmación, un monto o un comprobante podían llegar cuando un mismo número tenía más de un producto o pedido abierto. La nueva versión necesita una receta común, selección de producto explícita, pago positivo sin umbrales de regalos y un solo cupo de remarketing compartido por contacto.

Esta decisión preserva ofertas, workflows, conversaciones, pagos y episodios de calentamiento históricos. Configurar o publicar una versión no autoriza transporte, no reactiva efectos y no modifica por sí solo números, sesiones ni asignaciones.

## Decisión

### 1. Receta inmutable de diez pasos

La receta `sales-agreement-10-step`, revisión 1, fija este orden:

1. audio de presentación;
2. imagen del pack;
3. texto de oferta;
4. audio del acuerdo;
5. solicitud escrita del acuerdo;
6. entrega completa previa al pago;
7. audio de cobro;
8. instrucciones de pago;
9. agradecimiento por el comprobante aprobado;
10. entrega completa posterior al pago.

Los cinco primeros mensajes avanzan en orden sin una pregunta intermedia. El paso 5 espera aceptación contextual y es el ancla `awaiting_agreement`; el paso 8 espera comprobante y es el ancla `awaiting_payment`. Preguntas, negaciones, condiciones y reclamos de pago no se convierten en aceptación.

La topología y las compuertas pertenecen al workflow publicado. Los medios y textos editables pertenecen al snapshot inmutable de `offer.sales_flow.content`. En runtime sólo se superponen sobre un workflow con el mismo `recipe_id`, revisión y pasos requeridos. Una discrepancia falla cerrada. Publicar una oferta que declara `sales_flow` exige que `validateSalesFlowOfferDraft` quede lista: contenido, perfil de pago, política de comprobante, workflow, vendedor y entregas de ambas etapas.

Referencias: [contrato](../packages/contracts/src/sales-flow.ts), [receta](../packages/domain/src/sales/sales-recipe-v2.ts), [overlay de runtime](../packages/domain/src/sales/sales-flow-content.ts) y [validación compartida](../packages/domain/src/sales/sales-flow-configuration.ts).

### 2. Routing por evidencia, limitado a asignaciones

La selección se resuelve únicamente entre productos asignados y vigentes del número. Se conservan como evidencias fuertes la respuesta a un mensaje conocido, una referencia registrada y una elección explícita previamente presentada. Los aliases y frases configurados se comparan dentro del mensaje con límites de palabra y normalización de mayúsculas, Unicode y acentos.

`sí`, `sí, lo quiero`, importes, `ya pagué`, transferencias y comprobantes no seleccionan producto. Si dos productos coinciden o hay evidencia explícita contradictoria, el estado es `PRODUCT_SELECTION_REQUIRED` y se muestran opciones legibles. Una respuesta escrita con el número de opción sólo vale después de haber presentado esas opciones y nunca se interpreta desde un medio adjunto. IDs escritos por el cliente no son evidencia.

Una respuesta conocida o referencia registrada conserva el pedido existente. El contexto fijado por operador o recorrido sólo se usa cuando no contradice evidencia explícita más fuerte. Si existe una única ruta inequívoca se puede continuar; de lo contrario se pregunta sin inventar una decisión con IA.

Referencias: [matching de aliases](../packages/domain/src/sales/product-routing.ts) y [resolución persistente](../packages/db/src/commercial-assignments.ts).

### 3. Pago positivo, regalos y exclusión

Una oferta nueva puede declarar `positive_payment_unlocks_all=true`. Cuando un comprobante aprobado reconoce un importe entero positivo y la moneda/pedido son válidos:

- se registra exactamente el importe observado; no se fuerza al precio anunciado;
- una contribución adicional no crea otra venta ni vuelve a entregar los mismos materiales;
- todos los materiales postpago de esa receta quedan elegibles aunque un registro histórico conserve `min_amount_minor`;
- la configuración guiada rechaza nuevos regalos postpago con umbral;
- el orden causal es compromiso pendiente, reconocimiento del comprobante, agradecimiento del paso 9 y entrega idempotente del paso 10.

El primer pago comercial reconocido crea una exclusión durable por `workspace + environment + contact_id`. Esa exclusión cierra el ciclo abierto y cancela únicamente timers y efectos automáticos todavía seguros (`PENDING`, `READY` o `BLOCKED`). `SENDING`, `UNKNOWN`, evidencia, venta y entregas históricas se conservan. La exclusión bloquea remarketing automático en otros números/productos del mismo contacto, pero no bloquea soporte entrante ni una compra nueva iniciada por la persona. No se infieren identidades entre contactos diferentes.

La migración 0058 hace un backfill idempotente desde pagos positivos reconocidos, sin crear mensajes ni reactivar pendientes. Referencias: [reconocimiento de recibos](../packages/db/src/receipt-sales.ts), [exclusiones y ciclos](../packages/db/src/commercial-remarketing.ts) y [migración 0058](../packages/db/migrations/0058_commercial_remarketing_cycles.sql).

### 4. Remarketing de tres slots y un cupo compartido

Cada política contiene exactamente tres posiciones con IDs estables:

| Posición | Demora inicial | Estado inicial |
|---|---:|---|
| `remarketing_1` | 2 horas | activa |
| `remarketing_2` | 8 horas | inactiva |
| `remarketing_3` | 24 horas | inactiva |

Cada demora se edita como cantidad positiva más unidad `minutes | hours | days` y se normaliza a segundos enteros seguros. Las tres demoras son distintas y estrictamente crecientes, incluso si un slot está desactivado. El máximo visible y durable es sólo el número de slots activos; cambiar una demora no activa un slot, no cambia el máximo y no crea otro intento.

Un slot activo necesita, para `awaiting_agreement` y `awaiting_payment`, un audio o video más texto. Los slots desactivados pueden quedar incompletos. Las dos etapas comparten el mismo ciclo, máximo e intento por `slot_id`; avanzar de etapa, cambiar producto/número o reiniciar un worker no repone cupo. Reserva y consumo son atómicos, y `UNKNOWN` conserva el intento hasta conciliación.

La política se sella en el ciclo al abrirlo. Una nueva oferta sólo afecta ciclos nuevos. Reprogramar un ciclo abierto es una operación explícita de dos pasos:

1. vista previa con revisión, vencidos, cupo consumido, ventana del canal y hash;
2. aplicación con `expected_revision`, el mismo hash y una vista previa aún vigente.

La aplicación conserva intentos consumidos, `SENT`, `SENDING` y `UNKNOWN`; cancela/recrea sólo timers pendientes seguros. Una fecha nueva ya vencida se omite y nunca se envía en ráfaga. El tiempo comercial de 24/36/48 horas no amplía por sí mismo la ventana del transporte: fuera de ella debe existir una plantilla/capacidad elegible o el envío permanece bloqueado.

Referencias: [política de dominio](../packages/domain/src/sales/remarketing.ts), [runtime y cupo](../apps/automation-worker/src/workflow-timing.ts) y [API de vista previa/aplicación](../apps/api/src/remarketing.ts).

## F6: prueba por número

`Probar flujo` parte de un número REAL sólo como fuente de lectura. Copia todas sus asignaciones activas y el grafo versionado a un laboratorio SIMULATION, sustituye banco y accesos por placeholders, usa transporte simulador y conserva `external_effects=false`. El operador prueba selección multi-producto, preguntas, aceptación, comprobante sintético y reloj virtual sin escribir IDs técnicos.

La prueba ejercita routing, workflows, pedidos, pagos y timers del runtime. Compara el estado REAL antes/después y no autoriza ni despacha WhatsApp. Por tanto demuestra aislamiento y comportamiento del software, no recepción física, calidad de un proveedor de IA, elegibilidad real del canal ni entrega de accesos reales.

Referencias: [API del laboratorio](../apps/api/src/number-flow-tests.ts), [UI](../apps/web/src/components/number-flow-test.tsx) y [integración](../tests/integration/number-flow-test.test.ts).

## F6b: calentamiento automático

La política nueva es `standard-15d/v2`: catorce días automáticos acreditados por hechos del pipeline y evaluación desde el día nominal 15. No contiene `manualReady`, checklist ni declaraciones fabricadas. `standard-15d/v1` y otras políticas históricas siguen siendo legibles y ejecutables sin reinterpretación silenciosa.

La migración v1→v2 es individual, explícita y con vista previa. Reutiliza únicamente planes automáticos compatibles, requiere condiciones seguras, crea un episodio enlazado y conserva graduaciones e historia. Un heartbeat, una fecha transcurrida o una simulación no acreditan actividad REAL. Completar preparación tampoco concede autorización comercial.

SIMULATION puede recorrer 1→4→5→14→15 con reloj controlado para verificar workers, límites y migración. REAL aún requiere números propios conectados, identidad, grupo elegible, contenido, autorización vigente, scheduler desplegado y evidencia física. QR/2FA siguen siendo intervención humana cuando el proveedor los exige.

La decisión detallada está en [ADR de calentamiento v2](adr-warmup-policy-v2-2026-09-20.md) y la migración en [0059](../packages/db/migrations/0059_warmup_policy_v2.sql).

## Sello de publicación de Mi Ciclo Listo

El importador genera primero una revisión privada v4 sin red. Esa revisión sella el SHA exacto del commit, un manifiesto con hash de cada fuente transitiva del compilador, el hash de la revisión de audio, los hashes de todos los artefactos y un plan canónico compilado con hashes separados para assets, vendedor, workflow, oferta y versión de producto. La aprobación REAL debe repetir esos sellos y el hash de sus bytes pasa también al estado reanudable y a cada clave de idempotencia.

El apply vuelve a compilar el plan y falla antes de mutar si cambió el commit, el compilador, el audio, la configuración privada, la aprobación, el plan o el estado previo. Un reporte de reanudación incompatible falla antes de autenticarse. El plan declara `account_assignment=false`, `sending_enabled=false` y `real_messages=0`; publicar catálogo no autoriza conexiones ni mensajes. Después de merge se debe regenerar revisión y aprobación desde el SHA exacto que vaya a desplegarse: una aprobación creada sobre el worktree o un commit anterior no es reutilizable.

Referencia: [importador sellado](../scripts/import-mi-ciclo-listo.ts).

## Compatibilidad, rollback y F7

- Ofertas sin `sales_flow` conservan su comportamiento histórico; una nueva publicación que sí lo declare debe estar completa.
- Las versiones publicadas son inmutables. Editar crea un nuevo DRAFT; no reescribe conversaciones abiertas.
- Un rollback selecciona una versión compatible para conversaciones nuevas y pausa la nueva programación. No borra pagos, entregas, intentos ni episodios.
- Las migraciones 0058 y 0059 son aditivas y quedaron aplicadas por el instalador canónico; el reporte validó 59 migraciones y sus hashes exactos. Un rollback de aplicación no las elimina ni borra pagos, entregas, intentos o episodios.
- F7 de software quedó cerrado con tipos, lint, build, 470 unitarias, 499 integraciones más una omisión prevista, 117 E2E, 141 pruebas Python, 23 pruebas Node, recuperación B02 y audit sin vulnerabilidades conocidas. La validación local fue el gate expresamente aceptado; GitHub Actions siguió bloqueado por presupuesto, por lo que no se acredita CI verde.
- El paquete local sellado `linux/amd64` se instaló mediante los scripts canónicos sin modificar. El release `ci-35525885616-1-3de8b13fd345` terminó `SUCCEEDED` con seis servicios, 59 migraciones, paridad HTTPS, infraestructura preservada, REAL congelado y cero llamadas a proveedor. GitHub Deployment `6555681531` registra esa instalación separada del workflow fallido.
- No se activan recordatorios atrasados, envíos, campañas, números ni calentamiento por instalar software.

## Estado de evidencia al cierre del 20-sep-2026

El SHA publicado coincide con el árbol local validado, `main`, el manifiesto, el reporte remoto y el portal. La relectura confirmó `/readyz`, 307 rutas OpenAPI y el portal con 480 actividades, nueve grados y diez PDF privados. [Recibo sanitizado](evidence/sales-flow-warmup-v2-publication.json).

La revisión MCL v4 se regeneró sobre ese SHA, sin blockers y con 29 operaciones declaradas sin asignación, envíos ni mensajes. No se fabricó una aprobación REAL ni se ejecutó apply: publicación de catálogo, actualización de los tres assignments, autorizaciones de número, warm-up físico y piloto siguen pendientes de sus gates explícitos. Cero mensajes, campañas o cambios de gasto durante el cierre.
