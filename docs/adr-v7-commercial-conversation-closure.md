# V7 — Cierre humano de obligaciones comerciales

Decisión previa, 12-oct-2026. Un `committed_at` conserva una obligación; no debe
impedir para siempre un cierre explícito cuando esa obligación ya está resuelta.
El comando humano conserva su autoridad, mutex por conversación y transacción.
El nuevo lector examina **todos** los pedidos del perfil/entorno/conversación y
bloquea antes de cancelar pendientes o escribir CLOSED si falta evidencia.

Para cada pedido comercial comprometido o con actividad financiera/entrega:
importe y moneda exactos del pedido, contribuciones actuales aprobadas (sin
FALSE, TEST, duplicados ni evidencia sustituida) con su evento de reconocimiento,
o conciliación humana APPLIED ligada a su evento, importe, moneda y evidencia
protegida. No se suman conciliación y comprobantes como si fueran pagos distintos.
Una cantidad parcial no cancela el saldo aunque habilite beneficios de oferta.
Los indicadores `sale_status`, `fulfillment_status` y FINISHED no son pruebas.

Cada material exigible de la oferta capturada requiere una entrega canónica
DELIVERED/READ con efecto, intento aceptado e identidad coincidentes. Si hay un
acceso, su grant debe estar confirmado antes del mensaje de entrega. SENDING o
UNKNOWN en cualquier efecto bloquean; entregas/grants pendientes no se cancelan
para fabricar un cierre. Las fuentes consultadas se bloquean durante la decisión.
Un pedido TEST en una conversación comercial o viceversa rechaza por conflicto;
los cierres explícitos de TEST/SIMULATION no se cuentan como resolución comercial.

El resultado/evento del cierre guarda IDs, revisiones e importes comprobados sin
claves, contenido del comprobante ni enlaces de acceso. El reloj de cierre será
el `now()` de la transacción;025 mantiene su prueba de comando/evento/versión y
su propio cómputo de retención. No se cierra automáticamente al terminar workflow,
no se emite, concilia dinero ni borra información desde este helper.

Verificación prevista: función determinista con negativos; PostgreSQL con roles
restringidos y comando canónico, múltiples pedidos, parcial/FALSE/TEST, grant y
entrega inciertos, rollback, cierre pagado y conciliado, prueba025 de reloj y
fences de perfil/entorno. Los ACKs de los fixtures serán sintéticos explícitos.

Validación local:29 unitarias,18 PostgreSQL comerciales y17 de privacidad025
PASS; tipos/lint y revisión independiente PASS. ACKs sintéticos explícitos,
5 contenedores y65 volúmenes ajenos preservados exactamente. No montaje.

Límite de retención: sin el evento o intento operativo el helper rechaza. Esas
fuentes90d no sustituyen una prueba financiera5años;029 será un incremento
separado de recibos mínimos autenticados antes de purgar los originales.
