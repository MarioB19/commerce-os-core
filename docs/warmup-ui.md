# Warm-up: contenido y observación desde la interfaz

La revisión del 08-sep-2026 encontró que la interfaz sólo permitía conversaciones de dos turnos. Con seis conversaciones de esa longitud se alcanzaban doce mensajes, por debajo del mínimo de veinte de la fase 2. El editor permite ahora de 2 a 20 turnos explícitos, alternados entre dos números propios, usando el mismo contrato y los límites del planificador.

En Números → Preparar warm-up → Identidad y contenido → Agregar contenido aprobado:

- Escribir el nombre y cada turno. Se admiten texto, imagen, audio y documento; los archivos se seleccionan del catálogo y deben estar listos y tener un tipo compatible.
- Consultar la tabla de fases, importada de la política de dominio. Cuatro turnos permiten cinco o seis conversaciones distintas para cubrir la fase 2; cinco turnos requieren doce conversaciones distintas en fase 3. Diez turnos permiten las treinta conversaciones del mínimo de fase 5. Son cálculos de capacidad, sin afirmar que el horario, el pool o el contenido disponible ya permitan ejecutarlas.
- Confirmar propiedad, pertinencia, consentimiento y aprobación del contenido. Editar después de confirmar vuelve a desmarcar la aprobación. No se generan mensajes ni identidades automáticamente. Guardar el contenido no autoriza envíos; el alcance del pool conserva cuentas, capacidades, materiales, límites y vigencia independientes.

Números y Configuración muestran los planes persistidos más recientes: objetivo, mensajes planificados, mensajes con ACK, conversaciones previstas y estado del día. SENT no se presenta como entrega. Un día efectivo sigue dependiendo de conversaciones completas y salud conforme a las reglas del servidor.

La concentración usa `pair_stats` del overview: conversaciones históricas planificadas por pareja y total de participación de cada extremo. Los porcentajes no son tasas de entrega. El mínimo matemático de un pool pequeño se identifica por separado de la distribución registrada; con dos números es 100 %, con tres es 50 % como menor concentración máxima posible. Sin datos de pares, se informa que la distribución no está disponible.

La prueba de interfaz usa datos sintéticos y peticiones interceptadas. Verifica fases 2 y 3, consentimiento, conservación del borrador, selección de archivos, límite de veinte turnos, planes/ACK y concentración. No acredita un piloto, capacidades reales del proveedor ni una reducción de bloqueos por warm-up.

## V5, 13-sep-2026

El wizard muestra participantes, identidad/contenido, horario/límites, comprobaciones y el impacto comercial antes de Activar warm-up en estos números. La revisión y evidencia se resuelven en backend, sin SHA ni UUID manual. Pausar permanece visible; reanudar usa autorización vigente y preflight. Laboratorio ofrece Simular conversación, separada de Vista previa del plan. Véase [ADR y contratos V5](adr-v5-warmup-health.md).

La tarjeta de salud se abre al consultar el número; en la lista de números del producto, Ver salud carga evidencia almacenada bajo demanda. Expone causas, capacidades, fechas, calidad oficial no disponible cuando corresponda, cohortes y cuatro propósitos separados. No consulta proveedores ni renueva observaciones al abrir/refrescar.
