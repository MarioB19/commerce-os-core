# Números y preparación por grupos · decisión 19 septiembre 2026

Base verificada: main local y remoto b0ff5378122a164d5b48447a8abb1f547faf8039. Trabajo aislado en codex/numbers-groups-20260919. No se importan autorizaciones históricas. La implementación comenzó local; Brandon autorizó después la integración y publicación al cerrar verificaciones. Las sesiones, envíos REAL y ampliación de permisos conservan su autorización propia.

## Autoridades y compatibilidad

Se extienden warmup_pools, states, conversations, turns y el outbox existente. Los borradores no enrolan cuentas. Activación reserva cuenta y grupo transaccionalmente; sólo entonces afecta el guard comercial. Los episodios conservan política, identidad e historia. Migraciones aditivas; perfiles históricos sin versión se leen como legacy-30d/v1. Nuevas altas estándar privadas y de grupo usan standard-15d/v1. Inbound-light permanece explícito.

Los grupos se clasifican antes de contactos y ventas, incluso desconocidos o archivados. Recibos se identifican por efecto, grupo, emisor, receptor y membresía. Un envío es una muestra lógica, no N muestras por receptores. ACK global no acredita destinos. Recepción autenticada es una fuente propia, nunca un ACK inventado. El siguiente turno espera recepción del anterior. Membresía fresca exacta y permisos comprobados antes de despachar; una carrera remota posterior a esa lectura no puede eliminarse atómicamente con PostgreSQL.

Los efectos de grupo llevan una marca de versión que el guard anterior rechaza. Una restricción en DB impide que coordinadores antiguos generen efectos privados para pools de grupo. Rollback conserva esquema/historia y pausa grupos, sin convertirlos a privados.

## Política temporal

Cuatro fechas locales manuales transcurridas, tareas declaradas por operador con actor/fecha/fuente, diez días automáticos acreditados y evaluación desde día 15. No se aceptan retrofechas para fabricar progreso. Zona e identidad quedan fijadas por episodio. Actividad automática comienza con cuota 1, independientemente de retrasos. Fines de semana: floor del presupuesto por 0.5, mínimo ajustado explícito. No recuperar volumen perdido.

Estabilidad: siete días observados dentro de los diez automáticos, reiniciada por huecos de observación de una hora o señal negativa. Entrega: mínimo veinte efectos propios maduros (30 minutos por defecto), al menos 98% confirmados; cada efecto se confirma sólo con evidencia de todos sus destinatarios esperados. Muestras correlacionadas no son ensayos independientes ni reputación. No hay extensiones fijas en la política nueva; faltantes reevaluables. Una preparación completada no concede permiso comercial o mantenimiento.

Contenido: versiones aprobadas inmutables, reservas por cuenta/guion, una utilización por fecha local y 24 horas mínimas. UNKNOWN conserva la reserva. Cobertura verifica cuotas, participación activa de todos, turnos, tiempo y vencimiento. Mantenimiento es un propósito separado, apagado por defecto y cede ante trabajo comercial.

## API, MCP y capacidad

Web y MCP llaman los mismos endpoints con actor/workspace/entorno, revisión e idempotencia. Preparar, revisar, autorizar y activar son operaciones distintas; lecturas sin efectos. Jobs durables identificables y retomables; UNKNOWN se concilia, no se recrea. QR conserva acceso efímero autenticado; no se exportan bytes por MCP.

Capacidad separa plazas, sesiones, gateways, workers y host. Reserva transaccional hasta veinte; expansión incremental del helper existente con lock, comparación de revisión, escritura atómica, backup/readback y conservación del piloto. API sin Docker socket ni shell: el administrador sólo consume operaciones allowlist auditables. Preparar capacidad no inicia sesiones. Las métricas físicas requieren lectura autorizada del host; límites declarados no son mediciones de consumo.

## Validación y límites iniciales

Lecturas MCP del 19-sep: tres cuentas, estados WORKING/FAILED/UNKNOWN, cero permisos de envío vigentes y ningún pool. La herramienta histórica expone teléfonos en name; las nuevas proyecciones deben enmascararlos. Sin inventario actual del host ni prueba de grupos del WAHA instalado todavía. Documentación WAHA consultada para contratos de grupos/eventos; no acredita su versión instalada. Pruebas locales usarán PostgreSQL y adaptador incapaz de red externa, con reloj controlado para calendario y tiempo real para carga de dos horas.

## Alta incremental sin detener los números existentes

El endpoint de integraciones conserva la invalidación global para cambios de perfiles existentes. La creación inicial de un perfil WAHA puede conservar la revisión operativa únicamente cuando la vincula un administrador al job PROVISION reclamado, vigente, de su mismo actor; slot físicamente verificado; cuenta nueva sin identidad, permiso ni efectos; perfil ausente y revisión cero. El alcance administrativo y el permiso de escribir integraciones siguen siendo obligatorios. No se acepta esta excepción para rotación, edición, reutilización de cuentas ni otros proveedores. Se registra el job en auditoría. Así, agregar un gateway no congela silenciosamente los once ya operativos.

