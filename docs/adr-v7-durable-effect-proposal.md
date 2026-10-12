# ADR V7 — Avance del flujo sólo después de una intención durable

Estado: implementación local, PostgreSQL y revisión independiente verificados, 2026-10-12. No cambia emisiones reales, candidato público ni bases desplegadas.

## Problema

`proposeEffect` devuelve `undefined` tanto cuando no existe autoridad como cuando una clave ya existe. Los mensajes del workflow avanzan el cursor sin distinguir esos casos y el agente puede marcar una propuesta COMPLETED sin outbox. Pausa y protección son condiciones reversibles; perder la intención no es una pausa.

## Decisión

El núcleo expone `proposeEffectOutcome`: `CREATED`, `EXISTING_MATCH` o `BLOCKED` con motivo cerrado. Los primeros dos llevan la fila durable. El adaptador `proposeEffect` conserva la forma fila/undefined para consumidores anteriores; los orquestadores de workflow e IA usan el resultado explícito. No se crea autoridad al deduplicar: se lee la fila original, se verifica alcance, contenido/config y opciones explícitas, y no se cambia grant, aprobación, secuencia, predecesor, estado ni fechas. Una clave con contenido distinto se rechaza.

Para una asignación permanente exacta y no revocada, pausa humana o protecciones permiten persistir una intención con estado BLOCKED, conservando el grant y la aprobación estructural. El gate final conserva toda la autoridad/pausa/protección/consentimiento/salud/cuota y vuelve a leer el grant antes de emitir. Sin grant, con revocación o alcance diferente no se crea una intención nueva.

Un workflow bloqueado conserva su nodo y contador; no registra node_executed ni cambia el cursor como si hubiera propuesto. Los pasos anteriores que sí produjeron estado durable pueden conservarse en la misma transacción. El resultado bloqueado es un dato, no una excepción SQL: el lote puede continuar con otra conversación. Errores SQL o conflictos de idempotencia siguen siendo errores y deben abortar la transacción.

Una respuesta ya calculada por IA se conserva como AWAITING_EFFECT con propuesta/uso y contexto exactos si no puede crear el efecto. No se publica ai.proposal_accepted ni se marca COMPLETED. La recuperación reutiliza esa respuesta; no vuelve a llamar al proveedor. Una pausa de conversación/contacto/número conserva la candidatura y el run AWAITING_EFFECT, actualizando su turno para no bloquear el siguiente elemento. Una pausa observada después de la respuesta guarda el resultado sin proponer efecto. La baja voluntaria (opt-out) conserva su supresión y cancelación internas inmediatas incluso bajo esa pausa, sin enviar una respuesta. Sólo un cambio del contexto descarta el resultado; no se transforma una pausa reversible en una segunda llamada. Si el contexto original cambió, se descarta conforme a los guards existentes. Opt-out y handoff conservan sus transiciones específicas y no se confunden con una respuesta comercial enviada.

Los efectos existentes no reciben autorizaciones nuevas. SIMULATION y aprobaciones temporales/campañas conservan sus gates; la deduplicación sólo reconoce intención ya persistida. No se altera la retención ni el TTL.

## Verificación requerida

- PostgreSQL real: pausa/protección crea BLOCKED, la recuperación permite la misma fila, revocación/no grant no avanza cursor; idempotencia exacta conserva permiso/fechas y rechaza contenido diferente.
- Workflow real: mensaje/banco/entrega no saltan un paso sin efecto durable; una conversación bloqueada no impide procesar otra.
- Agente real con proveedor sintético local: respuesta pendiente no marca COMPLETED, reintento reutiliza output sin segundo proveedor, cambios de contexto descartan.
- Conservar ensayos originales 43/43 como históricos; nuevo conjunto se fija por hashes y no acredita canales físicos.

## Evidencia local y límites

El ensayo `f3-continuous-authorization-20261012/attempt11` pasó 54 casos PostgreSQL con roles restringidos. Relee 21 archivos fuente sin cambios: recibo `7eb31e13f138faba23cf8836f8b16e207594d01b72751144385c40b2f5a50216`, log `ec64c56eaa61a0dea9f45a7b2596a710eb6aba2555ae1697842a8a1666163634`. Se retiró sólo el contenedor propio; cinco CIDs/StartedAt/RestartCount y 65 volúmenes previos permanecieron exactos. El fixture de proveedor es local y no consume un modelo real. Los 43 casos de attempt8 quedan históricos. Attempt9 conservó 48/52 con errores de fixture (nombre de tabla y versión al alterar fechas); attempt10 pasó 52/52 antes del cierre final de binding y cursor IA.

Typecheck raíz, ESLint focal y 60 pruebas unitarias de continuidad/comercial pasaron. El lote de workflows se ordena por última actualización e identidad: diferir un nodo guarda estado y permite que otra conversación entre en un lote de tamaño uno. La prueba de cambio de asignación durante el callback de IA usa SQL restringido en la misma transacción del fixture; acredita relectura, no una conexión externa concurrente.

Esto no instala workers ni concede acceso a proveedores. El montaje por perfil de los workers y la separación PREPARE/red/RECONCILE de una llamada real siguen requiriendo integración y verificación propias; este ensayo sólo usa un proveedor sintético local. No acredita QR, capacidad física, entrega, coste real ni reanudación automática de efectos vencidos.

La revisión independiente encontró que el gate inicial podía borrar `ai_pending` de un run pendiente. Se corrigió el gate inicial y la relectura posterior al proveedor; los 54 casos anteriores quedan históricos hasta ejecutar los cuatro casos nuevos de pausa/reanudación y equidad.

Cierre de peer: attempt14 pasó 59/59 PostgreSQL, incluidas pausa de conversación/contacto/número con equidad del lote, pausa durante callback y opt-out inmediato. Recibo de fuente `1d459364ad0a68f038fb7bd99daaf1c81a94e9260abe90040957c09ab0a85022`; los 21 archivos capturados permanecieron idénticos en el readback final. El peer leyó los siete archivos y sus deltas y ejecutó 77 unitarias independientemente. Attempt12 conservó 54/58 por un campo NOT NULL omitido en los cuatro fixtures nuevos; attempt13 pasó 58/58 antes de la regresión opt-out. No se repitieron proveedores ni se operó producción.
