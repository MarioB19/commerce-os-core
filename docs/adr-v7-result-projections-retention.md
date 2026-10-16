# ADR V7 — Proyecciones anónimas y retención D-18

12-oct-2026. Diseño adoptado antes de implementar022. Gate de borrado todavía abierto.
No autoriza eliminar un perfil ni purgar datos antes de los plazos y respaldos.

La transición017 calcula resultados actuales desde evidencia comercial conservada.
La redacción heredada preserva esas métricas, pero depende de las conversaciones.
022 introduce una proyección diaria persistente que contiene únicamente fecha,
moneda, zona del mercado fijada en el recorrido, dimensiones comerciales y
contadores/sumas enteras. No contiene texto, teléfonos, contactos, conversaciones,
pedidos, comprobantes, prompts ni identidad de clientes. Las dimensiones de
producto/variante/número son referencias a configuración empresarial validada.

Un puerto interno por perfil reemplaza contribuciones versionadas de fuentes
COHORT, FINANCIAL y AI. Calcula deltas enteros sobre todos los granos afectados
en una transacción, bajo rol de proyección dedicado, con locks en orden fijo.
Un replay idéntico no produce efecto. Una revisión antigua o una revisión igual
con otro contenido se rechaza. Los montajes HTTP/MCP no exponen este escritor.
El lector sólo presenta una generación con watermark confirmado; una cola o
fallo pendiente no se transforma en datos actuales ni cero.

Los datos de trabajo de fuentes vivas quedan separados de los agregados. Antes
de purgar una conversación cerrada180d se verifica ausencia de trabajo pendiente,
obligaciones/retención legal y permisos; se consolida su contribución y se sella
un lote. Los tombstones de deduplicación usan hashes de IDs aleatorios ligados
al perfil. El agregado no incluye esos hashes. La purga elimina contenido y
vínculos identificables de la conversación, versiones, mensajes y derivados;
los tombstones técnicos imprescindibles para FK no forman una conversación
consultable ni permiten reconstruir su contenido. Replay y restore consultan
los tombstones para no reintroducir datos borrados ni sumar de nuevo la cohorte.

El ledger financiero conserva su política separada de5años. Sus hechos incluyen
un snapshot no PII de dimensiones/fecha de cohorte para que correcciones de
comprobantes y parcialidades se proyecten después del borrado del chat. El
aporte financiero al embudo (comprobante/pago/latencia a venta) se calcula desde
esa evidencia financiera; no queda congelado si un comprobante cambia a FALSE.
La IA conserva sólo uso/coste medido y contexto comercial sin prompts. Sus
reservas no son coste y una liquidación incierta mantiene falta de cobertura.

El rebuild combina los lotes sellados con fuentes activas y revisiones del
ledger financiero/IA, y se verifica contra la generación vigente antes de un
swap atómico. El re-borrado después de restore usa la misma versión de política
y tombstones. No se presume borrado inmediato de backups inmutables.

La validación exigida incluye concurrencia, replay, correcciones posteriores,
fallo antes/después de COMMIT, rollback si cambia autoridad o fuente, cero PII
en agregados, ausencia efectiva de contenido tras purga y métricas idénticas
antes/después. Tiempo de consulta/costo/volumen se miden en LOAD20. Guardar este
ADR o preparar022 no acredita su montaje ni cierre de PAY-RETENTION.

El colector usa una sola transacción REPEATABLE READ para fuentes, reconciliación
y watermark; el lector captura marcador y agregados con una única sentencia.
La zona se toma del snapshot de mercado; cortes mixtos no fabrican CPA/ROAS Meta.
El coste operativo019 sin jornada elegible se conserva en un grano anónimo
ai_unattributed (USD/UTC, familia y variante conocidas). Se muestra aparte del
embudo y las razones comerciales, independiente de moneda de venta; sus cortes
sólo incluyen dimensiones conocidas. Una reclasificación TEST comercial mueve
el coste operativo a esa sección, sin borrar gasto medido ni incluir pruebas
de credenciales/laboratorio. La forma no permite teléfonos ni IDs de clientes.

026 implementa la reconstrucción derivada en una transacción REPEATABLE READ,
con el mismo lock de perfil. La vista previa fija generación y hash de la suma
canónica de sellos y fuentes activas. Una fuente o generación cambiada aborta
antes del reemplazo. Los lectores ven el conjunto completo anterior hasta el
COMMIT; el ledger de fuentes y sellos nunca se borra ni se vuelve a contar.
Un recibo privado por UUID permite resolver una respuesta perdida sin repetir
el reemplazo. La reconstrucción conserva el watermark y el instante de última
cobertura: si el colector estaba PENDING continúa PENDING, aunque las filas
derivadas ya estén reparadas. Sólo el colector puede acreditar cobertura nueva.
Este puerto interno no concede acceso API/MCP a los escritores ni prueba por
sí mismo la ejecución periódica, rendimiento LOAD20 o borrado de conversaciones.

027 conserva frecuencias exactas de duración en milisegundos, separadas para
primera respuesta y primera venta, dentro del mismo grano anónimo. Cada fuente
comercial aporta como máximo una observación de cada clase; no se infiere una
distribución a partir de un promedio. Deltas, sellado, rollback y reconstrucción
incluyen esas frecuencias. p50/p95 usan rango más próximo superior
(`ceil(n*p/100)`), con enteros exactos y sin promediar percentiles parciales.
El lector combina frecuencias por el mismo corte y calendario del resto del
reporte. Si falta distribución histórica para alguna muestra, informa cobertura
incompleta; ausencia de muestras no significa latencia cero. Los histogramas
no contienen identificadores de clientes ni instantes absolutos. El volumen y
tiempo de consulta permanecen sujetos a LOAD20. Las series día/semana/mes ya
implementadas presentan los mismos percentiles por periodo y comparación.
