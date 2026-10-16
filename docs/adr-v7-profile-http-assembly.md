# V7 F2 — ensamblaje HTTP local con identidad nativa

Decisión del 11-oct-2026 antes de implementar. Continúa el alta y la aceptación
por invitación. La prueba local registra los plugins preparados en una instancia
Fastify propia, con el mismo formato de errores de la aplicación, y usa un
login PostgreSQL sin superusuario ni BYPASSRLS. No registra rutas en `createApp`
ni habilita el frontend comercial mientras falta el corte completo de consumidores.

El recorrido envía el alta por HTTP, verifica la ausencia de sesión implícita,
inicia sesión mediante el `handler` real de Better Auth configurado por
`createAuth(client)` y utiliza únicamente su cookie firmada para listar y
seleccionar perfiles y consultar la aceptación. No crea sesiones sintéticas ni
simula la respuesta de autenticación. El contenedor de la prueba confirma su
transacción antes de entregar la cookie. La comprobación de cuota usa el SQL
canónico `identityLimit` con el mismo ejecutor restringido; se añade un parámetro
interno opcional de ejecutor, cuyo valor por omisión conserva el pool actual.
Ningún campo HTTP elige ese ejecutor.

Los negativos cubren alta pública deshabilitada, contraseña incorrecta sin
cookie, consulta anónima, Origin ajeno, selección de otro perfil y revocación
de membresía tras login. La prueba distingue el ensamblaje local de plugins y
el handler nativo de la integración pendiente del middleware comercial completo.
No envía correo ni aplica cambios fuera de la base sintética aislada.
