# F3 — adopción de autoridad QR en participantes históricos

Decisión prospectiva adoptada por Root antes de implementar016. La adopción
cambia la fuente de permiso de un participante para efectos futuros; no cambia
la política del pool, su propósito, perfil, programa, episodio, créditos,
calendario, pausas ni efectos ya emitidos. Un pool mixto conserva la autoridad
de cada participante y cada outbox. No se convierte el pool a QR_CONTINUOUS.

El comando explícito exige acción warmup:write bajo autoridad Owner del perfil,
UUID durable, versión esperada y hash del estado leído. Se registra una fila
inmutable por participante/versión de adopción con pool, episodio, política,
perfil, origen QR vigente, contenido aprobado y actor. El reintento exacto
consulta el resultado; no cambia una adopción previa para revivir una conexión
revocada. Después de la adopción inicial, una reconexión de la misma identidad,
política y episodio crea un sucesor automático por el canal autorizado, ligado
al nuevo acto QR. No requiere otra activación o renovación humana. Conserva
las pausas de alcance y nunca modifica la revocación del origen anterior.

La lectura previa verifica el último connect APPLIED, misma identidad cifrada,
grant no revocado/pausado/protegido, perfil ACTIVE y origen del contenido. Los
miembros standard-15d/v2 conservan los mismos créditos inmutables y episodio.
Los miembros standard-15d/v1 o legacy-30d/v1 mantienen su política y requisitos
hasta graduarse; no se importan sus días como créditos v2 ni se reinician por
conveniencia. Metadata/profile_verified_at histórica sigue siendo requisito en
ese camino. Sólo el nuevo bootstrap015 usa la observación QR separada.

El planner forma una conversación cuando ambos participantes tienen autoridad
compatible vigente. Las parejas adoptadas usan sus respectivos grants QR;
parejas no adoptadas conservan la autorización legacy exacta. No se mezcla una
mitad permanente con una mitad sin autoridad y no se amplía la biblioteca por
una autorización caducada: la adopción liga el contenido propio ya aprobado por
su hash y origen histórico. Ningún efecto existente recibe otra autoridad.

El gate de envío debe cotejar la adopción inmutable, el grant del efecto, el
último origen QR de ambos números y las mismas comprobaciones de salud,
identidad, límites, causalidad y prueba de recepción. La espera por par no toca
inbound. La adopción no reanuda un pool pausado ni elimina una protección.

Se entrega primero el contrato persistente y sus puertos sin montaje. La
integración del planner/gate exige pruebas con pools mixtos, v1/v2, pausas,
reconexiones y efectos históricos; la tabla por sí sola no se presenta como
migración funcional terminada.

La tabla `warmup_effect_origins` fija todos los participantes y su fuente en la
misma transacción que crea cada efecto adoptado o mixto. Sus claves compuestas
ligan efecto/perfil/entorno/cuenta/adopción/grant; un participante legacy liga
su autorización temporal exacta. El guard SQL rechaza añadir orígenes a un
outbox viejo, mutarlos o usar TTL para un participante ya adoptado. El lector
para gate devuelve esas fuentes fijas; nunca crea una nueva autorización para
un efecto histórico. Los gates directo y de grupo consumen el lector de orígenes sin relink y
conservan identidad/salud, controles,
recibos causales y límites. El presupuesto se deriva del día inmutable del plan;
la migración016 impide cambiar su perfil, episodio, día o presupuesto, sin
conceder UPDATE al canal para adquirir un lock.

Después de instalar016, el planner legacy requiere un executor de perfil vivo,
igual que el bootstrap015; no descubre perfiles ni usa un fallback global.
El montaje WorkerScope de F0 es condición de ejecución. Los fixtures previos
al esquema016 conservan el comportamiento original, sin simular una adopción.

El lector de orígenes comprueba la expiración temporal con `clock_timestamp()`
después de bloqueos y cuotas: `now()` del lector legado queda fijado al inicio
de la transacción y no prueba vigencia al terminar. Devuelve el menor vencimiento
temporal para que el gate lo compruebe después de sus lecturas restantes.

En grupos una conversación sigue siendo un hilo completo; cada participación
consume el cupo de mensajes, no crea otra conversación. El planner adoptado y
el gate acotan los hilos elegidos por `dailyBudget.max_conversations`, además
de las participaciones/mensajes; no convierten un cupo en el otro.

Verificación local final: 10 pruebas puras y 20 PostgreSQL con roles restringidos,
TypeScript y ESLint pasan. El ensayo incluye los tres programas históricos,
pools mixtos, gates directo/grupal, vencimiento durante la transacción y
reconexión que conserva el origen antiguo sin revivirlo. Los tres intentos
anteriores y sus dumps fallidos permanecen como diagnóstico. No se ejecutó
proveedor ni se montó el worker en producción.
