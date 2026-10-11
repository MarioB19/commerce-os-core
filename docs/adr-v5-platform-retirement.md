# V5: CI selectivo, cliente neutral y retiro de producción web

Decisión 2026-09-13, registrada antes de implementar. V5 reemplaza los contratos de Studio y patrocinio, no el motor/fuentes de producción de Codex ni el tier Madrina.

Se conserva la historia y las tablas compartidas. Antes de retirar montajes se crea un respaldo verificable de fuentes explícitamente enumeradas y se comprueba restauración por SHA-256. El servidor deja de importar productores Studio/voz/dispositivos. Archivo y acceso a activos se exponen por rutas de archivo, separadas de producción. Ningún prefijo `creative` autoriza eliminación: seguridad, almacenamiento, presupuesto, identidad y tareas Intelligence siguen operativos. Las tareas pendientes exclusivas se cancelan; efectos inciertos quedan en conciliación sin reintentos. Restaurar fuentes no habilita endpoints ni permisos.

El cliente Commerce pasa a un paquete neutral que conserva envoltura, metadata y cursores, acepta método/revisión/idempotencia y no reintenta operaciones inciertas. MCP y el worker local consumen ese cliente. Los activos terminados se registran mediante contratos de catálogo con hash/origen/derechos/revisión, sin generar medios.

Madrina acredita un total aprobado superior a 10700 centavos únicamente para Mi Ciclo Listo. El total se cuenta una vez; el extra es desglose incluido. Ninguna versión de oferta crea patrocinios. Se conservan compromisos anteriores como excepciones históricas, sin crear asignaciones o efectos nuevos. El ensayo acepta un comprador y nunca autoriza envíos.

CI clasifica el diff completo (incluidos ambos lados de renombres), usa regresión amplia ante cambios desconocidos/dependencias/DB/auth/workflow o diff incompleto, y conserva un check final estable. PR borrador y narrativa usan comprobaciones ligeras. Ramas sin PR no disparan la suite; PR listo selecciona por impacto. Main/release calcula desde el último despliegue exitoso, y verify nunca despliega. OIDC, SHA/hash, portal, recuperación remota e instalación serial se conservan. Permisos de lectura en verificación y escritura sólo en publicación. No se cancelan instalaciones.

Validación exigida: matriz de clasificación y gates terminales, reversión/duplicados/parciales/TEST y umbrales 97/107/107.01, ausencia de endpoints de generación y patrocinios nuevos, cliente con metadata/errores y restauración de respaldo. La publicación y las pruebas físicas permanecen responsabilidad de la integración principal.
