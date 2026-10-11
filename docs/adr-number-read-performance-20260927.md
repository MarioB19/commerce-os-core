# Lecturas acotadas de salud y capacidad · 27-sep-2026

El runtime publicado `ab6ff867ad4076ac6d21ae47233b513bab3017a3` conserva consultas de capacidad que necesitan observar cuentas de todos los workspaces para evitar dos reservas del mismo gateway físico. El EXPLAIN productivo, sin ejecutar la consulta, usa un índice cuyo primer campo es workspace sin limitar ese campo: recorre un índice grande de records para hallar unas pocas cuentas. La tabla tiene aproximadamente 1.98 millones de filas y 833 MB de heap. Tres lecturas permanecieron activas esperando I/O y agotaron conexiones disponibles; el timeout HTTP no cancelaba PostgreSQL.

Además, la lectura del webhook de recepción busca el último health_signal cuyo value.kind es webhook. La proyección 0063 no tiene ese atributo, y su índice anterior tampoco permite buscar directamente ese subconjunto y orden. Un webhook ausente o antiguo puede obligar a recorrer el historial completo.

Se añadieron dos índices parciales mediante una nueva migración 0064: uno para todas las cuentas, sin restringir workspace, ambiente, proveedor ni borrados; otro para las observaciones webhook, por workspace, ambiente, cuenta y orden de creación. Se conservan todas las condiciones y el alcance global de las consultas. El índice general de cuentas también ayuda a la comprobación de aislamiento del proveedor y al heartbeat de workers. La migración 0063 aplicada permanece inmutable.

Las rutas de lectura de salud, capacidad, conciliación y preview reciben el presupuesto canónico de lectura con cancelación del lado PostgreSQL y devolución de la conexión. Un plazo vencido indicará indisponibilidad; nunca salud correcta ni capacidad libre. Las escrituras administrativas mantienen sus permisos, transacciones y bloqueo global de reservas.

La validación comprobará equivalencia de resultados, aislamiento entre workspaces, ausencia de webhook, planes antes/después con historial sintético de escala comparable y recuperación del pool tras un timeout. Construir índices también lee el historial y puede bloquear escrituras hasta el commit; su aplicación corresponde al instalador controlado, con hold, trazabilidad y readback. Los tiempos del benchmark local no se presentarán como latencia o plazo de migración productivos.

[Validación local y límites del benchmark](evidence/number-read-performance-20260927/README.md): 33 pruebas específicas, 535 unitarias y tipos/lint/build aprobados; resultados iguales sobre 500 mil señales sintéticas. La latencia del endpoint completo se verificará después de publicar.
