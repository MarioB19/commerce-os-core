# Clasificación del laboratorio de números · 09-oct-2026

Estado: corrección preparada; instalación y ensayo del laboratorio existente pendientes.

El laboratorio `NUMBER_FLOW_TEST_V1` guarda sus ofertas en `assignments[]`. El
clasificador anterior sólo conocía `simulation.offer_version_id`, por lo que
creaba órdenes sin TEST. La lectura del laboratorio existente encontró una
orden OFFERED sin recibos y sin clasificación. No se reinicia ni se sustituye.

Se reutiliza la validación persistida del simulador aislado (cuenta, contacto,
conversación, simulación y evento inmutable de creación) y se exige además la
asignación/oferta/producto/workflow exactos del snapshot. Las órdenes nuevas
quedan TEST desde su creación. Al avanzar canónicamente, una conversación y su
orden legadas sin clasificación se reconcilian con escritura versionada y evento,
conservando sus IDs, historial y cursor. Si existen recibos, contribuciones o
evidencia de venta antes de clasificar la orden, se rechaza la reconciliación.
Una decisión comercial explícita tampoco se sobrescribe. No hay migración de
datos ni SQL operacional manual, ni cambios a los scopes REAL existentes.

Los beneficios y el cierre TEST usan únicamente aportaciones de recibos aprobados
ligados al mismo grafo y a sus assets sintéticos de laboratorio. TEST se deriva de
la orden mediante `receipt_sale_facts`; no se introduce una etiqueta de recibo
aceptada del cliente. Venta, importe e ingresos analíticos permanecen en cero.
El total separado de ensayo permite verificar regalos y entrega. Los estados de
transporte siguen siendo necesarios para cerrar el flujo; un importe simulado
no sustituye sus acuses. La rama comercial REAL conserva sus condiciones.

La prueba recorre creación nueva y continuación legada, cobro TEST, beneficios y
cierre; conserva evidencia anterior y verifica cero cambios REAL. Casos negativos
rechazan marcadores falsificados, vínculos distintos y legado con evidencia
financiera. Estas pruebas sintéticas no acreditan un envío, pago o entrega real.
