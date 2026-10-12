# ADR V7 — Captura y evaluación de comprobantes en workers

Decisión previa,12-oct-2026. Continúa023 con conexión canónica en los workers existentes; no modifica el montaje consolidado ni ejecuta proveedores.

La creación de un pedido de una conversación F4 captura su política023 dentro de la misma transacción, antes del primer UPDATE del pedido. Si existe journey F4 pero no política explícita/autoridad de perfil, la transacción falla sin crear un pedido incompleto. Los pedidos antiguos no reciben reglas actuales retroactivamente. Una base histórica sin tablas F4 continúa por el camino anterior; no se usa esa compatibilidad cuando el pedido ya declara un snapshot023.

El análisis nuevo sólo se activa por snapshot durable del pedido. Relee pedido/comprobante, journey/release y versión inmutable de cobro en el mismo perfil/entorno; compara hash de versión y precio/moneda. El destino y titular se descifran en RAM desde la configuración autenticada. La evidencia del modelo es un dato no confiable y cerrado; no puede declarar coincidencias, clasificación comercial, duplicados ni autorización. Los campos enriquecidos faltantes siguen siendo desconocidos, nunca se completan inventando información.

La evaluación usa reloj PostgreSQL para REAL y sólo reloj de simulación autenticado para SIMULATION, conserva hashes y versiones de sus fuentes, y produce códigos sin datos bancarios. La extracción enriquecida se cifra antes de conservarla; la proyección histórica mínima sigue disponible al ledger existente. TEST/FALSE, revisión humana ya emitida o pendiente y evidencia duplicada no originan reconocimiento comercial automático. La reserva de evidencia y las contribuciones siguen usando los locks y gates canónicos existentes. Una repetición idéntica del mismo análisis no produce otra transición; contenido distinto no puede reemplazarlo silenciosamente.

El resultado documental Aprobado puede entrar al reconocimiento ya existente, con separación explícita entre contribución, cancelación de cobro y propuesta de entrega. No representa confirmación bancaria ni permiso de envío. El camino histórico sin snapshot023 permanece separado y no recibe cambios de política silenciosos. RF19 usa su propio entorno aislado; la conexión nueva no concede lecturas REAL al motor del laboratorio.

La validación requerida incluye PostgreSQL con roles restringidos, creación/replay/rollback, cambio posterior de configuración, aislamiento, extracción ausente o inconclusa, duplicación, TEST/FALSE y no repetición de efectos. Los proveedores, el montaje y la operación productiva continúan pendientes.

El contrato de cobro actual no contiene un valor esperado específico por pedido
para referencia o concepto. PRESENT puede evaluarse; EXACT/CONTAINS permanecen
Por revisar mientras no exista una fuente canónica para ese valor. No se toma
el texto del modelo como valor esperado. El resultado conserva los campos
bankReconciled=false y effectsAuthorized=false incluso al reconocer una contribución.

Ensayo local:14 PostgreSQL con roles restringidos pasan después de corregir
únicamente el workflow incompleto de la fixture del primer intento (9PASS/5FAIL
preservado). Se ensaya captura antes de versión2, compatibilidad de extracción histórica,
revisión posterior de política, análisis completo/incompleto, duplicación de
imagen/referencia, TEST/FALSE, revisión humana pendiente, replay y rollback.
Los26archivos registrados permanecen exactos antes/después;5 contenedores ajenos
con StartedAt/RestartCount y65volúmenes conservados. Hay47pruebas puras de motor
más contrato de extracción. ExtracciónRF14/019 y montaje siguen separados.
