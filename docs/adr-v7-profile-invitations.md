# V7 F2 — invitaciones y correo transaccional durable

Decisión del 11-oct-2026, registrada antes de implementar. Continúa el ADR-V7-13
del vault: Better Auth conserva la identidad y App Engine será el transporte GCP
compartido por recuperación, invitaciones y avisos. El SMTP heredado se preserva
para rollback; no se adopta como transporte nuevo de invitaciones. No se invita a
ninguna persona por instalar o probar este código.

Una solicitud explícita de Dueño, por la misma acción `employees:write` en
UI/API/MCP, identifica destinatario y rol. El servidor deriva el perfil de la
sesión seleccionada o PAT vigente. Registra una invitación versionada, un evento
de auditoría y una entrada de outbox en la misma transacción. El cliente aporta
una operación UUID para deduplicación; el mismo UUID con contenido distinto se
rechaza. Correo y nombre no se copian a logs/eventos. El destinatario se custodia
cifrado y se indexa mediante HMAC con separación de propósito, no hash simple.

El dispatch genera un enlace aleatorio de 256 bits y conserva sólo su digest en
la invitación. El token de la URL viaja en fragmento, nunca en query/access logs.
La outbox cifrada liga perfil, invitación, versión, destinatario y plantilla fija;
el cliente no puede aportar remitente, HTML ni endpoint. La vigencia de 24 horas
comienza al persistir el intento de despacho, no al crear una invitación que
podría esperar en cola. Una invitación sin despacho no es un enlace utilizable.

Antes del envío se confirma perfil ACTIVE, versión pendiente y autoridad actual
del iniciador; las cuotas globales y por perfil se reservan atómicamente. El
intento se confirma de forma durable antes de llamar al transporte. Un proceso
interrumpido después de ese punto queda UNCERTAIN, sin reenvío automático. La
aceptación del proveedor no acredita recepción del destinatario. Un reenvío es
una nueva acción explícita y versionada; invalida el enlace anterior y no se
admite mientras el intento previo está en curso. Un GET nunca consume enlaces.

Aceptar exige el token actual y una identidad Better Auth que corresponda al
correo verificado. El flujo para una persona nueva valida primero el enlace e
incorpora alta de credencial mediante las reglas de Better Auth, sin reactivar
signup público. No admite PAT como identidad del destinatario ni modifica una
membresía ya existente: cambios de acceso siguen la ruta administrativa. La
aceptación y creación de membresía son una sola transacción, con serialización
administrativa antes de locks y comprobación de reloj al final. Suspender el
perfil bloquea despacho y aceptación; cancelar o reenviar invalida el token
anterior. Aceptar dos veces no crea otra membresía ni duplica auditoría.

El primer incremento fija el contrato puro de estados y resultados. El esquema,
API, UI, outbox/worker, receptor App Engine, aceptación Better Auth y pruebas de
recepción real se integran después bajo este mismo contrato; el contrato puro no
acredita ninguna de esas operaciones. Todas las rutas permanecen sin registrar
hasta adaptar consumidores y aprobar la transición completa RLS/FK. Los tests
usan destinatarios sintéticos y nunca realizan envíos externos.

El segundo incremento prepara creación/listado/cancelación y su almacenamiento
sin registrar rutas ni activar el worker. Usa el HMAC de identidad existente con
propósitos exclusivos para destinatario y solicitud; ambos incluyen el perfil,
y la solicitud también incluye al iniciador y el rol. El payload cifrado liga
perfil/invitación/destinatario y una plantilla fija. Un único pendiente por
perfil/destinatario evita invitaciones paralelas; para sustituirlo se cancela o
reenvía mediante una acción versionada. El listado pagina por UUID, hasta 100
filas, bajo la autoridad Dueño ya existente. Crear no acredita ningún envío.

La transición concede al API sólo inserción/lectura de invitaciones y cola, y
actualización de estado/versión para cancelación. El trigger impide alterar
identidad, destinatario, rol o payload; no concede permisos de dispatch a roles
actuales. Los permisos y políticas del worker se incorporarán junto con su
implementación y pruebas nativas. La cola inicial tiene sólo estado QUEUED, de
modo que no puede confundirse con un intento durable de transporte.

El cliente distingue únicamente el rechazo confirmado `409
INVITATION_ALREADY_PENDING` del resultado incierto. Ese rechazo descarta la
operación local y exige recargar el listado antes de crear o cancelar; no repite
el POST rechazado. Un error distinto conserva UUID y contenido hasta consultar
la operación, y no habilita un reintento automático.

La aceptación se implementa separadamente de la administración del Dueño. No
requiere que el destinatario ya pertenezca al perfil ni selecciona un perfil por
él. Un localizador SQL fijo devuelve sólo los dos IDs de la invitación por HMAC
del enlace; no devuelve correo, token ni payload. Dentro de la transacción se
serializa la autoridad del perfil, se bloquean sesión/identidad, perfil e
invitación y se confirma el correo verificado de Better Auth contra el HMAC
custodiado. El rol y perfil proceden exclusivamente de la invitación. Membresía,
aceptación y auditoría se confirman juntos; caducidad y estado se comprueban al
final, usando el reloj de PostgreSQL. El iniciador de la invitación debe conservar
su membresía activa de Dueño al aceptar; se bloquea esa autoridad durante la
transacción. La revocación o una membresía existente no
se reemplazan ni reactivan por aceptar un enlace. Un reintento de la misma
aceptación sólo puede confirmar su resultado previo para el mismo usuario.

El esquema de enlace y aceptación sigue siendo una transición aislada. Añade
los campos de despacho y un permiso SQL de aceptación acotado; no concede al API
escritura de token ni horas de vigencia, y no activa todavía ningún worker. El
localizador SECURITY DEFINER se incorpora al inventario de privilegios que debe
revisarse antes de RLS. El primer adaptador valida destinatarios con identidad
existente; el alta por invitación usa después esta misma frontera transaccional
y las reglas de credenciales Better Auth, sin habilitar signup público.

La aceptación para una identidad existente utiliza un endpoint separado de la
selección de perfil. Sólo admite la sesión interactiva nativa y el secreto de la
invitación en un cuerpo POST acotado; rechaza PAT, perfil/entorno del llamador y
orígenes ajenos. No expone el secreto en URL, errores ni logs de la ruta. La
respuesta confirma el COMMIT sin cambiar automáticamente el perfil seleccionado.
La ruta permanece sin registrar hasta completar el cutover y sus gates.

La pantalla preparada de aceptación retira el fragmento de la URL antes de
cualquier petición y conserva el enlace únicamente en memoria. Una consulta de
estado usa un POST separado de sólo lectura, para no poner el secreto en query
o logs; comparte la validación de sesión, destinatario, autoridad y reloj con la
aceptación. No crea membresías ni auditoría. Tras una respuesta de aceptación
incierta, la pantalla permite sólo esta consulta: un resultado ACCEPTED confirma
el estado custodiado, PENDING permite una nueva acción explícita y un error
conserva la incertidumbre. No hay reintentos automáticos, almacenamiento local,
selección automática de perfil ni activación de rutas en este incremento.
