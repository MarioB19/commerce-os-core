# V7.5.4 — Recuperar la matriz pagada del laboratorio (Agente: Claude)

14-nov-2026. Producción (V7.5.3 `618ce5c5`) dejó la matriz pagada de Mi Ciclo
Listo `9aca909f` así: dos suites abiertas (WA 4 y WA 5), cuatro corridas con su
primer paso en `INTENT` en el control y en el motor, cero recibos, cero llamadas
de IA y toda la reserva de la matriz ocupada (US$6.40 / 32 llamadas). La causa
(`LAB_DRIVER_ASSIGNMENTS_CHANGED`) la corrige `2abb09d`. Iniciar otra prueba
devolvía `409 LAB_SUITE_IN_PROGRESS` y, aunque las suites terminaran, la matriz
sumaba los máximos de todas sus suites y rechazaba la continuación.

## Decisiones

1. **Las pruebas nuevas siguen la publicación como una conversación nueva**
   (`2abb09d`, conservado con su autoría). El binding se compila con la oferta,
   el flujo y el vendedor de la publicación. Con un binding fijado a una versión
   no cambia nada (la publicación se eligió por esos mismos IDs). Las capturas
   históricas conservan su hash (`snapshot_sha256` no depende del binding) y se
   siguen leyendo.

2. **Paso admitido y detenido antes de efectos: cierre auditable, nunca
   reejecución.** La acción, su simulación y su recibo `ACTION_APPLIED` se
   confirman en una sola transacción del motor; IA y transporte vienen después.
   Un `INTENT` sin recibo y sin vínculo de IA no produjo efectos ni consumo. La
   ruta soportada es la del worker (`reconcileStaleNumberLabOperation`, la misma
   pasada que concilia recibos y cierra pasos no admitidos):
   - control: `INTENT` con más de 600 s y sin `ai_bindings` (lectura);
   - motor, bajo el bloqueo de la fila de ejecución (cada fase del motor la
     toma `FOR SHARE` y verifica `INTENT` al empezar y al terminar): sin recibo,
     `INTENT → FAILED`. Esto **bloquea al worker atrasado**: ya no puede abrir
     una fase (`LAB_ENGINE_BINDING_REQUIRED`);
   - control, bajo el bloqueo de la operación: vuelve a exigir `INTENT`, edad y
     cero vínculos de IA y cierra `FAILED` con `LAB_OPERATION_STOPPED_BEFORE_EFFECTS`
     (`engine_admitted: true`, `effects: 0`, `ai_calls: 0`).
   Un recibo existente se concilia desde el recibo (sin cambio). Un vínculo de
   IA (resultado confirmado o incierto del proveedor) deja el paso en
   conciliación. Repetida, concurrente o tras un reinicio, la recuperación
   converge en un solo cierre (un evento `FAILED`, una versión de la corrida).
   Sin SQL manual, sin borrar corridas, sin fabricar éxitos.

3. **La suite concluye con su historia.** El comprador automático lee el paso
   cerrado como dependencia: la variante queda «Incompleto» con el motivo. Las
   operaciones, eventos y recibos se conservan.

4. **La matriz cuenta consumo, no reservas históricas** (`matrixReservation`).
   Por suite: abierta (caso en curso o paso en cola/`INTENT`), su máximo entero;
   terminal, sólo su consumo confirmado (cobrado por intentos asentados) más el
   incierto (intentos sin estado final o vínculos sin intento, por su máximo),
   sumado entre ambos números y todos los intentos. La continuación usa sólo la
   porción demostrablemente libre; el techo de la matriz sigue fijo y nunca
   sube. Mismos controles de autorización (`tests:run`), transacción, bloqueo
   por matriz e idempotencia por operación.

5. **Continuación vinculada a una captura vigente.** `POST
   /v2/number-tests/suites` acepta `continues_suite_id`: la suite previa debe
   ser del mismo número y de la misma matriz y estar terminal. Las corridas
   nuevas capturan la publicación vigente y cada caso guarda
   `continues_suite_id` y `continues_run_id` en su plan. No abre otra matriz.

## Pruebas

- Integración (`v7-number-lab`, PostgreSQL 17 aislado): dos números siguen la
  variante, se republica, la matriz admite dos suites, los cuatro primeros pasos
  quedan admitidos y detenidos (motor inalcanzable tras la admisión: mismo
  estado persistido que producción), `409` en ambos números; un `INTENT`
  reciente no se cierra; dos recuperaciones simultáneas y una tras reinicio por
  paso dan un solo cierre; el worker atrasado queda bloqueado; cero IA; las
  suites concluyen «Incompleto»; la continuación bajo la misma matriz completa
  compra 97 y 107 y ambos seguimientos con la publicación revisión 2, dentro del
  techo; la huella REAL no cambia.
- Unitarias: `matrixReservation` (abiertas, terminales, confirmado e incierto,
  nunca menos que lo consumido) y el compilador con binding fijo e histórico.
- La prueba de V7.5.3 cambia su expectativa: tras dos suites terminadas, una
  tercera cabe sólo en lo no consumido y una cuarta se rechaza.
