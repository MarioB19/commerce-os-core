# Autorizaciones continuas y protecciones por causa

12-oct-2026. Implementación aislada de ADR-V7-03/04, D-01 y D-17.
La rama parte de main80a6 revalidado y añade por avance directo el incremento
F2 revisado93141 para utilizar su contrato de perfil. No contiene cambios sin
commit de F2, no cambia el candidato público51f72 y no activa consumidores.

La autorización permanente identifica perfil, entorno, número y asignación
comercial o acto QR verificado. Un release no es parte de esa identidad y no
puede renovarla, revocarla o escribir una pausa humana. La autorización de
comercialización necesita una asignación humana; la de calentamiento sólo
se deriva del acto de conexión autenticado y sólo admite un par del mismo
perfil. Ninguna autoriza destinatarios externos, campañas ni publicidad.

La pausa humana se conserva separada de las causas de protección. Un hecho
de recuperación libera exclusivamente la causa y la versión observadas;
un hecho atrasado no borra una protección nueva. Un envío incierto necesita
conciliación específica; la salud del canal no acredita que no se envió.
El par de calentamiento necesita su propia autorización QR activa y sin
protecciones, además de cuenta activa, conexión, consentimiento y ausencia
de pausa. Estar conectado por sí solo no demuestra que sea un par elegible.
La baja es terminal para esta autorización: reactivación requiere un nuevo
acto autorizado, nunca un cambio automático a la fila revocada.

Los contratos cerrados y el reductor puro son compartidos por los futuros
adaptadores de API/MCP/UI y workers. El actor humano se obtiene de la autoridad
F2; las observaciones de salud y conexión provienen de puertos internos
autenticados, nunca del cuerpo HTTP. El reductor produce estado y evento
auditables; no envía ni toca Docker. Persistencia prevista en transición010,
con RLS FORCE, CAS e idempotencia dentro de la transacción de perfil.

Validación: ausencia de invalidación por tiempo/release, permiso por perfil y
propósito, pausas y revocación, recuperación fuera de orden, envío incierto y
calentamiento sin pares. Los ensayos de contratos no acreditan LIFE50/CONT3
operativos, capacidad física, montaje de rutas, migración ni producción.

Persistencia: cada autorización mantiene origen inmutable, estado versionado,
eventos inmutables y resultado por operación en una misma transacción. La API
puede modificar pausa/baja; los workers sólo las protecciones. Un trigger
rechaza cruces entre esas capacidades incluso mediante SQL directo. La
creación comercial verifica la asignación y binding actuales. La conexión QR
se vincula al comando humano `connect` aplicado y a la observación vigente
del proveedor; una simple fila conectada no crea autoridad. Repetir ese origen
no revive una autorización revocada. Ningún consumidor nuevo queda montado
por guardar esta transición aislada.

La pausa humana pertenece a la asignación comercial entre sus revisiones, o
al número para calentamiento entre sus conexiones QR. Un origen nuevo no
borra una pausa, incluso si la autorización anterior se revocó. Se deriva el
último acto humano de los eventos inmutables, con secuencia de base de datos
para ordenar actos sin depender del reloj. Crear un origen hereda ese estado;
pausar o reanudar actualiza las autorizaciones activas del mismo ámbito en una
transacción, con un evento por versión. Revocar sólo termina la autorización
indicada. Lock de ámbito antes de filas ordenadas y constraint diferida evitan
que una conexión concurrente escape a la pausa. Otra asignación comercial no
hereda la pausa de un producto ajeno. La UI conserva el identificador de un
cambio incierto y consulta su recibo sin repetir el POST.

Los nuevos efectos usarán una referencia separada y compuesta a continuidad
(transición012). La referencia temporal heredada se conserva en su columna
para auditoría; no se reinterpretan ni reactivan efectos históricos. Un efecto
no puede mezclar ambas autoridades ni cambiar de autorización tras crearse.
El vínculo verifica perfil, entorno, número y propósito en SQL. El lector
interno exige transacción de perfil, rol channel y efecto no vencido; mantiene
el lock compartido de la autorización hasta terminar la transacción. Este
vínculo no sustituye los gates de consentimiento, límites, salud o lease, ni
monta por sí mismo el dispatcher V7.

