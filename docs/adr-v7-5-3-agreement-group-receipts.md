# V7.5.3 — Acuerdo contextual, recepciones de grupo, laboratorio por tier y remarketing de Mi Ciclo Listo

13-nov-2026. Claude. Release correctivo sobre V7.5.2 (`13461428`, 121 migraciones).
Una migración nueva e incremental: `0122_v753_number_lab_plans.sql` (sólo el
esquema del laboratorio). No cambia precios, reglas de aprobación de
comprobantes, asignaciones, campañas ni gasto.

## F1/F2 · Acuerdo: propuesta de la IA + regla determinista (opción 2)

Hechos (V7.5.2, suite `86db2952`): la compradora escribió «Sí, acepto» al
acuerdo explicado; el flujo esperaba la frase literal; el vendedor IA contestó
que el acuerdo estaba registrado y el material en camino, y el flujo no envió
nada.

Decisión (autorizada por Brandon como opción 2):

1. **Una sola transición canónica.** `commitAgreement` (automation-worker) es el
   único camino que compromete la orden: frase configurada, comando humano y
   propuesta de la IA confirmada. Reutiliza el compromiso, la orden, la entrega y
   la cancelación de recordatorios pendientes que ya existían; corre en una sola
   transacción con escritura versionada de la orden y la conversación (dos
   escritores concurrentes no comprometen dos veces) y es idempotente
   (`order.committed` una vez; repetirla no vuelve a entregar salvo el comando
   humano, que conserva su `redeliver`).
2. **Dos llaves.** La IA sólo *propone* (`intent:'commitment'`, confianza
   ≥ 0.85, sin herramientas). `decideAgreementProposal` confirma únicamente si el
   acuerdo ya llegó al transporte, la orden no está comprometida, los controles
   están libres, el nodo es contextual y `screenAgreementReply` lee un sí claro
   («Sí, acepto», «va», «ok», «adelante», 👍…). «Sí, soy maestra», preguntas,
   negativas, condiciones, pagos declarados u otro tema no aceptan.
3. **Aclaración sin entrega.** Si la regla no confirma, se envía
   `agreementClarification` (texto determinista, sin afirmar registro ni envío)
   y no se entrega nada. Un nodo literal pide su frase exacta.
4. **El texto refleja el estado.** Mientras la orden está `OFFERED`,
   `unverifiedAgreementClaim` sustituye cualquier respuesta que afirme registro
   o entrega, sea cual sea su intención (`UNVERIFIED_AGREEMENT_CLAIM` en el
   contexto del vendedor).
5. **Concurrencia.** Una propuesta queda `AWAITING_EFFECT` si una persona toma
   la conversación durante la llamada y se revalida al liberarse; una propuesta
   vieja (llegó otro mensaje, baja o atención humana) se descarta sin cambios.
6. **Compatibilidad.** Las frases literales siguen funcionando igual
   (`configured_customer_phrase`); los otros productos no cambian.

Venta guiada sin espera de cobro: la receta de 10 pasos cobra al confirmarse la
entrega inicial completa. `billing_delay_seconds` sólo lo usa el flujo por
defecto; en una oferta guiada el vendedor lee 0 y el editor lo explica en lugar
de mostrar el campo. No se introduce ninguna espera nueva.

## F3 · Recepciones del calentamiento de grupo

Hechos (producción, sólo lecturas): el remitente guarda el ID `true_…@g.us_<id>_<participante>`;
los receptores ven `false_…` con otra representación del participante. El
componente del mensaje coincide 1:1; `correlateGroupEvents` comparaba el ID
literal y nunca acreditaba. Preexistente (no lo causaron V7.5.1 ni V7.5.2).

Decisión:

1. **Identidad canónica por adaptador** (`groupMessageIdentity`): para WAHA,
   chat `@g.us` + ID del mensaje; cualquier otro proveedor o forma, literal.
