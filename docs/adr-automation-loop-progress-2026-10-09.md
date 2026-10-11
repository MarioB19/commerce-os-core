# Progreso comprobable de los ciclos de automation

Fecha: 2026-10-09. Estado: aceptado para la corrección operativa.

La observación de la versión 7af948a3 encontró que `/readyz` de automation sólo
acredita inbound. Los once ciclos auxiliares atrapan errores sin publicar su
estado; `operations_monitor` fallaba por `WRITE_OWNER_AUTOMATION` mientras el
servicio declaraba disponibilidad. La migración 0068 corrige ese permiso, pero
no hace observables los demás ciclos.

Se registra un inventario cerrado de doce ciclos: inbound y los once auxiliares
existentes. Cada ejecución conserva intentos, éxitos, fallos acumulados, fallos
consecutivos, inicio, último éxito, último fallo y ejecución en curso. Un fallo
bloquea inmediatamente; sólo un éxito posterior recupera el ciclo. Un trabajo
atascado no se solapa ni se reinicia para simular progreso. Una iteración sin
trabajo cuenta como iteración correcta, nunca como un envío o efecto de negocio.

Los ciclos arrancan inmediatamente. Readiness permanece `STARTING` hasta el
primer éxito de todos; el plazo de 180 segundos tolera el intervalo máximo de
60 segundos y no acredita progreso antes de observarlo. El contrato `/readyz`
combina base de datos, progreso de todos los ciclos y publicación del heartbeat.
El heartbeat independiente conserva el snapshot durable cada 15 segundos, con
identidad nueva por proceso y caducidad de 45 segundos. Fallar su publicación
bloquea readiness hasta una publicación correcta; un lector posterior también
rechaza evidencia caducada, incompleta o incoherente.

Se extiende `workerService` con hooks opcionales para el snapshot, las métricas
y el heartbeat. Se conserva el comportamiento de los consumidores sin hooks y
no se modifica el monitor ni las guardas de channel. El API de readiness valida
el contrato nuevo de automation; un heartbeat legado no prueba esos doce ciclos.
No se cambian workflows, permisos comerciales, proveedores ni configuración
REAL. Las pruebas cubren fallos, recuperación, concurrencia, falta de progreso,
inventario cerrado, heartbeat y un bundle real con el rol de automation.
