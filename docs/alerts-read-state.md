# Avisos vistos

Corrección preparada el 11-nov-2026 por la solicitud de Brandon de marcar los
avisos acumulados como vistos. Pendiente de publicación.

Inicio, la campana y el listado abierto cuentan únicamente avisos de este
perfil en REAL que siguen sin resolver y sin acuse de lectura. La condición se
aplica antes del límite de 100 para que los avisos ya vistos no oculten otros
pendientes. `include=all` conserva la consulta del historial.

Marcar un aviso como visto conserva su estado operativo, causa, evidencia y
fecha de resolución. Un aviso nuevo permanece pendiente aunque se haya leído
otro del mismo tipo. Se mantiene el endpoint de acuse y su auditoría existente;
no cambian permisos, envíos ni el monitor que genera avisos.

Validación: regresión HTTP con PostgreSQL y rol restringido para contadores,
historial, idempotencia, límite de listado y aislamiento por perfil/entorno.
