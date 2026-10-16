# V7 F2 — cambios de acceso de empleados

Decisión del 11-oct-2026, registrada antes de implementar. La ruta preparada
`PATCH /v2/employees/:userId` permite a Dueño cambiar rol y estado activo de una
membresía de su perfil. Usa una versión esperada; la identidad global del usuario,
correo y contraseña no son editables por este controlador. Una baja conserva
historial y vínculos; no elimina usuarios ni tokens de otros perfiles.

La operación usa el lock administrativo transaccional ya compartido por perfiles,
empleados y tokens, antes de bloquear autoridad y objetivo. La comprobación del
actor se repite antes del commit. Se rechaza cambiar el acceso propio por esta
ruta: transferir la titularidad exige otra persona Dueño y un flujo explícito, sin
omitir la validación final de la sesión o token del actor. Rol y baja afectan las
nuevas solicitudes inmediatamente; una solicitud que ya retiene locks de
membresía termina antes de la baja. No se afirma cancelar efectos externos ya
despachados.

La base preserva el ID y versión de membresía, limita el API a UPDATE(role,active)
y prohíbe DELETE. Un trigger invoker requiere contexto del mismo perfil, aplica
el mismo try-advisory-lock y prohíbe retirar el último Dueño activo. El propietario
de la tabla conserva la vía explícita de migración/adopción de roles históricos;
no es un rol runtime. Los cambios de acceso exigen READ COMMITTED, para que el
conteo de Dueños posterior al lock no reutilice un snapshot anterior en una
transacción REPEATABLE READ. RLS global y la adopción cerrada de roles siguen formando
parte del corte completo pendiente. Esta transición no se instala automáticamente.

El evento de auditoría registra actor, empleado, estado/rol anterior y posterior,
y versiones en la misma transacción, sin correo ni secreto. Un cambio nulo no
crea otra revisión. UI exige lectura nueva después de un PATCH incierto, nunca lo
repite automáticamente, y descarta respuestas de una selección anterior. No se
crean invitaciones ni se envía correo como consecuencia de cambiar un rol.
