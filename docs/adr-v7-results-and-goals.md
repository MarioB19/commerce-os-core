# Resultados, metas y conservación de agregados V7

12-oct-2026. RF12, RF16 y D07/12/18. Se conserva el lector de gasto Meta y
reconocimiento de comprobantes; la nueva composición se autoriza por perfil.
Ningún cálculo publica campañas, modifica cobros ni llama proveedores.

El embudo es una cohorte de conversaciones iniciadas en el periodo del perfil:
inicio, respuesta confirmada, oferta/acuerdo observado, cobro enviado,
comprobante recibido y pago aprobado. Cada etapa registra su evidencia propia;
no se inventan etapas previas porque exista una venta. Los pagos y el gasto por
fecha de actividad se presentan separados de la conversión de esa cohorte.
El tiempo de respuesta usa la primera salida confirmada posterior al inbound;
el tiempo a venta usa la primera contribución reconocida. Se excluyen TEST,
SIMULATION y pagos duplicados o anulados del resultado comercial.

Los importes viajan como enteros decimales en unidades menores con moneda ISO.
La suma usa bigint; nunca se suman monedas. Los tokens y costos de IA conservan
proveedor, moneda, tarea y distinción operación/prueba. Falta de precio o
tokens no equivale a cero. ROAS y costos unitarios sólo existen cuando ambos
componentes tienen alcance, moneda, periodo y cobertura compatibles. Los cortes
no atribuibles a gasto Meta muestran el motivo en vez de prorratear arbitrariamente.

Metas por periodo civil, perfil y opcionalmente padre/variante: ingreso, ventas,
costo máximo por venta y ROAS. Mutaciones con versión esperada, recibo idempotente,
evento y autoridad vigente; la proyección temporal es una extrapolación visible,
no una predicción. No se proyecta un periodo futuro o sin tiempo observado.

La lectura compone proyecciones SQL acotadas por perfil/fecha y dimensiones
indexadas. Los agregados de retención conservan conteos, importes y sumas de
duraciones, sin texto, teléfonos ni datos de clientes. La eliminación de una
conversación debe confirmar su agregado antes de retirarla; una segunda pasada
no duplica sus métricas. Correcciones financieras permanecen auditables y se
reflejan en los agregados. No se declara retención instalada sin integrar y
ensayar ese recorrido con el worker.

API, cliente, MCP y UI comparten contratos. La validación debe cubrir scopes,
monedas, cero frente a ausencia, denominadores, DST, periodos previos, límites,
deduplicación, correcciones y pérdida de respuesta. Los datos sintéticos no
acreditan ventas ni gasto publicitario real.

## Corte de implementación de 017 (12-oct 06:56 UTC)

017 añade metas con recibos CAS y proyecciones SQL invoker/barrier acotadas.
La retención heredada sólo redacta campos de contenido y preserva filas,
identificadores y evidencia financiera. Su ensayo canónico demuestra que esta
redacción no altera resultados; **no satisface el borrado D-18**. El gate
PAY-RETENTION sigue abierto hasta 022: consolidación sin PII, borrado efectivo,
tombstones y reconstrucción con correcciones posteriores, sin recontar datos.
La combinación de 017 con el ledger real 019, la política global 020 y el
montaje de API/UI/MCP tampoco se infiere de fixtures sintéticos.

Los importes de Metas usan entrada en unidades monetarias y transporte en
unidades menores exactas. ROAS normaliza ceros decimales equivalentes antes
de firmar la operación, conservando comparación exacta contra el recibo.
Las ocho operaciones están disponibles en el cliente y el servidor MCP
preparados. La UI conserva una clave de operación en RAM durante una respuesta
incierta, permite consultar su recibo y sólo reenvía idéntico UUID y contenido
tras consulta explícita sin recibo. Un cambio de perfil descarta datos y
solicitudes tardías. Ninguna consulta ni meta modifica una campaña o un pago.