### Recuperación durable y migración de evidencia

Las lecturas de identidad y grupos conservan cursor y observaciones parciales. El worker limita cada tramo a 16 lecturas y 45 segundos, valida su claim dentro de cada transacción y reanuda el mismo job; un `UNKNOWN` mutante sólo admite readback administrativo. `resume_read` tiene expected_version, permiso, auditoría y herramienta MCP equivalente.

La migración revisada conserva días respaldados por planes COMPLETED de fechas distintas (hasta diez), fecha inicial, muestras y estabilidad históricas. No reinicia esos contadores ni inventa declaraciones humanas. El preview sella los planes acreditados; un cambio invalida la revisión. Una política ya vigente no se vuelve a migrar. La validación manual pendiente se presenta explícitamente.

### Conciliación desde otra sesión administrativa

Un administrador de capacidad vigente del mismo workspace puede conciliar UNKNOWN con expected_version y readback exacto, aunque el token que reclamó el job haya caducado o sido revocado. No puede completar un PREPARING ajeno. La creación inicial de perfil durante conciliación exige inventario fresco (60 s), cero sesiones y cuenta nueva sin efectos. El helper de conciliación sólo relee recursos existentes: no genera credenciales, no recrea overlay ni contenedores. Auditoría conserva ambos propietarios.

La migración conserva la fecha local del perfil anterior al buscar planes; no convierte UTC en una fecha adicional. Una preparación ya graduada se conserva y no se vuelve a migrar. Un pool legado con integrantes migrados no se puede reautorizar con la curva anterior: requiere un programa revisado compatible; los permisos comerciales no cambian.

### Release y rollback después de ampliar gateways

El congelamiento del instalador pausa explícitamente programas nuevos REAL y sus pools, invalida su revisión y conserva completados/archivo, episodios, autorizaciones históricas y resultados inciertos. Se ejecuta además del bloqueo global y ownership; no depende de que la interfaz anterior conozca grupos. Para rollback usar los helpers de esta entrega con los digests anteriores: un helper antiguo limitado a diez slots no puede validar un overlay ya ampliado. No revertir esquema ni redes/volúmenes. Reanudación requiere revisión y autorización nuevas.

Los comandos de sesión reutilizados exigen expected_version para cuentas creadas por el recorrido nuevo. El MCP transmite esa revisión; la compatibilidad de cuentas legadas conserva el contrato anterior. Así, una conexión desde Codex no puede ignorar una edición web concurrente.

### Medición reproducible de carga local

La aceptación conserva los umbrales de la sección 13.5 y separa duración, margen de recursos, latencias y corrección. El ensayo firma los archivos fuente sin simular un commit, inicia un observador de lectura desde el comienzo y registra disco del volumen local, tamaño/conexiones de PostgreSQL, colas, jobs durables y ownership. La ausencia de pg-boss activo en este perfil se declara: invocar los entrypoints canónicos no acredita su throughput ni el de IA o WAHA físicos. Los recursos del host incluyen carga ajena y no se excluyen ventanas desfavorables. Una media móvil de cinco minutos define margen sostenido; mínimos y máximos originales permanecen disponibles.

### Revisión final de paridad y tema

Retirar un número conserva el endpoint canónico de eliminación lógica, sus guards de desconexión/ownership/UNKNOWN y el historial. Se expone también en MCP con revisión, clave y confirmación literal; no se desconecta ni libera capacidad implícitamente. Los diálogos nuevos adoptan una clase de tema acotada para mantener contraste en modo oscuro sin cambiar otros formularios. Estas correcciones no cambian el motor, proveedor ni perfil del banco de carga; se verifican por transporte MCP y E2E después del ensayo aislado.

### Disco real del banco de carga

Un intento de 49 minutos agotó el filesystem de la VM Docker aunque el volumen macOS tenía espacio. Conservar ese resultado fallido; archivar y retirar únicamente las bases desechables de este trabajo, con hashes y verificación de pg_restore. Antes de repetir se requieren 650 MiB disponibles en el filesystem que respalda PostgreSQL, medido con `df` dentro del contenedor aislado. El observador registra ese espacio además del volumen del checkout. No se modifica el límite de recursos, no se limpian imágenes/volúmenes ajenos y no se relajan los criterios de aceptación.

### Compatibilidad de plazas con cuentas anteriores

El CI completo detectó que una reserva nueva ignoraba cuentas anteriores fuera del inventario de capacidad. La asignación debe excluir sus referencias y sus URLs físicas normalizadas, incluso cuando usan otro alias de integración. Preparar o ampliar preserva las plazas legadas del mismo workspace sin asociarlas a un job nuevo ni cambiar sesiones; una plaza ajena incluida en el objetivo rechaza la operación. El preview expone las plazas preservadas y las descuenta de la ampliación propuesta, sin afirmar instalación o consumo medido. La prueba de contrato crea una cuenta anterior por un alias alternativo y verifica que conserva su sesión, revisión y permisos.

