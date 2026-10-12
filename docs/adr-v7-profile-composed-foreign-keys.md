# Claves foráneas del catálogo V7 compuesto

Estado: preparación local; no autoriza una migración nativa.

El catálogo39 contiene 185 tablas y 323 claves foráneas. La clasificación de
filas no basta para clasificar relaciones: RF19 ejecuta en SIMULATION pero liga
sus presupuestos y snapshots a REAL. Cada una de sus cuatro relaciones públicas
usa su columna nativa `budget_environment` o `source_environment`, conservando
también el perfil. Las relaciones internas conservan sus claves de ejecución y
perfil sin inventar un entorno en las tablas que no lo tienen.

La propuesta completa deriva la lista de tablas de la clasificación revisada,
sin inferir autoridad de nombres de columnas. Exige una revisión explícita por
identidad y hash de metadatos para cada excepción. Un override sólo puede añadir
una dimensión de entorno a una relación ya compuesta; nunca quitar perfil ni
entorno, y no puede producir DDL por esa excepción. Todo override debe consumirse
exactamente una vez.

`manual_controls.environment` y `creative_pairings.workspace_id` conservan su
nulabilidad histórica explícita. Una columna de ámbito nullable sólo se acepta
si la relación ya contiene ese ámbito completo; nunca se añade a una FK para
producir una restricción que NULL pueda saltarse. No se inventa perfil para los
pairings retirados. Una nueva referencia a ellos requiere otra revisión.

Los únicos CASCADE que necesitan ampliar su clave son
`health_observation_index.record_id → records.id` y
`outbox_gate_schedule.effect_id → outbox.id`. Sus revisiones fijan la FK original,
su acción y su temporalidad. La nueva FK conserva CASCADE junto a la original;
no se admite SET NULL, SET DEFAULT ni una cascada no revisada. Las cascadas de
identidad y las relaciones que ya incluyen su perfil no se modifican.

La ejecución sigue separada del plan puro: inventario completo fresco, revisión
de SQL y datos, locks y revalidación de originales antes de añadir constraints.
Se conservan todas las FK originales y los datos. Un histórico cruzado aborta
la transacción completa; no se corrige, borra ni reasigna. Las pruebas locales
de composición no constituyen migración, montaje HTTP/worker ni aislamiento
nativo acreditado.

## Corte40: recibos comerciales029

El incremento029 agrega `commercial_resolution_receipts` como relación explícita
por perfil y entorno REAL, con dos referencias ya compuestas a records y una
referencia al perfil. La clasificación de filas y FK incorporará sólo esa tabla;
las seis revisiones especiales del catálogo39 conservan sus hashes. El nuevo
ensayo debe obtener otra lectura completa de roles/ACL/PK antes y después del DDL,
sin combinar los roles de un catálogo histórico con las claves de otro. Se
preservan las evidencias originales39 y sus conteos; el nuevo corte tendrá40
fuentes SQL y186 tablas.028 es un generador posterior ligado al catálogo, no una
migración SQL omitida de esas40.030 todavía no forma parte de este corte.

## Puerto de control del driver RF19

La siguiente composición incluye también `021_number_lab_driver_control.sql`: sólo
concede EXECUTE del lector cerrado de perfil al rol del control. No agrega tablas
ni claves, pero sí cambia ACL y requiere otra lectura del catálogo. El componente
`021_number_lab_driver.sql` permanece exclusivamente en la base secundaria del
motor; nunca se instala en la base comercial. Los catálogos40 siguen siendo
evidencia histórica del corte anterior y no acreditan este permiso posterior.

## Corte42: control RF19 y cercado de escritores030

El corte local siguiente incorpora el permiso explícito del driver y las dos tablas
privadas de autoridad030 (`privacy_writer_epochs` y `privacy_writer_leases`),
clasificadas por perfil, sin entorno comercial ni acceso directo a los roles de
aplicación. Se conservan sus políticas del owner cerrado. Las42 fuentes producirán
188 tablas y328 FK originales, con la misma propuesta de131 adicionales.

La instalación de SQL030 crea funciones y guards de perfil; los guards de todas
las tablas se generan después contra el catálogo real. Su compatibilidad con el
selector de perfil y los consumidores anteriores sigue siendo un gate separado,
no un permiso para excluir tablas o hacer pasar como completo el montaje.
