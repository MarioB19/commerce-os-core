# ADR — Contrato comercial y evidencia de entrega

Fecha: 2026-09-07. Estado: aceptado para implementación local. Alcance: H2 del cierre operativo; operación REAL y evaluaciones externas conservan sus autorizaciones.

## Decisiones previas a implementación

1. `grado` e `interes` son las variables canónicas de respuesta. Las versiones publicadas que escriben `grade`/`interest` y sus condiciones siguen funcionando mediante alias de lectura/escritura; no se reescriben versiones históricas. Si una instantánea contiene ambos nombres, prevalece el canónico. El contexto enviado al vendedor sólo incluye nombres canónicos y valores sanitizados.
2. Una frase de compromiso se coteja únicamente contra el nodo que realmente espera respuesta. El runtime conserva `waiting_node_id`; para estados antiguos sólo se infiere un predecesor de compromiso inequívoco. Un «sí» aislado no basta en Preescolar. Los comandos humanos tampoco pueden saltarse las esperas anteriores del flujo.
3. La proyección de entrega preserva hechos: `SENT` significa aceptación del proveedor, `DELIVERED` un acuse de entrega y `READ` un acuse de lectura/reproducción. Un pedido alcanza cada estado sólo cuando todos sus materiales propuestos lo alcanzan. `UNKNOWN` exige resolución, y no dispara reenvío. La proyección se versiona para reparar pedidos antiguos mal agregados de forma idempotente sin tocar el outbox ni enviar nada.
4. El acceso al producto tiene evidencia separada de la notificación. Un acceso estático sólo prepara un código compartido: no demuestra apertura, descarga ni creación de usuario. Los nuevos accesos comienzan `access_verification_status: UNVERIFIED`; ningún ACK lo eleva automáticamente.
5. El comprobante aceptado sigue siendo la única verdad del ingreso (`receipt_sales_v1`). Se conserva revisión humana en la receta. Un aporte adicional nuevo puede liberar un beneficio cuyo umbral acaba de alcanzar, deduplicado por pedido/material/regla. Correcciones, restauraciones y backfill mantienen su contrato sin nuevas entregas automáticas.

6. La preparación local de conversiones exige la definición `receipt_sales_v1`, estado `RECOGNIZED` e importe positivo entero en unidades menores. La conciliación bancaria histórica no interviene; `TEST`, estados excluidos o importes incompletos no generan una conversión. Preparar conserva `remote_sent: false`.

## Validación y límites

Regresión local con PostgreSQL aislado y proveedores deterministas: alias antiguos/nuevos, compromiso activo, respuesta duplicada/tardía, takeover/opt-out, rechazo de conocimiento ajeno, acuses desordenados y umbrales de comprobante. Corpus y manifiesto local fijan contenido, MIME y hashes de tres MP3 y un Calendario PDF. Core/Kit se identifican como referencias protegidas; no se registran códigos ni hashes de secretos. La recepción/apertura humana, IA comercial externa y pruebas reales permanecen pendientes de su gate operativo.
