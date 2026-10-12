# V7 — Recibos mínimos de resolución comercial

Decisión previa, 12-oct-2026;029 reservada por Root. El cierre comercial preparado
exige evidencia nativa de reconocimiento/conciliación y aceptación/entrega.
Los eventos e intentos operativos tienen retención90d, mientras el ledger
financiero tiene5años. Su ausencia no puede convertirse en aceptación ni bloquear
para siempre una obligación cuya resolución ya quedó autenticada.

029 captura recibos inmutables mínimos mediante un puerto SQL cerrado: perfil,
entorno REAL, pedido/conversación, clase e identidad de fuente, revisión, hashes
de términos/alcance y fuente, instante nativo de prueba y vencimiento. No guarda
comprobantes, texto, actor, dirección, teléfono, identificador de proveedor,
cifrados ni enlaces. La expiración se calcula cinco años desde la prueba nativa,
no desde la captura; repetir captura no renueva vida ni crea un reembolso.

La captura deriva hashes y datos directamente del ledger, comando/evento o
entrega/intent aceptado. No acepta hashes, fechas ni indicadores de autorización
del llamador. Repite perfil/entorno, conserva términos originales del pedido y
clasificación comercial, y se ejecuta antes de purgar las fuentes operativas.
El lector de fallback compara nuevamente términos, revisiones y fuentes vigentes
contra el recibo todavía válido. Cambiar importe, evidencia, clasificación,
asset, grant o estado confirmado invalida la prueba; no rescata body.status.

El propietario NOLOGIN/NOBYPASSRLS de custodia ya existe desde024/025; se añaden
sólo lecturas necesarias y los puertos exactos. La captura es para el actor de
resultados/retención; el worker de cierre sólo verifica. La selección del perfil
y sus GUC siguen obligatorios. Ambos puertos no emiten ni cierran por sí solos.

Pruebas previstas: captura nativa, fallback tras perder acceso al log, cinco años
exactos, no renovación, revisión/alcance cambiados, nuevo recibo sólo con nueva
prueba nativa, rollback, roles y ausencia de PII. Montar la captura antes de la
purga es un prerrequisito separado y explícito del protocolo D18.

Contrato preparado: `capture_commercial_resolution(order, kind, source)` sólo
acepta IDs/clase PAYMENT, RECONCILIATION o DELIVERY, en REPEATABLE READ y bajo el
mutex canónico de conversación. `verify_commercial_resolution` es booleano y
no consulta commands/domain_events/effect_attempts. El derivador interno carece
de EXECUTE público. La tabla no tiene puertos de UPDATE/DELETE ni ACL runtime.
La clasificación RLS global y el montaje del capturador se adoptan por separado.

`terms_hash` liga importe/moneda/oferta a la versión1; `authority_hash` liga
perfil/REAL/conversación/pedido/clasificación y compromiso. No representa ni
sustituye la autoridad humana del nuevo comando de cierre. `source_hash` cubre
las fuentes financieras vigentes o los efectos/materiales/grants confirmados.
Los hashes se derivan con reloj y serialización temporal UTC. La evolución
DELIVERED→READ conserva el hecho confirmado; proveedor, grant, acceso o términos
distintos requieren prueba nueva. La expiración toma el primer evento coincidente
y, para entrega con grant, la aceptación más antigua de ambos; ninguna captura
posterior renueva la vida. Un grant no suple una entrega sin intento aceptado.

El helper consulta029 primero cuando existe. Sólo la prueba exacta y vigente evita
la lectura del log; ausencia, alteración o vencimiento vuelve al chequeo nativo
previo y, sin evidencia accesible, rechaza. Las validaciones actuales de estado,
importe total, todos los pedidos, efectos inciertos y comando humano permanecen.

Cierre local:29 unitarias y53 PostgreSQL (18 custodia,18 cierre comercial,17
privacidad025), tipos/lint y peer independiente PASS. El recibo conserva
los intentos previos; la regresión final rechaza la fecha futura de cualquiera
de las dos aceptaciones antes de tomar su mínimo. También prueba el bloqueo
de la evidencia de conciliación hasta COMMIT cuando se utiliza el fallback.
No representa montaje, borrado de producción ni aceptación de un proveedor real.
