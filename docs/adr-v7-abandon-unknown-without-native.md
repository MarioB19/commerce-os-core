# Abandonar un DISPATCH incierto sin Build nativo (Agente: Claude)

20-oct-2026. El DISPATCH del intento `471563c1` (FULL de `785b9d37`,
`full-v1`) persistió `submit_intent` a las 22:01:06Z y terminó en `UNKNOWN`
(`CREATE_OR_BIND_OUTCOME_UNKNOWN`) unos 3 s después. La causa fue un 429 de
Cloud Build en `ListLocations`, en el inventario del fence previo al POST. La
métrica `serviceruntime` registra ese 429 en el minuto 22:01–22:02. El POST
nunca salió:

- no hay `CreateBuild` en los registros de auditoría ni en la métrica de
  solicitudes después de las 19:10Z;
- el inventario nativo completo (44 regiones) tiene el mismo hash que el
  inventario de la admisión (`a2247f91…`, tomado antes de la intención).

El ledger no tenía salida para ese estado. `UNKNOWN` sin UUID sólo admite
`bind`, que exige un Build. El intento retenía para siempre la exclusión global
y los 95 minutos, y bloqueaba todo el CI.

## Decisión

Se agrega `abandon_without_native` al ledger, autorizada por Brandon el 20-oct
(«Implementar la recuperación»). Sólo aplica a un intento `full` en `UNKNOWN`
que tenga intención durable, no tenga UUID nativo y sea el intento activo. El
nuevo estado terminal `ABANDONED_WITHOUT_NATIVE`:

- conserva plan, aprobación, admisión, intención (nonce y fuente),
  `submitted_at` e incertidumbre;
- agrega `abandonment` con el hash de evidencia, la fecha y
  `charged_seconds` igual al timeout del plan;
- cobra toda la reserva como uso confirmado en cada mes que la intención pudo
  alcanzar (`reserved_at` a `submitted_at` + timeout + cola). No hay reembolso;
- libera sólo `active_attempt`;
- deja consumidos el evento, el nonce y la fuente: no se puede volver a
  despachar ni reutilizar.

El comando no autentica la evidencia; la autentica el operador Root, igual que
`abort_before_dispatch`. Antes de su única CAS, Root relee:

- los controles en pausa y el medidor sin solicitud activa;
- el ledger, que debe estar en `UNKNOWN` sin UUID;
- el inventario nativo completo, que debe ser igual al de la admisión;
- la ausencia de `CreateBuild` en auditoría y en métricas desde la intención,
  más el 429 que explica la falla.

Guarda un recibo sin secretos. La ruta HTTP del controlador no acepta este
comando.

El controlador y el atestador validan el ledger completo. Por eso sus imágenes
desplegadas se derivan otra vez y reemplazan sólo `cloudbuild_admission.py`; el
controlador conserva además el medidor del 20-oct. La actualización se hace con
ambos controles en pausa y antes de la CAS. Ningún otro módulo enumera estados
de forma exhaustiva.

## Operación

Para reducir el riesgo de otro 429 entre el inventario de elegibilidad y el
fence, Root deja al menos tres minutos sin lecturas de Cloud Build, propias o
de otro tick, antes de cada tick con inventario. Un nuevo `UNKNOWN` sin Build
volvería a costar 95 minutos.

Regresiones: el éxito conserva la historia y cobra la reserva completa. También
se cubren:

- replay idempotente y evidencia inmutable;
- rechazo desde RESERVED, SUBMIT_INTENT, UUID_BOUND y UNKNOWN con UUID;
- rechazo de etapas que no son `full`;
- rechazo de campos inyectados y de una verificación ausente, sin CAS;
- forma durable estricta;
- cargo en ambos meses cuando la ventana cruza el fin de mes.
