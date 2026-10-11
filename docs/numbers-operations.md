# Operar números y calentamientos

Publicado y verificado `2a6e4fbd777ac2ee0c8a1e895ba2c42497ea2517`, [PR #2](https://github.com/MarioB19/commerce-os/pull/2), el 19-sep a las 23:21 México (20-sep 05:21 UTC). Mis números/Calentamientos, política 4+10 días, grupos y capacidad incremental están en producción. [Recibo completo](evidence/numbers-publication.json). MCP firmado instalado con 104 herramientas para la siguiente conexión; recarga y aceptación completa desde Codex pendientes. Capacidad funcional SIMULATION20 y tres gateways físicos conservados; ampliar REAL requiere medición y administrador acotado autorizado. [Contratos y catálogo](contracts/numbers-catalogue.md) · [Evidencia y límites](numbers-delivery.md) · [Release y piloto](numbers-release.md).

## Uso desde la web

El alta diferencia una orden en cola de un servicio con ejecución reciente. Si hay una orden pendiente y el heartbeat del servicio está ausente, vencido o bloqueado, Conectar muestra el bloqueo y permite «Cancelar orden sin iniciar» cuando su resultado sigue vacío. La cancelación conserva la cuenta y el historial, pausa la intención de ciclo de vida y registra NOT_ATTEMPTED; no borra sesiones ni cambia credenciales. Si la orden ya empezó, se rechaza la cancelación y se debe releer su resultado. UNKNOWN requiere conciliación y nunca se cancela como si no hubiera ocurrido. [Decisión](adr-pending-channel-cancellation.md).

Por API/MCP, releer `number_setup_get` y usar `number_setup_command` con `action: cancel_pending`, el `command_id` incluido en `CONNECT.evidence.cancellable_command_ids`, revisiones vigentes de cuenta/sesión, motivo e idempotencia. El resultado 200 `CANCELLED_BEFORE_EXECUTION` acredita cancelación local completada. Las solicitudes 202 de conexión siguen siendo órdenes durables; requieren el servicio y gateway disponibles para producir un resultado físico.

En Ventas → Mis números se ven alias, teléfono enmascarado, conexión, preparación, productos y siguiente acción. Buscar o filtrar no enrola teléfonos ni modifica permisos. El detalle lateral reúne identidad, checklist, historia y disponibilidad de cada producto. «Disponible en 1 de 2 productos» significa que sólo una relación cumple todos sus controles.

Agregar número pide alias, responsable y referencia del dispositivo principal. Reserva una plaza y muestra el trabajo de preparación. `REQUESTED` o `202` no significan gateway preparado. La integración debe quedar comprobada antes de preparar la vinculación. La persona escanea el QR mediante acceso autenticado de 90 segundos; después se relee la identidad y confirma propiedad. No escribir teléfonos, identidades técnicas, puertos o secretos en el recorrido normal. Conservar el teléfono principal y no compartirlo entre nuevas altas; una recuperación legítima usa el flujo de continuidad existente.

Para nuevas altas, la preparación empieza automáticamente al activar un programa `standard-15d/v2`. No pide checklist ni declaraciones manuales: acredita como máximo un día por fecha local y sólo cuando un plan del pipeline termina con evidencia de conversaciones y entregas. Los episodios históricos `standard-15d/v1` conservan sus declaraciones para auditoría; no se convierten en crédito automático. No hay listas de difusión ni actividad REAL sin autorización explícita.

En Calentamientos, el asistente guarda tres pasos: grupo/números, programa/contenido/horario, revisión. Seleccionar un grupo existente y todos sus miembros propios, incluso los que no hablarán. La creación del grupo y sus invitaciones ocurren en WhatsApp por la persona. El sistema exige observación completa de todos los participantes, identidad verificable, permisos y exclusividad. Terceros, LID sin resolver, membresía cambiada o evidencia vencida detienen nuevos despachos.

La biblioteca inicial crea borradores editables de conversaciones legítimas de prueba. Revisar y aprobar una versión antes de seleccionarla. Texto, imagen, audio y PDF usan materiales propios ya registrados; no pegar enlaces privados ni secretos. Editar conserva las versiones aprobadas anteriores. Se reserva el guion al planificar y se consume al iniciar el envío; se puede reutilizar una vez por fecha local y después de 24 horas. UNKNOWN mantiene la reserva.

Revisar muestra cobertura, turnos, cuotas, vencimiento e impacto sobre todas las relaciones comerciales. Autorizar guarda ese alcance concreto. Activar es otra acción explícita. Un cambio de miembros, contenido o configuración invalida la revisión. Una autorización vencida no se renueva sola. Pausar conserva progreso; reanudar valida otra vez. Cancelar no borra historia y se rechaza si queda trabajo incierto por conciliar. Restaurar un archivo deja un borrador.

## Cómo se decide que está listo

«Listo para calentar» requiere episodio v2, conexión, identidad, grupo/contenido propios y autorización vigente. «Preparación completada» requiere la política `standard-15d/v2`: catorce días automáticos acreditados, evaluación desde el día nominal 15, siete días estables dentro de ese recorrido, veinte efectos propios maduros y entrega de al menos 98 %. La maduración es de 30 minutos por defecto. Cada envío de grupo cuenta una vez; sus recepciones se comprueban por destinatario sin multiplicar muestras. ACK global y eco propio no acreditan a todos. La política v1 de cuatro días manuales más diez automáticos permanece legible y ejecutable sólo para episodios históricos.

Las cuotas combinan envíos y recepciones confirmadas por número: 5–15 participaciones en los días automáticos 1–7, 20–40 en 8–10 y 60–120 en 11–14. Así los cuatro días nuevos usan la fase más conservadora y no adelantan volumen de la curva histórica. El factor de fin de semana es 0.5 con redondeo hacia abajo y mínimo ajustado. El preflight reparte los turnos y puede rechazar grupos grandes cuya participación activa no cabe. Veinte cuentas de capacidad no implican que un solo grupo de veinte sea factible con la primera cuota.

Una pausa, día parcial, falta de muestras o desconexión explica el retraso y desplaza la estimación; nunca aumenta volumen para recuperarlo. No existe un requisito estándar de treinta días ni siete días adicionales después del día 15. El modo especializado inbound-light y episodios legados se identifican aparte. Migrar exige vista previa, pool pausado y revisión estable: conserva hasta catorce fechas distintas respaldadas por planes automáticos `COMPLETED`, excluye declaraciones manuales y no gradúa por antigüedad. Cada plan sólo puede respaldar un crédito inmutable; la curva antigua no puede sobrescribir un episodio migrado.

«Listo para vender» añade salud vigente, identidad, ownership, permisos y preparación del producto concreto. El cálculo no concede autorización. FAILED se muestra como problema de conexión, nunca como bloqueo confirmado de WhatsApp. Completar preparación tampoco inicia mantenimiento: éste es un programa opcional, autorizado aparte, con vigencia propia y prioridad inferior a las ventas.

## Operar desde Codex

Usar una conexión autorizada al MCP de Commerce. No ampliar scopes ante un 403. Los servicios usan `channels:read/manage/capacity`, `warmup:read/manage/activate/simulate` según acción; el administrador del host usa `channels:capacity:agent` y permisos separados de integraciones. Tokens de servicio siguen limitados por workspace, entorno, recursos y caducidad. El PAT personal conserva el rol vigente del usuario. Ningún release amplía permisos automáticamente.

Cada mutación lleva una clave de idempotencia estable para esa intención. Tras timeout, consultar el recurso y `operation_id`; repetir exactamente la intención con la misma clave sólo recupera su resultado. Conservar la versión devuelta. Ante 409, releer y revisar el cambio, sin incrementar versiones a ciegas. Un lote admite veinte elementos, claves únicas y resultados individuales; continuar páginas mediante `meta.next_offset`. Un alias ambiguo exige resolver la selección antes de operar.

Prompts copiables que sólo preparan o consultan:

> En Commerce, muestra qué números requieren atención en REAL. Usa `numbers_list`, sigue la paginación y lee `number_get` para explicar estado, motivo, productos y siguiente acción. No ejecutes comandos de sesión.

> Prepara el alta de dos números con estos alias, responsables y dispositivos: [datos propios]. Revisa capacidad, usa `number_create` con claves estables y sigue cada `number_operation_get`. Deja pendiente el escaneo humano; no conectes ni habilites envíos sin su alcance concreto.

> Deja un calentamiento en borrador para el grupo propio [alias] con todos sus integrantes. Consulta y, si está autorizado, actualiza su observación. Selecciona versiones de contenido que yo haya aprobado, horario 09:00–18:00 America/Mexico_City y vencimiento concreto. Guarda con `number_program_create`, calcula `number_program_preview` y presenta cobertura e impacto. No autorices ni actives.

> Pausa el calentamiento [alias]. Resuelve el programa sin ambigüedad, lee la versión actual y usa `number_program_command` con action pause, motivo y clave estable. Relee hasta confirmar PAUSED y muestra si hay efectos UNKNOWN que requieren conciliación.

> Prepara una ampliación a veinte plazas y muestra el impacto. Usa `number_capacity_get` y `number_capacity_command` con action preview y count 20. Separa capacidad instalada, reservada, conectada, sintética y física; conserva los recursos existentes. No apliques ampliación ni compres infraestructura.

Ejemplo estructurado de lectura y preparación SIMULATION, para un workspace de laboratorio autorizado:

```json
{"tool":"numbers_list","arguments":{"environment":"SIMULATION","q":"Equipo","limit":20,"offset":0}}
{"tool":"number_create","arguments":{"environment":"SIMULATION","idempotency_key":"alta-equipo-norte-v1","body":{"alias":"Equipo Norte","responsible":"Operador propio","device_ref":"Teléfono principal Norte"}}}
```

El resultado de alta contiene el ID y operation_id que se reutilizan, nunca se inventan. `number_operation_get` comprueba SUCCEEDED, FAILED, UNKNOWN o intervención humana. `number_operation_command` con `resume_read` sólo retoma lecturas durables de identidad/grupos, conservando cursor. Aprovisionamiento UNKNOWN se concilia con inventario del administrador; no se vuelve a enviar como otro job. Un segundo cliente puede recuperar la operación persistida con los mismos permisos.

Para una activación autorizada, `number_program_command` ejecuta `review` → `authorize` con la revisión devuelta y `AUTHORIZE_REVIEWED_PROGRAM` → `activate` con la revisión vigente y `ACTIVATE_REVIEWED_PROGRAM`. Cada paso relee versión y estado. No se requiere clic web adicional. El permiso del usuario debe referirse al programa, miembros, contenido, topes y vencimiento mostrados. El calendario se ejecuta en los workers aunque Codex esté cerrado.

Las herramientas existentes `channel_session_get/configure/recovery`, `channel_command`, `command_get`, `assignments_list/apply`, `assignment_transition`, `assignment_authorize` y `channel_health` siguen siendo las únicas vías de continuidad y relaciones comerciales. Preparación, venta y mantenimiento no comparten autorizaciones.

Retirar usa `number_retire` sobre el DELETE canónico, con versión vigente, motivo, clave estable y `DELETE_CHANNEL_ACCOUNT`. Requiere estado NEW/DISCONNECTED/STOPPED y ausencia de comandos pendientes o efectos SENDING/UNKNOWN; WAHA exige desvinculación observada. Conserva historia, congela controles y revoca permisos. No desconecta ni libera el slot implícitamente: el drenaje/capacidad se revisa por separado. No repetir un resultado incierto como una nueva intención.

## Capacidad y administración del host

`NUMBER_CAPACITY_LIMIT` configura 1–20 plazas. Una cuenta reserva una plaza propia; una operación concurrente no puede ocuparla de nuevo, incluso desde otro workspace REAL del mismo host. Hay un gateway por número en esta entrega. Los workers atienden varias cuentas y mantienen límites distribuidos; aumentar plazas no mueve sesiones ni aumenta automáticamente concurrencia.

El panel muestra inventario de slots, sesión, gateway, owner/generación/lease, host, colas, jobs y pool API. Las mediciones físicas tienen vigencia. Antes de ampliar REAL, el administrador acotado recoge CPU, memoria disponible, disco, memoria de gateways, sesiones e inventario de red/volúmenes; la revisión incluye los datos y diff exactos. Requiere 25 % de margen RAM y 30 % CPU. La estimación usa consumo medido por gateway con un suelo conservador; no convierte veinte límites de 768 MiB en una necesidad demostrada de 15 GiB.

El componente de host es `scripts/number-capacity-administrator.py`. Su archivo privado JSON contiene `api_origin`, `token_file`, `release_env`, `gateway_dir` y `overlay`; archivos/credenciales privados 0600 y directorio 0700, fuera del repositorio. No instalarlo ni emitir credenciales productivas sin autorización. Comandos allowlist una vez instalado:

```sh
python3 scripts/number-capacity-administrator.py /ruta/privada/capacity.json measure
python3 scripts/number-capacity-administrator.py /ruta/privada/capacity.json apply OPERATION_ID
python3 scripts/number-capacity-administrator.py /ruta/privada/capacity.json reconcile OPERATION_ID
```

`apply` reclama la operación canónica, extiende el overlay existente bajo lock/CAS, prepara sólo los slots solicitados y comprueba recursos/estado por lectura posterior. Preserva contenedores existentes, sesiones, credenciales, redes y volúmenes. La API no ejecuta shell ni monta Docker socket. `reconcile` relee el mismo resultado incierto; no genera secretos ni recrea contenedores. Un administrador sustituto autorizado puede conciliar UNKNOWN, sin robar PREPARING ajeno. Preparar no abre QR ni inicia sesiones.

Drenar impide nueva admisión; exige resolver SENDING/UNKNOWN y demostrar aislamiento del propietario anterior antes de transferir. Lease vencido no acredita aislamiento. Conservar el recibo del instalador y reanudar explícitamente después de transferir. No borrar volúmenes ni copiar una sesión activa a otro host.

## Reproducir las pruebas locales

Usar Node 24 y pnpm 10 del proyecto, una configuración privada y PostgreSQL aislados. El ejecutor crea otra base temporal por integración o ensayo. No reutilizar la base productiva ni la de otra tarea.

```sh
COMMERCE_CONFIG_DIR=/ruta/privada/pruebas pnpm test:integration
COMMERCE_CONFIG_DIR=/ruta/privada/pruebas pnpm test:e2e
COMMERCE_CONFIG_DIR=/ruta/privada/pruebas pnpm test:recovery
PG_CONTAINER_NAME=commerce-numbers-soak-postgres-FECHA COMMERCE_CONFIG_DIR=/ruta/privada/carga NUMBERS_SOAK_SECONDS=7200 NUMBERS_SOAK_INTERVAL_MS=12000 caffeinate -i node scripts/run-numbers-soak.mjs
# Al terminar, usar exactamente el informe anunciado por el ejecutor:
node scripts/assess-numbers-soak.mjs docs/evidence/numbers-soak-FECHA.json
```

`PG_CONTAINER_NAME` identifica exclusivamente el contenedor aislado de este ensayo (sufijo FECHA numérico); nunca usar uno productivo. El ejecutor exige 650 MiB libres en su filesystem real y el observador registra disco Docker y disco macOS por separado. La limpieza de ensayos fallidos conserva archivos pg_dump verificados y hashes; no elimina datos ajenos.

`caffeinate` sólo corresponde a macOS. En Linux conservar el host activo durante las dos horas. El ensayo usa veinte cuentas nuevas en siete grupos más dos cuentas comerciales sintéticas, PostgreSQL dedicado, adaptador sin red, reloj virtual para calendario y reloj real para carga. Un intervalo interrumpido de más de 60 segundos invalida continuidad. Ni declaraciones ni entregas de laboratorio acreditan actividad REAL.

El perfil aislado usa un ciclo cada 12 segundos: hasta cinco transacciones comerciales sintéticas por minuto, más los mensajes programados por las cuotas estándar. El reloj avanza media hora por ciclo para cubrir la preparación y continuar con mantenimiento autorizado aparte; el límite de transporte declarado sigue siendo cinco envíos por cuenta/minuto. El informe registra la tasa y actividad efectivas. Ejecutar sin suites de compilación/integración simultáneas; conservar cualquier incumplimiento por carga ambiente. El observador independiente mide salud, colas, disco, conexiones y jobs; la evaluación aplica los márgenes originales sobre medias móviles de cinco minutos ponderadas por tiempo. IA y procesos WAHA físicos no están incluidos en este perfil.

Relojes de los fallos: `slow_gateway_ms=1200` demora real por lectura/envío; `delayed_receipts_ms=240000` son cuatro minutos del calendario virtual y se liberan en el siguiente ciclo elegible, no cuatro minutos de espera real. La pausa de despacho ocupa cinco ciclos reales; los heartbeats siguen activos. Las dos horas, latencia de despacho, espera DB y edad de salud siempre se miden con reloj real. El reinicio efectivo de un proceso y la presión del pool tienen su prueba separada.
