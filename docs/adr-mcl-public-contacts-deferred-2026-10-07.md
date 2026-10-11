# Contactos públicos diferidos durante la migración

Brandon indicó el 7-oct continuar la recuperación sin completar por ahora correo
de soporte, responsable/domicilio de privacidad y correo de privacidad. Esa
decisión elimina la intervención pendiente para instalar el portal; no aporta
los valores ni acredita que el aviso esté completo.

El instalador mantiene la validación por defecto. Sólo la transición exacta de
mantenimiento puede optar por `defer_public_contact_fields=True`; valores
distintos de booleano o la opción fuera de esa transición son rechazados antes
de ejecutar comandos. El reporte guarda `public_contact_fields_deferred`.

Se conservan los conjuntos de códigos, secreto de sesión, URL exacta, permisos,
almacenamiento privado y rollback del proxy. No se inventa un correo/domicilio,
no se toma identidad de billing y no se modifica la UI: ya omite el soporte sin
email válido y muestra el aviso incompleto cuando faltan datos del responsable.

El llamador autorizado de la futura transición debe optar explícitamente. Esta
opción no habilita full en la copia ni sustituye su recibo Root/reconciliación.
La instalación real, acceso y descargas siguen pendientes de pruebas por CI/VPS.
