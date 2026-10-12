# D18 — Cercar escritores antes de tomar la instantánea

12-oct-2026. Decisión previa a030; no ejecuta ni autoriza el borrado de contenido.

El inventario y la redacción requieren una instantánea tomada después de excluir
escritores. Un advisory lock adquirido dentro de REPEATABLE READ no basta: esa
consulta puede fijar una instantánea anterior al último escritor.030 adquiere un
lock exclusivo de sesión mediante try-lock en READ COMMITTED, confirma una lease
privada y sólo después abre la transacción REPEATABLE READ. El puerto valida la
lease comprometida, backend, perfil, vencimiento y lock real. La identidad de
sesión se liga a una tabla TEMP recién creada por el owner cerrado; se rechaza
cualquier tabla previa. Se verifican propietario, namespace, persistencia y
nonce privado. La tabla desaparece al desconectar, aunque PostgreSQL reutilice
el PID. Esto evita ampliar permisos de estadísticas para leer backend_start
que PostgreSQL oculta al SECURITY DEFINER sin privilegios de monitor global. No espera ni roba
una lease de otra conexión; las desconexiones liberan el lock en PostgreSQL.

Cada escritura de una tabla pública con workspace_id toma el lock compartido de
transacción sin esperar y lee FOR SHARE la época del perfil. El borrado aumenta
esa época en su misma transacción. Una transacción REPEATABLE READ iniciada antes
del borrado falla al intentar bloquear la fila de época cambiada; no puede volver
a insertar contenido usando una instantánea anterior. SIMULATION conserva su
aislamiento; las filas de ámbito común, incluido membresía/perfil, sí participan.

La conexión dedicada se destruye al terminar, incluso después de COMMIT incierto
o timeout. No vuelve al pool con locks de sesión. Los límites de consulta y lease
son cortos; una contención devuelve un fallo reintentable al administrador, no
permiso para omitir un gate ni repetir un efecto externo. El puerto sólo maneja
fences: no concede escritura a los datos ni convierte al worker en owner.

El generador usa el catálogo explícito y produce un trigger por relación; nuevas
tablas o cambios de ámbito requieren regeneración revisada. El instalador debe
verificar catálogo/triggers antes de admitir un job. La autoridad de respaldo,
obligaciones, plan de campos, protección posterior a borrado y archivos siguen
siendo gates independientes del job. No se afirma que030 por sí solo los cierre.

Referencias: [aislamiento PostgreSQL17](https://www.postgresql.org/docs/17/transaction-iso.html)
y [locks PostgreSQL17](https://www.postgresql.org/docs/17/explicit-locking.html).

El helper exige además command=COMMIT en la respuesta terminal; una respuesta
ROLLBACK resuelta no acredita éxito. Los timeouts de sesión/transacción ociosa
cierran una conexión abandonada sin dejar indefinidamente su lock exclusivo.