La prueba de despacho debe observar ciclos acotados del worker: el límite de 20 es global y una suite compartida puede dejar trabajo previo. Se conserva ese límite y se exige progreso y entrega del workspace probado, con diagnóstico de guards si no progresa; un único ciclo no garantiza visitar cada cuenta de una base compartida.

Una lectura remota de grupo que lanza una excepción también debe actualizar el turno de selección del efecto bloqueado. Dejar su fecha intacta lo mantiene primero en todos los lotes y puede impedir visitar otros grupos. La corrección registra un motivo estable sin detalles del proveedor, conserva attempts=0 y permite que el siguiente ciclo atienda otros candidatos. Una regresión fuerza la caída de lectura del grupo más antiguo con lotes de una cuenta y exige entrega del grupo independiente.

### Contador de cola después del guard

El último pase de despacho puede bloquear por frecuencia un candidato que era elegible al inicio del pase. Medir el Map anterior contabilizaba ese efecto como cola ejecutable hasta la siguiente consulta. Se interrumpió el ensayo a los 84.5 minutos y se conservan sus bytes originales más un recibo de interrupción; no acredita dos horas. La medición corregida relee después del pase final y exige predecesor entregado y recepción autenticada, igual que el guard. El observador independiente también registra longitud elegible y su p95 de latencia debe cumplir diez segundos. Se repite el ensayo completo sobre fuente comprometida; no se ajustan duración, RAM, CPU, latencias ni estabilidad de cola para aceptar el intento anterior.

## CI de navegador y retención — 20-sep, segunda ejecución completa

El run 35485480414 superó tipos, lint, build, unitarias, las integraciones y recuperación, pero falló un caso de navegador: el selector global «Mis números» coincidía con el menú principal y la navegación de Números. Se acota ese selector al sidebar que la prueba verifica, conservando la comprobación de foco y reflujo. Las otras 115 pruebas de navegador pasaron.

La subida posterior de diagnósticos también agotó la cuota de Actions. No se eliminan artefactos históricos ni se amplían permisos: se conserva la carga de diagnósticos para PR fallidos; los PR exitosos usan los logs de cada comprobación y el gate obligatorio, como main. No se omite ninguna prueba, no se permite ignorar sus errores y el transporte privado de paquete/deploy se conserva. Los cambios son exclusivamente de prueba, workflow y documentación; el código de aplicación y los instrumentos del banco de dos horas siguen siendo exactamente los de 99d22dc.

## Incidente de presupuesto Actions — 20-sep, después de la fusión

El SHA 2a6e4fbd pasó verify completo y package en el run 35489026855. GitHub rechazó arrancar Commerce CI gate por presupuesto de Actions (runner_id=0, steps=[]); deploy quedó SKIPPED. No se inició instalación. El evaluador canónico ci-gate.py acepta localmente los resultados observados success/success/full; esto no cambia el check remoto fallido.

Se investiga recuperación de incidente con la autorización Google existente y el mismo paquete sellado, sin aumentar presupuesto, roles o permisos. La guía reserva acceso manual para incidentes. Cualquier instalación debe conservar validación de main/SHA/hashes, respaldo, migraciones e instalador canónico, congelamiento REAL y verificación posterior. No se reemplazan los checks remotos ni se presenta una ejecución manual como CI verde.

### Recuperación concluida y relectura

GitHub no inició Commerce CI gate porque agotó el presupuesto de Actions; deploy quedó SKIPPED. Se resolvió como incidente con la autorización Google existente, el paquete sellado de ese run y los instaladores canónicos sin modificar. Resultado SUCCEEDED: seis servicios, 57 migraciones, HTTPS por hash y sesiones/gateways conservados. El workflow sigue FAILURE por presupuesto; no se alteró ningún check, presupuesto, rol o scope. El despliegue real quedó registrado separadamente en GitHub (6549461250), exigiendo los checks verify/package exitosos.

Lecturas productivas: 20 GET de API y 15 llamadas MCP aprobadas; siete assets web coinciden por hash. Mis números, detalle, preparación, capacidad, Calentamientos y móvil 390px comprobados en navegador contra la API real con el PAT owner existente, sin respuestas simuladas. La contraseña bootstrap guardada devolvió 401; no se reinició ni modificó. Portal HTTPS confirma el mismo SHA y 480 actividades. MCP firmado instalado: 104 herramientas, incluidas las 38 nuevas; firma, seis archivos y paridad API comprobados. La conexión actual de Codex conserva el proceso anterior: recargarla antes de aceptar el recorrido completo desde ese cliente.

El instalador recibió los mismos valores privados del portal, con comparación antes/después. Los accesos efímeros se retiraron por la identidad exacta de su clave pública: el fingerprint calculado por el helper no coincidía con el ID del recurso OS Login, por lo que se comprobó la procedencia en el log privado y se eliminó el recurso correcto. Ambas ausencias se releyeron; las claves ajenas y ADC original permanecen. Esta incidencia de limpieza queda documentada para corregir el helper en una entrega propia. [Evidencia](evidence/numbers-incident-access-cleanup.json).
