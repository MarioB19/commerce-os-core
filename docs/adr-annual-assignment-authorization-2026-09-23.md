# ADR · Vigencia comercial de asignaciones hasta fin de año

## Decisión

El dueño puede autorizar una asignación de producto por hasta 366 días, con fecha de vencimiento explícita y un máximo total de mensajes entre 1 y 10 000. Operadores y tokens de servicio conservan el límite de siete días. La autorización sigue ligada a la revisión comercial, identidad del canal, producto, versiones, destinatarios y permiso de automatización. Campañas y autorizaciones genéricas conservan sus límites actuales.

Al renovar una autorización de `new_inbound` para la misma asignación, revisión, identidad y configuración, la fecha desde la que se consideran nuevas las conversaciones se hereda de la autorización anterior. Así las conversaciones que comenzaron durante el permiso previo pueden continuar dentro de su ventana de atención. El nuevo permiso no cubre conversaciones anteriores a la primera autorización y no reenvía mensajes históricos o inciertos.

Una nueva autorización revoca la anterior en la misma transacción y deja un evento auditable. El límite de mensajes del nuevo permiso es total para ese permiso; al agotarse, el despacho se bloquea hasta una nueva decisión del dueño. La vigencia no garantiza salud de WAHA, consentimiento, ventana de conversación ni disponibilidad continua.

## Razón

La aprobación comercial explícita hasta el 31 de diciembre de 2026 no puede registrarse hoy: la API rechaza vencimientos mayores a siete días. Renovar con la regla actual cambiaría la fecha de inicio de `new_inbound` y dejaría fuera a clientes que entraron durante el permiso anterior. El cambio permite registrar la decisión con su alcance exacto y conservar esas conversaciones sin ampliar la base histórica.
