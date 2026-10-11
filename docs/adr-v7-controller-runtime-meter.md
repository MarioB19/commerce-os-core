# Admisión del consumo del controlador

11-oct-2026. Decisión adoptada antes de implementar; instalación pendiente.

El controlador reserva por CAS su tiempo máximo antes de ejecutar trabajo. El
estado vive en un objeto GCS distinto del ledger de builds. Un objeto ausente,
conflicto, escritura incierta o solicitud anterior sin cerrar bloquea efectos;
no inicializa ni reinicia el presupuesto desde HTTP. El arranque y cierre se
incluyen en la reserva. El Scheduler usa un POST vacío a `/tick`; Pub/Sub usa
`/events`, cuyo cuerpo acotado se lee y descarta bajo un plazo absoluto. Ambas
rutas dependen de IAM nativo. El trabajo procede del control protegido, nunca
del cuerpo o parámetros. Un evento malformado recibe ACK sin ejecutar trabajo
ni publicar éxito, evitando una ráfaga de reintentos.

Las reservas son conservadoras y no se devuelven por medir un proceso local.
Un cierre confirmado libera exclusión, pero conserva todo el importe reservado.
Si una llamada cruza mes, la reserva completa carga ambos meses, sin reiniciar
una operación viva. La conciliación de una ejecución incierta exige evidencia
externa; un timeout no autoriza repetirla.

Las cotas iniciales son 5,000 segundos vCPU, 10,000 GiB-segundos y 2,000
solicitudes por mes, con 1 vCPU y 2 GiB. No equivalen a un límite de factura de
Cloud Run: el proveedor también factura arranques, solicitudes rechazadas y
latencia fuera de la medición del proceso. Antes de habilitar el servicio se
requieren cotas verificadas para esos intervalos, IAM cerrado y reconciliación
nativa de consumo. Las operaciones GCS del propio medidor se deben incluir en
la proyección; la tabla anterior de 2,000 escrituras no cubre por sí sola tres
CAS por cada uno de 744 ticks. No se habilita nube alegando que `maxInstances=1`
impone un techo mensual. Los gastos de bootstrap y cualquier revisión económica
se admiten y registran por separado.
