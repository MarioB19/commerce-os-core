# V7 — Admisión atómica de cuotas por perfil

Fecha: 2026-10-12. Estado: diseño e implementación local, sin adopción de datos ni
migración productiva. Transición reservada: `014_profile_quotas.sql`.

La configuración F2 no reservaba capacidad. La admisión nueva se ejecuta en un
trigger de PostgreSQL al materializar registros REAL de producto, número o
conversación. La misma transacción confirma el registro y su consumo; un rollback
revierte ambos. Se conserva la política de escritores, el contexto de perfil y
los gates de autorización existentes. El trigger no concede permisos comerciales.

La política protegida requiere adopción explícita: tres perfiles, veinte plazas
de números agregadas y 300 conversaciones por día de plataforma. El calendario
global se fija en esa adopción y no se cambia por HTTP. La suma de plazas asignadas
a perfiles no excede veinte. Los límites particulares se conservan en `profiles`.
El escalón 1000 requiere una admisión LOAD protegida, con referencias de medición
y economía y ventana prospectiva; una configuración de perfil no lo activa.

Los productos archivados conservan su plaza: el límite describe el catálogo
retenido, no sólo lo visible. Una futura política de liberación necesita contrato
explícito. Los números retirados liberan plaza únicamente al atravesar las
precondiciones de baja existentes: estado desconectado, pausa, ownership congelado,
desvinculación QR cuando corresponde, comandos resueltos y ausencia de efectos
SENDING/UNKNOWN. El asiento permanece. No se permite resucitar un número retirado;
una alta nueva obtiene otra identidad y requiere nueva admisión.

El día del perfil se calcula en su zona nativa con límites de calendario, incluso
en días de 23/25 horas. Cada consumo conserva ambos intervalos originales (perfil
y plataforma). Si cambia la zona del perfil, el nuevo intervalo cuenta también
los asientos cuyos intervalos históricos se solapan: el cambio no reinicia cupo.
No se usa la fecha enviada por el proveedor ni `records.created_at` para una nueva
admisión. Se usa el reloj de PostgreSQL. Cambiar o borrar un registro no devuelve
conversaciones consumidas ni borra su historia.

Los roles de runtime no escriben política, cobertura o consumos directamente.
Los helpers SECURITY DEFINER usan `search_path=pg_catalog` y nombres calificados.
La serialización utiliza un advisory lock transaccional no bloqueante: una carrera
no puede superar el cupo y devuelve un conflicto explícito; no se reintenta por
su cuenta ni retiene conexiones esperando un ciclo de locks. La política y el
perfil se revalidan dentro de esa transacción.

La instalación no inventa cero consumo. Antes de cualquier alta REAL se requiere
cobertura de todos los perfiles existentes, incluso suspendidos, mediante una
adopción por perfil del inventario exacto, con huella SHA-256 de registros y
configuración. El helper administrativo, sin EXECUTE público/runtime, reproduce
esa huella bajo bloqueo y conserva asientos históricos a partir de las fechas
nativas inventariadas. La adopción es única y no borra ni recalcula consumos
posteriores. Adoptar historia de un perfil suspendido no lo activa. La creación
de perfiles, adopción y admisión comparten el mismo lock global; si falta cualquier
cobertura, el alta queda cerrada. Una baja segura de un número ya cubierto puede
conservar su cierre sin conceder nuevas altas. Ningún dato productivo se
adopta por ejecutar esta transición de esquema.

La validación local completó 21 casos PostgreSQL 17.11 con roles restringidos, carreras,
DST, cambios de zona, agotamiento global/por perfil, idempotencia, rollback,
inventario previo incompleto/suspendido, bajas seguras y rechazo de acceso directo.
El peer independiente leyó SQL/ADR/casos y confirmó el cierre global; no repitió
la ejecución. El contenedor propio se retiró conservando cinco contenedores y
65 volúmenes, con identidades y estado exactos. Los intentos anteriores se
conservan como históricos; no se despliega ni adopta política con este resultado.

SIMULATION no
consume cuotas REAL; sus límites y aislamiento de laboratorio se verifican por
separado y no se presentan como capacidad comercial medida.
