# V7 F2 — recorrido de acceso por invitación

Decisión del 11-oct-2026 antes de implementar. Se compone una vista preparada
con alta, login nativo, consulta/aceptación y selector de perfiles. El arranque
extrae y elimina el fragmento antes de renderizar; conserva el enlace sólo en
memoria durante los cambios de vista. No se monta en `main.tsx` todavía.

Una respuesta de login no establece por sí sola el estado autenticado de la
vista. Después de una respuesta exitosa se consulta `/v2/me/profiles` con la
cookie nativa. Un resultado de escritura incierto bloquea otra escritura de
login hasta una consulta explícita: un 401 fresco devuelve el formulario y una
consulta correcta continúa con la invitación. La consulta y la selección no
adoptan un identificador de usuario o perfil proporcionado por el formulario.

La aceptación mantiene su comprobación previa y su regla de no repetir un POST
incierto. La vista habilita el selector sólo tras observar `ACCEPTED` y vuelve a
leer la lista de perfiles. No navega automáticamente al frontend comercial: el
ensamblaje entrega una selección confirmada a un callback de integración. Un
nuevo enlace desmonta todo el estado del anterior; respuestas tardías no cambian
la vista nueva. Contraseña, enlace y respuestas de identidad no se escriben en
URL, almacenamiento del navegador ni registros.

Los ensayos Chromium simulan respuestas para verificar el recorrido y los
estados inciertos; se mantienen separados del ensayo HTTP con PostgreSQL y
Better Auth reales. El middleware comercial, los consumidores y el corte RLS
completo siguen siendo requisitos de activación.
