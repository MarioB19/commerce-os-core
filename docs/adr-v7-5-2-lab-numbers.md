# V7.5.2 — Laboratorio sobre almacén de solo lectura, permiso operativo y estado de prueba

13-nov-2026. Claude. Release correctivo sobre V7.5.1 (`76901884`, 121 migraciones).
Sin migraciones nuevas. Incorpora el parche de lectura de Codex
(`08798f88`, [ADR](adr-number-lab-readonly-lock-2026-11-12.md)) con su autoría.

## L01 · El laboratorio no podía leer el almacén fuente

Hechos: `automation-worker` monta `/data/private:ro` y `/data/laboratory:rw`.
El bloqueo compartido abría `.private-namespace.lock` con `O_RDWR|O_CREAT` (EROFS)
y, además, el archivo no existía en el almacén fuente (ENOENT). El worker sólo
registraba `number_lab_operation_failed UNEXPECTED` y la operación quedaba
`INTENT` para siempre.

Decisión:

1. **Lectura** (Codex): un lector SHARED abre el lock existente con
   `O_RDONLY|O_NOFOLLOW`; sin él, lo crea sólo si la raíz es escribible.
2. **Inicialización canónica**: `copy_runtime_deployment.ensure_lab_storage`
   —que corre en la preparación escribible del host, con los workers detenidos,
   tanto en instalación nueva como en una actualización sin migraciones
   pendientes— crea el lock de cada espacio (fuente y laboratorio) vacío, 0600 y
   del dueño del directorio, con `O_EXCL|O_NOFOLLOW` relativo al directorio
   abierto. Como root, un proceso hijo baja primero al dueño, así que el archivo
   nace con su dueño final. Uno existente se verifica tal cual (archivo regular,
   no enlace, `nlink=1`, vacío, 0600, mismo dueño, mismo inode al abrirlo) y nunca
   se trunca, reemplaza ni cambia de permisos; cualquier otra cosa detiene la
   publicación (`COPY_RUNTIME_PRIVATE_NAMESPACE_LOCK_UNSAFE`). El informe del
   instalador registra `namespace_locks: {source, laboratory}: CREATED|VERIFIED`.
   No cambia montajes, la definición adoptada de los contenedores ni Root/B02.
3. **Diagnóstico sin secretos**: el lock falla con códigos estables
   (`PRIVATE_NAMESPACE_LOCK_UNINITIALIZED`, `PRIVATE_NAMESPACE_READ_ONLY`,
   `PRIVATE_NAMESPACE_LOCK_FILE`, `PRIVATE_NAMESPACE_LOCK_UNAVAILABLE`) y el
   código del sistema (`EROFS`, `ENOENT`…) aparte; el log del worker imprime
   código y errno, nunca mensaje, ruta, llave ni contenido.
4. **Sin reintento a ciegas**: una preparación que falla antes de que el motor
   admita la operación (la fila `executions` se escribe en la misma transacción
   que habilita al motor) cierra el paso como `FAILED` con
   `{state:'DEPENDENCY_REQUIRED', reason, engine_admitted:false}`. Un `INTENT`
   antiguo (≥ 10 min) sin ejecución del motor se cierra igual con
   `LAB_OPERATION_NOT_ADMITTED`; con ejecución del motor sigue la conciliación por
   recibo de siempre (queda incierto si no hay recibo). Nada se reencola, repite
   ni cobra; la suite marca el caso «Incompleto», no «Falló».

## N01 · Asignación, permiso operativo y calentamiento

Hechos: V7 retiró `POST /v1/channel-accounts/:id/activate` (V5), pero conservó
`sending_enabled` como compuerta del despacho, de la propuesta de la
automatización, del `resume` y de los diagnósticos. Ninguna ruta V7 lo
encendía: un número asignado por una persona no podía atender nunca, ni siquiera
al graduarse su calentamiento. Inicio contaba la bandera; Números mostraba
«Vendiendo» con sólo tener asignación.

