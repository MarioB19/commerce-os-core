# F2 — administración de tokens personales por perfil

Decisión del 12-oct-2026, previa al código. La lectura V2 de PAT ya fija perfil,
usuario, entornos y scopes contra la autoridad vigente. Este incremento prepara
la administración explícita del mismo modelo; no monta rutas productivas ni
adopta los scopes de credenciales históricas.

El Dueño puede listar metadatos y revocar tokens de su perfil con versión
esperada. El alta y la rotación requieren sesión interactiva y emiten una
credencial del usuario autenticado, nunca de un user/profile suministrado por el
cliente. El formulario seguro recibe el secreto una sola vez, después del
commit. Las herramientas de agente no reciben un secreto nuevo; su futura
acción de alta debe dirigir al formulario autenticado. Los scopes son un
subconjunto cerrado del rol vigente, sin plataforma, wildcard ni cambio de
perfil. Entornos y vencimiento de hasta 90 días quedan inmutables.

Cada mutación lleva un UUID de operación. Su registro durable conserva la
acción, actor, hash de la petición y resultado sin secreto en la misma
transacción del token y auditoría. El mismo UUID con petición distinta falla;
una repetición exacta devuelve sólo el resultado público. Un GET permite
conciliar una respuesta incierta. Si se perdió el secreto de un alta confirmada,
se revoca esa credencial y se inicia otra operación explícita: no se vuelve a
mostrar ni se almacena el bearer cifrado para replay. Rotar revoca el anterior
y crea el nuevo atómicamente; sólo el titular interactivo puede hacerlo.

El mutex transaccional de autoridad precede a locks de membresía/perfil/token.
El adaptador común revalida sesión o PAT y rol antes del commit. Un PAT no puede
revocarse a sí mismo por esta ruta: debe usar su sesión; evitar el fallo al
revalidar no justifica omitir la barrera final. La vigencia se comprueba con el
reloj de PostgreSQL después de locks y antes de confirmar la operación.

La transición 009 crea únicamente la tabla de operaciones privadas con FK de
perfil/actor/token, RLS obligatorio y grants acotados; la 008 pertenece al
incremento de variantes. El ensayo usa una base sintética y rol runtime sin
superusuario ni BYPASSRLS. No añade migración automática, correo, llamadas
externas ni autorización comercial.

El cliente web fija cookie y selección de perfil, limita tiempo y tamaño de
respuesta y valida el resultado sin incluir cuerpos ni secretos en errores.
La vista conserva el bearer sólo en memoria, permite ocultarlo y lo descarta al
cambiar selección o autoridad. Cada cambio de contexto tiene una época propia,
incluso A→B→A: una respuesta tardía no puede mostrar un secreto anterior.
Después de una respuesta incierta sólo se habilita un GET de operación y lista;
la ausencia confirmada permite repetir explícitamente la misma petición y UUID.
Una operación ya registrada devuelve únicamente sus metadatos.

Validación: 43 pruebas unitarias/HTTP/cliente, 11 casos HTTP y PostgreSQL con
Better Auth y rol restringido, y 9 recorridos Chromium con API sintética.
TypeScript completo y lint focal pasan. El primer ensayo PG conservado esperaba
403 donde el fence nativo devuelve 409 por cambio de versión de membresía; se
corrigió esa expectativa y se repitió en otra base. No se aplicó la transición
009 ni se montó el plugin/componente en el entorno comercial.