2. **Correlación estricta.** Además del ID canónico, el autor del evento debe
   ser la línea remitente (miembros del grupo por LID/teléfono o huella de la
   identidad de calentamiento) y el receptor una línea propia distinta. Cada
   recepción nueva deja `warmup.group_receipt_correlated` con el modo
   (`LITERAL`/`CANONICAL`).
3. **Idempotente.** La llave `(effect_id, receiver_id, delivery_source)` no
   cambia; un evento repetido, previo al ACK o posterior a un reinicio acredita
   una vez.
4. **Reconciliación acotada.** `reconcileGroupDeliveries` revisa en cada pase
   hasta 200 eventos guardados sin correlacionar. No reenvía, no fabrica
   recepciones, no acredita a mano ni reemplaza episodios. `SENDING/UNKNOWN`
   conservan su recuperación.
5. **Sin ráfagas.** Un turno liberado tarde por su predecesor respeta el
   espaciado planeado desde que el predecesor salió (`WARMUP_CAUSAL_SPACING`).
   Los turnos de un día vencen a su hora; los vencidos no cuentan como
   pendientes.
6. **Estado veraz.** `effectiveProgramState` distingue `WAITING_RECEIPT`,
   `UNCERTAIN`, `BLOCKED` (con su motivo) y `RUNNING`; «próximo envío» sólo
   muestra un turno futuro. Web, API y MCP leen lo mismo.

## Laboratorio (A01–A05, 97/107)

1. **A01** El comprador automático acepta como una persona (frase contextual).
2. **A02** Espera los temporizadores del flujo en vez de avanzar a ciegas.
3. **A03** Verifica la entrega **por ID y etapa**: cada material esperado una
   vez, aceptado por el transporte, nada de otra etapa antes de tiempo, nada
   inesperado, y el importe aprobado igual al planeado. Lo esperado se calcula
   del snapshot de la oferta y del pago registrado, sin usar el código de
   entrega. El comprobante que crea el laboratorio queda marcado como evidencia
   sintética (`synthetic_receipt`) para que el monto de prueba —y el extra de
   107— cuente igual que en producción.
4. **A04** `PASSED` sólo en estado terminal.
5. **A05** La proyección del caso refleja el estado real.
6. **Planes por caso**: `cases:[{variant_id,journey,tier_id}]` acota una suite;
   cada caso paga el monto de su tier (97 o 107).
7. **Matriz con tope persistente** (`0122`): varias suites comparten
   `matrix_id` y un tope agregado (`matrix_maximum_microusd`,
   `matrix_maximum_ai_calls`) que la admisión existente reserva de forma
   persistente. Exceder el tope (`LAB_MATRIX_LIMIT`) o cambiarlo
   (`LAB_MATRIX_LIMIT_CHANGED`) se rechaza antes de llamar a la IA. No cambia
   los controles de costo existentes.

## Remarketing de Mi Ciclo Listo

El motor ya tenía la semántica pedida; V7.5.3 la prueba con reloj controlado
(`tests/integration/v753-mcl-remarketing.test.ts`) con la política exacta:

- Un solo mensaje por ciclo de cliente, compartido entre acuerdo y cobro.
- 2 h después de un ancla confirmada por el transporte.
- Sólo 09:00–18:00 America/Mexico_City; fuera de horario espera a las 09:00 y
  sale una vez (sin ráfaga, aunque corran dos workers o se reinicie).
- Cancelan: respuesta del cliente, comprobante (aun antes de leerlo), pago,
  baja o atención humana. Un pendiente viejo nunca continúa tras una respuesta.
- Textos exactos (acuerdo / cobro) publicados sólo en la variante MCL después
  de instalar. Los demás productos siguen sin remarketing.

## Migración e instalador

`0122` agrega columnas y restricciones a `commerce_number_lab.suites` y
`suite_cases` (sin reescribir datos). Está en `V7_PROFILE_MIGRATION_NAMES` y en
`V7_INCREMENTAL_MIGRATION_NAMES`, así que el instalador la admite como
incremental sobre 121.