El reconciliador de conexiones consulta en cada ciclo el estado vigente por
perfil; no guarda una lista de cuentas al arrancar. Considera únicamente el
último comando humano connect aplicado y una observación QR verificada y
fresca del mismo número. Cada origen se registra en una transacción aparte,
con identificador de operación determinista y revalidación del origen. Una
fila revocada sigue contando como origen procesado: polling no la revive.
El registro no envía mensajes ni sustituye la selección de un par elegible.

Validación del incremento de persistencia y consumidores, 12-oct-2026:
74 pruebas focales de dominio/API/client/MCP, 29 casos sobre PostgreSQL real
con roles restringidos y cookies Better Auth, y 12 casos de Chromium pasan.
El ensayo SQL cubre también herencia de pausa entre conexiones y revisiones,
concurrencia, eventos forjados, rollback atómico, efectos con autoridad ajena,
vencimiento y descubrimiento dinámico. TypeScript y lint focal pasan.
Los intentos anteriores con errores del fixture se conservan; el resultado
válido corresponde a los hashes de `docs/evidence/f3-continuity-20261012.json`.

Este incremento todavía no monta las rutas ni reemplaza los productores y
dispatchers existentes. Quedan por integrar la autoridad de perfil en todos
los consumidores, el planificador automático entre pares propios, los gates
de emisión y los ensayos CONT/LIFE, antes de admitir un despliegue V7. Ninguna
prueba local acredita conexiones QR físicas, entrega real o producción V7.

Integración de efectos comerciales: los nuevos efectos de una asignación V7
obtienen su autoridad del origen comercial vigente dentro de la transacción
de perfil. No heredan ni renuevan el permiso temporal anterior. Los efectos
históricos conservan su referencia y sus límites hasta terminar o cancelarse;
no se modifica su autoridad. La lectura de continuidad mantiene locks de la
asignación, perfil y autorización, y no constituye por sí sola permiso para
emitir. El dispatcher conserva salud, identidad, propiedad exclusiva, cuotas,
consentimiento, ventanas, orden causal, versión de la configuración comercial
y conciliación de incertidumbre. Una campaña sigue requiriendo su aprobación
específica. La fecha de creación del permiso continuo no invalida el historial
de un cliente entrante de la asignación; sí se exige inbound persistido válido,
sin fechas futuras, y ventana o consentimiento/plantilla admisibles.

El pool automático QR se distingue de los pools históricos mediante
`continuity_mode=QR_CONTINUOUS`. Cada efecto referencia el permiso de su emisor
y el gate relee el permiso de la conexión QR actual de ambos participantes.
No salta una baja del último origen para recuperar un permiso anterior. La
verificación de identidad QR usa hechos separados de la verificación de nombre
y perfil del proveedor; no se fabrica `profile_verified_at`. Los dos extremos
conservan su curva diaria, incluso sin contador vitalicio de autorización: el
claim y el gate final cuentan mensajes/conversaciones consumidos bajo locks
por número, incluidos los resultados inciertos. La política, salud, identidad,
recepción del turno previo, pausas, ventanas y rate limiter siguen vigentes.

Validación del lector y gate comercial, 12-oct-2026: 43 casos PostgreSQL y
41 pruebas unitarias nuevas pasan con fuentes verificadas por SHA-256; tipos
y lint focal pasan. Los casos cubren la función restringida de perfil con
zona horaria, gates comerciales y lectura del permiso QR actual. El gate
completo de calentamiento automático depende de transición015 y sigue sin
ensayo PostgreSQL; no queda incluido en este incremento. Todavía debe
corregirse el resultado ambiguo del productor al bloquear o encontrar un
efecto existente, para que workflow e IA conserven la intención durable antes
de avanzar. Esta limitación impide considerar cerrado F3 o desplegarlo.
