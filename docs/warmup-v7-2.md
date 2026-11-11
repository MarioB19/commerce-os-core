# Calentamiento de grupos en V7.2

> **V7.4 (11-nov-2026):** el grupo puede incluir participantes externos y cada
> número elige si necesita calentamiento. Lo que este documento dice sobre «todos
> los integrantes deben pertenecer al perfil» queda como antecedente; la regla
> vigente está en [Números y calentamiento en V7.4](numbers-warmup-v7-4.md) y en
> el [ADR V7.4](adr-v7-4-numbers-warmup.md). Biblioteca, límites y horario no cambian.

En Números → Calentamientos, actualiza los grupos desde tus líneas conectadas,
elige uno existente y selecciona al menos dos emisores. Todos los integrantes
físicos del grupo deben pertenecer al perfil y estar identificados y conectados;
los integrantes no seleccionados siguen siendo destinatarios. No se crean grupos
ni se agregan contactos. Cada número se reserva para un programa a la vez.

La biblioteca incluida contiene 500 guiones de diez turnos, 5,000 mensajes
normalizados distintos, sin IA. Ver biblioteca permite revisar y buscar los
textos. Importar acepta un arreglo JSON de guiones con `label`, `topic`,
`ownership_confirmed: true` y `turns: [{kind: "text", text: "…"}]`.
Cada versión es inmutable; importa otra versión para corregir textos. Se rechazan
mensajes duplicados, datos personales evidentes, enlaces y marcadores pendientes.
La cobertura debe alcanzar siete días al máximo elegido más 20% de reserva.

Los límites son de mensajes salientes, por grupo y emisor. La curva gradual,
la capacidad del horario y las conversaciones completas pueden producir menos
mensajes que el máximo configurado. La revisión rechaza combinaciones de límites
que impidan obtener evidencia diaria. Los días efectivos se acreditan por
intercambios entregados y conexión observada; no se acreditan por sólo recibir.
El progreso anterior se conserva. Empezar tarde no reduce la evidencia exigida
ni genera una ráfaga de compensación. Los textos quedan reservados siete días
por grupo o número; un envío incierto nunca se repite automáticamente.

Pausar cancela sólo pendientes no iniciados; conserva el historial y resultados
inciertos. Reanudar requiere revisión nueva. Para cambiar grupo, emisores,
biblioteca u horario, pausa, revisa y guarda la configuración. Archivar conserva
historial y libera la reserva; restaurar necesita otra revisión. El mantenimiento
opcional continúa con volumen bajo y cede prioridad a ventas pendientes.

## API y MCP

Un token de perfil usa `warmup:read` y `warmup:write`. Se aplica el mismo permiso
QR vigente y el mismo aislamiento que en web; iniciar no exige una sesión humana.
No equivale a asignar variantes de venta ni a autorizar outbound a terceros.

1. `GET /v2/warmup` y `GET /v2/warmup/groups` leen líneas y grupos.
2. `POST /v2/warmup/groups/refresh` con `operationId` UUID y `accountIds`
   consulta el proveedor. Leer `/v2/warmup/operations/:id` hasta resultado terminal.
3. `POST /v2/warmup/programs` con `operationId` y `config` crea el borrador.
4. `POST /v2/warmup/preview` con `programId` y `config` devuelve `ready`,
   `blockers`, cobertura, límites y `previewHash`.
5. `POST /v2/warmup/programs/:id/commands` con `action: "start"`,
   `operationId`, `expectedVersion` y `previewHash` inicia. Pausar/archivar usan
   el mismo contrato sin hash; reanudar/configurar requieren revisión vigente.

`config` contiene `name`, `groupId`, `senderIds`, `libraryVersion`, `timezone`,
`startHour`, `endHour`, `groupDailyLimit`, `senderDailyLimit`, `maintenance`.
El entorno por defecto es REAL. No admite selección de otro perfil en el cuerpo.
Conserva el UUID y el cuerpo exacto ante respuesta incierta: primero consulta
la operación y sólo reenvía la misma solicitud; nunca inventes otro UUID para
resolver un resultado desconocido. Un cambio concurrente requiere nueva revisión.

`warmup_manage` expone `listar_programas`, `leer_programa`, `grupos`,
`actualizar_grupos`, `bibliotecas`, `ver_biblioteca`, `importar_biblioteca`,
`crear`, `previsualizar`, `iniciar`, `pausar_programa`, `reanudar_programa`,
`archivar`, `configurar` y `consultar_operacion`; las acciones históricas por
número siguen disponibles. La referencia generada detalla los esquemas exactos.

## Actualización y recuperación

0118 añade relaciones y restricciones sin reescribir evidencia previa. La
transición a grupos es explícita, conserva episodio e identidad y espera a
resolver SENDING/UNKNOWN/SENT antes de mover líneas. Una reconexión de la misma
identidad conserva el grupo y vuelve a planificar sólo los efectos no emitidos.
Cambios de integrantes pausan el programa y exigen revisar los destinatarios.

La recuperación preserva datos y deja la operación cerrada hasta validar las
sesiones. Tras actividad V7.2 se corrige hacia adelante: no se restaura una base
anterior sobre ventas o evidencia nuevas. El release se verifica por FULL nativo,
paquete exacto, ensayo aislado, instalación Root y versión servida por HTTPS.
