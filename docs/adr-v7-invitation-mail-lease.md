# F2 — reserva durable del correo de invitaciones

Decisión del 12-oct-2026, antes de implementar transición011. La transición012
de F3 conserva el outbox comercial y sus autorizaciones; este incremento sólo
consume profile_invitation_mail_jobs y el transporte GCP preparado de ADR-V7-13.

Un rol nuevo NOLOGIN, commerce_mail_dispatch, sólo puede ejecutar funciones
cerradas para un perfil y job explícitos. No recibe SELECT/UPDATE sobre tablas
de identidad, invitaciones o presupuesto. Las funciones SECURITY DEFINER usan
search_path pg_catalog y nombres cualificados. El contexto SQL se compara con
el perfil; se serializan el presupuesto global y la autoridad administrativa
antes de bloquear perfil, invitación, Dueño iniciador y job. La suspensión,
revocación del Dueño, cancelación o versión distinta impiden reservar/enviar.
La revisión final de RLS/FK y el inventario de estas funciones siguen siendo
gates de montaje, no permisos implícitos por instalar el código.

La reserva confirma atómicamente un intento UUID, el digest del enlace, el
inicio nativo de sus 24 horas, una autorización de hasta120segundos y el coste
interno de15467microUSD. Se cobra ese techo completo en cada etiqueta mensual de la unión UTC y America/Los_Angeles tocada por
[dispatched_at, authorized_until+960segundos]; es un límite interno conservador,
no una afirmación de factura ni de cuota del proveedor. El máximo interno es
2USD/mes; también se reservan8intentos/60segundos y100 por día America/Los_Angeles, globalmente y por
perfil. La cuota de minuto cuenta hasta authorized_until más60segundos. La diaria
reserva en cada día Pacific tocado por [dispatched_at,authorized_until),
incluidos ambos días si cruza medianoche; nunca libera por resultado temprano. Todos los estados consumen la reserva y nunca hay refund. GCS, logs,
egreso, builds y provisión necesitan sus admisiones independientes.

El secreto del enlace permanece en RAM y viaja sólo en el envelope AES-256-GCM
cerrado que entiende el servicio GCP existente; no se añade HTML, URL o sender
del llamador. Un segundo commit, todavía dentro de la autorización, registra
el hash del cuerpo cifrado y consume el permiso de envío una sola vez. Sólo
después de ese COMMIT puede realizarse un HTTP. Perder cualquiera de las dos
respuestas de commit impide llamar al transporte; una interrupción después del
permiso de envío permanece incierta. Los procesos siguientes sólo consultan
metadatos: no recuperan el cuerpo ni reintentan el job. El permiso cifrado
vigente no se convierte en una nueva prueba DB del lado App Engine.

El resultado ACCEPTED del transporte no acredita entrega. Errores, timeouts o
respuestas inválidas se registran UNCERTAIN sin volver a enviar. La aceptación
del enlace vuelve a validar estado, versión, destinatario e identidad nativa;
cancelar durante el breve permiso de transporte invalida el acceso aunque el
correo llegue después. No se realizan efectos externos dentro de transacciones.

La API de este módulo es un puerto interno con job/perfil explícitos, sin
selector HTTP público ni escaneo global. El worker, credenciales, factory GCP,
economía nativa y rutas permanecen sin activar hasta sus pruebas de integración.

Las claves foráneas del intento ligan tanto job como invitación al mismo perfil.
Cualquier rol dedicado preexistente hace fallar la transición, sin tocar sus permisos.
El listado existente muestra la caducidad nativa y deriva EXPIRED con el reloj
de PostgreSQL; no conserva el null del estado anterior a cualquier despacho.

Decisión Root final: contador por fecha nativa America/Los_Angeles, sin ventana
de24/25horas ni reset UTC. Las fechas derivan de los tiempos inmutables de
cada reserva y contemplan días de23/25horas sin renovar permisos históricos.
