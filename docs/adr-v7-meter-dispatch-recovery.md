# ADR V7 — Conciliar el medidor de DISPATCH sin conciliar CI

Fecha: 11-oct-2026. Módulo puro; ningún efecto ni autorización HTTP nueva.

El DISPATCH dejó una solicitud de controlador reservada y un intento FULL en
UNKNOWN. Un Build nativo sí existe. La existencia del Build no acredita éxito,
ni permite repetir CREATE, cancelar el Build o liberar los 95 minutos de CI.

`cloudbuild_dispatch_recovery` autentica los originales del incidente fijo:
solicitud HTTP terminada, control pausado, ledger UNKNOWN con submit intent,
servicio e IAM sin cambios y Build único ligado a fuente/configuración/intento.
La prueba dura como máximo 120 segundos y exige que hayan transcurrido los
450 segundos reservados más 30 de margen. Un JSON de forma válida no sustituye
la autenticación de los originales por el adaptador protegido.

`cloudbuild_meter_dispatch_recovery.propose_recovery` recibe esa prueba y los
bytes originales de ledger y medidor con sus generaciones. Revalida el límite
operativo de 420 minutos, el plan FULL de 5700 segundos y el hash íntegro del
submit intent. Ledger, incertidumbre, fuente, nonce, historial y reserva quedan
intactos. El módulo no produce una versión nueva del ledger ni liga el UUID.

La propuesta del medidor modifica únicamente la fila activa de RESERVED a
COMPLETED, su hash de resultado y `active_request`. Conserva los 450 segundos
completos, todas las filas anteriores, sus meses y todo uso de CPU, memoria y
peticiones. Su recibo acredita la conciliación del medidor, nunca éxito del
Build, reembolso o permiso de repetir DISPATCH. El hash del documento destino
usa exactamente la codificación GCS, incluido el salto de línea final.

Root deberá releer los originales y generaciones bajo la admisión vigente,
revalidar la prueba después del intent durable y enviar una sola CAS contra la
generación prevista. Un resultado incierto permite sólo GET y comparación de
los bytes exactos. Después, una tarea canónica RECONCILE_FULL separada podrá
ligar el Build existente y observarlo. Este módulo no la ejecuta ni autoriza
una nueva operación CREATE.