Decisión (D-01): la asignación humana de una variante a un número es la
autorización permanente para atender. Esa misma acción es la **transición
canónica del permiso operativo** (`HUMAN_ASSIGNMENT`, en `setVariantNumber`;
confirmar otra vez la misma asignación también lo restablece). Para asignaciones
humanas ya vigentes antes de esta transición, el mantenimiento por perfil del
channel-worker lo **adopta una sola vez** (`ASSIGNMENT_ADOPTION`). En ambos casos
exige la autorización comercial permanente viva de una asignación ACTIVE (sólo la
emite la sesión de una persona) y guarda `sending_permit` (origen, asignación,
continuidad, identidad, fecha, actor) más el evento
`channel.sending_permit_established`.

No levanta nada más: pausa humana, protecciones, calentamiento, controles
manuales, hold de release y política REAL siguen con sus propias compuertas. La
adopción no reactiva un permiso que existió y se apagó (eliminación,
desvinculación, logout): sólo un acto humano nuevo. Un número sin asignación
(WA 6, reserva) nunca obtiene permiso. No hay SQL manual ni activación masiva.
La adopción corre por pasadas acotadas (20 números por perfil) y sólo selecciona
números que cumplen la misma elegibilidad que la transición (proveedor real, sin
transporte de laboratorio, autorización viva de la revisión y vinculación
vigentes de la asignación), así que un número que la adopción rechazaría no
vuelve a seleccionarse ni bloquea a los demás: las pasadas convergen a cero.

Vocabulario único (`packages/db/src/number-selling.ts`), usado por Inicio y
Números: **asignado** (autorización comercial viva), **calentando** (la misma
guarda `commercialWarmupGuard` del despacho bloquea), **apto para atender**
(conectado, bajo control operativo, sin pausa, asignado, calentamiento cumplido,
permiso, política REAL abierta, sin protección) y **atendiendo** (apto y con una
conversación de cliente con entrada en las últimas 24 h). Inicio agrega
`ready` y causas `WARMING`, `NOT_ASSIGNED`, `NOT_OPERATIONAL`; Números usa
`READY_TO_ATTEND`, `ASSIGNED_WARMING`, `ASSIGNED_NOT_AUTHORIZED` y reserva
`SELLING` («Atendiendo») para actividad real.

## T01 · Prueba pendiente presentada como correcta

`last_test.ok` era «hay acciones y ninguna FAILED/UNKNOWN»: una suite RUNNING
con operaciones INTENT salía `ok:true`. Ahora (`number-lab-status.ts`):
`PASSED` sólo con la suite terminada y **todos** sus casos aprobados; `FAILED`
sólo con un caso fallido; en otro caso `IN_PROGRESS`, `UNCERTAIN` (paso sin
resultado), `INCOMPLETE` o `MANUAL` (prueba conversada, sin veredicto). `ok` es
`true`/`false` sólo en PASSED/FAILED y `null` en lo demás; se añaden `state`,
`label`, conteos de operaciones y cobertura. Web, API y MCP (que reenvía la
respuesta de la API) leen lo mismo. Una suite sin concluir impide iniciar otra
del mismo número (`LAB_SUITE_IN_PROGRESS`).

## Validación

- Regresiones rojas sobre V7.5.1 y verdes con el cambio: EROFS en montaje real de
  solo lectura; despacho real de un número nuevo graduado bloqueado por
  `CONTINUITY_ASSIGNMENT_UNAVAILABLE`; falso `ok:true` de una suite pendiente.
- Montaje Linux de solo lectura real (bind `ro`), PostgreSQL real, instalador
  sobre archivos y dueños reales (root → uid 1000), y la disposición exacta de
  producción en contenedor (`/data/private:ro`, `/data/laboratory:rw`).
- Ningún ensayo envía WhatsApp ni registra ventas; el laboratorio usa un
  proveedor de IA de contrato (sin llave real).
