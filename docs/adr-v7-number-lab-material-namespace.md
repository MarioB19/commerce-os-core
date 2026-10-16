# RF19 — Materiales bajo namespace privado compartido

Decisión previa, 12-oct-2026. Se importa sin cambios el puerto y pruebas de
`909596b0904dfb81b503b779278499d452396ff3`; procedencia por bytes/hash en
`v7-number-lab-namespace-import.json`. La custodia local ya revisada no acredita
el montaje del host ni una autorización de borrado.

La copia adquiere SH en las dos raíces privadas fijas (origen y laboratorio)
antes de consultar autoridad o abrir archivos y lo conserva durante lectura,
descifrado, validación de fuente/contenido, escritura, verificación y fsync.
El lector de entrega mantiene SH en la raíz LAB durante lectura, descifrado y
verificación completa. No se acepta un lease externo ni una raíz desde la acción.
Ambas raíces exigen 0700, propietario del proceso y filesystem local soportado.
La adquisición es no bloqueante; un EX ocupado rechaza sin producir material.

Las transacciones cortas de autoridad terminan antes de cada operación de disco;
no hay archivos ni proveedor dentro de una transacción SQL. Se revalida el lease
ante cada archivo y antes del resultado. Si falla la validación final del kernel,
el lector borra su buffer descifrado antes de propagar el error. Copias parciales
se conservan para conciliación: no se borra, sobrescribe ni repite una mutación
incierta por un fallo de custodia.

SH permite lectores concurrentes y bloquea al eraser EX cooperante. No concede
permiso comercial ni reemplaza los hashes/versiones/gates nativos. El host debe
montar el mismo puerto para todos los escritores y borradores de esa raíz; la
implementación local no afirma todavía esa integración. Las pruebas incluyen
EX durante copia/lectura, EX previo que impide entrada y liberación tras error.
