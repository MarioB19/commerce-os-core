# Métricas del monitor con su rol de ejecución · 09-oct-2026

Estado: corrección preparada; publicación y comprobación productiva pendientes.

## Evidencia y problema

El runtime `7af948a3` completó la transición nativa a `OPERATING`. El channel
mostró avance individual en sus catorce ciclos. Automation mantuvo su tick
inbound y procesó comandos y resultados SIMULATION, pero `operations_monitor`
falló repetidamente. Su HTTP de readiness no representa los once ciclos
auxiliares y, por tanto, no acredita el monitor.

La lectura nativa encontró `WRITE_OWNER_AUTOMATION` en PostgreSQL y ninguna
métrica `private_storage_disk`. `collectOperationalAlerts()` escribe un record
`operational_metric`; la última definición de `enforce_record_writer()`
(migración 0048) no admite ese kind para `commerce_automation`. Las pruebas
previas del monitor usaban la conexión de migración, que no ejerce esa frontera.

## Decisión

Añadir la migración **0068_operational_metric_writer.sql**. Reemplaza la función
por la definición vigente y añade exclusivamente `operational_metric` al conjunto
de kinds que puede insertar/actualizar automation. Conserva la detección del rol
heredado, el control especial de assets y las listas API/channel. No añade
privilegios de tabla, no altera migraciones aplicadas ni modifica datos,
configuración comercial, permisos de API o límites de proveedores.

Probar el monitor completo en una base nueva con el rol real
`commerce_automation`: dos recolecciones deben conservar el mismo ID y avanzar
versión/timestamp de la métrica, con alertas durables y sin entrega externa.
Probar INSERT/UPDATE autorizados, rechazo por API/channel/ingress/maintenance,
rechazo de kinds ajenos por automation y conservación de controles de assets.
Incluir un login que hereda automation y mantiene `role=none`, como el runtime.

La publicación correctiva pertenece al controlador existente `copy-runtime`.
Su rama `OPERATING` ya dispone de hold, parada de workers, comprobación de
operaciones en vuelo, activación, continuidad de ownership y CAS Root/B02.
El nuevo paquete y su aprobación deben ligar explícitamente el historial 67
vigente y sólo la adición 0068, aplicarla con workers parados y verificar los 68
hashes antes de activar. Se conservan aparte los contratos iniciales 65→67 y la
continuación `CORE_PREPARED`. No se autoriza SQL manual ni cambiar un hash aplicado.

## Comprobación tras publicar

Dos muestras del monitor deben mostrar una métrica duradera nueva y posterior
avance de versión/fecha, con el mismo contenedor y sin reinicios; el ciclo no debe
emitir nuevos `WRITE_OWNER_AUTOMATION`. La evidencia de inbound o del channel no
sustituye esta comprobación. Las alertas creadas no acreditan entrega/recepción de
notificaciones, y el arreglo no acredita los otros ciclos auxiliares inactivos.
